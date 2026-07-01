import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyClaudeMcpGet,
  classifyCursorList,
  classifyCursorListTools,
  classifyCursorLoginProbe,
  classifyCursorStatus,
  inspectCodexReadoutProof,
  inspectClientHookSurfaceContract,
  inspectCursorConfig,
  inspectCursorIsolatedOrgxConfig,
  inspectOpenCodeConfig,
  inspectOpenCodeDirectReadout,
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

  const approvalGate = classifyCursorListTools({
    text: 'Failed to list tools: Failed to load MCP "orgx": MCP server "orgx" has not been approved',
  });
  assert.equal(approvalGate.status, "open");
  assert.match(approvalGate.evidence, /not been approved/);

  const resourceGate = classifyCursorListTools({
    text: "Authentication callback failed: Requested resource was not included in the authorization request",
  });
  assert.equal(resourceGate.status, "open");
  assert.match(resourceGate.evidence, /resource validation/);
  assert.match(resourceGate.nextStep, /Deploy/);
});

test("classifies Cursor MCP login OAuth resource mismatch", () => {
  const gate = classifyCursorLoginProbe({
    text: "Authentication callback failed: Requested resource was not included in the authorization request",
  });

  assert.equal(gate.id, "cursor_mcp_login_probe");
  assert.equal(gate.status, "open");
  assert.match(gate.evidence, /OAuth callback/);
  assert.match(gate.nextStep, /canonicalization/);
});

test("classifies Cursor MCP login approval blocker", () => {
  const gate = classifyCursorLoginProbe({
    text: 'Failed to load MCP "orgx": MCP server "orgx" has not been approved',
  });

  assert.equal(gate.id, "cursor_mcp_login_probe");
  assert.equal(gate.status, "open");
  assert.match(gate.evidence, /not been approved/);
  assert.match(gate.nextStep, /Approve/);
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
      clientHookSurfaces: ["codex", "chatgpt", "claude-code", "cursor", "opencode"].map(
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

test("inspects OpenCode MCP config shape", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "orgx-opencode-config-"));
  mkdirSync(join(homeDir, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(homeDir, ".config", "opencode", "opencode.json"),
    JSON.stringify({
      mcp: {
        orgx: {
          enabled: true,
          type: "remote",
          url: "https://mcp.useorgx.com/mcp",
          token: "do-not-print",
        },
      },
    }),
    "utf8"
  );

  const gate = inspectOpenCodeConfig({ homeDir });
  assert.equal(gate.status, "verified");
  assert.match(gate.evidence, /orgx_present=true/);
  assert.match(gate.evidence, /orgx_type=remote/);
  assert.match(gate.evidence, /orgx_url_host=mcp.useorgx.com/);
  assert.doesNotMatch(gate.evidence, /do-not-print/);
  assert.doesNotMatch(gate.evidence, /https:\/\/mcp\.useorgx\.com\/mcp/);
});

test("inspects OpenCode direct readout without hiding existing local architecture", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "orgx-opencode-direct-"));
  mkdirSync(join(homeDir, ".superset", "bin"), { recursive: true });
  mkdirSync(join(homeDir, "Code", "opencode-ecosystem-orgx", "packages", "opencode"), {
    recursive: true,
  });
  mkdirSync(join(homeDir, "Code", "orgx-opencode-plugin-work-graph"), {
    recursive: true,
  });
  writeFileSync(join(homeDir, ".superset", "bin", "opencode"), "#!/bin/sh\n", "utf8");
  writeFileSync(
    join(homeDir, "Code", "opencode-ecosystem-orgx", "packages", "opencode", "package.json"),
    "{}",
    "utf8"
  );
  writeFileSync(
    join(homeDir, "Code", "orgx-opencode-plugin-work-graph", "package.json"),
    "{}",
    "utf8"
  );

  const gate = await inspectOpenCodeDirectReadout({
    homeDir,
    execFileImpl: async () => {
      const error = new Error("opencode missing");
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.equal(gate.status, "open");
  assert.equal(gate.id, "opencode_direct_readout");
  assert.match(gate.evidence, /superset_wrapper=true/);
  assert.match(gate.evidence, /source_checkout=true/);
  assert.match(gate.evidence, /orgx_peer_checkout=true/);
  assert.match(gate.nextStep, /Build\/install/);
});

test("verifies OpenCode direct readout when MCP tools expose OrgX chronicle path", async () => {
  const calls = [];
  const gate = await inspectOpenCodeDirectReadout({
    execFileImpl: async (_command, args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === "--version") {
        return { stdout: "1.16.2", stderr: "" };
      }
      return { stdout: "orgx_get_operator_chronicle\norgx_recommend", stderr: "" };
    },
  });

  assert.equal(gate.status, "verified");
  assert.deepEqual(calls, ["--version", "mcp list"]);
});

