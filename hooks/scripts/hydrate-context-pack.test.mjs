import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  MAX_CONTEXT_PACK_RESPONSE_BYTES,
  PACK_FILENAME,
  PENDING_CONTEXT_FILENAME,
  activateSessionWorkContext,
  buildCodexSessionStartOutput,
  buildPackRequest,
  clearSessionWorkContext,
  credentialFreeWizardEnvironment,
  isDirectRun,
  main,
  readBoundedJsonResponse,
  resolveConfig,
  resolveProjectDirectory,
} from "./hydrate-context-pack.mjs";

const sessionWorkContext = {
  schema_version: "orgx-session-work-context/v1",
  intent: {
    summary: "Continue the accepted Codex implementation slice.",
    acceptance_criteria: ["Focused checks pass"],
    constraints: ["Do not invent authority"],
  },
  authority: {
    mode: "unknown",
    status: "unknown",
    scope: { actions: [], resources: [], systems: [] },
    constraints: [],
  },
  cost: {
    availability: "available",
    currency: "USD",
    total: 0,
    estimated: true,
  },
  artifact_refs: [],
  evidence_refs: [],
};

const appSessionWorkContext = {
  ...sessionWorkContext,
  provenance: "producer_asserted",
  cost: { availability: "not_observed" },
};

function response(data, status = 200) {
  const body = JSON.stringify({ ok: true, data });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(Buffer.byteLength(body, "utf8")) },
    text: async () => body,
  };
}

function successfulWizard(calls) {
  return (command, args, options) => {
    const child = new EventEmitter();
    const chunks = [];
    child.stdout = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    child.stdin.once("finish", () => {
      calls.push({
        command,
        args,
        options,
        input: Buffer.concat(chunks).toString("utf8"),
      });
      const cwd = args[args.indexOf("--cwd") + 1];
      child.stdout.end(JSON.stringify(
        args[2] === "clear"
          ? { cleared: true, state: "missing", ready: false, cwd }
          : { state: "ready", ready: true, cwd }
      ));
      setImmediate(() => child.emit("close", 0));
    });
    child.kill = () => undefined;
    return child;
  };
}

test("resolves and sends the complete exact hierarchy with task anchor priority", () => {
  const config = resolveConfig({
    ORGX_API_KEY: "oxk_test",
    ORGX_BASE_URL: "https://useorgx.com/",
    ORGX_WORKSPACE_ID: "workspace-1",
    ORGX_INITIATIVE_ID: "initiative-2",
    ORGX_WORKSTREAM_ID: "workstream-3",
    ORGX_TASK_ID: "task-4",
  });

  assert.deepEqual(config.anchor, { type: "task", id: "task-4" });
  assert.deepEqual(buildPackRequest(config), {
    url: "https://useorgx.com/api/v1/context-pack",
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer oxk_test",
    },
    body: JSON.stringify({
      workspace_id: "workspace-1",
      initiative_id: "initiative-2",
      workstream_id: "workstream-3",
      task_id: "task-4",
    }),
  });
});

test("supports each exact scope without requiring an initiative", () => {
  for (const [envKey, id, requestField, type] of [
    ["ORGX_WORKSPACE_ID", "workspace-1", "workspace_id", "workspace"],
    ["ORGX_INITIATIVE_ID", "initiative-1", "initiative_id", "initiative"],
    ["ORGX_WORKSTREAM_ID", "workstream-1", "workstream_id", "workstream"],
    ["ORGX_TASK_ID", "task-1", "task_id", "task"],
  ]) {
    const config = resolveConfig({ ORGX_API_KEY: "oxk_test", [envKey]: id });
    assert.deepEqual(config.anchor, { type, id });
    assert.deepEqual(JSON.parse(buildPackRequest(config).body), {
      [requestField]: id,
    });
  }
});

test("project config is credential-free and cannot redirect an environment key", () => {
  assert.equal(
    resolveConfig(
      {},
      {
        api_key: "test_repository_secret",
        base_url: "https://attacker.invalid",
        task_id: "task-local",
      }
    ),
    null
  );

  const config = resolveConfig(
    { ORGX_API_KEY: "oxk_environment" },
    {
      api_key: "oxk_ignored",
      base_url: "https://attacker.invalid",
      task_id: "task-local",
    }
  );
  assert.equal(config.apiKey, "oxk_environment");
  assert.equal(config.baseUrl, "https://useorgx.com");
  assert.deepEqual(config.scope, { task_id: "task-local" });
  assert.equal(
    resolveConfig({
      ORGX_API_KEY: "oxk_environment",
      ORGX_BASE_URL: "https://token@example.com?key=secret",
      ORGX_TASK_ID: "task-1",
    }),
    null
  );
});

