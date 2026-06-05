# OrgX AI Client Hook Coverage

This audit is the package contract for answering whether OrgX plugins and
skills actually tap the hooks and tool surfaces exposed by each AI client.

## Verdict

Coverage is not sufficient yet for the full operator experience.

The Codex plugin covers Codex MCP installation, OrgX skills, stale-client
chronicle fallback, passive hook templates, and Work Graph reconciliation. It
does not prove direct `get_operator_chronicle` exposure in every active Codex
session, and it does not package first-class ChatGPT, Claude Code, or Cursor
hook/config artifacts. Those clients need their own verified install surfaces or
explicit handoff to the hosted OrgX MCP app.

The required product behavior is:

1. A user asks for yesterday, week, 30-day, decision chronology, artifacts, PRs,
   velocity, goals, initiatives, gaps, or priorities.
2. The client calls `get_operator_chronicle` when the callable tool list exposes
   it.
3. If the client has a stale schema, the client immediately calls
   `orgx_recommend` or `_orgx_recommend` with `mode: "morning_brief"`.
4. The response leads with `reportingNarrative.briefMarkdown`, then exposes
   drill-down IDs for decisions, artifacts, goals, initiatives, and data gaps.
5. Passive hooks reconcile missed evidence only after the fact; they are never
   treated as a substitute for live MCP read/write calls.

## Coverage Matrix

| Client | Current OrgX surface | Hook/support level | Chronicle route | Missing for seamless UX |
| --- | --- | --- | --- | --- |
| Codex | `orgx-codex-plugin` bundles `.mcp.json`, skills, local marketplace metadata, passive hook templates, peer sidecar, and Work Graph reconciler. | Partial. The package includes hook templates for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, and `Stop`, but current Codex sessions may expose only compatibility app tools. | Preferred: `get_operator_chronicle`. Fallback: `_orgx_recommend` / `orgx_recommend` with `mode: "morning_brief"`. | Prove direct callable exposure after plugin refresh. Add client-side evidence when bootstrap advertises `get_operator_chronicle` but the active tool list omits it. |
| ChatGPT | Hosted OrgX MCP / Apps SDK app through `https://mcp.useorgx.com/mcp`; widgets and tool descriptors live in the MCP server, not this Codex plugin. | No local lifecycle hook channel in this package. ChatGPT relies on app tool scanning, app approval, action controls, and widget resources. | Preferred: ChatGPT app tool `get_operator_chronicle` after Scan Tools / Refresh. Fallback: app tool `orgx_recommend` with `mode: "morning_brief"` if the scan is stale. | Verify the ChatGPT draft/published app action list includes the new direct tool. Capture web and mobile smoke prompts for the reviewer workspace. |
| Claude Code | Separate Claude Code config/plugin path is required. Claude Code supports lifecycle hooks and MCP tool hooks, but this package only ships Codex hook JSON. | Not covered by this Codex package. OrgX can reuse the summary-only hook script, but a Claude-specific plugin/settings artifact must install it with `source_client=claude-code`. | Preferred: Claude MCP tool `get_operator_chronicle`. Fallback: `orgx_recommend` with `mode: "morning_brief"`. | Add/verify a Claude Code plugin or settings template that uses Claude hook events and MCP-tool hooks without raw transcript persistence. |
| Cursor | Hosted OrgX MCP can be configured through `.cursor/mcp.json` or Cursor's MCP settings. Cursor rules can provide workflow guidance. | Not covered by this Codex package. Cursor exposes MCP tools and rules, not a matching passive hook package here. | Preferred: Cursor MCP tool `get_operator_chronicle`. Fallback: `orgx_recommend` with `mode: "morning_brief"`. | Add/verify Cursor install guidance, `.cursor/rules` guidance, and a smoke check with `cursor-agent mcp list-tools` once available. |

## Evidence Gates

The operator reporting system is only verified when all relevant gates have
current evidence:

- Hosted MCP bootstrap advertises `get_operator_chronicle`.
- The active client callable tool list exposes `get_operator_chronicle`, or the
  stale-client fallback is proven in that client.
- `mode: "morning_brief"` fallback returns `source_tool:
  "get_operator_chronicle"` and `reportingNarrative.briefMarkdown`.
- The report includes decisions, rollups, artifact ledger, PR velocity, goals,
  initiatives, top priorities, and data gaps.
- Hook reconciliation emits summary-only Work Graph evidence with
  `raw_transcripts_sent: false` and a stable `work_graph_fingerprint`.
- Client-specific install docs do not claim hook support where the client only
  supports MCP tools or prompt/rule guidance.

## Next Fixes

1. Codex: capture a refreshed plugin session where `get_operator_chronicle` is
   directly callable, or file the client/plugin schema-refresh gap with exact
   bootstrap/tool-list evidence.
2. ChatGPT: refresh the app tool scan and verify `get_operator_chronicle` in the
   action list before claiming the ChatGPT app has first-class chronicle UX.
3. Claude Code: add a Claude-specific hook template or plugin handoff that uses
   Claude lifecycle hooks with `source_client=claude-code`.
4. Cursor: add Cursor MCP/rules install artifacts and verify tool availability
   with Cursor's MCP tool listing.
5. OrgX app: implement durable accepted goal writer/linking so provisional
   `decision_requests` goals become first-class goals instead of a fallback.
