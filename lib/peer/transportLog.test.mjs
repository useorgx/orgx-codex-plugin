/**
 * Security regression tests for peer transport logging.
 *
 * The incident these lock down: the gateway WebSocket carries the live API key
 * in its `Sec-WebSocket-Protocol` header, `ws` exposes the failing request via
 * `event.target._req._header`, and logging the raw event wrote 52,779 cleartext
 * keys into the runner's stderr log.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLogThrottle,
  createTransportLogger,
  extractHttpStatus,
  isTerminalTransportError,
  redactSecrets,
  serializeForLog,
  summarizeTransportError,
} from './transportLog.mjs';

/** A syntactically realistic but non-live key shape. */
const LIVE_KEY = 'oxk_live_9fJqZ2xR7bT4wN1kD8sVpQ3mH6yL0aCe';

/**
 * Build a faithful stand-in for the `ws` ErrorEvent delivered to
 * `PeerClient.onError` when the gateway rejects the upgrade with HTTP 409.
 * Mirrors the real shape: cyclic references, a ClientRequest carrying the raw
 * upgrade text in `_header`, and the key repeated in several nested carriers.
 */
function makeWsUpgradeErrorEvent(key = LIVE_KEY) {
  const rawHeader =
    'GET /api/v1/gateway/stream?workspace_id=7af01a51 HTTP/1.1\r\n' +
    'Host: useorgx.com\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Protocol: orgx.v3, bearer.${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n';

  const clientRequest = {
    _header: rawHeader,
    method: 'GET',
    path: '/api/v1/gateway/stream',
    res: { statusCode: 409, statusMessage: 'runner-instance-id-required' },
    // ClientRequest also keeps the outgoing header map around.
    _headers: { 'sec-websocket-protocol': `orgx.v3, bearer.${key}` },
  };

  const socket = {
    url: 'wss://useorgx.com/api/v1/gateway/stream',
    _req: clientRequest,
    _protocol: `bearer.${key}`,
    readyState: 3,
  };
  clientRequest.socket = socket; // cycle, exactly like the real graph

  const error = new Error('Unexpected server response: 409');
  error.code = 'ECONNRESET';

  return {
    type: 'error',
    message: 'Unexpected server response: 409',
    error,
    target: socket,
  };
}

/** Capture everything a logger writes, as one flat searchable string. */
function captureConsole() {
  const lines = [];
  const record = (level) => (...args) => {
    lines.push(
      `${level} ` +
        args
          .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
          .join(' ')
    );
  };
  return {
    console: { log: record('log'), warn: record('warn'), error: record('error') },
    lines,
    text: () => lines.join('\n'),
  };
}

describe('redactSecrets', () => {
  it('strips a bearer subprotocol carrying a live key', () => {
    const out = redactSecrets(`Sec-WebSocket-Protocol: orgx.v3, bearer.${LIVE_KEY}`);
    assert.ok(!out.includes(LIVE_KEY));
    assert.match(out, /bearer\.\[redacted\]/);
  });

  it('strips a bare oxk_ key and an Authorization header', () => {
    const out = redactSecrets(`key=${LIVE_KEY} Authorization: Bearer ${LIVE_KEY}`);
    assert.ok(!out.includes(LIVE_KEY));
  });
});

describe('serializeForLog', () => {
  it('never round-trips a key out of a nested _header field', () => {
    const out = serializeForLog(makeWsUpgradeErrorEvent(), { maxLength: 100_000 });
    assert.ok(!out.includes(LIVE_KEY), 'serialized transport error leaked the API key');
    assert.ok(!out.includes('oxk_live'), 'serialized transport error leaked a key prefix');
  });

  it('survives cyclic object graphs without throwing', () => {
    const a = { name: 'a' };
    a.self = a;
    assert.doesNotThrow(() => serializeForLog(a));
    assert.match(serializeForLog(a), /Circular/);
  });

  it('redacts before truncating so no key fragment survives', () => {
    // Truncation point deliberately lands inside the credential.
    const payload = { pad: 'x'.repeat(40), header: `bearer.${LIVE_KEY}` };
    const out = serializeForLog(payload, { maxLength: 60 });
    assert.ok(!out.includes('oxk_live_9fJ'), 'a key fragment survived truncation');
  });
});

