#!/usr/bin/env node
// Read-only preflight. Only an unpublished, matching version tag may publish.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseMetadata(pkg, manifest, plugin, env) {
  if (pkg.version !== manifest.version || pkg.version !== plugin.version) {
    throw new Error('release versions disagree across package and plugin manifests');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)
      || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name)) {
    throw new Error('invalid release package name or version');
  }
  const releaseTag = `v${pkg.version}`;
  if (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME !== releaseTag) {
    throw new Error(`tag ${env.GITHUB_REF_NAME} does not match package ${releaseTag}`);
  }
  return {
    name: pkg.name,
    version: pkg.version,
    release_tag: releaseTag,
    npm_tag: pkg.version.includes('-') ? 'alpha' : 'latest',
  };
}

export function isReleaseEvent(env, metadata) {
  return env.GITHUB_EVENT_NAME === 'push'
    && env.GITHUB_REF_TYPE === 'tag'
    && env.GITHUB_REF_NAME === metadata.release_tag
    && env.GITHUB_REF === `refs/tags/${metadata.release_tag}`;
}

async function getJson(fetchImpl, url, headers = {}, absentMessage) {
  const response = await fetchImpl(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  // Authentication, rate limits, outages and malformed responses are not absence.
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`release lookup failed: HTTP ${response.status} from ${url}`);
  }
  const data = await response.json();
  if (response.status === 404) {
    if (absentMessage?.(data)) return null;
    throw new Error(`release lookup returned an unconfirmed 404 from ${url}`);
  }
  if (data === null) throw new Error(`release lookup returned empty metadata from ${url}`);
  return data;
}

export async function releaseDecision({ metadata, env, headSha, fetchImpl = fetch }) {
  const skip = (reason) => ({ ...metadata, publish: false, reason });
  if (!isReleaseEvent(env, metadata)) return skip('validation-only event');
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !env.GH_TOKEN) {
    throw new Error('release lookup requires the GitHub repository and token');
  }
  if (!/^[a-f0-9]{40}$/.test(headSha ?? '') || headSha !== env.GITHUB_SHA) {
    throw new Error('checkout does not match the release event commit');
  }
  const api = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${env.GH_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const tag = await getJson(fetchImpl, `${api}/git/ref/tags/${metadata.release_tag}`, headers);
  let object = tag?.object;
  // Lightweight and annotated tags must both resolve to the validated commit.
  for (let depth = 0; object?.type === 'tag' && depth < 10; depth += 1) {
    if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('invalid tag object');
    object = (await getJson(fetchImpl, `${api}/git/tags/${object.sha}`, headers))?.object;
  }
  if (object?.type !== 'commit' || object.sha !== headSha) {
    throw new Error('remote version tag does not match the validated commit');
  }
  const [published, release] = await Promise.all([
    getJson(fetchImpl,
      `https://registry.npmjs.org/${encodeURIComponent(metadata.name)}/${metadata.version}`,
      {}, (data) => data === `version not found: ${metadata.version}`),
    getJson(fetchImpl, `${api}/releases/tags/${metadata.release_tag}`, headers,
      (data) => data?.message === 'Not Found'),
  ]);
  if (published !== null && (published?.name !== metadata.name || published?.version !== metadata.version)) {
    throw new Error('registry returned unexpected release metadata');
  }
  if (release !== null && (release?.tag_name !== metadata.release_tag
      || !Number.isInteger(release?.id) || !Array.isArray(release?.assets))) {
    throw new Error('GitHub returned unexpected release metadata');
  }
  // Do not repair partial releases automatically with freshly packed bytes.
  if (published !== null) return skip('version already published to npm');
  if (release !== null) return skip('GitHub release already exists');
  return { ...metadata, publish: true, reason: 'unpublished version at the matching tag' };
}

async function main() {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const metadata = releaseMetadata(read('package.json'), read('plugin.manifest.json'),
    read('.codex-plugin/plugin.json'), process.env);
  if (process.argv[2] === '--validate') {
    console.log(`release-gate: validated ${metadata.release_tag}`);
    return;
  }
  const decision = await releaseDecision({
    metadata,
    env: process.env,
    headSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  });
  console.log(`release-gate: ${decision.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(decision).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release-gate: ${error.message}`);
    process.exitCode = 1;
  });
}
