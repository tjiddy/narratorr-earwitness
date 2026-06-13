import { extractionSchema, type Attribution, type BookResult, type Extraction } from '@shared/schemas.js';
import type { Book } from './discover.js';
import { type Cache, fileIdentity, sha, transcriptKey, extractionKey } from './cache.js';
import type { TranscribeProvider } from './transcribe/index.js';
import { extract, PROMPT_VERSION, SCHEMA_VERSION } from './extract.js';
import { readTags } from './tags.js';
import { compareAttribution, splitPeople } from './compare.js';

const MIN_TRANSCRIPT_CHARS = 15;
const EXCERPT_CHARS = 400;
// When a detected field can't be backed by a transcript-grounded evidence span,
// we null it and cap confidence here — "we think we heard it but can't prove it".
const UNVERIFIED_CONFIDENCE_CAP = 0.4;

export interface ProcessDeps {
  transcribe: TranscribeProvider;
  cache: Cache;
  ffmpegPath: string;
  offsetSeconds: number;
  seconds: number;
  whisperModel: string;
  ollama: { host: string; model: string };
  /** Job-level abort (cancellation). Combined with per-step timeouts below. */
  signal?: AbortSignal | undefined;
  transcribeTimeoutMs?: number | undefined;
  extractTimeoutMs?: number | undefined;
}

function emptyAttr(): Attribution {
  return { title: null, authors: [], narrators: [] };
}
function emptyEvidence() {
  return { title: null, author: null, narrator: null };
}

/** Combine the job abort signal with a per-call timeout (either may be absent). */
function withTimeout(signal: AbortSignal | undefined, ms: number | undefined): AbortSignal | undefined {
  const parts: AbortSignal[] = [];
  if (signal) parts.push(signal);
  if (ms && ms > 0) parts.push(AbortSignal.timeout(ms));
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : AbortSignal.any(parts);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Normalize for substring matching: lowercase, punctuation→space, collapse runs. */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True only if the evidence span actually appears in the (normalized) transcript. */
function evidenceSupports(evidence: string | null, transcriptNorm: string): boolean {
  if (!evidence) return false;
  const e = normalizeForMatch(evidence);
  if (e.length < 2) return false;
  return transcriptNorm.includes(e);
}

/**
 * Enforce the "evidence required" rule structurally (the prompt alone can't be
 * trusted): a detected field survives only if its evidence span is non-null AND
 * present in the transcript. Unsupported fields are nulled, confidence is capped,
 * and if nothing survives we downgrade to attributionPresent=false rather than
 * letting an all-null detection render as "verified".
 */
function enforceEvidence(extraction: Extraction, transcript: string): Extraction {
  const transcriptNorm = normalizeForMatch(transcript);
  const fields = ['title', 'author', 'narrator'] as const;

  const kept = { title: extraction.title, author: extraction.author, narrator: extraction.narrator };
  const evidence = { ...extraction.evidence };
  let nulledAny = false;
  for (const f of fields) {
    if (kept[f] !== null && !evidenceSupports(extraction.evidence[f], transcriptNorm)) {
      kept[f] = null;
      evidence[f] = null;
      nulledAny = true;
    }
  }

  const anySupported = kept.title !== null || kept.author !== null || kept.narrator !== null;
  return {
    ...extraction,
    ...kept,
    evidence,
    confidence: nulledAny ? Math.min(extraction.confidence, UNVERIFIED_CONFIDENCE_CAP) : extraction.confidence,
    attributionPresent: extraction.attributionPresent && anySupported,
  };
}

/**
 * Run one book through the full pipeline. Transcript and extraction are served
 * from / written to the split file cache, so re-runs of unchanged files are cheap.
 * Per-book errors are captured into the result rather than thrown — one bad file
 * shouldn't sink a whole scan.
 */
export async function processBook(book: Book, deps: ProcessDeps): Promise<BookResult> {
  const base = {
    name: book.name,
    sourcePath: book.source,
    introTrackPath: book.introTrackPath,
    introTrackReason: book.introTrackReason,
  };

  try {
    const identity = await fileIdentity(book.introTrackPath);

    // 1. Transcribe (cached)
    const tKey = transcriptKey({
      introTrackPath: book.introTrackPath,
      identity,
      offset: deps.offsetSeconds,
      seconds: deps.seconds,
      model: deps.whisperModel,
      backend: deps.transcribe.name,
    });
    let transcript = await deps.cache.get<string>('transcript', tKey);
    if (transcript === null) {
      transcript = await deps.transcribe.transcribe(book.introTrackPath, {
        ffmpegPath: deps.ffmpegPath,
        offsetSeconds: deps.offsetSeconds,
        seconds: deps.seconds,
        model: deps.whisperModel,
        signal: withTimeout(deps.signal, deps.transcribeTimeoutMs),
      });
      await deps.cache.set('transcript', tKey, transcript);
    }

    const tags = await readTags(book.introTrackPath);
    const transcriptExcerpt = transcript.slice(0, EXCERPT_CHARS);

    // No usable speech → book-level "couldn't determine", no field flags.
    if (transcript.replace(/\s/g, '').length < MIN_TRANSCRIPT_CHARS) {
      return {
        ...base,
        attributionPresent: false,
        detected: emptyAttr(),
        confidence: 0,
        evidence: emptyEvidence(),
        tags,
        flags: [],
        transcriptExcerpt,
        error: null,
      };
    }

    // 2. Extract (cached). Re-validate cached value against the schema so a stale
    // or corrupt cache entry is treated as a miss instead of trusted blindly.
    const eKey = extractionKey({
      transcriptHash: sha(transcript),
      model: deps.ollama.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
    });
    const cached = await deps.cache.get<unknown>('extraction', eKey);
    const cachedValid = cached === null ? null : extractionSchema.safeParse(cached);
    let extraction = cachedValid && cachedValid.success ? cachedValid.data : null;
    if (extraction === null) {
      extraction = await extract(transcript, {
        ...deps.ollama,
        signal: withTimeout(deps.signal, deps.extractTimeoutMs),
      });
      await deps.cache.set('extraction', eKey, extraction);
    }

    // 3. Enforce evidence (anti-hallucination) before trusting any detected field.
    const verified = enforceEvidence(extraction, transcript);

    const detected = {
      title: verified.title,
      authors: splitPeople(verified.author),
      narrators: splitPeople(verified.narrator),
    };

    const flags = verified.attributionPresent
      ? compareAttribution(detected, tags, verified.confidence)
      : [];

    return {
      ...base,
      attributionPresent: verified.attributionPresent,
      detected,
      confidence: verified.confidence,
      evidence: verified.evidence,
      tags,
      flags,
      transcriptExcerpt,
      error: null,
    };
  } catch (err) {
    // Job cancellation: bubble up so the scan ends as 'cancelled', not as a failed
    // book. A timeout (signal not job-aborted) is this book's failure, recorded below.
    if (deps.signal?.aborted) throw err;
    const message = isAbortError(err)
      ? 'operation timed out'
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      ...base,
      attributionPresent: false,
      detected: emptyAttr(),
      confidence: 0,
      evidence: emptyEvidence(),
      tags: emptyAttr(),
      flags: [],
      transcriptExcerpt: null,
      error: message,
    };
  }
}
