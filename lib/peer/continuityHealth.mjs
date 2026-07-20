import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_OUTBOX = join(
  homedir(),
  '.config',
  'useorgx',
  'wizard',
  'hooks',
  'events.jsonl'
);
const DEFAULT_REPORT = join(
  homedir(),
  '.config',
  'useorgx',
  'wizard',
  'hooks',
  'reports',
  'latest-work-graph-report.json'
);

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function inspectContinuityOutbox({
  outboxPath = process.env.ORGX_WIZARD_HOOK_OUTBOX ?? DEFAULT_OUTBOX,
  reportPath = process.env.ORGX_WIZARD_HOOK_REPORT_OUTPUT ?? DEFAULT_REPORT,
} = {}) {
  const [outboxText, reportText] = await Promise.all([
    readText(outboxPath),
    readText(reportPath),
  ]);
  const lines = (outboxText ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5000);
  let validRecords = 0;
  let deadLetters = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        validRecords += 1;
      } else {
        deadLetters += 1;
      }
    } catch {
      deadLetters += 1;
    }
  }

  let replayedRecords = 0;
  let lastReplayAt = null;
  if (reportText) {
    try {
      const report = JSON.parse(reportText);
      if (report?.posted) {
        replayedRecords = Number.isFinite(report.records_read)
          ? Math.max(0, Math.round(report.records_read))
          : 0;
        lastReplayAt =
          typeof report.report?.generated_at === 'string'
            ? report.report.generated_at
            : null;
      }
    } catch {
      deadLetters += 1;
    }
  }
  const pending = Math.max(0, validRecords - replayedRecords);
  return {
    state: deadLetters > 0 ? 'degraded' : pending > 0 ? 'pending' : 'ready',
    pending,
    dead_letters: deadLetters,
    last_replay_at: lastReplayAt,
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
    last_receipt_at: outboxHealth.last_replay_at,
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
