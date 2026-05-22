import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const manifestPath = resolve(root, '.codex-plugin', 'plugin.json');
const mcpPath = resolve(root, '.mcp.json');
const marketplacePath = resolve(root, '.agents', 'plugins', 'marketplace.json');
const codexHooksPath = resolve(root, 'hooks', 'codex', 'hooks.json');
const hookScriptPath = resolve(root, 'hooks', 'scripts', 'orgx-session-hook.mjs');

function fail(message) {
  console.error(`verify-plugin: ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (!existsSync(manifestPath)) fail('missing .codex-plugin/plugin.json');
if (!existsSync(mcpPath)) fail('missing .mcp.json');
if (!existsSync(marketplacePath)) fail('missing .agents/plugins/marketplace.json');
if (!existsSync(codexHooksPath)) fail('missing hooks/codex/hooks.json');
if (!existsSync(hookScriptPath)) fail('missing hooks/scripts/orgx-session-hook.mjs');

const manifest = readJson(manifestPath);
const mcp = readJson(mcpPath);
const marketplace = readJson(marketplacePath);
const codexHooks = readJson(codexHooksPath);

if (!manifest.name || typeof manifest.name !== 'string') {
  fail('manifest.name must be a non-empty string');
}
if (!manifest.version || typeof manifest.version !== 'string') {
  fail('manifest.version must be a non-empty string');
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
  fail('mcpServers.orgx.url must target https://mcp.useorgx.com/mcp');
}

for (const skillName of ['orgx-initiative-ops', 'orgx-runtime-reporting']) {
  const skillPath = resolve(root, 'skills', skillName, 'SKILL.md');
  if (!existsSync(skillPath)) {
    fail(`missing skill: ${skillName}`);
  }
}

if (!codexHooks.hooks || typeof codexHooks.hooks !== 'object') {
  fail('hooks/codex/hooks.json must define hooks');
}
for (const eventName of [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
]) {
  const entries = codexHooks.hooks[eventName];
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`hooks/codex/hooks.json missing ${eventName}`);
  }
  const hasOrgxCommand = entries.some(
    (entry) =>
      entry &&
      typeof entry.command === 'string' &&
      entry.command.includes('orgx-session-hook.mjs') &&
      entry.command.includes('--source_client=codex'),
  );
  if (!hasOrgxCommand) {
    fail(`${eventName} must call orgx-session-hook.mjs with source_client=codex`);
  }
}

const hookScript = readFileSync(hookScriptPath, 'utf8');
if (!hookScript.includes('orgx_codex_plugin_runtime_hook')) {
  fail('hook script must emit orgx_codex_plugin_runtime_hook records');
}
if (hookScript.includes('appendFileSync(outbox, raw')) {
  fail('hook script must not persist raw hook payloads');
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
