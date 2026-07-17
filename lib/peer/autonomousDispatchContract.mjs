import {
  computeContractDigest,
  validateExecutionEnvelope,
  verifyContractDigest,
} from '@useorgx/orgx-gateway-sdk';

import {
  AutonomousDispatchContractError,
  array,
  assert,
  assertSameSet,
  assertSorted,
  assertUnique,
  isRecord,
  nonEmpty,
  record,
  toolsByServer,
  validateLease,
  validateLineage,
} from './autonomousDispatchContractChecks.mjs';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MCP_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNSCOPED_MUTATION_TOOLS = new Set([
  'orgx_write',
  'orgx_attach',
  'orgx_act',
  'orgx_plan',
  'orgx_decide',
  'orgx_spawn',
  'orgx_submit_receipt',
  'orgx_emit_activity',
]);

export { AutonomousDispatchContractError };

/**
 * Validate the immutable source bundle carried by an autonomous V1 task.
 * OrgX verifies the HMAC before dispatch (the peer never receives the server
 * signing secret); the peer independently verifies the lease digest,
 * signature shape, expiry, lineage, and exact MCP tool bindings.
 */
export async function validateAutonomousDispatch(task, dispatch, opts = {}) {
  const context = record(task?.autonomous_context, 'autonomous_context');
  assert(context.schema_version === '1.0.0', 'schema_version_invalid');
  assert(context.launch_mode === 'autonomous', 'launch_mode_invalid');

  const transport = record(context.transport, 'transport');
  assert(
    transport.dispatch_protocol === 1 &&
      transport.terminal_protocol === 1 &&
      transport.finalization_mode === 'execution_receipt' &&
      transport.proof_carrying_finalization === false,
    'transport_contract_invalid'
  );
  assert(
    dispatch?.protocol_version === undefined || dispatch.protocol_version === 1,
    'autonomous_v2_finalization_unsupported'
  );

  const specialist = record(context.specialist, 'specialist');
  const assignment = record(context.assignment, 'assignment');
  const contextPack = record(context.context_pack, 'context_pack');
  const skills = await validateSkillManifest(context.skill_manifest);
  const nativePolicy = await validateNativePolicy(
    context.native_policy,
    specialist
  );
  const contracts = record(context.contracts, 'contracts');
  const mission = record(contracts.mission_contract, 'mission_contract');
  const node = record(contracts.work_node, 'work_node');
  const manifest = record(contracts.context_manifest, 'context_manifest');
  const lease = record(contracts.capability_lease, 'capability_lease');
  const profile = record(contracts.runtime_profile, 'runtime_profile');
  const qualityBar = record(contracts.quality_bar, 'quality_bar');
  const envelope = record(contracts.execution_envelope, 'execution_envelope');

  validateExecutionEnvelope(envelope);
  await Promise.all([
    verifySourceDigest(mission, 'mission_contract'),
    verifySourceDigest(manifest, 'context_manifest'),
    verifySourceDigest(lease, 'capability_lease'),
    verifySourceDigest(profile, 'runtime_profile'),
    verifySourceDigest(qualityBar, 'quality_bar'),
    verifySourceDigest(envelope, 'execution_envelope'),
  ]);

  const agentId = nonEmpty(specialist.agent_id, 'specialist.agent_id');
  const agentType = nonEmpty(specialist.agent_type, 'specialist.agent_type');
  const domain = nonEmpty(specialist.domain, 'specialist.domain');
  const instructions = nonEmpty(specialist.instructions, 'specialist.instructions');
  const instructionDigest = await computeContractDigest({
    agentId,
    agentType,
    domain,
    instructions,
  });
  assert(
    instructionDigest === specialist.instructions_digest,
    'specialist_instructions_digest_mismatch'
  );

  const title = nonEmpty(assignment.title, 'assignment.title');
  const description = nonEmpty(assignment.description, 'assignment.description');
  assert(task.title === title, 'assignment_title_mismatch');
  assert(
    assignment.task_id === null || typeof assignment.task_id === 'string',
    'assignment_task_id_invalid'
  );
  assert(
    assignment.session_id === null || typeof assignment.session_id === 'string',
    'assignment_session_id_invalid'
  );

  const contextDigest = await computeContractDigest({
    schemaVersion: '1.0.0',
    launchMode: 'autonomous',
    specialist,
    assignment,
    contextPack,
    skillManifest: skills,
    nativePolicy,
  });
  assert(contextDigest === context.context_digest, 'autonomous_context_digest_mismatch');

  const workspaceId = nonEmpty(opts.workspaceId, 'runner.workspace_id');
  const runId = nonEmpty(dispatch?.run_id, 'dispatch.run_id');
  const idempotencyKey = nonEmpty(dispatch?.idempotency_key, 'dispatch.idempotency_key');
  assert(task.workspace_id === workspaceId, 'task_workspace_mismatch');

  validateLineage({
    task,
    workspaceId,
    runId,
    idempotencyKey,
    contextDigest,
    specialist: { agentId, domain },
    assignment: { taskId: assignment.task_id, title, description },
    mission,
    node,
    manifest,
    lease,
    profile,
    qualityBar,
    envelope,
  });
  validateLease(lease, {
    workspaceId,
    runId,
    agentId,
    envelope,
    node,
    now: opts.now ?? new Date(),
  });
  validateNativeBindings(nativePolicy, { profile, node, lease });

  const tools = await validateToolManifest(context.tool_manifest);
  const toolDigests = tools.map((tool) => tool.digest);
  assertSameSet(toolDigests, lease.toolManifestDigests, 'lease_tool_binding_mismatch');
  assertSameSet(
    toolDigests,
    envelope.toolManifestDigests,
    'envelope_tool_binding_mismatch'
  );
  validateRuntimeBindings(task, profile, specialist, skills, tools, toolDigests, envelope);

  return {
    context,
    leaseId: lease.id,
    leaseDigest: lease.digest,
    resolvedSkills: skills,
    nativePolicy,
    allowedTools: tools,
    mcpPolicy: {
      allowedByServer: toolsByServer(tools),
      expectedSchemasByServer: schemasByServer(tools),
    },
  };
}

