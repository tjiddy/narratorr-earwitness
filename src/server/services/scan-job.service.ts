import { randomUUID } from 'node:crypto';
import type { BookResult, ScanProgress, ScanResults, ScanStatus } from '@shared/schemas.js';
import { discover } from '@core/discover.js';
import { processBook, type ProcessDeps } from '@core/pipeline.js';
import type { ReportStore } from '@core/store.js';

// In-memory job tracker (mirrors Narratorr's MatchJobService): jobs live in a Map,
// results accumulate on the job, and finished jobs are TTL-cleaned. The report
// store gives durability; this gives live progress.

const JOB_TTL_MS = 30 * 60 * 1000;

interface ScanJob {
  id: string;
  source: 'local';
  root: string;
  status: ScanStatus;
  total: number;
  processed: number;
  currentBook: string | null;
  results: BookResult[];
  error: string | null;
  abort: AbortController;
}

export interface ScanServiceDeps extends Omit<ProcessDeps, never> {
  reportStore: ReportStore;
  maxConcurrentBooks: number;
}

export class ScanJobService {
  private readonly jobs = new Map<string, ScanJob>();

  constructor(private readonly deps: ScanServiceDeps) {}

  start(root: string): string {
    const id = randomUUID();
    const job: ScanJob = {
      id,
      source: 'local',
      root,
      status: 'pending',
      total: 0,
      processed: 0,
      currentBook: null,
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

  results(id: string): ScanResults | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return { ...this.toProgress(job), results: job.results };
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
      currentBook: job.currentBook,
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
        job.currentBook = book.name;
        const result = await processBook(book, this.deps);
        job.results.push(result);
        job.processed += 1;
        await this.flush(job); // incremental — survive a crash mid-scan
      });

      job.status = job.abort.signal.aborted ? 'cancelled' : 'completed';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.currentBook = null;
      await this.flush(job);
      this.scheduleCleanup(job.id);
    }
  }

  private async flush(job: ScanJob): Promise<void> {
    try {
      await this.deps.reportStore.write({ ...this.toProgress(job), results: job.results });
    } catch {
      // a failed flush shouldn't kill the scan
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
