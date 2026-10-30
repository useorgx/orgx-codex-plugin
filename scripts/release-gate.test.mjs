import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { isReleaseEvent, releaseDecision, releaseMetadata } from './release-gate.mjs';

const headSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const annotatedSha = 'c'.repeat(40);
const repository = 'useorgx/orgx-codex-plugin';
const api = `https://api.github.com/repos/${repository}`;
const name = '@useorgx/codex-plugin';

function reply(status, body) {
  return { status, json: async () => body };
}

function fixture({ version = '0.1.25', event = {}, responses = {} } = {}) {
  const env = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: `v${version}`,
    GITHUB_REF: `refs/tags/v${version}`,
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: headSha,
    GH_TOKEN: 'test-token',
    ...event,
  };
  const metadata = releaseMetadata({ name, version }, { version }, { version }, env);
  const urls = {
    tag: `${api}/git/ref/tags/v${version}`,
    annotation: `${api}/git/tags/${annotatedSha}`,
    registry: `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    release: `${api}/releases/tags/v${version}`,
  };
  const defaults = {
    tag: reply(200, { object: { type: 'commit', sha: headSha } }),
    annotation: reply(200, { object: { type: 'commit', sha: headSha } }),
    registry: reply(404, `version not found: ${version}`),
    release: reply(404, { message: 'Not Found' }),
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(options.method === undefined || options.method === 'GET', 'preflight must be read-only');
    assert.equal(options.redirect, 'error', 'lookups must not follow credential-bearing redirects');
    assert.ok(options.signal instanceof AbortSignal, 'lookups must have a timeout');
    if (url.startsWith('https://registry.npmjs.org/')) {
      assert.equal(options.headers.Authorization, undefined, 'GitHub token must not reach npm');
    } else {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
    }
    const key = Object.keys(urls).find((candidate) => urls[candidate] === url);
    assert.ok(key, `unexpected request: ${url}`);
    const response = responses[key] ?? defaults[key];
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    env, metadata, calls, urls,
    run: (overrides = {}) => releaseDecision({ metadata, env, headSha, fetchImpl, ...overrides }),
  };
}

test('a new version publishes only at its matching lightweight tag', async () => {
  const scenario = fixture();
  assert.equal(isReleaseEvent(scenario.env, scenario.metadata), true);
  const decision = await scenario.run();
  assert.equal(decision.publish, true);
  assert.equal(decision.release_tag, 'v0.1.25');
  assert.equal(decision.npm_tag, 'latest');
  assert.equal(scenario.calls.length, 3);
  assert.equal(scenario.calls[0].url, scenario.urls.tag);
});

test('a new version supports an annotated tag resolving to the validated commit', async () => {
  const scenario = fixture({ responses: {
    tag: reply(200, { object: { type: 'tag', sha: annotatedSha } }),
  } });
  assert.equal((await scenario.run()).publish, true);
  assert.deepEqual(scenario.calls.slice(0, 2).map(({ url }) => url), [scenario.urls.tag, scenario.urls.annotation]);
});

test('published npm versions are skipped, including a partial release without GitHub assets', async () => {
  for (const githubExists of [false, true]) {
    const scenario = fixture({ version: '0.1.24', responses: {
      registry: reply(200, { name, version: '0.1.24' }),
      ...(githubExists ? { release: reply(200, {
        id: 413120716, tag_name: 'v0.1.24', assets: [{ id: 669396256, name: 'useorgx-codex-plugin-0.1.24.tgz' }],
      }) } : {}),
    } });
    const decision = await scenario.run();
    assert.equal(decision.publish, false);
    assert.equal(decision.reason, 'version already published to npm');
  }
});

test('an existing GitHub release is skipped with or without assets when npm is absent', async () => {
  for (const assets of [[], [{ id: 1, name: 'useorgx-codex-plugin-0.1.25.tgz' }]]) {
    const scenario = fixture({ responses: {
      release: reply(200, { id: 1, tag_name: 'v0.1.25', assets }),
    } });
    const decision = await scenario.run();
    assert.equal(decision.publish, false);
    assert.equal(decision.reason, 'GitHub release already exists');
  }
});

for (const status of [301, 401, 403, 408, 429, 500, 502, 503]) {
  test(`registry HTTP ${status} fails closed`, async () => {
    const scenario = fixture({ responses: { registry: reply(status, { error: 'unavailable' }) } });
    await assert.rejects(scenario.run(), new RegExp(`HTTP ${status}`));
  });
}

for (const [label, response] of [
  ['network failure', new Error('socket disconnected')],
  ['timeout', new Error('request timed out')],
  ['invalid JSON', { status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } }],
  ['non-JSON 404', { status: 404, json: async () => { throw new SyntaxError('proxy HTML'); } }],
  ['ambiguous 404', reply(404, { message: 'Not Found' })],
  ['proxy 404 error', reply(404, { error: 'version not found: 0.1.25' })],
  ['other version 404', reply(404, 'version not found: 0.1.26')],
  ['empty 404 error', reply(404, { error: '' })],
  ['wrong version', reply(200, { name, version: '0.1.26' })],
  ['wrong package', reply(200, { name: '@other/plugin', version: '0.1.25' })],
  ['missing metadata', reply(200, {})],
  ['null metadata', reply(200, null)],
]) {
  test(`registry ${label} cannot authorize publication`, async () => {
    await assert.rejects(fixture({ responses: { registry: response } }).run());
  });
}

for (const [label, response] of [
  ['unauthorized', reply(401, { message: 'Bad credentials' })],
  ['forbidden', reply(403, { message: 'Forbidden' })],
  ['rate limit', reply(429, { message: 'Rate limited' })],
  ['outage', reply(503, { message: 'Unavailable' })],
  ['network error', new Error('connection reset')],
  ['ambiguous 404', reply(404, { error: 'Not found' })],
  ['invalid JSON', { status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } }],
  ['wrong tag', reply(200, { id: 1, tag_name: 'v0.1.26', assets: [] })],
  ['missing assets', reply(200, { id: 1, tag_name: 'v0.1.25' })],
  ['null metadata', reply(200, null)],
]) {
  test(`GitHub release ${label} fails closed`, async () => {
    await assert.rejects(fixture({ responses: { release: response } }).run());
  });
}

test('published npm status does not mask an inconclusive GitHub lookup', async () => {
  await assert.rejects(fixture({ responses: {
    registry: reply(200, { name, version: '0.1.25' }),
    release: reply(503, { message: 'Unavailable' }),
  } }).run(), /HTTP 503/);
});

test('an existing GitHub release does not mask an inconclusive registry lookup', async () => {
  await assert.rejects(fixture({ responses: {
    registry: reply(503, { error: 'Unavailable' }),
    release: reply(200, { id: 1, tag_name: 'v0.1.25', assets: [] }),
  } }).run(), /HTTP 503/);
});

for (const [label, response] of [
  ['missing', reply(404, { message: 'Not Found' })],
  ['lookup failure', reply(503, { message: 'Unavailable' })],
  ['different commit', reply(200, { object: { type: 'commit', sha: otherSha } })],
  ['invalid object', reply(200, { object: { type: 'tree', sha: headSha } })],
  ['missing object', reply(200, {})],
  ['invalid annotation ID', reply(200, { object: { type: 'tag', sha: '../invalid' } })],
]) {
  test(`remote tag ${label} fails before registry or release lookups`, async () => {
    const scenario = fixture({ responses: { tag: response } });
    await assert.rejects(scenario.run());
    assert.equal(scenario.calls.length, 1);
  });
}

test('annotated tags cannot hide a different commit or a cyclic annotation', async () => {
  for (const object of [{ type: 'commit', sha: otherSha }, { type: 'tag', sha: annotatedSha }]) {
    const scenario = fixture({ responses: {
      tag: reply(200, { object: { type: 'tag', sha: annotatedSha } }),
      annotation: reply(200, { object }),
    } });
    await assert.rejects(scenario.run(), /remote version tag/);
    assert.ok(scenario.calls.length <= 11);
    assert.ok(scenario.calls.every(({ url }) => !url.includes('/releases/') && !url.includes('registry.npmjs.org')));
  }
});

test('checkout and event SHA must match before any remote lookup', async () => {
  for (const checkout of [otherSha, '', 'not-a-sha']) {
    const scenario = fixture();
    await assert.rejects(scenario.run({ headSha: checkout }), /checkout does not match/);
    assert.equal(scenario.calls.length, 0);
  }
});

test('release lookup requires a token and a well-formed repository', async () => {
  for (const event of [{ GH_TOKEN: '' }, { GITHUB_REPOSITORY: '' }, { GITHUB_REPOSITORY: 'owner/repo/extra' }]) {
    const scenario = fixture({ event });
    await assert.rejects(scenario.run(), /repository and token/);
    assert.equal(scenario.calls.length, 0);
  }
});

for (const [label, event] of [
  ['pull request', { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: '80/merge', GITHUB_REF: 'refs/pull/80/merge' }],
  ['main push', { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_REF: 'refs/heads/main' }],
  ['version-like branch', { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'v0.1.25', GITHUB_REF: 'refs/heads/v0.1.25' }],
  ['manual dispatch', { GITHUB_EVENT_NAME: 'workflow_dispatch' }],
  ['release event', { GITHUB_EVENT_NAME: 'release' }],
  ['schedule', { GITHUB_EVENT_NAME: 'schedule' }],
  ['inconsistent ref', { GITHUB_REF: 'refs/tags/v0.1.26' }],
]) {
  test(`${label} is validation-only and performs no lookup`, async () => {
    const scenario = fixture({ event: { ...event, GH_TOKEN: '' } });
    assert.equal(isReleaseEvent(scenario.env, scenario.metadata), false);
    const decision = await scenario.run();
    assert.equal(decision.publish, false);
    assert.equal(decision.reason, 'validation-only event');
    assert.equal(scenario.calls.length, 0);
  });
}

test('all three manifest versions and an explicit version tag must agree', () => {
  for (const versions of [
    ['0.1.25', '0.1.24', '0.1.25'],
    ['0.1.25', '0.1.25', '0.1.24'],
  ]) {
    assert.throws(() => releaseMetadata({ name, version: versions[0] }, { version: versions[1] }, { version: versions[2] }, {}), /versions disagree/);
  }
  assert.throws(() => fixture({ event: { GITHUB_REF_NAME: 'v0.1.24' } }), /does not match package/);
});

test('prereleases keep the alpha npm dist-tag', async () => {
  const scenario = fixture({ version: '0.1.25-alpha.1' });
  const decision = await scenario.run();
  assert.equal(decision.publish, true);
  assert.equal(decision.npm_tag, 'alpha');
  assert.equal(decision.release_tag, 'v0.1.25-alpha.1');
});

test('release metadata cannot inject shell or workflow output syntax', () => {
  for (const version of ['0.1.25\npublish=true', '$(command)', '']) {
    assert.throws(() => releaseMetadata({ name, version }, { version }, { version }, {}), /invalid release/);
  }
  assert.throws(() => releaseMetadata({ name: 'bad\nname', version: '0.1.25' }, { version: '0.1.25' }, { version: '0.1.25' }, {}), /invalid release/);
});

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const [, validate, release] = workflow.split(/^  (?:validate|release):\n/m);

test('workflow retains PR/main validation and requires it before a version-tag push release', () => {
  assert.match(workflow, /^on:\n  pull_request:\n  push:\n    branches:\n      - main\n    tags:\n      - "v\*"/m);
  assert.match(validate, /^      - run: npm run check$/m);
  assert.match(validate, /^      - run: npm test$/m);
  assert.match(validate, /run: node scripts\/release-gate\.mjs --validate/);
  assert.match(release, /^    needs: validate$/m);
  assert.match(release, /^    if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)$/m);
});

test('every release step after preflight requires the affirmative publish gate', () => {
  const steps = release.split(/^      - name: /m).slice(1);
  const preflight = steps.findIndex((step) => step.startsWith('Check immutable release identity\n'));
  assert.ok(preflight >= 0);
  assert.match(steps[preflight], /^        id: release$/m);
  assert.match(steps[preflight], /^        run: node scripts\/release-gate\.mjs$/m);
  const gatedSteps = steps.slice(preflight + 1);
  assert.equal(gatedSteps.length, 6);
  for (const step of gatedSteps) {
    assert.match(step, /^        if: steps\.release\.outputs\.publish == 'true'$/m, step.split('\n')[0]);
  }
  assert.match(release, /npm publish .* --access public --provenance --tag/);
  assert.match(release, /name: validated-release-tarball/);
});

test('GitHub publication is create-only and cannot overwrite assets or edit old notes', () => {
  assert.match(release, /^        run: gh release create "\$RELEASE_TAG" \.\/artifacts\/\*\.tgz --verify-tag --generate-notes$/m);
  assert.doesNotMatch(release, /softprops\/action-gh-release|gh release (?:edit|upload|delete)|--clobber|--force|git push/);
});

test('workflow retains existing signing, runner, serialization and OIDC boundaries', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(validate, /^    runs-on: ubuntu-latest$/m);
  assert.match(release, /^    runs-on: ubuntu-latest$/m);
  assert.match(validate, /name: Stamp manifest fingerprint from the packed file set\n        run: node scripts\/stamp-manifest\.mjs\n        env:\n          ORGX_MANIFEST_SIGNING_KEY: \$\{\{ secrets\.ORGX_MANIFEST_SIGNING_KEY \}\}/);
  assert.equal((workflow.match(/secrets\.ORGX_MANIFEST_SIGNING_KEY/g) ?? []).length, 1);
  assert.match(release, /^    permissions:\n      contents: write\n      id-token: write$/m);
  assert.match(release, /^    concurrency:\n      group: npm-release\n      cancel-in-progress: false$/m);
});
