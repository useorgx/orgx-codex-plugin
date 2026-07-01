#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_TIMEOUT_MS = 12_000;
const SERVER_JSON_URL = "https://mcp.useorgx.com/server.json";
const REQUIRED_CHRONICLE_TOOLS = ["get_operator_chronicle", "orgx_recommend"];
const OPERATOR_REPORTING_GATES_PATH = fileURLToPath(
  new URL("../docs/operator-reporting-gates.json", import.meta.url)
);
function defaultLatestDiagnosticPath(homeDir = homedir()) {
  return join(
    homeDir,
    ".config",
    "useorgx",
    "wizard",
    "hooks",
    "reports",
    "latest-reporting-gates-diagnostic.json"
  );
}
function defaultCodexReadoutProofPath(homeDir = homedir()) {
  return join(
    homeDir,
    ".config",
    "useorgx",
    "wizard",
    "hooks",
    "reports",
    "latest-codex-readout-proof.json"
  );
}

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

function readJsonIfPresent(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function commandMissing(error) {
  return error?.code === "ENOENT" || /not found/i.test(String(error?.message ?? ""));
}

async function runCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, execFileImpl = execFile, cwd } = {}) {
  try {
    const result = await execFileImpl(command, args, {
      timeout: timeoutMs,
      cwd,
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

export async function inspectCursorIsolatedOrgxConfig({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  execFileImpl = execFile,
} = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), "orgx-cursor-isolated-"));
  try {
    mkdirSync(join(tempRoot, ".cursor"), { recursive: true });
    writeFileSync(
      join(tempRoot, ".cursor", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            orgx: {
              type: "http",
              url: "https://mcp.useorgx.com/mcp",
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await runCommand("cursor-agent", ["mcp", "list"], {
      timeoutMs,
      execFileImpl,
      cwd: tempRoot,
    });

    if (result.missing) {
      return gate({
        id: "cursor_isolated_config_discovery",
        client: "cursor",
        status: "unavailable",
        evidence: "cursor-agent was not found on PATH.",
        nextStep: "Install Cursor Agent before relying on Cursor reporting UX.",
      });
    }
    if (/orgx/i.test(result.text)) {
      return gate({
        id: "cursor_isolated_config_discovery",
        client: "cursor",
        status: "verified",
        evidence: "cursor-agent mcp list discovers an isolated OrgX-only workspace config.",
        nextStep: "Focus remaining Cursor failures on OAuth/session binding instead of config discovery.",
      });
    }
    if (/No MCP servers configured/i.test(result.text)) {
      return gate({
        id: "cursor_isolated_config_discovery",
        client: "cursor",
        status: "open",
        evidence: "cursor-agent mcp list does not discover an isolated OrgX-only workspace config.",
        nextStep:
          "Treat Cursor Agent MCP discovery as broken for this CLI version; verify through Cursor IDE or update Cursor Agent before relying on CLI reporting.",
      });
    }
    return gate({
      id: "cursor_isolated_config_discovery",
      client: "cursor",
      status: "unknown",
      evidence: result.text || "cursor-agent mcp list returned no classifiable output for isolated OrgX config.",
      nextStep: "Inspect Cursor Agent MCP config discovery manually without printing secrets.",
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
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

export function classifyCursorStatus(result) {
  if (result.missing) {
    return gate({
      id: "cursor_agent_auth",
      client: "cursor",
      status: "unavailable",
      evidence: "cursor-agent was not found on PATH.",
      nextStep: "Install Cursor Agent before relying on Cursor reporting UX.",
    });
  }
  if (/Not logged in/i.test(result.text)) {
    return gate({
      id: "cursor_agent_auth",
      client: "cursor",
      status: "open",
      evidence: "cursor-agent status reports Not logged in.",
      nextStep: "Run cursor-agent login before expecting durable Cursor MCP reporting.",
    });
  }
  if (/Logged in|Authenticated|Signed in/i.test(result.text)) {
    return gate({
      id: "cursor_agent_auth",
      client: "cursor",
      status: "verified",
      evidence: "cursor-agent status reports an authenticated session.",
      nextStep: "Keep Cursor Agent authenticated while verifying MCP tool durability.",
    });
  }
  return gate({
    id: "cursor_agent_auth",
    client: "cursor",
    status: "unknown",
    evidence: result.text || "cursor-agent status returned no classifiable output.",
    nextStep: "Inspect Cursor Agent auth status manually.",
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
  if (/Requested resource was not included in the authorization request/i.test(result.text)) {
    return gate({
      id: "cursor_list_tools_orgx",
      client: "cursor",
      status: "open",
      evidence:
        "cursor-agent mcp list-tools orgx failed OAuth resource validation: Requested resource was not included in the authorization request.",
      nextStep:
        "Deploy the OrgX MCP OAuth resource canonicalization fix, then rerun cursor-agent mcp login orgx and list-tools.",
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
  if (/not been approved|needs approval|requires approval/i.test(result.text)) {
    return gate({
      id: "cursor_list_tools_orgx",
      client: "cursor",
      status: "open",
      evidence: "cursor-agent mcp list-tools orgx reports the OrgX MCP server has not been approved.",
      nextStep: "Approve/authenticate the OrgX MCP server in Cursor, then verify list-tools orgx includes get_operator_chronicle.",
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

export function classifyCursorLoginProbe(result) {
  if (result.missing) {
    return gate({
      id: "cursor_mcp_login_probe",
      client: "cursor",
      status: "unavailable",
      evidence: "cursor-agent was not found on PATH.",
      nextStep: "Install Cursor Agent before relying on Cursor reporting UX.",
    });
  }
  if (/Requested resource was not included in the authorization request/i.test(result.text)) {
    return gate({
      id: "cursor_mcp_login_probe",
      client: "cursor",
      status: "open",
      evidence:
        "cursor-agent mcp login orgx reaches the OAuth callback but fails resource validation: Requested resource was not included in the authorization request.",
      nextStep:
        "Deploy the OrgX MCP OAuth resource canonicalization fix on mcp.useorgx.com, then rerun cursor-agent mcp login orgx.",
    });
  }
  if (/not been approved|needs approval|requires approval/i.test(result.text)) {
    return gate({
      id: "cursor_mcp_login_probe",
      client: "cursor",
      status: "open",
      evidence: "cursor-agent mcp login orgx reports the OrgX MCP server has not been approved.",
      nextStep:
        "Approve the OrgX MCP server in Cursor, then rerun cursor-agent mcp login orgx.",
    });
  }
  if (/Listening on .*callback|Opening your browser|requires authentication/i.test(result.text)) {
    return gate({
      id: "cursor_mcp_login_probe",
      client: "cursor",
      status: "open",
      evidence: "cursor-agent mcp login orgx is waiting for browser consent.",
      nextStep:
        "Complete the browser consent flow, then rerun cursor-agent mcp list-tools orgx.",
    });
  }
  if (/success|authenticated|logged in/i.test(result.text)) {
    return gate({
      id: "cursor_mcp_login_probe",
      client: "cursor",
      status: "verified",
      evidence: "cursor-agent mcp login orgx completed.",
      nextStep:
        "Verify cursor-agent mcp list-tools orgx includes get_operator_chronicle.",
    });
  }
  return gate({
    id: "cursor_mcp_login_probe",
    client: "cursor",
    status: "unknown",
    evidence: result.text || "cursor-agent mcp login orgx returned no classifiable output.",
    nextStep: "Inspect Cursor MCP login output manually without printing secrets.",
  });
}

function summarizeCursorConfigFile(filePath, label) {
  if (!existsSync(filePath)) {
    return {
      label,
      exists: false,
      orgxPresent: false,
      orgxUrlHost: null,
      orgxKeys: [],
      serverCount: 0,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const servers = parsed?.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
    const orgx = servers.orgx && typeof servers.orgx === "object" ? servers.orgx : undefined;
    let orgxUrlHost = null;
    if (typeof orgx?.url === "string") {
      try {
        orgxUrlHost = new URL(orgx.url).host;
      } catch {
        orgxUrlHost = "invalid-url";
      }
    }
    return {
      label,
      exists: true,
      orgxPresent: Boolean(orgx),
      orgxUrlHost,
      orgxKeys: orgx ? Object.keys(orgx).sort() : [],
      serverCount: Object.keys(servers).length,
    };
  } catch (error) {
    return {
      label,
      exists: true,
      parseError: error instanceof Error ? error.message : String(error),
      orgxPresent: false,
      orgxUrlHost: null,
      orgxKeys: [],
      serverCount: 0,
    };
  }
}

export function inspectCursorConfig({ homeDir = homedir(), cwd = process.cwd() } = {}) {
  const configs = [
    summarizeCursorConfigFile(join(cwd, ".cursor", "mcp.json"), "workspace"),
    summarizeCursorConfigFile(join(homeDir, ".cursor", "mcp.json"), "home"),
  ];
  const orgxConfig = configs.find((config) => config.orgxPresent);
  const parseError = configs.find((config) => config.parseError);
  if (parseError) {
    return gate({
      id: "cursor_config_shape",
      client: "cursor",
      status: "open",
      evidence: `${parseError.label} Cursor MCP config exists but JSON parsing failed.`,
      nextStep: "Fix Cursor MCP config JSON before relying on Cursor reporting UX.",
    });
  }
  if (!orgxConfig) {
    return gate({
      id: "cursor_config_shape",
      client: "cursor",
      status: "open",
      evidence: `Cursor MCP config shape checked; orgx present=false; workspace_exists=${configs[0].exists}; home_exists=${configs[1].exists}`,
      nextStep: "Add an orgx MCP server entry pointing at mcp.useorgx.com.",
    });
  }
  return gate({
    id: "cursor_config_shape",
    client: "cursor",
    status: orgxConfig.orgxUrlHost === "mcp.useorgx.com" ? "verified" : "open",
    evidence: `Cursor MCP config shape checked; source=${orgxConfig.label}; server_count=${orgxConfig.serverCount}; orgx_keys=${orgxConfig.orgxKeys.join(",") || "none"}; orgx_url_host=${orgxConfig.orgxUrlHost}`,
    nextStep:
      orgxConfig.orgxUrlHost === "mcp.useorgx.com"
        ? "Cursor config contains the OrgX MCP URL; remaining failures are auth or Cursor Agent loader behavior."
        : "Set Cursor orgx MCP URL host to mcp.useorgx.com.",
  });
}

export function inspectOpenCodeConfig({ homeDir = homedir() } = {}) {
  const configPath = join(homeDir, ".config", "opencode", "opencode.json");
  if (!existsSync(configPath)) {
    return gate({
      id: "opencode_mcp_config",
      client: "opencode",
      status: "open",
      evidence: "~/.config/opencode/opencode.json is missing.",
      nextStep: "Add an OrgX remote MCP entry before treating OpenCode direct reporting as configured.",
    });
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    const mcp = parsed?.mcp && typeof parsed.mcp === "object" ? parsed.mcp : {};
    const orgx = mcp.orgx && typeof mcp.orgx === "object" ? mcp.orgx : undefined;
    let orgxUrlHost = null;
    if (typeof orgx?.url === "string") {
      try {
        orgxUrlHost = new URL(orgx.url).host;
      } catch {
        orgxUrlHost = "invalid-url";
      }
    }
    const orgxType = typeof orgx?.type === "string" ? orgx.type : null;
    const enabled = orgx?.enabled !== false;
    const verified =
      Boolean(orgx) &&
      orgxType === "remote" &&
      orgxUrlHost === "mcp.useorgx.com" &&
      enabled;

    return gate({
      id: "opencode_mcp_config",
      client: "opencode",
      status: verified ? "verified" : "open",
      evidence: `OpenCode MCP config checked; orgx_present=${Boolean(orgx)}; orgx_type=${orgxType ?? "missing"}; orgx_url_host=${orgxUrlHost ?? "missing"}; orgx_enabled=${enabled}`,
      nextStep: verified
        ? "Use opencode_direct_readout to verify the runnable CLI, OrgX MCP authentication, and direct chronicle or morning-brief call."
        : "Configure OpenCode mcp.orgx as a remote server at mcp.useorgx.com.",
    });
  } catch (error) {
    return gate({
      id: "opencode_mcp_config",
      client: "opencode",
      status: "open",
      evidence: `OpenCode config exists but JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`,
      nextStep: "Fix ~/.config/opencode/opencode.json before relying on OpenCode reporting UX.",
    });
  }
}

export async function inspectOpenCodeDirectReadout({
  homeDir = homedir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  execFileImpl = execFile,
} = {}) {
  const version = await runCommand("opencode", ["--version"], {
    timeoutMs,
    execFileImpl,
  });
  const supersetWrapperPresent = existsSync(join(homeDir, ".superset", "bin", "opencode"));
  const sourceCheckoutPresent = existsSync(
    join(homeDir, "Code", "opencode-ecosystem-orgx", "packages", "opencode", "package.json")
  );
  const peerCheckoutPresent = existsSync(
    join(homeDir, "Code", "orgx-opencode-plugin-work-graph", "package.json")
  );
  const stateDirPresent =
    existsSync(join(homeDir, ".local", "state", "opencode")) ||
    existsSync(join(homeDir, ".opencode"));
  const existingArchitecture = `superset_wrapper=${supersetWrapperPresent}; source_checkout=${sourceCheckoutPresent}; orgx_peer_checkout=${peerCheckoutPresent}; state_dir=${stateDirPresent}`;

  if (version.missing || /Superset:\s*opencode not found/i.test(version.text)) {
    return gate({
      id: "opencode_direct_readout",
      client: "opencode",
      status: "open",
      evidence: `OpenCode direct readout unavailable: opencode command is not backed by a runnable CLI; ${existingArchitecture}`,
      nextStep:
        "Build/install the existing OpenCode checkout or expose a real opencode binary on PATH, then verify the configured OrgX MCP server lists get_operator_chronicle or orgx_recommend.",
    });
  }

  const mcpTools = await runCommand("opencode", ["mcp", "list"], {
    timeoutMs,
    execFileImpl,
  });
  if (/get_operator_chronicle|orgx_recommend/i.test(mcpTools.text)) {
    return gate({
      id: "opencode_direct_readout",
      client: "opencode",
      status: "verified",
      evidence: "opencode mcp list exposes an OrgX chronicle or morning-brief tool.",
      nextStep: "Capture a direct OpenCode chronicle or morning-brief call receipt.",
    });
  }
  if (/needs authentication|requires authentication/i.test(mcpTools.text)) {
    return gate({
      id: "opencode_direct_readout",
      client: "opencode",
      status: "open",
      evidence: `opencode is runnable and sees the OrgX MCP server, but OrgX MCP needs authentication; ${existingArchitecture}`,
      nextStep:
        "Run opencode mcp auth orgx, complete OrgX browser consent, then verify mcp list exposes get_operator_chronicle or orgx_recommend.",
    });
  }

  return gate({
    id: "opencode_direct_readout",
    client: "opencode",
    status: "open",
    evidence: `opencode is runnable but direct OrgX chronicle tools were not visible from mcp list; ${existingArchitecture}`,
    nextStep:
      "Authenticate/configure the OpenCode OrgX MCP server, then verify mcp list includes get_operator_chronicle or orgx_recommend.",
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

export function inspectCodexReadoutProof({
  homeDir = homedir(),
  proofPath = defaultCodexReadoutProofPath(homeDir),
} = {}) {
  const requiredFields = [
    "reportingNarrative.briefMarkdown",
    "decisionChronology",
    "artifactLedger",
    "prVelocity",
    "initiatives",
    "goals",
    "dataGaps",
    "topPriorities",
  ];
  const proof = readJsonIfPresent(proofPath);

  if (!proof) {
    const evidence = `Codex readout proof receipt missing at ${proofPath}.`;
    return [
      gate({
        id: "codex_direct_tool_exposure",
        client: "codex",
        status: "open",
        evidence,
        nextStep:
          "Call get_operator_chronicle from Codex, write the bounded readout proof receipt, then rerun orgx-codex-diagnose-reporting.",
      }),
      gate({
        id: "codex_morning_brief_fallback",
        client: "codex",
        status: "open",
        evidence,
        nextStep:
          "If direct get_operator_chronicle is unavailable, call orgx_recommend mode=morning_brief and write the bounded readout proof receipt.",
      }),
    ];
  }

  if (proof.parseError) {
    const evidence = `Codex readout proof receipt could not be parsed: ${proof.parseError}`;
    return [
      gate({
        id: "codex_direct_tool_exposure",
        client: "codex",
        status: "open",
        evidence,
        nextStep: "Regenerate latest-codex-readout-proof.json as valid JSON.",
      }),
      gate({
        id: "codex_morning_brief_fallback",
        client: "codex",
        status: "open",
        evidence,
        nextStep: "Regenerate latest-codex-readout-proof.json as valid JSON.",
      }),
    ];
  }

  const fields = proof.fieldPresence && typeof proof.fieldPresence === "object" ? proof.fieldPresence : {};
  const missingFields = requiredFields.filter((field) => fields[field] !== true);
  const visibleTools = Array.isArray(proof.visibleTools) ? proof.visibleTools : [];
  const directVerified =
    proof.client === "codex" &&
    proof.route === "direct_mcp_readout" &&
    proof.tool === "get_operator_chronicle" &&
    visibleTools.includes("get_operator_chronicle") &&
    missingFields.length === 0;
  const fallbackVerified =
    proof.client === "codex" &&
    proof.route === "mcp_morning_brief_fallback" &&
    proof.tool === "orgx_recommend" &&
    proof.mode === "morning_brief" &&
    proof.sourceTool === "get_operator_chronicle" &&
    missingFields.length === 0;
  const countEvidence = [
    `workspace=${proof.workspaceId ?? "unknown"}`,
    `period=${proof.period ?? "unknown"}`,
    `decisions=${proof.counts?.decisionChronology ?? "unknown"}`,
    `artifacts=${proof.counts?.artifactLedger ?? "unknown"}`,
    `priorities=${proof.counts?.topPriorities ?? "unknown"}`,
    `missingFields=${missingFields.join(",") || "none"}`,
  ].join("; ");

  return [
    gate({
      id: "codex_direct_tool_exposure",
      client: "codex",
      status: directVerified ? "verified" : "open",
      evidence: directVerified
        ? `Codex direct get_operator_chronicle readout receipt verified; ${countEvidence}`
        : `Codex direct readout receipt is incomplete or not direct; route=${proof.route ?? "unknown"}; tool=${proof.tool ?? "unknown"}; ${countEvidence}`,
      nextStep: directVerified
        ? "Keep Codex direct Chronicle readout under session-refresh regression."
        : "Call get_operator_chronicle from Codex and regenerate the bounded readout proof receipt.",
    }),
    gate({
      id: "codex_morning_brief_fallback",
      client: "codex",
      status: fallbackVerified || directVerified ? "verified" : "open",
      evidence: fallbackVerified
        ? `Codex morning-brief fallback receipt verified; ${countEvidence}`
        : directVerified
          ? "Codex direct get_operator_chronicle is verified in this session; morning-brief fallback is not required for live readout."
          : `Codex morning-brief fallback receipt is incomplete or missing; route=${proof.route ?? "unknown"}; tool=${proof.tool ?? "unknown"}; ${countEvidence}`,
      nextStep:
        fallbackVerified || directVerified
          ? "Keep Codex fallback behavior as a regression path for stale tool-list sessions."
          : "Call orgx_recommend mode=morning_brief from Codex and regenerate the bounded readout proof receipt.",
    }),
  ];
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

export function inspectClientHookSurfaceContract({
  gatesPath = OPERATOR_REPORTING_GATES_PATH,
} = {}) {
  if (!existsSync(gatesPath)) {
    return gate({
      id: "client_hook_surface_contract",
      client: "local",
      status: "open",
      evidence: "docs/operator-reporting-gates.json is missing.",
      nextStep: "Restore the machine-readable client hook surface audit before claiming hook coverage.",
    });
  }

  try {
    const parsed = JSON.parse(readFileSync(gatesPath, "utf8"));
    const surfaces = Array.isArray(parsed.clientHookSurfaces) ? parsed.clientHookSurfaces : [];
    const requiredClients = ["codex", "chatgpt", "claude-code", "cursor", "opencode"];
    const present = new Set(surfaces.map((surface) => surface?.client).filter(Boolean));
    const missing = requiredClients.filter((client) => !present.has(client));
    const complete = missing.length === 0 && surfaces.every((surface) => {
      return [
        "bestAvailableSurface",
        "directReadoutPath",
        "fallbackPath",
        "passiveHookSupport",
        "nativeHookCoverageStatus",
        "sufficiency",
        "currentGap",
      ].every((field) => typeof surface?.[field] === "string" && surface[field].trim().length > 0);
    });

    return gate({
      id: "client_hook_surface_contract",
      client: "local",
      status: complete ? "verified" : "open",
      evidence: `client hook surface audit clients=${Array.from(present).sort().join(",") || "none"}; missing=${missing.join(",") || "none"}`,
      nextStep: complete
        ? "Keep hook-sufficiency audited separately from individual client runtime proof."
        : "Document each client best surface, fallback, hook support level, sufficiency, and current gap.",
    });
  } catch (error) {
    return gate({
      id: "client_hook_surface_contract",
      client: "local",
      status: "open",
      evidence: `client hook surface audit could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      nextStep: "Fix docs/operator-reporting-gates.json before relying on reporting diagnostics.",
    });
  }
}

export function summarizeGates(gates) {
  const open = gates.filter((item) => ["open", "blocked_by_client_access", "unknown"].includes(item.status));
  const openGateIds = open.map((item) => item.id);
  const gateById = new Map(gates.map((item) => [item.id, item]));
  const cursorAuthVerified = gateById.get("cursor_agent_auth")?.status === "verified";
  const cursorConfigVerified = gateById.get("cursor_config_shape")?.status === "verified";
  const cursorListToolsGate = gateById.get("cursor_list_tools_orgx");
  const cursorListToolsEvidence = cursorListToolsGate?.evidence ?? "";
  const cursorLoginProbeGate = gateById.get("cursor_mcp_login_probe");
  const cursorLoginProbeEvidence = cursorLoginProbeGate?.evidence ?? "";
  const openCodeDirectGate = gateById.get("opencode_direct_readout");
  const openCodeDirectEvidence = openCodeDirectGate?.evidence ?? "";
  const recommendedActions = [];
  if (openGateIds.includes("cursor_agent_auth")) {
    recommendedActions.push({
      gate: "cursor_agent_auth",
      action: "Run cursor-agent login, complete browser authentication, then rerun orgx-codex-diagnose-reporting.",
    });
  }
  if (openGateIds.includes("cursor_isolated_config_discovery")) {
    recommendedActions.push({
      gate: "cursor_isolated_config_discovery",
      action:
        "Cursor Agent does not discover an isolated OrgX-only MCP config; update Cursor Agent or verify through Cursor IDE before treating CLI reporting as live.",
    });
  }
  if (openGateIds.includes("cursor_mcp_list")) {
    recommendedActions.push({
      gate: "cursor_mcp_list",
      action:
        cursorAuthVerified && cursorConfigVerified
          ? "Cursor Agent is authenticated and OrgX config is present, but cursor-agent mcp list still reports no servers; update Cursor Agent or inspect the MCP config loader before treating Cursor reporting as live."
          : "After Cursor Agent login, run cursor-agent mcp list and confirm orgx is visible.",
    });
  }
  if (openGateIds.includes("cursor_list_tools_orgx")) {
    recommendedActions.push({
      gate: "cursor_list_tools_orgx",
      action:
        /Client ID mismatch/i.test(cursorListToolsEvidence)
          ? "Run cursor-agent mcp login orgx; if Client ID mismatch persists, treat this as an MCP OAuth client-binding failure and verify get_operator_chronicle through another client until Cursor is fixed."
          : /Requested resource was not included/i.test(cursorListToolsEvidence)
            ? "Deploy the OrgX MCP OAuth resource canonicalization fix, then rerun cursor-agent mcp login orgx and verify list-tools orgx includes get_operator_chronicle."
          : /requires authentication|not been approved|needs approval|requires approval|approve/i.test(
                cursorListToolsEvidence
              )
            ? "Approve/authenticate the OrgX MCP server in Cursor, then verify cursor-agent mcp list-tools orgx includes get_operator_chronicle and remains durable across a fresh Cursor session."
            : cursorAuthVerified
              ? "Verify Cursor OrgX MCP approval/auth, then confirm list-tools orgx includes get_operator_chronicle."
          : "If orgx remains missing or mismatched, run cursor-agent mcp login orgx and then verify list-tools orgx includes get_operator_chronicle.",
      });
  }
  if (openGateIds.includes("cursor_mcp_login_probe")) {
    recommendedActions.push({
      gate: "cursor_mcp_login_probe",
      action: /Requested resource was not included/i.test(cursorLoginProbeEvidence)
        ? "Cursor MCP login is blocked by the hosted OAuth resource mismatch; deploy the mcp.useorgx.com canonicalization fix before asking the user to retry consent."
        : /not been approved|needs approval|requires approval/i.test(cursorLoginProbeEvidence)
          ? "Approve the OrgX MCP server in Cursor, then rerun cursor-agent mcp login orgx and list-tools orgx."
        : "Complete Cursor MCP browser consent, then rerun cursor-agent mcp list-tools orgx.",
    });
  }
  if (openGateIds.includes("local_work_graph_report")) {
    recommendedActions.push({
      gate: "local_work_graph_report",
      action: "Run orgx-codex-reconcile-hooks to regenerate the summary-only local Work Graph report.",
    });
  }
  if (openGateIds.includes("opencode_direct_readout")) {
    recommendedActions.push({
      gate: "opencode_direct_readout",
      action:
        /opencode is runnable|needs authentication/i.test(openCodeDirectEvidence)
          ? "Run opencode mcp auth orgx, complete OrgX browser consent, then verify mcp list exposes get_operator_chronicle or orgx_recommend."
          : "Build/install the existing OpenCode checkout or expose a real opencode binary on PATH, then verify the configured OrgX MCP server lists get_operator_chronicle or orgx_recommend.",
    });
  }
  return {
    ok: open.length === 0,
    attentionState: open.length > 0 ? "needs_you" : "verified",
    headline:
      open.length > 0
        ? `${open.length} reporting gate${open.length === 1 ? "" : "s"} need attention`
        : "Operator reporting gates are locally verified",
    openGateIds,
    recommendedActions,
  };
}

export async function main({
  argv = process.argv.slice(2),
  fetchImpl = fetch,
  execFileImpl = execFile,
  homeDir = homedir(),
  latestDiagnosticPath,
  now = () => new Date(),
  writeOutput = true,
} = {}) {
  const args = parseArgs(argv);
  const timeoutMs = Number.parseInt(args.timeout_ms ?? args["timeout-ms"] ?? "", 10) || DEFAULT_TIMEOUT_MS;
  const gates = [];

  gates.push(await inspectHostedMcp({ fetchImpl }));
  gates.push(inspectCodexHooks({ homeDir }));
  gates.push(
    ...inspectCodexReadoutProof({
      homeDir,
      proofPath: args["codex-readout-proof"] ?? defaultCodexReadoutProofPath(homeDir),
    })
  );
  gates.push(inspectWorkGraphReport({ homeDir }));
  gates.push(inspectClientHookSurfaceContract());
  gates.push(inspectCursorConfig({ homeDir }));
  gates.push(inspectOpenCodeConfig({ homeDir }));
  gates.push(await inspectOpenCodeDirectReadout({ homeDir, timeoutMs, execFileImpl }));
  gates.push(await inspectCursorIsolatedOrgxConfig({ timeoutMs, execFileImpl }));

  const cursorStatus = await runCommand("cursor-agent", ["status"], { timeoutMs, execFileImpl });
  gates.push(classifyCursorStatus(cursorStatus));
  const cursorList = await runCommand("cursor-agent", ["mcp", "list"], { timeoutMs, execFileImpl });
  gates.push(classifyCursorList(cursorList));
  const cursorTools = await runCommand("cursor-agent", ["mcp", "list-tools", "orgx"], {
    timeoutMs,
    execFileImpl,
  });
  gates.push(classifyCursorListTools(cursorTools));
  if (args["probe-cursor-login"] === "true") {
    const cursorLogin = await runCommand("cursor-agent", ["mcp", "login", "orgx"], {
      timeoutMs,
      execFileImpl,
    });
    gates.push(classifyCursorLoginProbe(cursorLogin));
  }

  const claudeGet = await runCommand("claude", ["mcp", "get", "orgx"], { timeoutMs, execFileImpl });
  gates.push(classifyClaudeMcpGet(claudeGet));

  const report = {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    source: "orgx_codex_plugin_reporting_gate_diagnostics",
    summary: summarizeGates(gates),
    gates,
  };

  const resolvedLatestDiagnosticPath =
    latestDiagnosticPath === null
      ? null
      : latestDiagnosticPath ?? defaultLatestDiagnosticPath(homeDir);
  if (args["write-latest"] !== "false" && resolvedLatestDiagnosticPath) {
    mkdirSync(join(resolvedLatestDiagnosticPath, ".."), { recursive: true });
    writeFileSync(resolvedLatestDiagnosticPath, JSON.stringify(report, null, 2), "utf8");
  }

  if (writeOutput && args.json !== "false") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (writeOutput) {
    process.stdout.write(`${report.summary.headline}\n`);
    for (const action of report.summary.recommendedActions) {
      process.stdout.write(`> ${action.action}\n`);
    }
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
