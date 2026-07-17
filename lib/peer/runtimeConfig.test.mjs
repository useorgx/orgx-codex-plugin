import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateAutonomousRepoPath } from './runtimeConfig.mjs';

describe('autonomous runner repo binding', () => {
  it('accepts only a canonical git worktree root', async () => {
    const status = await validateAutonomousRepoPath('/work/orgx', {
      realpathImpl: async (value) => value,
      statImpl: async (value) => ({
        isDirectory: () => value === '/work/orgx',
      }),
      gitRootResolver: async () => '/work/orgx',
      homeDir: '/home/operator',
    });
    assert.deepEqual(status, {
      ready: true,
      path: '/work/orgx',
      reason: null,
    });
  });

  it('rejects missing, relative, home, and nested checkout paths', async () => {
    assert.equal((await validateAutonomousRepoPath()).reason, 'autonomous_repo_path_missing');
    assert.equal(
      (await validateAutonomousRepoPath('orgx')).reason,
      'autonomous_repo_path_not_absolute'
    );
    const shared = {
      realpathImpl: async (value) => value,
      statImpl: async (value) => ({ isDirectory: () => !value.endsWith('.git') }),
      homeDir: '/home/operator',
    };
    assert.equal(
      (await validateAutonomousRepoPath('/home/operator', shared)).reason,
      'autonomous_repo_path_too_broad'
    );
    assert.equal(
      (
        await validateAutonomousRepoPath('/work/orgx/packages/app', {
          ...shared,
          gitRootResolver: async () => '/work/orgx',
        })
      ).reason,
      'autonomous_repo_path_not_worktree_root'
    );
  });
});
