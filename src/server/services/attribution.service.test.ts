import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AttributionService,
  AttributionCapacityError,
  DebugBusyError,
  InvalidModelError,
  LibraryRootError,
  PathForbiddenError,
  PathNotFoundError,
  ProcessingError,
  UnprocessableContentError,
  type AttributionServiceDeps,
} from './attribution.service.js';
import { AudioDecodeError } from '@core/audio.js';
import type { Cache } from '@core/cache.js';

// These tests exercise the guard rails BEFORE processBook (path safety, ambiguity,
// capacity, misconfig) — none reach transcription, so the heavy deps are inert stubs.

function memCache(): Cache {
  const m = new Map<string, unknown>();
  return {
    get: async (ns: string, key: string) => (m.has(`${ns}:${key}`) ? m.get(`${ns}:${key}`) : null),
    set: async (ns: string, key: string, v: unknown) => void m.set(`${ns}:${key}`, v),
  } as unknown as Cache;
}

function makeDeps(over: Partial<AttributionServiceDeps>): AttributionServiceDeps {
  return {
    transcribe: { name: 'stub', transcribe: async () => '' },
    cache: memCache(),
    ffmpegPath: 'ffmpeg',
    offsetSeconds: 0,
    seconds: 60,
    whisper: { model: 'm' },
    ollama: { host: 'http://ollama.test', model: 'm' },
    libraryRoot: '/nonexistent',
    maxActive: 4,
    ...over,
  };
}

describe('AttributionService guard rails', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ew-attr-')));
    // Two .m4b containers in one folder → two distinct books → ambiguous.
    await fs.writeFile(path.join(root, 'a.m4b'), '');
    await fs.writeFile(path.join(root, 'b.m4b'), '');
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a traversal escape with PathForbiddenError (→403)', async () => {
    const svc = new AttributionService(makeDeps({ libraryRoot: root }));
    await expect(svc.attribute({ path: path.join('..', '..') })).rejects.toBeInstanceOf(PathForbiddenError);
  });

  it('rejects an absolute path with PathForbiddenError (→403)', async () => {
    const svc = new AttributionService(makeDeps({ libraryRoot: root }));
    await expect(svc.attribute({ path: path.resolve(root, 'a.m4b') })).rejects.toBeInstanceOf(PathForbiddenError);
  });

  it('returns PathNotFoundError for a missing path (→404)', async () => {
    const svc = new AttributionService(makeDeps({ libraryRoot: root }));
    await expect(svc.attribute({ path: 'does-not-exist.m4b' })).rejects.toBeInstanceOf(PathNotFoundError);
  });

  it('resolves a folder of multiple files as ONE book — no false 422 (contract: one path = one book)', async () => {
    // The folder holds a.m4b + b.m4b; the OLD discover() path counted these as 2 books
    // and 422'd. resolveBookAt treats them as one book's tracks. Stub transcribe returns
    // empty → no speech → attributionPresent:false, but crucially it does NOT throw.
    const svc = new AttributionService(makeDeps({ libraryRoot: root }));
    const res = await svc.attribute({ path: '.' });
    expect(res.detection.attributionPresent).toBe(false);
  });

  it('sheds load with AttributionCapacityError when at capacity (→503)', async () => {
    const svc = new AttributionService(makeDeps({ libraryRoot: root, maxActive: 0 }));
    await expect(svc.attribute({ path: 'a.m4b' })).rejects.toBeInstanceOf(AttributionCapacityError);
  });

  // maxActive:0 above only proves the threshold check fires (before the counter moves).
  // This proves the full cycle: a slot is TAKEN on entry and RELEASED in finally — so a
  // leaked/undecremented slot (the classic wedge-at-capacity bug) would fail here.
  it('takes a slot on entry and releases it on completion (counter cycle)', async () => {
    const svc = new AttributionService(
      makeDeps({ libraryRoot: root, maxActive: 1, transcribe: { name: 'stub', transcribe: async () => '' } }),
    );
    const inflight = svc.attribute({ path: 'a.m4b' }); // takes the only slot (active → 1 before first await)
    await expect(svc.attribute({ path: 'a.m4b' })).rejects.toBeInstanceOf(AttributionCapacityError); // shed while busy
    await inflight; // first completes → finally releases the slot
    const res = await svc.attribute({ path: 'a.m4b' }); // slot reusable → proves the decrement ran
    expect(res.detection.attributionPresent).toBe(false);
  });

  it('returns LibraryRootError when the library root is not mounted (→503)', async () => {
    const svc = new AttributionService(makeDeps({ libraryRoot: path.join(root, 'not-mounted') }));
    await expect(svc.attribute({ path: 'a.m4b' })).rejects.toBeInstanceOf(LibraryRootError);
  });

  // These reach processBook with a single-file path; the stubbed transcribe decides
  // whether the failure is permanent (undecodable) or transient.
  it('maps an undecodable file to UnprocessableContentError (→422, permanent)', async () => {
    const svc = new AttributionService(
      makeDeps({
        libraryRoot: root,
        transcribe: {
          name: 'stub',
          transcribe: async () => {
            throw new AudioDecodeError('ffmpeg failed (1): moov atom not found');
          },
        },
      }),
    );
    await expect(svc.attribute({ path: 'a.m4b' })).rejects.toBeInstanceOf(UnprocessableContentError);
  });

  it('maps a transient transcribe failure to ProcessingError (→503)', async () => {
    const svc = new AttributionService(
      makeDeps({
        libraryRoot: root,
        transcribe: {
          name: 'stub',
          transcribe: async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
          },
        },
      }),
    );
    await expect(svc.attribute({ path: 'a.m4b' })).rejects.toBeInstanceOf(ProcessingError);
  });
});

