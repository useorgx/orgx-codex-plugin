import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPluginContinuityHealth,
  inspectContinuityOutbox,
} from '../lib/peer/continuityHealth.mjs';
import { replayHookSpoolOnce } from '../lib/peer/hookSpoolReplay.mjs';

const NOW = '2026-07-15T12:00:00.000Z';

test('legacy report counts cannot acknowledge current spool records', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orgx-continuity-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outboxPath = join(dir, 'events.jsonl');
  const reportPath = join(dir, 'report.json');
  await writeFile(
    outboxPath,
    [
      JSON.stringify({ event: 'SessionStart' }),
      'not-json',
      JSON.stringify({ event: 'Stop' }),
      '',
    ].join('\n')
  );
  await writeFile(
    reportPath,
    JSON.stringify({
      posted: { ok: true },
      records_read: 1,
      report: { generated_at: NOW },
    })
  );

  assert.deepEqual(
    await inspectContinuityOutbox({ outboxPath, reportPath }),
    {
      state: 'degraded',
      pending: 2,
      pending_exact: true,
      partial_bytes: 0,
      dead_letters: 1,
      last_replay_at: null,
    }
  );
});

test('health follows the durable upload cursor and sees later appends', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orgx-continuity-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outboxPath = join(dir, 'events.jsonl');
  const record = JSON.stringify({ event: 'Stop' }) + '\n';
  await writeFile(outboxPath, record.repeat(3));
  await replayHookSpoolOnce({ spoolPath: outboxPath, postImpl: async () => {}, now: () => NOW });
  const drained = await inspectContinuityOutbox({ outboxPath });
  assert.equal(drained.pending, 0);
  assert.equal(drained.state, 'ready');
  assert.equal(drained.last_replay_at, NOW);
  await appendFile(outboxPath, record);
  assert.equal((await inspectContinuityOutbox({ outboxPath })).pending, 1);
});

test('an incomplete or capped scan cannot claim a healthy empty outbox', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orgx-continuity-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outboxPath = join(dir, 'events.jsonl');
  await writeFile(outboxPath, '{"event":"Sto');
  const partial = await inspectContinuityOutbox({ outboxPath });
  assert.equal(partial.state, 'pending');
  assert.equal(partial.dead_letters, 0);
  assert.ok(partial.partial_bytes > 0);
  const capped = await inspectContinuityOutbox({ outboxPath, maxScanBytes: 4 });
  assert.equal(capped.pending_exact, false);
  assert.equal(capped.state, 'pending');
});

test('plugin health reports endpoint profile without fabricating capability counts', async () => {
  const health = await buildPluginContinuityHealth({
    manifest: { version: '1.2.3' },
    sourceClient: 'test-client',
    authState: 'authenticated',
    hookEvents: ['Start', 'Stop'],
    endpoint: 'https://mcp.useorgx.com/mcp?profile=commander',
    outbox: {
      state: 'ready',
      pending: 0,
      dead_letters: 0,
      last_replay_at: NOW,
    },
  });

  assert.equal(health.schema_version, 'plugin-health.v1');
  assert.equal(health.source_client, 'test-client');
  assert.deepEqual(health.release, {
    installed: '1.2.3',
    source: '1.2.3',
    deployed: '1.2.3',
  });
  assert.equal(health.hooks.terminal_passive, true);
  assert.deepEqual(health.capabilities, {
    profile: 'commander',
    profile_tools: null,
    manifest_tools: null,
    inspectable_entities: null,
    visible_entities: null,
    measurement: 'not_probed',
  });
  assert.equal(health.last_receipt_at, null);
});

test('plugin health publishes counts only from an explicit capability snapshot', async () => {
  const health = await buildPluginContinuityHealth({
    manifest: { version: '1.2.3' },
    sourceClient: 'codex',
    authState: 'authenticated',
    hookEvents: [],
    endpoint: 'https://mcp.useorgx.com/mcp?profile=commander',
    capabilitySnapshot: {
      profile_tools: 12,
      manifest_tools: 37,
      inspectable_entities: 8,
      visible_entities: 7,
    },
    outbox: {
      state: 'ready',
      pending: 0,
      dead_letters: 0,
      last_replay_at: null,
    },
  });

  assert.deepEqual(health.capabilities, {
    profile: 'commander',
    profile_tools: 12,
    manifest_tools: 37,
    inspectable_entities: 8,
    visible_entities: 7,
    measurement: 'measured',
  });
});
