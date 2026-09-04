/**
 * CodexDriver tests — fake `codex` shim on PATH emits a scripted NDJSON
 * trace based on $CODEX_FIXTURE.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { CodexDriver } from './CodexDriver.mjs';
import { startPeer, summarizeTransportError } from './peer.mjs';
import { parseAutonomousDispatchEnabled } from './runtimeConfig.mjs';

const NOW = '2026-07-15T12:00:00.000Z';

let workdir;
let originalPath;

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'codex-peer-test-'));
  const fixtures = {
    SUCCESS_TRACE: [
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'call-1', type: 'tool_call', name: 'read_file', status: 'completed' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'edit-1',
          type: 'file_edit',
          path: 'src/billing.ts',
          summary: 'refactored error handling per error_context rule',
        },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 200 } }),
    ].join('\n'),
    ERROR_TRACE: [
      JSON.stringify({ type: 'error', message: 'rate-limited', recoverable: true }),
    ].join('\n'),
  };

  const shim = `#!/usr/bin/env node
const fixture = process.env.CODEX_FIXTURE;
const traces = ${JSON.stringify(fixtures)};
if (process.env.ORGX_API_KEY || process.env.ORGX_GATEWAY_KEY) {
  process.stderr.write('gateway transport authority leaked to Codex child\\n');
  process.exit(91);
}
if (process.argv.includes('--version')) {
  process.stdout.write('codex 0.5.1\\n');
  process.exit(0);
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  if (process.env.CODEX_AUTH === 'signed-out') {
    process.stderr.write('Not logged in\\n');
    process.exit(1);
  }
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
if (!process.argv.includes('exec') || !process.argv.includes('--json')) {
  process.stderr.write('expected codex exec --json\\n');
  process.exit(2);
}
const trace = traces[fixture] || '';
if (trace) process.stdout.write(trace + '\\n');
process.exit(0);
`;
  const shimPath = join(workdir, 'codex');
  await writeFile(shimPath, shim);
  await chmod(shimPath, 0o755);

  originalPath = process.env.PATH;
  process.env.PATH = `${workdir}:${originalPath}`;
});

after(async () => {
  process.env.PATH = originalPath;
  await rm(workdir, { recursive: true, force: true });
});

async function collect(gen) {
  const out = [];
  for await (const m of gen) out.push(m);
  return out;
}

it('summarizes transport failures without retaining authorization internals', () => {
  const summary = summarizeTransportError({
    name: 'ErrorEvent',
    message: 'Unexpected server response: 401 Bearer oxk_test_secret',
    target: {
      request: {
        header: 'Sec-WebSocket-Protocol: orgx.v1,bearer.oxk_test_secret',
      },
    },
  });

  assert.deepEqual(summary, {
    name: 'ErrorEvent',
    message: 'Unexpected server response: 401 Bearer [redacted]',
  });
  assert.doesNotMatch(JSON.stringify(summary), /test_secret/);
});

it('enables autonomous dispatch only for the exact string true', () => {
  assert.equal(parseAutonomousDispatchEnabled('true'), true);
  for (const value of [undefined, null, '', 'false', 'TRUE', '1', true, 1]) {
    assert.equal(
      parseAutonomousDispatchEnabled(value),
      false,
      `expected ${String(value)} to fail closed`,
    );
  }
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

describe('CodexDriver', () => {
  it('detect reports installed + authenticated', async () => {
    process.env.CODEX_AUTH = 'chatgpt';
    const d = new CodexDriver();
    const s = await d.detect();
    assert.equal(s.installed, true);
    assert.equal(s.authenticated, true);
    assert.equal(s.subscription_active, true);
    assert.equal(s.auth_status, 'authenticated');
    assert.equal(s.auth_method, 'chatgpt');
    assert.match(s.version ?? '', /codex 0\.5\.1/);
  });

  it('does not infer authentication from a working version command', async () => {
    process.env.CODEX_AUTH = 'signed-out';
    const d = new CodexDriver();
    const detected = await d.detect();
    const probe = await d.probe();

    assert.equal(detected.installed, true);
    assert.equal(detected.authenticated, false);
    assert.equal(detected.subscription_active, false);
    assert.equal(detected.auth_status, 'sign_in_required');
    assert.equal(probe.session_alive, true);
    assert.equal(probe.dispatch_ready, false);
  });

  it('dispatch yields task.started → task.step → task.completed', async () => {
    process.env.CODEX_AUTH = 'chatgpt';
    process.env.CODEX_FIXTURE = 'SUCCESS_TRACE';
    const d = new CodexDriver({ skillRules: async () => [] });
    const msgs = await collect(
      d.dispatch(
        { title: 'refactor billing error handling', driver: 'codex' },
        { run_id: 'r1', idempotency_key: 'k1' }
      )
    );
    const kinds = msgs.map((m) => m.kind);
    assert.ok(kinds.includes('task.started'));
    assert.equal(kinds.filter((k) => k === 'task.step').length, 2);
    assert.equal(kinds[kinds.length - 1], 'task.completed');
    const completed = msgs.at(-1);
    assert.equal(completed.provider, 'openai');
    assert.equal(completed.source_sub_type, 'subscription');
    assert.equal(completed.source_driver, 'codex');
    assert.equal(completed.tokens_used, 1200);
  });

  it('never passes Gateway transport credentials to fallback codex exec', async () => {
    process.env.CODEX_AUTH = 'chatgpt';
    process.env.CODEX_FIXTURE = 'SUCCESS_TRACE';
    process.env.ORGX_API_KEY = 'oxk_must_not_reach_fallback';
    process.env.ORGX_GATEWAY_KEY = 'oxk_legacy_must_not_reach_fallback';
    try {
      const d = new CodexDriver({ skillRules: async () => [] });
      const msgs = await collect(
        d.dispatch(
          { title: 'bounded fallback execution', driver: 'codex' },
          { run_id: 'r-env-isolation', idempotency_key: 'k-env-isolation' },
        ),
      );
      assert.equal(msgs.at(-1)?.kind, 'task.completed');
    } finally {
      delete process.env.ORGX_API_KEY;
      delete process.env.ORGX_GATEWAY_KEY;
    }
  });

  it('emits task.deviation when a skill rule matches', async () => {
    process.env.CODEX_FIXTURE = 'SUCCESS_TRACE';
    const d = new CodexDriver({
      skillRules: async () => [
        {
          skill_id: 'error-context',
          match: { pattern: 'error handling', on: 'file_edit' },
          dedupe_fingerprint: 'error-context-v1',
          evidence_kind: 'error_shape_shift',
        },
      ],
    });
    const msgs = await collect(
      d.dispatch(
        { title: 'anything', driver: 'codex' },
        { run_id: 'r1', idempotency_key: 'k1' }
      )
    );
    const deviations = msgs.filter((m) => m.kind === 'task.deviation');
    assert.equal(deviations.length, 1);
    assert.equal(deviations[0].skill_id, 'error-context');
  });

  it('emits task.failed on an error event', async () => {
    process.env.CODEX_FIXTURE = 'ERROR_TRACE';
    const d = new CodexDriver({ skillRules: async () => [] });
    const msgs = await collect(
      d.dispatch(
        { title: 'anything', driver: 'codex' },
        { run_id: 'r1', idempotency_key: 'k1' }
      )
    );
    const failed = msgs.find((m) => m.kind === 'task.failed');
    assert.ok(failed);
    assert.equal(failed.recoverable, true);
  });
});

it('peer opens the gateway socket, advertises Codex, heartbeats, and returns a receipt', async (t) => {
  const heartbeats = [];
  const messages = [];
  const receiptPosts = [];
  let activationHeartbeatAccepted = false;
  let prematureUpgrade = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/v1/gateway/heartbeat') {
      let body = '';
      for await (const chunk of request) body += chunk;
      heartbeats.push(JSON.parse(body));
      activationHeartbeatAccepted = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/api/v1/runs/codex-peer-e2e/receipt') {
      let body = '';
      for await (const chunk of request) body += chunk;
      receiptPosts.push({ headers: request.headers, body: JSON.parse(body) });
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"receipt_id":"receipt-e2e"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (!activationHeartbeatAccepted) {
      prematureUpgrade = true;
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (peer) => {
      sockets.emit('connection', peer, request);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => sockets.close(() => server.close(resolve))));
  const port = server.address().port;

  const terminal = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('peer receipt timed out')), 5_000);
    sockets.once('connection', (socket, request) => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      assert.equal(url.searchParams.get('plugin_id'), 'orgx-codex-plugin');
      assert.equal(url.searchParams.get('drivers'), 'codex');
      assert.equal(url.searchParams.get('installation_id'), 'codex-e2e-install');
      assert.equal(url.searchParams.get('runner_instance_id'), 'codex-e2e-runner');
      assert.equal(url.searchParams.get('activation_attempt_id'), null);
      assert.equal(url.searchParams.get('runner_role'), null);
      assert.match(request.headers['sec-websocket-protocol'] ?? '', /orgx\.v3/);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        if (message.kind === 'task.completed') {
          clearTimeout(timeout);
          resolve(message);
        }
      });
      socket.send(JSON.stringify({
        kind: 'task.dispatch',
        run_id: 'codex-peer-e2e',
        idempotency_key: 'codex-peer-e2e-key',
        timeout_seconds: 30,
        task: { title: 'no-op', driver: 'codex' },
      }));
    });
  });
  const fakeDriver = {
    id: 'codex',
    running: new Map(),
    detect: async () => ({
      installed: true,
      authenticated: true,
      subscription_active: true,
      subscription_type: 'chatgpt',
      auth_method: 'chatgpt',
      auth_status: 'authenticated',
      version: 'codex-e2e',
    }),
    probe: async () => ({ subscription_active: true, session_alive: true, dispatch_ready: true }),
    cancel: async () => undefined,
    async *dispatch(_task, context) {
      const now = new Date().toISOString();
      yield { kind: 'task.started', run_id: context.run_id, started_at: now };
      yield {
        kind: 'task.completed',
        run_id: context.run_id,
        outcome_kind: 'shipped',
        started_at: now,
        completed_at: now,
        tokens_used: 1,
        provider: 'openai',
        source_sub_type: 'subscription',
        source_driver: 'codex',
        cost_estimate_cents: 0,
      };
    },
  };
  let replayCalls = 0;
  let finishReplay;
  const upload = new Promise((resolve) => { finishReplay = resolve; });
  const peer = await startPeer({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'oxk_test_only',
    workspaceId: 'workspace-e2e',
    installationId: 'codex-e2e-install',
    runnerInstanceId: 'codex-e2e-runner',
    activationAttemptId: 'activation-e2e-attempt',
    runnerRole: 'candidate',
    receiptOutboxPath: join(workdir, 'receipt-e2e'),
    driver: fakeDriver,
    skipHeartbeat: true,
    replayHookSpoolImpl: async () => {
      replayCalls += 1;
      await upload;
      return { posted: 0 };
    },
    mcpEndpoint: 'https://mcp.useorgx.com/mcp?profile=commander',
    continuityOutbox: {
      state: 'ready',
      pending: 0,
      dead_letters: 0,
      last_replay_at: NOW,
    },
  });
  const receipt = await terminal;
  await peer.replayHookSpoolNow();
  assert.equal(replayCalls, 1, 'an unfinished upload must not overlap the next replay');
  finishReplay();
  await upload;
  await new Promise((resolve) => setImmediate(resolve));
  await peer.replayHookSpoolNow();
  assert.equal(replayCalls, 2, 'a later replay resumes after the upload settles');
  await waitFor(() => heartbeats.at(-1)?.metadata?.dispatch_ready === true);
  await peer.stop();

  assert.equal(receipt.source_driver, 'codex');
  assert.equal(prematureUpgrade, false);
  assert.equal(receiptPosts.length, 1);
  assert.equal(receiptPosts[0].headers['idempotency-key'], 'codex-peer-e2e');
  assert.equal(receiptPosts[0].body.outcome_kind, 'shipped');
  assert.deepEqual(messages.map((message) => message.kind), ['task.started', 'task.completed']);
  assert.equal(heartbeats.at(-1)?.metadata?.transport_online, true);
  assert.equal(heartbeats.at(-1)?.metadata?.dispatch_ready, true);
  assert.equal(heartbeats.at(-1)?.runner_instance_id, 'codex-e2e-runner');
  assert.equal(
    heartbeats.at(-1)?.activation_attempt_id,
    'activation-e2e-attempt',
  );
  assert.equal(heartbeats.at(-1)?.runner_role, 'candidate');
  assert.equal(heartbeats[0]?.metadata?.transport_online, false);
  assert.equal(heartbeats[0]?.metadata?.dispatch_ready, false);
  assert.deepEqual(heartbeats.at(-1)?.metadata?.durable_receipt_outbox, {
    state: 'ready',
    pending: 0,
  });
  assert.equal(
    heartbeats.at(-1)?.metadata?.autonomous_dispatch_enabled,
    false,
  );
  assert.deepEqual(heartbeats.at(-1)?.metadata?.continuity_health, {
    schema_version: 'plugin-health.v1',
    endpoint: 'https://mcp.useorgx.com/mcp?profile=commander',
    source_client: 'codex',
    auth_state: 'authenticated',
    release: { installed: '0.1.20', source: '0.1.20', deployed: '0.1.20' },
    hooks: {
      reported: 6,
      expected: 6,
      terminal_passive: true,
      events: [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'PermissionRequest',
        'Stop',
      ],
    },
    outbox: {
      state: 'ready',
      pending: 0,
      dead_letters: 0,
      last_replay_at: NOW,
    },
    capabilities: {
      profile: 'commander',
      profile_tools: null,
      manifest_tools: null,
      inspectable_entities: null,
      visible_entities: null,
      measurement: 'not_probed',
    },
    last_receipt_at: null,
  });
  assert.equal(heartbeats.at(-1)?.protocol_version, 3);
});

it('does not open the gateway socket when the activation heartbeat fails', async (t) => {
  let heartbeatCount = 0;
  let upgradeCount = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/v1/gateway/heartbeat') {
      heartbeatCount += 1;
      for await (const _chunk of request) {
        // Drain the request before returning the activation failure.
      }
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":"activation unavailable"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (_request, socket) => {
    upgradeCount += 1;
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const fakeDriver = {
    id: 'codex',
    running: new Map(),
    detect: async () => ({
      installed: true,
      authenticated: true,
      auth_status: 'authenticated',
    }),
    probe: async () => ({
      subscription_active: true,
      session_alive: true,
      dispatch_ready: true,
    }),
    cancel: async () => undefined,
    async *dispatch() {},
  };

  await assert.rejects(
    startPeer({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'oxk_pending_test_only',
      workspaceId: 'workspace-activation-failure',
      installationId: 'codex-activation-failure',
      receiptOutboxPath: join(workdir, 'receipt-activation-failure'),
      driver: fakeDriver,
      skipHeartbeat: true,
      mcpEndpoint: 'https://mcp.useorgx.com/mcp',
    }),
    /presence heartbeat 503/,
  );

  assert.equal(heartbeatCount, 1);
  assert.equal(upgradeCount, 0);
});

it('peer suspends once, resumes the same run, and emits its eventual terminal receipt', async (t) => {
  const heartbeats = [];
  const messages = [];
  const continuationPosts = [];
  const terminalPosts = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;

    if (request.url === '/api/v1/gateway/heartbeat') {
      heartbeats.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/api/v1/runs/codex-peer-resume/receipt') {
      terminalPosts.push(JSON.parse(body));
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"receipt_id":"receipt-resume"}');
      return;
    }
    if (request.url === '/api/client/live/attention/decision-resume') {
      continuationPosts.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (peer) => {
      sockets.emit('connection', peer, request);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () => new Promise((resolve) => sockets.close(() => server.close(resolve)))
  );
  const port = server.address().port;

  const terminal = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('resumed peer receipt timed out')),
      5_000
    );
    sockets.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        if (message.kind === 'task.suspended') {
          socket.send(
            JSON.stringify({
              kind: 'attention.resolve',
              protocol_version: 3,
              decision_id: 'decision-resume',
              run_id: 'codex-peer-resume',
              driver: 'codex',
              session_handle: 'thread-resume',
              idempotency_key: 'resolve-resume-once',
              resolution: {
                status: 'answered',
                answer: 'Continue with the verified change.',
              },
            })
          );
        }
        if (message.kind === 'task.completed') {
          clearTimeout(timeout);
          resolve(message);
        }
      });
      socket.send(
        JSON.stringify({
          kind: 'task.dispatch',
          run_id: 'codex-peer-resume',
          idempotency_key: 'codex-peer-resume-key',
          timeout_seconds: 30,
          task: { title: 'pause and resume', driver: 'codex' },
        })
      );
    });
  });
  const fakeDriver = {
    id: 'codex',
    running: new Map(),
    detect: async () => ({
      installed: true,
      authenticated: true,
      subscription_active: true,
      auth_status: 'authenticated',
    }),
    probe: async () => ({
      subscription_active: true,
      session_alive: true,
      dispatch_ready: true,
    }),
    cancel: async () => undefined,
    async *dispatch(_task, context) {
      yield {
        kind: 'task.started',
        run_id: context.run_id,
        started_at: NOW,
        session_handle: 'thread-resume',
      };
      yield {
        kind: 'task.suspended',
        protocol_version: 3,
        run_id: context.run_id,
        reason: 'attention',
        decision_ids: ['decision-resume'],
        session_handle: 'thread-resume',
        suspended_at: NOW,
      };
    },
    async *resolveAttention(message) {
      assert.equal(message.run_id, 'codex-peer-resume');
      assert.equal(message.decision_id, 'decision-resume');
      yield { state: 'resuming', session_handle: 'thread-resume' };
      yield { state: 'resumed', session_handle: 'thread-resume' };
      yield {
        kind: 'task.completed',
        run_id: message.run_id,
        outcome_kind: 'awaiting_review',
        started_at: NOW,
        first_response_at: NOW,
        completed_at: NOW,
        tokens_used: 1,
        provider: 'openai',
        source_sub_type: 'subscription',
        source_driver: 'codex',
        cost_estimate_cents: 0,
      };
    },
  };
  const peer = await startPeer({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'oxk_test_only',
    workspaceId: 'workspace-resume',
    installationId: 'codex-resume-install',
    receiptOutboxPath: join(workdir, 'receipt-resume'),
    driver: fakeDriver,
    skipHeartbeat: true,
    mcpEndpoint: 'https://mcp.useorgx.com/mcp',
  });

  const receipt = await terminal;
  await waitFor(
    () =>
      continuationPosts.length === 3 &&
      terminalPosts.length === 1 &&
      heartbeats.at(-1)?.metadata?.transport_online === true
  );
  await peer.stop();

  assert.equal(receipt.outcome_kind, 'awaiting_review');
  assert.deepEqual(
    messages.map((message) =>
      message.kind === 'continuation.receipt'
        ? `${message.kind}:${message.state}`
        : message.kind
    ),
    [
      'task.started',
      'task.suspended',
      'continuation.receipt:answer_received',
      'continuation.receipt:resuming',
      'continuation.receipt:resumed',
      'task.completed',
    ]
  );
  assert.deepEqual(
    continuationPosts.map((receiptBody) => receiptBody.state),
    ['answer_received', 'resuming', 'resumed']
  );
  assert.equal(terminalPosts[0].outcome_kind, 'awaiting_review');
  assert.equal(
    messages.some(
      (message) =>
        message.kind === 'task.failed' &&
        /multiple terminal or suspended/i.test(message.reason ?? '')
    ),
    false
  );
});

it('heartbeat advertises an explicit runner-owned autonomous opt-in', async (t) => {
  const heartbeats = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/v1/gateway/heartbeat') {
      let body = '';
      for await (const chunk of request) body += chunk;
      heartbeats.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (peer) => {
      sockets.emit('connection', peer, request);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () => new Promise((resolve) => sockets.close(() => server.close(resolve))),
  );
  const port = server.address().port;
  const fakeDriver = {
    id: 'codex',
    running: new Map(),
    detect: async () => ({
      installed: true,
      authenticated: true,
      auth_status: 'authenticated',
    }),
    probe: async () => ({
      subscription_active: true,
      session_alive: true,
      dispatch_ready: true,
    }),
    cancel: async () => undefined,
    async *dispatch() {},
  };
  const peer = await startPeer({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'oxk_test_only',
    workspaceId: 'workspace-autonomous-opt-in',
    installationId: 'codex-autonomous-opt-in',
    runnerInstanceId: 'codex-autonomous-opt-in-runner',
    receiptOutboxPath: join(workdir, 'receipt-autonomous-opt-in'),
    driver: fakeDriver,
    skipHeartbeat: true,
    autonomousDispatchEnabled: true,
    autonomousRepoPath: '/runner/orgx',
    autonomousRepoValidator: async () => ({
      ready: true,
      path: '/runner/orgx',
      reason: null,
    }),
    autonomousMcpReady: true,
  });

  await waitFor(
    () =>
      heartbeats.at(-1)?.metadata?.autonomous_dispatch_enabled === true &&
      heartbeats.at(-1)?.metadata?.transport_online === true,
  );
  await peer.stop();

  assert.equal(
    heartbeats.at(-1)?.metadata?.autonomous_dispatch_enabled,
    true,
  );
  assert.equal(heartbeats.at(-1)?.metadata?.autonomous_repo_ready, true);
  assert.equal(heartbeats.at(-1)?.metadata?.autonomous_mcp_ready, true);
  assert.equal(
    heartbeats.at(-1)?.runner_instance_id,
    'codex-autonomous-opt-in-runner',
  );
});

it('fails an autonomous runner opt-in without an explicit runner instance id', async () => {
  await assert.rejects(
    startPeer({
      apiKey: 'oxk_test_only',
      workspaceId: 'workspace-missing-runner-instance',
      autonomousDispatchEnabled: true,
    }),
    /runner_instance_id_required_for_autonomous_dispatch/,
  );
});

it('rejects an invalid programmatic runner instance id', async () => {
  await assert.rejects(
    startPeer({
      apiKey: 'oxk_test_only',
      workspaceId: 'workspace-invalid-runner-instance',
      runnerInstanceId: 'contains spaces',
    }),
    /runner_instance_id_invalid/,
  );
});

it('rejects a partial programmatic activation binding', async () => {
  await assert.rejects(
    startPeer({
      apiKey: 'oxk_test_only',
      workspaceId: 'workspace-partial-activation',
      runnerInstanceId: 'candidate-partial-activation',
      runnerRole: 'candidate',
    }),
    /runner_activation_binding_incomplete/,
  );
});

it('fails an autonomous runner opt-in without a valid runner-owned checkout', async () => {
  await assert.rejects(
    startPeer({
      apiKey: 'oxk_test_only',
      workspaceId: 'workspace-invalid-repo',
      runnerInstanceId: 'codex-invalid-repo-runner',
      autonomousDispatchEnabled: true,
      autonomousRepoValidator: async () => ({
        ready: false,
        path: null,
        reason: 'autonomous_repo_path_missing',
      }),
    }),
    /autonomous_repo_path_missing/
  );
});
