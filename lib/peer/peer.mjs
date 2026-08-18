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
import { createTransportLogger } from './transportLog.mjs';

const HEARTBEAT_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How often the peer drains the shared hook spool. Nothing scheduled this
 * before, which is why `events.jsonl` reached ~155MB having never uploaded.
 */
const SPOOL_REPLAY_MS = 5 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');

/**
 * Reconnect policy for the gateway socket.
 *
 * The SDK's default caps at 30s, which still means ~2,880 reconnect attempts a
 * day against a gateway that is permanently rejecting this runner. Backing off
 * to a 5-minute ceiling keeps a healthy runner responsive while making a
 * persistent rejection cheap. Terminal rejections (HTTP 409) stop the loop
 * outright — see `onError` below.
 */
const RECONNECT_POLICY = {
  initialDelayMs: 1_000,
  maxDelayMs: 300_000,
  jitterRatio: 0.3,
};

export async function startPeer(opts) {
  const baseUrl = opts.baseUrl ?? 'https://useorgx.com';
  const manifest = await loadManifest();

  const driver = opts.driver ?? new CodexDriver({
    skillRules: () => fetchSkillRules(baseUrl, opts),
  });

  // Every gateway lifecycle log goes through this logger. It is the only place
  // allowed to touch a transport error, and it never hands the raw object to
  // the console: the ws ErrorEvent reaches the live API key through
  // `target._req._header` (the raw upgrade text carries
  // `Sec-WebSocket-Protocol: orgx.v3, bearer.oxk_...`).
  const transportLog =
    opts.transportLogger ?? createTransportLogger({ prefix: '[orgx-codex-plugin]' });

  let terminated = false;
  let clientRef = null;

  const client = new PeerClient({
    baseUrl: httpsToWss(baseUrl),
    apiKey: opts.apiKey,
    workspaceId: opts.workspaceId,
    pluginId: '@useorgx/codex-plugin',
    drivers: [driver],
    reconnect: opts.reconnect ?? RECONNECT_POLICY,
    onOpen: () => transportLog.connected(),
    onClose: (code, reason) => transportLog.closed(code, reason),
    onError: (err) =>
      transportLog.error(err, {
        onTerminal: () => {
          // HTTP 409 `runner-instance-id-required`: the workspace has canonical
          // runner ids and this runner cannot present one. Retrying can never
          // succeed, so stop the loop instead of writing an error per attempt
          // until the disk fills.
          terminated = true;
          try {
            clientRef?.disconnect(1000, 'runner reactivation required');
          } catch {
            /* transport already torn down */
          }
        },
      }),
  });
  clientRef = client;
  client.connect();

  let heartbeatTimer = null;
  if (!opts.skipHeartbeat) {
    await postHeartbeat(baseUrl, opts, manifest).catch((err) =>
      transportLog.failure('initial heartbeat failed', err)
    );
    heartbeatTimer = setInterval(() => {
      if (terminated) return;
      postHeartbeat(baseUrl, opts, manifest).catch((err) =>
        transportLog.failure('weekly heartbeat failed', err)
      );
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  // Fold hook-spool replay into the peer's periodic loop so it runs
  // automatically with the runner's own credential. Previously the uploader
  // only ran when a human invoked the reconcile script with `--post=true`.
  const replaySpool = opts.replayHookSpoolImpl ?? defaultReplayHookSpool;
  let spoolTimer = null;
  const tickSpool = async () => {
    if (terminated) return;
    try {
      const result = await replaySpool({
        baseUrl,
        apiKey: opts.apiKey,
        workspaceId: opts.workspaceId,
        spoolPath: opts.hookSpoolPath,
      });
      if (result?.posted > 0) {
        console.log('[orgx-codex-plugin] hook spool replayed', {
          posted: result.posted,
          batches: result.batches,
          drained: result.drained === true,
          rotated: result.rotated === true,
        });
      }
    } catch (err) {
      transportLog.failure('hook spool replay failed', err);
    }
  };

  if (opts.skipSpoolReplay !== true) {
    void tickSpool();
    spoolTimer = setInterval(() => void tickSpool(), SPOOL_REPLAY_MS);
    spoolTimer.unref?.();
  }

  return {
    client,
    get terminated() {
      return terminated;
    },
    replayHookSpoolNow: tickSpool,
    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (spoolTimer) clearInterval(spoolTimer);
      client.disconnect();
    },
  };
}

/**
 * Default spool replay: read a batch from the durable cursor, turn it into a
 * Work Graph report, POST it, then advance the cursor. Imported lazily so the
 * peer does not pull the reconcile script on startup.
 */
async function defaultReplayHookSpool({ baseUrl, apiKey, workspaceId, spoolPath }) {
  if (!apiKey) return { status: 'skipped', reason: 'no_api_key', posted: 0 };

  const [{ replayHookSpool, defaultSpoolPath }, reconcile] = await Promise.all([
    import('./hookSpoolReplay.mjs'),
    import('../../hooks/scripts/orgx-work-graph-reconcile.mjs'),
  ]);

  return replayHookSpool({
    spoolPath: spoolPath ?? defaultSpoolPath(),
    postImpl: async (records) => {
      const report = reconcile.buildWorkGraphReport(records, {
        workspaceId,
        sourceClient: 'codex',
      });
      await reconcile.postWorkGraphReport({ report, baseUrl, apiKey });
    },
  });
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
