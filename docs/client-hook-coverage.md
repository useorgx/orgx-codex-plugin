# OrgX AI Client Hook Coverage

This audit is the package contract for answering whether OrgX plugins and
skills actually tap the hooks and tool surfaces exposed by each AI client.

## Verdict

Coverage is not sufficient yet for the full operator experience.

The Codex plugin covers Codex MCP installation, OrgX skills, stale-client
chronicle fallback, native `SessionStart` context injection, and a manual Work
Graph reconciler. Session collection is deliberately not duplicated in the
plugin: explicit `orgx-codex-install-hooks` setup delegates lifecycle capture,
consent policy, queueing, acknowledgement, retry, and delivery to Wizard. Source
verification does not by itself prove the newly packed plugin has run inside a
fresh installed Codex session.

This Codex package still does not package first-class ChatGPT or Cursor
hook/config artifacts. Claude Code is covered by the separate
`orgx-claude-code-plugin` install, which now has its own verified Stop-hook
reconciliation path. Cursor is verified through its native MCP and repo-local
rules/commands surfaces, not a passive lifecycle hook. ChatGPT still needs a
verified app action-list refresh before first-class chronicle UX is proven. The
current blocker is not the hosted MCP descriptor; it is client-side refresh,
authentication durability, and tool exposure inside each AI client's actual UI
or CLI session.

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

## Alternatives And Hook Fit

There are three viable reporting paths, but they are not equivalent:

1. **Direct MCP readout**: the client exposes `get_operator_chronicle` and the
   agent calls it in-session. This is the preferred path for decisions,
   chronology, artifacts, PRs, velocity, goals, initiatives, gaps, and next
   priorities because it is live, scoped, and inspectable.
2. **MCP morning-brief fallback**: the client exposes only the compatibility
   wrapper or has a stale tool schema, so the agent calls `orgx_recommend` /
   `_orgx_recommend` with `mode: "morning_brief"`. This is acceptable as a
   temporary UX fallback only when the response proves `source_tool:
   "get_operator_chronicle"` and includes `reportingNarrative.briefMarkdown`.
3. **Passive hook reconciliation**: the client emits lifecycle events and OrgX
   reconciles Work Graph evidence after the fact. This is a backstop for missed
   local evidence, not the main reporting UX, because it cannot reliably answer
   a live "what changed yesterday / this week / this month?" question without a
   subsequent MCP read.

Client hook coverage is therefore judged by whether the plugin taps the hooks
that the client actually exposes:

- Codex: the plugin taps native `SessionStart` only for first-turn hydration.
  Wizard owns later lifecycle capture, including `Stop`, and its summary-only
  Work Graph evidence. Direct chronicle readout is still gated on active-session
  tool exposure.
- ChatGPT: has no local lifecycle hook in this package. The correct surface is
  hosted MCP / Apps SDK tool discovery plus app action controls and widgets.
- Claude Code: taps lifecycle hooks through the separate Claude plugin and has
  direct MCP readout proof in the local CLI.
- Cursor: has MCP tools plus rules/commands, but no equivalent passive
  lifecycle hook package here. Cursor now has a repo-local `OrgX: Morning Brief`
  command, but reporting quality still depends on durable MCP auth and stable
  tool listing.

This same hook-fit audit is encoded in
`docs/operator-reporting-gates.json` under `clientHookSurfaces`. The package
verifier fails if any client lacks a declared best available surface, direct
readout path, fallback path, passive hook support level, sufficiency state, and
current gap. That keeps "alternatives exist" separate from "this plugin has
actually tapped the strongest native hook/action surface this client exposes."

## Coverage Matrix

