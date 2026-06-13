import { describe, it, expect } from 'vitest';
import { compareAttribution, nameSimilarity, personSetSimilarity, splitPeople, NAME_FLOOR } from './compare.js';
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

  it('flags a tag that credits an extra person not heard in the book (P1-5)', () => {
    const flags = compareAttribution(
      attr({ authors: ['Stephen King'] }),
      attr({ authors: ['Stephen King', 'Dean Koontz'] }),
      1,
    );
    expect(flags).toEqual([expect.objectContaining({ field: 'author', severity: 'mismatch' })]);
  });

  it('flags a tag that is missing a person heard in the book (P1-5)', () => {
    const flags = compareAttribution(
      attr({ narrators: ['Stephen King', 'Peter Straub'] }),
      attr({ narrators: ['Stephen King'] }),
      1,
    );
    expect(flags).toEqual([expect.objectContaining({ field: 'narrator', severity: 'mismatch' })]);
  });
});

describe('personSetSimilarity (symmetry)', () => {
  it('is symmetric in its arguments', () => {
    const a = ['Stephen King'];
    const b = ['Stephen King', 'Dean Koontz'];
    expect(personSetSimilarity(a, b)).toBeCloseTo(personSetSimilarity(b, a));
  });

  it('exact set match scores 1', () => {
    expect(personSetSimilarity(['Jane Doe', 'John Roe'], ['John Roe', 'Jane Doe'])).toBe(1);
  });

  it('a subset is penalized below the name floor', () => {
    expect(personSetSimilarity(['Stephen King'], ['Stephen King', 'Dean Koontz'])).toBeLessThan(NAME_FLOOR);
  });

  it('empty-vs-empty is a match, empty-vs-nonempty is not', () => {
    expect(personSetSimilarity([], [])).toBe(1);
    expect(personSetSimilarity([], ['Stephen King'])).toBe(0);
  });
});
