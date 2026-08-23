import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHookOutboxRecord,
  main,
  parseArgs,
  parseJson,
  summarizeHookPayload,
} from "./orgx-session-hook.mjs";

test("parseArgs handles key/value and boolean flags", () => {
  const parsed = parseArgs(["--event=Stop", "--source_client=codex", "--dry_run"]);
  assert.equal(parsed.event, "Stop");
  assert.equal(parsed.source_client, "codex");
  assert.equal(parsed.dry_run, "true");
});

test("parseJson returns an object for valid JSON only", () => {
  assert.deepEqual(parseJson('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJson("[]"), {});
  assert.deepEqual(parseJson("not json"), {});
});

test("summarizeHookPayload records safe compact evidence", () => {
  const summary = summarizeHookPayload(
    { session_id: "s1", prompt: "ship this", tool: { name: "read_file" } },
    {}
  );
  assert.equal(summary.tool_name, "read_file");
  assert.equal(summary.prompt_chars, 9);
  assert.deepEqual(summary.payload_keys, ["session_id", "prompt", "tool"]);
});

test("buildHookOutboxRecord captures Codex lifecycle context", () => {
  const record = buildHookOutboxRecord({
    sourceClient: "codex",
    event: "PostToolUse",
    args: {},
    payload: {
      thread_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/repo",
      transcript_path: "/tmp/transcript.jsonl",
    },
    now: () => new Date("2026-05-07T12:00:00.000Z"),
  });

  assert.equal(record.source, "orgx_codex_plugin_runtime_hook");
  assert.equal(record.source_client, "codex");
  assert.equal(record.session_id, "thread-1");
  assert.equal(record.turn_id, "turn-1");
  assert.equal(record.cwd, "/repo");
  assert.equal(record.transcript_path, "/tmp/transcript.jsonl");
});

test("main writes the hook outbox without requiring OrgX credentials", async () => {
  const outbox = join(mkdtempSync(join(tmpdir(), "orgx-codex-hook-")), "events.jsonl");
  const result = await main({
    argv: ["--event=SessionStart", "--source_client=codex"],
    env: { ORGX_WIZARD_HOOK_OUTBOX: outbox },
    now: () => new Date("2026-05-07T12:00:00.000Z"),
    readStdinImpl: async () => JSON.stringify({ session_id: "session-1", cwd: "/repo" }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.hook_outbox_written, true);
  const line = readFileSync(outbox, "utf8").trim();
  const record = JSON.parse(line);
  assert.equal(record.session_id, "session-1");
  assert.equal(record.cwd, "/repo");
});

test("configured Codex Stop hook runs local Work Graph reconciliation", () => {
  const hooks = JSON.parse(readFileSync(new URL("../codex/hooks.json", import.meta.url), "utf8"));
  const stopGroups = hooks.hooks.Stop;
  const stopHandlers = stopGroups.flatMap((group) => group.hooks ?? []);

  assert.ok(
    stopHandlers.some((hook) =>
      hook.command.includes("hooks/scripts/orgx-session-hook.mjs")
    ),
    "Stop should persist a compact hook outbox record"
  );
  assert.ok(
    stopHandlers.some((hook) =>
      hook.command.includes("hooks/scripts/orgx-reconcile-hook.mjs")
    ),
    "Stop should run local Work Graph reconciliation"
  );
});

test("configured Codex hooks use canonical matcher groups and typed handlers", () => {
  const config = JSON.parse(
    readFileSync(new URL("../codex/hooks.json", import.meta.url), "utf8")
  );

  for (const [eventName, groups] of Object.entries(config.hooks)) {
    assert.ok(groups.length > 0, `${eventName} should define at least one matcher group`);
    for (const group of groups) {
      assert.equal(group.matcher, "", `${eventName} should use the universal matcher`);
      assert.ok(group.hooks.length > 0, `${eventName} should define command handlers`);
      for (const hook of group.hooks) {
        assert.equal(hook.type, "command");
        assert.equal(typeof hook.command, "string");
        assert.ok(hook.command.length > 0);
      }
    }
  }
});
