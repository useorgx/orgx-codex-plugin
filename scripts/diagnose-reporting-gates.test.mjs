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
  inspectClientHookSurfaceContract,
  inspectCodexHooks,
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

test("inspects client hook surface contract", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "orgx-hook-surfaces-"));
  const gatesPath = join(homeDir, "operator-reporting-gates.json");
  writeFileSync(
    gatesPath,
    JSON.stringify({
      clientHookSurfaces: ["codex", "chatgpt", "claude-code", "cursor"].map(
        (client) => ({
          client,
          bestAvailableSurface: "MCP tools",
          directReadoutPath: "get_operator_chronicle",
          fallbackPath: "orgx_recommend mode=\"morning_brief\"",
          passiveHookSupport:
            client === "chatgpt" || client === "cursor"
              ? "none in this package"
              : "Stop hook",
          nativeHookCoverageStatus: "documented",
          sufficiency: "partial",
          currentGap: "runtime proof required",
        })
      ),
    }),
    "utf8"
  );

  const gate = inspectClientHookSurfaceContract({ gatesPath });
  assert.equal(gate.status, "verified");
  assert.match(gate.evidence, /codex/);
  assert.match(gate.evidence, /missing=none/);
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
  assert.deepEqual(summary.recommendedActions, []);
});

test("summarizeGates gives Cursor recovery sequence", () => {
  const summary = summarizeGates([
    { id: "cursor_agent_auth", status: "open" },
    { id: "cursor_mcp_list", status: "open" },
    { id: "cursor_list_tools_orgx", status: "open" },
  ]);
  assert.deepEqual(summary.openGateIds, [
    "cursor_agent_auth",
    "cursor_mcp_list",
    "cursor_list_tools_orgx",
  ]);
  assert.equal(summary.recommendedActions.length, 3);
  assert.match(summary.recommendedActions[0].action, /cursor-agent login/);
  assert.match(summary.recommendedActions[2].action, /get_operator_chronicle/);
});

test("Codex hook diagnostics reject legacy bare command entries", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "orgx-legacy-codex-hooks-"));
  mkdirSync(join(homeDir, ".codex"), { recursive: true });
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

  const result = inspectCodexHooks({ homeDir });
  assert.equal(result.status, "open");
  assert.match(result.evidence, /canonical=false/);
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
          {
            matcher: "",
            hooks: [
              { type: "command", command: "node orgx-session-hook.mjs" },
              { type: "command", command: "node orgx-reconcile-hook.mjs" },
            ],
          },
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
  const diagnosticEnv = {
    PATH: "/bin",
    ORGX_API_KEY: "oxk_must_not_reach_diagnostics",
    ORGX_GATEWAY_KEY: "oxk_legacy_must_not_reach_diagnostics",
  };
  const report = await main({
    argv: [],
    env: diagnosticEnv,
    homeDir,
    writeOutput: false,
    now: () => new Date("2026-06-05T15:45:00.000Z"),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tools: REQUIRED_TOOL_FIXTURE }),
    }),
    execFileImpl: async (command, args, options) => {
      assert.equal(options.env.ORGX_API_KEY, undefined);
      assert.equal(options.env.ORGX_GATEWAY_KEY, undefined);
      assert.equal(options.env.PATH, "/bin");
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
  assert.match(report.summary.recommendedActions[0].action, /browser authentication/);
  assert.deepEqual(calls, [
    "cursor-agent status",
    "cursor-agent mcp list",
    "cursor-agent mcp list-tools orgx",
    "claude mcp get orgx",
  ]);
});
