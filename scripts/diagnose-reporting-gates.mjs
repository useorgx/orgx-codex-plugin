#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_TIMEOUT_MS = 12_000;
const SERVER_JSON_URL = "https://mcp.useorgx.com/server.json";
const REQUIRED_CHRONICLE_TOOLS = ["get_operator_chronicle", "orgx_recommend"];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const raw = token.slice(2);
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex >= 0) {
      args[raw.slice(0, equalsIndex)] = raw.slice(equalsIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[raw] = next;
      index += 1;
    } else {
      args[raw] = "true";
    }
  }
  return args;
}

export function stripAnsi(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function compactOutput(stdout, stderr) {
  return stripAnsi(`${stdout ?? ""}\n${stderr ?? ""}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 2400);
}

function gate({ id, client, status, evidence, nextStep }) {
  return { id, client, status, evidence, nextStep };
}

function commandMissing(error) {
  return error?.code === "ENOENT" || /not found/i.test(String(error?.message ?? ""));
}

async function runCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, execFileImpl = execFile } = {}) {
  try {
    const result = await execFileImpl(command, args, {
      timeout: timeoutMs,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    });
    return {
      ok: true,
      code: 0,
      stdout: stripAnsi(result.stdout),
      stderr: stripAnsi(result.stderr),
      text: compactOutput(result.stdout, result.stderr),
    };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === "number" ? error.code : undefined,
      missing: commandMissing(error),
      timedOut: Boolean(error?.killed) || /timed out/i.test(String(error?.message ?? "")),
      stdout: stripAnsi(error?.stdout),
      stderr: stripAnsi(error?.stderr),
      text: compactOutput(error?.stdout, error?.stderr || error?.message),
    };
  }
}

export function classifyCursorList(result) {
  if (result.missing) {
    return gate({
      id: "cursor_mcp_list",
      client: "cursor",
      status: "unavailable",
      evidence: "cursor-agent was not found on PATH.",
      nextStep: "Install Cursor Agent before relying on Cursor reporting UX.",
    });
  }
  if (/No MCP servers configured/i.test(result.text)) {
    return gate({
      id: "cursor_mcp_list",
      client: "cursor",
      status: "open",
      evidence: "cursor-agent mcp list reports no configured servers.",
      nextStep: "Resolve why Cursor CLI does not see the expected MCP config.",
    });
  }
  if (/orgx/i.test(result.text)) {
    return gate({
      id: "cursor_mcp_list",
      client: "cursor",
      status: "verified",
      evidence: "cursor-agent mcp list includes orgx.",
      nextStep: "Keep the Cursor MCP list visible before checking tools.",
    });
  }
  return gate({
    id: "cursor_mcp_list",
    client: "cursor",
    status: "unknown",
    evidence: result.text || "cursor-agent mcp list returned no classifiable output.",
    nextStep: "Inspect Cursor MCP list output manually without printing secrets.",
  });
}

export function classifyCursorListTools(result) {
  if (result.missing) {
    return gate({
      id: "cursor_list_tools_orgx",
      client: "cursor",
      status: "unavailable",
      evidence: "cursor-agent was not found on PATH.",
      nextStep: "Install Cursor Agent before relying on Cursor reporting UX.",
    });
  }
  if (/Client ID mismatch/i.test(result.text)) {
    return gate({
      id: "cursor_list_tools_orgx",
      client: "cursor",
      status: "open",
      evidence: "cursor-agent mcp list-tools orgx fails with Client ID mismatch.",
      nextStep: "Refresh Cursor OAuth/session binding for orgx; durable reporting is not proven while this repeats.",
    });
  }
  if (/login|oauth|auth/i.test(result.text) && !/get_operator_chronicle/i.test(result.text)) {
    return gate({
      id: "cursor_list_tools_orgx",
      client: "cursor",
      status: "open",
      evidence: "cursor-agent mcp list-tools orgx requires authentication.",
      nextStep: "Run Cursor MCP login and verify repeated list-tools calls work without another login.",
    });
  }
  if (/get_operator_chronicle/i.test(result.text)) {
    return gate({
      id: "cursor_list_tools_orgx",
      client: "cursor",
      status: "verified",
      evidence: "cursor-agent mcp list-tools orgx includes get_operator_chronicle.",
      nextStep: "Repeat after a fresh Cursor session to prove auth durability.",
    });
  }
  return gate({
    id: "cursor_list_tools_orgx",
    client: "cursor",
    status: "unknown",
    evidence: result.text || "cursor-agent mcp list-tools orgx returned no classifiable output.",
    nextStep: "Inspect Cursor list-tools output manually without printing secrets.",
  });
}

export function classifyClaudeMcpGet(result) {
  if (result.missing) {
    return gate({
      id: "claude_mcp_get_orgx",
      client: "claude-code",
      status: "unavailable",
      evidence: "claude CLI was not found on PATH.",
      nextStep: "Install Claude Code before relying on Claude reporting UX.",
    });
  }
  if (/Status:\s*✓?\s*Connected/i.test(result.text) || /Connected/i.test(result.text)) {
    return gate({
      id: "claude_mcp_get_orgx",
      client: "claude-code",
      status: "verified",
      evidence: "claude mcp get orgx reports Connected.",
      nextStep: "Run a bounded direct get_operator_chronicle smoke when needed.",
    });
  }
  return gate({
    id: "claude_mcp_get_orgx",
    client: "claude-code",
    status: "open",
    evidence: result.text || "claude mcp get orgx returned no classifiable output.",
    nextStep: "Reconnect the Claude orgx MCP server and watch hook warnings.",
  });
}

async function inspectHostedMcp({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(SERVER_JSON_URL);
    const body = await response.text();
    const hasRequiredTools = REQUIRED_CHRONICLE_TOOLS.every((tool) => body.includes(tool));
    return gate({
      id: "hosted_mcp_descriptor",
      client: "server",
      status: response.ok && hasRequiredTools ? "verified" : "open",
      evidence: `server.json status=${response.status}; required chronicle tools present=${hasRequiredTools}`,
      nextStep: hasRequiredTools
        ? "Keep hosted MCP descriptors aligned with chronicle tooling."
        : "Update hosted MCP descriptor so get_operator_chronicle and orgx_recommend are discoverable.",
    });
  } catch (error) {
    return gate({
      id: "hosted_mcp_descriptor",
      client: "server",
      status: "open",
      evidence: `server.json fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      nextStep: "Verify network access and hosted MCP descriptor health.",
    });
  }
}

