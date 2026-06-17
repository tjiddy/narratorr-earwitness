import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import {
  DebugBusyError,
  InvalidModelError,
  LibraryRootError,
  PathForbiddenError,
  PathNotFoundError,
} from '../services/attribution.service.js';
import type { ScanJobService } from '../services/scan-job.service.js';
import type { AttributionService } from '../services/attribution.service.js';
import type { DebugResult } from '@shared/schemas.js';

// POST /api/debug/attribution is registered ONLY when EARWITNESS_DEBUG_ATTRIBUTION is on.
// app.test.ts covers the off (404) case; here we enable it and verify the error→status
// mapping + a success pass-through. The route exposes full transcripts, so its safety
// behaviors (busy-shed 429, traversal 403) must not regress silently.

const fakeScans = () =>
  ({ start: () => 'x', progress: () => null, results: async () => null, cancel: () => false }) as unknown as ScanJobService;

function appWithDebug(debugAttribute: AttributionService['debugAttribute']) {
  const attribution = { attribute: async () => ({ detection: {} }), debugAttribute } as unknown as AttributionService;
  return buildApp({ scans: fakeScans(), attribution, serveStatic: false });
}

const post = (payload: Record<string, unknown>) => ({ method: 'POST' as const, url: '/api/debug/attribution', payload });

beforeEach(() => {
  config.debugAttribution = true;
});
afterEach(() => {
  config.debugAttribution = false; // reset the singleton (app.test.ts asserts the off case)
});

describe('POST /api/debug/attribution (enabled)', () => {
  it('maps each debug error to its status code', async () => {
    const cases: Array<[Error, number]> = [
      [new InvalidModelError('whisperModel', 'evil/x'), 400],
      [new DebugBusyError(), 429],
      [new PathForbiddenError('p'), 403],
      [new PathNotFoundError('p'), 404],
      [new LibraryRootError('/lib'), 503],
    ];
    for (const [err, code] of cases) {
      const app = await appWithDebug(async () => {
        throw err;
      });
      const res = await app.inject(post({ path: 'x' }));
      expect(res.statusCode).toBe(code);
      expect(res.json()).toHaveProperty('error');
      await app.close();
    }
  });

  it('returns the free-form debug result on success', async () => {
    const result: DebugResult = {
      config: {
        whisperBackend: 'fake',
        whisperModel: 'm',
        ollamaModel: 'm',
        seconds: 60,
        offsetSeconds: 0,
        tailSampling: true,
        returnTimestamps: false,
        forceFresh: true,
        modelOverridden: false,
      },
      runs: [],
    };
    const app = await appWithDebug(async () => result);
    const res = await app.inject(post({ path: 'Book/a.m4b' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().config.whisperBackend).toBe('fake');
    await app.close();
  });

  it('400s a body with no path (zod body validation still applies)', async () => {
    const app = await appWithDebug(async () => {
      throw new Error('should not reach the handler');
    });
    const res = await app.inject(post({ runs: 2 })); // path missing
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
    await app.close();
  });
});
