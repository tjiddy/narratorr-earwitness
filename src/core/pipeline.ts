import { extractionSchema, type Attribution, type BookResult, type Extraction } from '@shared/schemas.js';
import type { Book } from './discover.js';
import { type Cache, fileIdentity, sha, transcriptKey, extractionKey } from './cache.js';
import type { TranscribeProvider } from './transcribe/index.js';
import { extract, PROMPT_VERSION, SCHEMA_VERSION } from './extract.js';
import { readTags, getAudioDuration } from './tags.js';
import { AudioDecodeError } from './audio.js';
import { compareAttribution, splitPeople } from './compare.js';
import { resolveSelfNarration } from './self-narration.js';
import type { Logger } from './logger.js';
import type { PipelineTrace, WindowTrace } from './trace.js';

const MIN_TRANSCRIPT_CHARS = 15;
const EXCERPT_CHARS = 400;
// A publisher logo sting at t=0 ("This is Audible." + chime) can spike faster-whisper's
// no-speech detection and make it SUPPRESS the spoken credit that immediately follows it
// in the same decode window — the head comes back abnormally short with no narrator. When
// that happens we re-probe a few seconds in, past the sting, before paying for the tail.
const STING_SKIP_SECONDS = 8;
// Heuristic for "the head decode skipped the credit": a real 60s window of narration yields
// ~700+ chars of speech (HP head measured 697). The stinger bug leaves the head SPARSE — the
// chime makes faster-whisper jump past the credit to clear narration (Beware of Chicken's
// suppressed head measured 393). Below this we re-probe past the sting. (A genuinely full head
// that simply lacks a narrator — e.g. Listening Library, narrator never announced — stays above
// it and isn't re-probed, since re-probing wouldn't find a credit that isn't spoken.)
const SUPPRESSED_HEAD_CHARS = 600;
// When a detected field can't be backed by a transcript-grounded evidence span,
// we null it and cap confidence here — "we think we heard it but can't prove it".
const UNVERIFIED_CONFIDENCE_CAP = 0.4;

