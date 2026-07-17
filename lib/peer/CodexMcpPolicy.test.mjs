import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CodexMcpPolicyError,
  buildCodexProcessConfigArgs,
  parseConfiguredMcpServers,
  verifyEffectiveMcpPolicy,
  verifyMcpReadinessStatus,
} from './CodexMcpPolicy.mjs';

const schema = {
  type: 'object',
  properties: { operation: { type: 'string', const: 'inspect_initiative' } },
  required: ['operation'],
  additionalProperties: false,
};
const policy = {
  allowedByServer: { orgx: ['orgx_inspect'] },
  expectedSchemasByServer: { orgx: { orgx_inspect: schema } },
};

describe('Codex MCP process policy', () => {
  it('disables every non-authorized server and enables only exact OrgX tools', () => {
    const args = buildCodexProcessConfigArgs(policy, ['github', 'orgx']);
    assert.ok(args.includes('mcp_servers.github.enabled=false'));
    assert.ok(args.includes('mcp_servers.orgx.enabled=true'));
    assert.ok(args.includes('mcp_servers.orgx.required=true'));
    assert.ok(
      args.includes('mcp_servers.orgx.enabled_tools=["orgx_inspect"]')
    );
    assert.ok(args.includes('mcp_servers.orgx.disabled_tools=[]'));
    assert.ok(args.includes('features.apps=false'));
    assert.ok(args.includes('features.plugins=false'));
  });

  it('fails when the authorized server is not locally configured', () => {
    assert.throws(
      () => buildCodexProcessConfigArgs(policy, ['github']),
      (error) =>
        error instanceof CodexMcpPolicyError && error.code === 'mcp_server_missing'
    );
  });

  it('proves the exact effective tool set and input schema', () => {
    const result = verifyEffectiveMcpPolicy(
      [
        {
          name: 'orgx',
          authStatus: 'oAuth',
          tools: {
            orgx_inspect: { name: 'orgx_inspect', inputSchema: schema },
          },
        },
        { name: 'github', authStatus: 'unsupported', tools: {} },
      ],
      policy
    );
    assert.deepEqual(result, {
      servers: ['orgx'],
      tools: ['orgx_inspect'],
    });
  });

  it('rejects an extra tool on the authorized server', () => {
    assert.throws(
      () =>
        verifyEffectiveMcpPolicy(
          [
            {
              name: 'orgx',
              authStatus: 'oAuth',
              tools: {
                orgx_inspect: { name: 'orgx_inspect', inputSchema: schema },
                orgx_act: { name: 'orgx_act', inputSchema: schema },
              },
            },
          ],
          policy
        ),
      (error) =>
        error instanceof CodexMcpPolicyError &&
        error.code === 'mcp_tool_set_mismatch'
    );
  });

  it('rejects actual MCP schema drift', () => {
    assert.throws(
      () =>
        verifyEffectiveMcpPolicy(
          [
            {
              name: 'orgx',
              authStatus: 'oAuth',
              tools: {
                orgx_inspect: {
                  name: 'orgx_inspect',
                  inputSchema: { ...schema, additionalProperties: true },
                },
              },
            },
          ],
          policy
        ),
      (error) =>
        error instanceof CodexMcpPolicyError &&
        error.code === 'mcp_tool_schema_mismatch'
    );
  });

  it('parses the supported Codex MCP discovery shape', () => {
    assert.deepEqual(
      parseConfiguredMcpServers('[{"name":"orgx"},{"name":"github"}]'),
      ['github', 'orgx']
    );
  });

  it('proves a bounded one-tool install readiness surface', () => {
    assert.deepEqual(
      verifyMcpReadinessStatus([
        {
          name: 'orgx',
          authStatus: 'oAuth',
          tools: {
            orgx_bootstrap: {
              name: 'orgx_bootstrap',
              inputSchema: schema,
            },
          },
        },
        { name: 'github', authStatus: 'unsupported', tools: {} },
      ]),
      { server: 'orgx', tool: 'orgx_bootstrap', schema_bounded: true }
    );
  });

  it('rejects unauthenticated install readiness', () => {
    assert.throws(
      () =>
        verifyMcpReadinessStatus([
          {
            name: 'orgx',
            authStatus: 'notLoggedIn',
            tools: {
              orgx_bootstrap: {
                name: 'orgx_bootstrap',
                inputSchema: schema,
              },
            },
          },
        ]),
      (error) =>
        error instanceof CodexMcpPolicyError &&
        error.code === 'mcp_server_unauthenticated'
    );
  });

  it('rejects every non-positive OAuth status even when cached tools remain', () => {
    for (const authStatus of [
      undefined,
      null,
      'notLoggedIn',
      'expired',
      'error',
      'loginRequired',
      'unsupported',
      'bearerToken',
      'oauth',
      'o_auth',
    ]) {
      assert.throws(
        () =>
          verifyEffectiveMcpPolicy(
            [
              {
                name: 'orgx',
                ...(authStatus === undefined ? {} : { authStatus }),
                tools: {
                  orgx_inspect: {
                    name: 'orgx_inspect',
                    inputSchema: schema,
                  },
                },
              },
            ],
            policy
          ),
        (error) =>
          error instanceof CodexMcpPolicyError &&
          error.code === 'mcp_server_unauthenticated',
        `expected ${String(authStatus)} to fail closed`
      );
    }
  });

  it('fails the installer doctor on missing, expired, errored, or login-required OAuth', () => {
    for (const authStatus of [undefined, 'expired', 'error', 'loginRequired']) {
      assert.throws(
        () =>
          verifyMcpReadinessStatus([
            {
              name: 'orgx',
              ...(authStatus === undefined ? {} : { authStatus }),
              tools: {
                orgx_bootstrap: {
                  name: 'orgx_bootstrap',
                  inputSchema: schema,
                },
              },
            },
          ]),
        (error) =>
          error instanceof CodexMcpPolicyError &&
          error.code === 'mcp_server_unauthenticated',
        `expected readiness status ${String(authStatus)} to fail closed`
      );
    }
  });
});