function inspectCodexHooks({ homeDir = homedir() } = {}) {
  const hooksPath = join(homeDir, ".codex", "hooks.json");
  if (!existsSync(hooksPath)) {
    return gate({
      id: "codex_stop_reconciliation",
      client: "codex",
      status: "open",
      evidence: "~/.codex/hooks.json is missing.",
      nextStep: "Install the Codex hook template before treating passive reconciliation as covered.",
    });
  }
  const text = readFileSync(hooksPath, "utf8");
  const hasSessionHook = text.includes("orgx-session-hook.mjs");
  const hasReconcileHook = text.includes("orgx-reconcile-hook.mjs");
  return gate({
    id: "codex_stop_reconciliation",
    client: "codex",
    status: hasSessionHook && hasReconcileHook ? "verified" : "open",
    evidence: `~/.codex/hooks.json has session hook=${hasSessionHook}; reconcile hook=${hasReconcileHook}`,
    nextStep:
      hasSessionHook && hasReconcileHook
        ? "Keep passive reconciliation as a backstop, not the live report UX."
        : "Install both OrgX Codex session and Stop reconciliation hooks.",
  });
}

function inspectWorkGraphReport({ homeDir = homedir() } = {}) {
  const reportPath = join(
    homeDir,
    ".config",
    "useorgx",
    "wizard",
    "hooks",
    "reports",
    "latest-work-graph-report.json"
  );
  if (!existsSync(reportPath)) {
    return gate({
      id: "local_work_graph_report",
      client: "local-hooks",
      status: "open",
      evidence: "latest-work-graph-report.json is missing.",
      nextStep: "Run a Stop reconciliation hook or orgx-codex-reconcile-hooks to create a local summary report.",
    });
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const rawTranscriptsSent = report?.report?.raw_transcripts_sent ?? report?.raw_transcripts_sent;
  const fingerprint = report?.work_graph_fingerprint ?? report?.report?.work_graph_fingerprint;
  return gate({
    id: "local_work_graph_report",
    client: "local-hooks",
    status: rawTranscriptsSent === false && Boolean(fingerprint) ? "verified" : "open",
    evidence: `latest report raw_transcripts_sent=${rawTranscriptsSent}; work_graph_fingerprint=${Boolean(fingerprint)}`,
    nextStep:
      rawTranscriptsSent === false && fingerprint
        ? "Keep the local report summary-only and use MCP readout for live reporting."
        : "Regenerate the local Work Graph report with summary-only redaction.",
  });
}

export function summarizeGates(gates) {
  const open = gates.filter((item) => ["open", "blocked_by_client_access", "unknown"].includes(item.status));
  return {
    ok: open.length === 0,
    attentionState: open.length > 0 ? "needs_you" : "verified",
    headline:
      open.length > 0
        ? `${open.length} reporting gate${open.length === 1 ? "" : "s"} need attention`
        : "Operator reporting gates are locally verified",
    openGateIds: open.map((item) => item.id),
  };
}

export async function main({
  argv = process.argv.slice(2),
  fetchImpl = fetch,
  execFileImpl = execFile,
  homeDir = homedir(),
  now = () => new Date(),
  writeOutput = true,
} = {}) {
  const args = parseArgs(argv);
  const timeoutMs = Number.parseInt(args.timeout_ms ?? args["timeout-ms"] ?? "", 10) || DEFAULT_TIMEOUT_MS;
  const gates = [];

  gates.push(await inspectHostedMcp({ fetchImpl }));
  gates.push(inspectCodexHooks({ homeDir }));
  gates.push(inspectWorkGraphReport({ homeDir }));

  const cursorList = await runCommand("cursor-agent", ["mcp", "list"], { timeoutMs, execFileImpl });
  gates.push(classifyCursorList(cursorList));
  const cursorTools = await runCommand("cursor-agent", ["mcp", "list-tools", "orgx"], {
    timeoutMs,
    execFileImpl,
  });
  gates.push(classifyCursorListTools(cursorTools));

  const claudeGet = await runCommand("claude", ["mcp", "get", "orgx"], { timeoutMs, execFileImpl });
  gates.push(classifyClaudeMcpGet(claudeGet));

  const report = {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    source: "orgx_codex_plugin_reporting_gate_diagnostics",
    summary: summarizeGates(gates),
    gates,
  };

  if (writeOutput && args.json !== "false") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (writeOutput) {
    process.stdout.write(`${report.summary.headline}\n`);
    for (const item of gates) {
      process.stdout.write(`- ${item.status} ${item.client}/${item.id}: ${item.evidence}\n`);
    }
  }

  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
