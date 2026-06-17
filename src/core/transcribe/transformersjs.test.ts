import { describe, it, expect, vi, beforeEach } from 'vitest';

// Validates the in-process model cache: load-once-per-model, and evict+DISPOSE the
// previous model's native session on a switch (P1-2). Mock the heavy deps — the HF
// pipeline and ffmpeg decode — so this is a pure cache/eviction test.

type FakePipe = ((...a: unknown[]) => Promise<{ text: string }>) & { model: string; dispose: ReturnType<typeof vi.fn> };
const created: FakePipe[] = [];

function makeFakePipe(model: string): FakePipe {
  const fn = vi.fn(async () => ({ text: 'hello world' })) as unknown as FakePipe;
  fn.model = model;
  fn.dispose = vi.fn();
  return fn;
}

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: vi.fn(async (_task: string, model: string) => {
    const p = makeFakePipe(model);
    created.push(p);
    return p;
  }),
}));
vi.mock('../audio.js', () => ({ decodePcmF32: vi.fn(async () => new Float32Array(16000)) }));

import { createTransformersJsProvider } from './transformersjs.js';
import { pipeline } from '@huggingface/transformers';

const opts = (model: string) => ({ ffmpegPath: 'ffmpeg', offsetSeconds: 0, seconds: 60, model });

beforeEach(() => {
  created.length = 0;
  vi.mocked(pipeline).mockClear();
});

describe('transformersjs provider — model cache + eviction', () => {
  it('loads once per model and reuses the resident pipeline', async () => {
    const p = createTransformersJsProvider();
    await p.transcribe('/x.m4b', opts('base.en'));
    await p.transcribe('/x.m4b', opts('base.en'));
    expect(vi.mocked(pipeline)).toHaveBeenCalledTimes(1); // same model → single load
  });

  it('evicts AND disposes the previous model when switching', async () => {
    const p = createTransformersJsProvider();
    await p.transcribe('/x.m4b', opts('base.en'));
    await p.transcribe('/x.m4b', opts('small.en'));
    expect(vi.mocked(pipeline)).toHaveBeenCalledTimes(2);
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1); // base.en evicted → disposed
    expect(created[1]!.dispose).not.toHaveBeenCalled(); // small.en is current → kept
  });
});