| Client | Current OrgX surface | Hook/support level | Chronicle route | Missing for seamless UX |
| --- | --- | --- | --- | --- |
| Codex | `orgx-codex-plugin` bundles `.mcp.json`, skills, a canonical `hooks/hooks.json` SessionStart adapter, peer sidecar, and Work Graph reconciler. | The plugin injects bounded `additionalContext` and forwards `data.sessionWorkContext` unchanged to Wizard for exact-cwd activation. Wizard alone owns later lifecycle capture. Plugin-initiated setup defaults to metadata-only unless `ORGX_SESSION_WORK_EPISODE_CAPTURE=bounded` is explicit. | Preferred: `get_operator_chronicle`. Fallback: `_orgx_recommend` / `orgx_recommend` with `mode: "morning_brief"`. | Isolated fresh-install proof passes. Wizard source compatibility for the current app `cost.availability` union merged in Wizard PR #105; a release containing that change and a production/global install remain unproven. |
| ChatGPT | Hosted OrgX MCP / Apps SDK app through `https://mcp.useorgx.com/mcp`; widgets and tool descriptors live in the MCP server, not this Codex plugin. Live `server.json` exposes 29 tools including `get_operator_chronicle`. | No local lifecycle hook channel in this package. ChatGPT relies on app tool scanning, app approval, action controls, and widget resources. | Preferred: ChatGPT app tool `get_operator_chronicle` after Scan Tools / Refresh. Fallback: app tool `orgx_recommend` with `mode: "morning_brief"` if the scan is stale. | Verify the ChatGPT draft/published app action list includes the new direct tool. Current UI proof is blocked: Chrome is not logged into ChatGPT, native ChatGPT app inspection is unavailable to Codex, and the logged-in Arc browser state is unsafe for automation until an unrelated LinkedIn edit modal is cleared. |
| Claude Code | Separate Claude Code config/plugin path is required. Claude Code supports lifecycle hooks and MCP tool hooks, but this package only ships Codex hook JSON. | Separate `orgx-claude-code-plugin` install is verified at `0.1.3`: it emits reporting events on `SessionStart`, `PostToolUse`, `SubagentStop`, and `Stop`, then runs non-blocking local Work Graph reconciliation on Claude `Stop`. Claude Code `2.1.165` now has the user-scoped local `orgx` MCP entry connected and a fresh noninteractive direct readout succeeded through `mcp__orgx__get_operator_chronicle`. | Preferred: Claude MCP tool `get_operator_chronicle`. Fallback: `orgx_recommend` with `mode: "morning_brief"`. | Keep monitoring hook reliability: one `claude mcp get orgx` run reported a cancelled `SessionEnd` hook even while MCP auth was connected. |
| Cursor | Hosted OrgX MCP is configured in `~/.cursor/mcp.json`, and repo-local Cursor overlay files exist under `.cursor/orgx`, `.cursor/rules`, and `.cursor/commands`. PR #1732 added `OrgX: Morning Brief` to the repo-local overlay. | Direct MCP tool surface is viable but auth is volatile. On 2026-06-05, `cursor-agent mcp list-tools orgx` first required OAuth; after `cursor-agent mcp login orgx`, it returned 29 tools including direct `get_operator_chronicle`. Later the same day, a fresh check required `cursor-agent mcp login orgx` again. Cursor exposes MCP tools and rules/commands, not a matching passive lifecycle hook package here. | Preferred: Cursor MCP tool `get_operator_chronicle`. Fallback: `orgx_recommend` with `mode: "morning_brief"`. Repo command: `OrgX: Morning Brief`. | Resolve the CLI inconsistency where `cursor-agent mcp list` reports no configured servers while `cursor-agent mcp list-tools orgx` can still succeed, and make OAuth/session persistence durable enough that the user does not have to re-login for reporting clarity. |

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
- Accepted goal decisions are persisted into first-class goal links instead of
  remaining provisional `decision_requests` fallback signals.
- Hook reconciliation emits summary-only Work Graph evidence with
  `raw_transcripts_sent: false` and a stable `work_graph_fingerprint`.
- Client-specific install docs do not claim hook support where the client only
  supports MCP tools or prompt/rule guidance.

## Current Evidence Snapshot

Last checked: 2026-06-05 10:50 America/Chicago.

