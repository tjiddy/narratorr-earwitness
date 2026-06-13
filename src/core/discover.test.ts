import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover } from './discover.js';

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ew-discover-'));
  // Folder-of-chapters book (natural sort matters: 2 before 10).
  const multi = path.join(root, 'The Stand');
  await fs.mkdir(multi);
  for (const n of ['Chapter 1.mp3', 'Chapter 2.mp3', 'Chapter 10.mp3', 'cover.jpg']) {
    await fs.writeFile(path.join(multi, n), '');
  }
  // Single-file book sitting loose under root.
  await fs.writeFile(path.join(root, 'It.m4b'), '');

  // Flat folder of DISTINCT loose books (must not collapse into one book).
  const flat = path.join(root, 'Loose');
  await fs.mkdir(flat);
  for (const n of ['Dune.mp3', 'Foundation.mp3', 'Neuromancer.mp3']) {
    await fs.writeFile(path.join(flat, n), '');
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('discover', () => {
  it('groups a folder of chapters into one multi-file book', async () => {
    const books = await discover(root);
    const stand = books.find((b) => b.name === 'The Stand');
    expect(stand).toBeDefined();
    expect(stand?.isMultifile).toBe(true);
    expect(stand?.tracks).toHaveLength(3); // cover.jpg excluded
  });

  it('picks Chapter 1 as the intro track via natural sort (not Chapter 10)', async () => {
    const books = await discover(root);
    const stand = books.find((b) => b.name === 'The Stand');
    expect(path.basename(stand!.introTrackPath)).toBe('Chapter 1.mp3');
  });

  it('treats a loose single file as its own book', async () => {
    const books = await discover(root);
    const it = books.find((b) => b.name === 'It');
    expect(it).toBeDefined();
    expect(it?.isMultifile).toBe(false);
    expect(it?.introTrackReason).toBe('single file');
  });

  it('splits a flat folder of distinct loose files into separate books (P2-3)', async () => {
    const books = await discover(root);
    for (const title of ['Dune', 'Foundation', 'Neuromancer']) {
      const b = books.find((x) => x.name === title);
      expect(b, title).toBeDefined();
      expect(b?.isMultifile).toBe(false);
    }
    // The coherent chapter series must still be ONE book, not split.
    expect(books.filter((b) => b.name === 'The Stand')).toHaveLength(1);
  });
});
