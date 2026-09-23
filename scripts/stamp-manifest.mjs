#!/usr/bin/env node
/**
 * Fill `manifest_fingerprint` (and `signature`, when a key is provided) in
 * plugin.manifest.json from the exact files `npm pack` will publish.
 *
 * The peer sends both fields on every heartbeat, but nothing populated them,
 * so every shipped build reported an empty identity and the server could not
 * tell one installed release from another (plan v3 §2, §5.4).
 *
 *   fingerprint = sha256 over sorted "<path>\0<sha256(file)>\n" for every
 *                 packed file except plugin.manifest.json itself
 *   signature   = base64(ed25519.sign(fingerprint)) with
 *                 ORGX_MANIFEST_SIGNING_KEY (PEM), matching the server's
 *                 lib/licenses/manifest.ts verifyManifest
 *
 * Run immediately before `npm pack` in the release workflow.
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = 'plugin.manifest.json';

export function computeManifestFingerprint(files, readFile) {
  const lines = files
    .filter((path) => path !== MANIFEST)
    .sort()
    .map((path) => `${path}\0${createHash('sha256').update(readFile(path)).digest('hex')}\n`);
  return `sha256:${createHash('sha256').update(lines.join('')).digest('hex')}`;
}

export function signManifestFingerprint(fingerprint, privateKeyPem) {
  return sign(null, Buffer.from(fingerprint, 'utf8'), createPrivateKey(privateKeyPem)).toString(
    'base64'
  );
}

function packedFiles(root) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(out)[0].files.map((file) => file.path);
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = resolve(root, MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const fingerprint = computeManifestFingerprint(packedFiles(root), (path) =>
    readFileSync(resolve(root, path))
  );
  const key = process.env.ORGX_MANIFEST_SIGNING_KEY;
  manifest.manifest_fingerprint = fingerprint;
  manifest.signature = key ? signManifestFingerprint(fingerprint, key) : '';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `stamp-manifest: ${fingerprint} (${key ? 'signed' : 'unsigned: ORGX_MANIFEST_SIGNING_KEY not set'})`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
