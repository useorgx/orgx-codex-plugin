#!/usr/bin/env node
/**
 * OrgX Codex plugin: emit the execution graph (the WEG keystone) from the
 * Work Graph reconcile path.
 *
 * Codex's lifecycle hooks SPOOL events to a local outbox (they do not POST
 * live), and there is no native session-stop hook bundle. The plugin's path to
 * get that data to OrgX is `orgx-work-graph-reconcile.mjs --post`. So the
 * architecturally-correct place to emit the execution graph is the SAME
 * reconcile pass: derive a deterministic graph from the spooled records and
 * POST it to /api/client/live/execution-graph, right alongside the Work Graph
 * report.
 *
 * The records are the real signal — one `step` node per spooled tool event;
 * a *_failure event marks that step `failed`. No data is synthesized. Emits NO
 * depends_on edges: spool order is not a verified dependency, and asserting one
 * would make the backend derive a false dependency_violation per edge.
 *
 * OPT-IN: maybeEmitExecutionGraph() no-ops unless ORGX_EMIT_EXECUTION_GRAPH is
 * truthy and an initiative + key are present. Best-effort: never throws into the
 * reconcile flow.
 */

const SCHEMA_VERSION = "1.0.0";
const VALID_SOURCE_CLIENTS = new Set([
  "openclaw",
  "codex",
  "claude-code",
  "chatgpt",
  "cursor",
  "web-ui",
  "api",
]);

const isTruthy = (v) =>
  typeof v === "string" && ["1", "true", "yes", "on"].includes(v.toLowerCase());

export function pickString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

const clampStr = (s, max) => (typeof s === "string" ? s.slice(0, max) : undefined);

const isToolEvent = (event) => /tool/i.test(String(event || ""));
const isFailureEvent = (event) => /fail/i.test(String(event || ""));

/**
 * Derive a real execution graph from normalized hook-outbox records. One root
 * `task` node + one `step` node per spooled tool event (failure -> failed).
 * No depends_on edges. Returns { nodes, edges }.
 */
export function deriveGraphFromRecords(records, opts = {}) {
  const maxNodes = Math.max(1, opts.maxNodes ?? 40);
  const list = Array.isArray(records) ? records : [];

  const nodes = [
    {
      id: "session",
      type: "task",
      title: clampStr(opts.summary, 500) || "Codex session",
      status: "completed",
      requires_evidence: false,
    },
  ];

  const toolRecords = list.filter(
    (r) => r && isToolEvent(r.event) && pickString(r.summary?.tool_name)
  );

  for (const [i, record] of toolRecords.slice(-(maxNodes - 1)).entries()) {
    nodes.push({
      id: `step-${i + 1}`,
      type: "step",
      title: clampStr(pickString(record.summary?.tool_name), 500) || "tool",
      status: isFailureEvent(record.event) ? "failed" : "completed",
      requires_evidence: false,
    });
  }

  return { nodes, edges: [] };
}

/** Build the runtime execution-graph event payload. Pure. */
export function buildExecutionGraphEvent({ records, env, sessionId }) {
  const initiativeId = pickString(env.ORGX_INITIATIVE_ID);
  if (!initiativeId) return null;

  let sourceClient = pickString(env.ORGX_SOURCE_CLIENT) || "codex";
  if (!VALID_SOURCE_CLIENTS.has(sourceClient)) sourceClient = "codex";

  const maxNodes = Number.parseInt(env.ORGX_EMIT_MAX_NODES ?? "", 10);
  const { nodes, edges } = deriveGraphFromRecords(records, {
    maxNodes: Number.isFinite(maxNodes) ? maxNodes : 40,
    summary: env.ORGX_EMIT_SUMMARY,
  });

  const event = {
    schema_version: SCHEMA_VERSION,
    initiative_id: initiativeId,
    source_client: sourceClient,
    summary: clampStr(
      pickString(env.ORGX_EMIT_SUMMARY) ||
        `${sourceClient} session: ${nodes.length - 1} step(s)`,
      2000
    ),
    nodes,
    edges,
    trust_events: [],
    metadata: { emitter: "orgx-codex-plugin", via: "work-graph-reconcile" },
  };

  const runId = pickString(env.ORGX_RUN_ID);
  if (runId) {
    event.run_id = runId;
  } else {
    event.correlation_id = clampStr(
      pickString(sessionId, env.ORGX_CORRELATION_ID) ||
        `${sourceClient}-${initiativeId}`,
      120
    );
  }

  return event;
}

/** POST the execution-graph event. Mirrors postWorkGraphReport's conventions. */
export async function postExecutionGraph({
  event,
  baseUrl,
  apiKey,
  userId,
  fetchImpl = fetch,
}) {
  const normalizedBaseUrl = pickString(baseUrl, "https://www.useorgx.com").replace(/\/+$/, "");
  const token = pickString(apiKey);
  if (!token) throw new Error("ORGX_API_KEY is required to emit the execution graph");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const uid = pickString(userId);
  if (uid) headers["X-Orgx-User-Id"] = uid;

  const response = await fetchImpl(`${normalizedBaseUrl}/api/client/live/execution-graph`, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
  });
  const body = await response.json().catch(async () => ({
    text: await response.text().catch(() => ""),
  }));
  if (!response.ok) {
    throw new Error(`execution-graph emit failed with HTTP ${response.status}`);
  }
  return body && typeof body === "object" && body.data ? body.data : body;
}

/**
 * Best-effort emit from the reconcile --post path. OPT-IN and non-throwing:
 * returns a small status object describing what happened.
 */
export async function maybeEmitExecutionGraph({
  records,
  env = process.env,
  args = {},
  fetchImpl = fetch,
}) {
  if (!isTruthy(env.ORGX_EMIT_EXECUTION_GRAPH)) return { skipped: "not_enabled" };

  const apiKey = pickString(args.api_key, args["api-key"], env.ORGX_API_KEY);
  if (!apiKey) return { skipped: "missing_api_key" };
  if (!pickString(env.ORGX_INITIATIVE_ID)) return { skipped: "missing_initiative_id" };

  const sessionId = pickString(
    Array.isArray(records) ? records.find((r) => r && r.session_id)?.session_id : undefined,
    env.ORGX_SESSION_ID
  );

  const event = buildExecutionGraphEvent({ records, env, sessionId });
  if (!event) return { skipped: "no_event" };

  try {
    const data = await postExecutionGraph({
      event,
      baseUrl: pickString(args.base_url, args["base-url"], env.ORGX_BASE_URL),
      apiKey,
      userId: pickString(env.ORGX_USER_ID),
      fetchImpl,
    });
    return { emitted: true, nodes: event.nodes.length, data };
  } catch (error) {
    return { skipped: "emit_failed", error: error instanceof Error ? error.message : String(error) };
  }
}
