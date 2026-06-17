import { randomUUID } from 'node:crypto';
import {
  scanResultsSchema,
  type BookResult,
  type ScanProgress,
  type ScanResults,
  type ScanStatus,
} from '@shared/schemas.js';
import { discover } from '@core/discover.js';
import { processBook, type ProcessDeps } from '@core/pipeline.js';
import type { ReportStore } from '@core/store.js';
import type { Logger } from '@core/logger.js';

// In-memory job tracker (mirrors Narratorr's MatchJobService): jobs live in a Map,
// results accumulate on the job, and finished jobs are TTL-cleaned. The report
// store gives durability; this gives live progress.

const JOB_TTL_MS = 30 * 60 * 1000;
const TERMINAL: ReadonlySet<ScanStatus> = new Set(['completed', 'failed', 'cancelled']);

interface ScanJob {
  id: string;
  source: 'local';
  root: string;
  status: ScanStatus;
  total: number;
  processed: number;
  currentBooks: Set<string>;
  results: BookResult[];
  error: string | null;
  abort: AbortController;
}

export interface ScanServiceDeps extends ProcessDeps {
  reportStore: ReportStore;
  maxConcurrentBooks: number;
  maxActiveScans: number;
}

/** Thrown by start() when the process-global scan cap is hit. Route → 503. */
export class ScanCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`scan capacity reached (${limit} active)`);
    this.name = 'ScanCapacityError';
  }
}

export class ScanJobService {
  private readonly jobs = new Map<string, ScanJob>();
  // Set once at startup (index.ts) to the app's pino logger. Scans can only start
  // after the app is listening, so it's always present by the time run() logs.
  private logger: Logger | null = null;

  constructor(private readonly deps: ScanServiceDeps) {}

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  private activeCount(): number {
    let active = 0;
    for (const job of this.jobs.values()) if (!TERMINAL.has(job.status)) active += 1;
    return active;
  }

  start(root: string): string {
    // Process-global backpressure: reject when too many scans are already in flight.
    if (this.activeCount() >= this.deps.maxActiveScans) {
      throw new ScanCapacityError(this.deps.maxActiveScans);
    }
    const id = randomUUID();
    const job: ScanJob = {
      id,
      source: 'local',
      root,
      status: 'pending',
      total: 0,
      processed: 0,
      currentBooks: new Set(),
      results: [],
      error: null,
      abort: new AbortController(),
    };
    this.jobs.set(id, job);
    void this.run(job);
    return id;
  }

  progress(id: string): ScanProgress | null {
    const job = this.jobs.get(id);
    return job ? this.toProgress(job) : null;
  }

  // Async + durable fallback: once a job is TTL-evicted (or after a restart) the
  // live results are gone, so we read the flushed report off disk and re-validate it.
  async results(id: string): Promise<ScanResults | null> {
    const job = this.jobs.get(id);
    if (job) return { ...this.toProgress(job), results: job.results };
    try {
      const report = await this.deps.reportStore.read(id);
      if (!report) return null;
      const parsed = scanResultsSchema.safeParse(report);
      if (!parsed.success) {
        this.logger?.warn({ scanId: id }, 'report on disk failed schema validation');
        return null;
      }
      return parsed.data;
    } catch (err) {
      this.logger?.warn({ scanId: id, err }, 'failed to read report');
      return null;
    }
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.abort.abort();
    return true;
  }

  private toProgress(job: ScanJob): ScanProgress {
    return {
      id: job.id,
      source: job.source,
      root: job.root,
      status: job.status,
      total: job.total,
      processed: job.processed,
      currentBooks: [...job.currentBooks],
      error: job.error,
    };
  }

  private async run(job: ScanJob): Promise<void> {
    try {
      job.status = 'discovering';
      const books = await discover(job.root);
      job.total = books.length;
      job.status = 'processing';

      await mapLimit(books, this.deps.maxConcurrentBooks, async (book) => {
        if (job.abort.signal.aborted) return;
        job.currentBooks.add(book.name);
        try {
          const result = await processBook(book, { ...this.deps, signal: job.abort.signal });
          job.results.push(result);
          job.processed += 1;
          await this.flush(job); // incremental — survive a crash mid-scan
        } catch (err) {
          // processBook only throws on cancellation; swallow so we end 'cancelled'.
          if (job.abort.signal.aborted) return;
          throw err;
        } finally {
          job.currentBooks.delete(book.name);
        }
      });

      job.status = job.abort.signal.aborted ? 'cancelled' : 'completed';
    } catch (err) {
      if (job.abort.signal.aborted) {
        job.status = 'cancelled';
      } else {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      job.currentBooks.clear();
      await this.flush(job);
      this.scheduleCleanup(job.id);
    }
  }

  private async flush(job: ScanJob): Promise<void> {
    try {
      await this.deps.reportStore.write({ ...this.toProgress(job), results: job.results });
    } catch (err) {
      // A failed flush shouldn't kill the scan, but it must not be silent either —
      // it means the durable copy is stale.
      this.logger?.warn({ scanId: job.id, err }, 'failed to flush report');
    }
  }

  private scheduleCleanup(id: string): void {
    setTimeout(() => this.jobs.delete(id), JOB_TTL_MS).unref();
  }
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const n = Math.max(1, limit);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
