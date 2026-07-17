import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  prepareAutonomousCodexExecution,
  probeAutonomousMcpReadiness,
} from './autonomousCodexExecution.mjs';

const authority = {
  leaseId: 'lease-1',
  leaseDigest: `sha256:${'a'.repeat(64)}`,
  context: {
    specialist: {
      agent_id: 'engineering-agent',
      domain: 'engineering',
      instructions: 'Work only inside the bound checkout.',
    },
    assignment: { description: 'Inspect the initiative.' },
    context_pack: { initiative_id: 'initiative-1' },
  },
  allowedTools: [
    {
      mcp_server: 'orgx',
      mcp_tool: 'orgx_inspect',
      logical_capabilities: ['initiative.inspect'],
    },
  ],
  resolvedSkills: [
    {
      id: 'orgx-engineering-agent',
      version: '2.0.0',
      instructions: 'Follow the bound engineering verification workflow.',
      digest: `sha256:${'b'.repeat(64)}`,
    },
  ],
  nativePolicy: {
    mode: 'workspace_write',
    sandbox: 'workspace_write',
    shell_access: true,
  },
  mcpPolicy: {
    allowedByServer: { orgx: ['orgx_inspect'] },
    expectedSchemasByServer: { orgx: { orgx_inspect: {} } },
  },
};

describe('autonomous Codex execution preparation', () => {
  it('uses only the runner-owned checkout and discovered MCP inventory', async () => {
    const prepared = await prepareAutonomousCodexExecution(
      { title: 'task', driver: 'codex' },
      { autonomous_authority: authority },
      {
        autonomousRepoPath: '/runner/orgx',
        mcpServerDiscovery: async () => ['github', 'orgx'],
      }
    );

    assert.equal(prepared.cwd, '/runner/orgx');
    assert.deepEqual(prepared.configuredMcpServers, ['github', 'orgx']);
    assert.equal(prepared.mcpPolicy.readOnly, false);
    assert.equal(prepared.mcpPolicy.disableShell, false);
    assert.match(prepared.prompt, /Work only inside the bound checkout/);
    assert.match(prepared.prompt, /Follow the bound engineering verification workflow/);
  });

  it('rejects a conflicting server-supplied repo path', async () => {
    await assert.rejects(
      prepareAutonomousCodexExecution(
        { title: 'task', driver: 'codex', repo_path: '/server/guess' },
        { autonomous_authority: authority },
        {
          autonomousRepoPath: '/runner/orgx',
          mcpServerDiscovery: async () => ['orgx'],
        }
      ),
      /autonomous_repo_path_conflict/
    );
  });

  it('turns non-engineering native policy into read-only shell-disabled execution', async () => {
    const prepared = await prepareAutonomousCodexExecution(
      { title: 'task', driver: 'codex' },
      {
        autonomous_authority: {
          ...authority,
          nativePolicy: {
            mode: 'read_only',
            sandbox: 'read_only',
            shell_access: false,
          },
        },
      },
      {
        autonomousRepoPath: '/runner/orgx',
        mcpServerDiscovery: async () => ['orgx'],
      }
    );

    assert.equal(prepared.mcpPolicy.readOnly, true);
    assert.equal(prepared.mcpPolicy.disableShell, true);
  });

  it('marks MCP readiness false if the OrgX server is absent', async () => {
    assert.deepEqual(
      await probeAutonomousMcpReadiness({
        mcpServerDiscovery: async () => ['github'],
      }),
      { ready: false, reason: 'autonomous_mcp_server_missing:orgx' }
    );
  });

  it('requires an app-server status proof before marking MCP ready', async () => {
    const calls = [];
    const result = await probeAutonomousMcpReadiness({
      cwd: '/runner/orgx',
      mcpServerDiscovery: async () => ['github', 'orgx'],
      appServerFactory: () => ({
        async probeMcpReadiness(input) {
          calls.push(input);
          return {
            server: 'orgx',
            tool: 'orgx_bootstrap',
            schema_bounded: true,
          };
        },
        close() {
          calls.push('closed');
        },
      }),
    });

    assert.equal(result.ready, true);
    assert.equal(calls[0].mcpPolicy.readOnly, true);
    assert.equal(calls[0].mcpPolicy.disableShell, true);
    assert.deepEqual(calls[0].configuredMcpServers, ['github', 'orgx']);
    assert.equal(calls.at(-1), 'closed');
  });
});
