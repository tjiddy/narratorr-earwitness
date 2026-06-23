import { describe, it, expect } from 'vitest';
import { resolveSelfNarration, isSelfNarrationRole } from './self-narration.js';

describe('isSelfNarrationRole', () => {
  it('matches role words for the author, case-insensitively', () => {
    expect(isSelfNarrationRole('the author')).toBe(true);
    expect(isSelfNarrationRole('Author')).toBe(true);
    expect(isSelfNarrationRole('the writer')).toBe(true);
    expect(isSelfNarrationRole('authors')).toBe(true);
  });
  it('does NOT match real names or role words embedded in longer strings', () => {
    expect(isSelfNarrationRole('David McCullough')).toBe(false);
    expect(isSelfNarrationRole('the authors guild')).toBe(false);
    expect(isSelfNarrationRole('Author Smith')).toBe(false);
  });
});

describe('resolveSelfNarration', () => {
  it('resolves a lone "the author" to the detected author (the 1776 case)', () => {
    const r = resolveSelfNarration({ title: '1776', authors: ['David McCullough'], narrators: ['the author'] });
    expect(r.narrators).toEqual(['David McCullough']);
    expect(r.title).toBe('1776'); // other fields untouched
    expect(r.authors).toEqual(['David McCullough']);
  });
  it('handles role-word variants (author / the writer)', () => {
    expect(resolveSelfNarration({ title: null, authors: ['A B'], narrators: ['author'] }).narrators).toEqual(['A B']);
    expect(resolveSelfNarration({ title: null, authors: ['A B'], narrators: ['the writer'] }).narrators).toEqual(['A B']);
  });
  it('substitutes within a mixed cast and preserves the real co-narrator', () => {
    const r = resolveSelfNarration({ title: null, authors: ['Jane Doe'], narrators: ['John Smith', 'the author'] });
    expect(r.narrators).toEqual(['John Smith', 'Jane Doe']);
  });
  it('expands multiple authors in place', () => {
    expect(resolveSelfNarration({ title: null, authors: ['A', 'B'], narrators: ['the author'] }).narrators).toEqual(['A', 'B']);
  });
  it('dedups when the author is already listed alongside the role word', () => {
    expect(resolveSelfNarration({ title: null, authors: ['Tina Fey'], narrators: ['Tina Fey', 'the author'] }).narrators).toEqual(['Tina Fey']);
  });
  it('does NOT touch a real narrator name', () => {
    expect(resolveSelfNarration({ title: null, authors: ['David McCullough'], narrators: ['Craig Wasson'] }).narrators).toEqual(['Craig Wasson']);
  });
  it('is a no-op when no author was detected (nothing to resolve to)', () => {
    expect(resolveSelfNarration({ title: null, authors: [], narrators: ['the author'] }).narrators).toEqual(['the author']);
  });
});
