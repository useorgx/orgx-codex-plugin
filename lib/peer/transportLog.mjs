/**
 * Transport logging safety net for the OrgX peer sidecar.
 *
 * Why this module exists
 * ----------------------
 * `PeerClient` authenticates the gateway WebSocket by putting the live API key
 * in the upgrade request's subprotocol list:
 *
 *   protocols = [`orgx.v3`, `bearer.${apiKey}`]
 *
 * The `ws` package surfaces upgrade failures through an `ErrorEvent` whose
 * `target` is the WebSocket, and the WebSocket keeps a reference to the
 * underlying `ClientRequest`. That request's `_header` field is the *raw* HTTP
 * upgrade text, which therefore contains:
 *
 *   Sec-WebSocket-Protocol: orgx.v3, bearer.oxk_<LIVE KEY>
 *
 * So `console.error('... error', event)` hands `util.inspect` an object graph
 * that walks straight into a cleartext credential and writes it to the runner's
 * stderr log. A rejected upgrade retried on a reconnect loop turns that into
 * hundreds of megabytes of leaked key.
 *
 * The rules this module enforces:
 *
 *  1. A raw transport error object is NEVER handed to the console. Callers get
 *     a narrow, hand-built summary ({ name, message, code, status }).
 *  2. Redaction is applied to the *serialized* text, after serialization and
 *     before truncation. Redacting field-by-field misses nested carriers like
 *     `_header`; truncating before redacting can leave a key fragment behind.
 *  3. Repeated identical failures are collapsed, so a persistent rejection
 *     cannot fill the disk.
 *  4. A rejection that will never succeed on retry (HTTP 409
 *     `runner-instance-id-required`) is reported as terminal so the caller can
 *     stop reconnecting instead of hammering forever.
 */

/** Longest serialized payload we will ever write for one transport event. */
const MAX_TRANSPORT_LOG_LENGTH = 800;
/** How deep to walk an error object graph before giving up. */
const MAX_SERIALIZE_DEPTH = 4;
/** Cap array fan-out so a buffered frame list cannot explode the line. */
const MAX_SERIALIZE_ARRAY = 20;
/** Suppression window for identical repeated transport failures. */
const DEFAULT_THROTTLE_WINDOW_MS = 60_000;

/**
 * Ordered secret patterns. `bearer.<token>` runs before the bare `oxk_` rule so
 * the whole subprotocol value collapses to a single marker rather than leaving
 * a `bearer.oxk_[redacted]` remnant.
 *
 * These are deliberately broad: it is always better to over-redact a log line
 * than to under-redact a credential.
 */
const SECRET_PATTERNS = [
  [/\bbearer\.[A-Za-z0-9._~+/-]+=*/gi, 'bearer.[redacted]'],
  [/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]'],
  [/\boxk_[A-Za-z0-9_-]+/g, 'oxk_[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]'],
  [/\b(authorization|x-api-key|api[-_]?key)(\\?["']?\s*[:=]\s*\\?["']?)[^\s"',;}]+/gi, '$1$2[redacted]'],
];

/**
 * Strip every known credential shape out of already-serialized text.
 * Safe to call on arbitrary strings, including raw HTTP header blocks.
 */
export function redactSecrets(value) {
  let text = typeof value === 'string' ? value : String(value);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Serialize an arbitrary value (including cyclic `ws` object graphs) and then
 * redact it. Serialize-then-redact is the load-bearing ordering: it guarantees
 * that anything reachable in the graph — `_header` included — passes through
 * the credential filter, no matter which field happened to carry it.
 */
export function serializeForLog(value, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_SERIALIZE_DEPTH;
  const maxLength = options.maxLength ?? MAX_TRANSPORT_LOG_LENGTH;
  const seen = new WeakSet();

  const walk = (input, depth) => {
    if (input === null || input === undefined) return input ?? null;
    const kind = typeof input;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') return input;
    if (kind === 'bigint') return String(input);
    if (kind === 'function') return '[Function]';
    if (kind === 'symbol') return String(input);
    if (kind !== 'object') return String(input);

    if (seen.has(input)) return '[Circular]';
    if (depth >= maxDepth) return '[Truncated]';
    seen.add(input);

    if (Array.isArray(input)) {
      return input.slice(0, MAX_SERIALIZE_ARRAY).map((item) => walk(item, depth + 1));
    }
    if (input instanceof Date) return input.toISOString();

    const out = {};
    if (input instanceof Error) {
      out.name = input.name;
      out.message = input.message;
    }
    for (const key of Object.keys(input)) {
      try {
        out[key] = walk(input[key], depth + 1);
      } catch {
        out[key] = '[Unreadable]';
      }
    }
    return out;
  };

  let text;
  try {
    text = JSON.stringify(walk(value, 0));
  } catch {
    try {
      text = String(value);
    } catch {
      text = '[Unserializable]';
    }
  }
  if (typeof text !== 'string') text = String(text);

  // Redact first, truncate second. Truncating first could slice a credential in
  // half and leave the leading half of a live key in the log.
  return redactSecrets(text).slice(0, maxLength);
}

/**
 * Pull an HTTP status out of a transport error without ever touching the
 * request headers. Covers the shapes `ws` and the SDK actually produce.
 */
export function extractHttpStatus(error) {
  const record = error && typeof error === 'object' ? error : null;
  const candidates = [
    record?.status,
    record?.statusCode,
    record?.response?.status,
    record?.response?.statusCode,
    record?.error?.status,
    record?.error?.statusCode,
    record?.target?._req?.res?.statusCode,
  ];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
      return candidate;
    }
  }
  // `ws` reports a rejected upgrade as: "Unexpected server response: 409"
  const message = typeof record?.message === 'string' ? record.message : '';
  const inner = typeof record?.error?.message === 'string' ? record.error.message : '';
  const match = /server response:\s*(\d{3})/i.exec(`${message} ${inner}`);
  if (match) return Number.parseInt(match[1], 10);
  return null;
}

