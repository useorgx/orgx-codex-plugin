import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureGatewayCredential,
  sanitizedChildProcessEnv,
} from './childProcessEnv.mjs';

describe('peer child-process environment isolation', () => {
  it('captures and removes both accepted gateway credential variables', () => {
    const env = {
      ORGX_API_KEY: 'oxk_primary',
      ORGX_GATEWAY_KEY: 'oxk_legacy',
      ORGX_WORKSPACE_ID: 'workspace-1',
    };

    assert.equal(captureGatewayCredential(env), 'oxk_primary');
    assert.equal(env.ORGX_API_KEY, undefined);
    assert.equal(env.ORGX_GATEWAY_KEY, undefined);
    assert.equal(env.ORGX_WORKSPACE_ID, 'workspace-1');
  });

  it('removes gateway credentials after overrides while preserving run scope', () => {
    const child = sanitizedChildProcessEnv(
      { PATH: '/bin', ORGX_API_KEY: 'oxk_parent' },
      {
        ORGX_GATEWAY_KEY: 'oxk_override',
        ORGX_RUN_ID: 'run-1',
      },
    );

    assert.deepEqual(child, { PATH: '/bin', ORGX_RUN_ID: 'run-1' });
  });
});
