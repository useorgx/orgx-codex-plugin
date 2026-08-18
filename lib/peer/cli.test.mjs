/**
 * Entrypoint-guard tests.
 *
 * Regression locked down here: the launchd runner starts the peer through the
 * npm bin shim (`node_modules/.bin/orgx-codex-peer`), which is a SYMLINK to
 * lib/peer/cli.mjs. Node reports the symlink path in `process.argv[1]` but
 * resolves `import.meta.url` to the real path, so a naive href comparison makes
 * the guard false and the peer exits 0 without ever starting.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isDirectRun, main } from './cli.mjs';

let workdir;
let realModulePath;
let symlinkPath;

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'codex-cli-guard-'));
  await mkdir(join(workdir, 'lib'), { recursive: true });
  await mkdir(join(workdir, 'bin'), { recursive: true });

  realModulePath = join(workdir, 'lib', 'cli.mjs');
  await writeFile(realModulePath, '// entrypoint stand-in\n');

  symlinkPath = join(workdir, 'bin', 'orgx-codex-peer');
  await symlink(realModulePath, symlinkPath);
});

after(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('isDirectRun', () => {
  it('is true when invoked through the real module path', () => {
    assert.equal(
      isDirectRun({
        argvPath: realModulePath,
        moduleUrl: pathToFileURL(realModulePath).href,
      }),
      true
    );
  });

  it('REGRESSION: is true when invoked through a .bin symlink', () => {
    // This is exactly how launchd starts the runner. A naive
    // `import.meta.url === pathToFileURL(argv[1]).href` returns false here,
    // which silently prevents the peer from ever starting.
    assert.equal(
      isDirectRun({
        argvPath: symlinkPath,
        moduleUrl: pathToFileURL(realModulePath).href,
      }),
      true
    );
  });

  it('demonstrates the naive guard would have failed on the symlink', () => {
    const naive = pathToFileURL(realModulePath).href === pathToFileURL(symlinkPath).href;
    assert.equal(naive, false, 'symlink and real path must differ (test premise)');
  });

  it('is false for an unrelated entrypoint', () => {
    assert.equal(
      isDirectRun({
        argvPath: join(workdir, 'lib', 'cli.mjs'),
        moduleUrl: pathToFileURL(join(workdir, 'bin')).href,
      }),
      false
    );
  });

  it('is false when argv[1] is absent (module import)', () => {
    assert.equal(isDirectRun({ argvPath: undefined }), false);
  });

  it('does not throw when realpath fails, and still resolves', () => {
    const missing = join(workdir, 'does-not-exist.mjs');
    assert.doesNotThrow(() =>
      isDirectRun({ argvPath: missing, moduleUrl: pathToFileURL(missing).href })
    );
    // Falls back to the literal comparison rather than crashing.
    assert.equal(
      isDirectRun({ argvPath: missing, moduleUrl: pathToFileURL(missing).href }),
      true
    );
  });

  it('propagates a throwing realpath impl into the fallback path', () => {
    const throwing = () => {
      throw new Error('EACCES');
    };
    assert.equal(
      isDirectRun({
        argvPath: realModulePath,
        moduleUrl: pathToFileURL(realModulePath).href,
        realpathSyncImpl: throwing,
      }),
      true
    );
  });
});

describe('main', () => {
  it('exits 2 without credentials instead of starting a peer', async () => {
    const errors = [];
    let started = false;
    const code = await main({
      env: {},
      log: () => {},
      error: (msg) => errors.push(msg),
      startPeerImpl: async () => {
        started = true;
        return { stop: async () => {} };
      },
      registerSignalHandlers: false,
    });
    assert.equal(code, 2);
    assert.equal(started, false);
    assert.match(errors.join(' '), /ORGX_API_KEY/);
  });

  it('starts the peer when credentials are present', async () => {
    let seen = null;
    const code = await main({
      env: {
        ORGX_API_KEY: 'oxk_test_key',
        ORGX_WORKSPACE_ID: 'ws-1',
        ORGX_BASE_URL: 'https://example.test',
      },
      log: () => {},
      error: () => {},
      startPeerImpl: async (o) => {
        seen = o;
        return { stop: async () => {} };
      },
      registerSignalHandlers: false,
    });
    assert.equal(code, 0);
    assert.equal(seen.workspaceId, 'ws-1');
    assert.equal(seen.baseUrl, 'https://example.test');
  });
});