/**
 * Build the ONLY object that is safe to hand to the console for a transport
 * failure. Every string field is redacted; nothing is copied by reference from
 * the original error, so there is no path back to `_header`.
 */
export function summarizeTransportError(error) {
  const record = error && typeof error === 'object' ? error : null;

  const rawName =
    (typeof record?.name === 'string' && record.name.trim()) ||
    (typeof record?.error?.name === 'string' && record.error.name.trim()) ||
    (typeof record?.type === 'string' && record.type.trim()) ||
    'TransportError';

  const rawMessage =
    (typeof record?.message === 'string' && record.message.trim()) ||
    (typeof record?.error?.message === 'string' && record.error.message.trim()) ||
    (typeof error === 'string' && error.trim()) ||
    'Gateway transport failed';

  const code = record?.code ?? record?.error?.code;
  const status = extractHttpStatus(error);

  return {
    name: redactSecrets(String(rawName)).slice(0, 120),
    message: redactSecrets(String(rawMessage)).slice(0, MAX_TRANSPORT_LOG_LENGTH),
    ...(typeof code === 'number' ||
    (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(code))
      ? { code: typeof code === 'string' ? redactSecrets(code) : code }
      : {}),
    ...(status === null ? {} : { status }),
  };
}

/**
 * A terminal transport error will not succeed on retry. The known case is the
 * gateway rejecting the upgrade with HTTP 409 `runner-instance-id-required`:
 * canonical runner ids exist in the workspace metadata, so a legacy runner that
 * cannot present `runner_instance_id` is permanently rejected and must be
 * reactivated by the operator. Retrying that forever is what produced a 238MB
 * error log.
 */
export function isTerminalTransportError(error) {
  const summary = summarizeTransportError(error);
  if (summary.status === 409) return true;
  const haystack = `${summary.name} ${summary.message} ${summary.code ?? ''}`.toLowerCase();
  return (
    haystack.includes('runner-instance-id-required') ||
    haystack.includes('runner_instance_id_required')
  );
}

/**
 * Collapse repeated identical events into a single line plus a repeat count.
 * A persistent rejection then costs one line per window instead of one line per
 * reconnect attempt.
 */
export function createLogThrottle(options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_THROTTLE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const state = new Map();

  return {
    /**
     * @returns {{ emit: boolean, repeated: number }} `emit` is true when the
     * caller should write a line; `repeated` is how many identical events were
     * suppressed since the last emitted line.
     */
    consider(key) {
      const timestamp = now();
      const entry = state.get(key);
      if (!entry) {
        state.set(key, { last: timestamp, suppressed: 0 });
        return { emit: true, repeated: 0 };
      }
      if (timestamp - entry.last >= windowMs) {
        const repeated = entry.suppressed;
        entry.last = timestamp;
        entry.suppressed = 0;
        return { emit: true, repeated };
      }
      entry.suppressed += 1;
      return { emit: false, repeated: entry.suppressed };
    },
    reset(key) {
      if (key === undefined) state.clear();
      else state.delete(key);
    },
  };
}

/**
 * Transport logger bound to one plugin tag. All gateway lifecycle logging for
 * the peer goes through this object so there is exactly one place where a
 * transport object can reach the console — and it never passes one through.
 */
export function createTransportLogger(options = {}) {
  const prefix = options.prefix ?? '[orgx-peer]';
  const sink = options.console ?? console;
  const throttle = options.throttle ?? createLogThrottle({ windowMs: options.windowMs, now: options.now });
  let terminalReported = false;

  const write = (level, message, payload) => {
    const line = `${prefix} ${message}`;
    if (payload === undefined) sink[level](line);
    else sink[level](line, payload);
  };

  return {
    connected() {
      terminalReported = false;
      throttle.reset();
      write('log', 'connected');
    },

    closed(code, reason) {
      write('warn', 'closed', {
        code: Number.isInteger(code) ? code : null,
        reason: redactSecrets(String(reason ?? '')).slice(0, 200),
      });
    },

    /**
     * Log a gateway transport error safely.
     *
     * @returns {{ terminal: boolean, summary: object, emitted: boolean }}
     */
    error(error, handlers = {}) {
      const summary = summarizeTransportError(error);
      const terminal = isTerminalTransportError(error);

      if (terminal) {
        if (!terminalReported) {
          terminalReported = true;
          write('error', 'gateway rejected this runner and will not retry', {
            ...summary,
            action:
              'This runner is not bound to a canonical runner_instance_id. Re-run the OrgX installer to reactivate it.',
          });
          handlers.onTerminal?.(summary);
        }
        return { terminal: true, summary, emitted: !terminalReported ? false : true };
      }

      const key = `${summary.name}|${summary.message}|${summary.code ?? ''}|${summary.status ?? ''}`;
      const decision = throttle.consider(key);
      if (decision.emit) {
        write('error', 'error', {
          ...summary,
          ...(decision.repeated > 0 ? { repeated_since_last_log: decision.repeated } : {}),
        });
      }
      handlers.onError?.(summary);
      return { terminal: false, summary, emitted: decision.emit };
    },

    /**
     * Log a non-transport failure (heartbeat, outbox) without ever passing the
     * raw rejection value to the console.
     */
    failure(message, error) {
      write('warn', message, summarizeTransportError(error));
    },

    /** Escape hatch for logging arbitrary structures with full redaction. */
    detail(level, message, value) {
      write(level, message, serializeForLog(value));
    },
  };
}

export const __testing = {
  MAX_TRANSPORT_LOG_LENGTH,
  SECRET_PATTERNS,
};