- Context activation slice checked 2026-08-24 22:00 America/Chicago. Codex CLI
  `0.147.0` installed this source into a fresh isolated plugin cache. Its native
  `SessionStart` adapter called a loopback `/api/v1/context-pack` with the exact
  workspace, initiative, workstream, and task IDs. A loopback Responses provider
  then observed both the OrgX context marker and the user marker in every first
  model request. The project pack was mode `0600`, and Wizard inspection was
  `ready` for the exact project cwd. This is isolated installed-client proof,
  not a global or production install.
- The current installed Wizard `0.1.69` still rejects the app's strict
  `cost: { availability: "not_observed" }` branch. The plugin preserves that
  exact object as pending instead of rewriting it. Source compatibility merged
  in Wizard PR #105; the remaining gap is releasing and installing a Wizard
  version that contains it, then repeating the installed-client canary.

- Live `https://mcp.useorgx.com/server.json` returned status `200` with 29
  tools, including `get_operator_chronicle` and `orgx_recommend`.

- Codex hosted MCP bootstrap advertised `get_operator_chronicle`, but the active
  Codex callable namespace still exposed wrapper tools. The stale-client
  fallback `_orgx_recommend` with `mode: "morning_brief"` returned `ok: true`,
  `source_tool: "get_operator_chronicle"`, and
  `reportingNarrative.briefMarkdown`.
- Fresh Codex bootstrap on 2026-06-05 returned server version
  `0.3.0-1b087831`, `visible_tools_count: 29`, and `visible_tools` including
  `get_operator_chronicle`; the active Codex namespace still exposed only the
  underscore wrapper tools in this session.
- `docs/operator-reporting-gates.json` now records the reporting proof gates as
  machine-readable status, route, evidence, and next-step entries. The plugin
  verifier fails if open gates such as Codex direct tool exposure, ChatGPT
  action-list proof, Cursor auth durability, or accepted-goal live data are
  accidentally marked verified without evidence.
- `orgx-codex-diagnose-reporting` now runs a redacted local diagnostic across
  hosted MCP descriptor health, Codex Stop hooks, latest Work Graph report,
  Cursor config shape, Cursor Agent auth, Cursor MCP list/list-tools, and Claude
  MCP config. A live run at 2026-06-05 10:45 America/Chicago returned
  `attentionState: "needs_you"` with exactly three open gates:
  `cursor_agent_auth`, `cursor_mcp_list`, and `cursor_list_tools_orgx`.
  Text mode now leads with the recovery sequence before the details:
  `cursor-agent login`, then `cursor-agent mcp list`, then
  `cursor-agent mcp login orgx` if `list-tools orgx` still fails to expose
  `get_operator_chronicle`.
- The previously installed `~/.codex/hooks.json` may still contain older Wizard
  handlers. Re-run `orgx-codex-install-hooks` after a Wizard release containing
  PR #105 rather than treating merged source as installed state.
- Running the installed Stop reconcile command wrote
  `~/.config/useorgx/wizard/hooks/reports/latest-work-graph-report.json` with
  `generated_at: "2026-06-05T14:00:18.983Z"`, `records_read: 5000`,
  `raw_transcripts_sent: false`, `redaction_level: "summary_only"`,
  `work_graph_fingerprint: wgf_928a73d6ddb93f28527167da`, and source coverage
  for Claude Code, Codex, OpenClaw, and opencode.
- Historical local plugin/cache version and Stop-reconcile receipts remain
  historical evidence; they do not prove this source revision is installed.
- `npm run check`, `npm test`, the opt-in real-Wizard integration test, an npm
  package install, and the isolated native first-turn canary passed for this
  source revision. Global install and production proof remain separate.
- Claude Code PR #14
  (`https://github.com/useorgx/orgx-claude-code-plugin/pull/14`) merged
  Stop-hook reconciliation. Installed wizard source and Claude cache paths at
  `0.1.3` passed `npm run check`. Running the active Claude cache Stop
  reconciler wrote
  `~/.config/useorgx/wizard/hooks/reports/latest-work-graph-report.json` with
  `records_read: 5000`, `raw_transcripts_sent: false`,
  `raw_transcripts_excluded: true`,
  `work_graph_fingerprint: wgf_928a73d6ddb93f28527167da`, and
  `posted: false`.
