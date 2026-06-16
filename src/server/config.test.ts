import { describe, it, expect } from 'vitest';
import { normalizeApiKey } from './config.js';

// normalizeApiKey trims the persisted key file's contents; a blank/whitespace file
// must read as "no key yet" so ensureApiKey() regenerates instead of locking /api
// behind a bearer of "" that nothing sends.
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
