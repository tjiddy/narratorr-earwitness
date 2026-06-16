import { describe, it, expect } from 'vitest';
import { buildApp } from '../app.js';
import type { ScanJobService } from '../services/scan-job.service.js';
import {
  AttributionCapacityError,
  AmbiguousPathError,
  PathForbiddenError,
  PathNotFoundError,
  ProcessingError,
} from '../services/attribution.service.js';
import type { AttributionService, AttributeResult } from '../services/attribution.service.js';

const fakeScans = () =>
  ({ start: () => 'x', progress: () => null, results: async () => null, cancel: () => false }) as unknown as ScanJobService;

function appWith(attribute: AttributionService['attribute']) {
  const attribution = { attribute } as unknown as AttributionService;
  return buildApp({ scans: fakeScans(), attribution, serveStatic: false });
}

const detection: AttributeResult['detection'] = {
  attributionPresent: true,
  detected: { title: 'Dune', authors: ['Frank Herbert'], narrators: ['Scott Brick'] },
  evidence: { title: 'Dune', author: 'Frank Herbert', narrator: 'Scott Brick' },
  confidence: 0.9,
};

const comparison: NonNullable<AttributeResult['comparison']> = {
  status: 'match',
  fields: {
    title: { status: 'match', expected: 'Dune', detected: 'Dune', reason: 'same' },
    authors: {
      status: 'match',
      expected: ['Frank Herbert'],
      detected: ['Frank Herbert'],
      matched: [{ expected: 'Frank Herbert', detected: 'Frank Herbert' }],
      missingExpected: [],
      unexpectedDetected: [],
      reason: 'same',
    },
    narrators: {
      status: 'unknown',
      expected: [],
      detected: ['Scott Brick'],
      matched: [],
      missingExpected: [],
      unexpectedDetected: [],
      reason: 'no expected',
    },
  },
};

const post = (payload: Record<string, unknown>) => ({ method: 'POST' as const, url: '/api/v1/attribution', payload });

describe('POST /api/v1/attribution', () => {
  it('returns detection only when no expected was sent', async () => {
    const app = await appWith(async () => ({ detection }));
    const res = await app.inject(post({ path: 'Dune/book.m4b' }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestId).toBeNull();
    expect(body.detection.detected.title).toBe('Dune');
    expect(body).not.toHaveProperty('comparison');
    await app.close();
  });

  it('echoes requestId and includes comparison when expected was sent', async () => {
    const app = await appWith(async () => ({ detection, comparison }));
    const res = await app.inject(
      post({ path: 'Dune/book.m4b', requestId: 'r1', expected: { title: 'Dune' } }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestId).toBe('r1');
    expect(body.comparison.status).toBe('match');
    await app.close();
  });

  it('400s a request with no path', async () => {
    const app = await appWith(async () => ({ detection }));
    const res = await app.inject(post({ expected: { title: 'x' } }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
    await app.close();
  });

  it('maps service errors to status codes', async () => {
    const cases: Array<[Error, number]> = [
      [new PathForbiddenError('p'), 403],
      [new PathNotFoundError('p'), 404],
      [new AmbiguousPathError(2), 422],
    ];
    for (const [err, code] of cases) {
      const app = await appWith(async () => {
        throw err;
      });
      const res = await app.inject(post({ path: 'x' }));
      expect(res.statusCode).toBe(code);
      expect(res.json()).toHaveProperty('error');
      await app.close();
    }
  });

  it('503s with Retry-After on capacity and processing failures', async () => {
    for (const err of [new AttributionCapacityError(4), new ProcessingError('ollama down')]) {
      const app = await appWith(async () => {
        throw err;
      });
      const res = await app.inject(post({ path: 'x' }));
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('30');
      await app.close();
    }
  });
});
