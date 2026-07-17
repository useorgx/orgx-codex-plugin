import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RUNNER_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/**
 * Resolve the durable identity of one running service instance.
 *
 * Autonomous installers must provide an explicit value so a staged candidate
 * and the current canonical service can never collapse to the same identity.
 * Interactive/manual launches keep backwards compatibility by persisting one
 * random identity for the exact workspace + installation binding.
 */
export async function resolveRunnerInstanceId(opts) {
  const configured = configuredRunnerInstanceId(opts.configuredId);
  if (configured.present) {
    if (!configured.value) {
      throw new Error('runner_instance_id_invalid');
    }
    return configured.value;
  }

  if (opts.autonomousDispatchEnabled === true) {
    throw new Error('runner_instance_id_required_for_autonomous_dispatch');
  }

  const directory =
    opts.stateDirectory ??
    join(opts.homeDirectory ?? homedir(), '.orgx', 'codex-peer', 'runner-instances');
  const path = join(
    directory,
    `${bindingScope(opts.workspaceId, opts.installationId)}.id`,
  );
  const readFileImpl = opts.readFileImpl ?? readFile;

  await (opts.mkdirImpl ?? mkdir)(directory, { recursive: true, mode: 0o700 });
  if ((opts.platform ?? process.platform) !== 'win32') {
    await (opts.chmodImpl ?? chmod)(directory, 0o700);
  }

  const existing = await readPersistedId(path, readFileImpl);
  if (existing.found) {
    if (!existing.value) throw new Error('runner_instance_id_state_invalid');
    return existing.value;
  }

  const createId = opts.randomUUIDImpl ?? randomUUID;
  const generatedId = createId();
  const candidate = normalizeRunnerInstanceId(`codex-${generatedId}`);
  if (!candidate) throw new Error('runner_instance_id_generation_failed');

  // Publish a fully written file with an atomic hard-link. A second concurrent
  // launcher either wins the link or reads the complete winning identity; it
  // can never observe a partially written target file.
  const temporaryPath = join(
    directory,
    `.${bindingScope(opts.workspaceId, opts.installationId)}.${process.pid}.${generatedId}.tmp`,
  );
  try {
    await (opts.writeFileImpl ?? writeFile)(temporaryPath, `${candidate}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await (opts.linkImpl ?? link)(temporaryPath, path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await (opts.rmImpl ?? rm)(temporaryPath, { force: true });
  }

  if ((opts.platform ?? process.platform) !== 'win32') {
    await (opts.chmodImpl ?? chmod)(path, 0o600);
  }

  const persisted = await readPersistedId(path, readFileImpl);
  if (!persisted.value) throw new Error('runner_instance_id_state_invalid');
  return persisted.value;
}

export function normalizeRunnerInstanceId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return RUNNER_INSTANCE_ID_PATTERN.test(normalized) ? normalized : null;
}

export function resolveRunnerActivationBinding(opts = {}) {
  const attemptConfigured = configuredValue(opts.activationAttemptId);
  const roleConfigured = configuredValue(opts.runnerRole);
  if (!attemptConfigured.present && !roleConfigured.present) {
    return { activationAttemptId: null, runnerRole: null };
  }
  if (!attemptConfigured.present || !roleConfigured.present) {
    throw new Error('runner_activation_binding_incomplete');
  }
  const activationAttemptId = normalizeRunnerInstanceId(
    attemptConfigured.raw,
  );
  if (!activationAttemptId) throw new Error('activation_attempt_id_invalid');
  const runnerRole =
    typeof roleConfigured.raw === 'string'
      ? roleConfigured.raw.trim()
      : null;
  if (runnerRole !== 'candidate' && runnerRole !== 'canonical') {
    throw new Error('runner_role_invalid');
  }
  return { activationAttemptId, runnerRole };
}

export function defaultInstallationId(opts = {}) {
  return `orgx-codex-plugin:${opts.platform ?? process.platform}:${
    opts.user ?? process.env.USER ?? 'local'
  }`;
}

function configuredRunnerInstanceId(value) {
  if (value === undefined || value === null || value === '') {
    return { present: false, value: null };
  }
  return { present: true, value: normalizeRunnerInstanceId(value) };
}

function configuredValue(value) {
  return value === undefined || value === null || value === ''
    ? { present: false, raw: null }
    : { present: true, raw: value };
}

function bindingScope(workspaceId, installationId) {
  return createHash('sha256')
    .update(`${workspaceId ?? ''}\0${installationId ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

async function readPersistedId(path, readFileImpl) {
  try {
    return {
      found: true,
      value: normalizeRunnerInstanceId(await readFileImpl(path, 'utf8')),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { found: false, value: null };
    throw error;
  }
}
