import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWorkGraphReport,
  loadHookOutboxRecords,
  main,
  normalizeHookRecord,
  normalizeSourceClient,
  parseArgs,
} from "./orgx-work-graph-reconcile.mjs";

const NOW = "2026-05-07T12:00:00.000Z";

function hookRecord(overrides = {}) {
  return {
    schema_version: "2026-05-07",
    source: "orgx_codex_plugin_runtime_hook",
    source_client: "codex",
    event: "PostToolUse",
    session_id: "session-1",
    turn_id: "turn-1",
    cwd: "/Users/example/Code/orgx",
    timestamp: NOW,
    summary: {
      tool_name: "apply_patch",
      prompt_chars: 42,
      payload_keys: ["tool_name", "cwd"],
    },
    ...overrides,
  };
}

test("normalizeSourceClient maps supported plugin aliases", () => {
  assert.equal(normalizeSourceClient("claude_code"), "claude-code");
  assert.equal(normalizeSourceClient("open-claw"), "openclaw");
  assert.equal(normalizeSourceClient("not-a-client"), "unknown");
});

test("parseArgs handles equals, split values, and booleans", () => {
  const args = parseArgs([
    "--outbox",
    "/tmp/events.jsonl",
    "--output=/tmp/report.json",
    "--post",
  ]);
  assert.equal(args.outbox, "/tmp/events.jsonl");
  assert.equal(args.output, "/tmp/report.json");
  assert.equal(args.post, "true");
});

test("normalizeHookRecord keeps compact lifecycle evidence only", () => {
  const normalized = normalizeHookRecord(
    hookRecord({
      source_client: "claude_code",
      summary: {
        tool_name: "Read",
        prompt_chars: 12,
        payload_keys: ["prompt", "token", "extra"],
      },
    })
  );

  assert.equal(normalized.source_client, "claude-code");
  assert.equal(normalized.session_id, "session-1");
  assert.equal(normalized.summary.tool_name, "Read");
  assert.deepEqual(normalized.summary.payload_keys, ["prompt", "token", "extra"]);
  assert.equal(Object.hasOwn(normalized, "prompt"), false);
});

test("loadHookOutboxRecords reads jsonl and skips malformed lines", async () => {
  const outbox = join(mkdtempSync(join(tmpdir(), "orgx-reconcile-")), "events.jsonl");
  writeFileSync(
    outbox,
    `${JSON.stringify(hookRecord())}\nnot json\n${JSON.stringify(
      hookRecord({ source_client: "openclaw", session_id: "session-2" })
    )}\n`,
    "utf8"
  );

  const loaded = await loadHookOutboxRecords(outbox);
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.skipped, 1);
  assert.equal(loaded.missing, false);
  assert.equal(loaded.records[1].source_client, "openclaw");
});

test("buildWorkGraphReport emits stable summary-only hydration shape", () => {
  const reportA = buildWorkGraphReport(
    [
      hookRecord(),
      hookRecord({
        source_client: "claude-code",
        session_id: "session-2",
        event: "Stop",
        summary: { tool_name: "Bash", payload_keys: ["tool_name"] },
      }),
    ],
    { generatedAt: NOW, workspaceCwd: "/Users/example/Code/orgx" }
  );
  const reportB = buildWorkGraphReport(
    [
      hookRecord({
        source_client: "claude-code",
        session_id: "session-2",
        event: "Stop",
        summary: { tool_name: "Bash", payload_keys: ["tool_name"] },
      }),
      hookRecord(),
    ],
    { generatedAt: NOW, workspaceCwd: "/Users/example/Code/orgx" }
  );

  assert.match(reportA.work_graph_fingerprint, /^wgf_[0-9a-f]{24}$/);
  assert.equal(reportA.work_graph_fingerprint, reportB.work_graph_fingerprint);
  assert.equal(
    reportA.signup_hydration.hydration_key,
    `orgx:work-graph:${reportA.work_graph_fingerprint}`
  );
  assert.equal(reportA.source_client, "wizard");
  assert.equal(reportA.raw_transcripts_sent, false);
  assert.equal(reportA.investigation.raw_transcripts_excluded, true);
  assert.equal(reportA.investigation.fingerprint, reportA.work_graph_fingerprint);
  assert.equal(reportA.investigation.generated_at, NOW);
  assert.equal(typeof reportA.investigation.why_not_100[0], "object");
  assert.equal(reportA.events[0].event_type, "tool_signal");
  assert.equal(reportA.source_coverage.orgxMcpCalled, false);
  assert.equal(reportA.final_state, "completed");
  assert.ok(reportA.findings.some((finding) => finding.type === "action"));
  assert.ok(
    reportA.missed_orchestration_opportunities.some(
      (finding) => finding.type === "missed_orchestration_opportunity"
    )
  );
  assert.equal(reportA.attribution_spine.source_events.length, 2);
  assert.ok(reportA.attribution_spine.tools.some((tool) => tool.label === "Bash"));
});

test("buildWorkGraphReport detects OrgX MCP tool signal", () => {
  const report = buildWorkGraphReport(
    [
      hookRecord({
        summary: {
          tool_name: "mcp__orgx__entity_action",
          payload_keys: ["tool_name"],
        },
      }),
    ],
    { generatedAt: NOW, workspaceCwd: "/repo" }
  );

  assert.equal(report.source_coverage.orgxMcpCalled, true);
  assert.deepEqual(report.missed_orchestration_opportunities, []);
  assert.deepEqual(report.source_coverage.missing, []);
});

test("buildWorkGraphReport does not treat unrelated MCP tools as OrgX writeback", () => {
  const report = buildWorkGraphReport(
    [
      hookRecord({
        summary: {
          tool_name: "mcp__github__create_issue",
          payload_keys: ["tool_name"],
        },
      }),
    ],
    { generatedAt: NOW, workspaceCwd: "/repo" }
  );

  assert.equal(report.source_coverage.mcpObserved, true);
  assert.equal(report.source_coverage.orgxObserved, true);
  assert.equal(report.source_coverage.orgxMcpCalled, false);
  assert.equal(report.missed_orchestration_opportunities.length, 1);
});

test("main writes a dry-run report file without OrgX credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-reconcile-main-"));
  const outbox = join(dir, "events.jsonl");
  const output = join(dir, "report.json");
  writeFileSync(outbox, `${JSON.stringify(hookRecord())}\n`, "utf8");

  const result = await main({
    argv: ["--outbox=" + outbox, "--output=" + output, "--cwd=/repo"],
    env: {},
    now: () => new Date(NOW),
  });

  assert.equal(result.ok, true);
  assert.equal(result.records_read, 1);
  const written = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(written.work_graph_fingerprint, result.work_graph_fingerprint);
  assert.equal(written.report.raw_transcripts_sent, false);
});
