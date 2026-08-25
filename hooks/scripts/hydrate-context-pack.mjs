#!/usr/bin/env node
/**
 * SessionStart: hydrate accepted OrgX context into Codex.
 *
 * The app compiles organizational state; the Wizard owns validation, exact-cwd
 * activation, session capture, queueing, and delivery. This adapter only:
 *   1. fetches the most-specific configured context pack,
 *   2. forwards data.sessionWorkContext unchanged to the Wizard, and
 *   3. returns bounded Codex SessionStart additionalContext.
 *
 * Every failure is visible in the return value and fails open for Codex.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

export const PACK_FILENAME = "orgx-context-pack.json";
export const PENDING_CONTEXT_FILENAME =
  "orgx-session-work-context.activation-pending.json";
export const MAX_HOOK_INPUT_BYTES = 64 * 1024;
export const MAX_CONTEXT_PACK_RESPONSE_BYTES = 128 * 1024;
export const MAX_SESSION_WORK_CONTEXT_BYTES = 4 * 1024;
export const MAX_ADDITIONAL_CONTEXT_BYTES = 8 * 1024;

const MAX_LOCAL_CONFIG_BYTES = 16 * 1024;
const MAX_WIZARD_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 3_000;
const LOCAL_CONFIG_PATH = [".codex", "orgx.local.json"];
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
const SCOPE_FIELDS = [
  {
    name: "workspace",
    requestField: "workspace_id",
    env: "ORGX_WORKSPACE_ID",
    local: ["workspaceId", "workspace_id"],
  },
  {
    name: "initiative",
    requestField: "initiative_id",
    env: "ORGX_INITIATIVE_ID",
    local: ["initiativeId", "initiative_id"],
  },
  {
    name: "workstream",
    requestField: "workstream_id",
    env: "ORGX_WORKSTREAM_ID",
    local: ["workstreamId", "workstream_id"],
  },
  {
    name: "task",
    requestField: "task_id",
    env: "ORGX_TASK_ID",
    local: ["taskId", "task_id"],
  },
];
const ANCHOR_PRIORITY = ["task", "workstream", "initiative", "workspace"];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseHookPayload(stdinText = "") {
  if (Buffer.byteLength(stdinText, "utf8") > MAX_HOOK_INPUT_BYTES) return {};
  try {
    const value = JSON.parse(stdinText || "{}");
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export async function readStdin(
  stream = process.stdin,
  maxBytes = MAX_HOOK_INPUT_BYTES
) {
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (!overflow && bytes <= maxBytes) chunks.push(buffer);
    else overflow = true;
  }
  return overflow ? "" : Buffer.concat(chunks).toString("utf8");
}

/** Plugin hooks run from the project cwd, but payload.cwd is authoritative. */
export function resolveProjectDirectory(payload = {}, env = {}, explicit) {
  const candidate = pickString(
    explicit,
    payload.cwd,
    payload.working_directory,
    payload.workspace,
    ...(Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []),
    ...(Array.isArray(payload.workspaceRoots) ? payload.workspaceRoots : []),
    env.CODEX_PROJECT_DIR
  );
  return candidate && isAbsolute(candidate) ? resolve(candidate) : undefined;
}

