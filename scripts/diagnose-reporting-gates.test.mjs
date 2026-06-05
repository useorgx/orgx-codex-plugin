import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyClaudeMcpGet,
  classifyCursorList,
  classifyCursorListTools,
  classifyCursorStatus,
  inspectCursorConfig,
  main,
  stripAnsi,
  summarizeGates,
} from "./diagnose-reporting-gates.mjs";

const REQUIRED_TOOL_FIXTURE = [
  { name: "get_operator_chronicle" },
  { name: "orgx_recommend" },
];

test("stripAnsi removes terminal control codes", () => {
  assert.equal(stripAnsi("\u001b[2K\u001b[1AStatus: Connected\r\n"), "Status: Connected");
});

test("classifies Cursor list and list-tools failures without secrets", () => {
  const authGate = classifyCursorStatus({ text: "Not logged in" });
  assert.equal(authGate.status, "open");
  assert.match(authGate.evidence, /Not logged in/);

  const listGate = classifyCursorList({
    text: "No MCP servers configured (expected in local and user config)",
  });
  assert.equal(listGate.status, "open");
  assert.match(listGate.evidence, /no configured servers/i);

  const toolsGate = classifyCursorListTools({ text: "Failed to list tools: Client ID mismatch" });
  assert.equal(toolsGate.status, "open");
  assert.match(toolsGate.evidence, /Client ID mismatch/);
});

test("inspects Cursor config shape without raw values", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "orgx-cursor-config-"));
  mkdirSync(join(homeDir, ".cursor"), { recursive: true });
  writeFileSync(
    join(homeDir, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        orgx: {
          url: "https://mcp.useorgx.com/mcp",
          token: "do-not-print",
        },
      },
    }),
    "utf8"
  );

  const gate = inspectCursorConfig({ homeDir, cwd: homeDir });
  assert.equal(gate.status, "verified");
  assert.match(gate.evidence, /orgx_url_host=mcp.useorgx.com/);
  assert.doesNotMatch(gate.evidence, /do-not-print/);
  assert.doesNotMatch(gate.evidence, /https:\/\/mcp\.useorgx\.com\/mcp/);
});

test("classifies direct client visibility", () => {
  assert.equal(
    classifyCursorListTools({ text: "get_operator_chronicle\norgx_recommend" }).status,
    "verified"
  );
  assert.equal(classifyClaudeMcpGet({ text: "Status: Connected" }).status, "verified");
});

test("summarizeGates surfaces needs-you state", () => {
  const summary = summarizeGates([
    { id: "a", status: "verified" },
    { id: "b", status: "open" },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.attentionState, "needs_you");
  assert.deepEqual(summary.openGateIds, ["b"]);
});

test("main emits redacted reporting diagnostics", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "orgx-reporting-gates-"));
  mkdirSync(join(homeDir, ".codex"), { recursive: true });
  mkdirSync(join(homeDir, ".config", "useorgx", "wizard", "hooks", "reports"), {
    recursive: true,
  });
  writeFileSync(
    join(homeDir, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: {
        Stop: [
          { command: "node orgx-session-hook.mjs" },
          { command: "node orgx-reconcile-hook.mjs" },
        ],
      },
    }),
    "utf8"
  );
  writeFileSync(
    join(homeDir, ".config", "useorgx", "wizard", "hooks", "reports", "latest-work-graph-report.json"),
    JSON.stringify({
      work_graph_fingerprint: "wgf_abc123",
      report: { raw_transcripts_sent: false },
    }),
    "utf8"
  );

  const calls = [];
  const report = await main({
    argv: [],
    homeDir,
    writeOutput: false,
    now: () => new Date("2026-06-05T15:45:00.000Z"),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tools: REQUIRED_TOOL_FIXTURE }),
    }),
    execFileImpl: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args.join(" ") === "mcp list") {
        return { stdout: "No MCP servers configured", stderr: "" };
      }
      if (args.join(" ") === "mcp list-tools orgx") {
        const error = new Error("Failed to list tools");
        error.stdout = "";
        error.stderr = "Failed to list tools: Client ID mismatch";
        error.code = 1;
        throw error;
      }
      if (args.join(" ") === "status") {
        return { stdout: "Not logged in", stderr: "" };
      }
      return { stdout: "Status: Connected", stderr: "" };
    },
  });

  assert.equal(report.summary.attentionState, "needs_you");
  assert.ok(report.summary.openGateIds.includes("cursor_agent_auth"));
  assert.ok(report.summary.openGateIds.includes("cursor_mcp_list"));
  assert.ok(report.summary.openGateIds.includes("cursor_list_tools_orgx"));
  assert.deepEqual(calls, [
    "cursor-agent status",
    "cursor-agent mcp list",
    "cursor-agent mcp list-tools orgx",
    "claude mcp get orgx",
  ]);
});
