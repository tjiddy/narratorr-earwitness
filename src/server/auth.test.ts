import { describe, it, expect, afterEach } from 'vitest';
import { buildApp } from './app.js';
import { config } from './config.js';
import type { ScanJobService } from './services/scan-job.service.js';
import type { AttributionService } from './services/attribution.service.js';

// The network auth gate (auth.ts) is the only thing between the LAN and /api/*. It's a
// no-op when config.apiKey is null (which is why the rest of the suite, building the app
// without a key, never exercises it) — so these tests set a key first, then drive the gate
// through buildApp + inject. A non-loopback remoteAddress is used so the loopback bypass
// doesn't mask the key check. The empty-key case is the regression from commit 293925a.

const KEY = 'test-api-key-deadbeefdeadbeefdeadbeef';
const REMOTE = '203.0.113.7'; // documentation range — never loopback

const fakeScans = () =>
  ({ start: () => 'x', progress: () => null, results: async () => null, cancel: () => false }) as unknown as ScanJobService;
const fakeAttribution = () => ({ attribute: async () => ({ detection: {} }) }) as unknown as AttributionService;
const fakeTranscribe = () => ({ name: 'fake', transcribe: async () => '', setProvider() {} });
const build = () => buildApp({ scans: fakeScans(), attribution: fakeAttribution(), transcribe: fakeTranscribe(), serveStatic: false });

afterEach(() => {
  config.apiKey = null; // reset the singleton so it doesn't leak into other suites
});

describe('registerAuth — /api/* network gate', () => {
  it('401s a network request with no credentials when a key is configured', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: REMOTE });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    await app.close();
  });

  it('accepts a correct X-Api-Key from the network', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      remoteAddress: REMOTE,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('accepts a correct Authorization: Bearer key from the network', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      remoteAddress: REMOTE,
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('401s a wrong key', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      remoteAddress: REMOTE,
      headers: { 'x-api-key': 'not-the-key' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('does NOT accept an empty X-Api-Key when a key is set (empty-key-lockout regression)', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      remoteAddress: REMOTE,
      headers: { 'x-api-key': '' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('trusts a loopback request without any key', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('treats an IPv4-mapped IPv6 loopback as loopback', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '::ffff:127.0.0.1' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // CSRF guard: an unknown-id cancel reaches the handler as 404 (fakeScans.cancel → false),
  // so a 403 here can only come from the cross-origin guard, not the route itself.
  it('403s a forged cross-origin write even from loopback (CSRF guard)', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/scans/xyz/cancel',
      remoteAddress: '127.0.0.1', // loopback → trusted, but the Origin is foreign
      headers: { origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows a same-origin write (Origin host matches Host) → reaches the handler', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/scans/xyz/cancel',
      remoteAddress: '127.0.0.1',
      headers: { origin: 'http://localhost', host: 'localhost' },
    });
    expect(res.statusCode).toBe(404); // guard passed; handler says scan not found
    await app.close();
  });

  it('allows a write with no Origin header (machine client like narratorr)', async () => {
    config.apiKey = KEY;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/scans/xyz/cancel',
      remoteAddress: '203.0.113.7',
      headers: { 'x-api-key': KEY }, // no Origin — server-to-server
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('leaves /api/* open when no key is configured (blank key file → null → gate not installed)', async () => {
    config.apiKey = null;
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: REMOTE });
    expect(res.statusCode).toBe(200); // registerAuth no-ops; security then relies on network isolation
    await app.close();
  });
});
