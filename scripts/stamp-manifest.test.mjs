import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';

import { computeManifestFingerprint, signManifestFingerprint } from './stamp-manifest.mjs';

const contents = { 'a.mjs': 'a', 'b/c.mjs': 'c', 'plugin.manifest.json': '{"x":1}' };
const read = (path) => Buffer.from(contents[path]);

test('fingerprint is order-independent and excludes the manifest itself', () => {
  const one = computeManifestFingerprint(['a.mjs', 'b/c.mjs', 'plugin.manifest.json'], read);
  const two = computeManifestFingerprint(['b/c.mjs', 'a.mjs'], read);
  assert.equal(one, two);
  assert.match(one, /^sha256:[0-9a-f]{64}$/);
});

test('fingerprint changes when any packed byte changes', () => {
  const before = computeManifestFingerprint(['a.mjs'], read);
  const after = computeManifestFingerprint(['a.mjs'], () => Buffer.from('A'));
  assert.notEqual(before, after);
});

test('signature verifies the way the server verifies it', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const fingerprint = computeManifestFingerprint(['a.mjs'], read);
  const signature = signManifestFingerprint(
    fingerprint,
    privateKey.export({ type: 'pkcs8', format: 'pem' })
  );
  assert.equal(
    verify(null, Buffer.from(fingerprint, 'utf8'), publicKey, Buffer.from(signature, 'base64')),
    true
  );
});
