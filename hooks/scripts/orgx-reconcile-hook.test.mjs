import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "./orgx-reconcile-hook.mjs";

const NOW = "2026-05-07T12:00:00.000Z";

function hookRecord() {
  return {
    schema_version: "2026-05-07",
    source: "orgx_codex_plugin_runtime_hook",
    source_client: "codex",
    event: "Stop",
    session_id: "session-1",
    turn_id: "turn-1",
    cwd: "/repo",
    timestamp: NOW,
    summary: {
      tool_name: "mcp__orgx__orgx_register_artifact",
      payload_keys: ["tool_name"],
    },
  };
}

test("Stop hook writes a local Work Graph report without OrgX credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-stop-reconcile-"));
  const outbox = join(dir, "events.jsonl");
  const output = join(dir, "latest.json");
  writeFileSync(outbox, `${JSON.stringify(hookRecord())}\n`, "utf8");

  const result = await main({
    argv: [
      "--event=Stop",
      "--source_client=codex",
      `--outbox=${outbox}`,
      `--output=${output}`,
    ],
    env: {},
    now: () => new Date(NOW),
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.records_read, 1);
  assert.equal(result.posted, false);
  assert.equal(existsSync(output), true);
  const written = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(written.report.raw_transcripts_sent, false);
  assert.equal(written.work_graph_fingerprint, result.work_graph_fingerprint);
});

test("Stop hook does not post unless posting is explicitly enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-stop-reconcile-no-post-"));
  const outbox = join(dir, "events.jsonl");
  const output = join(dir, "latest.json");
  writeFileSync(outbox, `${JSON.stringify(hookRecord())}\n`, "utf8");
  let calls = 0;

  const result = await main({
    argv: [
      "--event=Stop",
      `--outbox=${outbox}`,
      `--output=${output}`,
      "--api-key=oxk_test_token",
    ],
    env: {},
    now: () => new Date(NOW),
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.posted, false);
  assert.equal(calls, 0);
});

test("Stop hook posts only with opt-in and an API key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-stop-reconcile-post-"));
  const outbox = join(dir, "events.jsonl");
  const output = join(dir, "latest.json");
  writeFileSync(outbox, `${JSON.stringify(hookRecord())}\n`, "utf8");
  const calls = [];

  const result = await main({
    argv: [
      "--event=Stop",
      `--outbox=${outbox}`,
      `--output=${output}`,
      "--base-url=https://example.test",
    ],
    env: {
      ORGX_HOOK_RECONCILE_POST: "true",
      ORGX_API_KEY: "oxk_test_token",
    },
    now: () => new Date(NOW),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ ok: true, id: "posted-1" }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.posted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/api/client/work-graph/reports");
  assert.equal(calls[0].options.headers.Authorization, "Bearer oxk_test_token");
});

test("Stop hook skips posting when opt-in is enabled without an API key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-stop-reconcile-post-skip-"));
  const outbox = join(dir, "events.jsonl");
  const output = join(dir, "latest.json");
  writeFileSync(outbox, `${JSON.stringify(hookRecord())}\n`, "utf8");
  let calls = 0;

  const result = await main({
    argv: ["--event=Stop", `--outbox=${outbox}`, `--output=${output}`],
    env: { ORGX_WIZARD_HOOK_RECONCILE_POST: "true" },
    now: () => new Date(NOW),
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.posted, false);
  assert.equal(result.post_skipped_reason, "ORGX_API_KEY is required for Stop-hook posting");
  assert.equal(calls, 0);
});
