import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { main } from './cli.mjs';

describe('orgx-codex-peer CLI', () => {
  it('runs the one-shot readiness doctor without Gateway credentials', async () => {
    const output = [];
    const code = await main({
      argv: ['check-autonomous-readiness'],
      env: { ORGX_AUTONOMOUS_REPO_PATH: '/runner/orgx' },
      log: (line) => output.push(line),
      checkAutonomousReadinessImpl: async (input) => ({
        ready: true,
        reason: null,
        repo_path_seen: input.autonomousRepoPath,
      }),
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
});
