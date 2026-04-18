# OrgX Peer Sidecar for Codex

This folder adds a **peer sidecar** to `@useorgx/codex-plugin` so OrgX can dispatch tasks to the user's local `codex` CLI session. The existing skill catalog under `skills/` is shared; the peer spawns `codex run --format ndjson` with the rendered prompt.

## Run

```bash
ORGX_API_KEY=oxk_... ORGX_WORKSPACE_ID=<uuid> node lib/peer/cli.mjs
```

Programmatic:

```js
import { startPeer } from '@useorgx/codex-plugin/peer';

const peer = await startPeer({
  apiKey: process.env.ORGX_API_KEY,
  workspaceId: process.env.ORGX_WORKSPACE_ID,
});
await peer.stop();
```

## Required oxk_ scopes

- `gateway:drive`
- `plugin:heartbeat`

See `@useorgx/orgx-gateway-sdk` (https://github.com/useorgx/orgx-gateway-sdk) for the wire protocol. Tests use `node --test` with a fake `codex` shim on PATH.