test("classifies runnable OpenCode with OrgX MCP auth pending", async () => {
  const gate = await inspectOpenCodeDirectReadout({
    execFileImpl: async (_command, args) => {
      if (args.join(" ") === "--version") {
        return { stdout: "1.16.2", stderr: "" };
      }
      return { stdout: "orgx needs authentication\nhttps://mcp.useorgx.com/mcp", stderr: "" };
    },
  });

  assert.equal(gate.status, "open");
  assert.match(gate.evidence, /opencode is runnable/);
  assert.match(gate.evidence, /needs authentication/);
  assert.match(gate.nextStep, /opencode mcp auth orgx/);
});


test("isolates Cursor config discovery from global MCP config", async () => {
  const calls = [];
  const gate = await inspectCursorIsolatedOrgxConfig({
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: "No MCP servers configured", stderr: "" };
    },
  });

  assert.equal(gate.status, "open");
  assert.equal(gate.id, "cursor_isolated_config_discovery");
  assert.match(gate.evidence, /isolated OrgX-only workspace config/);
  assert.doesNotMatch(gate.evidence, /\/tmp|orgx-cursor-isolated/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "cursor-agent");
  assert.deepEqual(calls[0].args, ["mcp", "list"]);
  assert.ok(calls[0].cwd);
});

test("verifies isolated Cursor config discovery when orgx is listed", async () => {
  const gate = await inspectCursorIsolatedOrgxConfig({
    execFileImpl: async () => ({
      stdout: "orgx: not loaded (needs approval)",
      stderr: "",
    }),
  });

  assert.equal(gate.status, "verified");
  assert.match(gate.nextStep, /OAuth/);
});

test("classifies direct client visibility", () => {
  assert.equal(
    classifyCursorListTools({ text: "get_operator_chronicle\norgx_recommend" }).status,
    "verified"
  );
  assert.equal(classifyClaudeMcpGet({ text: "Status: Connected" }).status, "verified");
});

test("verifies Codex direct readout from a bounded receipt", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "orgx-codex-readout-proof-"));
  const proofPath = join(homeDir, "latest-codex-readout-proof.json");
  writeFileSync(
    proofPath,
    JSON.stringify({
      schemaVersion: 1,
      client: "codex",
      route: "direct_mcp_readout",
      tool: "get_operator_chronicle",
      workspaceId: "7af01a51-49b1-47d8-98b9-91a198debca8",
      period: "30d",
      visibleTools: ["get_operator_chronicle", "orgx_recommend"],
      fieldPresence: {
        "reportingNarrative.briefMarkdown": true,
        decisionChronology: true,
        artifactLedger: true,
        prVelocity: true,
        initiatives: true,
        goals: true,
        dataGaps: true,
        topPriorities: true,
      },
      counts: {
        decisionChronology: 12,
        artifactLedger: 12,
        topPriorities: 6,
      },
    }),
    "utf8"
  );

  const gates = inspectCodexReadoutProof({ homeDir, proofPath });
  assert.deepEqual(
    gates.map((gate) => [gate.id, gate.status]),
    [
      ["codex_direct_tool_exposure", "verified"],
      ["codex_morning_brief_fallback", "verified"],
    ]
  );
  assert.match(gates[0].evidence, /decisions=12/);
  assert.match(gates[0].evidence, /missingFields=none/);
  assert.doesNotMatch(gates[0].evidence, /artifactLedger.+Dogfood Proof/);
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

test("summarizeGates distinguishes authenticated Cursor MCP loader failures", () => {
  const summary = summarizeGates([
    { id: "cursor_config_shape", status: "verified" },
    { id: "cursor_isolated_config_discovery", status: "open" },
    { id: "cursor_agent_auth", status: "verified" },
    { id: "cursor_mcp_list", status: "open" },
    {
      id: "cursor_list_tools_orgx",
      status: "open",
      evidence: "cursor-agent mcp list-tools orgx fails with Client ID mismatch.",
    },
  ]);

  assert.equal(summary.recommendedActions.length, 3);
  assert.match(summary.recommendedActions[0].action, /isolated/);
  assert.match(summary.recommendedActions[1].action, /authenticated/);
  assert.match(summary.recommendedActions[1].action, /MCP config loader/);
  assert.match(summary.recommendedActions[2].action, /Client ID mismatch/);
  assert.doesNotMatch(summary.recommendedActions[1].action, /login/);
});

test("summarizeGates treats Cursor approval as the current post-discovery blocker", () => {
  const summary = summarizeGates([
    { id: "cursor_config_shape", status: "verified" },
    { id: "cursor_isolated_config_discovery", status: "verified" },
    { id: "cursor_agent_auth", status: "verified" },
    { id: "cursor_mcp_list", status: "verified" },
    {
      id: "cursor_list_tools_orgx",
      status: "open",
      evidence: 'Failed to load MCP "orgx": MCP server "orgx" has not been approved.',
    },
  ]);

  assert.deepEqual(summary.openGateIds, ["cursor_list_tools_orgx"]);
  assert.equal(summary.recommendedActions.length, 1);
  assert.match(summary.recommendedActions[0].action, /Approve\/authenticate/);
  assert.doesNotMatch(summary.recommendedActions[0].action, /Client ID mismatch/);
});

