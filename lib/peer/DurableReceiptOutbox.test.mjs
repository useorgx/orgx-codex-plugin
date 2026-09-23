import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DurableReceiptDriver,
  DurableReceiptOutbox,
} from './DurableReceiptOutbox.mjs';
import { payloadDigest } from './deliveryAck.mjs';

describe('durable terminal receipt outbox', () => {
  it('retains a rejected receipt and replays it after peer restart', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'orgx-receipt-outbox-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const rejected = [];
    const first = outbox(directory, async (url, init) => {
      rejected.push({ url: String(url), init });
      return { ok: false, status: 503 };
    });

    const firstResult = await first.enqueue(completion());
    assert.deepEqual(firstResult, { durable: true, acknowledged: false });
    assert.equal(rejected.length, 1);
    assert.equal((await receiptFiles(directory)).length, 1);

    const replayed = [];
    const restarted = outbox(directory, async (url, init) => {
      replayed.push({ url: String(url), init });
      return acked(init, 201);
    });
    const flush = await restarted.flush();

    assert.deepEqual(flush, { attempted: 1, acknowledged: 1, pending: 0 });
    assert.equal((await receiptFiles(directory)).length, 0);
    assert.equal(replayed.length, 1);
    assert.match(replayed[0].url, /\/api\/v1\/runs\/run-1\/receipt$/);
    assert.equal(replayed[0].init.headers['Idempotency-Key'], 'run-1');
    assert.deepEqual(JSON.parse(replayed[0].init.body), {
      provider: 'openai',
      source_sub_type: 'subscription',
      source_driver: 'codex',
      started_at: '2026-07-17T12:00:00.000Z',
      first_response_at: null,
      completed_at: '2026-07-17T12:01:00.000Z',
      tokens_used: 42,
      cost_estimate_cents: 0,
      saved_estimate_cents: 0,
      outcome_kind: 'awaiting_review',
      metadata: { recovered_from: 'codex_plugin_durable_outbox' },
    });
  });

  it('retains and replays task.failed so a dropped socket cannot strand a run', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'orgx-failure-outbox-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const first = outbox(directory, async () => ({ ok: false, status: 500 }));

    const firstResult = await first.enqueue(failure());
    assert.deepEqual(firstResult, { durable: true, acknowledged: false });
    assert.equal((await receiptFiles(directory)).length, 1);

    const replayed = [];
    const restarted = outbox(directory, async (url, init) => {
      replayed.push({ url: String(url), init });
      return acked(init, 200);
    });
    const flush = await restarted.flush();

    assert.deepEqual(flush, { attempted: 1, acknowledged: 1, pending: 0 });
    assert.equal((await receiptFiles(directory)).length, 0);
    assert.deepEqual(JSON.parse(replayed[0].init.body), failure());
    assert.equal(replayed[0].init.headers['Idempotency-Key'], 'run-failed');
  });

  it('keeps the record on a 2xx that is not a digest-bound ACK (plan v3 §5.6)', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'orgx-bare-ack-outbox-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const responses = [
      { ok: true, status: 200, json: async () => ({}) },
      { ok: true, status: 201, json: async () => ({ receipt_id: 'receipt-1' }) },
      {
        ok: true,
        status: 201,
        json: async () => ({
          ack: { operation_id: 'run-1', payload_digest: payloadDigest('{}'), disposition: 'persisted' },
        }),
      },
    ];
    for (const response of responses) {
      const result = await outbox(directory, async () => response).enqueue(completion());
      assert.equal(result.acknowledged, false);
      assert.equal((await receiptFiles(directory)).length, 1);
    }
  });

  it('settles a failure report that a different terminal already superseded', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'orgx-superseded-outbox-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = await outbox(directory, async () => ({
      ok: false,
      status: 409,
      json: async () => ({ reason: 'run_already_terminal', run_status: 'completed' }),
    })).enqueue(failure());
    assert.equal(result.acknowledged, true);
    assert.equal((await receiptFiles(directory)).length, 0);
  });

  it('sends the digest of the exact bytes posted', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'orgx-digest-outbox-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let seen;
    await outbox(directory, async (_url, init) => {
      seen = init;
      return acked(init, 201);
    }).enqueue(completion());
    assert.equal(seen.headers['X-OrgX-Payload-Digest'], payloadDigest(seen.body));
    assert.equal(seen.headers['Idempotency-Key'], 'run-1');
  });

  it('persists before yielding a terminal message to the SDK', async () => {
    const calls = [];
    const driver = new DurableReceiptDriver(
      {
        id: 'codex',
        async *dispatch() {
          yield completion();
        },
      },
      {
        enqueue: async (message) => {
          calls.push(message.run_id);
          return { durable: true, acknowledged: false };
        },
      }
    );

    const messages = await collect(
      driver.dispatch({}, { run_id: 'run-1', idempotency_key: 'key-1' })
    );
    assert.deepEqual(calls, ['run-1']);
    assert.deepEqual(messages, [completion()]);
  });

  it('fails recoverably instead of emitting a non-durable completion', async () => {
    const driver = new DurableReceiptDriver(
      {
        id: 'codex',
        async *dispatch() {
          yield completion();
        },
      },
      {
        enqueue: async () => {
          throw new Error('disk unavailable Bearer secret-token oxk_private123');
        },
      }
    );

    const messages = await collect(
      driver.dispatch({}, { run_id: 'run-1', idempotency_key: 'key-1' })
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'task.failed');
    assert.equal(messages[0].recoverable, true);
    assert.match(messages[0].reason, /disk unavailable/);
    assert.doesNotMatch(messages[0].reason, /secret-token|private123/);
    assert.equal(Number.isFinite(Date.parse(messages[0].failed_at)), true);
  });
});

/** Mirrors the server: a persisted receipt echoes the digest-bound ACK. */
function acked(init, status) {
  return {
    ok: true,
    status,
    json: async () => ({
      ack: {
        operation_id: init.headers['Idempotency-Key'],
        payload_digest: payloadDigest(init.body),
        disposition: 'persisted',
      },
    }),
  };
}

function outbox(directory, fetchImpl) {
  return new DurableReceiptOutbox({
    directory,
    baseUrl: 'https://useorgx.com',
    apiKey: 'oxk_test_only',
    workspaceId: 'workspace-1',
    fetchImpl,
    onError: () => undefined,
  });
}

function completion() {
  return {
    kind: 'task.completed',
    run_id: 'run-1',
    outcome_kind: 'awaiting_review',
    started_at: '2026-07-17T12:00:00.000Z',
    completed_at: '2026-07-17T12:01:00.000Z',
    tokens_used: 42,
    provider: 'openai',
    source_sub_type: 'subscription',
    source_driver: 'codex',
    cost_estimate_cents: 0,
  };
}

function failure() {
  return {
    kind: 'task.failed',
    run_id: 'run-failed',
    reason: 'signed quality bar was not met',
    recoverable: false,
    failed_at: '2026-07-17T12:02:00.000Z',
  };
}

async function receiptFiles(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith('.json'));
}

async function collect(generator) {
  const messages = [];
  for await (const message of generator) messages.push(message);
  return messages;
}