async function validateNativePolicy(value, specialist) {
  const policy = record(value, 'native_policy');
  assert(policy.schema_version === '1.0.0', 'native_policy_schema_invalid');
  const mode = nonEmpty(policy.mode, 'native_policy.mode');
  assert(
    mode === 'read_only' || mode === 'workspace_write',
    'native_policy_mode_invalid'
  );
  const sandbox = nonEmpty(policy.sandbox, 'native_policy.sandbox');
  assert(sandbox === mode, 'native_policy_sandbox_mismatch');
  const expectedWrite = mode === 'workspace_write';
  assert(policy.shell_access === expectedWrite, 'native_policy_shell_access_invalid');
  const requiredCapability = policy.required_capability;
  if (expectedWrite) {
    assert(
      requiredCapability === 'engineering_execution',
      'native_policy_capability_invalid'
    );
    assert(
      specialist.agent_type === 'engineering' && specialist.domain === 'engineering',
      'native_policy_agent_not_authorized'
    );
  } else {
    assert(requiredCapability === null, 'native_policy_capability_invalid');
  }
  const digest = nonEmpty(policy.digest, 'native_policy.digest');
  assert(DIGEST_PATTERN.test(digest), 'native_policy_digest_invalid');
  const material = {
    schemaVersion: '1.0.0',
    mode,
    sandbox,
    shellAccess: policy.shell_access,
    requiredCapability,
  };
  assert(
    (await computeContractDigest(material)) === digest,
    'native_policy_digest_mismatch'
  );
  return {
    schema_version: '1.0.0',
    mode,
    sandbox,
    shell_access: policy.shell_access,
    required_capability: requiredCapability,
    digest,
  };
}

function validateNativeBindings(nativePolicy, { profile, node, lease }) {
  const sandboxPolicy = record(
    profile.sandboxPolicy,
    'runtime_profile.sandboxPolicy'
  );
  assert(
    sandboxPolicy.digest === nativePolicy.digest,
    'runtime_profile_native_policy_mismatch'
  );
  if (nativePolicy.mode !== 'workspace_write') return;
  assert(
    array(node.requiredCapabilities, 'work_node.requiredCapabilities').includes(
      nativePolicy.required_capability
    ),
    'work_node_native_capability_missing'
  );
  assert(
    array(lease.actions, 'capability_lease.actions').includes(
      nativePolicy.required_capability
    ),
    'capability_lease_native_action_missing'
  );
}