test("uses only an explicit Codex hook project directory", () => {
  assert.equal(
    resolveProjectDirectory(
      { cwd: "/workspace/from-hook" },
      { CODEX_PROJECT_DIR: "/workspace/from-env" }
    ),
    "/workspace/from-hook"
  );
  assert.equal(
    resolveProjectDirectory({}, { CODEX_PROJECT_DIR: "/workspace/from-env" }),
    "/workspace/from-env"
  );
  assert.equal(resolveProjectDirectory({}, {}), undefined);
  assert.equal(
    resolveProjectDirectory({}, { CURSOR_PROJECT_DIR: "/wrong/client" }),
    undefined
  );
  assert.equal(resolveProjectDirectory({}, {}, "relative/project"), undefined);
});

test("rejects a declared context-pack response beyond the byte budget", async () => {
  const result = await readBoundedJsonResponse({
    headers: {
      get: () => String(MAX_CONTEXT_PACK_RESPONSE_BYTES + 1),
    },
    text: async () => {
      throw new Error("must reject before reading");
    },
  });
  assert.deepEqual(result, { ok: false, reason: "response_too_large" });
});

test("retains the pack, activates exact context, and emits first-turn context", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "orgx-codex-context-pack-"));
  const requests = [];
  const wizardCalls = [];
  const now = new Date("2026-08-24T20:00:00.000Z");
  try {
    const result = await main({
      env: {
        PATH: process.env.PATH,
        ORGX_API_KEY: "test_api_key_must_not_reach_wizard",
        ORGX_GATEWAY_KEY: "test_gateway_key_must_not_reach_wizard",
        DATABASE_URL: "postgres://must:not@reach-wizard.invalid/db",
        XDG_CONFIG_HOME: join(projectDir, "wizard-config"),
        ORGX_WORKSPACE_ID: "workspace-1",
        ORGX_INITIATIVE_ID: "initiative-2",
        ORGX_WORKSTREAM_ID: "workstream-3",
        ORGX_TASK_ID: "task-4",
      },
      stdinText: JSON.stringify({ cwd: projectDir }),
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return response({
          frame: { anchor: "task-4" },
          sessionWorkContext: appSessionWorkContext,
        });
      },
      spawnImpl: successfulWizard(wizardCalls),
      now,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.session_context, {
      activated: true,
      reason: "wizard_activated",
    });
    assert.match(result.additional_context, /exact current working directory/);
    assert.match(result.additional_context, /Continue the accepted Codex/);
    const hookOutput = buildCodexSessionStartOutput(result);
    assert.equal(hookOutput.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(
      hookOutput.hookSpecificOutput.additionalContext,
      result.additional_context
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://useorgx.com/api/v1/context-pack");
    assert.equal(requests[0].options.redirect, "error");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      workspace_id: "workspace-1",
      initiative_id: "initiative-2",
      workstream_id: "workstream-3",
      task_id: "task-4",
    });

    const packPath = join(projectDir, ".codex", PACK_FILENAME);
    assert.equal(result.context_pack_path, packPath);
    assert.deepEqual(JSON.parse(readFileSync(packPath, "utf8")), {
      fetchedAt: now.toISOString(),
      data: {
        frame: { anchor: "task-4" },
        sessionWorkContext: appSessionWorkContext,
      },
    });
    assert.equal(statSync(packPath).mode & 0o777, 0o600);

    assert.equal(wizardCalls.length, 1);
    assert.equal(wizardCalls[0].command, "orgx-wizard");
    assert.deepEqual(wizardCalls[0].args, [
      "sessions",
      "context",
      "set",
      "--file",
      "-",
      "--cwd",
      projectDir,
      "--json",
    ]);
    assert.deepEqual(JSON.parse(wizardCalls[0].input), appSessionWorkContext);
    assert.equal(wizardCalls[0].options.env.ORGX_API_KEY, undefined);
    assert.equal(wizardCalls[0].options.env.ORGX_GATEWAY_KEY, undefined);
    assert.equal(wizardCalls[0].options.env.DATABASE_URL, undefined);
    assert.equal(
      wizardCalls[0].options.env.XDG_CONFIG_HOME,
      join(projectDir, "wizard-config")
    );
    assert.equal(
      existsSync(join(projectDir, ".codex", PENDING_CONTEXT_FILENAME)),
      false
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("persists exact pending context when Wizard is unavailable", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "orgx-codex-context-pack-"));
  try {
    const result = await main({
      env: {
        ORGX_API_KEY: "oxk_test",
        ORGX_INITIATIVE_ID: "initiative-1",
      },
      stdinText: JSON.stringify({ cwd: projectDir }),
      fetchImpl: async () =>
        response({ sessionWorkContext: appSessionWorkContext }),
      spawnImpl: () => {
        throw new Error("orgx-wizard unavailable");
      },
    });

    const pendingPath = join(
      projectDir,
      ".codex",
      PENDING_CONTEXT_FILENAME
    );
    assert.deepEqual(result.session_context, {
      activated: false,
      reason: "wizard_unavailable",
      pending_path: pendingPath,
    });
    assert.match(result.additional_context, /activation is pending/);
    assert.deepEqual(
      JSON.parse(readFileSync(pendingPath, "utf8")),
      appSessionWorkContext
    );
    assert.equal(statSync(pendingPath).mode & 0o777, 0o600);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("retains a pack and clears stale activation when context is absent", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "orgx-codex-context-pack-"));
  const wizardCalls = [];
  try {
    const result = await main({
      env: { ORGX_API_KEY: "oxk_test", ORGX_WORKSPACE_ID: "workspace-1" },
      stdinText: JSON.stringify({ cwd: projectDir }),
      fetchImpl: async () =>
        response({ contextCapsule: { workspaceId: "workspace-1" } }),
      spawnImpl: successfulWizard(wizardCalls),
    });

    assert.deepEqual(result.session_context, {
      activated: false,
      reason: "not_returned",
      prior_activation_cleared: true,
      clear_reason: "wizard_cleared",
    });
    assert.match(result.additional_context, /No receipt-ready/);
    assert.match(result.additional_context, /prior exact-directory.*cleared/i);
    assert.equal(wizardCalls.length, 1);
    assert.deepEqual(wizardCalls[0].args, [
      "sessions",
      "context",
      "clear",
      "--cwd",
      projectDir,
      "--json",
    ]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("clears stale activation when the server context is not receipt-ready", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "orgx-codex-context-pack-"));
  const wizardCalls = [];
  try {
    const result = await main({
      env: { ORGX_API_KEY: "oxk_test", ORGX_TASK_ID: "task-1" },
      stdinText: JSON.stringify({ cwd: projectDir }),
      fetchImpl: async () =>
        response({
          sessionWorkContext: { schema_version: "orgx-session-work-context/v2" },
        }),
      spawnImpl: successfulWizard(wizardCalls),
    });

    assert.deepEqual(result.session_context, {
      activated: false,
      reason: "context_invalid",
      prior_activation_cleared: true,
      clear_reason: "wizard_cleared",
    });
    assert.equal(wizardCalls[0].args[2], "clear");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("does not fetch against the installed plugin cwd", async () => {
  let fetched = false;
  const result = await main({
    env: { ORGX_API_KEY: "oxk_test", ORGX_TASK_ID: "task-1" },
    stdinText: "{}",
    fetchImpl: async () => {
      fetched = true;
      return response({});
    },
  });
  assert.deepEqual(result, {
    ok: true,
    skipped: "project_directory_unavailable",
  });
  assert.equal(fetched, false);
});

test("fails open on an offline context-pack request", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "orgx-codex-context-pack-"));
  try {
    const result = await main({
      env: { ORGX_API_KEY: "oxk_test", ORGX_TASK_ID: "task-1" },
      stdinText: JSON.stringify({ cwd: projectDir }),
      fetchImpl: async () => {
        throw new TypeError("offline");
      },
    });
    assert.deepEqual(result, {
      ok: true,
      skipped: "context_pack_request_failed",
      reason: "network_error",
    });
    assert.equal(existsSync(join(projectDir, ".codex", PACK_FILENAME)), false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("bounds a stalled context-pack response body", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "orgx-codex-context-pack-"));
  const startedAt = Date.now();
  try {
    const result = await main({
      env: {
        ORGX_API_KEY: "oxk_test",
        ORGX_TASK_ID: "task-1",
        ORGX_CONTEXT_PACK_TIMEOUT_MS: "250",
      },
      stdinText: JSON.stringify({ cwd: projectDir }),
      fetchImpl: async (_url, options) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () =>
              new Promise((_resolve, reject) => {
                const rejectAbort = () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                };
                if (options.signal.aborted) rejectAbort();
                else options.signal.addEventListener("abort", rejectAbort, { once: true });
              }),
          }),
        },
      }),
    });
    assert.deepEqual(result, {
      ok: true,
      skipped: "context_pack_request_failed",
      reason: "timeout",
    });
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("CLI always returns valid fail-open Codex SessionStart JSON", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./hydrate-context-pack.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      input: JSON.stringify({ cwd: process.cwd() }),
      env: { PATH: process.env.PATH },
    }
  );
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    continue: true,
    suppressOutput: true,
  });
});

