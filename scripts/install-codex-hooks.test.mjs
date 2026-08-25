import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildWizardInstallArgs,
  installCodexHooks,
  resolveWorkEpisodeCapture,
} from "./install-codex-hooks.mjs";

test("runs through an npm-style bin symlink", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "orgx-codex-install-bin-"));
  const cliPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "install-codex-hooks.mjs"
  );
  const binPath = join(tempDir, "orgx-codex-install-hooks");
  try {
    symlinkSync(cliPath, binPath);
    const result = spawnSync(process.execPath, [binPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        ORGX_SESSION_WORK_EPISODE_CAPTURE: "full-transcript",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /metadata-only or bounded/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("defaults plugin-initiated hook setup to metadata-only", () => {
  assert.equal(resolveWorkEpisodeCapture({}), "metadata-only");
  assert.deepEqual(buildWizardInstallArgs("metadata-only"), [
    "hooks",
    "install",
    "--targets",
    "codex",
    "--work-capture",
    "metadata-only",
    "--json",
  ]);
});

test("honors explicit bounded WorkEpisode consent", () => {
  assert.equal(
    resolveWorkEpisodeCapture({ ORGX_SESSION_WORK_EPISODE_CAPTURE: "bounded" }),
    "bounded"
  );
});

test("rejects an unknown capture mode instead of falling back to bounded", () => {
  assert.throws(
    () =>
      resolveWorkEpisodeCapture({
        ORGX_SESSION_WORK_EPISODE_CAPTURE: "full-transcript",
      }),
    /metadata-only or bounded/
  );
});

test("delegates to Wizard without forwarding credentials", () => {
  const calls = [];
  const result = installCodexHooks({
    env: {
      PATH: "/bin",
      ORGX_API_KEY: "test_api_key_must_not_escape",
      ORGX_GATEWAY_KEY: "test_gateway_key_must_not_escape",
      DATABASE_URL: "postgres://must:not@escape.invalid/db",
      XDG_CONFIG_HOME: "/tmp/orgx-wizard-config",
      ORGX_SESSION_WORK_EPISODE_CAPTURE: "bounded",
    },
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '{"installed":true}', stderr: "" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.capture, "bounded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "orgx-wizard");
  assert.deepEqual(calls[0].args, buildWizardInstallArgs("bounded"));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.ORGX_API_KEY, undefined);
  assert.equal(calls[0].options.env.ORGX_GATEWAY_KEY, undefined);
  assert.equal(calls[0].options.env.DATABASE_URL, undefined);
  assert.equal(calls[0].options.env.XDG_CONFIG_HOME, "/tmp/orgx-wizard-config");
});

test("reports Wizard capture-policy incompatibility without retrying bounded", () => {
  let calls = 0;
  const result = installCodexHooks({
    env: { ORGX_SESSION_WORK_EPISODE_CAPTURE: "metadata-only" },
    spawnSyncImpl: (_command, args) => {
      calls += 1;
      assert.deepEqual(args, buildWizardInstallArgs("metadata-only"));
      return {
        status: 1,
        stdout: "",
        stderr: "error: unknown option '--work-capture'",
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wizard_rejected_capture_policy");
  assert.match(result.detail, /unknown option '--work-capture'/);
});
