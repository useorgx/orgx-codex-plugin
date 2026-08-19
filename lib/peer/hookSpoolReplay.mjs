/**
 * Durable replay of the shared hook spool (`~/.config/useorgx/wizard/hooks/events.jsonl`).
 *
 * Three defects this module exists to fix:
 *
 *  1. NOTHING SCHEDULED THE UPLOAD. `orgx-work-graph-reconcile.mjs` only POSTs
 *     when a human invokes it with `--post=true` and an `ORGX_API_KEY`. Nobody
 *     did, so the spool reached ~155MB having never uploaded once.
 *
 *  2. THE READER COULD NEVER DRAIN IT. `loadHookOutboxRecords` always streams
 *     from byte 0 and stops after `maxRecords` (5,000). Re-running it therefore
 *     re-reads the same oldest 5,000 records forever; the tail is unreachable
 *     and the file grows without bound. Progress needs a durable *byte offset*,
 *     which is what this module keeps.
 *
 *  3. "PENDING" WAS A SCAN CAP, NOT A COUNT. Health reported a flat
 *     `pending: 5000` because that is where the scan stopped — presenting a cap
 *     as a fact. `countPendingRecords` below reports whether the number is
 *     exact and says so explicitly when it is not.
 *
 * The cursor is stored next to the spool and is keyed to the file's identity
 * (inode + size), so a rotated or truncated spool resets cleanly instead of
 * skipping past live records.
 */

import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Records handed to a single POST. */
const DEFAULT_BATCH_RECORDS = 2_000;
/** Bytes read in a single batch, so one pass cannot pin memory. */
const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;
/** Above this, a fully drained spool is truncated rather than kept forever. */
const DEFAULT_ROTATE_BYTES = 64 * 1024 * 1024;
/** Ceiling on a pending *count* scan before we admit the number is a floor. */
const DEFAULT_COUNT_SCAN_BYTES = 256 * 1024 * 1024;

export function defaultSpoolPath() {
  return join(homedir(), '.config', 'useorgx', 'wizard', 'hooks', 'events.jsonl');
}

export function defaultCursorPath(spoolPath = defaultSpoolPath()) {
  return join(dirname(spoolPath), '.replay-cursor.json');
}

/**
 * Read the durable cursor. A cursor that does not match the spool's current
 * identity (different inode, or a file that shrank) is treated as stale and
 * reset to zero — the spool was rotated or truncated underneath us.
 */
export async function readCursor(cursorPath, spoolStat) {
  let cursor = { byteOffset: 0, inode: null, size: 0, totalPosted: 0, lastPostedAt: null };
  try {
    const parsed = JSON.parse(await readFile(cursorPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      cursor = {
        byteOffset: Number.isFinite(parsed.byteOffset) ? Math.max(0, parsed.byteOffset) : 0,
        inode: parsed.inode ?? null,
        size: Number.isFinite(parsed.size) ? parsed.size : 0,
        totalPosted: Number.isFinite(parsed.totalPosted) ? parsed.totalPosted : 0,
        lastPostedAt: parsed.lastPostedAt ?? null,
      };
    }
  } catch {
    /* missing or corrupt cursor — start from the beginning */
  }

  if (spoolStat) {
    const rotated = cursor.inode !== null && String(cursor.inode) !== String(spoolStat.ino);
    const truncated = spoolStat.size < cursor.byteOffset;
    if (rotated || truncated) {
      return { ...cursor, byteOffset: 0, inode: String(spoolStat.ino), stale: true };
    }
  }
  return { ...cursor, stale: false };
}

export async function writeCursor(cursorPath, cursor) {
  await mkdir(dirname(cursorPath), { recursive: true });
  await writeFile(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, 'utf8');
}

/**
 * Read one batch of raw JSONL records starting at the cursor's byte offset.
 *
 * Returns the byte offset immediately after the last COMPLETE line consumed, so
 * a partially written trailing line is re-read next pass rather than dropped.
 */
export async function readSpoolBatch({
  spoolPath,
  startOffset = 0,
  maxRecords = DEFAULT_BATCH_RECORDS,
  maxBytes = DEFAULT_BATCH_BYTES,
} = {}) {
  let info;
  try {
    info = await stat(spoolPath);
  } catch {
    return { records: [], malformed: 0, nextOffset: startOffset, size: 0, missing: true, drained: true };
  }

  if (startOffset >= info.size) {
    return { records: [], malformed: 0, nextOffset: info.size, size: info.size, missing: false, drained: true };
  }

  const end = Math.min(info.size, startOffset + maxBytes) - 1;
  const stream = createReadStream(spoolPath, { encoding: 'utf8', start: startOffset, end });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const records = [];
  let malformed = 0;
  let consumedBytes = 0;

  for await (const line of rl) {
    // +1 for the newline delimiter that readline strips.
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    const trimmed = line.trim();
    if (trimmed) {
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        malformed += 1;
      }
    }
    consumedBytes += lineBytes;
    if (records.length >= maxRecords) break;
  }
  rl.close();
  stream.destroy();

  const nextOffset = Math.min(info.size, startOffset + consumedBytes);
  return {
    records,
    malformed,
    nextOffset,
    size: info.size,
    missing: false,
    drained: nextOffset >= info.size,
  };
}

/**
 * Count records still unread behind the cursor.
 *
 * Honest by construction: `exact` is false when the scan hit its byte ceiling,
 * and `pending` is then a documented FLOOR, never presented as the true total.
 * Callers must render the two cases differently.
 */
