import { describe, it, expect } from 'vitest';
import { compareAttribution, nameSimilarity, splitPeople, NAME_FLOOR } from './compare.js';
import type { Attribution } from '@shared/schemas.js';

const attr = (over: Partial<Attribution>): Attribution => ({
  title: null,
  authors: [],
  narrators: [],
  ...over,
});

describe('nameSimilarity', () => {
  it('treats first-name expansions as a match (Whisper-tolerant)', () => {
    expect(nameSimilarity('Ray Porter', 'Raymond Porter')).toBeGreaterThanOrEqual(NAME_FLOOR);
  });
  it('matches "Last, First" against "First Last"', () => {
    expect(nameSimilarity('King, Stephen', 'Stephen King')).toBeGreaterThan(0.95);
  });
  it('scores unrelated names low', () => {
    expect(nameSimilarity('Stephen King', 'Dean Koontz')).toBeLessThan(NAME_FLOOR);
  });
});

describe('splitPeople', () => {
  it('splits multi-person strings', () => {
    expect(splitPeople('Jane Doe and John Roe')).toEqual(['Jane Doe', 'John Roe']);
    expect(splitPeople('A, B & C')).toEqual(['A', 'B', 'C']);
    expect(splitPeople(null)).toEqual([]);
  });
});

describe('compareAttribution', () => {
  it('does not flag a tolerant name near-match', () => {
    const flags = compareAttribution(
      attr({ narrators: ['Ray Porter'] }),
      attr({ narrators: ['Raymond Porter'] }),
      1,
    );
    expect(flags).toHaveLength(0);
  });

  it('flags a real author mismatch', () => {
    const flags = compareAttribution(
      attr({ authors: ['Stephen King'] }),
      attr({ authors: ['Dean Koontz'] }),
      1,
    );
    expect(flags).toEqual([expect.objectContaining({ field: 'author', severity: 'mismatch' })]);
  });

  it('flags missing tags', () => {
    const flags = compareAttribution(attr({ title: 'The Shining' }), attr({}), 1);
    expect(flags).toEqual([expect.objectContaining({ field: 'title', severity: 'missing_tag' })]);
  });

  it('downgrades a low-confidence disagreement to low_confidence, not mismatch', () => {
    const flags = compareAttribution(
      attr({ authors: ['Stephen King'] }),
      attr({ authors: ['Dean Koontz'] }),
      0.2,
    );
    expect(flags[0]?.severity).toBe('low_confidence');
  });

  it('multi-person sets match regardless of order', () => {
    const flags = compareAttribution(
      attr({ narrators: ['Jane Doe', 'John Roe'] }),
      attr({ narrators: ['John Roe', 'Jane Doe'] }),
      1,
    );
    expect(flags).toHaveLength(0);
  });
});
