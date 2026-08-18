#!/usr/bin/env node
/**
 * CLI entrypoint: `orgx-codex-peer`.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `startPeer` is imported lazily inside main() so that loading this module —
// to unit-test the entrypoint guard — does not require the gateway SDK to be
// installed, and does not pull the peer runtime into the process.

/**
 * True when this module is the process entrypoint.
 *
 * MUST be symlink-safe. The launchd runner invokes the peer through the npm
 * bin shim (`runtime/node_modules/.bin/orgx-codex-peer`), which is a symlink to
 * this file. Node sets `process.argv[1]` to the *symlink* path but resolves
 * `import.meta.url` to the *real* path, so the naive comparison
 * `import.meta.url === pathToFileURL(process.argv[1]).href` is always false
 * under the bin shim — main() never runs and the process exits 0 in silence.
 * Comparing realpaths on both sides is what makes the guard hold.
 *
 * Parameterized so the guard itself is unit-testable.
 */
export function isDirectRun({
  argvPath = process.argv[1],
  moduleUrl = import.meta.url,
  realpathSyncImpl = realpathSync,
} = {}) {
  if (!argvPath) return false;
  try {
    return realpathSyncImpl(argvPath) === realpathSyncImpl(fileURLToPath(moduleUrl));
  } catch {
    // realpath throws on a deleted/unreadable path; fall back to the literal
    // comparison rather than crashing the entrypoint.
    try {
      return moduleUrl === pathToFileURL(argvPath).href;
    } catch {
      return false;
    }
  }
}

export async function main(opts = {}) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const error = opts.error ?? console.error;

  const apiKey = env.ORGX_API_KEY;
  const workspaceId = env.ORGX_WORKSPACE_ID;
  const baseUrl = env.ORGX_BASE_URL ?? 'https://useorgx.com';
  if (!apiKey || !workspaceId) {
    error('Missing ORGX_API_KEY and/or ORGX_WORKSPACE_ID. Export both and retry.');
    return 2;
  }

  const start =
    opts.startPeerImpl ?? (await import('./peer.mjs')).startPeer;
  const peer = await start({ apiKey, workspaceId, baseUrl });
  log('[orgx-codex-plugin] peer running — ctrl-c to stop.');

  if (opts.registerSignalHandlers !== false) {
    const shutdown = async () => {
      await peer.stop();
      process.exit(0);
    };
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
    .catch((err) => {
      console.error('[orgx-codex-plugin] fatal', err);
      process.exitCode = 1;
    });
}
