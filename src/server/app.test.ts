import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from './app.js';
import type { ScanJobService } from './services/scan-job.service.js';
import type { AttributionService } from './services/attribution.service.js';

// Minimal stand-ins — only the methods the routes touch.
function fakeScans(over: Partial<ScanJobService> = {}): ScanJobService {
  return {
    start: () => 'scan-id',
    progress: () => null,
    results: async () => null,
    cancel: () => false,
    ...over,
  } as unknown as ScanJobService;
}

function fakeAttribution(over: Partial<AttributionService> = {}): AttributionService {
  return {
    attribute: async () => ({ detection: {} }),
    debugAttribute: async () => ({ config: {}, runs: [] }),
    ...over,
  } as unknown as AttributionService;
}

// The debug + settings routes need the (swappable) transcribe holder; a stub satisfies it.
const fakeTranscribe = () => ({ name: 'fake', transcribe: async () => '', setProvider() {} });

const base = { scans: fakeScans(), attribution: fakeAttribution(), transcribe: fakeTranscribe() };

describe('buildApp', () => {
  it('returns 404 with the {error} envelope for a missing scan (P2-7)', async () => {
    const app = await buildApp({ ...base, serveStatic: false });
    const res = await app.inject({ method: 'POST', url: '/api/scans/xyz/cancel' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'scan not found' });
    await app.close();
  });

  it('normalizes a validation failure into the {error} envelope (P2-extra)', async () => {
    const app = await buildApp({ ...base, serveStatic: false });
    const res = await app.inject({ method: 'POST', url: '/api/scans', payload: { source: 'local' } }); // root missing
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toHaveProperty('error');
    expect(body).not.toHaveProperty('statusCode'); // not Fastify's default shape
    await app.close();
  });

  it('always exposes POST /api/debug/attribution (v0.8.0 dropped the env flag)', async () => {
    const app = await buildApp({ ...base, serveStatic: false });
    const res = await app.inject({ method: 'POST', url: '/api/debug/attribution', payload: { path: 'x' } });
    expect(res.statusCode).toBe(200); // route is always registered now; the fake returns a debug result
    await app.close();
  });

  describe('prod static serving (P1-1)', () => {
    let clientDir: string;
    beforeAll(async () => {
      clientDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ew-client-'));
      await fs.writeFile(path.join(clientDir, 'index.html'), '<!doctype html><title>Earwitness</title>');
    });
    afterAll(async () => {
      await fs.rm(clientDir, { recursive: true, force: true });
    });

    it('serves index.html for a non-API GET (SPA fallback)', async () => {
      const app = await buildApp({ ...base, serveStatic: true, clientDir });
      const res = await app.inject({ method: 'GET', url: '/some/spa/route' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.body).toMatch(/Earwitness/);
      await app.close();
    });

    it('still 404s unknown API routes as JSON, not HTML', async () => {
      const app = await buildApp({ ...base, serveStatic: true, clientDir });
      const res = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toHaveProperty('error');
      await app.close();
    });
  });
});
