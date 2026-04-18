/**
 * CodexDriver tests — fake `codex` shim on PATH emits a scripted NDJSON
 * trace based on $CODEX_FIXTURE.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexDriver } from './CodexDriver.mjs';

let workdir;
let originalPath;

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'codex-peer-test-'));
  const fixtures = {
    SUCCESS_TRACE: [
      JSON.stringify({ kind: 'tool_call', tool: 'read_file', summary: 'src/billing.ts' }),
      JSON.stringify({
        kind: 'file_edit',
        path: 'src/billing.ts',
        summary: 'refactored error handling per error_context rule',
      }),
      JSON.stringify({ kind: 'tokens_used', delta: 1200 }),
      JSON.stringify({ kind: 'assistant_completed', tokens_used: 1200 }),
    ].join('\n'),
    ERROR_TRACE: [
      JSON.stringify({ kind: 'error', message: 'rate-limited', recoverable: true }),
    ].join('\n'),
  };

  const shim = `#!/usr/bin/env node
const fixture = process.env.CODEX_FIXTURE;
const traces = ${JSON.stringify(fixtures)};
if (process.argv.includes('--version')) {
  process.stdout.write('codex 0.5.1\\n');
  process.exit(0);
}
const trace = traces[fixture] || '';
if (trace) process.stdout.write(trace + '\\n');
process.exit(0);
`;
  const shimPath = join(workdir, 'codex');
  await writeFile(shimPath, shim);
  await chmod(shimPath, 0o755);

  originalPath = process.env.PATH;
  process.env.PATH = `${workdir}:${originalPath}`;
});

after(async () => {
  process.env.PATH = originalPath;
  await rm(workdir, { recursive: true, force: true });
});

async function collect(gen) {
  const out = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe('CodexDriver', () => {
  it('detect reports installed + authenticated', async () => {
    const d = new CodexDriver();
    const s = await d.detect();
    assert.equal(s.installed, true);
    assert.equal(s.authenticated, true);
    assert.match(s.version ?? '', /codex 0\.5\.1/);
  });

  it('dispatch yields task.started → task.step → task.completed', async () => {
    process.env.CODEX_FIXTURE = 'SUCCESS_TRACE';
    const d = new CodexDriver({ skillRules: async () => [] });
    const msgs = await collect(
      d.dispatch(
        { title: 'refactor billing error handling', driver: 'codex' },
        { run_id: 'r1', idempotency_key: 'k1' }
      )
    );
    const kinds = msgs.map((m) => m.kind);
    assert.ok(kinds.includes('task.started'));
    assert.equal(kinds.filter((k) => k === 'task.step').length, 2);
    assert.equal(kinds[kinds.length - 1], 'task.completed');
    const completed = msgs.at(-1);
    assert.equal(completed.provider, 'openai');
    assert.equal(completed.source_sub_type, 'subscription');
    assert.equal(completed.source_driver, 'codex');
    assert.equal(completed.tokens_used, 1200);
  });

  it('emits task.deviation when a skill rule matches', async () => {
    process.env.CODEX_FIXTURE = 'SUCCESS_TRACE';
    const d = new CodexDriver({
      skillRules: async () => [
        {
          skill_id: 'error-context',
          match: { pattern: 'error handling', on: 'file_edit' },
          dedupe_fingerprint: 'error-context-v1',
          evidence_kind: 'error_shape_shift',
        },
      ],
    });
    const msgs = await collect(
      d.dispatch(
        { title: 'anything', driver: 'codex' },
        { run_id: 'r1', idempotency_key: 'k1' }
      )
    );
    const deviations = msgs.filter((m) => m.kind === 'task.deviation');
    assert.equal(deviations.length, 1);
    assert.equal(deviations[0].skill_id, 'error-context');
  });

  it('emits task.failed on an error event', async () => {
    process.env.CODEX_FIXTURE = 'ERROR_TRACE';
    const d = new CodexDriver({ skillRules: async () => [] });
    const msgs = await collect(
      d.dispatch(
        { title: 'anything', driver: 'codex' },
        { run_id: 'r1', idempotency_key: 'k1' }
      )
    );
    const failed = msgs.find((m) => m.kind === 'task.failed');
    assert.ok(failed);
    assert.equal(failed.recoverable, true);
  });
});
