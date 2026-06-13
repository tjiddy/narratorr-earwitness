import { parseFile } from 'music-metadata';
import type { Attribution } from '@shared/schemas.js';

// Read embedded tags into the same Attribution shape we detect from audio.
// Audiobook tag conventions are a swamp; the common mapping (Audible/iTunes):
//   album            -> book title (per-file `title` is usually the chapter)
//   artist / artists -> author(s)
//   composer         -> narrator(s)
// We read defensively and fall back; mismatches here are exactly what we flag.
export async function readTags(track: string): Promise<Attribution> {
  try {
    const { common } = await parseFile(track, { duration: false });

    const title = common.album ?? common.title ?? null;

    const authors =
      common.artists && common.artists.length > 0
        ? dedupe(common.artists)
        : common.artist
          ? [common.artist]
          : [];

    const narrators = common.composer && common.composer.length > 0 ? dedupe(common.composer) : [];

    return { title, authors, narrators };
  } catch {
    // Unreadable/tagless file — empty attribution (the audio is our source of truth anyway).
    return { title: null, authors: [], narrators: [] };
  }
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}