export interface ProcessDeps {
  transcribe: TranscribeProvider;
  cache: Cache;
  ffmpegPath: string;
  offsetSeconds: number;
  seconds: number;
  /** Whisper model, carried as a REFERENCE (not a snapshotted string) so a live edit via
   *  the Settings page — which mutates config.whisper.model in place — is picked up by the
   *  next transcribe without a restart. It also feeds the transcript cache key, so the key
   *  changes when the model changes (correct: different model → different transcript). */
  whisper: { model: string };
  ollama: { host: string; model: string };
  /** Job-level abort (cancellation). Combined with per-step timeouts below. */
  signal?: AbortSignal | undefined;
  transcribeTimeoutMs?: number | undefined;
  extractTimeoutMs?: number | undefined;
  /** Sample the file's TAIL when the head intro doesn't yield a complete attribution
   *  (Audible & co. put the credit at the end). Default on; set false to disable. */
  tailSampling?: boolean | undefined;
  /** Forward to the transcribe backend (transformers.js): emit token timestamps for
   *  reliable chunk stitching. Debug knob; default false. */
  returnTimestamps?: boolean | undefined;
  /** Debug: skip the transcript/extraction cache entirely (no read, no write) so a
   *  re-run actually re-transcribes/re-extracts. Essential for model A/B + variance. */
  bypassCache?: boolean | undefined;
  /** Optional request-scoped logger. When present, the pipeline narrates every step
   *  — transcript size + excerpt, raw extraction, evidence-guard nulling, final
   *  detection — so "why did it say X?" is answerable from the logs alone. */
  logger?: Logger | undefined;
  /** Optional debug trace collector. When present, the pipeline records the full guts
   *  of the run (full transcripts, raw extraction, guard nulling, window selection). */
  trace?: PipelineTrace | undefined;
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

/** One analyzed window of a file — transcript + the evidence-guarded detection from it. */
interface WindowAnalysis {
  label: 'head' | 'tail';
  transcript: string;
  transcriptExcerpt: string;
  attributionPresent: boolean;
  detected: Attribution;
  confidence: number;
  evidence: { title: string | null; author: string | null; narrator: string | null };
}

/** How many of the three fields a window actually pinned down — the head-vs-tail tiebreaker. */
function fieldScore(a: WindowAnalysis): number {
  return (a.detected.title ? 1 : 0) + (a.detected.authors.length ? 1 : 0) + (a.detected.narrators.length ? 1 : 0);
}

/** "Good enough to skip the tail": a title AND a NARRATOR, both evidence-backed. The tail
 *  exists to catch the narrator credit (Audible & co. put it at the end), so a head with a
 *  title+author but no narrator is NOT complete — it must still sample the tail. (Author
 *  alone used to satisfy this via fieldScore>=2, which silently dropped tail-only narrators.) */
function isComplete(a: WindowAnalysis): boolean {
  return a.attributionPresent && a.detected.title !== null && a.detected.narrators.length > 0;
}

/**
 * Transcribe + extract + evidence-guard ONE window of ONE track (head or tail). The
 * transcript cache key includes BOTH the sampled track path and the window offset, so
 * head/tail — even when they come from different files (a multi-file book) — never
 * collide and re-runs are cheap. Makes no head-vs-tail decision; the caller does.
 */
async function analyzeWindow(
  book: Book,
  deps: ProcessDeps,
  win: { track: string; offset: number; seconds: number; label: 'head' | 'tail' },
): Promise<WindowAnalysis> {
  const log = deps.logger;
  const bypass = deps.bypassCache === true;
  const startedAt = performance.now();
  const identity = await fileIdentity(win.track);

  const tKey = transcriptKey({
    introTrackPath: win.track,
    identity,
    offset: win.offset,
    seconds: win.seconds,
    model: deps.whisper.model,
    backend: deps.transcribe.name,
  });
  let transcript = bypass ? null : await deps.cache.get<string>('transcript', tKey);
  const cacheStatus: WindowTrace['cache'] = bypass ? 'bypass' : transcript !== null ? 'hit' : 'miss';
  if (transcript === null) {
    transcript = await deps.transcribe.transcribe(win.track, {
      ffmpegPath: deps.ffmpegPath,
      offsetSeconds: win.offset,
      seconds: win.seconds,
      model: deps.whisper.model,
      returnTimestamps: deps.returnTimestamps,
      signal: withTimeout(deps.signal, deps.transcribeTimeoutMs),
    });
    if (!bypass) await deps.cache.set('transcript', tKey, transcript);
  }
  const transcriptExcerpt = transcript.slice(0, EXCERPT_CHARS);
  log?.info(
    { book: book.name, window: win.label, offset: Math.round(win.offset), cache: cacheStatus, chars: transcript.length, excerpt: transcript.slice(0, 200) },
    'pipeline: transcribed',
  );
  log?.debug({ book: book.name, window: win.label, transcript }, 'pipeline: full transcript');

  // Push a trace record (debug only) for whichever exit we take.
  const pushTrace = (
    rawExtraction: WindowTrace['rawExtraction'],
    evidence: WindowTrace['evidence'],
    nulledByGuard: string[],
    detected: Attribution,
    attributionPresent: boolean,
    confidence: number,
  ): void => {
    deps.trace?.windows.push({
      label: win.label,
      track: win.track,
      offset: Math.round(win.offset),
      seconds: win.seconds,
      cache: cacheStatus,
      chars: transcript!.length,
      transcript: transcript!,
      rawExtraction,
      evidence,
      nulledByGuard,
      detected,
      attributionPresent,
      confidence,
      ms: Math.round(performance.now() - startedAt),
    });
  };

  // No usable speech in this window → empty detection (the caller may try the other window).
  if (transcript.replace(/\s/g, '').length < MIN_TRANSCRIPT_CHARS) {
    log?.warn(
      { book: book.name, window: win.label, chars: transcript.length },
      'pipeline: no usable speech in window → attributionPresent=false (silence/music, or credit is elsewhere)',
    );
    pushTrace(null, null, [], emptyAttr(), false, 0);
    return { label: win.label, transcript, transcriptExcerpt, attributionPresent: false, detected: emptyAttr(), confidence: 0, evidence: emptyEvidence() };
  }

  // Extract (cached). Re-validate cached value against the schema so a stale or corrupt
  // cache entry is treated as a miss instead of trusted blindly.
  const eKey = extractionKey({
    transcriptHash: sha(transcript),
    model: deps.ollama.model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
  });
  const cached = bypass ? null : await deps.cache.get<unknown>('extraction', eKey);
  const cachedValid = cached === null ? null : extractionSchema.safeParse(cached);
  let extraction = cachedValid && cachedValid.success ? cachedValid.data : null;
  const extractionCached = extraction !== null;
  if (extraction === null) {
    extraction = await extract(transcript, { ...deps.ollama, signal: withTimeout(deps.signal, deps.extractTimeoutMs) });
    if (!bypass) await deps.cache.set('extraction', eKey, extraction);
  }
  log?.info(
    {
      book: book.name,
      window: win.label,
      cache: bypass ? 'bypass' : extractionCached ? 'hit' : 'miss',
      raw: { title: extraction.title, author: extraction.author, narrator: extraction.narrator },
      confidence: extraction.confidence,
      attributionPresent: extraction.attributionPresent,
    },
    'pipeline: extracted (raw, pre-evidence-guard)',
  );
  log?.debug({ book: book.name, window: win.label, evidence: extraction.evidence }, 'pipeline: extraction evidence spans');

  // Enforce evidence (anti-hallucination) before trusting any detected field.
  const verified = enforceEvidence(extraction, transcript);
  const nulled = (['title', 'author', 'narrator'] as const).filter((f) => extraction[f] !== null && verified[f] === null);
  if (nulled.length > 0) {
    log?.warn(
      { book: book.name, window: win.label, nulled, confidence: verified.confidence },
      'pipeline: evidence guard nulled unsupported field(s) — detected but not found verbatim in the transcript',
    );
  }

  const rawDetected = {
    title: verified.title,
    authors: splitPeople(verified.author),
    narrators: splitPeople(verified.narrator),
  };
  // Deterministically resolve role-word narrators ("read by the author") to the detected author(s)
  // BEFORE comparison — the sighted LLM judge resolves this only intermittently (see self-narration.ts).
  const detected = resolveSelfNarration(rawDetected);
  if (detected.narrators.join('|') !== rawDetected.narrators.join('|')) {
    log?.info(
      { book: book.name, window: win.label, from: rawDetected.narrators, to: detected.narrators },
      'pipeline: resolved self-narration (role → author name)',
    );
  }
  log?.info(
    { book: book.name, window: win.label, attributionPresent: verified.attributionPresent, detected, confidence: verified.confidence },
    'pipeline: window analysis complete',
  );

  pushTrace(
    { title: extraction.title, author: extraction.author, narrator: extraction.narrator, confidence: extraction.confidence, attributionPresent: extraction.attributionPresent },
    extraction.evidence,
    nulled,
    detected,
    verified.attributionPresent,
    verified.confidence,
  );

  return {
    label: win.label,
    transcript,
    transcriptExcerpt,
    attributionPresent: verified.attributionPresent,
    detected,
    confidence: verified.confidence,
    evidence: verified.evidence,
  };
}

/**
 * Run one book through the full pipeline. Samples the HEAD of the first track (publisher
 * intro) first; if that doesn't yield a complete attribution, samples the TAIL of the
 * LAST track (Audible & co. put the credit at the end — which for a multi-file book is
 * in the final track, not the tail of track 1) and keeps whichever window heard more.
 * Only books the head can't resolve pay for a second transcription. Transcript +
 * extraction are cached, so re-runs of unchanged files are cheap. Per-book errors are
 * captured into the result rather than thrown — one bad file shouldn't sink a whole scan.
 */
export async function processBook(book: Book, rawDeps: ProcessDeps): Promise<BookResult> {
  // Snapshot the mutable runtime config (model names) + the transcribe backend ONCE per book.
  // The Settings page can hot-swap the Whisper backend / model mid-run; without this snapshot
  // the cache key (which embeds model + backend name) could be computed from one config and
  // the actual transcribe/extract run against another across an await, mis-keying the cache.
  // Live edits still apply to the NEXT book — each processBook call re-snapshots.
  const deps: ProcessDeps = {
    ...rawDeps,
    whisper: { model: rawDeps.whisper.model },
    ollama: { host: rawDeps.ollama.host, model: rawDeps.ollama.model },
    transcribe: rawDeps.transcribe.snapshot?.() ?? rawDeps.transcribe,
  };
  const base = {
    name: book.name,
    sourcePath: book.source,
    introTrackPath: book.introTrackPath,
    introTrackReason: book.introTrackReason,
  };
  const log = deps.logger;
  log?.info(
    { book: book.name, sourcePath: book.source, introTrack: book.introTrackPath, introReason: book.introTrackReason },
    'pipeline: processing book',
  );

  try {
    const tags = await readTags(book.introTrackPath);

    const headTrack = book.tracks[0] ?? book.introTrackPath;
    const tailTrack = book.tracks[book.tracks.length - 1] ?? book.introTrackPath;
    if (deps.trace) {
      deps.trace.book = {
        name: book.name,
        source: book.source,
        introTrackPath: book.introTrackPath,
        tracks: book.tracks,
        firstTrack: headTrack,
        lastTrack: tailTrack,
      };
    }
    if (book.tracks.length > 1) {
      log?.info(
        { book: book.name, tracks: book.tracks.length, first: headTrack, last: tailTrack, source: book.source },
        'pipeline: multi-file book — head from first track, tail from last',
      );
      // Soft signal, not a cap: a real book is a handful-to-dozens of tracks. Hundreds
      // smells like a multi-book parent (a narratorr contract breach) — leave a breadcrumb.
      if (book.tracks.length > 150) {
        log?.warn(
          { book: book.name, tracks: book.tracks.length, source: book.source },
          'pipeline: unusually many tracks for one book — possible multi-book parent (contract breach?)',
        );
      }
    }

    // Window 1: the head of the first track — where well-behaved books announce themselves.
    let chosen = await analyzeWindow(book, deps, {
      track: headTrack,
      offset: deps.offsetSeconds,
      seconds: deps.seconds,
      label: 'head',
    });
    // Default trace selection (overwritten below if we actually sample the tail).
    if (deps.trace) deps.trace.selection = { tailSampled: false, headScore: fieldScore(chosen), tailScore: 0, winner: 'head' };

    // Window 1b (stinger re-probe): if the head didn't fully resolve AND its transcript is
    // abnormally short, the publisher logo sting likely suppressed the credit. Re-seek a few
    // seconds in — past the sting — and keep it if it heard more. Cheap insurance against the
    // "This is Audible." decode-suppression bug (faster-whisper bails after the chime).
    if (
      !isComplete(chosen) &&
      chosen.transcript.replace(/\s/g, '').length < SUPPRESSED_HEAD_CHARS &&
      deps.offsetSeconds === 0
    ) {
      log?.info(
        { book: book.name, headChars: chosen.transcript.length, reprobeOffset: STING_SKIP_SECONDS },
        'pipeline: head short/incomplete → re-probing past the intro sting',
      );
      const head2 = await analyzeWindow(book, deps, {
        track: headTrack,
        offset: STING_SKIP_SECONDS,
        seconds: deps.seconds,
        label: 'head',
      });
      if (
        fieldScore(head2) > fieldScore(chosen) ||
        (fieldScore(head2) === fieldScore(chosen) && head2.attributionPresent && !chosen.attributionPresent)
      ) {
        chosen = head2;
        if (deps.trace) deps.trace.selection = { tailSampled: false, headScore: fieldScore(chosen), tailScore: 0, winner: 'head' };
      }
    }

    // Window 2 (lazy): the tail of the LAST track. A separate tail file is always new
    // audio; for a single-file book only sample the tail if it doesn't overlap the head.
    if (deps.tailSampling !== false && !isComplete(chosen)) {
      const multiFile = tailTrack !== headTrack;
      const duration = await getAudioDuration(tailTrack);
      const headEnd = deps.offsetSeconds + deps.seconds;
      if (duration !== null && (multiFile || duration - deps.seconds > headEnd)) {
        const tailOffset = Math.max(0, duration - deps.seconds);
        log?.info(
          { book: book.name, tailTrack, duration: Math.round(duration), tailOffset: Math.round(tailOffset), headScore: fieldScore(chosen) },
          'pipeline: head incomplete → sampling tail',
        );
        const tail = await analyzeWindow(book, deps, { track: tailTrack, offset: tailOffset, seconds: deps.seconds, label: 'tail' });
        const headScore = fieldScore(chosen);
        const tailScore = fieldScore(tail);
        const tailWins = tailScore > headScore || (tailScore === headScore && tail.attributionPresent && !chosen.attributionPresent);
        log?.info(
          { book: book.name, headScore, tailScore, winner: tailWins ? 'tail' : 'head' },
          'pipeline: window selection',
        );
        if (deps.trace) deps.trace.selection = { tailSampled: true, headScore, tailScore, winner: tailWins ? 'tail' : 'head' };
        if (tailWins) chosen = tail;
      } else {
        log?.info(
          { book: book.name, duration: duration === null ? 'unknown' : Math.round(duration) },
          'pipeline: tail sampling skipped (file too short, or duration unknown)',
        );
      }
    }

    const flags = chosen.attributionPresent
      ? compareAttribution(chosen.detected, tags, chosen.confidence)
      : [];

    log?.info(
      { book: book.name, window: chosen.label, attributionPresent: chosen.attributionPresent, detected: chosen.detected, confidence: chosen.confidence },
      'pipeline: detection complete',
    );

    return {
      ...base,
      attributionPresent: chosen.attributionPresent,
      detected: chosen.detected,
      confidence: chosen.confidence,
      evidence: chosen.evidence,
      tags,
      flags,
      transcriptExcerpt: chosen.transcriptExcerpt,
      error: null,
      errorKind: null,
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
    // Undecodable audio is permanent for this file (don't retry); everything else —
    // timeouts, dependency hiccups, the fuzzy middle — defaults to transient (retry-safe).
    const errorKind = err instanceof AudioDecodeError ? 'unprocessable' : 'transient';
    log?.warn({ book: book.name, error: message, errorKind }, 'pipeline: processing failed');
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
      errorKind,
    };
  }
}
