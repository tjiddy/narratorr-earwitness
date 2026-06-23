import { z } from 'zod';
import {
  comparisonSchema,
  type Attribution,
  type Comparison,
  type FieldStatus,
  type MultiFieldComparison,
  type SingleFieldComparison,
} from '@shared/schemas.js';
import { sha, type Cache } from './cache.js';

// STAGE 2 of attribution: the SIGHTED comparison. Stage 1 (extract) is blind — it
// never sees the metadata. This stage sees the FROZEN detected values + the expected
// metadata and judges, per field, whether they are the same IDENTITY (not the same
// string). It may only PRODUCE the verdict; it never mutates detection.
//
// The LLM does the fuzzy part (name equivalence: "John Ham" == "John Hamm",
// "Ron Artest" == "Metta World Peace"); the set arithmetic and the status rollup are
// computed deterministically in code from its pairings, and any pairing that doesn't
// reference a real input string is dropped (anti-hallucination).

// Bump when the prompt wording OR the comparison behavior changes — part of the cache key.
// v3: pairwise leftover recovery (bug #4 — the one-shot matcher under-pairs multi-name lists).
export const COMPARE_PROMPT_VERSION = 'v3';

const SYSTEM_PROMPT = `You compare two attributions for an audiobook. "detected" is what a SPEECH-TO-TEXT system HEARD in the spoken audio credit; "expected" is what the library catalog believes. For each field decide whether they refer to the SAME work / SAME people.

Critical context: "detected" came from speech-to-text, which routinely MANGLES the spelling of proper nouns — narrator and author names especially. So the real question per name is: is HEARD a plausible MISHEARING or spelling/formatting variant of EXPECTED (the same real person)? Judge that, not whether the strings match.

Rules:
- Pair a detected name with an expected name when detected is a plausible speech-to-text mishearing, homophone, transliteration, or formatting/ordering/initials/honorific variant of the SAME real person. Speech-to-text confusions to treat as the SAME person include: Brick/Brink, Euan/Ewan, Suzy/Susie, Stephen/Steven, Maarleveld/Marleveld, "Khristine Hvam"/"Christine Vam", "John Ham"/"John Hamm", "King, Stephen"/"Stephen King". Also pair a well-known alternate/former/stage name of the same real person (e.g. "Ron Artest"/"Metta World Peace").
- Do NOT pair two names that refer to GENUINELY DIFFERENT people. If detected has a different first name AND a different surname with no phonetic overlap — e.g. "Kevin R. Free" vs "David Kwee", or "Marc Thompson" vs "Kevin Thompson" — they are DIFFERENT people; leave them UNPAIRED even if that means nothing matches. NEVER invent a connection to force a match. When genuinely unsure, leave UNPAIRED.
- For "authors" and "narrators": return ONLY the pairs you judge to be the same person, as { "expected": <verbatim from the expected list>, "detected": <verbatim from the detected list> }. Copy the strings EXACTLY from the provided lists. Pair each name at most once. Never output a pair unless both strings appear in the lists.
- For "title": { "same": true | false } — whether detected and expected name the same work. Ignore subtitle, series, volume, and edition wording (e.g. "Dune" == "Dune: Book One of the Dune Chronicles").
- "reason": one short human-readable sentence per field. It is for display only.
- Respond ONLY with JSON matching the schema.`;

const matchPairSchema = z.object({ expected: z.string(), detected: z.string() });
const llmSchema = z.object({
  title: z.object({ same: z.boolean(), reason: z.string() }),
  authors: z.object({ matches: z.array(matchPairSchema), reason: z.string() }),
  narrators: z.object({ matches: z.array(matchPairSchema), reason: z.string() }),
});
type LlmComparison = z.infer<typeof llmSchema>;

// Bug #4 recovery: judging ONE expected/heard pair at a time is far more reliable than
// asking the model to emit the whole set-partition in one shot (which silently drops
// obvious mishearings on multi-name lists — e.g. it pairs "Marin Ireland" but not
// "Edoardo Ballerini"/"Eduardo Ballerini"). Same framing/guardrails as the main prompt.
const PAIR_PROMPT = `A speech-to-text system transcribed a spoken audiobook credit; proper nouns — names especially — are routinely MANGLED. Given one EXPECTED name (from the catalog) and one HEARD name (from speech-to-text), decide: is HEARD a plausible mishearing, homophone, transliteration, or formatting/ordering/initials/honorific variant of EXPECTED — i.e. the SAME real person? Examples of SAME: Brick/Brink, Euan/Ewan, Stephen/Steven, "January LaVoy"/"January Lavoie", "Edoardo Ballerini"/"Eduardo Ballerini", "John Ham"/"John Hamm". If HEARD has a different first name AND a different surname with no phonetic overlap, they are DIFFERENT people. When genuinely unsure, answer false. Respond ONLY with JSON.`;
const pairSchema = z.object({ same: z.boolean(), reason: z.string() });
const pairJsonSchema = z.toJSONSchema(pairSchema);

