#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    args[key] = rest.length > 0 ? rest.join("=") : "true";
  }
  return args;
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function summarize(payload) {
  const toolName = pickString(
    payload.tool_name,
    payload.toolName,
    payload.tool?.name,
    payload.name
  );
  const prompt = pickString(payload.prompt);
  return {
    tool_name: toolName,
    prompt_chars: prompt ? prompt.length : undefined,
    payload_keys: Object.keys(payload).slice(0, 40),
  };
}

const args = parseArgs(process.argv.slice(2));
const payload = parseJson(await readStdin());
const outbox = pickString(
  process.env.ORGX_WIZARD_HOOK_OUTBOX,
  args.outbox,
  join(homedir(), ".config", "useorgx", "wizard", "hooks", "events.jsonl")
);
const event = pickString(
  args.event,
  payload.hook_event_name,
  payload.hookEventName,
  payload.event,
  payload.eventName,
  "unknown"
);
const sourceClient = pickString(args.source_client, args["source-client"], "codex");

const record = {
  schema_version: "2026-05-07",
  source: "orgx_codex_plugin_runtime_hook",
  source_client: sourceClient,
  event,
  session_id: pickString(
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId
  ),
  turn_id: pickString(payload.turn_id, payload.turnId),
  cwd: pickString(payload.cwd, payload.working_directory, payload.workspace, process.cwd()),
  transcript_path: pickString(payload.transcript_path, payload.transcriptPath),
  timestamp: new Date().toISOString(),
  summary: summarize(payload),
};

try {
  mkdirSync(dirname(outbox), { recursive: true, mode: 0o700 });
  appendFileSync(outbox, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
} catch {
  // Hooks must never break the user's Codex session.
}

process.exit(0);
