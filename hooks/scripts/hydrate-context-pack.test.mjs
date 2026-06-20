import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, buildPackRequest } from "./hydrate-context-pack.mjs";

test("resolveConfig requires api key + initiative", () => {
  assert.equal(resolveConfig({}, null), null);
  assert.deepEqual(resolveConfig({ ORGX_API_KEY: "k", ORGX_INITIATIVE_ID: "i1" }, null), {
    apiKey: "k", baseUrl: "https://useorgx.com", initiativeId: "i1",
  });
});
test("buildPackRequest targets the endpoint with bearer auth", () => {
  const r = buildPackRequest({ apiKey: "k", baseUrl: "https://useorgx.com/", initiativeId: "i1" });
  assert.equal(r.url, "https://useorgx.com/api/client/context-pack");
  assert.equal(r.headers.authorization, "Bearer k");
  assert.deepEqual(JSON.parse(r.body), { initiative_id: "i1" });
});
