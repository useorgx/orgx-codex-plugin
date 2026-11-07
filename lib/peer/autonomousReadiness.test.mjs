import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkAutonomousReadiness } from './autonomousReadiness.mjs';

const detected = {
  installed: true,
  authenticated: true,
      provider_auth_verified: true,
      quota_status: 'allowed',
  auth_method: 'chatgpt',
  version: 'codex-cli 1.2.3',
};

describe('autonomous readiness doctor', () => {
  it('returns ready only after repo, subscription, app-server, and MCP proof pass', async () => {
    const result = await checkAutonomousReadiness({
      autonomousRepoPath: '/runner/orgx',
      autonomousRepoValidator: async () => ({
        ready: true,
        path: '/runner/orgx',
        reason: null,
      }),
      driver: {
        detect: async () => detected,
        probeAutonomousMcpReadiness: async () => ({
          ready: true,
          reason: null,
          proof: {
            server: 'orgx',
            tool: 'orgx_get_workspace_context',
            schema_bounded: true,
          },
        }),
      },
    });

    assert.equal(result.ready, true);
    assert.equal(result.repo_ready, true);
    assert.equal(result.codex.auth_method, 'chatgpt');
    assert.equal(result.mcp.proof.tool, 'orgx_get_workspace_context');
  });

  it('fails before Codex probing when the runner-owned repo is invalid', async () => {
    let detectedCalled = false;
    const result = await checkAutonomousReadiness({
      autonomousRepoPath: '/broad',
      autonomousRepoValidator: async () => ({
        ready: false,
        path: null,
        reason: 'autonomous_repo_path_too_broad',
      }),
      driver: {
        detect: async () => {
          detectedCalled = true;
          return detected;
        },
      },
    });

    assert.equal(result.ready, false);
    assert.equal(result.reason, 'autonomous_repo_path_too_broad');
    assert.equal(detectedCalled, false);
  });

  it('fails closed when app-server or authenticated MCP proof is unavailable', async () => {
    const result = await checkAutonomousReadiness({
      autonomousRepoPath: '/runner/orgx',
      autonomousRepoValidator: async () => ({
        ready: true,
        path: '/runner/orgx',
        reason: null,
      }),
      driver: {
        detect: async () => detected,
        probeAutonomousMcpReadiness: async () => ({
          ready: false,
          reason: 'autonomous_mcp_probe_failed:app-server unsupported',
        }),
      },
    });

    assert.equal(result.ready, false);
    assert.equal(result.repo_ready, true);
    assert.match(result.reason, /app-server unsupported/);
  });

  it('rejects non-ChatGPT Codex authentication for subscription execution', async () => {
    let mcpCalled = false;
    const result = await checkAutonomousReadiness({
      autonomousRepoPath: '/runner/orgx',
      autonomousRepoValidator: async () => ({
        ready: true,
        path: '/runner/orgx',
        reason: null,
      }),
      driver: {
        detect: async () => ({
          ...detected,
          auth_method: 'api_key',
        }),
        probeAutonomousMcpReadiness: async () => {
          mcpCalled = true;
          return { ready: true, reason: null };
        },
      },
    });

    assert.equal(result.ready, false);
    assert.equal(result.reason, 'codex_chatgpt_subscription_required');
    assert.equal(mcpCalled, false);
  });

  for (const quota of ['blocked', 'unknown']) it(`does not admit authenticated Codex with ${quota} quota`, async () => {
    const result = await checkAutonomousReadiness({ autonomousRepoValidator: async () => ({ ready: true, path: '/owned' }),
      driver: { detect: async () => ({ ...detected, quota_status: quota }),
        probeAutonomousMcpReadiness: async () => { throw new Error('MCP must not run before usage admission'); } } });
    assert.equal(result.ready, false);
    assert.equal(result.codex.authenticated, true);
    assert.equal(result.reason, quota === 'blocked' ? 'codex_usage_blocked' : 'codex_usage_unverified');
  });

  it('rejects cached login metadata without live provider proof', async () => {
    const result = await checkAutonomousReadiness({ autonomousRepoValidator: async () => ({ ready: true, path: '/owned' }),
      driver: { detect: async () => ({ ...detected, provider_auth_verified: false, auth_status: 'provider_auth_unverified' }),
        probeAutonomousMcpReadiness: async () => { throw new Error('MCP must not confer provider authentication'); } } });
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'codex_provider_auth_unverified');
    assert.equal(result.codex.authenticated, false);
    assert.equal(result.codex.provider_auth_verified, false);
  });
});