async function validateSkillManifest(value) {
  const entries = array(value, 'skill_manifest');
  assert(entries.length > 0, 'skill_manifest_empty');
  const seenIds = new Set();
  const seenDigests = new Set();
  const result = [];
  let instructionCharacters = 0;
  for (const raw of entries) {
    const skill = record(raw, 'skill_manifest_entry');
    const id = nonEmpty(skill.id, 'skill.id');
    const version = nonEmpty(skill.version, 'skill.version');
    const instructions = nonEmpty(skill.instructions, 'skill.instructions');
    assert(/^[A-Za-z0-9_.:/-]+$/.test(id), 'skill_id_invalid');
    assert(instructions.length <= 100_000, 'skill_instructions_too_large');
    instructionCharacters += instructions.length;
    assert(instructionCharacters <= 300_000, 'skill_manifest_too_large');
    const digest = nonEmpty(skill.digest, 'skill.digest');
    assert(DIGEST_PATTERN.test(digest), 'skill_digest_invalid');
    assert(
      (await computeContractDigest({ id, version, instructions })) === digest,
      'skill_manifest_digest_mismatch'
    );
    assert(!seenIds.has(id), 'skill_manifest_id_duplicate');
    assert(!seenDigests.has(digest), 'skill_manifest_digest_duplicate');
    seenIds.add(id);
    seenDigests.add(digest);
    result.push({ id, version, instructions, digest });
  }
  assertSorted(
    result.map((skill) => skill.id),
    'skill_manifest_unsorted'
  );
  return result;
}

async function validateToolManifest(value) {
  const entries = array(value, 'tool_manifest');
  assert(entries.length > 0, 'tool_manifest_empty');
  const seenIds = new Set();
  const seenDigests = new Set();
  const seenQualified = new Set();
  const result = [];
  for (const raw of entries) {
    const tool = record(raw, 'tool_manifest_entry');
    const id = mcpIdentifier(tool.id, 'tool.id');
    const name = mcpIdentifier(tool.name, 'tool.name');
    const version = nonEmpty(tool.version, 'tool.version');
    const serverIdentity = nonEmpty(tool.server_identity, 'tool.server_identity');
    const mcpServer = mcpIdentifier(tool.mcp_server, 'tool.mcp_server');
    const mcpTool = mcpIdentifier(tool.mcp_tool, 'tool.mcp_tool');
    assert(
      !UNSCOPED_MUTATION_TOOLS.has(mcpTool),
      'autonomous_mcp_mutation_tool_unsupported'
    );
    const jsonSchema = record(tool.json_schema, 'tool.json_schema');
    const logicalCapabilities = array(
      tool.logical_capabilities,
      'tool.logical_capabilities'
    ).map((entry) => nonEmpty(entry, 'tool.logical_capability'));
    assert(logicalCapabilities.length > 0, 'tool_logical_capabilities_empty');
    assertUnique(logicalCapabilities, 'tool_logical_capabilities_duplicate');
    assertSorted(logicalCapabilities, 'tool_logical_capabilities_unsorted');
    assert(id === name && name === mcpTool, 'tool_identity_mismatch');
    assert(jsonSchema.type === 'object', 'tool_json_schema_invalid');
    assert(jsonSchema.additionalProperties === false, 'tool_json_schema_unconstrained');
    record(jsonSchema.properties, 'tool.json_schema.properties');
    const digest = nonEmpty(tool.digest, 'tool.digest');
    assert(DIGEST_PATTERN.test(digest), 'tool_digest_invalid');
    const material = {
      id,
      name,
      version,
      serverIdentity,
      mcpServer,
      mcpTool,
      jsonSchema,
      logicalCapabilities,
    };
    assert(
      (await computeContractDigest(material)) === digest,
      'tool_manifest_digest_mismatch'
    );
    const qualified = `${mcpServer}:${mcpTool}`;
    assert(!seenIds.has(id), 'tool_manifest_id_duplicate');
    assert(!seenDigests.has(digest), 'tool_manifest_digest_duplicate');
    assert(!seenQualified.has(qualified), 'tool_manifest_mcp_duplicate');
    seenIds.add(id);
    seenDigests.add(digest);
    seenQualified.add(qualified);
    result.push({
      ...tool,
      id,
      name,
      version,
      server_identity: serverIdentity,
      mcp_server: mcpServer,
      mcp_tool: mcpTool,
      json_schema: jsonSchema,
      logical_capabilities: logicalCapabilities,
      digest,
    });
  }
  return result;
}

