import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const manifestPath = resolve(root, '.codex-plugin', 'plugin.json');
const mcpPath = resolve(root, '.mcp.json');
const marketplacePath = resolve(root, '.agents', 'plugins', 'marketplace.json');

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

const manifest = readJson(manifestPath);
const mcp = readJson(mcpPath);
const marketplace = readJson(marketplacePath);

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
if (orgx.command !== 'npx') {
  fail('mcpServers.orgx.command must be npx');
}
if (!Array.isArray(orgx.args) || orgx.args[0] !== 'mcp-remote') {
  fail('mcpServers.orgx.args must start with mcp-remote');
}
if (orgx.args[1] !== 'https://mcp.useorgx.com/') {
  fail('mcpServers.orgx must target https://mcp.useorgx.com/');
}

for (const skillName of ['orgx-initiative-ops', 'orgx-runtime-reporting']) {
  const skillPath = resolve(root, 'skills', skillName, 'SKILL.md');
  if (!existsSync(skillPath)) {
    fail(`missing skill: ${skillName}`);
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

console.log('verify-plugin: ok');
