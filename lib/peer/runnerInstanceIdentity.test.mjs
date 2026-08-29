import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultInstallationId,
  normalizeRunnerInstanceId,
  resolveRunnerActivationBinding,
  resolveRunnerInstanceId,
} from './runnerInstanceIdentity.mjs';

describe('runner instance identity', () => {
  it('requires an explicit identity for autonomous dispatch', async () => {
    await assert.rejects(
      resolveRunnerInstanceId({
        workspaceId: 'workspace-a',
        installationId: 'install-a',
        autonomousDispatchEnabled: true,
      }),
      /runner_instance_id_required_for_autonomous_dispatch/,
    );
  });

  it('accepts a bounded explicit identity without touching local state', async () => {
    assert.equal(
      await resolveRunnerInstanceId({
        configuredId: ' candidate-01 ',
        workspaceId: 'workspace-a',
        installationId: 'install-a',
        autonomousDispatchEnabled: true,
        mkdirImpl: async () => assert.fail('explicit identity must not persist'),
      }),
      'candidate-01',
    );
    assert.equal(normalizeRunnerInstanceId('bad instance id'), null);
  });

  it('accepts only a complete candidate or canonical activation binding', () => {
    assert.deepEqual(
      resolveRunnerActivationBinding({
        activationAttemptId: ' attempt-01 ',
        runnerRole: 'candidate',
      }),
      { activationAttemptId: 'attempt-01', runnerRole: 'candidate' },
    );
    assert.deepEqual(resolveRunnerActivationBinding(), {
      activationAttemptId: null,
      runnerRole: null,
    });
    assert.throws(
      () => resolveRunnerActivationBinding({ runnerRole: 'canonical' }),
      /runner_activation_binding_incomplete/,
    );
    assert.throws(
      () =>
        resolveRunnerActivationBinding({
          activationAttemptId: 'attempt-01',
          runnerRole: 'primary',
        }),
      /runner_role_invalid/,
    );
  });

  it('persists one stable mode-0600 identity for a manual binding', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'orgx-runner-identity-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let generated = 0;
    const opts = {
      workspaceId: 'workspace-manual',
      installationId: 'install-manual',
      autonomousDispatchEnabled: false,
      stateDirectory: directory,
      randomUUIDImpl: () => {
        generated += 1;
        return '11111111-1111-4111-8111-111111111111';
      },
    };

    const first = await resolveRunnerInstanceId(opts);
    const second = await resolveRunnerInstanceId(opts);

    assert.equal(first, 'codex-11111111-1111-4111-8111-111111111111');
    assert.equal(second, first);
    assert.equal(generated, 1);
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    assert.equal((await readFile(join(directory, names[0]), 'utf8')).trim(), first);
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(directory, names[0]))).mode & 0o777, 0o600);
    }
  });

  it('fails closed instead of replacing corrupted persisted identity state', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'orgx-runner-identity-bad-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const first = await resolveRunnerInstanceId({
      workspaceId: 'workspace-bad',
      installationId: 'install-bad',
      autonomousDispatchEnabled: false,
      stateDirectory: directory,
      randomUUIDImpl: () => '22222222-2222-4222-8222-222222222222',
    });
    assert.ok(first);
    const names = await readdir(directory);
    await writeFile(join(directory, names[0]), 'not a valid identity\n');

    await assert.rejects(
      resolveRunnerInstanceId({
        workspaceId: 'workspace-bad',
        installationId: 'install-bad',
        autonomousDispatchEnabled: false,
        stateDirectory: directory,
      }),
      /runner_instance_id_state_invalid/,
    );
  });

  it('rejects an existing identity file with insecure permissions', async (t) => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'orgx-runner-identity-mode-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const opts = {
      workspaceId: 'workspace-mode',
      installationId: 'install-mode',
      autonomousDispatchEnabled: false,
      stateDirectory: directory,
      randomUUIDImpl: () => '55555555-5555-4555-8555-555555555555',
    };
    await resolveRunnerInstanceId(opts);
    const [name] = await readdir(directory);
    const path = join(directory, name);
    await chmod(path, 0o644);

    await assert.rejects(
      resolveRunnerInstanceId(opts),
      /runner_instance_id_state_permissions_insecure/,
    );
    assert.equal((await stat(path)).mode & 0o777, 0o644);
  });

  it('rejects an insecure state directory instead of silently repairing it', async (t) => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'orgx-runner-state-mode-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await chmod(directory, 0o755);

    await assert.rejects(
      resolveRunnerInstanceId({
        workspaceId: 'workspace-directory-mode',
        installationId: 'install-directory-mode',
        autonomousDispatchEnabled: false,
        stateDirectory: directory,
      }),
      /runner_instance_id_state_permissions_insecure/,
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
  });

  it('rejects a symlinked identity state path without following it', async (t) => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'orgx-runner-identity-link-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const opts = {
      workspaceId: 'workspace-link',
      installationId: 'install-link',
      autonomousDispatchEnabled: false,
      stateDirectory: directory,
      randomUUIDImpl: () => '66666666-6666-4666-8666-666666666666',
    };
    await resolveRunnerInstanceId(opts);
    const bindingName = (await readdir(directory)).find((name) =>
      name.endsWith('.id')
    );
    assert.ok(bindingName);
    await rm(join(directory, bindingName));
    const target = join(directory, 'untrusted-target');
    await writeFile(target, 'attacker-controlled\n', { mode: 0o600 });
    await symlink(target, join(directory, bindingName));

    await assert.rejects(
      resolveRunnerInstanceId(opts),
      /runner_instance_id_state_path_untrusted/,
    );
    assert.equal(await readFile(target, 'utf8'), 'attacker-controlled\n');
  });

  it('publishes exactly one complete identity across concurrent manual starts', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'orgx-runner-identity-race-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const generated = [
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    let writesReady = 0;
    let releaseWrites;
    const bothWritten = new Promise((resolve) => {
      releaseWrites = resolve;
    });
    const opts = {
      workspaceId: 'workspace-race',
      installationId: 'install-race',
      autonomousDispatchEnabled: false,
      stateDirectory: directory,
      randomUUIDImpl: () => generated.shift(),
      writeFileImpl: async (...args) => {
        await writeFile(...args);
        writesReady += 1;
        if (writesReady === 2) releaseWrites();
        await bothWritten;
      },
    };

    const [first, second] = await Promise.all([
      resolveRunnerInstanceId(opts),
      resolveRunnerInstanceId(opts),
    ]);

    assert.equal(first, second);
    assert.match(first, /^codex-(33333333|44444444)-/);
    const names = await readdir(directory);
    assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), []);
    assert.equal(names.filter((name) => name.endsWith('.id')).length, 1);
  });

  it('keeps the legacy installation identity stable', () => {
    assert.equal(
      defaultInstallationId({ platform: 'linux', user: 'runner' }),
      'orgx-codex-plugin:linux:runner',
    );
  });
});
