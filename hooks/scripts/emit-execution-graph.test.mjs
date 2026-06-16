import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveGraphFromRecords,
  buildExecutionGraphEvent,
  maybeEmitExecutionGraph,
} from "./emit-execution-graph.mjs";

const records = [
  { event: "session_start", source_client: "codex", session_id: "s1", summary: {} },
  { event: "post_tool_use", source_client: "codex", session_id: "s1", summary: { tool_name: "Edit" } },
  { event: "post_tool_use", source_client: "codex", session_id: "s1", summary: { tool_name: "Bash" } },
  { event: "post_tool_use_failure", source_client: "codex", session_id: "s1", summary: { tool_name: "Bash" } },
];

test("deriveGraphFromRecords: root + one step per tool event, no edges", () => {
  const { nodes, edges } = deriveGraphFromRecords(records);
  assert.equal(nodes.length, 4); // session + 3 tool events
  assert.equal(nodes[0].id, "session");
  assert.equal(nodes[1].title, "Edit");
  assert.deepEqual(edges, []);
});

test("deriveGraphFromRecords: a *_failure event marks that step failed", () => {
  const { nodes } = deriveGraphFromRecords(records);
  assert.equal(nodes[2].status, "completed"); // Bash post_tool_use
  assert.equal(nodes[3].status, "failed"); // Bash post_tool_use_failure
});

test("deriveGraphFromRecords: non-tool/no-tool_name records are ignored", () => {
  const { nodes } = deriveGraphFromRecords([
    { event: "session_start", summary: {} },
    { event: "subagent_start", summary: {} },
  ]);
  assert.equal(nodes.length, 1); // only the root
});

test("deriveGraphFromRecords: empty input still yields one honest root node", () => {
  const { nodes, edges } = deriveGraphFromRecords([]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].status, "completed");
  assert.deepEqual(edges, []);
});

test("buildExecutionGraphEvent: null without an initiative id", () => {
  assert.equal(buildExecutionGraphEvent({ records, env: {}, sessionId: "s1" }), null);
});

test("buildExecutionGraphEvent: cursor source, correlation_id run identity", () => {
  const event = buildExecutionGraphEvent({
    records,
    env: { ORGX_INITIATIVE_ID: "9e52303c-430a-4472-a5ae-ec3ab169e4f3" },
    sessionId: "s1",
  });
  assert.equal(event.source_client, "codex");
  assert.equal(event.run_id, undefined);
  assert.equal(event.correlation_id, "s1");
  assert.deepEqual(event.trust_events, []);
});

test("maybeEmitExecutionGraph: no-op unless ORGX_EMIT_EXECUTION_GRAPH set", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const res = await maybeEmitExecutionGraph({
    records,
    env: { ORGX_INITIATIVE_ID: "x", ORGX_API_KEY: "k" },
    fetchImpl,
  });
  assert.equal(res.skipped, "not_enabled");
  assert.equal(called, false);
});

test("maybeEmitExecutionGraph: enabled + configured POSTs the derived graph", async () => {
  let postedUrl = null;
  let postedBody = null;
  const fetchImpl = async (url, init) => {
    postedUrl = url;
    postedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data: { execution_graph_fingerprint: "xgf_x" } }) };
  };
  const res = await maybeEmitExecutionGraph({
    records,
    env: {
      ORGX_EMIT_EXECUTION_GRAPH: "1",
      ORGX_API_KEY: "k",
      ORGX_USER_ID: "u",
      ORGX_INITIATIVE_ID: "9e52303c-430a-4472-a5ae-ec3ab169e4f3",
      ORGX_BASE_URL: "https://useorgx.com",
    },
    fetchImpl,
  });
  assert.equal(res.emitted, true);
  assert.equal(postedUrl, "https://useorgx.com/api/client/live/execution-graph");
  assert.equal(postedBody.source_client, "codex");
  assert.equal(postedBody.initiative_id, "9e52303c-430a-4472-a5ae-ec3ab169e4f3");
});

test("maybeEmitExecutionGraph: a failing POST never throws", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const res = await maybeEmitExecutionGraph({
    records,
    env: { ORGX_EMIT_EXECUTION_GRAPH: "1", ORGX_API_KEY: "k", ORGX_INITIATIVE_ID: "x" },
    fetchImpl,
  });
  assert.equal(res.skipped, "emit_failed");
});
