import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import { CodexAppServerClient } from './CodexAppServerClient.mjs';
import { CodexDriver } from './CodexDriver.mjs';

async function collect(generator) {
  const output = [];
  for await (const message of generator) output.push(message);
  return output;
}

async function collectWithTap(generator, output) {
  for await (const message of generator) output.push(message);
  return output;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

class FakeAppServer {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.responses = [];
    this.errors = [];
    this.eventWaiters = [];
  }

  async start() {
    return { threadId: 'thread-1', turnId: 'turn-1' };
  }

  push(message) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.queue.push(message);
    for (const pending of [...this.eventWaiters]) {
      if (!pending.predicate(message)) continue;
      this.eventWaiters.splice(this.eventWaiters.indexOf(pending), 1);
      pending.resolve(message);
    }
  }

  async *messages() {
    while (true) {
      const message =
        this.queue.shift() ??
        (await new Promise((resolve) => this.waiters.push(resolve)));
      if (message === null) return;
      yield message;
    }
  }

  respond(id, result) {
    this.responses.push({ id, result });
    this.push({
      method: 'serverRequest/resolved',
      params: { requestId: id, threadId: 'thread-1' },
    });
  }

  respondError(id, code, message) {
    this.errors.push({ id, code, message });
  }

  waitFor(predicate) {
    const queued = this.queue.find(predicate);
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.eventWaiters.push({ predicate, resolve }));
  }

  close() {}
}

