import { resolveBookAt } from '@core/discover.js';
import type { Book } from '@core/discover.js';
import { processBook, type ProcessDeps } from '@core/pipeline.js';
import { compareIdentity, type Expected } from '@core/compare-llm.js';
import type { Logger } from '@core/logger.js';
import { newPipelineTrace } from '@core/trace.js';
import { TRANSFORMERS_MODEL_ALIASES } from '@core/transcribe/models.js';
import type { AttributionRequest, Comparison, DebugResult, DebugRun, Detection } from '@shared/schemas.js';
import { realOrNull, resolveWithinRoot } from '../paths.js';

// Per-file attribution: the engine behind POST /api/v1/attribution. Stateless — one
// path in, detection (+ optional comparison) out. narratorr owns the loop; this just
// answers one book at a time and protects its own (possibly tiny) hardware with a
// process-wide in-flight cap that the route turns into 503 + Retry-After.

export interface AttributionServiceDeps extends ProcessDeps {
  /** Shared library mount root; request paths are resolved relative to this. */
  libraryRoot: string;
  /** Max concurrent attribution calls before we shed load (→ 503). */
  maxActive: number;
}

/** Too many attribution calls in flight. Route → 503 + Retry-After. */
export class AttributionCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`attribution capacity reached (${limit} active)`);
    this.name = 'AttributionCapacityError';
  }
}
/** Request path escapes the library root. Route → 403. */
export class PathForbiddenError extends Error {
  constructor(readonly requested: string) {
    super('path resolves outside the configured library root');
    this.name = 'PathForbiddenError';
  }
}
/** No audio file at the request path. Route → 404. */
export class PathNotFoundError extends Error {
  constructor(readonly requested: string) {
    super('no audio file found at path');
    this.name = 'PathNotFoundError';
  }
}
/** Library root not mounted/readable — server misconfig. Route → 503 + Retry-After. */
export class LibraryRootError extends Error {
  constructor(readonly root: string) {
    super(`library root not accessible: ${root}`);
    this.name = 'LibraryRootError';
  }
}
/** TRANSIENT processing failure (timeout / dependency hiccup). Route → 503 + Retry-After. */
export class ProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessingError';
  }
}
/** PERMANENT per-file failure — the audio can't be decoded. Route → 422 (don't retry). */
export class UnprocessableContentError extends Error {
  constructor(message: string) {
    super(`unprocessable audio: ${message}`);
    this.name = 'UnprocessableContentError';
  }
}
/** A debug run is already in flight (debug is single-slot — only one at a time). */
export class DebugBusyError extends Error {
  constructor() {
    super('a debug run is already in progress — try again when it finishes');
    this.name = 'DebugBusyError';
  }
}
/** A debug request supplied a model override that isn't allow-listed. Route → 400. */
export class InvalidModelError extends Error {
  constructor(field: 'whisperModel' | 'ollamaModel', value: string) {
    super(`${field} "${value.slice(0, 80)}" is not an allowed model override`);
    this.name = 'InvalidModelError';
  }
}

export interface AttributeInput {
  path: string;
  expected?: AttributionRequest['expected'];
  signal?: AbortSignal | undefined;
  /** Request-scoped logger (the route passes req.log). Threads through to the pipeline. */
  logger?: Logger | undefined;
}

export interface AttributeResult {
  detection: Detection;
  comparison?: Comparison;
}

export class AttributionService {
  private active = 0;
  // Single-slot cap: only ONE debug run executes at a time. NOTE this serializes
  // debug-vs-debug only — a debug run still SHARES the transcribe semaphore and the
  // single-resident model cache with production (a model override evicts the live model),
  // so it can slow/evict production. The env flag (OFF by default) is the real isolation.
  private debugActive = 0;

  constructor(private readonly deps: AttributionServiceDeps) {}

