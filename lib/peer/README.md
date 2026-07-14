# OrgX Peer Sidecar for Codex

This folder adds a **peer sidecar** to `@useorgx/codex-plugin` so OrgX can dispatch tasks to the user's local `codex` CLI session. The existing skill catalog under `skills/` is shared; the peer spawns `codex exec --json --skip-git-repo-check` with the rendered prompt and translates Codex JSONL lifecycle events into OrgX peer messages.

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

The dependency is pinned to the SDK release that supports both Gateway v1 and
v2. This peer deliberately negotiates v1 today: a successful Codex process is
not, by itself, a canonical `ProofPacket`. The protocol will move to v2 only
when the driver can return the envelope-bound proof, receipt, artifact, cost,
and outcome references required by `ExecutionResult`.
