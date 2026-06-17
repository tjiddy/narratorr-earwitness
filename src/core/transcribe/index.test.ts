import { describe, it, expect } from 'vitest';
import { withTranscribeLimit } from './index.js';
import type { TranscribeProvider, TranscribeOptions } from './provider.js';

// The swappable transcribe holder backs the Settings "change Whisper backend" action: its
// `name` is a getter (so the transcript cache key busts on a backend change but not a
// host-only change), setProvider swaps the inner backend, and the concurrency cap (one
// semaphore) survives the swap.

const opts = {} as TranscribeOptions;
const slot = (name: string, fn?: TranscribeProvider['transcribe']): TranscribeProvider => ({
  name,
  transcribe: fn ?? (async () => name),
});

describe('withTranscribeLimit (swappable holder)', () => {
  it('name is a getter reflecting the current provider', () => {
    const h = withTranscribeLimit(slot('openai-compat'), 1);
    expect(h.name).toBe('openai-compat');
    h.setProvider(slot('whispercpp'));
    expect(h.name).toBe('whispercpp');
  });

  it('delegates transcribe to the current provider', async () => {
    const h = withTranscribeLimit(slot('a'), 1);
    expect(await h.transcribe('t', opts)).toBe('a');
    h.setProvider(slot('b'));
    expect(await h.transcribe('t', opts)).toBe('b');
  });

  it('snapshot() stays bound to the captured backend even after a swap (cache-key safety)', async () => {
    const h = withTranscribeLimit(slot('openai-compat'), 1);
    const snap = h.snapshot!();
    expect(snap.name).toBe('openai-compat');
    h.setProvider(slot('whispercpp')); // swap AFTER snapshotting
    expect(snap.name).toBe('openai-compat'); // snapshot's name is frozen
    expect(await snap.transcribe('t', opts)).toBe('openai-compat'); // and it still calls the captured provider
    expect(h.name).toBe('whispercpp'); // the holder itself moved on
  });

  it('preserves the concurrency cap (one slot) across a swap', async () => {
    let active = 0;
    let max = 0;
    const slow = (name: string): TranscribeProvider =>
      slot(name, async () => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
        return name;
      });
    const h = withTranscribeLimit(slow('a'), 1);
    const first = Promise.all([h.transcribe('t', opts), h.transcribe('t', opts)]);
    h.setProvider(slow('b')); // swap while transcribes are queued on the shared semaphore
    await Promise.all([first, h.transcribe('t', opts), h.transcribe('t', opts)]);
    expect(max).toBe(1);
  });
});
