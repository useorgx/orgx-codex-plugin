import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main } from './cli.mjs';

describe('orgx-codex-peer CLI', () => {
  it('runs through an npm-style bin symlink', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orgx-codex-bin-'));
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
    const binPath = join(tempDir, 'orgx-codex-peer');

    try {
      symlinkSync(cliPath, binPath);
      const result = spawnSync(process.execPath, [binPath], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });

      assert.equal(result.status, 2);
      assert.match(
        result.stderr,
        /Missing ORGX_API_KEY and\/or ORGX_WORKSPACE_ID/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs the one-shot readiness doctor without Gateway credentials', async () => {
    const output = [];
    const env = {
      ORGX_API_KEY: 'oxk_must_not_reach_readiness',
      ORGX_GATEWAY_KEY: 'oxk_legacy_must_not_reach_readiness',
      ORGX_AUTONOMOUS_REPO_PATH: '/runner/orgx',
    };
    const code = await main({
      argv: ['check-autonomous-readiness'],
      env,
      log: (line) => output.push(line),
      checkAutonomousReadinessImpl: async (input) => {
        assert.equal(env.ORGX_API_KEY, undefined);
        assert.equal(env.ORGX_GATEWAY_KEY, undefined);
        return {
          ready: true,
          reason: null,
          repo_path_seen: input.autonomousRepoPath,
        };
      },
    });

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output[0]), {
      ready: true,
      reason: null,
      repo_path_seen: '/runner/orgx',
    });
  });

  it('returns nonzero when the readiness doctor fails closed', async () => {
    const output = [];
    const code = await main({
      argv: ['check-autonomous-readiness'],
      env: {},
      log: (line) => output.push(line),
      checkAutonomousReadinessImpl: async () => ({
        ready: false,
        reason: 'autonomous_repo_path_missing',
      }),
    });

    assert.equal(code, 1);
    assert.equal(JSON.parse(output[0]).ready, false);
  });

  it('fails closed when an autonomous service omits its installed instance id', async () => {
    const errors = [];
    let started = false;
    const code = await main({
      env: {
        ORGX_API_KEY: 'oxk_test_only',
        ORGX_WORKSPACE_ID: 'workspace-autonomous',
        ORGX_AUTONOMOUS_DISPATCH_ENABLED: 'true',
      },
      error: (line) => errors.push(line),
      startPeerImpl: async () => {
        started = true;
        return { stop: async () => undefined };
      },
      registerSignalHandlers: false,
    });

    assert.equal(code, 2);
    assert.equal(started, false);
    assert.match(errors[0], /runner_instance_id_required_for_autonomous_dispatch/);
  });

  it('propagates the installer-persisted runner instance id into the peer', async () => {
    let received;
    const env = {
      ORGX_API_KEY: 'oxk_test_only',
      ORGX_GATEWAY_KEY: 'oxk_legacy_must_also_be_removed',
      ORGX_WORKSPACE_ID: 'workspace-autonomous',
      ORGX_INSTALLATION_ID: 'installation-autonomous',
      ORGX_RUNNER_INSTANCE_ID: 'candidate-service-01',
      ORGX_ACTIVATION_ATTEMPT_ID: 'activation-attempt-01',
      ORGX_RUNNER_ROLE: 'candidate',
      ORGX_AUTONOMOUS_DISPATCH_ENABLED: 'true',
      ORGX_AUTONOMOUS_REPO_PATH: '/runner/orgx',
    };
    const code = await main({
      env,
      log: () => undefined,
      startPeerImpl: async (opts) => {
        received = opts;
        return { stop: async () => undefined };
      },
      registerSignalHandlers: false,
    });

    assert.equal(code, 0);
    assert.equal(received.installationId, 'installation-autonomous');
    assert.equal(received.runnerInstanceId, 'candidate-service-01');
    assert.equal(received.activationAttemptId, 'activation-attempt-01');
    assert.equal(received.runnerRole, 'candidate');
    assert.equal(received.autonomousDispatchEnabled, true);
    assert.equal(received.apiKey, 'oxk_test_only');
    assert.equal(env.ORGX_API_KEY, undefined);
    assert.equal(env.ORGX_GATEWAY_KEY, undefined);
  });

  it('rejects a partial activation binding before the peer starts', async () => {
    const errors = [];
    let started = false;
    const code = await main({
      env: {
        ORGX_API_KEY: 'oxk_test_only',
        ORGX_WORKSPACE_ID: 'workspace-candidate',
        ORGX_RUNNER_INSTANCE_ID: 'candidate-service-02',
        ORGX_ACTIVATION_ATTEMPT_ID: 'activation-attempt-02',
      },
      error: (line) => errors.push(line),
      startPeerImpl: async () => {
        started = true;
        return { stop: async () => undefined };
      },
      registerSignalHandlers: false,
    });

    assert.equal(code, 2);
    assert.equal(started, false);
    assert.match(errors[0], /runner_activation_binding_incomplete/);
  });

  it('uses the persisted manual identity resolver for interactive launches', async () => {
    let identityInput;
    let received;
    const code = await main({
      env: {
        ORGX_API_KEY: 'oxk_test_only',
        ORGX_WORKSPACE_ID: 'workspace-interactive',
        ORGX_INSTALLATION_ID: 'installation-interactive',
      },
      log: () => undefined,
      resolveRunnerInstanceIdImpl: async (input) => {
        identityInput = input;
        return 'persisted-manual-runner';
      },
      startPeerImpl: async (opts) => {
        received = opts;
        return { stop: async () => undefined };
      },
      registerSignalHandlers: false,
    });

    assert.equal(code, 0);
    assert.equal(identityInput.autonomousDispatchEnabled, false);
    assert.equal(identityInput.configuredId, undefined);
    assert.equal(received.runnerInstanceId, 'persisted-manual-runner');
  });
});
