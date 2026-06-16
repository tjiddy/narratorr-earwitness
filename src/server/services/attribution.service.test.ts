import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AttributionService,
  AttributionCapacityError,
  AmbiguousPathError,
  LibraryRootError,
  PathForbiddenError,
  PathNotFoundError,
  type AttributionServiceDeps,
} from './attribution.service.js';
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
    whisperModel: 'm',
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

  it('returns AmbiguousPathError when a folder holds multiple books (→422)', async () => {
    const svc = new AttributionService(makeDeps({ libraryRoot: root }));
    await expect(svc.attribute({ path: '.' })).rejects.toBeInstanceOf(AmbiguousPathError);
  });

  it('sheds load with AttributionCapacityError when at capacity (→503)', async () => {
    const svc = new AttributionService(makeDeps({ libraryRoot: root, maxActive: 0 }));
    await expect(svc.attribute({ path: 'a.m4b' })).rejects.toBeInstanceOf(AttributionCapacityError);
  });

  it('returns LibraryRootError when the library root is not mounted (→503)', async () => {
    const svc = new AttributionService(makeDeps({ libraryRoot: path.join(root, 'not-mounted') }));
    await expect(svc.attribute({ path: 'a.m4b' })).rejects.toBeInstanceOf(LibraryRootError);
  });
});
