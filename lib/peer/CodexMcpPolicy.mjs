const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

export class CodexMcpPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodexMcpPolicyError';
    this.code = code;
  }
}

/**
 * Build process-scoped Codex overrides. The user config remains untouched:
 * every configured server outside the signed allowlist is disabled, and each
 * allowed server exposes only the exact bound tools.
 */
export function buildCodexProcessConfigArgs(policy, configuredServers) {
  const normalized = normalizePolicy(policy, configuredServers);
  const args = [
    '-c',
    'features.apps=false',
    '-c',
    'features.connectors=false',
    '-c',
    'features.enable_mcp_apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.remote_plugin=false',
    '-c',
    'features.collab=false',
    '-c',
    'features.multi_agent=false',
  ];

  if (policy.disableShell === true) {
    args.push(
      '-c',
      'features.experimental_use_unified_exec_tool=false',
      '-c',
      'features.shell_tool=false',
      '-c',
      'features.unified_exec=false',
      '-c',
      'web_search="disabled"',
      '-c',
      'features.standalone_web_search=false'
    );
  }

  for (const server of normalized.configuredServers) {
    const tools = normalized.allowedByServer[server];
    if (!tools) {
      args.push('-c', `mcp_servers.${server}.enabled=false`);
      continue;
    }
    args.push(
      '-c',
      `mcp_servers.${server}.enabled=true`,
      '-c',
      `mcp_servers.${server}.required=true`,
      '-c',
      `mcp_servers.${server}.enabled_tools=${JSON.stringify(tools)}`,
      '-c',
      `mcp_servers.${server}.disabled_tools=[]`,
      '-c',
      `mcp_servers.${server}.default_tools_approval_mode="approve"`
    );
  }
  return args;
}

export function buildCodexAppServerArgs(policy, configuredServers) {
  return [
    ...buildCodexProcessConfigArgs(policy, configuredServers),
    'app-server',
    '--stdio',
  ];
}

/**
 * mcpServerStatus/list is the enforcement proof, not merely diagnostics. It
 * must show the exact server/tool set and the exact signed input schemas before
 * turn/start is allowed to send a model request.
 */
export function verifyEffectiveMcpPolicy(entries, policy) {
  const normalized = normalizePolicy(policy, Object.keys(policy.allowedByServer ?? {}));
  if (!Array.isArray(entries)) {
    fail('mcp_status_invalid', 'mcpServerStatus/list did not return an array');
  }
  const byName = new Map();
  for (const entry of entries) {
    if (!isRecord(entry)) fail('mcp_status_invalid', 'MCP server status must be an object');
    const name = identifier(entry.name, 'MCP server status name');
    if (byName.has(name)) fail('mcp_status_duplicate_server', `duplicate MCP server '${name}'`);
    byName.set(name, entry);
  }

  for (const [server, expectedTools] of Object.entries(normalized.allowedByServer)) {
    const entry = byName.get(server);
    if (!entry) fail('mcp_server_missing', `required MCP server '${server}' is not configured`);
    if (normalizeAuthStatus(entry.authStatus ?? entry.auth_status) === 'notloggedin') {
      fail('mcp_server_unauthenticated', `required MCP server '${server}' is not authenticated`);
    }
    const actualTools = toolMap(entry.tools, server);
    assertExactSet(
      Object.keys(actualTools),
      expectedTools,
      'mcp_tool_set_mismatch',
      `MCP server '${server}'`
    );
    for (const toolName of expectedTools) {
      const tool = actualTools[toolName];
      if (!isRecord(tool) || tool.name !== toolName) {
        fail('mcp_tool_identity_mismatch', `${server}/${toolName} identity did not match`);
      }
      const actualSchema = tool.inputSchema ?? tool.input_schema;
      const expectedSchema = policy.expectedSchemasByServer?.[server]?.[toolName];
      if (!isRecord(expectedSchema)) {
        fail('mcp_expected_schema_missing', `${server}/${toolName} has no signed schema`);
      }
      if (!isRecord(actualSchema) || canonicalJson(actualSchema) !== canonicalJson(expectedSchema)) {
        fail('mcp_tool_schema_mismatch', `${server}/${toolName} input schema did not match`);
      }
    }
  }

  for (const [server, entry] of byName) {
    if (normalized.allowedByServer[server]) continue;
    const exposed = Object.keys(toolMap(entry.tools, server));
    if (exposed.length > 0) {
      fail(
        'mcp_unexpected_server_exposed',
        `non-authorized MCP server '${server}' exposed ${exposed.length} tool(s)`
      );
    }
  }

  return {
    servers: Object.keys(normalized.allowedByServer).sort(),
    tools: Object.values(normalized.allowedByServer).flat().sort(),
  };
}

/**
 * Installation-time capability gate. No model turn is started: app-server
 * must load the authenticated OrgX MCP and honor an exact one-tool overlay.
 * Per-run verification remains stricter and compares the actual schema to the
 * signed manifest before every autonomous turn.
 */
