import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CodexAppServerClient } from './CodexAppServerClient.mjs';
import { parseConfiguredMcpServers } from './CodexMcpPolicy.mjs';
import { renderAutonomousPrompt } from './autonomousDispatch.mjs';
import { sanitizedChildProcessEnv } from './childProcessEnv.mjs';

const execFileAsync = promisify(execFile);

export async function prepareAutonomousCodexExecution(task, context, opts = {}) {
  const authority = context?.autonomous_authority;
  if (!authority) return null;

  const runnerRepoPath = opts.autonomousRepoPath;
  if (typeof runnerRepoPath !== 'string' || !runnerRepoPath) {
    throw new Error(
      'autonomous_repo_not_ready: ORGX_AUTONOMOUS_REPO_PATH is not a validated git worktree'
    );
  }
  if (task.repo_path != null && task.repo_path !== runnerRepoPath) {
    throw new Error(
      'autonomous_repo_path_conflict: remote task path does not match the runner-owned checkout'
    );
  }

  const discover = opts.mcpServerDiscovery ?? discoverConfiguredMcpServers;
  const configuredMcpServers = await discover();
  return {
    authority,
    cwd: runnerRepoPath,
    prompt: renderAutonomousPrompt(authority),
    configuredMcpServers,
    mcpPolicy: {
      ...authority.mcpPolicy,
      readOnly: authority.nativePolicy.sandbox === 'read_only',
      disableShell: authority.nativePolicy.shell_access === false,
    },
  };
}

export function autonomousPreflightFailure(runId, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    kind: 'task.failed',
    run_id: runId,
    reason: `autonomous_execution_preflight_failed: ${detail}`,
    recoverable: false,
  };
}

export async function probeAutonomousMcpReadiness(opts = {}) {
  let client;
  try {
    const discover = opts.mcpServerDiscovery ?? discoverConfiguredMcpServers;
    const servers = await discover();
    const requiredServer = opts.serverName ?? 'orgx';
    if (!servers.includes(requiredServer)) {
      return {
        ready: false,
        reason: `autonomous_mcp_server_missing:${requiredServer}`,
      };
    }
    const toolName = opts.toolName ?? 'orgx_bootstrap';
    const clientFactory =
      opts.appServerFactory ?? ((clientOpts) => new CodexAppServerClient(clientOpts));
    client = clientFactory({ version: opts.pluginVersion });
    const proof = await client.probeMcpReadiness({
      cwd: opts.cwd ?? process.cwd(),
      configuredMcpServers: servers,
      serverName: requiredServer,
      toolName,
      mcpPolicy: {
        allowedByServer: { [requiredServer]: [toolName] },
        expectedSchemasByServer: {},
        readOnly: true,
        disableShell: true,
      },
    });
    return { ready: true, reason: null, proof };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ready: false, reason: `autonomous_mcp_probe_failed:${detail}` };
  } finally {
    client?.close?.();
  }
}

export async function discoverConfiguredMcpServers() {
  const { stdout } = await execFileAsync('codex', ['mcp', 'list', '--json'], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    env: sanitizedChildProcessEnv(),
  });
  return parseConfiguredMcpServers(stdout);
}