describe('summarizeTransportError', () => {
  it('returns only scalar, redacted fields — no reference to the raw graph', () => {
    const summary = summarizeTransportError(makeWsUpgradeErrorEvent());
    assert.deepEqual(Object.keys(summary).sort(), ['code', 'message', 'name', 'status']);
    assert.equal(summary.status, 409);
    assert.ok(!JSON.stringify(summary).includes(LIVE_KEY));
  });

  it('falls back to a safe default for a non-object error', () => {
    const summary = summarizeTransportError(undefined);
    assert.equal(summary.name, 'TransportError');
    assert.equal(summary.message, 'Gateway transport failed');
  });
});

describe('extractHttpStatus / isTerminalTransportError', () => {
  it('reads 409 out of the ws "Unexpected server response" message', () => {
    assert.equal(extractHttpStatus({ message: 'Unexpected server response: 409' }), 409);
  });

  it('treats a 409 upgrade rejection as terminal', () => {
    assert.equal(isTerminalTransportError(makeWsUpgradeErrorEvent()), true);
  });

  it('treats runner-instance-id-required as terminal regardless of status', () => {
    assert.equal(
      isTerminalTransportError(new Error('runner-instance-id-required')),
      true
    );
  });

  it('treats an ordinary network blip as retryable', () => {
    const err = new Error('socket hang up');
    err.code = 'ECONNRESET';
    assert.equal(isTerminalTransportError(err), false);
  });
});

describe('createTransportLogger', () => {
  it('SECURITY: a ws upgrade error cannot round-trip a key into log output', () => {
    const captured = captureConsole();
    const logger = createTransportLogger({
      prefix: '[orgx-codex-plugin]',
      console: captured.console,
    });

    logger.error(makeWsUpgradeErrorEvent());

    const text = captured.text();
    assert.ok(text.length > 0, 'expected the logger to write something');
    assert.ok(!text.includes(LIVE_KEY), 'API key leaked into log output');
    assert.ok(!text.includes('oxk_live'), 'API key prefix leaked into log output');
    assert.ok(!text.includes('Sec-WebSocket-Protocol'), 'raw upgrade header leaked');
    assert.ok(!text.includes('_header'), 'raw request header field leaked');
  });

  it('SECURITY: close reasons and failures are redacted too', () => {
    const captured = captureConsole();
    const logger = createTransportLogger({
      prefix: '[orgx-codex-plugin]',
      console: captured.console,
    });

    logger.closed(1006, `rejected bearer.${LIVE_KEY}`);
    logger.failure('heartbeat failed', new Error(`auth Bearer ${LIVE_KEY} rejected`));
    logger.detail('warn', 'raw', makeWsUpgradeErrorEvent());

    assert.ok(!captured.text().includes(LIVE_KEY), 'API key leaked into log output');
  });

  it('reports a 409 once and signals terminal to the caller', () => {
    const captured = captureConsole();
    const logger = createTransportLogger({
      prefix: '[orgx-codex-plugin]',
      console: captured.console,
    });

    let terminalCount = 0;
    for (let i = 0; i < 50; i += 1) {
      const result = logger.error(makeWsUpgradeErrorEvent(), {
        onTerminal: () => {
          terminalCount += 1;
        },
      });
      assert.equal(result.terminal, true);
    }

    assert.equal(terminalCount, 1, 'terminal handler must fire exactly once');
    const terminalLines = captured.lines.filter((line) =>
      line.includes('will not retry')
    );
    assert.equal(terminalLines.length, 1, '50 rejections must produce one line');
  });

  it('collapses repeated identical transient errors', () => {
    const captured = captureConsole();
    let clock = 0;
    const logger = createTransportLogger({
      prefix: '[orgx-codex-plugin]',
      console: captured.console,
      windowMs: 60_000,
      now: () => clock,
    });

    const blip = () => {
      const err = new Error('socket hang up');
      err.code = 'ECONNRESET';
      return err;
    };

    for (let i = 0; i < 1_000; i += 1) logger.error(blip());
    assert.equal(captured.lines.length, 1, '1000 identical errors must log once');

    clock += 60_001;
    logger.error(blip());
    assert.equal(captured.lines.length, 2, 'a new window logs once more');
    assert.match(captured.text(), /repeated_since_last_log/);
  });
});

describe('createLogThrottle', () => {
  it('emits first, suppresses within the window, re-emits after it', () => {
    let clock = 0;
    const throttle = createLogThrottle({ windowMs: 1_000, now: () => clock });

    assert.equal(throttle.consider('k').emit, true);
    assert.equal(throttle.consider('k').emit, false);
    clock += 1_001;
    const after = throttle.consider('k');
    assert.equal(after.emit, true);
    assert.equal(after.repeated, 1);
  });
});
