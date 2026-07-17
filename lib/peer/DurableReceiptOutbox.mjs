import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OUTBOX_SCHEMA = 'orgx.gateway-receipt-outbox.v1';
const RECEIPT_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

/**
 * Disk-backed terminal receipt delivery.
 *
 * A WebSocket send only proves that bytes entered a socket buffer. Every
 * completion is written atomically before it is yielded to the SDK and is
 * independently posted to the idempotent receipt endpoint. The file is
 * removed only after an HTTP 2xx application acknowledgement.
 */
export class DurableReceiptOutbox {
  constructor(opts) {
    this.directory = opts.directory;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.workspaceId = opts.workspaceId;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.onError = opts.onError ?? (() => undefined);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.inFlight = new Set();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(this.directory, 0o700);
    }
  }

  async enqueue(message) {
    if (!isDurableTerminal(message)) return { durable: false, acknowledged: false };
    await this.initialize();
    const normalizedMessage = normalizeTerminal(message);
    const record = {
      schema_version: OUTBOX_SCHEMA,
      workspace_id: this.workspaceId,
      run_id: normalizedMessage.run_id,
      created_at: new Date().toISOString(),
      message: normalizedMessage,
    };
    const path = this.pathFor(normalizedMessage.run_id);
    await atomicWriteJson(path, record);
    const acknowledged = await this.deliverPath(path, record);
    return { durable: true, acknowledged };
  }

  async flush() {
    await this.initialize();
    const names = (await readdir(this.directory)).filter((name) =>
      RECEIPT_FILE_PATTERN.test(name)
    );
    let acknowledged = 0;
    for (const name of names.sort()) {
      if (await this.deliverPath(join(this.directory, name))) acknowledged += 1;
    }
    return {
      attempted: names.length,
      acknowledged,
      pending: names.length - acknowledged,
    };
  }

  async status() {
    await this.initialize();
    const names = (await readdir(this.directory)).filter((name) =>
      RECEIPT_FILE_PATTERN.test(name)
    );
    return {
      state: names.length === 0 ? 'ready' : 'pending',
      pending: names.length,
    };
  }

  pathFor(runId) {
    const key = createHash('sha256')
      .update(`${this.workspaceId}\0${runId}`)
      .digest('hex');
    return join(this.directory, `${key}.json`);
  }

  async deliverPath(path, knownRecord) {
    if (this.inFlight.has(path)) return false;
    this.inFlight.add(path);
    try {
      const record = knownRecord ?? JSON.parse(await readFile(path, 'utf8'));
      if (!validRecord(record, this.workspaceId)) {
        this.onError(new Error(`receipt outbox record invalid: ${path}`));
        return false;
      }
      if (typeof this.fetchImpl !== 'function') {
        this.onError(new Error('receipt outbox fetch unavailable'));
        return false;
      }
      const response = await this.fetchImpl(receiptUrl(this.baseUrl, record.run_id), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': record.run_id,
        },
        body: JSON.stringify(receiptBody(record.message)),
        ...(typeof globalThis.AbortSignal?.timeout === 'function'
          ? { signal: globalThis.AbortSignal.timeout(this.timeoutMs) }
          : {}),
      });
      if (!response?.ok) {
        throw new Error(
          `durable receipt delivery rejected with ${response?.status ?? 'unknown'}`
        );
      }
      await rm(path, { force: true });
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    } finally {
      this.inFlight.delete(path);
    }
  }
}

export class DurableReceiptDriver {
  constructor(driver, outbox) {
    this.driver = driver;
    this.outbox = outbox;
  }

  get id() {
    return this.driver.id;
  }

  get running() {
    return this.driver.running;
  }

  detect() {
    return this.driver.detect();
  }

  probe() {
    return this.driver.probe();
  }

  cancel(runId) {
    return this.driver.cancel(runId);
  }

  setAutonomousDispatchEnabled(value) {
    return this.driver.setAutonomousDispatchEnabled?.(value);
  }

  probeAutonomousMcpReadiness() {
    return this.driver.probeAutonomousMcpReadiness?.();
  }

  async *dispatch(task, context) {
    yield* this.withDurableTerminal(this.driver.dispatch(task, context), context.run_id);
  }

