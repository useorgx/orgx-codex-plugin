/**
 * CodexDriver — drives the local `codex` CLI for OrgX peer dispatch.
 *
 * The OpenAI Codex CLI supports non-interactive sessions via `codex run`
 * with `--format ndjson` for machine-readable output. The driver:
 *
 *   1. detect()   — `codex --version` to confirm CLI + auth (codex CLI
 *                    errors if no ChatGPT / Codex subscription is
 *                    active in the current shell).
 *   2. dispatch() — spawns `codex run --format ndjson` with the
 *                    rendered prompt as the last argument. Reads NDJSON
 *                    stdout line-by-line, yields PeerToServer messages.
 *   3. probe()    — liveness check via `codex --version`.
 *   4. cancel()   — SIGTERM the child then SIGKILL after 3s grace.
 *
 * Events the driver recognizes on stdout:
 *   { kind: 'tool_call',     tool, summary, ref? }
 *   { kind: 'file_edit',     path, summary, diff_ref? }
 *   { kind: 'chat',          role, text }
 *   { kind: 'tokens_used',   delta }
 *   { kind: 'assistant_completed', tokens_used }
 *   { kind: 'error',         message, recoverable? }
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
    try {
      const out = await runOnce('codex', ['--version'], { timeoutMs: 5_000 });
      return {
        installed: true,
        authenticated: !/not authenticated|sign in|no session/i.test(out.stderr),
        version: out.stdout.trim() || undefined,
        subscription_active: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found/i.test(msg)) {
        return { installed: false, authenticated: false, error: msg };
      }
      return { installed: true, authenticated: false, error: msg };
    }
  }

  async probe() {
    try {
      await runOnce('codex', ['--version'], { timeoutMs: 2_500 });
      return { subscription_active: true, session_alive: true, queue_depth: this.running.size };
    } catch {
      return { subscription_active: false, session_alive: false, queue_depth: this.running.size };
    }
  }

  async *dispatch(task, context) {
    const prompt = renderPrompt(task);
    const cwd = task.repo_path || process.cwd();
    const args = ['run', '--format', 'ndjson', prompt];

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

        if (
          !firstResponseAt &&
          (event.kind === 'tool_call' || event.kind === 'chat' || event.kind === 'file_edit')
        ) {
          firstResponseAt = new Date().toISOString();
        }

        if (event.kind === 'tokens_used') {
          tokensTotal += Number(event.delta ?? 0);
          continue;
        }

        if (event.kind === 'file_edit' || event.kind === 'tool_call') {
          const summary =
            event.kind === 'file_edit'
              ? `edit ${event.path} — ${event.summary ?? 'change'}`
              : `call ${event.tool ?? 'tool'} — ${event.summary ?? ''}`;
          yield {
            kind: 'task.step',
            run_id: context.run_id,
            step: {
              kind: event.kind,
              summary,
              evidence_ref: event.diff_ref ?? event.ref ?? null,
            },
          };

          for (const rule of rules) {
            if (rule.match?.on !== event.kind) continue;
            const text =
              event.kind === 'file_edit'
                ? `${event.path ?? ''} ${event.summary ?? ''}`
                : `${event.tool ?? ''} ${event.summary ?? ''}`;
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
              evidence_ref: event.diff_ref ?? event.ref ?? event.path ?? event.tool ?? '',
              dedupe_key: dedupe,
              severity: 'warn',
            };
          }
        }

        if (event.kind === 'assistant_completed') {
          tokensTotal = tokensTotal || Number(event.tokens_used ?? 0);
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

        if (event.kind === 'error') {
          yield {
            kind: 'task.failed',
            run_id: context.run_id,
            reason: event.message ?? 'codex errored',
            recoverable: event.recoverable === true,
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