export function readLocalConfig(projectDir) {
  const path = join(projectDir, ...LOCAL_CONFIG_PATH);
  if (!existsSync(path)) return null;
  try {
    if (statSync(path).size > MAX_LOCAL_CONFIG_BYTES) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function localValue(localConfig, keys) {
  return isRecord(localConfig)
    ? pickString(...keys.map((key) => localConfig[key]))
    : undefined;
}

function safeBaseUrl(value) {
  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === "http:" &&
      ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.pathname !== "/") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Local project config is deliberately credential-free. An API key and any
 * non-default origin must be supplied by the launching environment.
 */
export function resolveConfig(env = {}, localConfig = null) {
  const apiKey = pickString(env.ORGX_API_KEY);
  if (!apiKey) return null;

  const configuredBaseUrl = pickString(env.ORGX_BASE_URL);
  const baseUrl = safeBaseUrl(configuredBaseUrl || "https://useorgx.com");
  if (!baseUrl) return null;

  const scope = {};
  for (const field of SCOPE_FIELDS) {
    const id = pickString(
      env[field.env],
      localValue(localConfig, field.local)
    );
    if (id) scope[field.requestField] = id;
  }
  if (Object.keys(scope).length === 0) return null;

  const anchorName = ANCHOR_PRIORITY.find((name) => {
    const field = SCOPE_FIELDS.find((candidate) => candidate.name === name);
    return field && scope[field.requestField];
  });
  const anchorField = SCOPE_FIELDS.find((field) => field.name === anchorName);
  return {
    apiKey,
    baseUrl,
    scope,
    anchor: anchorField
      ? { type: anchorField.name, id: scope[anchorField.requestField] }
      : null,
  };
}

export function buildPackRequest(config) {
  return {
    url: `${config.baseUrl}/api/v1/context-pack`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(config.scope),
  };
}

async function readResponseText(response, maxBytes) {
  const declaredLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, reason: "response_too_large" };
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "response_too_large" };
      }
      chunks.push(chunk);
    }
    return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
  }

  if (typeof response?.text !== "function") {
    return { ok: false, reason: "response_body_unavailable" };
  }
  const text = await response.text();
  return Buffer.byteLength(text, "utf8") <= maxBytes
    ? { ok: true, text }
    : { ok: false, reason: "response_too_large" };
}

export async function readBoundedJsonResponse(
  response,
  maxBytes = MAX_CONTEXT_PACK_RESPONSE_BYTES
) {
  const body = await readResponseText(response, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return { ok: false, reason: "response_invalid_json" };
  }
}

function privateJsonWrite(path, value) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.orgx-context.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may have been renamed.
    }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some mounted filesystems do not expose POSIX modes.
  }
  return path;
}

function removePendingContext(projectDir) {
  try {
    unlinkSync(join(projectDir, ".codex", PENDING_CONTEXT_FILENAME));
  } catch {
    // Missing or locked stale state is non-fatal.
  }
}

export function persistPendingSessionWorkContext(projectDir, context) {
  return privateJsonWrite(
    join(projectDir, ".codex", PENDING_CONTEXT_FILENAME),
    context
  );
}

function timeoutFromEnvironment(env, key) {
  const configured = Number(env[key]);
  return Number.isFinite(configured) && configured >= 250 && configured <= 10_000
    ? Math.round(configured)
    : DEFAULT_TIMEOUT_MS;
}

