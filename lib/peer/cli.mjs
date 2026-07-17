#!/usr/bin/env node
/**
 * CLI entrypoint: `orgx-codex-peer`.
 */

import { startPeer } from './peer.mjs';
import { pathToFileURL } from 'node:url';

import { checkAutonomousReadiness } from './autonomousReadiness.mjs';
import { parseAutonomousDispatchEnabled } from './runtimeConfig.mjs';
import { captureFatalPeerException } from './sentry.mjs';

export async function main(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const error = opts.error ?? console.error;
  if (argv[0] === 'check-autonomous-readiness') {
    const check = opts.checkAutonomousReadinessImpl ?? checkAutonomousReadiness;
    const result = await check({
      autonomousRepoPath: env.ORGX_AUTONOMOUS_REPO_PATH,
    });
    log(JSON.stringify(result));
    return result.ready === true ? 0 : 1;
  }

  const apiKey = env.ORGX_API_KEY ?? env.ORGX_GATEWAY_KEY;
  const workspaceId = env.ORGX_WORKSPACE_ID;
  const baseUrl = env.ORGX_BASE_URL ?? 'https://useorgx.com';
  const autonomousDispatchEnabled = parseAutonomousDispatchEnabled(
    env.ORGX_AUTONOMOUS_DISPATCH_ENABLED,
  );
  if (!apiKey || !workspaceId) {
    error('Missing ORGX_API_KEY and/or ORGX_WORKSPACE_ID. Export both and retry.');
    return 2;
  }

  const installationId = env.ORGX_INSTALLATION_ID;
  const start = opts.startPeerImpl ?? startPeer;
  const peer = await start({
    apiKey,
    workspaceId,
    baseUrl,
    installationId,
    autonomousDispatchEnabled,
    autonomousRepoPath: env.ORGX_AUTONOMOUS_REPO_PATH,
  });
  log('[orgx-codex-plugin] peer running — ctrl-c to stop.');

  const shutdown = async () => {
    await peer.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
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
