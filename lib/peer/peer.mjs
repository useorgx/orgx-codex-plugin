/**
 * Peer runtime for @useorgx/codex-plugin — wires CodexDriver into
 * PeerClient and manages runtime presence plus license heartbeat. Mirror of the claude-code
 * plugin's sidecar; see that plugin's lib/peer/README.md for the mental
 * model (skill catalog is shared; peer is a second shape, not a
 * replacement).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PeerClient } from '@useorgx/orgx-gateway-sdk';
import WebSocket from 'ws';

import { CodexDriver } from './CodexDriver.mjs';
import { buildPluginContinuityHealth } from './continuityHealth.mjs';
import {
  capturePeerException,
  initializePeerSentry,
} from './sentry.mjs';

const PRESENCE_HEARTBEAT_MS = 20_000;
const LICENSE_HEARTBEAT_MS = 7 * 24 * 60 * 60 * 1000;
const PLUGIN_ID = 'orgx-codex-plugin';
// Protocol v2 requires a canonical proof-bearing ExecutionResult. Keep the
// production peer on v1 until the driver can obtain that proof from OrgX.
const GATEWAY_PROTOCOL_VERSION = 1;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');

export async function startPeer(opts) {
  const baseUrl = opts.baseUrl ?? 'https://useorgx.com';
  const manifest = await loadManifest();
  initializePeerSentry(manifest.version);

  const driver = opts.driver ?? new CodexDriver({
    skillRules: () => fetchSkillRules(baseUrl, opts),
  });

  let transportOnline = false;
  let presenceTimer = null;
  const heartbeatPresence = () =>
    postPresenceHeartbeat(baseUrl, opts, manifest, driver, transportOnline);

  const client = new PeerClient({
    baseUrl: httpsToWss(baseUrl),
    apiKey: opts.apiKey,
    workspaceId: opts.workspaceId,
    pluginId: PLUGIN_ID,
    installationId: opts.installationId ?? defaultInstallationId(),
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    drivers: [driver],
    webSocketFactory:
      opts.webSocketFactory ??
      ((url, protocols) => new WebSocket(url, protocols)),
    onOpen: () => {
      transportOnline = true;
      console.log('[orgx-codex-plugin] connected');
      void heartbeatPresence().catch((err) =>
        console.warn('[orgx-codex-plugin] open heartbeat failed', err)
      );
    },
    onClose: (code, reason) => {
      transportOnline = false;
      console.warn('[orgx-codex-plugin] closed', { code, reason });
    },
    onError: (err) => {
      capturePeerException(err, { stage: 'gateway_transport' });
      console.error('[orgx-codex-plugin] error', err);
    },
  });
  client.connect();

  let licenseHeartbeatTimer = null;
  if (!opts.skipHeartbeat) {
    await heartbeatPresence().catch((err) =>
      console.warn('[orgx-codex-plugin] initial presence heartbeat failed', err)
    );
    presenceTimer = setInterval(() => {
      heartbeatPresence().catch((err) =>
        console.warn('[orgx-codex-plugin] presence heartbeat failed', err)
      );
    }, PRESENCE_HEARTBEAT_MS);
    presenceTimer.unref?.();

    await postLicenseHeartbeat(baseUrl, opts, manifest).catch((err) =>
      console.warn('[orgx-codex-plugin] initial license heartbeat failed', err)
    );
    licenseHeartbeatTimer = setInterval(() => {
      postLicenseHeartbeat(baseUrl, opts, manifest).catch((err) =>
        console.warn('[orgx-codex-plugin] weekly license heartbeat failed', err)
      );
    }, LICENSE_HEARTBEAT_MS);
    licenseHeartbeatTimer.unref?.();
  }

  return {
    client,
    stop: async () => {
      if (presenceTimer) clearInterval(presenceTimer);
      if (licenseHeartbeatTimer) clearInterval(licenseHeartbeatTimer);
      transportOnline = false;
      client.disconnect();
    },
  };
}

async function loadManifest() {
  const path = resolve(PLUGIN_ROOT, 'plugin.manifest.json');
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      plugin_name: '@useorgx/codex-plugin',
      version: '0.0.0-dev',
      manifest_fingerprint: 'dev-placeholder',
      signature: '',
    };
  }
}

async function postPresenceHeartbeat(
  baseUrl,
  opts,
  manifest,
  driver,
  transportOnline
) {
  const detected = await driver.detect();
  const authenticated = detected.authenticated === true;
  const dispatchReady =
    transportOnline && detected.installed === true && authenticated;
  const continuityHealth = await buildPluginContinuityHealth({
    manifest,
    sourceClient: 'codex',
    authState: detected.auth_status ?? 'unknown',
    hookEvents: [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Stop',
    ],
    endpoint: opts.mcpEndpoint,
    outbox: opts.continuityOutbox,
  });
  const res = await fetch(
    `${baseUrl.replace(/\/$/, '')}/api/v1/gateway/heartbeat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        workspace_id: opts.workspaceId,
        plugin_id: PLUGIN_ID,
        installation_id: opts.installationId ?? defaultInstallationId(),
        host_platform: process.platform,
        drivers_installed: [driver.id],
        gateway_version: manifest.version,
        protocol_version: GATEWAY_PROTOCOL_VERSION,
        plan_tier: detected.plan_tier ?? null,
        subscription_type: detected.subscription_type ?? null,
        subscription_active: authenticated,
        metadata: {
          runtime: 'peer',
          transport_online: transportOnline,
          runtime_online: true,
          dispatch_ready: dispatchReady,
          auth_status: detected.auth_status ?? 'unknown',
          auth_method: detected.auth_method ?? null,
          probe_version: detected.version ?? null,
          queue_depth: driver.running?.size ?? 0,
          continuity_health: continuityHealth,
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`presence heartbeat ${res.status}`);
}

async function postLicenseHeartbeat(baseUrl, opts, manifest) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/licenses/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      workspace_id: opts.workspaceId,
      plugin_name: manifest.plugin_name,
      version: manifest.version,
      manifest_fingerprint: manifest.manifest_fingerprint,
      signature: manifest.signature,
    }),
  });
  if (!res.ok) {
    throw new Error(`heartbeat ${res.status}`);
  }
}

function defaultInstallationId() {
  return `${PLUGIN_ID}:${process.platform}:${process.env.USER ?? 'local'}`;
}

async function fetchSkillRules(baseUrl, opts) {
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/v1/plan-skills?workspace_id=${encodeURIComponent(opts.workspaceId)}`,
      { headers: { Authorization: `Bearer ${opts.apiKey}` } }
    );
    if (!res.ok) return [];
    const body = await res.json();
    const rules = [];
    for (const skill of body.skills ?? []) {
      for (const rule of skill.rules ?? []) {
        rules.push({
          skill_id: skill.id,
          match: { pattern: rule.pattern, on: rule.on },
          dedupe_fingerprint: rule.dedupe_fingerprint,
          evidence_kind: rule.evidence_kind,
        });
      }
    }
    return rules;
  } catch {
    return [];
  }
}

function httpsToWss(url) {
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length);
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length);
  return url;
}