  async attribute(input: AttributeInput): Promise<AttributeResult> {
    const log = input.logger;
    log?.info({ path: input.path, hasExpected: !!input.expected }, 'attribution: request received');

    if (this.active >= this.deps.maxActive) {
      log?.warn({ path: input.path, active: this.active, limit: this.deps.maxActive }, 'attribution: at capacity → 503');
      throw new AttributionCapacityError(this.deps.maxActive);
    }
    this.active += 1;
    try {
      const book = await this.resolveOneBook(input.path, log);

      // Stage 1: blind extraction → detection (evidence-guarded fact).
      const result = await processBook(book, { ...this.deps, signal: input.signal, logger: log });
      if (result.error !== null) {
        log?.warn({ path: input.path, error: result.error, kind: result.errorKind }, 'attribution: processing failed');
        // Permanent (undecodable audio) → 422; transient (timeout/dependency) → 503.
        throw result.errorKind === 'unprocessable'
          ? new UnprocessableContentError(result.error)
          : new ProcessingError(result.error);
      }

      const detection: Detection = {
        attributionPresent: result.attributionPresent,
        detected: result.detected,
        evidence: result.evidence,
        confidence: result.confidence,
      };

      if (!input.expected) {
        log?.info(
          { path: input.path, attributionPresent: detection.attributionPresent, confidence: detection.confidence },
          'attribution: complete (detection only, no expected)',
        );
        return { detection };
      }

      // Stage 2: sighted comparison → verdict (never mutates detection).
      const expected: Expected = {
        title: input.expected.title ?? null,
        authors: input.expected.authors ?? [],
        narrators: input.expected.narrators ?? [],
      };
      const comparison = await compareIdentity(result.detected, expected, {
        host: this.deps.ollama.host,
        model: this.deps.ollama.model,
        cache: this.deps.cache,
        signal: input.signal,
      });
      log?.info(
        {
          path: input.path,
          status: comparison.status,
          fields: {
            title: comparison.fields.title.status,
            authors: comparison.fields.authors.status,
            narrators: comparison.fields.narrators.status,
          },
        },
        'attribution: complete (comparison)',
      );
      return { detection, comparison };
    } finally {
      this.active -= 1;
    }
  }

  /**
   * Shared path → single Book resolution (containment guard + resolveBookAt). Throws the
   * same LibraryRoot/Forbidden/NotFound errors as attribute(), so the public and debug
   * paths have IDENTICAL path safety.
   */
  private async resolveOneBook(reqPath: string, log?: Logger): Promise<Book> {
    const rootReal = await realOrNull(this.deps.libraryRoot);
    if (!rootReal) {
      log?.warn({ root: this.deps.libraryRoot }, 'attribution: library root not accessible → 503');
      throw new LibraryRootError(this.deps.libraryRoot);
    }
    const resolved = await resolveWithinRoot(reqPath, rootReal);
    if (!resolved.ok) {
      log?.warn({ path: reqPath, reason: resolved.reason }, 'attribution: path rejected');
      throw resolved.reason === 'forbidden' ? new PathForbiddenError(reqPath) : new PathNotFoundError(reqPath);
    }
    // EXACTLY ONE book (narratorr owns layout, §B.6) — never split a multi-file/multi-disc book.
    const book = await resolveBookAt(resolved.real);
    if (!book) {
      log?.warn({ path: reqPath }, 'attribution: no audio found at path → 404');
      throw new PathNotFoundError(reqPath);
    }
    if (book.tracks.length > 1) {
      log?.info(
        { path: reqPath, tracks: book.tracks.length, first: book.tracks[0], last: book.tracks.at(-1), source: book.source },
        'attribution: resolved multi-file book (one book, all tracks)',
      );
    }
    return book;
  }

  /**
   * Reject request-supplied model overrides that aren't safe. On the in-process
   * `transformersjs` backend an override reaches `pipeline()`, where an arbitrary HF repo
   * id would download + execute remote weights — so request overrides are allow-listed to
   * the known aliases (the configured model is always allowed). Other backends forward the
   * name to a remote service (opaque to us), so we only reject traversal/URL/oversized shapes.
   */
  private validateDebugModels(input: DebugAttributeInput): void {
    const unsafe = (v: string): boolean => v.length > 200 || /\s/.test(v) || v.includes('..') || v.includes('://');
    const whisper = input.whisperModel?.trim();
    if (whisper && whisper !== this.deps.whisper.model) {
      if (this.deps.transcribe.name === 'transformersjs') {
        if (!TRANSFORMERS_MODEL_ALIASES.includes(whisper)) throw new InvalidModelError('whisperModel', whisper);
      } else if (unsafe(whisper)) {
        throw new InvalidModelError('whisperModel', whisper);
      }
    }
    const ollama = input.ollamaModel?.trim();
    if (ollama && ollama !== this.deps.ollama.model && unsafe(ollama)) {
      throw new InvalidModelError('ollamaModel', ollama);
    }
  }

