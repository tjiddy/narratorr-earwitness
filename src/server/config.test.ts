import { describe, it, expect } from 'vitest';
import { normalizeApiKey } from './config.js';

// Regression: docker-compose passes an unset `${EARWITNESS_API_KEY}` as an EMPTY
// STRING, which previously read as "a key is set" and locked /api behind a bearer
// of "" that nothing sends. Empty/whitespace must mean "no key".
describe('normalizeApiKey', () => {
  it('treats absent / empty / whitespace as no key', () => {
    expect(normalizeApiKey(undefined)).toBeNull();
    expect(normalizeApiKey('')).toBeNull();
    expect(normalizeApiKey('   ')).toBeNull();
  });

  it('keeps a real key (trimmed)', () => {
    expect(normalizeApiKey('s3cret')).toBe('s3cret');
    expect(normalizeApiKey('  s3cret  ')).toBe('s3cret');
  });
});