export function credentialFreeWizardEnvironment(env = process.env) {
  const childEnv = {};
  for (const name of WIZARD_ENV_ALLOWLIST) {
    if (typeof env[name] === "string") childEnv[name] = env[name];
  }
  return childEnv;
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

function parseWizardAcknowledgement(stdout, projectDir) {
  try {
    const value = JSON.parse(stdout);
    if (!isRecord(value) || value.ready !== true || value.state !== "ready") {
      return { activated: false, reason: "wizard_unverified" };
    }
    if (resolve(value.cwd) !== resolve(projectDir)) {
      return { activated: false, reason: "wizard_cwd_mismatch" };
    }
    return { activated: true, reason: "wizard_activated" };
  } catch {
    return { activated: false, reason: "wizard_unverified" };
  }
}

function parseWizardClearAcknowledgement(stdout, projectDir) {
  try {
    const value = JSON.parse(stdout);
    if (!isRecord(value) || value.ready !== false || value.state !== "missing") {
      return { cleared: false, reason: "wizard_unverified" };
    }
    if (resolve(value.cwd) !== resolve(projectDir)) {
      return { cleared: false, reason: "wizard_cwd_mismatch" };
    }
    return {
      cleared: true,
      reason: value.cleared === true ? "wizard_cleared" : "wizard_already_clear",
    };
  } catch {
    return { cleared: false, reason: "wizard_unverified" };
  }
}

function runWizardJsonCommand({
  args,
  input = "",
  operation = "activate",
  projectDir,
  env,
  spawnImpl,
  parseSuccess,
}) {
  return new Promise((resolveResult) => {
    let child;
    let settled = false;
    let outputBytes = 0;
    const output = [];
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    const failure = (reason) =>
      operation === "clear"
        ? { cleared: false, reason }
        : { activated: false, reason };

    try {
      child = spawnImpl(pickString(env.ORGX_WIZARD_BIN) || "orgx-wizard", args, {
        env: credentialFreeWizardEnvironment(env),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish(failure("wizard_unavailable"));
      return;
    }

    child.once?.("error", () =>
      finish(failure("wizard_unavailable"))
    );
    child.stdout?.on?.("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > MAX_WIZARD_OUTPUT_BYTES) {
        child.kill?.();
        finish(failure("wizard_output_too_large"));
        return;
      }
      output.push(buffer);
    });
    child.once?.("close", (code) => {
      if (code !== 0) {
        finish(failure("wizard_rejected"));
        return;
      }
      finish(parseSuccess(Buffer.concat(output).toString("utf8"), projectDir));
    });
    child.stdin?.once?.("error", () =>
      finish(failure("wizard_unavailable"))
    );
    timer = setTimeout(() => {
      child.kill?.();
      finish(failure("wizard_timeout"));
    }, timeoutFromEnvironment(env, "ORGX_SESSION_CONTEXT_ACTIVATION_TIMEOUT_MS"));

    try {
      child.stdin?.end(input);
    } catch {
      finish(failure("wizard_unavailable"));
    }
  });
}

/** Forward the exact server object to Wizard's supported activation seam. */
export async function activateSessionWorkContext({
  context,
  projectDir,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  if (
    !isRecord(context) ||
    context.schema_version !== "orgx-session-work-context/v1" ||
    jsonBytes(context) > MAX_SESSION_WORK_CONTEXT_BYTES ||
    !projectDir
  ) {
    return { activated: false, reason: "context_invalid" };
  }

  return runWizardJsonCommand({
    args: [
      "sessions",
      "context",
      "set",
      "--file",
      "-",
      "--cwd",
      projectDir,
      "--json",
    ],
    input: JSON.stringify(context),
    projectDir,
    env,
    spawnImpl,
    parseSuccess: parseWizardAcknowledgement,
  });
}

/** Prevent a prior exact-cwd activation surviving a definitive empty response. */
export async function clearSessionWorkContext({
  projectDir,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  if (!projectDir) return { cleared: false, reason: "project_directory_unavailable" };
  return runWizardJsonCommand({
    args: [
      "sessions",
      "context",
      "clear",
      "--cwd",
      projectDir,
      "--json",
    ],
    operation: "clear",
    projectDir,
    env,
    spawnImpl,
    parseSuccess: parseWizardClearAcknowledgement,
  });
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n[OrgX context truncated; inspect .codex/orgx-context-pack.json.]";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  let text = "";
  for (const char of value) {
    if (Buffer.byteLength(text + char, "utf8") > budget) break;
    text += char;
  }
  return text + suffix;
}

function additionalContextFor({ context, activation, packPath }) {
  const relativePack = ".codex/orgx-context-pack.json";
  if (!isRecord(context)) {
    const clearanceLine = activation?.prior_activation_cleared
      ? "Any prior exact-directory Wizard activation was cleared."
      : `Wizard could not verify removal of a prior activation (${activation?.clear_reason || "unknown"}); do not rely on earlier session authority.`;
    return [
      `OrgX compiled context is available at ${relativePack}.`,
      "No receipt-ready sessionWorkContext was returned, so refresh consequential state through OrgX before acting.",
      clearanceLine,
    ].join("\n");
  }
  const activationLine = activation.activated
    ? "Wizard validated and activated this context for the exact current working directory."
    : `Wizard activation is pending (${activation.reason}); use this as briefing only, not as proof of activated authority.`;
  return truncateUtf8(
    [
      "OrgX session context (producer-asserted; accepted references retain their own provenance):",
      activationLine,
      `Full compiled pack: ${relativePack}${packPath ? "" : " (not persisted)"}`,
      JSON.stringify(context),
    ].join("\n"),
    MAX_ADDITIONAL_CONTEXT_BYTES
  );
}

export function buildCodexSessionStartOutput(result = {}) {
  const output = { continue: true, suppressOutput: true };
  if (typeof result.additional_context === "string" && result.additional_context) {
    output.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext: result.additional_context,
    };
  }
  return output;
}

export async function main({
  env = process.env,
  stdinText = "",
  projectDir,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  now = new Date(),
} = {}) {
  try {
    const payload = parseHookPayload(stdinText);
    const activeProjectDir = resolveProjectDirectory(payload, env, projectDir);
    if (!activeProjectDir || !existsSync(activeProjectDir)) {
      return { ok: true, skipped: "project_directory_unavailable" };
    }

    const config = resolveConfig(env, readLocalConfig(activeProjectDir));
    if (!config) return { ok: true, skipped: "context_pack_unconfigured" };

    const request = buildPackRequest(config);
    const controller = new AbortController();
    const requestTimer = setTimeout(
      () => controller.abort(),
      timeoutFromEnvironment(env, "ORGX_CONTEXT_PACK_TIMEOUT_MS")
    );
    let response;
    let parsed;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "error",
        signal: controller.signal,
      });
      if (response?.ok) parsed = await readBoundedJsonResponse(response);
    } catch (error) {
      return {
        ok: true,
        skipped: "context_pack_request_failed",
        reason: error?.name === "AbortError" ? "timeout" : "network_error",
      };
    } finally {
      clearTimeout(requestTimer);
    }
    if (!response?.ok) {
      return {
        ok: true,
        skipped: "context_pack_request_failed",
        status: response?.status,
      };
    }

    if (!parsed.ok || !isRecord(parsed.value?.data)) {
      return {
        ok: true,
        skipped: "context_pack_response_invalid",
        reason: parsed.reason || "data_missing",
      };
    }
    const data = parsed.value.data;
    const contextPackPath = privateJsonWrite(
      join(activeProjectDir, ".codex", PACK_FILENAME),
      { fetchedAt: now.toISOString(), data }
    );

    const context = data.sessionWorkContext;
    if (!isRecord(context)) {
      removePendingContext(activeProjectDir);
      const clearance = await clearSessionWorkContext({
        projectDir: activeProjectDir,
        env,
        spawnImpl,
      });
      const activation = {
        activated: false,
        reason: "not_returned",
        prior_activation_cleared: clearance.cleared,
        clear_reason: clearance.reason,
      };
      return {
        ok: true,
        context_pack_path: contextPackPath,
        session_context: activation,
        additional_context: additionalContextFor({
          context: null,
          activation,
          packPath: contextPackPath,
        }),
      };
    }
    if (
      context.schema_version !== "orgx-session-work-context/v1" ||
      jsonBytes(context) > MAX_SESSION_WORK_CONTEXT_BYTES
    ) {
      removePendingContext(activeProjectDir);
      const clearance = await clearSessionWorkContext({
        projectDir: activeProjectDir,
        env,
        spawnImpl,
      });
      const activation = {
        activated: false,
        reason: "context_invalid",
        prior_activation_cleared: clearance.cleared,
        clear_reason: clearance.reason,
      };
      return {
        ok: true,
        context_pack_path: contextPackPath,
        session_context: activation,
        additional_context: additionalContextFor({
          context: null,
          activation,
          packPath: contextPackPath,
        }),
      };
    }

    const activation = await activateSessionWorkContext({
      context,
      projectDir: activeProjectDir,
      env,
      spawnImpl,
    });
    let pendingPath;
    if (activation.activated) removePendingContext(activeProjectDir);
    else pendingPath = persistPendingSessionWorkContext(activeProjectDir, context);

    return {
      ok: true,
      context_pack_path: contextPackPath,
      session_context: pendingPath
        ? { ...activation, pending_path: pendingPath }
        : activation,
      additional_context: additionalContextFor({
        context,
        activation,
        packPath: contextPackPath,
      }),
    };
  } catch {
    return { ok: true, skipped: "context_pack_hydration_failed" };
  }
}

if (isDirectRun()) {
  readStdin()
    .then((stdinText) => main({ stdinText }))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(buildCodexSessionStartOutput(result))}\n`);
    })
    .catch(() => {
      process.stdout.write(
        `${JSON.stringify(buildCodexSessionStartOutput({}))}\n`
      );
    })
    .finally(() => process.exit(0));
}
