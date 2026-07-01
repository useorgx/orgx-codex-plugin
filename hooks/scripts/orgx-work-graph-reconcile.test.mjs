import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWorkGraphReport,
  discoverTranscriptFiles,
  loadHookOutboxRecords,
  main,
  normalizeHookRecord,
  normalizeSourceClient,
  parseArgs,
  scanTranscriptSignals,
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
    }),
  );

  assert.equal(normalized.source_client, "claude-code");
  assert.equal(normalized.session_id, "session-1");
  assert.equal(normalized.summary.tool_name, "Read");
  assert.deepEqual(normalized.summary.payload_keys, [
    "prompt",
    "token",
    "extra",
  ]);
  assert.equal(Object.hasOwn(normalized, "prompt"), false);
});

test("loadHookOutboxRecords reads jsonl and skips malformed lines", async () => {
  const outbox = join(
    mkdtempSync(join(tmpdir(), "orgx-reconcile-")),
    "events.jsonl",
  );
  writeFileSync(
    outbox,
    `${JSON.stringify(hookRecord())}\nnot json\n${JSON.stringify(
      hookRecord({ source_client: "openclaw", session_id: "session-2" }),
    )}\n`,
    "utf8",
  );

  const loaded = await loadHookOutboxRecords(outbox);
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.skipped, 1);
  assert.equal(loaded.missing, false);
  assert.equal(loaded.records[1].source_client, "openclaw");
});

test("loadHookOutboxRecords compacts noisy outboxes without dropping quiet source clients", async () => {
  const outbox = join(
    mkdtempSync(join(tmpdir(), "orgx-reconcile-compact-")),
    "events.jsonl",
  );
  const lines = [
    hookRecord({
      source_client: "cursor",
      session_id: "cursor-session",
      timestamp: "2026-05-20T12:00:00.000Z",
    }),
    ...Array.from({ length: 10 }, (_, index) =>
      hookRecord({
        source_client: "claude-code",
        session_id: `claude-session-${index}`,
        timestamp: `2026-05-21T12:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    ),
  ];
  writeFileSync(
    outbox,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );

  const loaded = await loadHookOutboxRecords(outbox, {
    maxRecords: 5,
    since: "2026-05-01T00:00:00.000Z",
  });

  assert.equal(loaded.records.length, 5);
  assert.equal(loaded.matched, 11);
  assert.ok(loaded.records.some((record) => record.source_client === "cursor"));
  assert.ok(
    loaded.records.some((record) => record.source_client === "claude-code"),
  );
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
    { generatedAt: NOW, workspaceCwd: "/Users/example/Code/orgx" },
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
    { generatedAt: NOW, workspaceCwd: "/Users/example/Code/orgx" },
  );

  assert.match(reportA.work_graph_fingerprint, /^wgf_[0-9a-f]{24}$/);
  assert.equal(reportA.work_graph_fingerprint, reportB.work_graph_fingerprint);
  assert.equal(
    reportA.signup_hydration.hydration_key,
    `orgx:work-graph:${reportA.work_graph_fingerprint}`,
  );
  assert.equal(reportA.source_client, "wizard");
  assert.equal(reportA.raw_transcripts_sent, false);
  assert.equal(reportA.investigation.raw_transcripts_excluded, true);
  assert.equal(
    reportA.investigation.fingerprint,
    reportA.work_graph_fingerprint,
  );
  assert.equal(reportA.investigation.generated_at, NOW);
  assert.equal(typeof reportA.investigation.why_not_100[0], "object");
  assert.equal(reportA.events[0].event_type, "tool_signal");
  assert.equal(reportA.source_coverage.orgxMcpCalled, false);
  assert.equal(reportA.final_state, "completed");
  assert.ok(reportA.findings.some((finding) => finding.type === "action"));
  assert.ok(
    reportA.missed_orchestration_opportunities.some(
      (finding) => finding.type === "missed_orchestration_opportunity",
    ),
  );
  assert.equal(reportA.attribution_spine.source_events.length, 2);
  assert.ok(
    reportA.attribution_spine.tools.some((tool) => tool.label === "Bash"),
  );
  assert.ok(
    reportA.attribution_spine.artifacts.some(
      (artifact) => artifact.id === "artifact:tool-use-trail",
    ),
  );
  assert.ok(
    reportA.attribution_spine.goals.some(
      (goal) => goal.id === "initiative:continuous-orgx-writeback",
    ),
  );
  assert.equal(
    reportA.attribution_spine.review.pending_count,
    new Set(reportA.attribution_spine.dedupe_keys).size,
  );
});

test("scanTranscriptSignals extracts summary-only decision, artifact, goal, and blocker signals", () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-transcript-scan-"));
  const sourceDir = join(dir, "codex");
  mkdirSync(sourceDir);
  const transcript = join(sourceDir, "session.jsonl");
  const rawDecision =
    "We decided to use Trigger.dev for operational runs and stop referencing Inngest as the active path.";
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        timestamp: NOW,
        type: "message",
        payload: {
          message: {
            content: rawDecision,
          },
        },
      }),
      JSON.stringify({
        timestamp: NOW,
        type: "message",
        payload: {
          message: {
            content:
              "The PR artifact was verified, but the top priority goal still has a blocker and missing production writeback.",
          },
        },
      }),
      JSON.stringify({
        timestamp: NOW,
        type: "session_meta",
        payload: {
          base_instructions:
            "This instruction text says decision artifact goal blocker but must be ignored.",
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const files = discoverTranscriptFiles({
    roots: [{ source_client: "codex", path: sourceDir }],
    since: "2026-05-01T00:00:00.000Z",
  });
  assert.equal(files.length, 1);

  const transcriptScan = scanTranscriptSignals({
    roots: [{ source_client: "codex", path: sourceDir }],
    since: "2026-05-01T00:00:00.000Z",
    maxFiles: 10,
    maxLinesPerFile: 20,
  });

  assert.equal(transcriptScan.scanned_files, 1);
  assert.equal(transcriptScan.raw_transcripts_included, false);
  assert.ok(transcriptScan.counts.decision >= 1);
  assert.ok(transcriptScan.counts.artifact >= 1);
  assert.ok(transcriptScan.counts.goal >= 1);
  assert.ok(transcriptScan.counts.blocker >= 1);

  const report = buildWorkGraphReport([hookRecord()], {
    generatedAt: NOW,
    workspaceCwd: "/Users/example/Code/orgx",
    transcriptScan,
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.fingerprint_basis.raw_transcripts_included, false);
  assert.equal(
    report.investigation.raw_events_summary.transcript_scan.scanned_files,
    1,
  );
  assert.ok(report.findings.some((finding) => finding.type === "decision"));
  assert.ok(report.findings.some((finding) => finding.type === "blocker"));
  assert.equal(serialized.includes(rawDecision), false);
  assert.equal(serialized.includes("base_instructions"), false);
  assert.equal(serialized.includes("Inngest as the active path"), false);
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
    { generatedAt: NOW, workspaceCwd: "/repo" },
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
    { generatedAt: NOW, workspaceCwd: "/repo" },
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
    argv: [
      "--outbox=" + outbox,
      "--output=" + output,
      "--cwd=/repo",
      "--transcript-scan=false",
    ],
    env: {},
    now: () => new Date(NOW),
  });

  assert.equal(result.ok, true);
  assert.equal(result.records_read, 1);
  const written = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(written.work_graph_fingerprint, result.work_graph_fingerprint);
  assert.equal(written.transcript_scan_enabled, false);
  assert.equal(written.report.raw_transcripts_sent, false);
});
