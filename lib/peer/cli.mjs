#!/usr/bin/env node
/**
 * CLI entrypoint: `orgx-codex-peer`.
 */

import { startPeer } from './peer.mjs';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkAutonomousReadiness } from './autonomousReadiness.mjs';
import { parseAutonomousDispatchEnabled } from './runtimeConfig.mjs';
import {
  defaultInstallationId,
  resolveRunnerActivationBinding,
  resolveRunnerInstanceId,
} from './runnerInstanceIdentity.mjs';
import { captureFatalPeerException } from './sentry.mjs';
import { captureGatewayCredential } from './childProcessEnv.mjs';

export function isDirectRun({
  argvPath = process.argv[1],
  moduleUrl = import.meta.url,
  realpathSyncImpl = realpathSync,
} = {}) {
  if (!argvPath) return false;

  try {
    return (
      realpathSyncImpl(argvPath) === realpathSyncImpl(fileURLToPath(moduleUrl))
    );
  } catch {
    return moduleUrl === pathToFileURL(argvPath).href;
  }
}

export async function main(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const error = opts.error ?? console.error;

  // Capture transport authority exactly once, before any command-specific
  // readiness probe can spawn Codex, git, or MCP subprocesses.
  const apiKey = captureGatewayCredential(env);
  if (argv[0] === 'check-autonomous-readiness') {
    const check = opts.checkAutonomousReadinessImpl ?? checkAutonomousReadiness;
    const result = await check({
      autonomousRepoPath: env.ORGX_AUTONOMOUS_REPO_PATH,
    });
    log(JSON.stringify(result));
    return result.ready === true ? 0 : 1;
  }

  const workspaceId = env.ORGX_WORKSPACE_ID;
  const baseUrl = env.ORGX_BASE_URL ?? 'https://useorgx.com';
  const autonomousDispatchEnabled = parseAutonomousDispatchEnabled(
    env.ORGX_AUTONOMOUS_DISPATCH_ENABLED,
  );
  if (!apiKey || !workspaceId) {
    error('Missing ORGX_API_KEY and/or ORGX_WORKSPACE_ID. Export both and retry.');
    return 2;
  }

  const installationId = env.ORGX_INSTALLATION_ID ?? defaultInstallationId();
  const resolveIdentity =
    opts.resolveRunnerInstanceIdImpl ?? resolveRunnerInstanceId;
  let runnerInstanceId;
  let activationBinding;
  try {
    runnerInstanceId = await resolveIdentity({
      configuredId: env.ORGX_RUNNER_INSTANCE_ID,
      workspaceId,
      installationId,
      autonomousDispatchEnabled,
    });
    activationBinding = resolveRunnerActivationBinding({
      activationAttemptId: env.ORGX_ACTIVATION_ATTEMPT_ID,
      runnerRole: env.ORGX_RUNNER_ROLE,
    });
  } catch (identityError) {
    error(
      `[orgx-codex-plugin] ${
        identityError instanceof Error
          ? identityError.message
          : 'runner_instance_id_unavailable'
      }`,
    );
    return 2;
  }
  const start = opts.startPeerImpl ?? startPeer;
  const peer = await start({
    apiKey,
    workspaceId,
    baseUrl,
    installationId,
    runnerInstanceId,
    ...(activationBinding.activationAttemptId
      ? {
          activationAttemptId: activationBinding.activationAttemptId,
          runnerRole: activationBinding.runnerRole,
        }
      : {}),
    autonomousDispatchEnabled,
    autonomousRepoPath: env.ORGX_AUTONOMOUS_REPO_PATH,
    receiptOutboxPath: env.ORGX_RECEIPT_OUTBOX_PATH,
  });
  log('[orgx-codex-plugin] peer running — ctrl-c to stop.');

  const shutdown = async () => {
    await peer.stop();
    process.exit(0);
  };
  if (opts.registerSignalHandlers !== false) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  return 0;
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (err) => {
      await captureFatalPeerException(err);
      console.error('[orgx-codex-plugin] fatal', err);
      process.exitCode = 1;
    });
}
