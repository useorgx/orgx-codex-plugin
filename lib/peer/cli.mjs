#!/usr/bin/env node
/**
 * CLI entrypoint: `orgx-codex-peer`.
 */

import { startPeer } from './peer.mjs';

async function main() {
  const apiKey = process.env.ORGX_API_KEY;
  const workspaceId = process.env.ORGX_WORKSPACE_ID;
  const baseUrl = process.env.ORGX_BASE_URL ?? 'https://useorgx.com';
  if (!apiKey || !workspaceId) {
    console.error('Missing ORGX_API_KEY and/or ORGX_WORKSPACE_ID. Export both and retry.');
    process.exit(2);
  }

  const peer = await startPeer({ apiKey, workspaceId, baseUrl });
  console.log('[orgx-codex-plugin] peer running — ctrl-c to stop.');

  const shutdown = async () => {
    await peer.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[orgx-codex-plugin] fatal', err);
  process.exit(1);
});
