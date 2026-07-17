import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkAutonomousReadiness } from './autonomousReadiness.mjs';

const detected = {
  installed: true,
  authenticated: true,
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
            tool: 'orgx_bootstrap',
            schema_bounded: true,
          },
        }),
      },
    });

    assert.equal(result.ready, true);
    assert.equal(result.repo_ready, true);
    assert.equal(result.codex.auth_method, 'chatgpt');
    assert.equal(result.mcp.proof.tool, 'orgx_bootstrap');
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
});
