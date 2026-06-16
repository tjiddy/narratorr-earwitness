import { discover } from '@core/discover.js';
import { processBook, type ProcessDeps } from '@core/pipeline.js';
import { compareIdentity, type Expected } from '@core/compare-llm.js';
import type { AttributionRequest, Comparison, Detection } from '@shared/schemas.js';
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
/** Folder holds multiple distinct books. Route → 422. */
export class AmbiguousPathError extends Error {
  constructor(readonly count: number) {
    super(`path is a folder with ${count} distinct books — send one book's path`);
    this.name = 'AmbiguousPathError';
  }
}
/** Library root not mounted/readable — server misconfig. Route → 503 + Retry-After. */
export class LibraryRootError extends Error {
  constructor(readonly root: string) {
    super(`library root not accessible: ${root}`);
    this.name = 'LibraryRootError';
  }
}
/** Processing failed (transcribe/extract error, timeout). Route → 503 + Retry-After. */
export class ProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessingError';
  }
}

export interface AttributeInput {
  path: string;
  expected?: AttributionRequest['expected'];
  signal?: AbortSignal | undefined;
}

export interface AttributeResult {
  detection: Detection;
  comparison?: Comparison;
}

export class AttributionService {
  private active = 0;

  constructor(private readonly deps: AttributionServiceDeps) {}

  async attribute(input: AttributeInput): Promise<AttributeResult> {
    if (this.active >= this.deps.maxActive) throw new AttributionCapacityError(this.deps.maxActive);
    this.active += 1;
    try {
      const rootReal = await realOrNull(this.deps.libraryRoot);
      if (!rootReal) throw new LibraryRootError(this.deps.libraryRoot);

      const resolved = await resolveWithinRoot(input.path, rootReal);
      if (!resolved.ok) {
        throw resolved.reason === 'forbidden'
          ? new PathForbiddenError(input.path)
          : new PathNotFoundError(input.path);
      }

      const books = await discover(resolved.real);
      if (books.length === 0) throw new PathNotFoundError(input.path); // exists, but no audio
      if (books.length > 1) throw new AmbiguousPathError(books.length);
      const book = books[0]!;

      // Stage 1: blind extraction → detection (evidence-guarded fact).
      const result = await processBook(book, { ...this.deps, signal: input.signal });
      if (result.error !== null) throw new ProcessingError(result.error);

      const detection: Detection = {
        attributionPresent: result.attributionPresent,
        detected: result.detected,
        evidence: result.evidence,
        confidence: result.confidence,
      };

      if (!input.expected) return { detection };

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
      return { detection, comparison };
    } finally {
      this.active -= 1;
    }
  }
}
