/**
 * Peer runtime for @useorgx/codex-plugin — wires CodexDriver into
 * PeerClient and manages runtime presence plus license heartbeat. Mirror of the claude-code
 * plugin's sidecar; see that plugin's lib/peer/README.md for the mental
 * model (skill catalog is shared; peer is a second shape, not a
 * replacement).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PeerClient } from '@useorgx/orgx-gateway-sdk';
import WebSocket from 'ws';

import { CodexDriver } from './CodexDriver.mjs';
import { AutonomousDispatchGuard } from './autonomousDispatch.mjs';
import {
  defaultReceiptOutboxPath,
  DurableReceiptDriver,
  DurableReceiptOutbox,
} from './DurableReceiptOutbox.mjs';
import { validateAutonomousRepoPath } from './runtimeConfig.mjs';
import {
  defaultInstallationId,
  normalizeRunnerInstanceId,
  resolveRunnerActivationBinding,
} from './runnerInstanceIdentity.mjs';
import { buildPluginContinuityHealth } from './continuityHealth.mjs';
import {
  capturePeerException,
  initializePeerSentry,
} from './sentry.mjs';

const PRESENCE_HEARTBEAT_MS = 20_000;
const LICENSE_HEARTBEAT_MS = 7 * 24 * 60 * 60 * 1000;
const PLUGIN_ID = 'orgx-codex-plugin';
const GATEWAY_PROTOCOL_VERSION = 3;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');

const MAX_TRANSPORT_LOG_LENGTH = 500;

function redactTransportText(value) {
  return String(value)
    .slice(0, MAX_TRANSPORT_LOG_LENGTH)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bbearer\.[A-Za-z0-9._~-]+/gi, 'bearer.[redacted]')
    .replace(/\boxk_[A-Za-z0-9_-]+\b/g, 'oxk_[redacted]');
}

export function summarizeTransportError(error) {
  const record = error && typeof error === 'object' ? error : null;
  const name =
    typeof record?.name === 'string' && record.name.trim()
      ? redactTransportText(record.name)
      : 'TransportError';
  const message =
    typeof record?.message === 'string' && record.message.trim()
      ? redactTransportText(record.message)
      : typeof error === 'string' && error.trim()
        ? redactTransportText(error)
        : 'Gateway transport failed';
  const code = record?.code;

  return {
    name,
    message,
    ...(typeof code === 'number' ||
    (typeof code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(code))
      ? { code }
      : {}),
  };
}

export async function startPeer(opts) {
  const baseUrl = opts.baseUrl ?? 'https://useorgx.com';
  const manifest = await loadManifest();
  initializePeerSentry(manifest.version);

  const autonomyRequested = opts.autonomousDispatchEnabled === true;
  const runnerInstanceId = normalizeRunnerInstanceId(opts.runnerInstanceId);
  if (
    opts.runnerInstanceId !== undefined &&
    opts.runnerInstanceId !== null &&
    opts.runnerInstanceId !== '' &&
    !runnerInstanceId
  ) {
    throw new Error('runner_instance_id_invalid');
  }
  if (autonomyRequested && !runnerInstanceId) {
    throw new Error(
      'runner_instance_id_required_for_autonomous_dispatch: set ORGX_RUNNER_INSTANCE_ID to the installer-persisted service identity'
    );
  }
  const activationBinding = resolveRunnerActivationBinding({
    activationAttemptId: opts.activationAttemptId,
    runnerRole: opts.runnerRole,
  });
  const validateRepo = opts.autonomousRepoValidator ?? validateAutonomousRepoPath;
  const repoStatus = autonomyRequested
    ? await validateRepo(opts.autonomousRepoPath)
    : { ready: false, path: null, reason: 'autonomous_dispatch_not_requested' };
  if (autonomyRequested && repoStatus.ready !== true) {
    throw new Error(
      `${repoStatus.reason ?? 'autonomous_repo_path_invalid'}: set ORGX_AUTONOMOUS_REPO_PATH to a canonical git worktree root`
    );
  }

  const rawDriver = opts.driver ?? new CodexDriver({
    skillRules: () => fetchSkillRules(baseUrl, opts),
    useAppServer: true,
    apiKey: opts.apiKey,
    baseUrl,
    workspaceId: opts.workspaceId,
    pluginVersion: manifest.version,
    autonomousRepoPath: repoStatus.path,
  });
  const mcpStatus = autonomyRequested
    ? await probeAutonomousMcp(rawDriver, opts)
    : { ready: false, reason: 'autonomous_dispatch_not_requested' };
  const autonomy = {
    requested: autonomyRequested,
    repoReady: repoStatus.ready === true,
    mcpReady: mcpStatus.ready === true,
    enabled:
      autonomyRequested && repoStatus.ready === true && mcpStatus.ready === true,
    repoReason: repoStatus.reason ?? null,
    mcpReason: mcpStatus.reason ?? null,
  };
  const guardedDriver = new AutonomousDispatchGuard(rawDriver, {
    autonomousDispatchEnabled: autonomy.enabled,
    autonomousRepoPath: repoStatus.path,
    workspaceId: opts.workspaceId,
  });
  const receiptOutbox =
    opts.receiptOutbox ??
    new DurableReceiptOutbox({
      directory:
        opts.receiptOutboxPath ?? defaultReceiptOutboxPath(opts.workspaceId),
      baseUrl,
      apiKey: opts.apiKey,
      workspaceId: opts.workspaceId,
      fetchImpl: opts.fetchImpl,
      onError: (error) => {
        const safeError = summarizeTransportError(error);
        console.warn('[orgx-codex-plugin] receipt outbox delivery pending', safeError);
      },
    });
  await receiptOutbox.initialize();
  await receiptOutbox.flush();
  const driver = new DurableReceiptDriver(guardedDriver, receiptOutbox);

  let transportOnline = false;
  let presenceTimer = null;
  const heartbeatPresence = async () => {
    await receiptOutbox.flush();
    const receiptOutboxStatus = await receiptOutbox.status();
    if (autonomy.requested) {
      const latestMcpStatus = await probeAutonomousMcp(rawDriver, opts);
      autonomy.mcpReady = latestMcpStatus.ready === true;
      autonomy.mcpReason = latestMcpStatus.reason ?? null;
      autonomy.enabled = autonomy.repoReady && autonomy.mcpReady;
      driver.setAutonomousDispatchEnabled(autonomy.enabled);
    }
    return postPresenceHeartbeat(
      baseUrl,
      opts,
      manifest,
      driver,
      transportOnline,
      autonomy,
      receiptOutboxStatus,
      runnerInstanceId,
      activationBinding,
      opts.fetchImpl,
    );
  };

  const client = new PeerClient({
    baseUrl: httpsToWss(baseUrl),
    apiKey: opts.apiKey,
    workspaceId: opts.workspaceId,
    pluginId: PLUGIN_ID,
    installationId: opts.installationId ?? defaultInstallationId(),
    ...(runnerInstanceId ? { runnerInstanceId } : {}),
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    drivers: [driver],
    webSocketFactory:
      opts.webSocketFactory ??
      ((url, protocols) => new WebSocket(url, protocols)),
    onOpen: () => {
      transportOnline = true;
      console.log('[orgx-codex-plugin] connected');
      void heartbeatPresence().catch((err) =>
        console.warn('[orgx-codex-plugin] open heartbeat failed', err)
      );
    },
    onClose: (code, reason) => {
      transportOnline = false;
      console.warn('[orgx-codex-plugin] closed', { code, reason });
    },
    onError: (err) => {
      const safeError = summarizeTransportError(err);
      capturePeerException(new Error(`${safeError.name}: ${safeError.message}`), {
        stage: 'gateway_transport',
      });
      console.error('[orgx-codex-plugin] error', safeError);
    },
  });

  // A newly minted runner key is heartbeat-only until the exact installation
  // binding is proven. Complete that authenticated activation handshake before
  // the SDK attempts a WebSocket upgrade that requires an active key.
  await heartbeatPresence();
  client.connect();

  let licenseHeartbeatTimer = null;
  if (!opts.skipHeartbeat) {
    presenceTimer = setInterval(() => {
      heartbeatPresence().catch((err) =>
        console.warn('[orgx-codex-plugin] presence heartbeat failed', err)
      );
    }, PRESENCE_HEARTBEAT_MS);
    presenceTimer.unref?.();

    await postLicenseHeartbeat(baseUrl, opts, manifest).catch((err) =>
      console.warn('[orgx-codex-plugin] initial license heartbeat failed', err)
    );
    licenseHeartbeatTimer = setInterval(() => {
      postLicenseHeartbeat(baseUrl, opts, manifest).catch((err) =>
        console.warn('[orgx-codex-plugin] weekly license heartbeat failed', err)
      );
    }, LICENSE_HEARTBEAT_MS);
    licenseHeartbeatTimer.unref?.();
  }

  return {
    client,
    stop: async () => {
      if (presenceTimer) clearInterval(presenceTimer);
      if (licenseHeartbeatTimer) clearInterval(licenseHeartbeatTimer);
      transportOnline = false;
      client.disconnect();
      await receiptOutbox.flush();
    },
  };
}

async function loadManifest() {
  const path = resolve(PLUGIN_ROOT, 'plugin.manifest.json');
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      plugin_name: '@useorgx/codex-plugin',
      version: '0.0.0-dev',
      manifest_fingerprint: 'dev-placeholder',
      signature: '',
    };
  }
}

async function postPresenceHeartbeat(
  baseUrl,
  opts,
  manifest,
  driver,
  transportOnline,
  autonomy,
  receiptOutboxStatus,
  runnerInstanceId,
  activationBinding,
  fetchImpl,
) {
  const detected = await driver.detect();
  const authenticated = detected.authenticated === true;
  const dispatchReady =
    transportOnline && detected.installed === true && authenticated;
  const continuityHealth = await buildPluginContinuityHealth({
    manifest,
    sourceClient: 'codex',
    authState: detected.auth_status ?? 'unknown',
    hookEvents: [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Stop',
    ],
    endpoint: opts.mcpEndpoint,
    outbox: opts.continuityOutbox,
  });
  const send = fetchImpl ?? fetch;
  const res = await send(
    `${baseUrl.replace(/\/$/, '')}/api/v1/gateway/heartbeat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        workspace_id: opts.workspaceId,
        plugin_id: PLUGIN_ID,
        installation_id: opts.installationId ?? defaultInstallationId(),
        ...(runnerInstanceId
          ? { runner_instance_id: runnerInstanceId }
          : {}),
        ...(activationBinding.activationAttemptId
          ? {
              activation_attempt_id: activationBinding.activationAttemptId,
              runner_role: activationBinding.runnerRole,
            }
          : {}),
        host_platform: process.platform,
        drivers_installed: [driver.id],
        gateway_version: manifest.version,
        protocol_version: GATEWAY_PROTOCOL_VERSION,
        plan_tier: detected.plan_tier ?? null,
        subscription_type: detected.subscription_type ?? null,
        subscription_active: authenticated,
        metadata: {
          runtime: 'peer',
          transport_online: transportOnline,
          runtime_online: true,
          dispatch_ready: dispatchReady,
          auth_status: detected.auth_status ?? 'unknown',
          auth_method: detected.auth_method ?? null,
          probe_version: detected.version ?? null,
          queue_depth: driver.running?.size ?? 0,
          autonomous_dispatch_requested: autonomy.requested,
          autonomous_repo_ready: autonomy.repoReady,
          autonomous_mcp_ready: autonomy.mcpReady,
          autonomous_policy_ready: autonomy.mcpReady,
          autonomous_dispatch_enabled: autonomy.enabled,
          autonomous_repo_reason: autonomy.repoReason,
          autonomous_mcp_reason: autonomy.mcpReason,
          durable_receipt_outbox: receiptOutboxStatus,
          continuity_health: continuityHealth,
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`presence heartbeat ${res.status}`);
}

async function probeAutonomousMcp(driver, opts) {
  if (typeof driver.probeAutonomousMcpReadiness === 'function') {
    return driver.probeAutonomousMcpReadiness();
  }
  return opts.autonomousMcpReady === true
    ? { ready: true, reason: null }
    : { ready: false, reason: 'autonomous_mcp_probe_unavailable' };
}

async function postLicenseHeartbeat(baseUrl, opts, manifest) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/licenses/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      workspace_id: opts.workspaceId,
      plugin_name: manifest.plugin_name,
      version: manifest.version,
      manifest_fingerprint: manifest.manifest_fingerprint,
      signature: manifest.signature,
    }),
  });
  if (!res.ok) {
    throw new Error(`heartbeat ${res.status}`);
  }
}

async function fetchSkillRules(baseUrl, opts) {
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/v1/plan-skills?workspace_id=${encodeURIComponent(opts.workspaceId)}`,
      { headers: { Authorization: `Bearer ${opts.apiKey}` } }
    );
    if (!res.ok) return [];
    const body = await res.json();
    const rules = [];
    for (const skill of body.skills ?? []) {
      for (const rule of skill.rules ?? []) {
        rules.push({
          skill_id: skill.id,
          match: { pattern: rule.pattern, on: rule.on },
          dedupe_fingerprint: rule.dedupe_fingerprint,
          evidence_kind: rule.evidence_kind,
        });
      }
    }
    return rules;
  } catch {
    return [];
  }
}

function httpsToWss(url) {
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length);
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length);
  return url;
}