const jsonSchema = z.toJSONSchema(llmSchema);
// Derived from the JSON schema so any shape change invalidates the comparison cache.
export const COMPARE_SCHEMA_VERSION = sha(JSON.stringify(jsonSchema)).slice(0, 12);

/** narratorr's belief, normalized: a single title and people lists (missing → null/[]). */
export interface Expected {
  title: string | null;
  authors: string[];
  narrators: string[];
}

export interface CompareDeps {
  host: string;
  model: string;
  cache: Cache;
  signal?: AbortSignal | undefined;
  /** Debug: skip the comparison cache (no read, no write) so a re-run re-judges. */
  bypassCache?: boolean | undefined;
}

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
/** Loose key for matching the LLM's echoed strings back to real input strings. */
function normKey(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function rollup(statuses: FieldStatus[]): FieldStatus {
  if (statuses.includes('mismatch')) return 'mismatch';
  if (statuses.includes('partial')) return 'partial';
  if (statuses.includes('match')) return 'match';
  return 'unknown';
}

function buildMultiField(
  expected: string[],
  detected: string[],
  rawMatches: { expected: string; detected: string }[],
  reason: string,
): MultiFieldComparison {
  const expByKey = new Map(expected.map((e) => [normKey(e), e] as const));
  const detByKey = new Map(detected.map((d) => [normKey(d), d] as const));
  const usedExp = new Set<string>();
  const usedDet = new Set<string>();
  const matched: { expected: string; detected: string }[] = [];

  for (const m of rawMatches) {
    const ek = normKey(m.expected);
    const dk = normKey(m.detected);
    const e = expByKey.get(ek);
    const d = detByKey.get(dk);
    if (!e || !d) continue; // not in the provided lists → hallucinated, drop
    if (usedExp.has(ek) || usedDet.has(dk)) continue; // one pairing per name
    usedExp.add(ek);
    usedDet.add(dk);
    matched.push({ expected: e, detected: d });
  }

  const missingExpected = expected.filter((e) => !usedExp.has(normKey(e)));
  const unexpectedDetected = detected.filter((d) => !usedDet.has(normKey(d)));
  const status: FieldStatus =
    unexpectedDetected.length > 0
      ? 'mismatch' // heard someone not in expected → contradiction
      : missingExpected.length > 0
        ? matched.length > 0
          ? 'partial' // consistent subset (heard fewer, none contradicting)
          : 'mismatch'
        : 'match';

  return { status, expected, detected, matched, missingExpected, unexpectedDetected, reason };
}

/** A multi-value field we couldn't compare (no detected credit, or no expected belief). */
function unknownMultiField(expected: string[], detected: string[]): MultiFieldComparison {
  const reason =
    detected.length === 0
      ? 'No spoken credit found in the audio for this field.'
      : 'No expected value provided to compare against.';
  return {
    status: 'unknown',
    expected,
    detected,
    matched: [],
    // If we heard nothing, surface what was expected-but-unheard (not a contradiction).
    missingExpected: detected.length === 0 ? [...expected] : [],
    unexpectedDetected: [],
    reason,
  };
}

function unknownTitle(expected: string | null, detected: string | null): SingleFieldComparison {
  const reason =
    detected === null
      ? 'No spoken title credit found in the audio.'
      : 'No expected title provided to compare against.';
  return { status: 'unknown', expected, detected, reason };
}

async function callLlm(detected: Attribution, expected: Expected, deps: CompareDeps): Promise<LlmComparison> {
  const body = {
    model: deps.model,
    stream: false,
    format: jsonSchema,
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          detected: { title: detected.title, authors: detected.authors, narrators: detected.narrators },
          expected,
        }),
      },
    ],
  };

  const res = await fetch(`${deps.host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: deps.signal ?? null,
  });
  if (!res.ok) throw new Error(`ollama compare ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? '';
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`ollama compare returned non-JSON content: ${content.slice(0, 200)}`);
  }
  const parsed = llmSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`comparison did not match schema: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Judge a single (expected, heard) name pair — are they the same real person, allowing
 * for speech-to-text mangling? Cached on (names, model, version) so a pair is judged once
 * across the whole library. Best-effort: any HTTP/parse failure resolves to `false` so a
 * hiccup never over-pairs (the cardinal sin) and never breaks the parent comparison —
 * except a genuine cancellation, which propagates.
 */
async function samePerson(expectedName: string, heardName: string, deps: CompareDeps): Promise<boolean> {
  const key = sha(['pair', expectedName, heardName, deps.model, COMPARE_PROMPT_VERSION].join('|'));
  if (!deps.bypassCache) {
    const cached = await deps.cache.get<boolean>('name-pair', key);
    if (cached !== null) return cached;
  }
  let same = false;
  try {
    const res = await fetch(`${deps.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: deps.model,
        stream: false,
        format: pairJsonSchema,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: PAIR_PROMPT },
          { role: 'user', content: JSON.stringify({ expected: expectedName, heard: heardName }) },
        ],
      }),
      signal: deps.signal ?? null,
    });
    if (res.ok) {
      const data = (await res.json()) as { message?: { content?: string } };
      const parsed = pairSchema.safeParse(JSON.parse(data.message?.content ?? '{}'));
      if (parsed.success) same = parsed.data.same;
    }
  } catch (e) {
    if (deps.signal?.aborted) throw e; // honor cancellation; swallow only real errors
    same = false;
  }
  if (!deps.bypassCache) await deps.cache.set('name-pair', key, same);
  return same;
}