  async *resolveAttention(message) {
    if (typeof this.driver.resolveAttention !== 'function') {
      throw new Error(`Driver '${this.id}' cannot resume attention requests`);
    }
    yield* this.withDurableTerminal(
      this.driver.resolveAttention(message),
      message.run_id
    );
  }

  async *withDurableTerminal(messages, runId) {
    for await (const message of messages) {
      if (!isDurableTerminal(message)) {
        yield message;
        continue;
      }
      const terminal = normalizeTerminal(message);
      try {
        await this.outbox.enqueue(terminal);
      } catch (error) {
        yield normalizeTerminal({
          kind: 'task.failed',
          run_id: runId,
          reason: `durable_receipt_outbox_failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          recoverable: true,
        });
        return;
      }
      yield terminal;
      return;
    }
  }
}

export function defaultReceiptOutboxPath(workspaceId) {
  const scope = createHash('sha256')
    .update(String(workspaceId ?? 'unscoped'))
    .digest('hex')
    .slice(0, 24);
  return join(homedir(), '.orgx', 'codex-peer', 'receipt-outbox', scope);
}

function isDurableTerminal(message) {
  return (
    message?.kind === 'task.completed' ||
    message?.kind === 'task.failed' ||
    (message?.kind === 'task.result' && message.protocol_version === 2)
  );
}

function normalizeTerminal(message) {
  if (message.kind !== 'task.failed') return message;
  const failedAt = Date.parse(message.failed_at);
  return {
    ...message,
    reason: redactFailureReason(message.reason),
    failed_at: Number.isFinite(failedAt)
      ? new Date(failedAt).toISOString()
      : new Date().toISOString(),
  };
}

function validRecord(value, workspaceId) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.schema_version === OUTBOX_SCHEMA &&
    value.workspace_id === workspaceId &&
    typeof value.run_id === 'string' &&
    value.run_id.length > 0 &&
    value.message?.run_id === value.run_id &&
    isValidDurableTerminal(value.message)
  );
}

function isValidDurableTerminal(message) {
  if (!isDurableTerminal(message) || typeof message.run_id !== 'string') {
    return false;
  }
  if (message.kind !== 'task.failed') return true;
  return (
    typeof message.reason === 'string' &&
    typeof message.recoverable === 'boolean' &&
    typeof message.failed_at === 'string' &&
    Number.isFinite(Date.parse(message.failed_at))
  );
}

function redactFailureReason(value) {
  return String(value ?? 'Codex execution failed')
    .slice(0, 2_000)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bbearer\.[A-Za-z0-9._~-]+/gi, 'bearer.[redacted]')
    .replace(/\boxk_[A-Za-z0-9_-]+\b/g, 'oxk_[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]');
}

function receiptUrl(baseUrl, runId) {
  const httpBase = baseUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  return new URL(
    `/api/v1/runs/${encodeURIComponent(runId)}/receipt`,
    httpBase
  );
}

function receiptBody(receipt) {
  if (receipt.kind === 'task.failed') {
    return {
      kind: 'task.failed',
      run_id: receipt.run_id,
      reason: receipt.reason,
      recoverable: receipt.recoverable,
      failed_at: receipt.failed_at,
    };
  }
  if (receipt.kind === 'task.result') {
    return {
      protocol_version: 2,
      execution_result: receipt.execution_result,
      provider_attribution: receipt.provider_attribution ?? null,
      outcome_kind: receipt.execution_result.disposition,
      completed_at: receipt.execution_result.completedAt,
      metadata: { recovered_from: 'codex_plugin_durable_outbox' },
    };
  }
  return {
    provider: receipt.provider,
    source_sub_type: receipt.source_sub_type,
    source_driver: receipt.source_driver,
    started_at: receipt.started_at,
    first_response_at: receipt.first_response_at ?? null,
    completed_at: receipt.completed_at,
    tokens_used: receipt.tokens_used,
    cost_estimate_cents: receipt.cost_estimate_cents,
    saved_estimate_cents: receipt.saved_estimate_cents ?? 0,
    outcome_kind: receipt.outcome_kind,
    metadata: { recovered_from: 'codex_plugin_durable_outbox' },
  };
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
