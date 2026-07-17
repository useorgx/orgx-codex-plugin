import {
  AutonomousDispatchContractError,
  validateAutonomousDispatch,
} from './autonomousDispatchContract.mjs';

/**
 * Wrap every driver, including injected/test drivers, so runner-owned opt-in
 * is enforced before a local subscription process can be started.
 */
export class AutonomousDispatchGuard {
  constructor(driver, opts = {}) {
    this.driver = driver;
    this.autonomousDispatchEnabled = opts.autonomousDispatchEnabled === true;
    this.workspaceId = opts.workspaceId;
    this.autonomousRepoPath = opts.autonomousRepoPath;
    this.now = opts.now;
  }

  get id() {
    return this.driver.id;
  }

  get running() {
    return this.driver.running;
  }

  setAutonomousDispatchEnabled(value) {
    this.autonomousDispatchEnabled = value === true;
  }

  detect() {
    return this.driver.detect();
  }

  probe() {
    return this.driver.probe();
  }

  cancel(runId) {
    return this.driver.cancel(runId);
  }

  async *resolveAttention(message) {
    if (typeof this.driver.resolveAttention !== 'function') {
      throw new Error(`Driver '${this.id}' cannot resume attention requests`);
    }
    yield* this.driver.resolveAttention(message);
  }

  async *dispatch(task, context) {
    const runId = context?.run_id;
    if (context?.protocol_version === 2 || context?.execution_envelope) {
      yield failed(
        runId,
        'autonomous_v2_finalization_unsupported: protocol v2 requires real server-issued proof and verification IDs'
      );
      return;
    }

    const carriesAutonomousContext = isRecord(task?.autonomous_context);
    const dispatchClass = task?.dispatch_class;
    if (
      dispatchClass !== undefined &&
      dispatchClass !== 'interactive' &&
      dispatchClass !== 'autonomous'
    ) {
      yield failed(
        runId,
        'dispatch_class_invalid: dispatch_class must be interactive or autonomous'
      );
      return;
    }
    if (dispatchClass === 'interactive' && carriesAutonomousContext) {
      yield failed(
        runId,
        'dispatch_class_context_conflict: interactive dispatch cannot carry autonomous_context'
      );
      return;
    }

    if (!this.autonomousDispatchEnabled) {
      if (dispatchClass === 'autonomous' || carriesAutonomousContext) {
        yield failed(
          runId,
          'autonomous_dispatch_disabled: this runner has not opted into unattended work'
        );
        return;
      }
      yield* this.driver.dispatch(task, context);
      return;
    }

    if (dispatchClass === 'interactive') {
      yield* this.driver.dispatch(task, context);
      return;
    }

    if (dispatchClass !== 'autonomous') {
      yield failed(
        runId,
        'dispatch_class_missing: opted-in runners require an explicit interactive or autonomous dispatch class'
      );
      return;
    }

    if (!carriesAutonomousContext) {
      yield failed(
        runId,
        'autonomous_context_missing: opted-in runners reject unconstrained task.dispatch messages'
      );
      return;
    }

    if (
      typeof this.autonomousRepoPath !== 'string' ||
      !this.autonomousRepoPath
    ) {
      yield failed(
        runId,
        'autonomous_repo_not_ready: runner-owned checkout binding is missing'
      );
      return;
    }
    if (task.repo_path != null && task.repo_path !== this.autonomousRepoPath) {
      yield failed(
        runId,
        'autonomous_repo_path_conflict: remote task path does not match the runner-owned checkout'
      );
      return;
    }

    try {
      const autonomousAuthority = await validateAutonomousDispatch(task, context, {
        workspaceId: this.workspaceId,
        ...(this.now ? { now: this.now } : {}),
      });
      yield* this.driver.dispatch(task, {
        ...context,
        autonomous_authority: autonomousAuthority,
      });
    } catch (error) {
      const code =
        error instanceof AutonomousDispatchContractError
          ? error.code
          : 'autonomous_contract_invalid';
      const detail = error instanceof Error ? error.message : String(error);
      yield failed(runId, `${code}: ${detail}`);
    }
  }
}

export function renderAutonomousPrompt(authority) {
  const context = authority.context;
  const skillSections = authority.resolvedSkills.flatMap((skill) => [
    `### ${skill.id} (${skill.version})`,
    skill.instructions,
    '',
  ]);
  const toolLines = authority.allowedTools.map((tool) => {
    const qualified = `mcp__${tool.mcp_server}__${tool.mcp_tool}`;
    return `- ${qualified} (authorizes: ${tool.logical_capabilities.join(', ')})`;
  });
  return [
    'ORGX AUTONOMOUS SPECIALIST RUN',
    `Agent: ${context.specialist.agent_id} (${context.specialist.domain})`,
    `Capability lease: ${authority.leaseId} / ${authority.leaseDigest}`,
    `Native policy: ${authority.nativePolicy.mode} (shell access: ${authority.nativePolicy.shell_access})`,
    '',
    'SPECIALIST INSTRUCTIONS',
    context.specialist.instructions,
    '',
    'RESOLVED SKILLS',
    ...skillSections,
    'ASSIGNMENT',
    context.assignment.description,
    '',
    'CANONICAL CONTEXT',
    JSON.stringify(context.context_pack, null, 2),
    '',
    'AUTHORIZED MCP TOOLS',
    ...toolLines,
    '',
    'Use only the MCP tools listed above. Codex filesystem and shell tools remain governed by the signed native policy and workspace sandbox. Treat the signed lease, assignment, and context as immutable. Return concrete evidence; the Gateway persists the terminal execution receipt.',
  ].join('\n');
}

function failed(runId, reason) {
  return {
    kind: 'task.failed',
    run_id: runId,
    reason,
    recoverable: false,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
