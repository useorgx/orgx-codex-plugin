#!/usr/bin/env node

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const WORK_GRAPH_SCHEMA_VERSION = "2.0.0";
const WORK_GRAPH_FINGERPRINT_VERSION = "wgf_v1";
const DEFAULT_OUTBOX = join(
  homedir(),
  ".config",
  "useorgx",
  "wizard",
  "hooks",
  "events.jsonl",
);
const SOURCE_CLIENTS = new Set([
  "codex",
  "claude",
  "claude-code",
  "cursor",
  "opencode",
  "goose",
  "openclaw",
  "slack",
  "mcp",
  "orgx_runtime_hook",
  "github",
  "linear",
  "gmail",
  "calendar",
  "notion",
  "docs",
  "manual",
  "wizard",
  "api",
  "unknown",
]);
const TRANSCRIPT_SIGNAL_LIMIT = 200;
const DEFAULT_TRANSCRIPT_ROOTS = [
  {
    source_client: "codex",
    path: join(homedir(), ".codex", "sessions"),
  },
  {
    source_client: "claude-code",
    path: join(homedir(), ".claude", "projects"),
  },
  {
    source_client: "cursor",
    path: join(homedir(), ".cursor", "projects"),
  },
  {
    source_client: "openclaw",
    path: join(homedir(), ".openclaw"),
  },
  {
    source_client: "opencode",
    path: join(homedir(), ".opencode"),
  },
];
const TRANSCRIPT_SIGNAL_DEFS = [
  {
    kind: "decision",
    findingType: "decision",
    title: "Decision signals found in CLI transcripts",
    summary:
      "Summary-only transcript scan found decision-like turns that should be reviewed for durable OrgX decisions.",
    pattern:
      /\b(decision|decided|choose|chosen|selected|going with|use trigger|stop referencing|default to|ship|merge|approved)\b/i,
  },
  {
    kind: "artifact",
    findingType: "artifact",
    title: "Artifact and PR signals found in CLI transcripts",
    summary:
      "Summary-only transcript scan found artifact, branch, commit, PR, or report signals that should be reviewed as proof.",
    pattern:
      /\b(artifact|pull request|pr #|branch|commit|diff|screenshot|report|implemented|created|verified)\b/i,
  },
  {
    kind: "goal",
    findingType: "goal",
    title: "Goal and priority signals found in CLI transcripts",
    summary:
      "Summary-only transcript scan found goal, initiative, priority, or next-action signals across local CLI sessions.",
    pattern:
      /\b(goal|priority|initiative|next action|top priorit|what'?s left|remaining|objective)\b/i,
  },
  {
    kind: "blocker",
    findingType: "blocker",
    title: "Blocker and gap signals found in CLI transcripts",
    summary:
      "Summary-only transcript scan found blocker, missing-work, failure, or gap signals that should feed operator priorities.",
    pattern:
      /\b(blocked|blocker|missing|gap|not working|failing|failed|needs|unverified|not clear|not there yet)\b/i,
  },
];
const TRANSCRIPT_TEXT_KEYS = new Set([
  "body",
  "content",
  "markdown",
  "message",
  "result",
  "summary",
  "text",
  "title",
]);
const TRANSCRIPT_SKIP_KEY_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /base[_-]?instructions/i,
  /cookie/i,
  /developer[_-]?instructions/i,
  /encrypted/i,
  /instructions/i,
  /memory/i,
  /password/i,
  /secret/i,
  /signature/i,
  /storage[_-]?state/i,
  /system/i,
  /token/i,
];

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [rawKey, ...rest] = arg.slice(2).split("=");
    const key = rawKey.trim();
    if (!key) continue;
    if (rest.length > 0) {
      args[key] = rest.join("=");
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      args[key] = argv[index + 1];
      index += 1;
    } else {
      args[key] = "true";
    }
  }
  return args;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

export function pickString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashString(value, length = 24) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function stableHash(value, length = 24) {
  return hashString(stableJson(value), length);
}

function slug(value, fallback = "unknown") {
  return (
    pickString(value)
      ?.toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || fallback
  );
}

function toIsoTimestamp(value, fallback) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return fallback;
}

export function normalizeSourceClient(value) {
  const raw = pickString(value)?.toLowerCase() || "unknown";
  if (raw === "claude_code") return "claude-code";
  if (raw === "claudecode") return "claude-code";
  if (raw === "open-claw") return "openclaw";
  return SOURCE_CLIENTS.has(raw) ? raw : "unknown";
}

function sourceLabel(sourceClient) {
  return (
    {
      codex: "Codex",
      "claude-code": "Claude Code",
      claude: "Claude",
      openclaw: "OpenClaw",
      orgx_runtime_hook: "OrgX runtime hook",
      mcp: "MCP",
      wizard: "OrgX wizard",
    }[sourceClient] || sourceClient
  );
}

function eventPhase(event) {
  const normalized = String(event || "").toLowerCase();
  if (normalized.includes("stop") || normalized.includes("complete")) {
    return "completed";
  }
  if (normalized.includes("block") || normalized.includes("error")) {
    return "blocked";
  }
  if (normalized.includes("permission")) return "blocked";
  return "in_progress";
}

function recordSortKey(record) {
  return [
    record.timestamp || "",
    record.source_client || "",
    record.session_id || "",
    record.event || "",
    record.turn_id || "",
  ].join("\u0000");
}

function compactRecords(records, maxRecords) {
  if (!Number.isFinite(maxRecords) || maxRecords <= 0) return records;
  if (records.length <= maxRecords) return records;

  const sorted = [...records].sort((a, b) =>
    recordSortKey(a).localeCompare(recordSortKey(b)),
  );
  const selected = sorted.slice(-maxRecords);
  const selectedSources = new Set(
    selected.map((record) => record.source_client),
  );
  const sourceClients = [
    ...new Set(sorted.map((record) => record.source_client).filter(Boolean)),
  ];
  for (const sourceClient of sourceClients) {
    if (selectedSources.has(sourceClient)) continue;
    const representative = [...sorted]
      .reverse()
      .find((record) => record.source_client === sourceClient);
    if (!representative) continue;
    const selectedCounts = selected.reduce((counts, record) => {
      counts[record.source_client] = (counts[record.source_client] || 0) + 1;
      return counts;
    }, {});
    const replaceIndex = selected.findIndex(
      (record) => selectedCounts[record.source_client] > 1,
    );
    if (replaceIndex >= 0) {
      selected[replaceIndex] = representative;
      selectedSources.add(sourceClient);
    }
  }

  return selected.sort((a, b) =>
    recordSortKey(a).localeCompare(recordSortKey(b)),
  );
}

