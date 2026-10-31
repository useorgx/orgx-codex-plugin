import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateListingMetadata } from './validate-listing-metadata.mjs';

const manifest = JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
const fixture = () => structuredClone(manifest);

test('current native Codex listing meets public metadata requirements', () => {
  assert.doesNotThrow(() => validateListingMetadata(manifest));
});

test('native Codex presentation must remain at root interface', () => {
  for (const value of [undefined, null, [], 'listing']) {
    const candidate = fixture();
    candidate.interface = value;
    assert.throws(() => validateListingMetadata(candidate), /manifest\.interface is required/);
  }
});

test('rejects overlong listing fields at their documented boundaries', () => {
  for (const [field, limit] of Object.entries({ displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80 })) {
    const candidate = fixture();
    candidate.interface[field] = 'x'.repeat(limit);
    assert.doesNotThrow(() => validateListingMetadata(candidate));
    candidate.interface[field] += 'x';
    assert.throws(() => validateListingMetadata(candidate), new RegExp(`${field} must contain at most ${limit}`));
    candidate.interface[field] = ' ';
    assert.throws(() => validateListingMetadata(candidate), new RegExp(`${field} must be a non-empty string`));
  }
});

test('every attached MCP listing URL is required and must be HTTPS without credentials', () => {
  for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    for (const value of [undefined, '', 'not-a-url', 'http://useorgx.com', 'https://user:password@useorgx.com']) {
      const candidate = fixture();
      candidate.interface[field] = value;
      assert.throws(() => validateListingMetadata(candidate), new RegExp(field));
    }
    const candidate = fixture();
    const prefix = 'https://useorgx.com/';
    candidate.interface[field] = prefix + 'x'.repeat(1024 - prefix.length);
    assert.doesNotThrow(() => validateListingMetadata(candidate));
    candidate.interface[field] += 'x';
    assert.throws(() => validateListingMetadata(candidate), /at most 1024 characters/);
  }
});
