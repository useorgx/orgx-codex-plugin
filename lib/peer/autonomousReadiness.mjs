import { CodexDriver } from './CodexDriver.mjs';
import { validateAutonomousRepoPath } from './runtimeConfig.mjs';

/**
 * One-shot installer gate for autonomous subscription execution. It proves
 * the runner-owned checkout, ChatGPT-authenticated Codex CLI, current
 * app-server RPC surface, and authenticated exact OrgX MCP overlay without
 * starting a model turn.
 */
export async function checkAutonomousReadiness(opts = {}) {
  const validateRepo = opts.autonomousRepoValidator ?? validateAutonomousRepoPath;
  const repo = await validateRepo(opts.autonomousRepoPath);
  if (repo.ready !== true) {
    return notReady(repo.reason ?? 'autonomous_repo_path_invalid');
  }

  const driver =
    opts.driver ??
    new CodexDriver({
      useAppServer: true,
      autonomousRepoPath: repo.path,
      pluginVersion: opts.pluginVersion,
      mcpServerDiscovery: opts.mcpServerDiscovery,
      appServerFactory: opts.appServerFactory,
    });
  const detected = await driver.detect();
  if (detected.installed !== true) {
    return notReady('codex_not_installed', detected, true);
  }
  if (detected.authenticated !== true || detected.provider_auth_verified !== true) {
    const reason = detected.auth_status === 'reauthentication_required' ? 'codex_reauthentication_required'
      : detected.auth_status === 'sign_in_required' ? 'codex_subscription_not_authenticated'
        : detected.auth_status === 'chatgpt_subscription_required' ? 'codex_chatgpt_subscription_required'
          : 'codex_provider_auth_unverified';
    return notReady(reason, detected, true);
  }
  if (detected.auth_method !== 'chatgpt') {
    return notReady('codex_chatgpt_subscription_required', detected, true);
  }
  if (detected.quota_status !== 'allowed') {
    return notReady(detected.quota_status === 'blocked' ? 'codex_usage_blocked' : 'codex_usage_unverified', detected, true);
  }

  const mcp = await driver.probeAutonomousMcpReadiness();
  if (mcp.ready !== true) {
    return {
      ready: false,
      reason: mcp.reason ?? 'autonomous_mcp_not_ready',
      repo_ready: true,
      codex: codexSummary(detected),
      mcp,
    };
  }
  return {
    ready: true,
    reason: null,
    repo_ready: true,
    codex: codexSummary(detected),
    mcp,
  };
}

function notReady(reason, detected, repoReady = false) {
  return {
    ready: false,
    reason,
    repo_ready: repoReady,
    ...(detected ? { codex: codexSummary(detected) } : {}),
  };
}

function codexSummary(detected) {
  return {
    installed: detected.installed === true,
    authenticated: detected.authenticated === true && detected.provider_auth_verified === true,
    cached_chatgpt_login: detected.cached_chatgpt_login === true,
    provider_auth_verified: detected.provider_auth_verified === true,
    quota_status: detected.quota_status ?? 'unknown',
    auth_method: detected.auth_method ?? null,
    version: detected.version ?? null,
  };
}
