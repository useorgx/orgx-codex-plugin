import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { countPendingRecords, defaultCursorPath, readCursor } from './hookSpoolReplay.mjs';

const DEFAULT_OUTBOX = join(
  homedir(),
  '.config',
  'useorgx',
  'wizard',
  'hooks',
  'events.jsonl'
);
export async function inspectContinuityOutbox({
  outboxPath = process.env.ORGX_WIZARD_HOOK_OUTBOX ?? DEFAULT_OUTBOX,
  cursorPath = defaultCursorPath(outboxPath),
  maxScanBytes = 8 * 1024 * 1024,
} = {}) {
  let info;
  try {
    info = await stat(outboxPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const cursor = await readCursor(cursorPath, info);
  const counts = await countPendingRecords({
    spoolPath: outboxPath,
    startOffset: cursor.byteOffset,
    maxScanBytes,
  });
  const pending = counts.pending;
  const deadLetters = counts.deadLetters ?? 0;
  const partialBytes = counts.partialBytes ?? 0;
  return {
    state: deadLetters > 0 ? 'degraded' : pending > 0 || partialBytes > 0 || !counts.exact ? 'pending' : 'ready',
    pending,
    pending_exact: counts.exact,
    partial_bytes: partialBytes,
    dead_letters: deadLetters,
    last_replay_at: typeof cursor.lastPostedAt === 'string' ? cursor.lastPostedAt : null,
  };
}

export async function buildPluginContinuityHealth({
  manifest,
  sourceClient,
  authState,
  hookEvents,
  endpoint =
    process.env.ORGX_MCP_URL ??
    'https://mcp.useorgx.com/mcp?profile=commander',
  outbox,
  capabilitySnapshot,
}) {
  const outboxHealth = outbox ?? (await inspectContinuityOutbox());
  const version =
    typeof manifest?.version === 'string' ? manifest.version : '0.0.0-dev';
  const profile = resolveEndpointProfile(endpoint);
  const measured =
    capabilitySnapshot !== null &&
    typeof capabilitySnapshot === 'object' &&
    !Array.isArray(capabilitySnapshot);
  return {
    schema_version: 'plugin-health.v1',
    endpoint,
    source_client: sourceClient,
    auth_state: authState ?? 'unknown',
    release: {
      installed: version,
      source: version,
      deployed: version,
    },
    hooks: {
      reported: hookEvents.length,
      expected: hookEvents.length,
      terminal_passive: true,
      events: [...hookEvents],
    },
    outbox: outboxHealth,
    capabilities: {
      profile,
      profile_tools: measured
        ? normalizeCapabilityCount(capabilitySnapshot.profile_tools)
        : null,
      manifest_tools: measured
        ? normalizeCapabilityCount(capabilitySnapshot.manifest_tools)
        : null,
      inspectable_entities: measured
        ? normalizeCapabilityCount(capabilitySnapshot.inspectable_entities)
        : null,
      visible_entities: measured
        ? normalizeCapabilityCount(capabilitySnapshot.visible_entities)
        : null,
      measurement: measured ? 'measured' : 'not_probed',
    },
    // Work Graph upload time is not proof of a persisted execution receipt.
    last_receipt_at: null,
  };
}

function resolveEndpointProfile(endpoint) {
  try {
    const profile = new URL(endpoint).searchParams.get('profile')?.trim();
    return profile || null;
  } catch {
    return null;
  }
}

function normalizeCapabilityCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}