describe('AttributionService.debugAttribute', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ew-dbg-')));
    await fs.writeFile(path.join(root, 'a.m4b'), '');
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  const transcript = 'Recorded Books presents Virgin River by Robyn Carr, narrated by Therese Plumb.';
  // One Ollama stub for BOTH calls: extraction (transcript → fields) and comparison
  // (detected vs expected → identity verdict), told apart by the comparison system prompt.
  function mockOllama(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        const isCompare = body.includes('compare two attributions');
        const content = isCompare
          ? JSON.stringify({
              title: { same: true, reason: 'same work' },
              authors: { matches: [], reason: '' },
              narrators: { matches: [], reason: '' },
            })
          : JSON.stringify({
              attributionPresent: true,
              title: 'Virgin River',
              author: 'Robyn Carr',
              narrator: 'Therese Plumb',
              publisher: null,
              confidence: 0.9,
              evidence: { title: 'Virgin River', author: 'Robyn Carr', narrator: 'Therese Plumb' },
            });
        return new Response(JSON.stringify({ message: { content } }), { status: 200 });
      }),
    );
  }
  const stubTranscribe = { name: 'stub', transcribe: async () => transcript };

  it('runs N times, bypasses cache by default, and populates the trace', async () => {
    mockOllama();
    const svc = new AttributionService(makeDeps({ libraryRoot: root, transcribe: stubTranscribe }));
    const res = await svc.debugAttribute({ path: 'a.m4b', runs: 2, expected: { title: 'Virgin River' } });

    expect(res.runs).toHaveLength(2);
    expect(res.config.forceFresh).toBe(true);
    const r0 = res.runs[0]!;
    expect(r0.detection.detected.title).toBe('Virgin River');
    expect(r0.trace.windows[0]!.cache).toBe('bypass'); // forceFresh default → no cache read
    expect(r0.trace.windows[0]!.transcript).toContain('Virgin River'); // FULL transcript, not excerpt
    expect(r0.trace.windows[0]!.rawExtraction?.narrator).toBe('Therese Plumb');
    expect(r0.comparison?.fields.title.status).toBe('match');
  });

  it('flags a model override (which evicts the production model)', async () => {
    mockOllama();
    const svc = new AttributionService(makeDeps({ libraryRoot: root, whisper: { model: 'base.en' }, transcribe: stubTranscribe }));
    const res = await svc.debugAttribute({ path: 'a.m4b', whisperModel: 'small.en' });
    expect(res.config.whisperModel).toBe('small.en');
    expect(res.config.modelOverridden).toBe(true);
  });

  it('uses the cache when forceFresh is explicitly false', async () => {
    mockOllama();
    const svc = new AttributionService(makeDeps({ libraryRoot: root, transcribe: stubTranscribe }));
    const res = await svc.debugAttribute({ path: 'a.m4b', forceFresh: false });
    expect(res.config.forceFresh).toBe(false);
    expect(res.runs[0]!.trace.windows[0]!.cache).not.toBe('bypass'); // miss (then it would cache)
  });

  it('sheds a concurrent debug run with DebugBusyError (single-slot, never starves prod)', async () => {
    mockOllama();
    const svc = new AttributionService(makeDeps({ libraryRoot: root, transcribe: stubTranscribe }));
    const inflight = svc.debugAttribute({ path: 'a.m4b' }); // takes the single debug slot
    await expect(svc.debugAttribute({ path: 'a.m4b' })).rejects.toBeInstanceOf(DebugBusyError);
    await inflight; // finishes → slot released
    const again = await svc.debugAttribute({ path: 'a.m4b' }); // reusable
    expect(again.runs).toHaveLength(1);
  });

  it('rejects an arbitrary HF-style whisperModel override on the transformersjs backend (no remote model load)', async () => {
    mockOllama();
    const svc = new AttributionService(
      makeDeps({ libraryRoot: root, whisper: { model: 'base.en' }, transcribe: { name: 'transformersjs', transcribe: async () => transcript } }),
    );
    await expect(
      svc.debugAttribute({ path: 'a.m4b', whisperModel: 'evil/backdoor-model' }),
    ).rejects.toBeInstanceOf(InvalidModelError);
  });

  it('allows a known alias override on the transformersjs backend', async () => {
    mockOllama();
    const svc = new AttributionService(
      makeDeps({ libraryRoot: root, whisper: { model: 'base.en' }, transcribe: { name: 'transformersjs', transcribe: async () => transcript } }),
    );
    const res = await svc.debugAttribute({ path: 'a.m4b', whisperModel: 'small.en' });
    expect(res.config.whisperModel).toBe('small.en');
  });

  it('rejects a traversal/URL-shaped ollamaModel override', async () => {
    mockOllama();
    const svc = new AttributionService(makeDeps({ libraryRoot: root, transcribe: stubTranscribe }));
    await expect(
      svc.debugAttribute({ path: 'a.m4b', ollamaModel: 'http://evil/../x' }),
    ).rejects.toBeInstanceOf(InvalidModelError);
  });
});
