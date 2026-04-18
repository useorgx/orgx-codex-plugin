/**
 * Peer runtime for @useorgx/codex-plugin — wires CodexDriver into
 * PeerClient and manages license heartbeat. Mirror of the claude-code
 * plugin's sidecar; see that plugin's lib/peer/README.md for the mental
 * model (skill catalog is shared; peer is a second shape, not a
 * replacement).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PeerClient } from '@useorgx/orgx-gateway-sdk';

import { CodexDriver } from './CodexDriver.mjs';

const HEARTBEAT_MS = 7 * 24 * 60 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');

export async function startPeer(opts) {
  const baseUrl = opts.baseUrl ?? 'https://useorgx.com';
  const manifest = await loadManifest();

  const driver = opts.driver ?? new CodexDriver({
    skillRules: () => fetchSkillRules(baseUrl, opts),
  });

  const client = new PeerClient({
    baseUrl: httpsToWss(baseUrl),
    apiKey: opts.apiKey,
    workspaceId: opts.workspaceId,
    pluginId: '@useorgx/codex-plugin',
    drivers: [driver],
    onOpen: () => console.log('[orgx-codex-plugin] connected'),
    onClose: (code, reason) => console.warn('[orgx-codex-plugin] closed', { code, reason }),
    onError: (err) => console.error('[orgx-codex-plugin] error', err),
  });
  client.connect();

  let heartbeatTimer = null;
  if (!opts.skipHeartbeat) {
    await postHeartbeat(baseUrl, opts, manifest).catch((err) =>
      console.warn('[orgx-codex-plugin] initial heartbeat failed', err)
    );
    heartbeatTimer = setInterval(() => {
      postHeartbeat(baseUrl, opts, manifest).catch((err) =>
        console.warn('[orgx-codex-plugin] weekly heartbeat failed', err)
      );
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  return {
    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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

async function postHeartbeat(baseUrl, opts, manifest) {
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
