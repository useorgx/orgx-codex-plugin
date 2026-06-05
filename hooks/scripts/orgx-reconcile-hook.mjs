#!/usr/bin/env node

import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import { main as reconcileMain, parseArgs } from "./orgx-work-graph-reconcile.mjs";

const DEFAULT_REPORT_OUTPUT = join(
  homedir(),
  ".config",
  "useorgx",
  "wizard",
  "hooks",
  "reports",
  "latest-work-graph-report.json"
);

function pickString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isEnabled(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function buildReconcileArgv({ args, env }) {
  const outbox = pickString(args.outbox, env.ORGX_WIZARD_HOOK_OUTBOX);
  const output = pickString(
    args.output,
    env.ORGX_WIZARD_HOOK_REPORT_OUTPUT,
    DEFAULT_REPORT_OUTPUT
  );
  const cwd = pickString(args.cwd, env.ORGX_WORKSPACE_CWD, process.cwd());
  const maxRecords = pickString(args.max_records, args["max-records"]);
  const baseUrl = pickString(args.base_url, args["base-url"], env.ORGX_BASE_URL);
  const apiKey = pickString(args.api_key, args["api-key"], env.ORGX_API_KEY);
  const shouldPost =
    isEnabled(args.post) ||
    isEnabled(env.ORGX_HOOK_RECONCILE_POST) ||
    isEnabled(env.ORGX_WIZARD_HOOK_RECONCILE_POST);

  const argv = [`--output=${output}`, `--cwd=${cwd}`];
  if (outbox) argv.push(`--outbox=${outbox}`);
  if (maxRecords) argv.push(`--max-records=${maxRecords}`);
  if (baseUrl) argv.push(`--base-url=${baseUrl}`);
  if (shouldPost && apiKey) {
    argv.push("--post", `--api-key=${apiKey}`);
  }

  return {
    argv,
    output,
    shouldPost,
    postSkippedReason:
      shouldPost && !apiKey
        ? "ORGX_API_KEY is required for Stop-hook posting"
        : undefined,
  };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  now = () => new Date(),
  fetchImpl = fetch,
} = {}) {
  const args = parseArgs(argv);
  const event = pickString(args.event, args.hook_event_name, "Stop");
  if (event !== "Stop") {
    return {
      ok: true,
      skipped: true,
      reason: "reconciliation only runs on Stop hooks",
    };
  }

  const reconcile = buildReconcileArgv({ args, env });
  try {
    const result = await reconcileMain({
      argv: reconcile.argv,
      env,
      now,
      fetchImpl,
    });
    return {
      ok: true,
      skipped: false,
      report_output: reconcile.output,
      records_read: result.records_read,
      work_graph_fingerprint: result.work_graph_fingerprint,
      hydration_key: result.hydration_key,
      posted: Boolean(result.posted),
      post_skipped_reason: reconcile.postSkippedReason,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      report_output: reconcile.output,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