/**
 * Bug #4 recovery: the one-shot set-partition under-pairs multi-name lists. Re-judge each
 * leftover pair (every unexpectedDetected × missingExpected) one at a time, absorb the real
 * mishearings, and rebuild the field from the augmented matches. No-op unless BOTH sides
 * have leftovers (a clean match or a consistent subset has nothing to recover).
 */
async function recoverMultiField(field: MultiFieldComparison, deps: CompareDeps): Promise<MultiFieldComparison> {
  if (field.status === 'unknown' || field.missingExpected.length === 0 || field.unexpectedDetected.length === 0) {
    return field;
  }
  const recovered: { expected: string; detected: string }[] = [];
  const claimedExpected = new Set<string>();
  for (const heard of field.unexpectedDetected) {
    for (const exp of field.missingExpected) {
      if (claimedExpected.has(normKey(exp))) continue;
      if (await samePerson(exp, heard, deps)) {
        recovered.push({ expected: exp, detected: heard });
        claimedExpected.add(normKey(exp));
        break;
      }
    }
  }
  if (recovered.length === 0) return field;
  return buildMultiField(field.expected, field.detected, [...field.matched, ...recovered], field.reason);
}

/**
 * Compare frozen `detected` (what was heard) against `expected` (the tags). A field
 * is only judged by the LLM when BOTH sides have content; otherwise it's `unknown`
 * (we can't call a tag wrong on the strength of silence). Result is cached on
 * (detected, expected, model, versions). Never mutates `detected`.
 */
export async function compareIdentity(
  detected: Attribution,
  expected: Expected,
  deps: CompareDeps,
): Promise<Comparison> {
  const titleComparable = detected.title !== null && expected.title !== null;
  const authorsComparable = detected.authors.length > 0 && expected.authors.length > 0;
  const narratorsComparable = detected.narrators.length > 0 && expected.narrators.length > 0;

  // Nothing to compare → all-unknown, no LLM call.
  if (!titleComparable && !authorsComparable && !narratorsComparable) {
    return {
      status: 'unknown',
      fields: {
        title: unknownTitle(expected.title, detected.title),
        authors: unknownMultiField(expected.authors, detected.authors),
        narrators: unknownMultiField(expected.narrators, detected.narrators),
      },
    };
  }

  const key = sha(
    [JSON.stringify(detected), JSON.stringify(expected), deps.model, COMPARE_PROMPT_VERSION, COMPARE_SCHEMA_VERSION].join(
      '|',
    ),
  );
  if (!deps.bypassCache) {
    // Re-validate the cached value against the schema (like the extraction cache) so a
    // stale/corrupt/hand-edited entry is treated as a miss instead of trusted blindly.
    const cached = await deps.cache.get<unknown>('comparison', key);
    const valid = cached === null ? null : comparisonSchema.safeParse(cached);
    if (valid && valid.success) return valid.data;
  }

  const llm = await callLlm(detected, expected, deps);

  const title: SingleFieldComparison = titleComparable
    ? { status: llm.title.same ? 'match' : 'mismatch', expected: expected.title, detected: detected.title, reason: llm.title.reason }
    : unknownTitle(expected.title, detected.title);
  // Build from the one-shot pairing, then recover leftovers pairwise (bug #4).
  const authors = await recoverMultiField(
    authorsComparable
      ? buildMultiField(expected.authors, detected.authors, llm.authors.matches, llm.authors.reason)
      : unknownMultiField(expected.authors, detected.authors),
    deps,
  );
  const narrators = await recoverMultiField(
    narratorsComparable
      ? buildMultiField(expected.narrators, detected.narrators, llm.narrators.matches, llm.narrators.reason)
      : unknownMultiField(expected.narrators, detected.narrators),
    deps,
  );

  const comparison: Comparison = {
    status: rollup([title.status, authors.status, narrators.status]),
    fields: { title, authors, narrators },
  };
  if (!deps.bypassCache) await deps.cache.set('comparison', key, comparison);
  return comparison;
}
