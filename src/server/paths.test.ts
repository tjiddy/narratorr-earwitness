import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWithin, resolveWithinRoots, resolveWithinRoot } from './paths.js';

describe('isWithin', () => {
  it('accepts a child inside the root', () => {
    expect(isWithin(path.join('/a', 'b', 'c'), path.join('/a', 'b'))).toBe(true);
  });
  it('accepts the root itself', () => {
    expect(isWithin(path.join('/a', 'b'), path.join('/a', 'b'))).toBe(true);
  });
  it('rejects a sibling sharing a name prefix', () => {
    expect(isWithin(path.join('/a', 'bcd'), path.join('/a', 'b'))).toBe(false);
  });
  it('rejects an unrelated path', () => {
    expect(isWithin(path.join('/x', 'y'), path.join('/a', 'b'))).toBe(false);
  });
  if (process.platform === 'win32') {
    it('is case-insensitive on Windows', () => {
      expect(isWithin('C:\\Users\\Todd\\Books\\X', 'c:\\users\\todd\\books')).toBe(true);
    });
  }
});

describe('resolveWithinRoots', () => {
  let base: string;
  let root: string;
  let sub: string;
  let sibling: string;

  beforeAll(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ew-paths-')));
    root = path.join(base, 'root');
    sub = path.join(root, 'inner');
    sibling = path.join(base, 'rootX'); // shares the "root" name prefix
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('accepts an in-root subdirectory', async () => {
    expect(await resolveWithinRoots(sub, [root])).not.toBeNull();
  });
  it('rejects a parent traversal (..)', async () => {
    expect(await resolveWithinRoots(path.join(sub, '..', '..'), [root])).toBeNull();
  });
  it('rejects a sibling that shares a name prefix', async () => {
    expect(await resolveWithinRoots(sibling, [root])).toBeNull();
  });
  it('rejects a nonexistent path', async () => {
    expect(await resolveWithinRoots(path.join(root, 'does-not-exist'), [root])).toBeNull();
  });
  it('rejects a symlink that escapes the root', async () => {
    const link = path.join(root, 'escape');
    try {
      await fs.symlink(base, link, 'dir'); // points OUTSIDE root
    } catch {
      return; // no symlink privilege (common on Windows) — skip
    }
    expect(await resolveWithinRoots(link, [root])).toBeNull();
  });
});

describe('resolveWithinRoot (library-relative, attribution endpoint)', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ew-libroot-')));
    await fs.mkdir(path.join(root, 'Author', 'Book'), { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves an in-root relative path', async () => {
    const r = await resolveWithinRoot(path.join('Author', 'Book'), root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.real.endsWith('Book')).toBe(true);
  });

  it('forbids an absolute path', async () => {
    const r = await resolveWithinRoot(path.resolve(root, 'Author'), root);
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('forbids a parent traversal', async () => {
    const r = await resolveWithinRoot(path.join('..', '..'), root);
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('reports not_found for a missing relative path', async () => {
    const r = await resolveWithinRoot('Author/Nope', root);
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('forbids a symlink that escapes the root', async () => {
    const link = path.join(root, 'escape');
    try {
      await fs.symlink(path.dirname(root), link, 'dir'); // points OUTSIDE root
    } catch {
      return; // no symlink privilege — skip
    }
    const r = await resolveWithinRoot('escape', root);
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
  });
});