- Claude Code `2.1.165` now reports the user-scoped local `orgx` server as
  `Connected`. A fresh `claude mcp get orgx` check at 2026-06-05 10:31
  America/Chicago returned connected cleanly with no cancelled hook warning.
  A prior noninteractive smoke test with
  `--allowedTools mcp__orgx__get_operator_chronicle` and
  `--output-format json` exited successfully and returned
  `tool_used: "mcp__orgx__get_operator_chronicle"`, `has_briefMarkdown: true`,
  headline `275 items need a decision or unblock`, 6 top priorities, 8 pending
  decisions, 23 resolved decisions in 30 days, 53 artifacts, 4 goals, and 1
  data gap. This closes the Claude direct-readout gate for the current local
  CLI session historically; a repeat direct noninteractive smoke in this turn
  hung and was terminated, so this snapshot only refreshes Claude config health.
- Cursor global MCP config at `~/.cursor/mcp.json` includes an `orgx` server
  pointing at `mcp.useorgx.com`. The repo-local OrgX Cursor overlay includes
  `.cursor/orgx/manifest.json`, `.cursor/rules/orgx-execution-loop.mdc`, and
  OrgX command prompts for start/resume/morning-brief/proof/decision review.
  PR #1732 (`https://github.com/hopeatina/orgx/pull/1732`) merged
  `OrgX: Morning Brief`, which instructs Cursor to call
  `get_operator_chronicle` first and only use `orgx_recommend` with
  `mode="morning_brief"` as a fallback. Verification included manifest
  validation, `tests/api.client-bootstrap.route.spec.ts`, commit-hook
  typecheck/lint-budget, pre-push `benchmark:prove`, provider-auth checks, and
  successful Vercel deployment `dpl_22askxJ46TmZR3jNhCLk6zow3YLV`.
  Cursor auth durability is still not closed: the new diagnostic verified the
  redacted Cursor config shape contains `orgx` at `mcp.useorgx.com`, but
  `cursor-agent status` reports `Not logged in`, `cursor-agent mcp list` sees no
  configured servers, and `cursor-agent mcp list-tools orgx` fails with
  `Client ID mismatch`.
- ChatGPT server/submission metadata is aligned with the direct chronicle tool,
  but action-list proof is not complete. Current live UI verification is blocked
  by client access rather than MCP metadata: Chrome is logged out, the native
  ChatGPT app cannot be inspected from Codex, and Arc is logged into ChatGPT but
  is unsafe for automation until an unrelated LinkedIn company-page edit modal
  is cleared without saving.
- OrgX app accepted-goal writer/linking is now shipped. PR #1728
  (`https://github.com/hopeatina/orgx/pull/1728`) merged at
  `736fe928b7d1fcd9e27ac1468f624c65f6f11549` after focused tests,
  typecheck, diff check, pre-push benchmark proof, and a successful Vercel
  preview deployment (`dpl_FdJVknvHRgqkdD7PioaWQ5BLeLy1`). The change wires
  approved objective edits into existing `goals`, `user_goals`, and
  `objective_id` infrastructure so accepted goal decisions can become
  reportable first-class goal links.

## Next Fixes

1. Codex: capture a refreshed plugin session where `get_operator_chronicle` is
   directly callable, or file the client/plugin schema-refresh gap with exact
   bootstrap/tool-list evidence.
2. ChatGPT: refresh the app tool scan and verify `get_operator_chronicle` in the
   action list before claiming the ChatGPT app has first-class chronicle UX.
3. Cursor: reconcile the CLI summary-list inconsistency and make OAuth/session
   persistence durable enough that `list-tools orgx` does not require repeated
   manual login.
4. Claude Code: monitor Stop/SessionEnd hook reliability after direct MCP calls;
   direct `get_operator_chronicle` is now proven, but one successful
   `claude mcp get orgx` check emitted a cancelled `SessionEnd` hook warning.
