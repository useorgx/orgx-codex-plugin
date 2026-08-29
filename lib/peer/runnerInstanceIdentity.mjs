import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
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
  const lstatImpl = opts.lstatImpl ?? lstat;
  const platform = opts.platform ?? process.platform;

  const existingDirectory = await privatePathState(directory, {
    expectedKind: 'directory',
    expectedMode: 0o700,
    lstatImpl,
    platform,
  });
  if (!existingDirectory.found) {
    await (opts.mkdirImpl ?? mkdir)(directory, { recursive: true, mode: 0o700 });
    await assertPrivatePath(directory, {
      expectedKind: 'directory',
      expectedMode: 0o700,
      lstatImpl,
      platform,
    });
  }

  const existing = await readPersistedId(path, readFileImpl, {
    lstatImpl,
    platform,
  });
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

  const persisted = await readPersistedId(path, readFileImpl, {
    lstatImpl,
    platform,
  });
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

async function readPersistedId(path, readFileImpl, opts) {
  const state = await privatePathState(path, {
    expectedKind: 'file',
    expectedMode: 0o600,
    ...opts,
  });
  if (!state.found) return { found: false, value: null };
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

async function assertPrivatePath(path, opts) {
  const state = await privatePathState(path, opts);
  if (!state.found) throw new Error('runner_instance_id_state_path_untrusted');
  return state;
}

async function privatePathState(path, opts) {
  let metadata;
  try {
    metadata = await opts.lstatImpl(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { found: false };
    throw error;
  }
  if (opts.platform === 'win32') return { found: true, metadata };

  const expectedKindMatches =
    opts.expectedKind === 'directory'
      ? metadata.isDirectory()
      : metadata.isFile();
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    metadata.isSymbolicLink() ||
    !expectedKindMatches ||
    (currentUid !== null && metadata.uid !== currentUid)
  ) {
    throw new Error('runner_instance_id_state_path_untrusted');
  }
  if ((metadata.mode & 0o777) !== opts.expectedMode) {
    throw new Error('runner_instance_id_state_permissions_insecure');
  }
  return { found: true, metadata };
}