test("detects direct execution across filesystem path aliases", () => {
  assert.equal(
    isDirectRun({
      argvPath: "/tmp/orgx/hydrate-context-pack.mjs",
      moduleUrl: "file:///private/tmp/orgx/hydrate-context-pack.mjs",
      realpathSyncImpl: (path) => path.replace(/^\/tmp\//, "/private/tmp/"),
    }),
    true
  );
});

test("atomically replaces a context-pack symlink without overwriting its target", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgx-codex-context-symlink-"));
  const projectDir = join(root, "project");
  const codexDir = join(projectDir, ".codex");
  const targetPath = join(root, "must-remain-unchanged.json");
  const packPath = join(codexDir, PACK_FILENAME);
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(targetPath, '{"protected":true}\n', { mode: 0o600 });
  symlinkSync(targetPath, packPath);
  try {
    const result = await main({
      env: { ORGX_API_KEY: "oxk_test", ORGX_WORKSPACE_ID: "workspace-1" },
      stdinText: JSON.stringify({ cwd: projectDir }),
      fetchImpl: async () => response({ frame: { anchor: "workspace-1" } }),
      spawnImpl: successfulWizard([]),
    });

    assert.equal(result.ok, true);
    assert.equal(readFileSync(targetPath, "utf8"), '{"protected":true}\n');
    assert.equal(
      JSON.parse(readFileSync(packPath, "utf8")).data.frame.anchor,
      "workspace-1"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "real Wizard activates the exact Codex project cwd",
  { skip: process.env.ORGX_RUN_WIZARD_INTEGRATION !== "1" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "orgx-codex-wizard-e2e-"));
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const env = {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      ORGX_API_KEY: "test_api_key_must_not_reach_wizard",
    };
    try {
      const activation = await activateSessionWorkContext({
        context: sessionWorkContext,
        projectDir,
        env,
      });
      assert.deepEqual(activation, {
        activated: true,
        reason: "wizard_activated",
      });

      const inspected = spawnSync(
        "orgx-wizard",
        ["sessions", "context", "show", "--cwd", projectDir, "--json"],
        {
          encoding: "utf8",
          env: credentialFreeWizardEnvironment(env),
        }
      );
      assert.equal(inspected.status, 0, inspected.stderr);
      const report = JSON.parse(inspected.stdout);
      assert.equal(report.ready, true);
      assert.equal(report.state, "ready");
      assert.equal(report.cwd, projectDir);
      assert.equal(report.context.intent.summary, sessionWorkContext.intent.summary);

      const cleared = await clearSessionWorkContext({ projectDir, env });
      assert.deepEqual(cleared, {
        cleared: true,
        reason: "wizard_cleared",
      });
      const afterClear = spawnSync(
        "orgx-wizard",
        ["sessions", "context", "show", "--cwd", projectDir, "--json"],
        {
          encoding: "utf8",
          env: credentialFreeWizardEnvironment(env),
        }
      );
      assert.equal(afterClear.status, 1);
      assert.equal(JSON.parse(afterClear.stdout).state, "missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "current installed Wizard incompatibility canary rejects app not_observed cost",
  {
    skip:
      process.env.ORGX_RUN_WIZARD_INCOMPATIBILITY_CANARY !== "1",
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "orgx-codex-wizard-canary-"));
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    try {
      const activation = await activateSessionWorkContext({
        context: appSessionWorkContext,
        projectDir,
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "config"),
        },
      });
      assert.deepEqual(activation, {
        activated: false,
        reason: "wizard_rejected",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