test("summarizeGates surfaces Cursor OAuth resource deployment blocker", () => {
  const summary = summarizeGates([
    { id: "cursor_config_shape", status: "verified" },
    { id: "cursor_isolated_config_discovery", status: "verified" },
    { id: "cursor_agent_auth", status: "verified" },
    { id: "cursor_mcp_list", status: "verified" },
    {
      id: "cursor_list_tools_orgx",
      status: "open",
      evidence:
        "cursor-agent mcp list-tools orgx failed OAuth resource validation: Requested resource was not included in the authorization request.",
    },
    {
      id: "cursor_mcp_login_probe",
      status: "open",
      evidence:
        "cursor-agent mcp login orgx reaches the OAuth callback but fails resource validation: Requested resource was not included in the authorization request.",
    },
  ]);

  assert.deepEqual(summary.openGateIds, [
    "cursor_list_tools_orgx",
    "cursor_mcp_login_probe",
  ]);
  assert.equal(summary.recommendedActions.length, 2);
  assert.match(summary.recommendedActions[0].action, /Deploy/);
  assert.match(summary.recommendedActions[1].action, /hosted OAuth resource mismatch/);
});

test("main can optionally probe Cursor MCP login", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "orgx-reporting-gates-login-"));
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
    argv: ["--probe-cursor-login=true"],
    homeDir,
    writeOutput: false,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tools: REQUIRED_TOOL_FIXTURE }),
    }),
    execFileImpl: async (_command, args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === "mcp login orgx") {
        const error = new Error("MCP login failed");
        error.stderr =
          "Authentication callback failed: Requested resource was not included in the authorization request";
        error.code = 1;
        throw error;
      }
      if (args.join(" ") === "mcp list-tools orgx") {
        const error = new Error("Failed to list tools");
        error.stderr = "MCP 'orgx' requires authentication.";
        error.code = 1;
        throw error;
      }
      if (args.join(" ") === "mcp list") return { stdout: "orgx", stderr: "" };
      if (args.join(" ") === "status") return { stdout: "Logged in", stderr: "" };
      if (args.join(" ") === "--version") return { stdout: "1.16.2", stderr: "" };
      return { stdout: "Status: Connected", stderr: "" };
    },
  });

  assert.ok(report.summary.openGateIds.includes("cursor_mcp_login_probe"));
  assert.match(
    report.summary.recommendedActions.find(
      (action) => action.gate === "cursor_mcp_login_probe"
    )?.action,
    /hosted OAuth resource mismatch/
  );
  assert.ok(calls.includes("mcp login orgx"));
});

test("summarizeGates surfaces OpenCode installation work when direct readout is missing", () => {
  const summary = summarizeGates([
    { id: "opencode_mcp_config", status: "verified" },
    {
      id: "opencode_direct_readout",
      status: "open",
      evidence: "OpenCode direct readout unavailable: opencode command is not backed by a runnable CLI.",
    },
  ]);

  assert.deepEqual(summary.openGateIds, ["opencode_direct_readout"]);
  assert.equal(summary.recommendedActions.length, 1);
  assert.match(summary.recommendedActions[0].action, /OpenCode checkout/);
});

test("summarizeGates surfaces OpenCode auth work when CLI is runnable", () => {
  const summary = summarizeGates([
    { id: "opencode_mcp_config", status: "verified" },
    {
      id: "opencode_direct_readout",
      status: "open",
      evidence: "opencode is runnable and sees the OrgX MCP server, but OrgX MCP needs authentication.",
    },
  ]);

  assert.deepEqual(summary.openGateIds, ["opencode_direct_readout"]);
  assert.equal(summary.recommendedActions.length, 1);
  assert.match(summary.recommendedActions[0].action, /opencode mcp auth orgx/);
  assert.doesNotMatch(summary.recommendedActions[0].action, /Build\/install/);
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
  assert.ok(report.summary.openGateIds.includes("cursor_isolated_config_discovery"));
  assert.ok(report.summary.openGateIds.includes("cursor_mcp_list"));
  assert.ok(report.summary.openGateIds.includes("cursor_list_tools_orgx"));
  assert.ok(report.summary.openGateIds.includes("opencode_direct_readout"));
  assert.match(report.summary.recommendedActions[0].action, /browser authentication/);
  const latestPath = join(
    homeDir,
    ".config",
    "useorgx",
    "wizard",
    "hooks",
    "reports",
    "latest-reporting-gates-diagnostic.json"
  );
  assert.equal(existsSync(latestPath), true);
  const latest = JSON.parse(readFileSync(latestPath, "utf8"));
  assert.equal(latest.source, "orgx_codex_plugin_reporting_gate_diagnostics");
  assert.deepEqual(latest.summary.openGateIds, report.summary.openGateIds);
  assert.deepEqual(calls, [
    "opencode --version",
    "opencode mcp list",
    "cursor-agent mcp list",
    "cursor-agent status",
    "cursor-agent mcp list",
    "cursor-agent mcp list-tools orgx",
    "claude mcp get orgx",
  ]);
});