export async function countPendingRecords({
  spoolPath,
  startOffset = 0,
  maxScanBytes = DEFAULT_COUNT_SCAN_BYTES,
} = {}) {
  let info;
  try {
    info = await stat(spoolPath);
  } catch {
    return { pending: 0, exact: true, scannedBytes: 0, remainingBytes: 0, missing: true };
  }

  const remainingBytes = Math.max(0, info.size - startOffset);
  if (remainingBytes === 0) {
    return { pending: 0, exact: true, scannedBytes: 0, remainingBytes: 0, missing: false };
  }

  const capped = remainingBytes > maxScanBytes;
  const end = Math.min(info.size, startOffset + maxScanBytes) - 1;
  const stream = createReadStream(spoolPath, { encoding: 'utf8', start: startOffset, end });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let pending = 0;
  for await (const line of rl) {
    if (line.trim()) pending += 1;
  }
  rl.close();
  stream.destroy();

  return {
    pending,
    exact: !capped,
    scannedBytes: Math.min(remainingBytes, maxScanBytes),
    remainingBytes,
    missing: false,
    ...(capped ? { note: 'scan capped; pending is a lower bound, not a total' } : {}),
  };
}

/**
 * Once the spool is fully drained and oversized, reclaim the disk.
 * Truncating only when `drained` is true is what makes this safe: an
 * undelivered record is never discarded to save space.
 */
export async function rotateIfDrained({
  spoolPath,
  cursorPath,
  drained,
  size,
  rotateBytes = DEFAULT_ROTATE_BYTES,
  keepArchive = false,
} = {}) {
  if (!drained || size < rotateBytes) return { rotated: false, reclaimedBytes: 0 };

  if (keepArchive) {
    await rename(spoolPath, `${spoolPath}.1`);
  } else {
    // Truncate in place so the hook writers' open handles keep working.
    const handle = await open(spoolPath, 'r+');
    try {
      await handle.truncate(0);
    } finally {
      await handle.close();
    }
  }

  await writeCursor(cursorPath, {
    byteOffset: 0,
    inode: null,
    size: 0,
    totalPosted: 0,
    lastPostedAt: new Date().toISOString(),
    lastRotatedAt: new Date().toISOString(),
  });
  return { rotated: true, reclaimedBytes: size };
}

/**
 * Replay one batch: read from the cursor, POST it, then advance the cursor.
 *
 * The cursor advances ONLY after `postImpl` resolves successfully, so a failed
 * upload is retried rather than silently skipped.
 *
 * @param {(records: object[]) => Promise<unknown>} postImpl
 */
export async function replayHookSpoolOnce({
  spoolPath = defaultSpoolPath(),
  cursorPath = defaultCursorPath(spoolPath),
  postImpl,
  maxRecords = DEFAULT_BATCH_RECORDS,
  maxBytes = DEFAULT_BATCH_BYTES,
  rotateBytes = DEFAULT_ROTATE_BYTES,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof postImpl !== 'function') {
    return { status: 'skipped', reason: 'no_post_impl', posted: 0 };
  }

  let info = null;
  try {
    info = await stat(spoolPath);
  } catch {
    return { status: 'skipped', reason: 'spool_missing', posted: 0 };
  }

  const cursor = await readCursor(cursorPath, info);
  const batch = await readSpoolBatch({
    spoolPath,
    startOffset: cursor.byteOffset,
    maxRecords,
    maxBytes,
  });

  if (batch.records.length === 0) {
    const rotation = await rotateIfDrained({
      spoolPath,
      cursorPath,
      drained: batch.drained,
      size: batch.size,
      rotateBytes,
    });
    return { status: 'idle', posted: 0, drained: batch.drained, ...rotation };
  }

  await postImpl(batch.records);

  const advanced = {
    byteOffset: batch.nextOffset,
    inode: String(info.ino),
    size: batch.size,
    totalPosted: (cursor.totalPosted ?? 0) + batch.records.length,
    lastPostedAt: now(),
  };
  await writeCursor(cursorPath, advanced);

  const rotation = await rotateIfDrained({
    spoolPath,
    cursorPath,
    drained: batch.drained,
    size: batch.size,
    rotateBytes,
  });

  return {
    status: 'posted',
    posted: batch.records.length,
    malformed: batch.malformed,
    byteOffset: advanced.byteOffset,
    totalPosted: advanced.totalPosted,
    drained: batch.drained,
    ...rotation,
  };
}

/**
 * Drain the spool across several batches, stopping at `maxBatches` so one tick
 * cannot monopolize the peer. Any failure ends the tick with the cursor left
 * where it was, so nothing is lost.
 */
export async function replayHookSpool(options = {}) {
  const maxBatches = options.maxBatches ?? 5;
  let posted = 0;
  let batches = 0;
  let last = null;

  for (let i = 0; i < maxBatches; i += 1) {
    last = await replayHookSpoolOnce(options);
    if (last.status !== 'posted') break;
    posted += last.posted;
    batches += 1;
    if (last.drained) break;
  }

  return {
    status: batches > 0 ? 'posted' : (last?.status ?? 'idle'),
    posted,
    batches,
    drained: last?.drained ?? false,
    rotated: last?.rotated ?? false,
    reason: last?.reason,
  };
}

export const __testing = {
  DEFAULT_BATCH_RECORDS,
  DEFAULT_BATCH_BYTES,
  DEFAULT_ROTATE_BYTES,
  DEFAULT_COUNT_SCAN_BYTES,
};
