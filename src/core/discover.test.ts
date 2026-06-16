import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover, resolveBookAt } from './discover.js';

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

  // Multi-.m4b "parts" book — the confirmed false-422 case for the attribution path.
  const parts = path.join(root, 'Parts Book');
  await fs.mkdir(parts);
  for (const n of ['Part 1.m4b', 'Part 2.m4b']) await fs.writeFile(path.join(parts, n), '');

  // Disc-subfolder book.
  const discs = path.join(root, 'Disc Book');
  await fs.mkdir(path.join(discs, 'Disc 1'), { recursive: true });
  await fs.mkdir(path.join(discs, 'Disc 2'), { recursive: true });
  await fs.writeFile(path.join(discs, 'Disc 1', '01.mp3'), '');
  await fs.writeFile(path.join(discs, 'Disc 1', '02.mp3'), '');
  await fs.writeFile(path.join(discs, 'Disc 2', '01.mp3'), '');

  // A folder with no audio at all.
  await fs.mkdir(path.join(root, 'Empty'));
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

  it('still splits a multi-.m4b folder into separate books (batch path unaffected)', async () => {
    const books = await discover(path.join(root, 'Parts Book'));
    expect(books).toHaveLength(2); // batch rule: each .m4b is its own book
  });
});

// The attribution path: ONE submitted path == ONE book. resolveBookAt never splits.
describe('resolveBookAt', () => {
  it('single audio file → one book, one track', async () => {
    const b = await resolveBookAt(path.join(root, 'It.m4b'));
    expect(b).not.toBeNull();
    expect(b!.tracks).toHaveLength(1);
    expect(b!.isMultifile).toBe(false);
  });

  it('folder of uniform chapters → ONE book, all tracks, intro = Chapter 1 (natural sort)', async () => {
    const b = await resolveBookAt(path.join(root, 'The Stand'));
    expect(b!.tracks).toHaveLength(3); // cover.jpg excluded
    expect(path.basename(b!.introTrackPath)).toBe('Chapter 1.mp3');
  });

  it('folder of DISTINCT loose titles → ONE book (NOT split, unlike discover)', async () => {
    const b = await resolveBookAt(path.join(root, 'Loose'));
    expect(b!.tracks).toHaveLength(3);
    expect(b!.isMultifile).toBe(true);
  });

  it('multiple .m4b "parts" → ONE book (the false-422 regression)', async () => {
    const b = await resolveBookAt(path.join(root, 'Parts Book'));
    expect(b!.tracks).toHaveLength(2);
    expect(path.basename(b!.introTrackPath)).toBe('Part 1.m4b');
  });

  it('Disc N/ subfolders → ONE book; intro from Disc 1, last track from Disc 2', async () => {
    const b = await resolveBookAt(path.join(root, 'Disc Book'));
    expect(b!.tracks).toHaveLength(3);
    expect(b!.introTrackPath.replace(/\\/g, '/')).toMatch(/Disc 1\/01\.mp3$/);
    expect(b!.tracks.at(-1)!.replace(/\\/g, '/')).toMatch(/Disc 2\/01\.mp3$/);
  });

  it('no audio under the path → null (caller → 404)', async () => {
    expect(await resolveBookAt(path.join(root, 'Empty'))).toBeNull();
    expect(await resolveBookAt(path.join(root, 'does-not-exist'))).toBeNull();
  });
});
