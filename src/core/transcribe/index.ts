import type { TranscribeProvider } from './provider.js';
import { createTransformersJsProvider } from './transformersjs.js';
import { createOpenAiCompatProvider } from './openai-compat.js';
import { createWhisperCppProvider } from './whispercpp.js';

export type WhisperBackend = 'transformersjs' | 'openai-compat' | 'whispercpp';

export function createTranscribeProvider(cfg: { backend: WhisperBackend; host: string }): TranscribeProvider {
  switch (cfg.backend) {
    case 'transformersjs':
      return createTransformersJsProvider();
    case 'whispercpp':
      return createWhisperCppProvider(cfg.host);
    case 'openai-compat':
      return createOpenAiCompatProvider(cfg.host);
  }
}

export type { TranscribeProvider, TranscribeOptions } from './provider.js';