export function verifyMcpReadinessStatus(
  entries,
  { serverName = 'orgx', toolName = 'orgx_bootstrap' } = {}
) {
  identifier(serverName, 'readiness MCP server');
  identifier(toolName, 'readiness MCP tool');
  if (!Array.isArray(entries)) {
    fail('mcp_status_invalid', 'mcpServerStatus/list did not return an array');
  }
  const byName = new Map();
  for (const entry of entries) {
    if (!isRecord(entry)) fail('mcp_status_invalid', 'MCP server status must be an object');
    const name = identifier(entry.name, 'MCP server status name');
    if (byName.has(name)) fail('mcp_status_duplicate_server', `duplicate MCP server '${name}'`);
    byName.set(name, entry);
  }
  const required = byName.get(serverName);
  if (!required) fail('mcp_server_missing', `required MCP server '${serverName}' is not configured`);
  if (normalizeAuthStatus(required.authStatus ?? required.auth_status) === 'notloggedin') {
    fail('mcp_server_unauthenticated', `required MCP server '${serverName}' is not authenticated`);
  }
  const actualTools = toolMap(required.tools, serverName);
  assertExactSet(
    Object.keys(actualTools),
    [toolName],
    'mcp_tool_set_mismatch',
    `MCP server '${serverName}'`
  );
  const tool = actualTools[toolName];
  if (!isRecord(tool) || tool.name !== toolName) {
    fail('mcp_tool_identity_mismatch', `${serverName}/${toolName} identity did not match`);
  }
  const schema = tool.inputSchema ?? tool.input_schema;
  if (
    !isRecord(schema) ||
    schema.type !== 'object' ||
    !isRecord(schema.properties) ||
    schema.additionalProperties !== false
  ) {
    fail(
      'mcp_tool_schema_unbounded',
      `${serverName}/${toolName} does not expose a bounded object schema`
    );
  }
  for (const [name, entry] of byName) {
    if (name === serverName) continue;
    const exposed = Object.keys(toolMap(entry.tools, name));
    if (exposed.length > 0) {
      fail(
        'mcp_unexpected_server_exposed',
        `non-authorized MCP server '${name}' exposed ${exposed.length} tool(s)`
      );
    }
  }
  return {
    server: serverName,
    tool: toolName,
    schema_bounded: true,
  };
}

export function parseConfiguredMcpServers(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('mcp_discovery_invalid', 'codex mcp list --json returned invalid JSON');
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(rows)) {
    fail('mcp_discovery_invalid', 'codex mcp list --json returned an unsupported shape');
  }
  const names = rows.map((entry) => {
    if (!isRecord(entry)) fail('mcp_discovery_invalid', 'MCP discovery row is invalid');
    return identifier(entry.name, 'configured MCP server name');
  });
  if (new Set(names).size !== names.length) {
    fail('mcp_discovery_duplicate_server', 'configured MCP server names are not unique');
  }
  return names.sort();
}

function normalizePolicy(policy, configuredServers) {
  if (!isRecord(policy) || !isRecord(policy.allowedByServer)) {
    fail('mcp_policy_invalid', 'MCP allowlist is missing');
  }
  const allowedEntries = Object.entries(policy.allowedByServer);
  if (allowedEntries.length === 0) fail('mcp_policy_empty', 'MCP allowlist is empty');
  const allowedByServer = {};
  for (const [server, rawTools] of allowedEntries) {
    identifier(server, 'allowed MCP server');
    if (!Array.isArray(rawTools) || rawTools.length === 0) {
      fail('mcp_policy_invalid', `MCP server '${server}' has no allowed tools`);
    }
    const tools = rawTools.map((tool) => identifier(tool, 'allowed MCP tool'));
    assertExactSet(tools, [...new Set(tools)], 'mcp_policy_duplicate_tool', server);
    allowedByServer[server] = [...tools].sort();
  }
  if (!Array.isArray(configuredServers)) {
    fail('mcp_discovery_invalid', 'configured MCP server list is missing');
  }
  const configured = configuredServers.map((server) =>
    identifier(server, 'configured MCP server')
  );
  if (new Set(configured).size !== configured.length) {
    fail('mcp_discovery_duplicate_server', 'configured MCP server names are not unique');
  }
  for (const server of Object.keys(allowedByServer)) {
    if (!configured.includes(server)) {
      fail('mcp_server_missing', `required MCP server '${server}' is not configured`);
    }
  }
  return {
    allowedByServer,
    configuredServers: [...configured].sort(),
  };
}

function toolMap(value, server) {
  if (!isRecord(value)) {
    fail('mcp_status_invalid', `MCP server '${server}' did not return a tool map`);
  }
  return value;
}

function assertExactSet(actual, expected, code, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (
    left.length !== right.length ||
    left.some((value, index) => value !== right[index])
  ) {
    fail(code, `${label} expected [${right.join(', ')}], received [${left.join(', ')}]`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeAuthStatus(value) {
  return typeof value === 'string' ? value.replaceAll(/[^a-z]/gi, '').toLowerCase() : '';
}

function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail('mcp_identifier_invalid', `${label} is not a safe Codex config identifier`);
  }
  return value;
}

function fail(code, message) {
  throw new CodexMcpPolicyError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
