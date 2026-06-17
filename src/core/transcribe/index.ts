import type { TranscribeProvider } from './provider.js';
import { createOpenAiCompatProvider } from './openai-compat.js';
import { createWhisperCppProvider } from './whispercpp.js';
import { Semaphore } from '../semaphore.js';

export type WhisperBackend = 'transformersjs' | 'openai-compat' | 'whispercpp';

/** A concurrency-limited provider whose underlying backend can be hot-swapped at runtime
 *  (the Settings page changes Whisper backend/host without a restart). */
export interface SwappableTranscribeProvider extends TranscribeProvider {
  /** Replace the inner provider. The shared semaphore (and thus the concurrency cap) is
   *  preserved across the swap; in-flight transcribes finish on the old provider. */
  setProvider(provider: TranscribeProvider): void;
}

/**
 * Wrap a provider so at most `limit` transcribes run at once, process-wide. Book
 * concurrency stays parallel for tag-read/extract; only the heavy STT step is
 * gated. One shared instance enforces the cap across every concurrent book.
 *
 * `name` is a GETTER reading the current provider's name — the transcript cache key
 * includes it, so swapping to a different BACKEND busts the cache (correct: different
 * engine → different transcript), while a host-only swap (same backend name) reuses it.
 */
export function withTranscribeLimit(provider: TranscribeProvider, limit: number): SwappableTranscribeProvider {
  const sem = new Semaphore(Math.max(1, limit));
  let current = provider;
  // Run a SPECIFIC provider through the shared semaphore (used by both transcribe + snapshot).
  const runWith = async (p: TranscribeProvider, track: string, opts: Parameters<TranscribeProvider['transcribe']>[1]) => {
    const release = await sem.acquire();
    try {
      return await p.transcribe(track, opts);
    } finally {
      release();
    }
  };
  return {
    get name() {
      return current.name;
    },
    setProvider(next: TranscribeProvider) {
      current = next;
    },
    transcribe(track, opts) {
      return runWith(current, track, opts);
    },
    // Capture `current` NOW; the returned pair stays bound to it even if a later setProvider
    // swaps the backend — so a caller's cache key (name) and call (transcribe) can't diverge.
    snapshot() {
      const p = current;
      return { name: p.name, transcribe: (track, opts) => runWith(p, track, opts) };
    },
  };
}

// Async because the transformers.js adapter (which statically pulls the heavy
// @huggingface/transformers package) is imported lazily — only the selected
// backend's code loads, so an openai-compat/whispercpp boot stays light.
export async function createTranscribeProvider(cfg: { backend: WhisperBackend; host: string }): Promise<TranscribeProvider> {
  switch (cfg.backend) {
    case 'transformersjs': {
      const { createTransformersJsProvider } = await import('./transformersjs.js');
      return createTransformersJsProvider();
    }
    case 'whispercpp':
      return createWhisperCppProvider(cfg.host);
    case 'openai-compat':
      return createOpenAiCompatProvider(cfg.host);
  }
}

export type { TranscribeProvider, TranscribeOptions } from './provider.js';
