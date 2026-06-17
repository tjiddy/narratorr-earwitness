import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScanJobService, ScanCapacityError, type ScanServiceDeps } from './scan-job.service.js';
import { Cache } from '@core/cache.js';
import { ReportStore } from '@core/store.js';
import type { ScanResults } from '@shared/schemas.js';

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ew-svc-'));
});
afterAll(async () => {
  // Fire-and-forget scans (the cap test) may still be flushing reports as we tear
  // down — retry past the resulting ENOTEMPTY rather than failing the suite.
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function makeService(over: Partial<ScanServiceDeps> = {}): { svc: ScanJobService; reportStore: ReportStore } {
  const reportStore = new ReportStore(path.join(tmp, `reports-${Math.random().toString(36).slice(2)}`));
  const svc = new ScanJobService({
    transcribe: { name: 'fake', transcribe: async () => '' },
    cache: new Cache(path.join(tmp, 'cache')),
    reportStore,
    ffmpegPath: 'ffmpeg',
    offsetSeconds: 0,
    seconds: 60,
    whisper: { model: 't' },
    ollama: { host: 'http://x', model: 'm' },
    maxConcurrentBooks: 1,
    maxActiveScans: 4,
    ...over,
  });
  return { svc, reportStore };
}

describe('results() durable fallback (P1-6)', () => {
  it('reads the on-disk report when the job is no longer in memory', async () => {
    const { svc, reportStore } = makeService();
    const report: ScanResults = {
      id: 'gone-123',
      source: 'local',
      root: '/x',
      status: 'completed',
      total: 1,
      processed: 1,
      currentBooks: [],
      error: null,
      results: [],
    };
    await reportStore.write(report);
    const out = await svc.results('gone-123');
    expect(out?.id).toBe('gone-123');
    expect(out?.status).toBe('completed');
  });

  it('returns null for an unknown scan with no report on disk', async () => {
    const { svc } = makeService();
    expect(await svc.results('nope-456')).toBeNull();
  });
});

describe('global scan cap (P1-7)', () => {
  it('rejects a scan started beyond the active cap', () => {
    const { svc } = makeService({ maxActiveScans: 1 });
    svc.start('/nonexistent/root-a'); // counts as active (pending/discovering)
    expect(() => svc.start('/nonexistent/root-b')).toThrow(ScanCapacityError);
  });
});