export function normalizeHookRecord(record, index = 0) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const sourceClient = normalizeSourceClient(record.source_client);
  const sessionId = pickString(record.session_id, record.sessionId);
  const cwd = pickString(record.cwd, record.workspace, process.cwd());
  const timestamp = toIsoTimestamp(
    record.timestamp,
    "1970-01-01T00:00:00.000Z",
  );
  const summary =
    record.summary &&
    typeof record.summary === "object" &&
    !Array.isArray(record.summary)
      ? record.summary
      : {};
  return {
    schema_version: pickString(record.schema_version, "2026-05-07"),
    source: pickString(record.source, "orgx_runtime_hook"),
    source_client: sourceClient,
    event: pickString(record.event, "unknown"),
    session_id: sessionId || `unknown-session-${index + 1}`,
    turn_id: pickString(record.turn_id, record.turnId),
    cwd,
    transcript_path: pickString(record.transcript_path, record.transcriptPath),
    timestamp,
    summary: {
      tool_name: pickString(summary.tool_name, summary.toolName),
      prompt_chars:
        typeof summary.prompt_chars === "number" &&
        Number.isFinite(summary.prompt_chars)
          ? summary.prompt_chars
          : undefined,
      payload_keys: Array.isArray(summary.payload_keys)
        ? summary.payload_keys
            .filter((item) => typeof item === "string")
            .slice(0, 40)
        : [],
    },
  };
}

