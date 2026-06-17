import { describe, it, expect } from 'vitest';
import { buildApp } from '../app.js';
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

// POST /api/debug/attribution is ALWAYS registered (v0.8.0 dropped the env flag). Here we
// verify the error→status mapping + a success pass-through. The route exposes full
// transcripts, so its safety behaviors (busy-shed 429, traversal 403) must not regress.

const fakeScans = () =>
  ({ start: () => 'x', progress: () => null, results: async () => null, cancel: () => false }) as unknown as ScanJobService;
const fakeTranscribe = () => ({ name: 'fake', transcribe: async () => '', setProvider() {} });

function appWithDebug(debugAttribute: AttributionService['debugAttribute']) {
  const attribution = { attribute: async () => ({ detection: {} }), debugAttribute } as unknown as AttributionService;
  return buildApp({ scans: fakeScans(), attribution, transcribe: fakeTranscribe(), serveStatic: false });
}

const post = (payload: Record<string, unknown>) => ({ method: 'POST' as const, url: '/api/debug/attribution', payload });

describe('POST /api/debug/attribution', () => {
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
