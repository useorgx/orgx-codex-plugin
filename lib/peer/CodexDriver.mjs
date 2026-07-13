/**
 * CodexDriver — drives the local `codex` CLI for OrgX peer dispatch.
 *
 * The OpenAI Codex CLI supports non-interactive sessions via `codex exec`
 * with `--json` for machine-readable output. The driver:
 *
 *   1. detect()   — `codex --version` confirms installation, then
 *                    `codex login status` confirms the local ChatGPT/Codex
 *                    session. Version output is never treated as auth proof.
 *   2. dispatch() — spawns `codex exec --json` with the
 *                    rendered prompt as the last argument. Reads NDJSON
 *                    stdout line-by-line, yields PeerToServer messages.
 *   3. probe()    — repeats the auth-aware detection contract.
 *   4. cancel()   — SIGTERM the child then SIGKILL after 3s grace.
 *
 * Events the driver recognizes on stdout:
 *   { kind: 'tool_call',     tool, summary, ref? }
 *   { kind: 'file_edit',     path, summary, diff_ref? }
 *   { kind: 'chat',          role, text }
 *   { kind: 'tokens_used',   delta }
 *   { kind: 'assistant_completed', tokens_used }
 *   { kind: 'error',         message, recoverable? }
 *   { type: 'item.completed', item: { type: 'agent_message' | 'tool_call' | ... } }
 *   { type: 'turn.completed', usage }
 *
 * Skill rules (fetched from /api/v1/plan-skills) run against file_edit
 * and tool_call events; matches emit task.deviation.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANCEL_GRACE_MS = 3_000;

export class CodexDriver {
  id = 'codex';

  constructor(opts = {}) {
    this.opts = opts;
    this.running = new Map();
  }

  async detect() {
    let version;
    try {
      const out = await runOnce('codex', ['--version'], { timeoutMs: 5_000 });
      version = out.stdout.trim() || undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found/i.test(msg)) {
        return {
          installed: false,
          authenticated: false,
          subscription_active: false,
          auth_status: 'not_installed',
          error: msg,
        };
      }
      return {
        installed: true,
        authenticated: false,
        subscription_active: false,
        auth_status: 'probe_failed',
        error: msg,
      };
    }

    try {
      const auth = await runOnce('codex', ['login', 'status'], {
        timeoutMs: 5_000,
      });
      const output = `${auth.stdout}\n${auth.stderr}`.trim();
      const authenticated =
        /logged in using chatgpt|logged in|authenticated/i.test(output) &&
        !/not logged in|not authenticated|sign in required|no session/i.test(
          output
        );
      return {
        installed: true,
        authenticated,
        version,
        subscription_active: authenticated,
        subscription_type: authenticated ? 'chatgpt' : null,
        auth_method: /chatgpt/i.test(output) ? 'chatgpt' : null,
        auth_status: authenticated ? 'authenticated' : 'sign_in_required',
      };
    } catch (err) {
      return {
        installed: true,
        authenticated: false,
        version,
        subscription_active: false,
        subscription_type: null,
        auth_method: null,
        auth_status: 'sign_in_required',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async probe() {
    const detected = await this.detect();
    const ready = detected.installed === true && detected.authenticated === true;
    return {
      subscription_active: ready,
      session_alive: detected.installed === true,
      dispatch_ready: ready,
      auth_status: detected.auth_status,
      auth_method: detected.auth_method ?? null,
      subscription_type: detected.subscription_type ?? null,
      queue_depth: this.running.size,
    };
  }

  async *dispatch(task, context) {
    const prompt = renderPrompt(task);
    const cwd = task.repo_path || process.cwd();
    const args = ['exec', '--json', '--skip-git-repo-check', prompt];

    const startedAt = new Date().toISOString();
    const child = spawn('codex', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ORGX_RUN_ID: context.run_id },
    });
    this.running.set(context.run_id, child);

    yield { kind: 'task.started', run_id: context.run_id, started_at: startedAt };

    const rules = (await (this.opts.skillRules?.() ?? Promise.resolve([]))).filter(Boolean);
    const seen = new Set();
    let firstResponseAt = null;
    let tokensTotal = 0;

    try {
      for await (const line of readNdjson(child.stdout)) {
        const event = safeParse(line);
        if (!event || typeof event !== 'object') continue;

        const step = eventToStep(event);
        if (
          !firstResponseAt &&
          (step || event.kind === 'chat' || event.type === 'item.completed')
        ) {
          firstResponseAt = new Date().toISOString();
        }

        if (event.kind === 'tokens_used') {
          tokensTotal += Number(event.delta ?? 0);
          continue;
        }

        if (step) {
          yield {
            kind: 'task.step',
            run_id: context.run_id,
            step,
          };

          for (const rule of rules) {
            if (rule.match?.on !== step.kind) continue;
            const text = `${step.evidence_ref ?? ''} ${step.summary ?? ''}`;
            try {
              if (!new RegExp(rule.match.pattern).test(text)) continue;
            } catch {
              continue;
            }
            const dedupe = `${rule.skill_id}:${rule.dedupe_fingerprint}:${context.run_id}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            yield {
              kind: 'task.deviation',
              run_id: context.run_id,
              skill_id: rule.skill_id,
              evidence_kind: rule.evidence_kind,
              evidence_ref: step.evidence_ref ?? '',
              dedupe_key: dedupe,
              severity: 'warn',
            };
          }
        }

        const completed = completionFromEvent(event);
        if (completed) {
          tokensTotal = tokensTotal || completed.tokens_used;
          yield {
            kind: 'task.completed',
            run_id: context.run_id,
            outcome_kind: 'shipped',
            started_at: startedAt,
            first_response_at: firstResponseAt ?? startedAt,
            completed_at: new Date().toISOString(),
            tokens_used: tokensTotal,
            provider: 'openai',
            source_sub_type: 'subscription',
            source_driver: 'codex',
            cost_estimate_cents: 0,
          };
          return;
        }

        const failure = failureFromEvent(event);
        if (failure) {
          yield {
            kind: 'task.failed',
            run_id: context.run_id,
            reason: failure.message,
            recoverable: failure.recoverable,
          };
          return;
        }
      }

      const exitCode = await waitExit(child);
      if (exitCode === 0) {
        yield {
          kind: 'task.completed',
          run_id: context.run_id,
          outcome_kind: 'shipped',
          started_at: startedAt,
          first_response_at: firstResponseAt ?? startedAt,
          completed_at: new Date().toISOString(),
          tokens_used: tokensTotal,
          provider: 'openai',
          source_sub_type: 'subscription',
          source_driver: 'codex',
          cost_estimate_cents: 0,
        };
      } else {
        yield {
          kind: 'task.failed',
          run_id: context.run_id,
          reason: `codex exited ${exitCode}`,
          recoverable: exitCode === null,
        };
      }
    } finally {
      this.running.delete(context.run_id);
    }
  }

  async cancel(runId) {
    const child = this.running.get(runId);
    if (!child) return;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, CANCEL_GRACE_MS).unref?.();
    this.running.delete(runId);
  }
}

// ───── Helpers ────────────────────────────────────────────────────────────

function runOnce(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      rejectFn(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(t);
      rejectFn(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolveFn({ stdout, stderr });
      else rejectFn(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

async function* readNdjson(stream) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function eventToStep(event) {
  if (event.kind === 'file_edit') {
    return {
      kind: 'file_edit',
      summary: `edit ${event.path ?? 'file'} - ${event.summary ?? 'change'}`,
      evidence_ref: event.diff_ref ?? event.ref ?? event.path ?? null,
    };
  }
  if (event.kind === 'tool_call') {
    return {
      kind: 'tool_call',
      summary: `call ${event.tool ?? 'tool'} - ${event.summary ?? ''}`,
      evidence_ref: event.ref ?? event.tool ?? null,
    };
  }

  if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') {
    return null;
  }

  const item = event.item;
  if (item.type === 'tool_call' || item.type === 'function_call') {
    const tool = item.name ?? item.tool ?? item.call_name ?? 'tool';
    return {
      kind: 'tool_call',
      summary: `call ${tool} - ${item.status ?? 'completed'}`,
      evidence_ref: item.id ?? item.call_id ?? tool,
    };
  }

  if (
    item.type === 'file_edit' ||
    item.type === 'file_change' ||
    item.type === 'patch' ||
    item.type === 'apply_patch'
  ) {
    const path = item.path ?? item.file ?? item.file_path ?? 'file';
    return {
      kind: 'file_edit',
      summary: `edit ${path} - ${item.summary ?? item.status ?? 'change'}`,
      evidence_ref: item.diff_ref ?? item.id ?? path,
    };
  }

  return null;
}

function completionFromEvent(event) {
  if (event.kind === 'assistant_completed') {
    return { tokens_used: Number(event.tokens_used ?? 0) };
  }
  if (event.type !== 'turn.completed') return null;
  const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
  return {
    tokens_used:
      Number(usage.total_tokens ?? 0) ||
      Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0),
  };
}

function failureFromEvent(event) {
  if (event.kind === 'error') {
    return {
      message: event.message ?? 'codex errored',
      recoverable: event.recoverable === true,
    };
  }
  if (event.type === 'error') {
    return {
      message: event.message ?? event.error ?? 'codex errored',
      recoverable: event.recoverable === true,
    };
  }
  if (event.type === 'turn.failed') {
    return {
      message: event.message ?? event.reason ?? 'codex turn failed',
      recoverable: event.recoverable === true,
    };
  }
  return null;
}

function waitExit(child) {
  return new Promise((resolveFn) => {
    if (child.exitCode !== null) resolveFn(child.exitCode);
    else child.once('close', (code) => resolveFn(code));
  });
}

function renderPrompt(task) {
  const parts = [task.title];
  if (task.description) parts.push('\n\n', task.description);
  if (task.skill_ids?.length) {
    parts.push('\n\nSkills to honor:\n');
    for (const id of task.skill_ids) parts.push(`  - ${id}\n`);
  }
  return parts.join('');
}

export { PLUGIN_ROOT };
