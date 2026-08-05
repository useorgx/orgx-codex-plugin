/**
 * Minimal JSON-RPC client for `codex app-server --stdio`.
 *
 * App-server is the only Codex CLI surface that keeps native
 * request_user_input and approval requests open while an external operator
 * answers them. `codex exec --json` deliberately cannot provide that contract.
 */

import { spawn } from 'node:child_process';

import {
  buildCodexAppServerArgs,
  verifyEffectiveMcpPolicy,
  verifyMcpReadinessStatus,
} from './CodexMcpPolicy.mjs';
import { sanitizedChildProcessEnv } from './childProcessEnv.mjs';

const CLOSE_GRACE_MS = 3_000;

export class CodexAppServerClient {
  constructor(opts = {}) {
    this.opts = opts;
    this.child = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.waiters = new Set();
    this.queue = [];
    this.queueWaiters = [];
    this.closed = false;
    this.stderr = '';
  }

  async start({
    cwd,
    prompt,
    metadata = {},
    mcpPolicy,
    configuredMcpServers = [],
  }) {
    await this._openThread({ cwd, mcpPolicy, configuredMcpServers });

    if (mcpPolicy) {
      const entries = await this._listMcpServerStatus(this.threadId);
      this.mcpPolicyProof = verifyEffectiveMcpPolicy(entries, mcpPolicy);
    }

    const turnResult = await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      responsesapiClientMetadata: stringifyMetadata(metadata),
    });
    this.turnId = turnResult?.turn?.id ?? turnResult?.turnId;
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      ...(this.mcpPolicyProof ? { mcpPolicyProof: this.mcpPolicyProof } : {}),
    };
  }

  async probeMcpReadiness({
    cwd,
    mcpPolicy,
    configuredMcpServers = [],
    serverName = 'orgx',
    toolName = 'orgx_bootstrap',
  }) {
    await this._openThread({ cwd, mcpPolicy, configuredMcpServers });
    const entries = await this._listMcpServerStatus(this.threadId);
    return verifyMcpReadinessStatus(entries, { serverName, toolName });
  }

  async _openThread({ cwd, mcpPolicy, configuredMcpServers }) {
    if (this.child) throw new Error('Codex app-server is already running');

    const spawnImpl = this.opts.spawnImpl ?? spawn;
    const args = mcpPolicy
      ? buildCodexAppServerArgs(mcpPolicy, configuredMcpServers)
      : ['app-server', '--stdio'];
    this.child = spawnImpl('codex', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedChildProcessEnv(process.env, this.opts.env ?? {}),
    });
    this._readStdout(this.child.stdout);
    this.child.stderr?.on?.('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4_000);
    });
    this.child.on?.('error', (error) => this._close(error));
    this.child.on?.('close', (code) => {
      const detail = this.stderr.trim();
      const error =
        code === 0
          ? null
          : new Error(
              `codex app-server exited ${code}${detail ? `: ${detail.slice(0, 500)}` : ''}`
            );
      this._close(error);
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'orgx_codex_peer',
        title: 'OrgX Codex Peer',
        version: this.opts.version ?? '0.0.0-dev',
      },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});

    const threadResult = await this.request('thread/start', {
      cwd,
      approvalPolicy: 'on-request',
      sandbox: mcpPolicy?.readOnly === true ? 'readOnly' : 'workspaceWrite',
      serviceName: 'orgx_codex_peer',
      ephemeral: false,
      ...(mcpPolicy ? { selectedCapabilityRoots: [] } : {}),
    });
    this.threadId = threadResult?.thread?.id ?? threadResult?.threadId;
    if (!this.threadId) throw new Error('Codex app-server did not return a thread id');
    return this.threadId;
  }

  async _listMcpServerStatus(threadId) {
    const entries = [];
    let cursor = null;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.request('mcpServerStatus/list', {
        threadId,
        detail: 'full',
        cursor,
        limit: 100,
      });
      if (!Array.isArray(result?.data)) {
        throw new Error(
          'mcp_status_invalid: mcpServerStatus/list returned an unsupported response'
        );
      }
      entries.push(...result.data);
      cursor = result.nextCursor ?? result.next_cursor ?? null;
      if (!cursor) return entries;
    }
    throw new Error('mcp_status_pagination_exceeded: MCP inventory exceeded 100 pages');
  }

  request(method, params) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      try {
        this._write({ id, method, params });
      } catch (error) {
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  notify(method, params) {
    this._write({ method, params });
  }

  respond(id, result) {
    this._write({ id, result });
  }

  respondError(id, code, message) {
    this._write({ id, error: { code, message } });
  }

  waitFor(predicate, timeoutMs = 30_000) {
    const queued = this.queue.find(predicate);
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Codex app-server event timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  async *messages() {
    while (!this.closed || this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const message = await new Promise((resolve) => this.queueWaiters.push(resolve));
      if (message) yield message;
    }
  }

  async interrupt() {
    if (this.threadId && this.turnId && !this.closed) {
      try {
        await this.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.turnId,
        });
      } catch {
        // Process termination below remains the cancellation backstop.
      }
    }
    this.close();
  }

  close() {
    const child = this.child;
    if (!child || this.closed) return;
    child.kill?.('SIGTERM');
    const timer = setTimeout(() => {
      if (!this.closed) child.kill?.('SIGKILL');
    }, CLOSE_GRACE_MS);
    timer.unref?.();
  }

  _write(message) {
    if (!this.child?.stdin || this.closed) {
      throw new Error('Codex app-server is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async _readStdout(stream) {
    try {
      for await (const line of readLines(stream)) {
        const message = safeParse(line);
        if (!message || typeof message !== 'object') continue;

        if (message.id != null && !message.method) {
          const pending = this.pending.get(String(message.id));
          if (pending) {
            this.pending.delete(String(message.id));
            if (message.error) {
              pending.reject(
                new Error(
                  `Codex app-server request failed: ${message.error.message ?? 'unknown error'}`
                )
              );
            } else {
              pending.resolve(message.result);
            }
            continue;
          }
        }

        this._publish(message);
      }
    } catch (error) {
      this._close(error);
    }
  }

  _publish(message) {
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }

    const direct = this.queueWaiters.shift();
    if (direct) direct(message);
    else this.queue.push(message);
  }

  _close(error) {
    if (this.closed) return;
    this.closed = true;
    const finalError = error ?? new Error('Codex app-server closed');
    for (const pending of this.pending.values()) pending.reject(finalError);
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(finalError);
    }
    this.waiters.clear();
    while (this.queueWaiters.length) this.queueWaiters.shift()(null);
  }
}

function stringifyMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)])
  );
}

async function* readLines(stream) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
