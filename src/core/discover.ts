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

// Walk recursion is bounded: real libraries nest Author/Series/Book/disc, not 16
// deep. The cap is a backstop against a pathological tree (or a symlink loop the
// visited-set somehow misses).
const MAX_DEPTH = 16;

const isAudio = (name: string) => AUDIO_EXTS.has(path.extname(name).toLowerCase());
const isContainer = (file: string) => CONTAINER_EXTS.has(path.extname(file).toLowerCase());

function caseFold(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isWithin(child: string, root: string): boolean {
  const c = caseFold(child);
  const r = caseFold(root);
  if (c === r) return true;
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

function makeBook(source: string, name: string, tracks: string[], reason?: string): Book {
  const isMultifile = tracks.length > 1;
  return {
    name,
    source,
    introTrackPath: tracks[0]!,
    introTrackReason: reason ?? (isMultifile ? `first of ${tracks.length} tracks (natural sort)` : 'single file'),
    tracks,
    isMultifile,
  };
}

// Reduce a filename stem to its non-numeric "skeleton" so chapter files
// ("Chapter 1", "Chapter 2") collapse to one key while distinct titles
// ("Dune", "Foundation") stay separate.
function skeleton(file: string): string {
  return path.parse(file).name
    .toLowerCase()
    .replace(/\d+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/** Longest common (case-insensitive) filename-stem prefix of a track group, trimmed. */
function commonName(files: string[]): string | null {
  const stems = files.map((f) => path.parse(f).name);
  let prefix = stems[0] ?? '';
  for (const s of stems.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i]!.toLowerCase() === s[i]!.toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[\s\-_,.]+$/, '').trim();
  return prefix.length >= 2 ? prefix : null;
}

/**
 * Group loose (non-container) audio siblings into books. A flat folder of N
 * distinct loose files used to collapse into ONE book transcribing only track 1;
 * we now split by name skeleton, so distinct titles become separate books while a
 * single coherent chapter series stays one directory-named book.
 */
function groupLooseFiles(dir: string, files: string[]): Book[] {
  if (files.length === 0) return [];

  const groups = new Map<string, string[]>();
  for (const f of files) {
    const key = skeleton(f);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }

  // One coherent series (or a single file) → keep the directory-named book.
  if (groups.size <= 1) return [makeBook(dir, path.basename(dir), files)];

  // Multiple distinct name patterns sharing a flat folder → separate books.
  const books: Book[] = [];
  for (const tracks of groups.values()) {
    if (tracks.length === 1) {
      books.push(
        makeBook(tracks[0]!, path.parse(tracks[0]!).name, tracks, 'loose file in a mixed flat folder'),
      );
    } else {
      books.push(
        makeBook(
          tracks[0]!,
          commonName(tracks) ?? path.parse(tracks[0]!).name,
          tracks,
          `${tracks.length} tracks grouped by name pattern in a flat folder (ambiguous — verify)`,
        ),
      );
    }
  }
  return books;
}

export async function discover(root: string): Promise<Book[]> {
  const resolved = path.resolve(root);
  const rootReal = await realOrNull(resolved);
  if (!rootReal) throw new Error(`path does not exist: ${resolved}`);

  const st = await fs.stat(rootReal);
  if (st.isFile()) {
    if (isAudio(rootReal)) return [makeBook(rootReal, path.parse(rootReal).name, [rootReal])];
    return [];
  }

  // Captured non-null for the closure (control-flow narrowing doesn't cross into it).
  const scanRoot: string = rootReal;
  const books: Book[] = [];
  const visited = new Set<string>();

  // ONE readdir per directory (partitioned into files/subdirs). Symlinked dirs are
  // realpath-resolved and only followed if they stay inside the scan root — a link
  // to "/" would otherwise walk the whole filesystem (DoS + containment bypass).
  async function walk(real: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const key = caseFold(real);
    if (visited.has(key)) return;
    visited.add(key);

    const entries = await fs.readdir(real, { withFileTypes: true }).catch(() => []);
    const audio: string[] = [];
    const subdirs: string[] = [];
    for (const e of entries) {
      const full = path.join(real, e.name);
      if (e.isDirectory()) {
        subdirs.push(full);
      } else if (e.isFile()) {
        if (isAudio(e.name)) audio.push(full);
      } else if (e.isSymbolicLink()) {
        const target = await realOrNull(full);
        if (!target) continue;
        const tst = await fs.stat(target).catch(() => null);
        if (tst?.isDirectory()) {
          if (isWithin(target, scanRoot)) subdirs.push(target);
        } else if (tst?.isFile() && isAudio(e.name)) {
          audio.push(full);
        }
      }
    }

    audio.sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
    for (const container of audio.filter(isContainer)) {
      books.push(makeBook(container, path.parse(container).name, [container]));
    }
    books.push(...groupLooseFiles(real, audio.filter((f) => !isContainer(f))));

    for (const sub of subdirs) await walk(sub, depth + 1);
  }
  await walk(scanRoot, 0);

  return books.sort((a, b) => naturalCompare(a.name, b.name));
}
