import type { TranscribeProvider } from './provider.js';
import { createOpenAiCompatProvider } from './openai-compat.js';
import { createWhisperCppProvider } from './whispercpp.js';
import { Semaphore } from '../semaphore.js';

export type WhisperBackend = 'transformersjs' | 'openai-compat' | 'whispercpp';

/**
 * Wrap a provider so at most `limit` transcribes run at once, process-wide. Book
 * concurrency stays parallel for tag-read/extract; only the heavy STT step is
 * gated. One shared instance enforces the cap across every concurrent book.
 */
export function withTranscribeLimit(provider: TranscribeProvider, limit: number): TranscribeProvider {
  const sem = new Semaphore(Math.max(1, limit));
  return {
    name: provider.name,
    async transcribe(track, opts) {
      const release = await sem.acquire();
      try {
        return await provider.transcribe(track, opts);
      } finally {
        release();
      }
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
