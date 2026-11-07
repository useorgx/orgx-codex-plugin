import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPeer } from './peer.mjs';
import { assertNativeCodexProvider } from './CodexAuthReadiness.mjs';

it('rejects an explicitly conflicting signed provider rather than substituting OpenAI', () => {
  const authority = { context: { contracts: { runtime_profile: {
    driver: { id: 'codex' }, runtime: { contract: { provider: 'custom' } },
  } } } };
  assert.throws(() => assertNativeCodexProvider({}, authority), /codex_provider_unsupported/);
});

for (const state of ['cached', 'blocked', 'unknown']) it(`publishes no dispatch or autonomous readiness for ${state} provider proof`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'orgx-auth-presence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const heartbeats = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.url === '/api/v1/gateway/heartbeat') heartbeats.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  const sockets = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => sockets.close(() => server.close(resolve))));
  const driver = { id: 'codex', running: new Map(),
    detect: async () => ({ installed: true, authenticated: true, cached_chatgpt_login: true,
      provider_auth_verified: state !== 'cached', quota_status: state === 'cached' ? 'allowed' : state,
      auth_method: 'chatgpt', auth_status: state === 'cached' ? 'provider_auth_unverified' : 'authenticated' }),
    probe: async () => ({ dispatch_ready: false }),
    probeAutonomousMcpReadiness: async () => ({ ready: true, reason: null }),
    cancel: async () => {}, async *dispatch() { throw new Error('No task is admitted by this fixture'); } };
  const peer = await startPeer({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'oxk_offline_fixture',
    workspaceId: 'workspace-auth-fixture', installationId: 'auth-fixture', runnerInstanceId: 'auth-runner',
    autonomousDispatchEnabled: true, autonomousRepoPath: '/fixture/owned',
    autonomousRepoValidator: async () => ({ ready: true, path: '/fixture/owned', reason: null }),
    driver, skipHeartbeat: true, receiptOutboxPath: directory, replayHookSpoolImpl: async () => ({ posted: 0 }) });
  t.after(() => peer.stop());
  const deadline = Date.now() + 2000;
  while (!heartbeats.some(heartbeat => heartbeat.metadata.transport_online) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(heartbeats.some(heartbeat => heartbeat.metadata.transport_online));
  assert.ok(heartbeats.every(heartbeat => heartbeat.metadata.dispatch_ready === false));
  assert.ok(heartbeats.every(heartbeat => heartbeat.metadata.autonomous_dispatch_enabled === false));
  assert.equal(heartbeats.at(-1).subscription_active, state !== 'cached');
  await peer.stop();
});