describe('CodexAppServerClient', () => {
  it('never passes Gateway transport credentials to Codex app-server', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => undefined;
    let childEnv;
    let buffer = '';
    stdin.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        }
        if (request.method === 'thread/start') {
          stdout.write(
            `${JSON.stringify({
              id: request.id,
              result: { thread: { id: 'thread-secret-free' } },
            })}\n`,
          );
        }
      }
    });

    const client = new CodexAppServerClient({
      env: {
        SAFE_CHILD_VALUE: 'kept',
        ORGX_API_KEY: 'oxk_must_not_escape',
        ORGX_GATEWAY_KEY: 'oxk_also_removed',
      },
      spawnImpl: (_command, _args, options) => {
        childEnv = options.env;
        return child;
      },
    });
    await client._openThread({
      cwd: '/tmp',
      mcpPolicy: undefined,
      configuredMcpServers: [],
    });

    assert.equal(childEnv.SAFE_CHILD_VALUE, 'kept');
    assert.equal(childEnv.ORGX_API_KEY, undefined);
    assert.equal(childEnv.ORGX_GATEWAY_KEY, undefined);
    client.close();
  });

  it('negotiates initialize, starts a thread, and starts a turn over JSONL', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => undefined;

    const requests = [];
    let buffer = '';
    stdin.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        }
        if (request.method === 'thread/start') {
          stdout.write(
            `${JSON.stringify({
              id: request.id,
              result: { thread: { id: 'thread-jsonl' } },
            })}\n`
          );
        }
        if (request.method === 'turn/start') {
          stdout.write(
            `${JSON.stringify({
              id: request.id,
              result: { turn: { id: 'turn-jsonl' } },
            })}\n`
          );
        }
      }
    });

    const client = new CodexAppServerClient({ spawnImpl: () => child });
    const handles = await client.start({
      cwd: '/tmp',
      prompt: 'Do the work',
      metadata: { orgx_run_id: 'run-1' },
    });

    assert.deepEqual(handles, {
      threadId: 'thread-jsonl',
      turnId: 'turn-jsonl',
    });
    assert.deepEqual(
      requests.map((request) => request.method),
      ['initialize', 'initialized', 'thread/start', 'turn/start']
    );
    assert.equal(requests[0].params.capabilities.experimentalApi, true);
    assert.equal(requests[2].params.approvalPolicy, 'on-request');
    assert.equal(requests[3].params.input[0].text, 'Do the work');
  });

  it('proves the exact MCP tool and schema surface before turn/start', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => undefined;
    const schema = {
      type: 'object',
      properties: { operation: { type: 'string', const: 'inspect_initiative' } },
      required: ['operation'],
      additionalProperties: false,
    };
    const policy = {
      allowedByServer: { orgx: ['orgx_inspect'] },
      expectedSchemasByServer: { orgx: { orgx_inspect: schema } },
    };
    const requests = [];
    let buffer = '';
    stdin.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        }
        if (request.method === 'thread/start') {
          stdout.write(
            `${JSON.stringify({
              id: request.id,
              result: { thread: { id: 'thread-policy' } },
            })}\n`
          );
        }
        if (request.method === 'mcpServerStatus/list') {
          stdout.write(
            `${JSON.stringify({
              id: request.id,
              result: {
                data: [
                  {
                    name: 'orgx',
                    authStatus: 'oAuth',
                    tools: {
                      orgx_inspect: {
                        name: 'orgx_inspect',
                        inputSchema: schema,
                      },
                    },
                  },
                  { name: 'github', authStatus: 'unsupported', tools: {} },
                ],
                nextCursor: null,
              },
            })}\n`
          );
        }
        if (request.method === 'turn/start') {
          stdout.write(
            `${JSON.stringify({
              id: request.id,
              result: { turn: { id: 'turn-policy' } },
            })}\n`
          );
        }
      }
    });

    let spawnArgs;
    const client = new CodexAppServerClient({
      spawnImpl: (_command, args) => {
        spawnArgs = args;
        return child;
      },
    });
    const handles = await client.start({
      cwd: '/tmp',
      prompt: 'Use exact tools',
      mcpPolicy: policy,
      configuredMcpServers: ['github', 'orgx'],
    });

    assert.equal(handles.threadId, 'thread-policy');
    assert.deepEqual(handles.mcpPolicyProof, {
      servers: ['orgx'],
      tools: ['orgx_inspect'],
    });
    assert.deepEqual(
      requests.map((request) => request.method),
      [
        'initialize',
        'initialized',
        'thread/start',
        'mcpServerStatus/list',
        'turn/start',
      ]
    );
    assert.deepEqual(requests[2].params.selectedCapabilityRoots, []);
    assert.equal(requests[2].params.sandbox, 'workspaceWrite');
    assert.ok(spawnArgs.includes('mcp_servers.github.enabled=false'));
    assert.ok(
      spawnArgs.includes('mcp_servers.orgx.enabled_tools=["orgx_inspect"]')
    );
  });

  it('runs a read-only, shell-disabled MCP readiness probe without a model turn', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => undefined;
    const boundedSchema = {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    };
    const requests = [];
    let buffer = '';
    stdin.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        if (request.method === 'initialize') {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        }
        if (request.method === 'thread/start') {
          stdout.write(
            `${JSON.stringify({
              id: request.id,
              result: { thread: { id: 'thread-readiness' } },
            })}\n`
          );
        }
        if (request.method === 'mcpServerStatus/list') {
          stdout.write(
            `${JSON.stringify({
              id: request.id,
              result: {
                data: [
                  {
                    name: 'orgx',
                    authStatus: 'oAuth',
                    tools: {
                      orgx_bootstrap: {
                        name: 'orgx_bootstrap',
                        inputSchema: boundedSchema,
                      },
                    },
                  },
                  { name: 'github', authStatus: 'unsupported', tools: {} },
                ],
                nextCursor: null,
              },
            })}\n`
          );
        }
      }
    });

    let spawnArgs;
    const client = new CodexAppServerClient({
      spawnImpl: (_command, args) => {
        spawnArgs = args;
        return child;
      },
    });
    const proof = await client.probeMcpReadiness({
      cwd: '/tmp',
      configuredMcpServers: ['github', 'orgx'],
      mcpPolicy: {
        allowedByServer: { orgx: ['orgx_bootstrap'] },
        expectedSchemasByServer: {},
        readOnly: true,
        disableShell: true,
      },
    });

    assert.deepEqual(proof, {
      server: 'orgx',
      tool: 'orgx_bootstrap',
      schema_bounded: true,
    });
    assert.deepEqual(
      requests.map((request) => request.method),
      ['initialize', 'initialized', 'thread/start', 'mcpServerStatus/list']
    );
    assert.equal(requests[2].params.sandbox, 'readOnly');
    assert.ok(spawnArgs.includes('features.shell_tool=false'));
    assert.ok(spawnArgs.includes('mcp_servers.github.enabled=false'));
    assert.ok(
      spawnArgs.includes('mcp_servers.orgx.enabled_tools=["orgx_bootstrap"]')
    );
  });
});

