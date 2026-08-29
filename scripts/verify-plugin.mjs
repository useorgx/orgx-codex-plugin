import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const packagePath = resolve(root, 'package.json');
const peerManifestPath = resolve(root, 'plugin.manifest.json');
const manifestPath = resolve(root, '.codex-plugin', 'plugin.json');
const mcpPath = resolve(root, '.mcp.json');
const marketplacePath = resolve(root, '.agents', 'plugins', 'marketplace.json');
const clientHookCoveragePath = resolve(root, 'docs', 'client-hook-coverage.md');
const operatorReportingGatesPath = resolve(root, 'docs', 'operator-reporting-gates.json');
const codexHooksPath = resolve(root, 'hooks', 'hooks.json');
const contextHydrationPath = resolve(
  root,
  'hooks',
  'scripts',
  'hydrate-context-pack.mjs',
);
const hookReconcilerPath = resolve(
  root,
  'hooks',
  'scripts',
  'orgx-work-graph-reconcile.mjs',
);
const reportingGateDiagnosticsPath = resolve(root, 'scripts', 'diagnose-reporting-gates.mjs');
const hookInstallerPath = resolve(root, 'scripts', 'install-codex-hooks.mjs');

function fail(message) {
  console.error(`verify-plugin: ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (!existsSync(packagePath)) fail('missing package.json');
if (!existsSync(peerManifestPath)) fail('missing plugin.manifest.json');
if (!existsSync(manifestPath)) fail('missing .codex-plugin/plugin.json');
if (!existsSync(mcpPath)) fail('missing .mcp.json');
if (!existsSync(marketplacePath)) fail('missing .agents/plugins/marketplace.json');
if (!existsSync(clientHookCoveragePath)) fail('missing docs/client-hook-coverage.md');
if (!existsSync(operatorReportingGatesPath)) fail('missing docs/operator-reporting-gates.json');
if (!existsSync(codexHooksPath)) fail('missing hooks/hooks.json');
if (!existsSync(contextHydrationPath)) {
  fail('missing hooks/scripts/hydrate-context-pack.mjs');
}
if (!existsSync(hookReconcilerPath)) {
  fail('missing hooks/scripts/orgx-work-graph-reconcile.mjs');
}
if (!existsSync(reportingGateDiagnosticsPath)) fail('missing scripts/diagnose-reporting-gates.mjs');
if (!existsSync(hookInstallerPath)) fail('missing scripts/install-codex-hooks.mjs');

const pkg = readJson(packagePath);
const peerManifest = readJson(peerManifestPath);
const manifest = readJson(manifestPath);
const mcp = readJson(mcpPath);
const marketplace = readJson(marketplacePath);
const codexHooks = readJson(codexHooksPath);
const operatorReportingGates = readJson(operatorReportingGatesPath);
const clientHookCoverage = readFileSync(clientHookCoveragePath, 'utf8');

for (const section of ['dependencies', 'optionalDependencies']) {
  for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
    if (
      /^(?:git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|git@)/i.test(
        String(specifier),
      )
    ) {
      fail(
        `package.json ${section}.${name} must use a registry version, not a Git dependency`,
      );
    }
  }
}

if (!manifest.name || typeof manifest.name !== 'string') {
  fail('manifest.name must be a non-empty string');
}
if (!manifest.version || typeof manifest.version !== 'string') {
  fail('manifest.version must be a non-empty string');
}
if (pkg.version !== manifest.version) {
  fail('package.json version must match .codex-plugin/plugin.json version');
}
if (peerManifest.version !== pkg.version) {
  fail('plugin.manifest.json version must match package.json version');
}
if (!Array.isArray(peerManifest.capabilities)) {
  fail('plugin.manifest.json capabilities must be an array');
}
for (const capability of ['plugin:heartbeat', 'plugin:runtime_hooks', 'work_graph:reconcile']) {
  if (!peerManifest.capabilities.includes(capability)) {
    fail(`plugin.manifest.json missing capability: ${capability}`);
  }
}
if (!manifest.description || typeof manifest.description !== 'string') {
  fail('manifest.description must be a non-empty string');
}
if (manifest.skills !== './skills/') {
  fail('manifest.skills must point to ./skills/');
}
if (manifest.mcpServers !== './.mcp.json') {
  fail('manifest.mcpServers must point to ./.mcp.json');
}
if (
  !manifest.interface.defaultPrompt?.some((prompt) =>
    /operator chronicle/i.test(prompt)
  )
) {
  fail('defaultPrompt must include an operator chronicle reporting prompt');
}
if (
  !Array.isArray(manifest.interface.defaultPrompt) ||
  manifest.interface.defaultPrompt.length === 0 ||
  manifest.interface.defaultPrompt.some(
    (prompt) =>
      typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 128,
  )
) {
  fail('every defaultPrompt entry must contain 1 to 128 characters');
}
if (
  !manifest.interface.defaultPrompt?.some(
    (prompt) =>
      prompt.includes('get_operator_chronicle') &&
      prompt.includes('orgx_recommend') &&
      prompt.includes('mode="morning_brief"') &&
      prompt.includes('reportingNarrative.briefMarkdown'),
  )
) {
  fail('defaultPrompt chronicle prompt must document direct tool and stale-client fallback');
}
if (!manifest.interface.longDescription.includes('operator chronicle reporting')) {
  fail('longDescription must mention operator chronicle reporting');
}

const interfaceFields = [
  'displayName',
  'shortDescription',
  'developerName',
  'category',
  'websiteURL',
  'privacyPolicyURL',
  'termsOfServiceURL',
  'brandColor',
  'composerIcon',
  'logo',
];

if (!manifest.interface || typeof manifest.interface !== 'object') {
  fail('manifest.interface is required');
}

for (const field of interfaceFields) {
  if (
    !manifest.interface[field] ||
    typeof manifest.interface[field] !== 'string'
  ) {
    fail(`manifest.interface.${field} must be a non-empty string`);
  }
}

for (const assetField of ['composerIcon', 'logo']) {
  const assetPath = resolve(root, manifest.interface[assetField]);
  if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
    fail(`missing asset for ${assetField}: ${manifest.interface[assetField]}`);
  }
}

if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object') {
  fail('.mcp.json must define mcpServers');
}
if (!mcp.mcpServers.orgx || typeof mcp.mcpServers.orgx !== 'object') {
  fail('.mcp.json must define mcpServers.orgx');
}

const orgx = mcp.mcpServers.orgx;
if (orgx.type !== 'http') {
  fail('mcpServers.orgx.type must be http');
}
if (orgx.url !== 'https://mcp.useorgx.com/mcp') {
  fail('mcpServers.orgx.url must target the canonical MCP resource');
}
if (orgx.oauth_resource !== 'https://mcp.useorgx.com/mcp') {
  fail('mcpServers.orgx.oauth_resource must target the canonical OAuth resource');
}
if (orgx.http_headers?.['x-orgx-tool-profile'] !== 'commander') {
  fail('mcpServers.orgx.http_headers must request the commander tool profile');
}
if (!String(orgx.note ?? '').includes('operator chronicle reporting')) {
  fail('mcpServers.orgx.note must mention operator chronicle reporting');
}

for (const expected of [
  'Coverage is not sufficient yet for the full operator experience.',
  'Codex',
  'ChatGPT',
  'Claude Code',
  'Cursor',
  'get_operator_chronicle',
  'orgx_recommend',
  'mode: "morning_brief"',
  'raw_transcripts_sent: false',
]) {
  if (!clientHookCoverage.includes(expected)) {
    fail(`client hook coverage audit must include: ${expected}`);
  }
}

if (operatorReportingGates.schemaVersion !== 1) {
  fail('operator reporting gates schemaVersion must be 1');
}
if (!Array.isArray(operatorReportingGates.requiredReadoutFields)) {
  fail('operator reporting gates must define requiredReadoutFields');
}
for (const expected of [
  'reportingNarrative.briefMarkdown',
  'decisionChronology',
  'artifactLedger',
  'prVelocity',
  'initiatives',
  'goals',
  'dataGaps',
  'topPriorities',
]) {
  if (!operatorReportingGates.requiredReadoutFields.includes(expected)) {
    fail(`operator reporting gates missing readout field: ${expected}`);
  }
}
if (!Array.isArray(operatorReportingGates.acceptableRoutes)) {
  fail('operator reporting gates must define acceptableRoutes');
}
for (const expected of [
  'direct_mcp_readout',
  'mcp_morning_brief_fallback',
  'passive_hook_reconciliation',
]) {
  if (!operatorReportingGates.acceptableRoutes.some((route) => route.id === expected)) {
    fail(`operator reporting gates missing route: ${expected}`);
  }
}
if (!Array.isArray(operatorReportingGates.clientHookSurfaces)) {
  fail('operator reporting gates must define clientHookSurfaces');
}
const hookSurfacesByClient = new Map(
  operatorReportingGates.clientHookSurfaces.map((surface) => [
    surface.client,
    surface,
  ]),
);
for (const expected of ['codex', 'chatgpt', 'claude-code', 'cursor']) {
  if (!hookSurfacesByClient.has(expected)) {
    fail(`operator reporting gates missing client hook surface: ${expected}`);
  }
}
for (const surface of operatorReportingGates.clientHookSurfaces) {
  for (const field of [
    'client',
    'bestAvailableSurface',
    'directReadoutPath',
    'fallbackPath',
    'passiveHookSupport',
    'nativeHookCoverageStatus',
    'sufficiency',
    'currentGap',
  ]) {
    if (!surface[field] || typeof surface[field] !== 'string') {
      fail(
        `client hook surface ${surface.client ?? '<unknown>'} must include ${field}`,
      );
    }
  }
}
if (!hookSurfacesByClient.get('codex').passiveHookSupport.includes('Stop')) {
  fail('Codex hook surface must explicitly include Stop hook coverage');
}
if (
  hookSurfacesByClient.get('chatgpt').passiveHookSupport !==
  'none in this package'
) {
  fail('ChatGPT hook surface must not claim local passive hook support');
}
if (
  !hookSurfacesByClient
    .get('cursor')
    .directReadoutPath.includes('get_operator_chronicle')
) {
  fail('Cursor hook surface must preserve direct chronicle readout path');
}
if (!hookSurfacesByClient.get('claude-code').fallbackPath.includes('morning_brief')) {
  fail('Claude Code hook surface must preserve the morning_brief fallback');
}
if (!Array.isArray(operatorReportingGates.gates)) {
  fail('operator reporting gates must define gates');
}
const gatesById = new Map(operatorReportingGates.gates.map((gate) => [gate.id, gate]));
for (const expected of [
  'hosted_mcp_descriptor',
  'local_reporting_gate_diagnostics',
  'client_hook_surface_contract',
  'codex_direct_tool_exposure',
  'codex_morning_brief_fallback',
  'codex_first_turn_context',
  'codex_stop_reconciliation',
  'chatgpt_action_list',
  'claude_direct_readout',
  'cursor_morning_brief_command',
  'cursor_config_shape',
  'cursor_agent_auth',
  'cursor_auth_durability',
  'accepted_goal_links_live_data',
]) {
  if (!gatesById.has(expected)) {
    fail(`operator reporting gates missing gate: ${expected}`);
  }
}
for (const gate of operatorReportingGates.gates) {
  if (!gate.id || !gate.client || !gate.status || !gate.route || !gate.evidence || !gate.nextStep) {
    fail(`operator reporting gate ${gate.id ?? '<unknown>'} must include id, client, status, route, evidence, and nextStep`);
  }
}
if (gatesById.get('codex_direct_tool_exposure').status === 'verified') {
  fail('codex_direct_tool_exposure must not be marked verified until direct callable exposure is proven');
}
if (gatesById.get('chatgpt_action_list').status === 'verified') {
  fail('chatgpt_action_list must not be marked verified until app action-list UI proof exists');
}
if (gatesById.get('cursor_auth_durability').status === 'verified') {
  fail('cursor_auth_durability must not be marked verified until repeated list-tools calls work without login');
}
if (gatesById.get('cursor_agent_auth').status === 'verified') {
  fail('cursor_agent_auth must not be marked verified while cursor-agent status reports Not logged in');
}
if (gatesById.get('accepted_goal_links_live_data').status === 'verified') {
  fail('accepted_goal_links_live_data must not be marked verified while the chronicle reports provisional goal signals');
}

for (const skillName of ['orgx-initiative-ops', 'orgx-runtime-reporting']) {
  const skillPath = resolve(root, 'skills', skillName, 'SKILL.md');
  if (!existsSync(skillPath)) {
    fail(`missing skill: ${skillName}`);
  }
  const skillText = readFileSync(skillPath, 'utf8');
  if (!skillText.includes('get_operator_chronicle')) {
    fail(`${skillName} must route reporting questions through get_operator_chronicle`);
  }
  if (!skillText.includes('orgx_recommend') || !skillText.includes('morning_brief')) {
    fail(`${skillName} must document the orgx_recommend morning_brief stale-client fallback`);
  }
}

if (!codexHooks.hooks || typeof codexHooks.hooks !== 'object') {
  fail('hooks/hooks.json must define hooks');
}

function commandHandlers(entries, eventName) {
  const handlers = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.matcher !== '' ||
      !Array.isArray(entry.hooks) ||
      entry.hooks.length === 0
    ) {
      fail(`${eventName} must use non-empty canonical universal matcher groups`);
    }
    for (const handler of entry.hooks) {
      if (
        !handler ||
        typeof handler !== 'object' ||
        handler.type !== 'command' ||
        typeof handler.command !== 'string' ||
        handler.command.length === 0
      ) {
        fail(`${eventName} must contain only typed command handlers`);
      }
      handlers.push(handler);
    }
  }
  return handlers;
}

const hookEvents = Object.keys(codexHooks.hooks);
if (hookEvents.length !== 1 || hookEvents[0] !== 'SessionStart') {
  fail('plugin hooks must hydrate SessionStart only; Wizard owns all session capture');
}

const sessionStartEntries = commandHandlers(
  codexHooks.hooks.SessionStart,
  'SessionStart',
);
if (sessionStartEntries.length !== 1) {
  fail('SessionStart must contain exactly one context hydration handler');
}
const [sessionStart] = sessionStartEntries;
if (
  !sessionStart.command.includes('${PLUGIN_ROOT}') ||
  !sessionStart.command.includes('hydrate-context-pack.mjs')
) {
  fail('SessionStart must call the plugin-root context hydrator');
}
if (
  !Number.isInteger(sessionStart.timeout) ||
  sessionStart.timeout < 1 ||
  sessionStart.timeout > 8
) {
  fail('SessionStart context hydration timeout must be between 1 and 8 seconds');
}
if (
  !Number.isInteger(sessionStart.additionalContextLimit) ||
  sessionStart.additionalContextLimit < 1 ||
  sessionStart.additionalContextLimit > 2048
) {
  fail('SessionStart additionalContextLimit must be between 1 and 2048 tokens');
}

const contextHydration = readFileSync(contextHydrationPath, 'utf8');
for (const expected of [
  '/api/v1/context-pack',
  'ORGX_WORKSPACE_ID',
  'ORGX_INITIATIVE_ID',
  'ORGX_WORKSTREAM_ID',
  'ORGX_TASK_ID',
  'data.sessionWorkContext',
  'sessions',
  'context',
  'set',
  'buildCodexSessionStartOutput',
  'MAX_CONTEXT_PACK_RESPONSE_BYTES',
  'PENDING_CONTEXT_FILENAME',
]) {
  if (!contextHydration.includes(expected)) {
    fail(`context hydration must include ${expected}`);
  }
}
if (/localConfig\?\.(?:apiKey|api_key)/.test(contextHydration)) {
  fail('context hydration must never load credentials from project config');
}

const hookReconciler = readFileSync(hookReconcilerPath, 'utf8');
for (const expected of [
  'work_graph_fingerprint',
  'signup_hydration',
  'raw_transcripts_sent: false',
  'raw_transcripts_excluded: true',
]) {
  if (!hookReconciler.includes(expected)) {
    fail(`hook reconciler must include ${expected}`);
  }
}
if (
  !pkg.bin ||
  pkg.bin['orgx-codex-reconcile-hooks'] !==
    'hooks/scripts/orgx-work-graph-reconcile.mjs'
) {
  fail('package bin must expose orgx-codex-reconcile-hooks');
}
if (pkg.bin['orgx-codex-diagnose-reporting'] !== 'scripts/diagnose-reporting-gates.mjs') {
  fail('package bin must expose orgx-codex-diagnose-reporting');
}
if (pkg.bin['orgx-codex-install-hooks'] !== 'scripts/install-codex-hooks.mjs') {
  fail('package bin must expose orgx-codex-install-hooks');
}
const hookInstaller = readFileSync(hookInstallerPath, 'utf8');
for (const expected of [
  'ORGX_SESSION_WORK_EPISODE_CAPTURE',
  'metadata-only',
  '--work-capture',
  'credentialFreeInstallEnvironment',
]) {
  if (!hookInstaller.includes(expected)) {
    fail(`hook installer must include ${expected}`);
  }
}
const reportingGateDiagnostics = readFileSync(reportingGateDiagnosticsPath, 'utf8');
for (const expected of [
  'cursor-agent',
  'cursor-agent mcp list reports no configured servers',
  'Client ID mismatch',
  'get_operator_chronicle',
  'raw_transcripts_sent',
  'orgx_codex_plugin_reporting_gate_diagnostics',
  'client_hook_surface_contract',
  'recommendedActions',
  'cursor-agent login',
]) {
  if (!reportingGateDiagnostics.includes(expected)) {
    fail(`reporting gate diagnostics must include ${expected}`);
  }
}
if (reportingGateDiagnostics.includes('.cursor/mcp.json')) {
  fail('reporting gate diagnostics must not read or print Cursor config paths');
}
if (!Array.isArray(pkg.files)) {
  fail('package.json must define a publish files allowlist');
}
for (const expectedPath of [
  '.codex-plugin/',
  'hooks/hooks.json',
  'hooks/scripts/hydrate-context-pack.mjs',
  'hooks/scripts/orgx-work-graph-reconcile.mjs',
  'docs/client-hook-coverage.md',
  'docs/operator-reporting-gates.json',
  'lib/peer/peer.mjs',
  'lib/peer/runnerInstanceIdentity.mjs',
  'scripts/diagnose-reporting-gates.mjs',
  'scripts/install-codex-hooks.mjs',
  'skills/',
]) {
  if (!pkg.files.includes(expectedPath)) {
    fail(`package files allowlist missing ${expectedPath}`);
  }
}
for (const forbiddenPath of [
  '.codex/',
  'AGENTS.md',
  'hooks/codex/',
  'hooks/scripts/orgx-session-hook.mjs',
  'hooks/scripts/orgx-reconcile-hook.mjs',
  'hooks/scripts/orgx-session-hook.test.mjs',
]) {
  if (pkg.files.includes(forbiddenPath)) {
    fail(`package files allowlist must not include local/test artifact ${forbiddenPath}`);
  }
}

if (marketplace.name !== 'orgx-local') {
  fail('marketplace.name must be orgx-local');
}
if (
  !marketplace.interface ||
  marketplace.interface.displayName !== 'OrgX Local'
) {
  fail('marketplace.interface.displayName must be OrgX Local');
}
if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
  fail('marketplace.plugins must contain exactly one plugin entry');
}

const [pluginEntry] = marketplace.plugins;
if (pluginEntry.name !== manifest.name) {
  fail('marketplace plugin name must match manifest.name');
}
if (
  !pluginEntry.source ||
  pluginEntry.source.source !== 'local' ||
  pluginEntry.source.path !== './'
) {
  fail('marketplace source must be local and point to ./');
}
if (
  !pluginEntry.policy ||
  pluginEntry.policy.installation !== 'AVAILABLE' ||
  pluginEntry.policy.authentication !== 'ON_INSTALL'
) {
  fail(
    'marketplace policy must set installation=AVAILABLE and authentication=ON_INSTALL',
  );
}
if (pluginEntry.category !== 'Productivity') {
  fail('marketplace category must be Productivity');
}

if (!manifest.interface.capabilities.includes('Interactive')) {
  fail('manifest.interface.capabilities must include Interactive');
}

console.log('verify-plugin: ok');
