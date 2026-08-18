/**
 * Tests for durable hook-spool replay.
 *
 * Locks down the three defects that let `events.jsonl` reach ~155MB with zero
 * uploads: no scheduled post, a reader that always restarted at byte 0 and so
 * could never drain, and a "pending" number that was really a scan cap.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  countPendingRecords,
  defaultCursorPath,
  readCursor,
  readSpoolBatch,
  replayHookSpool,
  replayHookSpoolOnce,
  rotateIfDrained,
} from './hookSpoolReplay.mjs';

let workdir;
let spoolPath;
let cursorPath;

const line = (i) => `${JSON.stringify({ event: 'PostToolUse', seq: i })}\n`;

async function seedSpool(count) {
  let body = '';
  for (let i = 0; i < count; i += 1) body += line(i);
  await writeFile(spoolPath, body, 'utf8');
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'orgx-spool-'));
  spoolPath = join(workdir, 'events.jsonl');
  cursorPath = defaultCursorPath(spoolPath);
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('readSpoolBatch', () => {
  it('reads from a byte offset rather than restarting at zero', async () => {
    await seedSpool(10);
    const first = await readSpoolBatch({ spoolPath, startOffset: 0, maxRecords: 4 });
    assert.equal(first.records.length, 4);
    assert.equal(first.records[0].seq, 0);
    assert.equal(first.drained, false);

    const second = await readSpoolBatch({
      spoolPath,
      startOffset: first.nextOffset,
      maxRecords: 4,
    });
    assert.equal(second.records[0].seq, 4, 'second batch must continue, not restart');
  });

  it('reports drained once the offset reaches EOF', async () => {
    await seedSpool(3);
    const batch = await readSpoolBatch({ spoolPath, startOffset: 0, maxRecords: 100 });
    assert.equal(batch.records.length, 3);
    assert.equal(batch.drained, true);
  });

  it('counts malformed lines without losing the offset', async () => {
    await writeFile(spoolPath, `${line(0)}not json\n${line(1)}`, 'utf8');
    const batch = await readSpoolBatch({ spoolPath, startOffset: 0, maxRecords: 100 });
    assert.equal(batch.records.length, 2);
    assert.equal(batch.malformed, 1);
    assert.equal(batch.drained, true);
  });

  it('treats a missing spool as drained, not an error', async () => {
    const batch = await readSpoolBatch({ spoolPath: join(workdir, 'nope.jsonl') });
    assert.equal(batch.missing, true);
    assert.equal(batch.drained, true);
  });
});

describe('countPendingRecords', () => {
  it('reports an exact count when the whole remainder is scanned', async () => {
    await seedSpool(25);
    const result = await countPendingRecords({ spoolPath, startOffset: 0 });
    assert.equal(result.pending, 25);
    assert.equal(result.exact, true);
  });

  it('HONESTY: flags a capped scan as a lower bound, never a total', async () => {
    await seedSpool(500);
    const { size } = await stat(spoolPath);
    const result = await countPendingRecords({
      spoolPath,
      startOffset: 0,
      maxScanBytes: Math.floor(size / 4),
    });
    assert.equal(result.exact, false, 'a capped scan must not claim to be exact');
    assert.ok(result.pending < 500, 'capped scan sees only part of the file');
    assert.match(result.note, /lower bound/);
  });

  it('reports zero pending behind a fully advanced cursor', async () => {
    await seedSpool(10);
    const { size } = await stat(spoolPath);
    const result = await countPendingRecords({ spoolPath, startOffset: size });
    assert.equal(result.pending, 0);
    assert.equal(result.exact, true);
  });
});

describe('readCursor', () => {
  it('resets a cursor whose offset is past a truncated spool', async () => {
    await seedSpool(2);
    const info = await stat(spoolPath);
    await writeFile(
      cursorPath,
      JSON.stringify({ byteOffset: 999_999, inode: String(info.ino), size: 999_999 }),
      'utf8'
    );
    const cursor = await readCursor(cursorPath, info);
    assert.equal(cursor.byteOffset, 0);
    assert.equal(cursor.stale, true);
  });

  it('resets when the spool was rotated to a new inode', async () => {
    await seedSpool(2);
    const info = await stat(spoolPath);
    await writeFile(
      cursorPath,
      JSON.stringify({ byteOffset: 10, inode: 'some-other-inode', size: 10 }),
      'utf8'
    );
    const cursor = await readCursor(cursorPath, info);
    assert.equal(cursor.byteOffset, 0);
    assert.equal(cursor.stale, true);
  });

  it('starts at zero when no cursor exists', async () => {
    await seedSpool(1);
    const cursor = await readCursor(cursorPath, await stat(spoolPath));
    assert.equal(cursor.byteOffset, 0);
  });
});

describe('replayHookSpoolOnce', () => {
  it('posts a batch and advances the durable cursor', async () => {
    await seedSpool(10);
    const posted = [];
    const result = await replayHookSpoolOnce({
      spoolPath,
      cursorPath,
      maxRecords: 4,
      postImpl: async (records) => posted.push(records.length),
    });
    assert.equal(result.status, 'posted');
    assert.equal(result.posted, 4);
    assert.deepEqual(posted, [4]);

    const cursor = JSON.parse(await readFile(cursorPath, 'utf8'));
    assert.ok(cursor.byteOffset > 0, 'cursor must advance after a successful post');
    assert.equal(cursor.totalPosted, 4);
  });

  it('DRAIN: repeated calls consume the whole spool exactly once', async () => {
    await seedSpool(20);
    const seen = [];
    for (let i = 0; i < 10; i += 1) {
      await replayHookSpoolOnce({
        spoolPath,
        cursorPath,
        maxRecords: 3,
        postImpl: async (records) => seen.push(...records.map((r) => r.seq)),
      });
    }
    assert.deepEqual(seen, [...Array(20).keys()], 'every record exactly once, in order');
  });

  it('does NOT advance the cursor when the post fails', async () => {
    await seedSpool(5);
    await assert.rejects(
      replayHookSpoolOnce({
        spoolPath,
        cursorPath,
        postImpl: async () => {
          throw new Error('network down');
        },
      })
    );
    // Cursor file must not exist / must not have advanced.
    let advanced = 0;
    try {
      advanced = JSON.parse(await readFile(cursorPath, 'utf8')).byteOffset;
    } catch {
      advanced = 0;
    }
    assert.equal(advanced, 0, 'a failed upload must be retried, not skipped');
  });

  it('picks up records appended after a drain', async () => {
    await seedSpool(3);
    const seen = [];
    const post = async (records) => seen.push(...records.map((r) => r.seq));
    await replayHookSpoolOnce({ spoolPath, cursorPath, postImpl: post });
    await appendFile(spoolPath, line(99), 'utf8');
    await replayHookSpoolOnce({ spoolPath, cursorPath, postImpl: post });
    assert.deepEqual(seen, [0, 1, 2, 99]);
  });

  it('is a no-op without a post implementation', async () => {
    await seedSpool(3);
    const result = await replayHookSpoolOnce({ spoolPath, cursorPath });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no_post_impl');
  });
});

describe('rotateIfDrained', () => {
  it('BOUNDED GROWTH: truncates an oversized, fully drained spool', async () => {
    await seedSpool(100);
    const { size } = await stat(spoolPath);
    const result = await rotateIfDrained({
      spoolPath,
      cursorPath,
      drained: true,
      size,
      rotateBytes: 10,
    });
    assert.equal(result.rotated, true);
    assert.equal((await stat(spoolPath)).size, 0);
  });

  it('SAFETY: never truncates a spool that still has undelivered records', async () => {
    await seedSpool(100);
    const { size } = await stat(spoolPath);
    const result = await rotateIfDrained({
      spoolPath,
      cursorPath,
      drained: false,
      size,
      rotateBytes: 10,
    });
    assert.equal(result.rotated, false);
    assert.equal((await stat(spoolPath)).size, size, 'undelivered data must survive');
  });

  it('leaves a small drained spool alone', async () => {
    await seedSpool(2);
    const { size } = await stat(spoolPath);
    const result = await rotateIfDrained({
      spoolPath,
      cursorPath,
      drained: true,
      size,
      rotateBytes: 1_000_000,
    });
    assert.equal(result.rotated, false);
  });
});

describe('replayHookSpool', () => {
  it('drains across multiple batches in one tick', async () => {
    await seedSpool(50);
    const seen = [];
    const result = await replayHookSpool({
      spoolPath,
      cursorPath,
      maxRecords: 10,
      maxBatches: 10,
      postImpl: async (records) => seen.push(...records.map((r) => r.seq)),
    });
    assert.equal(result.posted, 50);
    assert.equal(result.drained, true);
    assert.equal(seen.length, 50);
  });

  it('stops at maxBatches so one tick cannot monopolize the peer', async () => {
    await seedSpool(50);
    const result = await replayHookSpool({
      spoolPath,
      cursorPath,
      maxRecords: 5,
      maxBatches: 2,
      postImpl: async () => {},
    });
    assert.equal(result.batches, 2);
    assert.equal(result.posted, 10);
    assert.equal(result.drained, false);
  });
});
