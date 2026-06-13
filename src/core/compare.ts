import type { Attribution, Flag } from '@shared/schemas.js';

// Field-specific, multi-person comparison. Whisper mangles uncommon proper nouns,
// so name matching is deliberately tolerant (token alignment + initial/prefix
// handling) to avoid false "tag is wrong" flags, while title uses a plain
// bigram-Dice floor.

export const TITLE_FLOOR = 0.6;
export const NAME_FLOOR = 0.6;
// Below this extraction confidence, a disagreement is reported as `low_confidence`
// ("we think it's X but aren't sure") rather than a hard `mismatch`.
export const CONFIDENCE_FLOOR = 0.5;

/** Split a raw "by A and B" / "A, B & C" string into individual people. */
export function splitPeople(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\s*(?:,|;|&|\band\b|\bwith\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalize(s: string): string {
  let v = stripDiacritics(s).toLowerCase().trim();
  // "King, Stephen" -> "stephen king"
  const comma = v.match(/^([^,]+),\s*(.+)$/);
  if (comma) v = `${comma[2]} ${comma[1]}`;
  return v.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function bigrams(s: string): Map<string, number> {
  const compact = s.replace(/\s+/g, '');
  const m = new Map<string, number>();
  for (let i = 0; i < compact.length - 1; i++) {
    const g = compact.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice coefficient over character bigrams of normalized strings. */
export function dice(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let overlap = 0;
  let total = 0;
  for (const [, c] of ga) total += c;
  for (const [, c] of gb) total += c;
  for (const [g, c] of ga) {
    const other = gb.get(g);
    if (other) overlap += Math.min(c, other);
  }
  return total === 0 ? 0 : (2 * overlap) / total;
}

function tokenScore(a: string, b: string): number {
  if (a === b) return 1;
  // initial / prefix: "ray" vs "raymond", "j" vs "john"
  if (a.length >= 1 && b.length >= 1 && (a.startsWith(b) || b.startsWith(a))) return 0.92;
  return dice(a, b);
}

/** Tolerant single-name similarity via greedy token alignment. */
export function nameSimilarity(a: string, b: string): number {
  const ta = normalize(a).split(' ').filter(Boolean);
  const tb = normalize(b).split(' ').filter(Boolean);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const pool = [...long];
  let sum = 0;
  for (const tok of short) {
    let bestI = -1;
    let best = 0;
    for (let i = 0; i < pool.length; i++) {
      const sc = tokenScore(tok, pool[i]!);
      if (sc > best) {
        best = sc;
        bestI = i;
      }
    }
    sum += best;
    if (bestI >= 0) pool.splice(bestI, 1);
  }
  return sum / short.length;
}

/** Mean best-match score mapping each name in `from` to its closest in `to`. */
function avgBestMatch(from: string[], to: string[]): number {
  let sum = 0;
  for (const a of from) {
    let best = 0;
    for (const b of to) best = Math.max(best, nameSimilarity(a, b));
    sum += best;
  }
  return sum / from.length;
}

/**
 * Symmetric, cardinality-aware similarity between two people-sets: the WORSE of
 * the two directional averages. A one-directional average (only detected→tags)
 * scores `detected=[A]` vs `tags=[A,B]` a perfect 1.0 and never flags a tag that
 * credits someone not in the book; taking the min in both directions catches both
 * an extra tagged person and a missing one.
 */
export function personSetSimilarity(detected: string[], tags: string[]): number {
  if (detected.length === 0 && tags.length === 0) return 1;
  if (detected.length === 0 || tags.length === 0) return 0;
  return Math.min(avgBestMatch(detected, tags), avgBestMatch(tags, detected));
}

function classify(similarity: number, confidence: number, floor: number): Flag['severity'] | null {
  if (similarity >= floor) return null;
  return confidence < CONFIDENCE_FLOOR ? 'low_confidence' : 'mismatch';
}

/** Produce field-level flags. `no_attribution` is handled at book level, not here. */
export function compareAttribution(
  detected: Attribution,
  tags: Attribution,
  confidence: number,
): Flag[] {
  const flags: Flag[] = [];

  // Title (single value)
  if (detected.title) {
    if (!tags.title) {
      flags.push({ field: 'title', tagValue: null, detectedValue: detected.title, similarity: null, severity: 'missing_tag' });
    } else {
      const sim = dice(detected.title, tags.title);
      const sev = classify(sim, confidence, TITLE_FLOOR);
      if (sev) flags.push({ field: 'title', tagValue: tags.title, detectedValue: detected.title, similarity: sim, severity: sev });
    }
  }

  // Authors / narrators (multi-person sets)
  for (const field of ['author', 'narrator'] as const) {
    const det = field === 'author' ? detected.authors : detected.narrators;
    const tag = field === 'author' ? tags.authors : tags.narrators;
    if (det.length === 0) continue;
    const detValue = det.join(', ');
    if (tag.length === 0) {
      flags.push({ field, tagValue: null, detectedValue: detValue, similarity: null, severity: 'missing_tag' });
      continue;
    }
    const sim = personSetSimilarity(det, tag);
    const sev = classify(sim, confidence, NAME_FLOOR);
    if (sev) flags.push({ field, tagValue: tag.join(', '), detectedValue: detValue, similarity: sim, severity: sev });
  }

  return flags;
}
