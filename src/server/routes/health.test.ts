import { describe, it, expect } from 'vitest';
import { buildApp } from '../app.js';
import type { ScanJobService } from '../services/scan-job.service.js';
import type { AttributionService } from '../services/attribution.service.js';

const fakeScans = () =>
  ({ start: () => 'x', progress: () => null, results: async () => null, cancel: () => false }) as unknown as ScanJobService;
const fakeAttribution = () => ({ attribute: async () => ({ detection: {} }) }) as unknown as AttributionService;

const appUnderTest = () =>
  buildApp({ scans: fakeScans(), attribution: fakeAttribution(), serveStatic: false });

describe('GET /api/v1/health', () => {
  it('returns ok + mode + version (narratorr Test Connection probe)', async () => {
    const app = await appUnderTest();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(['standalone', 'narratorr']).toContain(body.mode);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    await app.close();
  });
});
