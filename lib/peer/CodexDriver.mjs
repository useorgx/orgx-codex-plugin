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

import { CodexAppServerClient } from './CodexAppServerClient.mjs';
import { buildCodexProcessConfigArgs } from './CodexMcpPolicy.mjs';
import {
  autonomousPreflightFailure,
  prepareAutonomousCodexExecution,
  probeAutonomousMcpReadiness,
} from './autonomousCodexExecution.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANCEL_GRACE_MS = 3_000;

export class CodexDriver {
  id = 'codex';

  constructor(opts = {}) {
    this.opts = opts;
    this.running = new Map();
    this.attention = new Map();
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
        /logged in using chatgpt/i.test(output) &&
        !/not logged in|not authenticated|sign in required|no session/i.test(
          output
        );
      return {
        installed: true,
        authenticated,
        version,
        subscription_active: authenticated,
        subscription_type: authenticated ? 'chatgpt' : null,
        auth_method: authenticated ? 'chatgpt' : null,
        auth_status: authenticated
          ? 'authenticated'
          : /logged in|authenticated/i.test(output)
            ? 'chatgpt_subscription_required'
            : 'sign_in_required',
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

  async probeAutonomousMcpReadiness() {
    return probeAutonomousMcpReadiness({
      mcpServerDiscovery: this.opts.mcpServerDiscovery,
      appServerFactory: this.opts.appServerFactory,
      serverName: 'orgx',
      cwd: this.opts.autonomousRepoPath,
      pluginVersion: this.opts.pluginVersion,
    });
  }

  async *dispatch(task, context) {
    if (this.opts.useAppServer === true) {
      yield* this.dispatchAppServer(task, context);
      return;
    }

    let autonomous;
    try {
      autonomous = await prepareAutonomousCodexExecution(task, context, this.opts);
    } catch (error) {
      yield autonomousPreflightFailure(context.run_id, error);
      return;
    }
    const prompt = autonomous?.prompt ?? renderPrompt(task);
    const cwd = autonomous?.cwd ?? task.repo_path ?? process.cwd();
    let policyArgs = [];
    if (autonomous) {
      try {
        policyArgs = buildCodexProcessConfigArgs(
          autonomous.mcpPolicy,
          autonomous.configuredMcpServers
        );
      } catch (error) {
        yield autonomousPreflightFailure(context.run_id, error);
        return;
      }
    }
    const args = [
      ...policyArgs,
      'exec',
      '--json',
      '--skip-git-repo-check',
      prompt,
    ];

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

  async *dispatchAppServer(task, context) {
    let autonomous;
    try {
      autonomous = await prepareAutonomousCodexExecution(task, context, this.opts);
    } catch (error) {
      yield autonomousPreflightFailure(context.run_id, error);
      return;
    }
    const prompt = autonomous?.prompt ?? renderPrompt(task);
    const cwd = autonomous?.cwd ?? task.repo_path ?? process.cwd();
    const startedAt = new Date().toISOString();
    const client = this.opts.appServerFactory
      ? this.opts.appServerFactory({ task, context })
      : new CodexAppServerClient({
          version: this.opts.pluginVersion,
          env: { ORGX_RUN_ID: context.run_id },
        });
    this.running.set(context.run_id, client);

    let firstResponseAt = null;
    let tokensTotal = 0;
    try {
      const handles = await client.start({
        cwd,
        prompt,
        metadata: {
          orgx_run_id: context.run_id,
          orgx_workspace_id: task.workspace_id ?? this.opts.workspaceId,
          orgx_initiative_id: task.initiative_id,
          orgx_workstream_id: task.workstream_id,
        },
        ...(autonomous
          ? {
              mcpPolicy: autonomous.mcpPolicy,
              configuredMcpServers: autonomous.configuredMcpServers,
            }
          : {}),
      });
      yield {
        kind: 'task.started',
        run_id: context.run_id,
        started_at: startedAt,
        session_handle: handles.threadId,
      };

      for await (const message of client.messages()) {
        if (!message || typeof message !== 'object') continue;

        if (message.id != null && isAttentionServerRequest(message.method)) {
          await this.forwardAppServerAttention({
            client,
            message,
            task,
            context,
            handles,
            cwd,
          });
          continue;
        }

        if (!firstResponseAt && isProgressNotification(message.method)) {
          firstResponseAt = new Date().toISOString();
        }
        if (message.method === 'thread/tokenUsage/updated') {
          tokensTotal = tokenUsageTotal(message.params?.tokenUsage) || tokensTotal;
          continue;
        }
        if (message.method === 'item/completed') {
          const step = appServerItemToStep(message.params?.item);
          if (step) {
            yield { kind: 'task.step', run_id: context.run_id, step };
          }
          continue;
        }
        if (message.method === 'turn/completed') {
          const turn = message.params?.turn ?? {};
          if (turn.status === 'failed') {
            yield {
              kind: 'task.failed',
              run_id: context.run_id,
              reason:
                turn.error?.message ?? turn.error?.additionalDetails ?? 'Codex turn failed',
              recoverable: false,
            };
          } else if (turn.status === 'interrupted') {
            yield {
              kind: 'task.failed',
              run_id: context.run_id,
              reason: 'Codex turn was interrupted',
              recoverable: true,
            };
          } else {
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
          }
          return;
        }
        if (message.method === 'error') {
          yield {
            kind: 'task.failed',
            run_id: context.run_id,
            reason:
              message.params?.error?.message ??
              message.params?.message ??
              'Codex app-server reported an error',
            recoverable: message.params?.willRetry === true,
          };
          return;
        }
      }

      yield {
        kind: 'task.failed',
        run_id: context.run_id,
        reason: 'Codex app-server closed without a terminal turn state',
        recoverable: true,
      };
    } catch (error) {
      yield autonomousPreflightFailure(context.run_id, error);
    } finally {
      client.close?.();
      this.running.delete(context.run_id);
      for (const [decisionId, pending] of this.attention) {
        if (pending.runId === context.run_id) this.attention.delete(decisionId);
      }
    }
  }

  async forwardAppServerAttention({
    client,
    message,
    task,
    context,
    handles,
    cwd,
  }) {
    if (hasSensitiveUserInput(message)) {
      client.respondError?.(
        message.id,
        -32602,
        'Sensitive input cannot be relayed through OrgX. Re-run this step in a local Codex UI and enter the secret there.'
      );
      return;
    }
    const requests = attentionRequestsFromAppServer(message);
    if (!requests.length) {
      client.respondError?.(
        message.id,
        -32602,
        `Unsupported Codex attention request: ${message.method}`
      );
      return;
    }

    const group = {
      runId: context.run_id,
      requestId: message.id,
      method: message.method,
      params: message.params ?? {},
      client,
      threadId: message.params?.threadId ?? handles.threadId,
      turnId: message.params?.turnId ?? handles.turnId,
      decisionIds: [],
      questions: requests,
      answers: new Map(),
      expectedCount: requests.length,
    };

    for (const [index, request] of requests.entries()) {
      const decision = await postAttention(
        this.opts.baseUrl ?? 'https://useorgx.com',
        this.opts.apiKey,
        {
          initiative_id: task.initiative_id,
          run_id: context.run_id,
          ...(task.workstream_id ? { workstream_id: task.workstream_id } : {}),
          idempotency_key: `codex:${context.run_id}:${message.method}:${message.id}:${index}`,
          question: request.question,
          context: request.context,
          ...(request.options.length ? { options: request.options } : {}),
          blocking: true,
          attention_kind: request.kind,
          response_mode: request.responseMode,
          source_client: 'codex',
          source_tool: message.method,
          source_session_id: group.threadId,
          source_event_id: `${message.id}:${request.questionId}`,
          impact_if_delayed:
            'This Codex turn remains paused at the exact request until the answer is returned.',
          recommended_action: request.recommendedAction,
          continuation: {
            strategy: 'reply_in_place',
            session_handle: group.threadId,
            tool_call_id:
              message.params?.itemId ?? message.params?.approvalId ?? String(message.id),
            capability_version: 'codex-app-server-v1',
          },
          metadata: {
            codex: {
              rpc_request_id: message.id,
              rpc_method: message.method,
              thread_id: group.threadId,
              turn_id: group.turnId,
              item_id: message.params?.itemId ?? null,
              question_id: request.questionId,
              question_index: index,
              question_count: requests.length,
              cwd,
            },
          },
        }
      );
      group.decisionIds.push(decision.decision_id);
      this.attention.set(decision.decision_id, group);
      request.decisionId = decision.decision_id;
    }
  }

  async *resolveAttention(message) {
    const group = this.attention.get(message.decision_id);
    if (!group) {
      throw new Error(
        'The Codex app-server request is no longer attached to this peer; the durable answer remains available in OrgX.'
      );
    }

    group.answers.set(message.decision_id, message.resolution);
    const complete =
      group.decisionIds.length === group.expectedCount &&
      group.decisionIds.every((decisionId) => group.answers.has(decisionId));
    if (!complete) {
      yield {
        state: 'answer_received',
        session_handle: group.threadId,
        detail: `${group.answers.size} of ${group.expectedCount} related answers received.`,
      };
      return;
    }

    yield {
      state: 'resuming',
      session_handle: group.threadId,
      detail: 'Returning the answer to the exact Codex app-server request.',
    };
    const response = responseForAttentionGroup(group);
    const accepted = group.client.waitFor(
      (event) =>
        event?.method === 'serverRequest/resolved' &&
        String(event.params?.requestId) === String(group.requestId),
      this.opts.resolveTimeoutMs ?? 30_000
    );
    group.client.respond(group.requestId, response);
    await accepted;
    for (const decisionId of group.decisionIds) this.attention.delete(decisionId);
    yield {
      state: 'resumed',
      session_handle: group.threadId,
      detail: 'Codex accepted the answer and continued the same turn.',
    };
  }

  async cancel(runId) {
    const child = this.running.get(runId);
    if (!child) return;
    if (typeof child.interrupt === 'function') {
      await child.interrupt();
      this.running.delete(runId);
      return;
    }
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

const APP_SERVER_ATTENTION_METHODS = new Set([
  'item/tool/requestUserInput',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'permissions/requestApproval',
]);

function isAttentionServerRequest(method) {
  return APP_SERVER_ATTENTION_METHODS.has(method);
}

function isProgressNotification(method) {
  return (
    method === 'item/started' ||
    method === 'item/completed' ||
    method === 'item/agentMessage/delta'
  );
}

function hasSensitiveUserInput(message) {
  return (
    message?.method === 'item/tool/requestUserInput' &&
    Array.isArray(message?.params?.questions) &&
    message.params.questions.some((question) => question?.isSecret === true)
  );
}

function attentionRequestsFromAppServer(message) {
  const params = message.params ?? {};
  if (message.method === 'item/tool/requestUserInput') {
    return (Array.isArray(params.questions) ? params.questions : []).map(
      (question, index) => {
        const options = (Array.isArray(question.options) ? question.options : [])
          .map((option, optionIndex) => ({
            id: `option-${optionIndex + 1}`,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          }))
          .filter((option) => typeof option.label === 'string' && option.label.trim());
        return {
          questionId: question.id ?? `question-${index + 1}`,
          question: question.question ?? question.header ?? 'Codex needs your input.',
          context: [
            question.header,
            params.questions.length > 1
              ? `Question ${index + 1} of ${params.questions.length}. Codex resumes after every answer arrives.`
              : null,
          ]
            .filter(Boolean)
            .join('\n\n'),
          options,
          kind: 'question',
          responseMode: options.length ? 'single_select' : 'free_text',
          recommendedAction: 'Answer here to continue the same Codex turn.',
        };
      }
    );
  }

  if (message.method === 'item/commandExecution/requestApproval') {
    const available = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter((item) => typeof item === 'string')
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
    return [
      {
        questionId: params.approvalId ?? params.itemId ?? 'command-approval',
        question: params.reason ?? 'Allow Codex to run this command?',
        context: [params.command ? `Command: ${params.command}` : null, params.cwd]
          .filter(Boolean)
          .join('\n\n'),
        options: approvalOptions(available),
        kind: 'permission',
        responseMode: 'single_select',
        recommendedAction:
          'Review the command and choose the narrowest approval that lets work continue.',
      },
    ];
  }

  if (message.method === 'item/fileChange/requestApproval') {
    return [
      {
        questionId: params.itemId ?? 'file-change-approval',
        question: params.reason ?? 'Allow Codex to apply these file changes?',
        context: params.grantRoot
          ? `Requested write root: ${params.grantRoot}`
          : 'Codex is waiting before applying a file change.',
        options: approvalOptions([
          'accept',
          'acceptForSession',
          'decline',
          'cancel',
        ]),
        kind: 'approval',
        responseMode: 'single_select',
        recommendedAction:
          'Review the pending change and approve once unless repeated access is intentional.',
      },
    ];
  }

  if (message.method === 'permissions/requestApproval') {
    return [
      {
        questionId: params.itemId ?? 'permission-profile-approval',
        question: params.reason ?? 'Allow Codex to expand its permissions?',
        context: [
          params.cwd ? `Working directory: ${params.cwd}` : null,
          `Requested permissions: ${JSON.stringify(params.permissions ?? {})}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        options: [
          { id: 'accept', label: 'Allow this turn' },
          { id: 'decline', label: 'Keep current limits' },
        ],
        kind: 'permission',
        responseMode: 'single_select',
        recommendedAction:
          'Grant only the permissions required by the current task.',
      },
    ];
  }
  return [];
}

function approvalOptions(values) {
  const labels = {
    accept: 'Allow once',
    acceptForSession: 'Allow for this session',
    decline: 'Decline and continue',
    cancel: 'Decline and stop',
  };
  return values.map((value) => ({ id: value, label: labels[value] ?? value }));
}

async function postAttention(baseUrl, apiKey, body) {
  if (!apiKey) throw new Error('Codex remote attention requires an OrgX API key.');
  if (!body.initiative_id) {
    throw new Error('Codex remote attention requires an initiative id.');
  }
  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}/api/client/live/attention`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.decision_id !== 'string') {
    throw new Error(
      `OrgX attention request failed (${response.status}): ${
        payload.error ?? 'missing decision id'
      }`
    );
  }
  return payload;
}

function responseForAttentionGroup(group) {
  if (group.method === 'item/tool/requestUserInput') {
    const answers = {};
    for (const question of group.questions) {
      const resolution = group.answers.get(question.decisionId) ?? {};
      answers[question.questionId] = {
        answers: resolutionAnswers(resolution, question.options),
      };
    }
    return { answers };
  }

  const resolution = group.answers.get(group.decisionIds[0]) ?? {};
  const decision = selectedDecision(resolution, group.questions[0]?.options);
  if (group.method === 'permissions/requestApproval') {
    return decision === 'accept'
      ? { permissions: group.params.permissions ?? {}, scope: 'turn' }
      : { permissions: {}, scope: 'turn' };
  }
  return {
    decision: ['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)
      ? decision
      : 'decline',
  };
}

function selectedDecision(resolution, options = []) {
  const raw =
    resolution.option_id ??
    resolution.option_ids?.[0] ??
    resolution.answer ??
    resolution.note ??
    resolution.status;
  if (typeof raw !== 'string') return 'decline';
  const byId = options.find((option) => option.id === raw);
  if (byId) return byId.id;
  const byLabel = options.find(
    (option) => option.label.toLowerCase() === raw.toLowerCase()
  );
  return byLabel?.id ?? raw;
}

function resolutionAnswers(resolution, options = []) {
  const raw =
    resolution.answer ??
    resolution.option_ids ??
    resolution.option_id ??
    resolution.note ??
    '';
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((value) => value != null && String(value).trim())
    .map((value) => {
      const stringValue = String(value);
      const option = options.find((item) => item.id === stringValue);
      return option?.label ?? stringValue;
    });
}

function appServerItemToStep(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'fileChange') {
    const path = item.changes?.[0]?.path ?? item.id ?? 'file';
    return {
      kind: 'file_edit',
      summary: `edit ${path} - ${item.status ?? 'completed'}`,
      evidence_ref: item.id ?? path,
    };
  }
  if (
    item.type === 'commandExecution' ||
    item.type === 'mcpToolCall' ||
    item.type === 'dynamicToolCall' ||
    item.type === 'collabAgentToolCall'
  ) {
    const tool = item.command ?? item.server ?? item.tool ?? item.type;
    return {
      kind: 'tool_call',
      summary: `call ${tool} - ${item.status ?? 'completed'}`,
      evidence_ref: item.id ?? tool,
    };
  }
  return null;
}

function tokenUsageTotal(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const total = usage.total ?? usage.totalUsage ?? usage;
  return (
    Number(total.totalTokens ?? total.total_tokens ?? 0) ||
    Number(total.inputTokens ?? total.input_tokens ?? 0) +
      Number(total.outputTokens ?? total.output_tokens ?? 0)
  );
}

export { PLUGIN_ROOT };
