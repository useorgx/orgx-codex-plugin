# OrgX Peer Sidecar for Codex

This folder adds a **peer sidecar** to `@useorgx/codex-plugin` so OrgX can dispatch tasks to the user's local `codex` CLI session. The existing skill catalog under `skills/` is shared. Production dispatch uses `codex app-server --stdio`, which keeps native questions and approvals open while OrgX routes them to the initiative Attention queue and returns the answer to the exact waiting request.

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

See `@useorgx/orgx-gateway-sdk` (https://github.com/useorgx/orgx-gateway-sdk) for the wire protocol. The peer negotiates protocol v3 so the gateway can deliver `attention.resolve` and receive monotonic continuation receipts.

`codex exec --json` remains as a compatibility path for driver tests and older
integrators. It cannot preserve `request_user_input` or approval server requests,
so OrgX peer dispatch does not use that path in production.

Secret-marked questions are never sent to OrgX. App-server receives an explicit
error telling the operator to enter the value in a local Codex UI, so API keys
and other sensitive answers cannot enter the remote Attention record.
