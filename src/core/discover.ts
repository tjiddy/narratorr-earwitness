import { promises as fs } from 'node:fs';
import path from 'node:path';

// Find audiobooks under a root and pick the track that should carry the intro.
// A "book" is either a single loose audio file, or a directory that directly
// contains audio files (a folder of per-chapter files). For folders we natural-sort
// and take the first track, since the publisher/title/narrator intro is at the start.
// We record WHY a track was chosen (introTrackReason) so a human can spot bad picks
// in the report — intro detection is intentionally MVP-naive.

export const AUDIO_EXTS = new Set([
  '.m4b', '.m4a', '.mp3', '.aac', '.ogg', '.opus', '.flac', '.wav',
]);

// Self-contained single-file book containers — each is its own book even when it
// sits beside others. Everything else in a folder is treated as chapters of one book.
const CONTAINER_EXTS = new Set(['.m4b']);

export interface Book {
  name: string;
  source: string; // file or directory representing the book
  introTrackPath: string;
  introTrackReason: string;
  tracks: string[];
  isMultifile: boolean;
}

const NUM = /(\d+)/;
function naturalKey(name: string): Array<string | number> {
  return name.split(NUM).map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}
function naturalCompare(a: string, b: string): number {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  const len = Math.min(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const x = ka[i]!;
    const y = kb[i]!;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return ka.length - kb.length;
}

async function audioFilesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort(naturalCompare)
    .map((name) => path.join(dir, name));
}

function makeBook(source: string, name: string, tracks: string[]): Book {
  const isMultifile = tracks.length > 1;
  return {
    name,
    source,
    introTrackPath: tracks[0]!,
    introTrackReason: isMultifile
      ? `first of ${tracks.length} tracks (natural sort)`
      : 'single file',
    tracks,
    isMultifile,
  };
}

const isContainer = (file: string) => CONTAINER_EXTS.has(path.extname(file).toLowerCase());

export async function discover(root: string): Promise<Book[]> {
  const resolved = path.resolve(root);
  const st = await fs.stat(resolved).catch(() => null);
  if (!st) throw new Error(`path does not exist: ${resolved}`);

  if (st.isFile()) {
    if (AUDIO_EXTS.has(path.extname(resolved).toLowerCase())) {
      return [makeBook(resolved, path.parse(resolved).name, [resolved])];
    }
    return [];
  }

  const books: Book[] = [];

  // Each .m4b is its own book; the remaining (chapter-style) files in a directory
  // group into one multi-file book named after that directory.
  async function walk(dir: string): Promise<void> {
    const files = await audioFilesIn(dir);
    for (const container of files.filter(isContainer)) {
      books.push(makeBook(container, path.parse(container).name, [container]));
    }
    const chapters = files.filter((f) => !isContainer(f));
    if (chapters.length > 0) books.push(makeBook(dir, path.basename(dir), chapters));

    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
  }
  await walk(resolved);

  return books.sort((a, b) => naturalCompare(a.name, b.name));
}
