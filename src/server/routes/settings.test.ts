import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { loadOverlay } from '../runtime-config.js';
import type { SwappableTranscribeProvider } from '@core/transcribe/index.js';
import type { ScanJobService } from '../services/scan-job.service.js';
import type { AttributionService } from '../services/attribution.service.js';

// GET/POST /api/settings + rotate-key. Inject defaults to a loopback peer, so the /api gate
// trusts the request and trusted fields (hosts + key) are returned. POST persists the
// overlay, applies it live, and hot-swaps the Whisper provider only when backend/host changed.

const fakeScans = () =>
  ({ start: () => 'x', progress: () => null, results: async () => null, cancel: () => false }) as unknown as ScanJobService;
const fakeAttribution = () => ({ attribute: async () => ({ detection: {} }) }) as unknown as AttributionService;

let tmp: string;
let setProvider: ReturnType<typeof vi.fn>;
const saved = {} as { apiKey: string | null; apiKeyFile: string; configFile: string; ollama: typeof config.ollama; whisper: typeof config.whisper };

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ew-set-'));
  saved.apiKey = config.apiKey;
  saved.apiKeyFile = config.apiKeyFile;
  saved.configFile = config.configFile;
  saved.ollama = config.ollama;
  saved.whisper = config.whisper;
});
afterAll(async () => {
  Object.assign(config, saved);
  await fs.rm(tmp, { recursive: true, force: true });
});

let counter = 0;
beforeEach(() => {
  config.apiKey = 'test-key-abcdef';
  config.apiKeyFile = path.join(tmp, `api-key-${counter}`);
  config.configFile = path.join(tmp, `config-${counter++}.json`);
  // Unused-port hosts so readiness probes fail fast (reachable=false) without hanging.
  config.ollama = { host: 'http://127.0.0.1:9', model: 'om' };
  config.whisper = { host: 'http://127.0.0.1:9', backend: 'openai-compat', model: 'wm' };
  setProvider = vi.fn();
});

const build = () => {
  const transcribe = { name: 'openai-compat', transcribe: async () => '', setProvider } as unknown as SwappableTranscribeProvider;
  return buildApp({ scans: fakeScans(), attribution: fakeAttribution(), transcribe, serveStatic: false });
};

describe('GET /api/settings', () => {
  it('returns the effective config + key for a trusted (loopback) caller', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.apiKey).toBe('test-key-abcdef');
    expect(body.ollama).toMatchObject({ host: 'http://127.0.0.1:9', model: 'om', reachable: false });
    expect(body.whisper).toMatchObject({ backend: 'openai-compat', model: 'wm' });
    expect(typeof body.ffmpeg.ok).toBe('boolean');
    await app.close();
  });
});

describe('POST /api/settings', () => {
  it('persists + applies an ollama model change live, without a provider swap', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/settings', payload: { ollama: { model: 'new-model' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ollama.model).toBe('new-model');
    expect(config.ollama.model).toBe('new-model'); // applied in place
    expect(await loadOverlay(config.configFile)).toMatchObject({ ollama: { model: 'new-model' } }); // persisted
    expect(setProvider).not.toHaveBeenCalled(); // backend/host unchanged → no rebuild
    await app.close();
  });

  it('hot-swaps the transcribe provider when the whisper backend changes', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/settings', payload: { whisper: { backend: 'whispercpp' } } });
    expect(res.statusCode).toBe(200);
    expect(config.whisper.backend).toBe('whispercpp');
    expect(setProvider).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('400s an unknown (non-editable) field — strict overlay', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/settings', payload: { libraryRoot: '/etc' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /api/settings/rotate-key', () => {
  it('mints a new key, swaps it into config, and persists it', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/settings/rotate-key' });
    expect(res.statusCode).toBe(200);
    const { apiKey } = res.json();
    expect(apiKey).toMatch(/^[0-9a-f]{48}$/); // 24 random bytes hex
    expect(config.apiKey).toBe(apiKey); // live swap — old key now invalid
    expect((await fs.readFile(config.apiKeyFile, 'utf8')).trim()).toBe(apiKey); // persisted
    await app.close();
  });
});