describe('CodexDriver app-server attention bridge', () => {
  it('never treats an autonomous transport completion as shipped by itself', async () => {
    const fake = new FakeAppServer();
    const driver = new CodexDriver({
      useAppServer: true,
      autonomousRepoPath: '/runner/orgx',
      mcpServerDiscovery: async () => ['orgx'],
      appServerFactory: () => fake,
    });
    const dispatch = collect(
      driver.dispatch(
        {
          title: 'Produce verified evidence',
          driver: 'codex',
          repo_path: '/runner/orgx',
        },
        {
          run_id: 'run-autonomous-terminal',
          idempotency_key: 'dispatch-autonomous-terminal',
          autonomous_authority: minimalAutonomousAuthority(),
        }
      )
    );

    await waitFor(() => driver.running.has('run-autonomous-terminal'));
    fake.push({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    const messages = await dispatch;
    assert.equal(messages.at(-1).kind, 'task.completed');
    assert.equal(messages.at(-1).outcome_kind, 'awaiting_review');
  });

  it('keeps secret answers out of the remote attention channel', async () => {
    const fake = new FakeAppServer();
    const driver = new CodexDriver({
      useAppServer: true,
      apiKey: 'oxk_test',
      appServerFactory: () => fake,
    });
    const dispatch = collect(
      driver.dispatch(
        {
          title: 'Configure a provider',
          driver: 'codex',
          initiative_id: 'initiative-1',
        },
        { run_id: 'run-secret', idempotency_key: 'dispatch-secret' }
      )
    );

    await waitFor(() => driver.running.has('run-secret'));
    fake.push({
      id: 45,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        questions: [
          {
            id: 'api-key',
            header: 'API key',
            question: 'Enter the provider API key',
            isSecret: true,
          },
        ],
      },
    });
    await waitFor(() => fake.errors.length === 1);
    assert.deepEqual(fake.errors[0], {
      id: 45,
      code: -32602,
      message:
        'Sensitive input cannot be relayed through OrgX. Re-run this step in a local Codex UI and enter the secret there.',
    });

    fake.push({
      method: 'turn/completed',
      params: {
        turn: { id: 'turn-1', status: 'failed', error: { message: 'input required' } },
      },
    });
    const messages = await dispatch;
    assert.deepEqual(messages.map((message) => message.kind), [
      'task.started',
      'task.failed',
    ]);
  });

  it('returns all human answers to the exact waiting request before the turn continues', async (t) => {
    const attentionBodies = [];
    const api = createServer(async (request, response) => {
      if (request.url !== '/api/client/live/attention') {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      attentionBodies.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ decision_id: `decision-${attentionBodies.length}` })
      );
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    t.after(() => new Promise((resolve) => api.close(resolve)));

    const fake = new FakeAppServer();
    const driver = new CodexDriver({
      useAppServer: true,
      apiKey: 'oxk_test',
      baseUrl: `http://127.0.0.1:${api.address().port}`,
      appServerFactory: () => fake,
    });
    const observedDispatchMessages = [];
    const dispatch = collectWithTap(
      driver.dispatch(
        {
          title: 'Refine the brand system',
          driver: 'codex',
          initiative_id: 'initiative-1',
          workspace_id: 'workspace-1',
          workstream_id: 'workstream-1',
        },
        { run_id: 'run-1', idempotency_key: 'dispatch-1' }
      ),
      observedDispatchMessages
    );

    await waitFor(() => driver.running.has('run-1'));
    fake.push({
      id: 44,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'direction',
            header: 'Direction',
            question: 'Which visual direction should lead?',
            options: [
              { label: 'Quiet signal', description: 'Light and restrained.' },
              { label: 'Loud signal', description: 'High contrast and energetic.' },
            ],
          },
          {
            id: 'constraint',
            header: 'Constraint',
            question: 'What must remain unchanged?',
            options: null,
          },
        ],
      },
    });
    await waitFor(() => attentionBodies.length === 2);
    await waitFor(() =>
      observedDispatchMessages.some((message) => message.kind === 'task.suspended')
    );
    const suspended = observedDispatchMessages.find(
      (message) => message.kind === 'task.suspended'
    );
    assert.equal(suspended.protocol_version, 3);
    assert.equal(suspended.run_id, 'run-1');
    assert.equal(suspended.reason, 'attention');
    assert.deepEqual(suspended.decision_ids, ['decision-1', 'decision-2']);
    assert.equal(suspended.session_handle, 'thread-1');
    assert.match(suspended.suspended_at, /^\d{4}-\d{2}-\d{2}T/);

    const firstReceipts = await collect(
      driver.resolveAttention({
        decision_id: 'decision-1',
        run_id: 'run-1',
        resolution: { status: 'answered', option_id: 'option-1' },
      })
    );
    assert.deepEqual(firstReceipts.map((receipt) => receipt.state), [
      'answer_received',
    ]);
    assert.equal(fake.responses.length, 0);

    const observedContinuationMessages = [];
    const secondReceiptsPromise = collectWithTap(
      driver.resolveAttention({
        decision_id: 'decision-2',
        run_id: 'run-1',
        resolution: { status: 'answered', answer: 'The wordmark' },
      }),
      observedContinuationMessages
    );
    await waitFor(() =>
      observedContinuationMessages.some(
        (message) => message.state === 'resumed'
      )
    );
    assert.deepEqual(
      observedContinuationMessages.map((receipt) => receipt.state),
      ['resuming', 'resumed']
    );
    assert.deepEqual(fake.responses, [
      {
        id: 44,
        result: {
          answers: {
            direction: { answers: ['Quiet signal'] },
            constraint: { answers: ['The wordmark'] },
          },
        },
      },
    ]);
    assert.equal(attentionBodies[0].continuation.strategy, 'reply_in_place');
    assert.equal(attentionBodies[0].source_tool, 'item/tool/requestUserInput');

    fake.push({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    const secondReceipts = await secondReceiptsPromise;
    assert.deepEqual(
      secondReceipts.map((message) => message.kind ?? message.state),
      ['resuming', 'resumed', 'task.completed']
    );
    const dispatchMessages = await dispatch;
    assert.deepEqual(dispatchMessages.map((message) => message.kind), [
      'task.started',
      'task.suspended',
    ]);
  });
});

function minimalAutonomousAuthority() {
  return {
    leaseId: 'lease-1',
    leaseDigest: `sha256:${'a'.repeat(64)}`,
    nativePolicy: {
      mode: 'read_only',
      sandbox: 'read_only',
      shell_access: false,
    },
    context: {
      specialist: {
        agent_id: 'product-agent',
        domain: 'product',
        instructions: 'Produce evidence and stop at the signed quality gate.',
      },
      assignment: { description: 'Produce verified evidence.' },
      context_pack: {},
    },
    resolvedSkills: [],
    allowedTools: [],
    mcpPolicy: {
      allowedByServer: { orgx: [] },
      expectedSchemasByServer: { orgx: {} },
    },
  };
}
