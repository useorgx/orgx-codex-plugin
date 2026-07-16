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
  t.after(() => new Promise((resolve) => sockets.close(() => server.close(resolve))));
  const port = server.address().port;

  const terminal = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('peer receipt timed out')), 5_000);
    sockets.once('connection', (socket, request) => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      assert.equal(url.searchParams.get('plugin_id'), 'orgx-codex-plugin');
      assert.equal(url.searchParams.get('drivers'), 'codex');
      assert.equal(url.searchParams.get('installation_id'), 'codex-e2e-install');
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
  const peer = await startPeer({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'oxk_test_only',
    workspaceId: 'workspace-e2e',
    installationId: 'codex-e2e-install',
    driver: fakeDriver,
    skipHeartbeat: true,
    mcpEndpoint: 'https://mcp.useorgx.com/mcp',
    continuityOutbox: {
      state: 'ready',
      pending: 0,
      dead_letters: 0,
      last_replay_at: NOW,
    },
  });
  const receipt = await terminal;
  await waitFor(() => heartbeats.at(-1)?.metadata?.dispatch_ready === true);
  await peer.stop();

  assert.equal(receipt.source_driver, 'codex');
  assert.deepEqual(messages.map((message) => message.kind), ['task.started', 'task.completed']);
  assert.equal(heartbeats.at(-1)?.metadata?.transport_online, true);
  assert.equal(heartbeats.at(-1)?.metadata?.dispatch_ready, true);
  assert.deepEqual(heartbeats.at(-1)?.metadata?.continuity_health, {
    schema_version: 'plugin-health.v1',
    endpoint: 'https://mcp.useorgx.com/mcp',
    auth_state: 'authenticated',
    release: { installed: '0.1.9', source: '0.1.9', deployed: '0.1.9' },
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
      profile: 'codex',
      profile_tools: 33,
      manifest_tools: 33,
      inspectable_entities: 20,
      visible_entities: 20,
    },
    last_receipt_at: NOW,
  });
  assert.equal(heartbeats.at(-1)?.protocol_version, 3);
});
