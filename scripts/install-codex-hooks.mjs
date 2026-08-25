#!/usr/bin/env node
/**
 * Explicitly delegate Codex session capture installation to the OrgX Wizard.
 *
 * The plugin does not install or run a second summary collector. This command
 * selects a consent-safe capture policy and asks the Wizard to own the hooks.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const MAX_OUTPUT_BYTES = 64 * 1024;
const INSTALL_TIMEOUT_MS = 15_000;
const WIZARD_ENV_ALLOWLIST = new Set([
  "APPDATA",
  "CI",
  "ComSpec",
  "DO_NOT_TRACK",
  "DSH_HOME",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_COLOR",
  "ORGX_TELEMETRY_DISABLED",
  "ORGX_WIZARD_CONFIG_HOME",
  "ORGX_WIZARD_DISABLE_KEYTAR",
  "ORGX_WIZARD_HOOK_OUTBOX",
  "ORGX_WIZARD_HOOK_OUTBOX_MAX_BYTES",
  "ORGX_WIZARD_HOOK_SPOOL",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveWorkEpisodeCapture(env = process.env) {
  const value =
    pickString(env.ORGX_SESSION_WORK_EPISODE_CAPTURE)?.toLowerCase() ??
    "metadata-only";
  if (value === "metadata-only" || value === "bounded") return value;
  throw new Error(
    "ORGX_SESSION_WORK_EPISODE_CAPTURE must be metadata-only or bounded."
  );
}

export function credentialFreeInstallEnvironment(env = process.env) {
  const childEnv = {};
  for (const name of WIZARD_ENV_ALLOWLIST) {
    if (typeof env[name] === "string") childEnv[name] = env[name];
  }
  return childEnv;
}

export function buildWizardInstallArgs(capture) {
  return [
    "hooks",
    "install",
    "--targets",
    "codex",
    "--work-capture",
    capture,
    "--json",
  ];
}

export function isDirectRun({
  argvPath = process.argv[1],
  moduleUrl = import.meta.url,
  realpathSyncImpl = realpathSync,
} = {}) {
  if (!argvPath) return false;
  try {
    return (
      realpathSyncImpl(argvPath) === realpathSyncImpl(fileURLToPath(moduleUrl))
    );
  } catch {
    return moduleUrl === pathToFileURL(argvPath).href;
  }
}

export function installCodexHooks({
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const capture = resolveWorkEpisodeCapture(env);
  const command = pickString(env.ORGX_WIZARD_BIN) || "orgx-wizard";
  const args = buildWizardInstallArgs(capture);
  const result = spawnSyncImpl(command, args, {
    encoding: "utf8",
    env: credentialFreeInstallEnvironment(env),
    shell: false,
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });

  if (result?.error) {
    return {
      ok: false,
      capture,
      command,
      args,
      reason:
        result.error.code === "ETIMEDOUT"
          ? "wizard_timeout"
          : "wizard_unavailable",
      detail: result.error.message,
    };
  }
  if (result?.status !== 0) {
    return {
      ok: false,
      capture,
      command,
      args,
      reason: "wizard_rejected_capture_policy",
      detail: pickString(result?.stderr, result?.stdout, "Wizard rejected setup."),
    };
  }
  return {
    ok: true,
    capture,
    command,
    args,
    wizard: pickString(result?.stdout),
  };
}

if (isDirectRun()) {
  try {
    const result = installCodexHooks();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