export async function loadHookOutboxRecords(
  outboxPath,
  { maxRecords = 5000, since = undefined } = {},
) {
  if (!existsSync(outboxPath)) {
    return { records: [], skipped: 0, missing: true };
  }

  const records = [];
  let skipped = 0;
  const sinceMs = since ? Date.parse(String(since)) : NaN;
  const rl = createInterface({
    input: createReadStream(outboxPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const normalized = normalizeHookRecord(parsed, records.length + skipped);
      if (normalized) {
        const timestampMs = Date.parse(normalized.timestamp);
        if (!Number.isFinite(sinceMs) || timestampMs >= sinceMs) {
          records.push(normalized);
        }
      } else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  return {
    records: compactRecords(records, maxRecords),
    skipped,
    missing: false,
    matched: records.length,
  };
}

function toolNames(records) {
  return [
    ...new Set(
      records
        .map((record) => pickString(record.summary?.tool_name))
        .filter(Boolean)
        .sort(),
    ),
  ];
}

function hasOrgxSignal(records) {
  return records.some((record) => {
    const haystack = [
      record.source,
      record.source_client,
      record.event,
      record.summary?.tool_name,
      ...(record.summary?.payload_keys || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes("orgx") || haystack.includes("useorgx");
  });
}

function hasMcpSignal(records) {
  return records.some((record) => {
    const haystack = [
      record.event,
      record.summary?.tool_name,
      ...(record.summary?.payload_keys || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes("mcp");
  });
}

function hasOrgxMcpSignal(records) {
  return records.some((record) => {
    const haystack = [
      record.event,
      record.summary?.tool_name,
      ...(record.summary?.payload_keys || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      haystack.includes("mcp") &&
      (haystack.includes("orgx") || haystack.includes("useorgx"))
    );
  });
}

function shouldSkipTranscriptKey(key) {
  return TRANSCRIPT_SKIP_KEY_PATTERNS.some((pattern) =>
    pattern.test(String(key || "")),
  );
}

function extractTextFragments(value, key = "", depth = 0, fragments = []) {
  if (fragments.length >= 40 || depth > 8 || shouldSkipTranscriptKey(key)) {
    return fragments;
  }
  if (typeof value === "string") {
    const allowedKey =
      !key || TRANSCRIPT_TEXT_KEYS.has(String(key).toLowerCase());
    const trimmed = value.trim();
    if (allowedKey && trimmed && trimmed.length <= 4000) {
      fragments.push(trimmed.slice(0, 1000));
    }
    return fragments;
  }
  if (!value || typeof value !== "object") return fragments;
  if (Array.isArray(value)) {
    for (const item of value) {
      extractTextFragments(item, key, depth + 1, fragments);
      if (fragments.length >= 40) break;
    }
    return fragments;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (shouldSkipTranscriptKey(childKey)) continue;
    const normalizedKey = String(childKey).toLowerCase();
    if (
      TRANSCRIPT_TEXT_KEYS.has(normalizedKey) ||
      typeof childValue === "object"
    ) {
      extractTextFragments(childValue, childKey, depth + 1, fragments);
    }
    if (fragments.length >= 40) break;
  }
  return fragments;
}

function parseTranscriptTimestamp(value, fallback) {
  if (!value || typeof value !== "object") return fallback;
  return toIsoTimestamp(
    value.timestamp ||
      value.created_at ||
      value.createdAt ||
      value.payload?.timestamp ||
      value.message?.created_at ||
      value.message?.createdAt ||
      value.message?.timestamp,
    fallback,
  );
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function discoverTranscriptFiles({
  roots = DEFAULT_TRANSCRIPT_ROOTS,
  since,
  maxFiles = 400,
  maxDepth = 8,
} = {}) {
  const sinceMs = since ? Date.parse(String(since)) : NaN;
  const files = [];
  const normalizedRoots = (Array.isArray(roots) ? roots : [])
    .map((root) => ({
      source_client: normalizeSourceClient(
        root?.source_client || root?.sourceClient,
      ),
      path: pickString(root?.path),
    }))
    .filter((root) => root.path && existsSync(root.path));

  for (const root of normalizedRoots) {
    const stack = [{ path: root.path, depth: 0 }];
    while (stack.length && files.length < maxFiles * 4) {
      const current = stack.pop();
      if (!current || current.depth > maxDepth) continue;
      const stat = safeStat(current.path);
      if (!stat) continue;
      if (stat.isDirectory()) {
        let entries = [];
        try {
          entries = readdirSync(current.path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          stack.push({
            path: join(current.path, entry.name),
            depth: current.depth + 1,
          });
        }
        continue;
      }
      if (!stat.isFile()) continue;
      if (!/\.(jsonl|json|md|txt)$/i.test(current.path)) continue;
      if (Number.isFinite(sinceMs) && stat.mtimeMs < sinceMs) continue;
      if (stat.size > 20 * 1024 * 1024) continue;
      files.push({
        path: current.path,
        source_client: root.source_client,
        mtime: new Date(stat.mtimeMs).toISOString(),
        size: stat.size,
      });
    }
  }

  return files
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, maxFiles);
}

function classifyTranscriptFragments(fragments) {
  const haystack = fragments.join("\n");
  return TRANSCRIPT_SIGNAL_DEFS.filter((definition) =>
    definition.pattern.test(haystack),
  ).map((definition) => definition.kind);
}

export function scanTranscriptSignals({
  roots = DEFAULT_TRANSCRIPT_ROOTS,
  since,
  maxFiles = 400,
  maxLinesPerFile = 400,
} = {}) {
  const files = discoverTranscriptFiles({ roots, since, maxFiles });
  const counts = Object.fromEntries(
    TRANSCRIPT_SIGNAL_DEFS.map((definition) => [definition.kind, 0]),
  );
  const signals = [];
  let scannedLines = 0;

  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const selectedLines = lines.slice(-maxLinesPerFile);
    scannedLines += selectedLines.length;
    selectedLines.forEach((line, index) => {
      const lineNumber = Math.max(
        1,
        lines.length - selectedLines.length + index + 1,
      );
      let fragments = [];
      let occurredAt = file.mtime;
      try {
        const parsed = JSON.parse(line);
        occurredAt = parseTranscriptTimestamp(parsed, file.mtime);
        fragments = extractTextFragments(parsed);
      } catch {
        fragments = extractTextFragments({ text: line }, "text");
      }
      if (!fragments.length) return;
      for (const kind of classifyTranscriptFragments(fragments)) {
        counts[kind] = (counts[kind] || 0) + 1;
        if (signals.length >= TRANSCRIPT_SIGNAL_LIMIT) continue;
        const sourceHash = hashString(file.path, 16);
        signals.push({
          kind,
          source_client: file.source_client,
          source_id: `${file.source_client}:${sourceHash}`,
          evidence_ref: `transcript-scan:${file.source_client}:${hashString(
            `${file.path}:${lineNumber}:${kind}:${occurredAt}`,
            16,
          )}`,
          occurred_at: occurredAt,
          confidence: 0.58,
        });
      }
    });
  }

  return {
    scanned_files: files.length,
    scanned_lines: scannedLines,
    source_clients: [
      ...new Set(files.map((file) => file.source_client).filter(Boolean)),
    ].sort(),
    signals,
    counts,
    raw_transcripts_included: false,
  };
}

function normalizeTranscriptScan(value) {
  const emptyCounts = Object.fromEntries(
    TRANSCRIPT_SIGNAL_DEFS.map((definition) => [definition.kind, 0]),
  );
  if (!value || typeof value !== "object") {
    return {
      scanned_files: 0,
      scanned_lines: 0,
      source_clients: [],
      signals: [],
      counts: emptyCounts,
      raw_transcripts_included: false,
    };
  }
  const signals = Array.isArray(value.signals)
    ? value.signals
        .map((signal) => ({
          kind: pickString(signal?.kind, "unknown"),
          source_client: normalizeSourceClient(signal?.source_client),
          source_id: pickString(signal?.source_id, "transcript-scan:unknown"),
          evidence_ref: pickString(
            signal?.evidence_ref,
            "transcript-scan:unknown",
          ),
          occurred_at: toIsoTimestamp(
            signal?.occurred_at,
            "1970-01-01T00:00:00.000Z",
          ),
          confidence:
            typeof signal?.confidence === "number" &&
            Number.isFinite(signal.confidence)
              ? Math.max(0, Math.min(1, signal.confidence))
              : 0.58,
        }))
        .filter((signal) =>
          TRANSCRIPT_SIGNAL_DEFS.some(
            (definition) => definition.kind === signal.kind,
          ),
        )
        .slice(0, TRANSCRIPT_SIGNAL_LIMIT)
    : [];
  const counts = { ...emptyCounts };
  for (const definition of TRANSCRIPT_SIGNAL_DEFS) {
    const supplied = Number(value.counts?.[definition.kind]);
    counts[definition.kind] = Number.isFinite(supplied)
      ? Math.max(0, supplied)
      : signals.filter((signal) => signal.kind === definition.kind).length;
  }
  return {
    scanned_files: parsePositiveInt(value.scanned_files, 0),
    scanned_lines: parsePositiveInt(value.scanned_lines, 0),
    source_clients: [
      ...new Set(
        (Array.isArray(value.source_clients) ? value.source_clients : [])
          .map(normalizeSourceClient)
          .filter(Boolean),
      ),
    ].sort(),
    signals,
    counts,
    raw_transcripts_included: false,
  };
}

function buildTranscriptEvidenceRef(signal) {
  return {
    id: signal.evidence_ref,
    source_client: signal.source_client,
    source_id: signal.source_id,
    label: `Transcript ${signal.kind} signal`,
    summary: `Summary-only local transcript scan found a ${signal.kind}-like turn.`,
    occurred_at: signal.occurred_at,
    confidence: signal.confidence,
    redaction_state: "public_summary",
    metadata: {
      transcript_scan: true,
      signal_kind: signal.kind,
      raw_transcripts_included: false,
    },
  };
}

function buildEvidenceRef(record, ordinal) {
  const sourceId = `${record.source_client}:${record.session_id}`;
  const id = `${sourceId}:${ordinal}`;
  const tool = pickString(record.summary?.tool_name);
  const summaryBits = [
    `${sourceLabel(record.source_client)} ${record.event} hook observed.`,
    tool ? `Tool signal: ${tool}.` : undefined,
    typeof record.summary?.prompt_chars === "number"
      ? `Prompt length: ${record.summary.prompt_chars} characters.`
      : undefined,
  ].filter(Boolean);
  return {
    id,
    source_client: record.source_client,
    source_id: sourceId,
    label: `${sourceLabel(record.source_client)} ${record.event}`,
    summary: summaryBits.join(" "),
    occurred_at: record.timestamp,
    confidence: 0.72,
    redaction_state: "public_summary",
    metadata: {
      event: record.event,
      cwd_hash: hashString(record.cwd, 16),
      has_transcript_path: Boolean(record.transcript_path),
    },
  };
}

function buildAttributionNode({
  id,
  kind,
  label,
  summary,
  sourceClient,
  evidenceRefs,
  linkedNodeIds = [],
  confidence = 0.72,
  weight = 50,
  metadata = {},
}) {
  return {
    id,
    kind,
    label,
    summary,
    source_client: sourceClient,
    evidence_refs: evidenceRefs.slice(0, 30),
    linked_node_ids: linkedNodeIds.slice(0, 50),
    confidence,
    weight,
    review_state: "unreviewed",
    dedupe_key: id,
    metadata,
  };
}

function finalStateFor(records) {
  if (records.some((record) => eventPhase(record.event) === "blocked")) {
    return "blocked";
  }
  if (records.some((record) => eventPhase(record.event) === "completed")) {
    return "completed";
  }
  if (records.length > 0) return "in_progress";
  return "unknown";
}

function findingTypeCounts(findings) {
  const counts = {};
  for (const finding of findings) {
    counts[finding.type] = (counts[finding.type] || 0) + 1;
  }
  return counts;
}

function emptyAttributionSpine(evidenceRefs = []) {
  return {
    source_events: [],
    actions: [],
    decisions: [],
    artifacts: [],
    people: [],
    agents: [],
    tools: [],
    businesses: [],
    product_surfaces: [],
    goals: [],
    sources: [],
    initiative_candidates: [],
    evidence_refs: evidenceRefs,
    confidence: evidenceRefs.length ? 0.7 : 0,
    dedupe_keys: [],
    privacy: {
      redaction_state: "public_summary",
      raw_transcripts_included: false,
      public_summary_only: true,
    },
    review: {
      pending_count: 0,
      correction_affordances: [
        "confirm",
        "merge",
        "hide",
        "mark_important",
        "launch_or_dismiss",
      ],
    },
  };
}

export function buildWorkGraphReport(recordsInput, options = {}) {
  const generatedAt = toIsoTimestamp(
    options.generatedAt,
    new Date().toISOString(),
  );
  const records = recordsInput
    .map((record, index) => normalizeHookRecord(record, index))
    .filter(Boolean)
    .sort((a, b) => recordSortKey(a).localeCompare(recordSortKey(b)));
  const firstRecord = records[0];
  const workspaceCwd = pickString(
    options.workspaceCwd,
    firstRecord?.cwd,
    process.cwd(),
  );
  const workspaceName = pickString(
    options.workspaceName,
    basename(workspaceCwd) || workspaceCwd,
    "Local workspace",
  );
  const workspaceHash = `sha256:${hashString(workspaceCwd, 32)}`;
  const workspace = {
    id: pickString(
      options.workspaceId,
      `local:${hashString(workspaceCwd, 16)}`,
    ),
    name: workspaceName,
  };
  const transcriptScan = normalizeTranscriptScan(options.transcriptScan);
  const sourceClients = [
    ...new Set(
      [
        ...records.map((record) => record.source_client),
        ...transcriptScan.source_clients,
        ...transcriptScan.signals.map((signal) => signal.source_client),
      ].filter(Boolean),
    ),
  ].sort();
  const sessions = [
    ...new Set(
      records
        .map((record) => `${record.source_client}:${record.session_id}`)
        .filter(Boolean),
    ),
  ].sort();
  const observedToolNames = toolNames(records);
  const orgxMcpCalled = hasOrgxMcpSignal(records);
  const hookEvidenceRefs = records.slice(0, 200).map(buildEvidenceRef);
  const transcriptEvidenceRefs = transcriptScan.signals
    .slice(0, 200)
    .map(buildTranscriptEvidenceRef);
  const evidenceRefs = [...hookEvidenceRefs, ...transcriptEvidenceRefs].slice(
    0,
    1000,
  );
  const primaryEvidenceRef =
    evidenceRefs[0]?.id || "work-graph:hook-outbox:empty";
  const sourceEvents = records.slice(0, 200).map((record, index) => ({
    source_client: record.source_client,
    source_id: `${record.source_client}:${record.session_id}`,
    source_label: `${sourceLabel(record.source_client)} session`,
    event_type: "runtime_hook",
    occurred_at: record.timestamp,
    evidence_ref: evidenceRefs[index].id,
    confidence: 0.72,
    metadata: {
      event: record.event,
      tool_name: record.summary?.tool_name,
      prompt_chars: record.summary?.prompt_chars,
    },
  }));
  const transcriptSourceEvents = transcriptScan.signals
    .slice(0, 200)
    .map((signal) => ({
      source_client: signal.source_client,
      source_id: signal.source_id,
      source_label: `${sourceLabel(signal.source_client)} local transcript`,
      event_type: "client_extraction",
      occurred_at: signal.occurred_at,
      evidence_ref: signal.evidence_ref,
      confidence: signal.confidence,
      metadata: {
        transcript_scan: true,
        signal_kind: signal.kind,
        raw_transcripts_included: false,
      },
    }));
  const reportEvents = [...sourceEvents, ...transcriptSourceEvents]
    .slice(0, 500)
    .map((event) => ({
      source_client: event.source_client,
      source_id: event.source_id,
      source_label: event.source_label,
      event_type: event.metadata?.tool_name
        ? "tool_signal"
        : "client_extraction",
      evidence_ref: event.evidence_ref,
      metadata: {
        ...event.metadata,
        occurred_at: event.occurred_at,
        attribution_event_type: event.event_type,
      },
    }));

  const findings = [];
  if (records.length > 0) {
    findings.push({
      type: "action",
      title: "AI client lifecycle activity observed",
      summary:
        "OrgX captured summary-only hook events from local AI client sessions.",
      source_client: records[0].source_client,
      source_id: `${records[0].source_client}:${records[0].session_id}`,
      evidence_ref: primaryEvidenceRef,
      confidence: 0.72,
      metadata: {
        event_count: records.length,
        session_count: sessions.length,
        source_clients: sourceClients,
      },
    });
  }
  if (observedToolNames.length > 0) {
    findings.push({
      type: "artifact",
      title: "Tool-use trail is available for work graph hydration",
      summary:
        "Hook metadata includes compact tool names that can seed OrgX sources, tools, and evidence refs without raw transcript upload.",
      source_client: records[0]?.source_client || "unknown",
      source_id: records[0]
        ? `${records[0].source_client}:${records[0].session_id}`
        : "unknown:session",
      evidence_ref: primaryEvidenceRef,
      confidence: 0.7,
      metadata: {
        tool_names: observedToolNames.slice(0, 20),
      },
    });
  }
  for (const definition of TRANSCRIPT_SIGNAL_DEFS) {
    const signalCount = transcriptScan.counts[definition.kind] || 0;
    if (signalCount <= 0) continue;
    const firstSignal = transcriptScan.signals.find(
      (signal) => signal.kind === definition.kind,
    );
    findings.push({
      type: definition.findingType,
      title: definition.title,
      summary: `${definition.summary} ${signalCount} signal(s) were found across ${transcriptScan.scanned_files} local file(s).`,
      source_client: firstSignal?.source_client || "wizard",
      source_id: firstSignal?.source_id || "work-graph:transcript-scan",
      evidence_ref: firstSignal?.evidence_ref || primaryEvidenceRef,
      confidence: firstSignal ? 0.62 : 0.5,
      metadata: {
        signal_kind: definition.kind,
        signal_count: signalCount,
        scanned_files: transcriptScan.scanned_files,
        source_clients: transcriptScan.source_clients,
        transcript_scan: true,
        raw_transcripts_included: false,
      },
    });
  }

  const missedOrchestration = [];
  if (records.length > 0 && !orgxMcpCalled) {
    const missed = {
      type: "missed_orchestration_opportunity",
      title: "Session activity was captured without durable OrgX writeback",
      summary:
        "The hook outbox observed client lifecycle events, but no OrgX MCP tool signal was detected in the compact hook metadata.",
      source_client: "wizard",
      source_id: "work-graph:hook-outbox",
      evidence_ref: primaryEvidenceRef,
      confidence: 0.76,
      metadata: {
        event_count: records.length,
        session_count: sessions.length,
      },
    };
    findings.push(missed);
    missedOrchestration.push(missed);
  }

  const sourceNodes = sourceClients.map((sourceClient) =>
    buildAttributionNode({
      id: `source:${sourceClient}`,
      kind: "source",
      label: sourceLabel(sourceClient),
      summary: `${sourceLabel(sourceClient)} hook events were present in the outbox.`,
      sourceClient,
      evidenceRefs: evidenceRefs
        .filter((ref) => ref.source_client === sourceClient)
        .slice(0, 10)
        .map((ref) => ref.id),
      linkedNodeIds: ["action:hook-lifecycle-captured"],
      confidence: 0.72,
      weight: 70,
      metadata: { connected: true },
    }),
  );
  const toolNodes = observedToolNames.slice(0, 50).map((name) =>
    buildAttributionNode({
      id: `tool:${slug(name)}`,
      kind: "tool",
      label: name.slice(0, 120),
      summary: `Tool signal observed from hook metadata: ${name}.`,
      sourceClient: name.toLowerCase().includes("orgx")
        ? "mcp"
        : records[0]?.source_client || "unknown",
      evidenceRefs: evidenceRefs
        .filter(
          (ref) =>
            records[evidenceRefs.indexOf(ref)]?.summary?.tool_name === name,
        )
        .slice(0, 10)
        .map((ref) => ref.id),
      linkedNodeIds: ["action:hook-lifecycle-captured"],
      confidence: 0.68,
      weight: name.toLowerCase().includes("orgx") ? 84 : 60,
      metadata: {},
    }),
  );
  const toolArtifactNode = observedToolNames.length
    ? buildAttributionNode({
        id: "artifact:tool-use-trail",
        kind: "artifact",
        label: "Tool-use trail",
        summary:
          "Compact hook metadata captured a reviewable tool-use trail without sending raw transcripts.",
        sourceClient: records[0]?.source_client || "wizard",
        evidenceRefs: evidenceRefs.slice(0, 20).map((ref) => ref.id),
        linkedNodeIds: toolNodes.slice(0, 20).map((node) => node.id),
        confidence: 0.7,
        weight: 74,
        metadata: {
          signal_kind: "artifact",
          source: "hook_metadata",
          tool_count: observedToolNames.length,
          raw_transcripts_included: false,
        },
      })
    : null;
  const actionNode = records.length
    ? buildAttributionNode({
        id: "action:hook-lifecycle-captured",
        kind: "action",
        label: "Capture AI client lifecycle",
        summary:
          "Convert local hook outbox events into OrgX Work Graph source events, evidence refs, and reviewable initiative candidates.",
        sourceClient: "wizard",
        evidenceRefs: evidenceRefs.slice(0, 20).map((ref) => ref.id),
        linkedNodeIds: [
          ...sourceNodes.map((node) => node.id),
          ...toolNodes.map((node) => node.id),
        ],
        confidence: 0.74,
        weight: 82,
        metadata: { raw_transcripts_sent: false },
      })
    : null;
  const initiativeNode = records.length
    ? buildAttributionNode({
        id: "initiative:continuous-orgx-writeback",
        kind: "goal",
        label: "Install continuous OrgX writeback",
        summary:
          "Review hook-derived session evidence and promote real decisions, blockers, artifacts, and goals into OrgX.",
        sourceClient: "wizard",
        evidenceRefs: evidenceRefs.slice(0, 20).map((ref) => ref.id),
        linkedNodeIds: actionNode ? [actionNode.id] : [],
        confidence: orgxMcpCalled ? 0.64 : 0.78,
        weight: orgxMcpCalled ? 62 : 88,
        metadata: { priority: orgxMcpCalled ? "p2" : "p0" },
      })
    : null;
  const transcriptSignalNodes = TRANSCRIPT_SIGNAL_DEFS.map((definition) => {
    const matchingSignals = transcriptScan.signals.filter(
      (signal) => signal.kind === definition.kind,
    );
    if (!matchingSignals.length && !transcriptScan.counts[definition.kind])
      return null;
    const kind =
      definition.kind === "decision"
        ? "decision"
        : definition.kind === "artifact"
          ? "artifact"
          : definition.kind === "goal"
            ? "goal"
            : "action";
    return buildAttributionNode({
      id: `transcript-signal:${definition.kind}`,
      kind,
      label: definition.title,
      summary: `${definition.summary} Review in OrgX before converting to durable entities.`,
      sourceClient: matchingSignals[0]?.source_client || "wizard",
      evidenceRefs: matchingSignals.map((signal) => signal.evidence_ref),
      linkedNodeIds: actionNode ? [actionNode.id] : [],
      confidence: matchingSignals.length ? 0.62 : 0.5,
      weight: definition.kind === "blocker" ? 86 : 72,
      metadata: {
        signal_kind: definition.kind,
        signal_count:
          transcriptScan.counts[definition.kind] || matchingSignals.length,
        transcript_scan: true,
        raw_transcripts_included: false,
      },
    });
  }).filter(Boolean);

  const attributionSpine = emptyAttributionSpine(evidenceRefs);
  attributionSpine.source_events = [
    ...sourceEvents,
    ...transcriptSourceEvents,
  ].slice(0, 1000);
  attributionSpine.actions = actionNode ? [actionNode] : [];
  attributionSpine.actions.push(
    ...transcriptSignalNodes.filter((node) => node.kind === "action"),
  );
  attributionSpine.decisions = transcriptSignalNodes.filter(
    (node) => node.kind === "decision",
  );
  attributionSpine.artifacts = transcriptSignalNodes.filter(
    (node) => node.kind === "artifact",
  );
  if (toolArtifactNode) {
    attributionSpine.artifacts.unshift(toolArtifactNode);
  }
  attributionSpine.goals = [
    ...(initiativeNode ? [initiativeNode] : []),
    ...transcriptSignalNodes.filter((node) => node.kind === "goal"),
  ];
  attributionSpine.sources = sourceNodes;
  attributionSpine.tools = toolNodes;
  attributionSpine.initiative_candidates = initiativeNode
    ? [initiativeNode]
    : [];
  attributionSpine.confidence = evidenceRefs.length ? 0.72 : 0;
  attributionSpine.dedupe_keys = [
    ...new Set(
      [
        ...attributionSpine.actions,
        ...attributionSpine.decisions,
        ...attributionSpine.artifacts,
        ...attributionSpine.goals,
        ...attributionSpine.sources,
        ...attributionSpine.tools,
        ...attributionSpine.initiative_candidates,
      ].map((node) => node.dedupe_key),
    ),
  ];
  attributionSpine.review.pending_count = attributionSpine.dedupe_keys.length;

  const counts = findingTypeCounts(findings);
  const fingerprintBasis = {
    schema_version: WORK_GRAPH_SCHEMA_VERSION,
    fingerprint_version: WORK_GRAPH_FINGERPRINT_VERSION,
    workspace_hash: workspaceHash,
    source_clients: sourceClients.length ? sourceClients : ["unknown"],
    connected_source_hashes: [
      ...sessions,
      ...transcriptScan.signals.map((signal) => signal.source_id),
    ]
      .map((session) => `sha256:${hashString(session, 32)}`)
      .slice(0, 50),
    missing_source_hashes: (orgxMcpCalled
      ? []
      : [`sha256:${hashString("orgx-mcp", 32)}`]
    ).slice(0, 50),
    finding_type_counts: counts,
    pattern_hashes: [
      ...records.map(
        (record) =>
          `sha256:${stableHash(
            {
              source_client: record.source_client,
              event: record.event,
              tool_name: record.summary?.tool_name,
            },
            32,
          )}`,
      ),
      ...transcriptScan.signals.map(
        (signal) =>
          `sha256:${stableHash(
            {
              source_client: signal.source_client,
              signal_kind: signal.kind,
              source_id: signal.source_id,
            },
            32,
          )}`,
      ),
    ]
      .sort()
      .slice(0, 500),
    trail_shape_hashes: [],
    recurring_pattern_hashes: [],
    kickoff_hashes: records.length
      ? [`sha256:${hashString("continuous-orgx-writeback", 32)}`]
      : [],
    raw_transcripts_included: false,
  };
  const workGraphFingerprint = `wgf_${stableHash(fingerprintBasis, 24)}`;
  const hydrationKey = `orgx:work-graph:${workGraphFingerprint}`;
  const reportId = `report_${stableHash({ workGraphFingerprint, generatedAt }, 24)}`;

  return {
    schema_version: WORK_GRAPH_SCHEMA_VERSION,
    report_id: reportId,
    idempotency_key: `work-graph:hook-outbox:${workGraphFingerprint}`,
    work_graph_fingerprint: workGraphFingerprint,
    fingerprint_version: WORK_GRAPH_FINGERPRINT_VERSION,
    fingerprint_basis: fingerprintBasis,
    signup_hydration: {
      strategy: "work_graph_fingerprint_claim",
      hydration_key: hydrationKey,
      eligible: evidenceRefs.length > 0,
      notes: evidenceRefs.length
        ? [
            "claim after signup",
            "summary-only hook outbox and transcript hydration",
          ]
        : ["no hook or transcript evidence found"],
    },
    generated_at: generatedAt,
    source_client: "wizard",
    session_id: sessions[0] || "hook-outbox-empty",
    workspace,
    audit_method: {
      mode: "ai_client_session_search",
      searched_session_files:
        transcriptScan.scanned_files + (records.length > 0 ? 1 : 0),
      skipped_session_files: 0,
      searched_message_count: records.length + transcriptScan.scanned_lines,
      retained_evidence_lines: evidenceRefs.length,
      searched_source_groups: sourceClients.length,
      extraction_lenses: [
        "runtime_hooks",
        "summary_only_work_graph",
        "summary_only_local_transcript_signals",
      ],
      client_native_packs: sourceClients.map((sourceClient) => ({
        source_client: sourceClient,
        source_label: sourceLabel(sourceClient),
        searched_session_count:
          records.filter((record) => record.source_client === sourceClient)
            .length +
          transcriptScan.signals.filter(
            (signal) => signal.source_client === sourceClient,
          ).length,
        finding_count: findings.filter(
          (finding) => finding.source_client === sourceClient,
        ).length,
        confidence: 0.72,
      })),
      privacy_contract: [
        "raw transcripts are excluded",
        "hook payload values are summarized before persistence",
        "workspace paths are hashed in public evidence metadata",
      ],
      notes: transcriptScan.scanned_files
        ? [
            "Local transcript scanning is summary-only; raw transcript text is not included.",
          ]
        : [],
    },
    domain_coverage: [
      {
        id: "runtime-hooks",
        label: "Runtime hooks",
        summary: `${records.length} summary-only lifecycle events captured.`,
        finding_count: findings.length,
        source_clients: sourceClients.length ? sourceClients : ["unknown"],
        evidence_refs: evidenceRefs.slice(0, 20).map((ref) => ref.id),
        confidence: records.length ? 0.72 : 0,
      },
      ...(transcriptScan.scanned_files
        ? [
            {
              id: "transcript-scan",
              label: "Local transcript signals",
              summary: `${transcriptScan.scanned_files} local transcript file(s) scanned for summary-only decision, artifact, goal, and blocker signals.`,
              finding_count: TRANSCRIPT_SIGNAL_DEFS.reduce(
                (total, definition) =>
                  total + (transcriptScan.counts[definition.kind] || 0),
                0,
              ),
              source_clients: transcriptScan.source_clients.length
                ? transcriptScan.source_clients
                : ["unknown"],
              evidence_refs: transcriptEvidenceRefs
                .slice(0, 20)
                .map((ref) => ref.id),
              confidence: 0.62,
            },
          ]
        : []),
    ],
    skill_tool_signals: observedToolNames.slice(0, 50).map((name) => ({
      id: `tool:${slug(name)}`,
      label: name.slice(0, 120),
      kind: name.toLowerCase().includes("orgx") ? "mcp_tool" : "client_tool",
      mention_count: records.filter(
        (record) => record.summary?.tool_name === name,
      ).length,
      source_clients: sourceClients.length ? sourceClients : ["unknown"],
      evidence_refs: evidenceRefs
        .filter((_, index) => records[index]?.summary?.tool_name === name)
        .slice(0, 20)
        .map((ref) => ref.id),
      confidence: 0.68,
    })),
    source_coverage: {
      connected: sourceClients.map(sourceLabel),
      missing: orgxMcpCalled ? [] : ["OrgX MCP writeback"],
      mcpObserved: hasMcpSignal(records),
      orgxObserved: hasOrgxSignal(records),
      orgxMcpCalled,
      skillOnlySignal: records.length > 0 && !orgxMcpCalled,
      coverage_score: orgxMcpCalled ? 80 : records.length ? 45 : 0,
      manifests: sourceClients.map((sourceClient) => ({
        source_client: sourceClient,
        source_label: sourceLabel(sourceClient),
        status: "connected",
        searched_sources: [
          ...(records.some((record) => record.source_client === sourceClient)
            ? ["hook_outbox"]
            : []),
          ...(transcriptScan.signals.some(
            (signal) => signal.source_client === sourceClient,
          )
            ? ["local_cli_transcripts"]
            : []),
        ],
        searched_session_count:
          records.filter((record) => record.source_client === sourceClient)
            .length +
          transcriptScan.signals.filter(
            (signal) => signal.source_client === sourceClient,
          ).length,
        skipped_session_count: 0,
        query_count: 0,
        finding_count: findings.filter(
          (finding) => finding.source_client === sourceClient,
        ).length,
        confidence: 0.72,
        notes: [],
      })),
      notes: [
        orgxMcpCalled
          ? "OrgX MCP signal detected in hook metadata."
          : "No OrgX MCP writeback signal detected in compact hook metadata.",
        ...(transcriptScan.scanned_files
          ? [
              "Summary-only local transcript signal scan completed without raw transcript persistence.",
            ]
          : []),
      ],
    },
    final_state: records.length
      ? finalStateFor(records)
      : transcriptScan.signals.length
        ? "in_progress"
        : "unknown",
    events: reportEvents,
    findings,
    missed_orchestration_opportunities: missedOrchestration,
    trails: [],
    recurring_patterns: [],
    recommendations:
      evidenceRefs.length && !orgxMcpCalled
        ? [
            {
              id: "recommendation:promote-hook-outbox",
              title: "Promote hook outbox evidence",
              summary:
                "Review summary-only hook and transcript evidence, then promote real decisions, blockers, artifacts, and goals into OrgX.",
              action_type: "connect_source",
              trail_ids: [],
              evidence_refs: [primaryEvidenceRef],
              priority: "p0",
              expected_lift: "+work graph durability",
              confidence: 0.76,
            },
          ]
        : [],
    mirror: {
      headline: evidenceRefs.length
        ? "AI work is ready for OrgX review"
        : "No AI activity evidence found",
      body: evidenceRefs.length
        ? "OrgX found summary-only lifecycle and transcript-signal evidence that can hydrate a work graph without sending raw transcripts."
        : "The hook outbox and local transcript scan did not contain evidence to hydrate.",
      lens: "all",
      generated_at: generatedAt,
      claims: evidenceRefs.length
        ? [
            {
              id: "mirror:hook-outbox",
              text: `${records.length} lifecycle events and ${transcriptScan.signals.length} transcript signal sample(s) were captured across ${sessions.length} hook session(s).`,
              evidence_refs: [primaryEvidenceRef],
              confidence: 0.72,
            },
          ]
        : [],
    },
    tension_metrics:
      records.length && !orgxMcpCalled
        ? [
            {
              id: "tension:work-without-writeback",
              label: "work without writeback",
              value: String(records.length),
              tone: "warning",
              trail_ids: [],
              evidence_refs: [primaryEvidenceRef],
              explanation:
                "Hook events exist, but compact metadata did not prove durable OrgX MCP writeback.",
            },
          ]
        : [],
    opportunity_score: {
      overall: evidenceRefs.length ? (orgxMcpCalled ? 58 : 76) : 0,
      value_potential: evidenceRefs.length ? 78 : 0,
      evidence_quality: evidenceRefs.length ? 64 : 0,
      urgency: records.length && !orgxMcpCalled ? 80 : 35,
      owner_clarity: evidenceRefs.length ? 55 : 0,
      automation_potential: evidenceRefs.length ? 86 : 0,
      orgx_fit: evidenceRefs.length ? 90 : 0,
    },
    execution_quality: {
      overall: evidenceRefs.length ? 66 : 0,
      evidence_coverage: evidenceRefs.length ? 64 : 0,
      source_attribution: evidenceRefs.length ? 70 : 0,
      trail_depth: 0,
      insight_depth: evidenceRefs.length ? 52 : 0,
      actionability: evidenceRefs.length ? 72 : 0,
      impact_confidence: evidenceRefs.length ? 52 : 0,
      notes: [
        "This producer intentionally emits summary-only evidence.",
        "Durable entities should be confirmed before promotion.",
      ],
    },
    impact_projection: {
      time_saved_hours_per_week: evidenceRefs.length ? 2 : 0,
      acceleration_percent: evidenceRefs.length ? 8 : 0,
      estimated_monthly_value_usd: 0,
      confidence: evidenceRefs.length ? 0.35 : 0,
      basis: [
        "hook outbox event count",
        "transcript signal count",
        "source coverage",
      ],
      assumptions: ["manual review promotes only confirmed entities"],
    },
    investigation: {
      schema_version: WORK_GRAPH_SCHEMA_VERSION,
      audit_id: `hook-outbox:${stableHash({ workspaceHash, generatedAt }, 16)}`,
      fingerprint: workGraphFingerprint,
      generated_at: generatedAt,
      raw_events_summary: {
        event_count: records.length,
        source_clients: sourceClients,
        sessions: sessions.length,
        transcript_scan: {
          scanned_files: transcriptScan.scanned_files,
          scanned_lines: transcriptScan.scanned_lines,
          signal_count: transcriptScan.signals.length,
          counts: transcriptScan.counts,
          source_clients: transcriptScan.source_clients,
          raw_transcripts_included: false,
        },
      },
      corpus_manifest: {
        outbox_path: options.outboxPath ? "<local-hook-outbox>" : undefined,
        transcript_scan: transcriptScan.scanned_files
          ? {
              searched_sources: transcriptScan.source_clients,
              scanned_files: transcriptScan.scanned_files,
              raw_transcripts_included: false,
            }
          : undefined,
        raw_transcripts_excluded: true,
      },
      work_loops: [],
      loop_families: [],
      usage_catalogue: {
        tools: observedToolNames,
      },
      source_confidence: {
        hook_outbox: records.length ? 0.72 : 0,
        local_transcript_scan: transcriptScan.scanned_files ? 0.62 : 0,
      },
      why_not_100: orgxMcpCalled
        ? [
            {
              code: "compact_hook_records",
              summary: "Hook records are compact and need entity confirmation.",
            },
          ]
        : [
            {
              code: "missing_orgx_mcp_writeback",
              summary: "No OrgX MCP writeback signal was detected.",
            },
          ],
      counterfactuals: [],
      verification_log: [
        {
          step: "load_hook_outbox",
          status: "passed",
          records_read: records.length,
          records_skipped: options.recordsSkipped || 0,
        },
        {
          step: "scan_local_transcript_signals",
          status: transcriptScan.scanned_files ? "passed" : "skipped",
          records_read: transcriptScan.scanned_lines,
          records_skipped: 0,
        },
      ],
      critic_log: [],
      verification_log_summary: {
        total: records.length + transcriptScan.scanned_lines,
        passed: records.length + transcriptScan.scanned_lines,
        dropped: 0,
      },
      critic_log_summary: {
        total: 0,
        survived: 0,
        dropped_or_demoted: 0,
      },
      mirror_paragraph: {},
      repair_plan: [],
      impact_projection: {},
      redaction_log: [
        {
          rule: "exclude_raw_transcripts",
          status: "passed",
        },
      ],
      raw_transcripts_excluded: true,
      claimable: evidenceRefs.length > 0,
    },
    initiative_kickoffs: evidenceRefs.length
      ? [
          {
            title: "Install continuous OrgX writeback",
            summary:
              "Turn hook and transcript-derived evidence into reviewed OrgX entities and runtime progress.",
            reason: orgxMcpCalled
              ? "Hook evidence exists and can be attached to the active graph."
              : "Work happened in AI clients without a proven OrgX MCP writeback signal.",
            finding_refs: [primaryEvidenceRef],
            priority: orgxMcpCalled ? "p2" : "p0",
          },
        ]
      : [],
    attribution_spine: attributionSpine,
    redaction_level: "summary_only",
    raw_transcripts_sent: false,
  };
}

export async function postWorkGraphReport({
  report,
  baseUrl,
  apiKey,
  fetchImpl = fetch,
}) {
  const normalizedBaseUrl = pickString(
    baseUrl,
    "https://www.useorgx.com",
  ).replace(/\/+$/, "");
  const token = pickString(apiKey);
  if (!token) {
    throw new Error(
      "ORGX_API_KEY is required when posting a Work Graph report",
    );
  }
  const response = await fetchImpl(
    `${normalizedBaseUrl}/api/client/work-graph/reports`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        report,
        public_share: true,
        attach_artifact: false,
      }),
    },
  );
  const body = await response.json().catch(async () => ({
    text: await response.text().catch(() => ""),
  }));
  if (!response.ok) {
    throw new Error(
      `Work Graph report post failed with HTTP ${response.status}`,
    );
  }
  return body;
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  now = () => new Date(),
  fetchImpl = fetch,
} = {}) {
  const args = parseArgs(argv);
  const outboxPath = pickString(
    args.outbox,
    env.ORGX_WIZARD_HOOK_OUTBOX,
    DEFAULT_OUTBOX,
  );
  const maxRecords = parsePositiveInt(
    pickString(args.max_records, args["max-records"], "5000"),
    5000,
  );
  const lookbackDays = parsePositiveInt(
    pickString(
      args.lookback_days,
      args["lookback-days"],
      env.ORGX_WORK_GRAPH_LOOKBACK_DAYS,
      "30",
    ),
    30,
  );
  const since = new Date(
    now().getTime() - lookbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const loaded = await loadHookOutboxRecords(outboxPath, {
    maxRecords,
    since,
  });
  const transcriptScanEnabled = isEnabled(
    pickString(
      args.transcript_scan,
      args["transcript-scan"],
      env.ORGX_WORK_GRAPH_TRANSCRIPT_SCAN,
    ),
    true,
  );
  const transcriptScan = transcriptScanEnabled
    ? scanTranscriptSignals({
        since,
        maxFiles: parsePositiveInt(
          pickString(
            args.max_transcript_files,
            args["max-transcript-files"],
            env.ORGX_WORK_GRAPH_MAX_TRANSCRIPT_FILES,
            "400",
          ),
          400,
        ),
        maxLinesPerFile: parsePositiveInt(
          pickString(
            args.max_transcript_lines,
            args["max-transcript-lines"],
            env.ORGX_WORK_GRAPH_MAX_TRANSCRIPT_LINES,
            "400",
          ),
          400,
        ),
      })
    : undefined;
  const report = buildWorkGraphReport(loaded.records, {
    outboxPath,
    generatedAt: now().toISOString(),
    workspaceCwd: pickString(args.cwd, env.ORGX_WORKSPACE_CWD),
    workspaceName: pickString(args.workspace_name, args["workspace-name"]),
    workspaceId: pickString(args.workspace_id, args["workspace-id"]),
    recordsSkipped: loaded.skipped,
    transcriptScan,
  });

  const result = {
    ok: true,
    outbox_path: outboxPath,
    records_read: loaded.records.length,
    records_matched: loaded.matched,
    records_skipped: loaded.skipped,
    outbox_missing: loaded.missing,
    lookback_days: lookbackDays,
    since,
    transcript_scan_enabled: transcriptScanEnabled,
    transcript_scan: report.investigation.raw_events_summary.transcript_scan,
    work_graph_fingerprint: report.work_graph_fingerprint,
    hydration_key: report.signup_hydration.hydration_key,
    report,
  };

  if (args.post === "true") {
    result.posted = await postWorkGraphReport({
      report,
      baseUrl: pickString(args.base_url, args["base-url"], env.ORGX_BASE_URL),
      apiKey: pickString(args.api_key, args["api-key"], env.ORGX_API_KEY),
      fetchImpl,
    });
  }

  const outputPath = pickString(args.output);
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
