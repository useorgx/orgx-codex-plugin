#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    args[key] = rest.length > 0 ? rest.join("=") : "true";
  }
  return args;
}

export function pickString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function summarizeHookPayload(payload, args = {}) {
  const toolName = pickString(
    args.tool_name,
    payload.tool_name,
    payload.toolName,
    payload.tool?.name,
    payload.name
  );
  const prompt = pickString(payload.prompt, payload.user_prompt, payload.message);
  return {
    tool_name: toolName,
    prompt_chars: prompt ? prompt.length : undefined,
    payload_keys: Object.keys(payload).slice(0, 40),
  };
}

export function buildHookOutboxRecord({
  sourceClient,
  event,
  args,
  payload,
  now,
}) {
  const current = now();
  return {
    schema_version: "2026-05-07",
    source: "orgx_codex_plugin_runtime_hook",
    source_client: sourceClient,
    event,
    session_id: pickString(
      args.session_id,
      payload.session_id,
      payload.sessionId,
      payload.conversation_id,
      payload.conversationId,
      payload.thread_id,
      payload.threadId
    ),
    turn_id: pickString(args.turn_id, payload.turn_id, payload.turnId),
    cwd: pickString(payload.cwd, payload.working_directory, payload.workspace, process.cwd()),
    transcript_path: pickString(payload.transcript_path, payload.transcriptPath),
    timestamp: current instanceof Date
      ? current.toISOString()
      : new Date(current).toISOString(),
    summary: summarizeHookPayload(payload, args),
  };
}

export function appendHookOutboxRecord(record, { args = {}, env = process.env } = {}) {
  const outbox = pickString(
    env.ORGX_WIZARD_HOOK_OUTBOX,
    args.outbox,
    join(homedir(), ".config", "useorgx", "wizard", "hooks", "events.jsonl")
  );
  try {
    mkdirSync(dirname(outbox), { recursive: true, mode: 0o700 });
    appendFileSync(outbox, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  now = () => new Date(),
  readStdinImpl = readStdin,
} = {}) {
  const args = parseArgs(argv);
  const payload = parseJson(await readStdinImpl());
  const event = pickString(
    args.event,
    payload.hook_event_name,
    payload.hookEventName,
    payload.event,
    payload.eventName,
    "unknown"
  );
  const sourceClient = pickString(args.source_client, args["source-client"], "codex");
  const record = buildHookOutboxRecord({
    sourceClient,
    event,
    args,
    payload,
    now,
  });
  return {
    ok: true,
    hook_outbox_written: appendHookOutboxRecord(record, { args, env }),
    record,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(0);
    });
}