function validateRuntimeBindings(
  task,
  profile,
  specialist,
  skills,
  tools,
  toolDigests,
  envelope
) {
  const profileTools = array(profile.tools, 'runtime_profile.tools');
  assertSameSet(
    toolDigests,
    profileTools.map((tool) => record(tool, 'runtime_profile.tool').digest),
    'runtime_profile_tool_binding_mismatch'
  );
  for (const tool of tools) {
    const ref = profileTools.find(
      (candidate) =>
        isRecord(candidate) && candidate.id === tool.id && candidate.digest === tool.digest
    );
    assert(
      isRecord(ref) &&
        ref.version === tool.version &&
        ref.serverIdentity === tool.server_identity,
      'runtime_profile_tool_ref_mismatch'
    );
  }

  const profileMcpServers = array(profile.mcpServers, 'runtime_profile.mcpServers').map(
    (entry) => nonEmpty(record(entry, 'mcp_server').id, 'mcp_server.id')
  );
  const runtimeMcpServers = array(
    record(record(profile.runtime, 'runtime_profile.runtime').contract, 'runtime_contract')
      .mcp_servers,
    'runtime_contract.mcp_servers'
  );
  for (const server of Object.keys(toolsByServer(tools))) {
    assert(profileMcpServers.includes(server), 'runtime_profile_mcp_mismatch');
    assert(runtimeMcpServers.includes(server), 'runtime_contract_mcp_mismatch');
  }

  const skillIds = array(task.skill_ids, 'task.skill_ids').map((value) =>
    nonEmpty(value, 'task.skill_id')
  );
  const profileSkills = array(profile.skills, 'runtime_profile.skills');
  assertSameSet(
    skillIds,
    skills.map((skill) => skill.id),
    'specialist_skill_binding_mismatch'
  );
  assertSameSet(
    skillIds,
    profileSkills.map((entry) =>
      nonEmpty(record(entry, 'runtime_profile.skill').id, 'runtime_profile.skill.id')
    ),
    'runtime_profile_skill_binding_mismatch'
  );
  const runtimeSkills = array(
    record(record(profile.runtime, 'runtime_profile.runtime').contract, 'runtime_contract')
      .skills,
    'runtime_contract.skills'
  );
  assertSameSet(skillIds, runtimeSkills, 'runtime_contract_skill_binding_mismatch');
  assertSameSet(
    skills.map((skill) => skill.digest),
    array(envelope.skillVersionDigests, 'execution_envelope.skillVersionDigests'),
    'envelope_skill_binding_mismatch'
  );
  for (const skill of skills) {
    const ref = profileSkills.find(
      (entry) =>
        isRecord(entry) && entry.id === skill.id && entry.digest === skill.digest
    );
    assert(
      isRecord(ref) && ref.version === skill.version,
      'runtime_profile_skill_ref_mismatch'
    );
  }
  const charterSkill = skills.find((skill) => skill.id === 'orgx.specialist.charter');
  assert(
    isRecord(charterSkill) && charterSkill.instructions === specialist.instructions,
    'specialist_charter_content_mismatch'
  );
}

async function verifySourceDigest(source, label) {
  assert(DIGEST_PATTERN.test(String(source.digest ?? '')), `${label}_digest_invalid`);
  assert(await verifyContractDigest(source, source.digest), `${label}_digest_mismatch`);
}

function mcpIdentifier(value, label) {
  const normalized = nonEmpty(value, label);
  assert(MCP_IDENTIFIER_PATTERN.test(normalized), 'mcp_identifier_invalid');
  return normalized;
}

function schemasByServer(tools) {
  const result = {};
  for (const tool of tools) {
    result[tool.mcp_server] ??= {};
    result[tool.mcp_server][tool.mcp_tool] = tool.json_schema;
  }
  return result;
}
