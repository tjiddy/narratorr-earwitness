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
});
