#!/usr/bin/env node
/**
 * SessionStart: hydrate the OrgX AgentContextPack (M adapter — Codex).
 *
 * Codex is notify/MCP-based; this best-effort SessionStart hook fetches the
 * compiled pack for the active initiative (POST /api/client/context-pack) and
 * writes .codex/orgx-context-pack.json (0600) so the agent starts briefed. Never
 * fails the session. The MCP backbone also returns the pack on first orgx_inspect
 * call, so hydration is guaranteed either way.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const PACK_FILENAME = "orgx-context-pack.json";
const CONFIG_PATHS = [[".codex", "orgx.local.json"], [".claude", "orgx.local.json"]];

export function pickString(...values) {
  for (const v of values) if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return undefined;
}

export function readLocalConfig(projectDir) {
  for (const parts of CONFIG_PATHS) {
    const path = join(projectDir, ...parts);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* next */ }
  }
  return null;
}

export function resolveConfig(env = {}, localConfig = null) {
  const apiKey = pickString(env.ORGX_API_KEY, localConfig?.apiKey, localConfig?.api_key);
  const baseUrl = pickString(env.ORGX_BASE_URL, localConfig?.baseUrl, localConfig?.base_url) || "https://useorgx.com";
  const initiativeId = pickString(env.ORGX_INITIATIVE_ID, localConfig?.initiativeId, localConfig?.initiative_id);
  if (!apiKey || !initiativeId) return null;
  return { apiKey, baseUrl, initiativeId };
}

export function buildPackRequest(config) {
  return {
    url: `${config.baseUrl.replace(/\/$/, "")}/api/client/context-pack`,
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ initiative_id: config.initiativeId }),
  };
}

async function main() {
  try {
    const projectDir = pickString(process.env.CODEX_PROJECT_DIR, process.cwd()) ?? process.cwd();
    const config = resolveConfig(process.env, readLocalConfig(projectDir));
    if (!config) return;
    const req = buildPackRequest(config);
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) return;
    const payload = await res.json().catch(() => null);
    const data = payload?.data ?? null;
    if (!data) return;
    const dir = join(projectDir, ".codex");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, PACK_FILENAME);
    writeFileSync(out, JSON.stringify({ fetchedAt: new Date().toISOString(), data }, null, 2), { mode: 0o600 });
    try { chmodSync(out, 0o600); } catch { /* best-effort */ }
  } catch { /* never fail the session */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().finally(() => process.exit(0));
}
