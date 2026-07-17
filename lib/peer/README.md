# OrgX Peer Sidecar for Codex

This folder adds a **peer sidecar** to `@useorgx/codex-plugin` so OrgX can dispatch tasks to the user's local `codex` CLI session. The existing skill catalog under `skills/` is shared. Production dispatch uses `codex app-server --stdio`, which keeps native questions and approvals open while OrgX routes them to the initiative Attention queue and returns the answer to the exact waiting request.

## Run

```bash
ORGX_API_KEY=oxk_... ORGX_WORKSPACE_ID=<uuid> node lib/peer/cli.mjs
```

This default configuration accepts interactive OrgX dispatches only. To let
OrgX select this user-controlled runner for unattended Codex work, opt in on
the runner itself:

```bash
ORGX_AUTONOMOUS_DISPATCH_ENABLED=true \
ORGX_AUTONOMOUS_REPO_PATH=/absolute/path/to/git-worktree \
ORGX_API_KEY=oxk_... \
ORGX_WORKSPACE_ID=<uuid> \
node lib/peer/cli.mjs
```

Only the exact string `true` requests autonomous dispatch. The repo path is a
runner-owned binding: it must canonicalize to an existing git worktree root and
cannot be overridden by a Gateway task. Missing, relative, home-directory,
filesystem-root, nested, or conflicting paths fail closed. Service installers
should store the canonical path in a mode-0600 state file and export it without
sourcing arbitrary shell text.

The heartbeat distinguishes requested, repo-ready, and MCP-ready states. It
reports autonomous dispatch enabled only when the opt-in, checkout, and local
`orgx` MCP configuration are all ready. Every autonomous run then validates the
signed V1 context/lease/tool bundle, verifies and injects the actual resolved
skill instructions bound by the runtime profile and execution envelope,
launches Codex with only the exact MCP tools enabled, disables every other
configured MCP server, and checks
`mcpServerStatus/list` tool names and input schemas before `turn/start`. Any
unsupported Codex version, missing server, extra tool, schema drift, expired
lease, or malformed lineage stops before model execution. Protocol V2 remains
disabled until the plugin can supply real server-issued proof and verification
IDs.

The signed native policy is separate from the MCP manifest. Non-engineering
work uses Codex's `readOnly` sandbox and the stable `shell_tool=false` switch;
only an engineering agent with `engineering_execution` bound into both the work
node and capability lease may receive `workspaceWrite` plus shell access. Codex
does not currently expose a complete native-tool inventory over app-server, so
the peer does not claim that read-only turns contain only MCP tools. The sandbox
is the write boundary for remaining non-shell native utilities.

An opted-in peer still accepts user-initiated dispatches, but only when the
Gateway explicitly places `dispatch_class: interactive` on the task. Background
dispatches require `dispatch_class: autonomous` plus the full signed context;
missing, unknown, or contradictory classes fail closed. Configure the hosted
OrgX MCP server with `codex mcp add orgx --url https://mcp.useorgx.com/mcp` and
complete `codex mcp login orgx`. The `oxk_` Gateway key below must never be
reused as the MCP OAuth token.

Before writing the autonomous setting, an installer can run:

```bash
ORGX_AUTONOMOUS_REPO_PATH=/absolute/path/to/git-worktree \
  orgx-codex-peer check-autonomous-readiness
```

This one-shot command does not require `ORGX_API_KEY`. It starts no model turn
and exits nonzero unless the repo, ChatGPT subscription login, app-server RPC,
OrgX MCP OAuth, exact one-tool overlay, and bounded bootstrap schema all pass.

Programmatic:

```js
import { startPeer } from '@useorgx/codex-plugin/peer';

const peer = await startPeer({
  apiKey: process.env.ORGX_API_KEY,
  workspaceId: process.env.ORGX_WORKSPACE_ID,
  autonomousDispatchEnabled: true,
  autonomousRepoPath: process.env.ORGX_AUTONOMOUS_REPO_PATH,
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