  /**
   * DEBUG ONLY (gated by EARWITNESS_DEBUG_ATTRIBUTION + API key at the route). Runs the
   * REAL pipeline N times with a trace collector, bypassing all caches by default and
   * optionally overriding the STT/LLM model — so we can diagnose attribution misses
   * (e.g. a dropped credit line) and A/B models. Single-slot (debug-vs-debug); it still
   * competes with production at the transcribe semaphore + shared resident-model cache, so
   * a model override evicts the live model. N runs go sequentially within one request.
   */
  async debugAttribute(input: DebugAttributeInput): Promise<DebugResult> {
    this.validateDebugModels(input); // reject unsafe model overrides before taking the slot
    if (this.debugActive >= 1) throw new DebugBusyError();
    this.debugActive += 1;
    try {
      const book = await this.resolveOneBook(input.path);
      const whisperModel = input.whisperModel?.trim() || this.deps.whisper.model;
      const ollamaModel = input.ollamaModel?.trim() || this.deps.ollama.model;
      const forceFresh = input.forceFresh !== false; // default true — debug must bypass caches
      const runsN = Math.min(Math.max(input.runs ?? 1, 1), 10);

      const runs: DebugRun[] = [];
      for (let i = 0; i < runsN; i++) {
        const trace = newPipelineTrace();
        const t0 = performance.now();
        const result = await processBook(book, {
          ...this.deps,
          // Fresh objects (not config.whisper / config.ollama) so a debug per-run override
          // never mutates the live production config.
          whisper: { model: whisperModel },
          ollama: { host: this.deps.ollama.host, model: ollamaModel },
          returnTimestamps: input.returnTimestamps,
          bypassCache: forceFresh,
          trace,
        });
        const detection: Detection = {
          attributionPresent: result.attributionPresent,
          detected: result.detected,
          evidence: result.evidence,
          confidence: result.confidence,
        };
        let comparison: Comparison | undefined;
        let compareMs: number | undefined;
        if (input.expected && result.error === null) {
          const expected: Expected = {
            title: input.expected.title ?? null,
            authors: input.expected.authors ?? [],
            narrators: input.expected.narrators ?? [],
          };
          const c0 = performance.now();
          comparison = await compareIdentity(result.detected, expected, {
            host: this.deps.ollama.host,
            model: ollamaModel,
            cache: this.deps.cache,
            bypassCache: forceFresh,
          });
          compareMs = Math.round(performance.now() - c0);
        }
        runs.push({
          detection,
          trace,
          error: result.error,
          errorKind: result.errorKind,
          totalMs: Math.round(performance.now() - t0),
          ...(comparison ? { comparison } : {}),
          ...(compareMs !== undefined ? { compareMs } : {}),
        });
      }

      return {
        config: {
          whisperBackend: this.deps.transcribe.name,
          whisperModel,
          ollamaModel,
          seconds: this.deps.seconds,
          offsetSeconds: this.deps.offsetSeconds,
          tailSampling: this.deps.tailSampling !== false,
          returnTimestamps: input.returnTimestamps === true,
          forceFresh,
          modelOverridden: whisperModel !== this.deps.whisper.model,
        },
        runs,
      };
    } finally {
      this.debugActive -= 1;
    }
  }
}

export interface DebugAttributeInput {
  path: string;
  expected?: AttributionRequest['expected'];
  whisperModel?: string | undefined;
  ollamaModel?: string | undefined;
  returnTimestamps?: boolean | undefined;
  forceFresh?: boolean | undefined;
  runs?: number | undefined;
}
// DebugRun / DebugResult shapes live in @shared/schemas/debug.ts (shared with the client).
