import { pipeline, env } from '@huggingface/transformers';
import { decodePcmF32 } from '../audio.js';
import type { TranscribeProvider } from './provider.js';

// DEV / CPU-only fallback provider — in-process, no external service. Explicitly
// NOT the production path (that's the external GPU Whisper service via openai-compat).
// Lets us validate the whole pipeline with zero infra.

// transformers.js caches downloaded weights under node_modules by default, which a
// container rebuild/restart discards. Point it at a configurable dir (a mounted
// volume in Docker) so weights persist. Only applied when this backend is selected.
const TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE;
if (TRANSFORMERS_CACHE) env.cacheDir = TRANSFORMERS_CACHE;

const MODEL_MAP: Record<string, string> = {
  'large-v3-turbo': 'onnx-community/whisper-large-v3-turbo',
  'large-v3': 'onnx-community/whisper-large-v3',
  small: 'Xenova/whisper-small',
  'small.en': 'Xenova/whisper-small.en',
  base: 'Xenova/whisper-base',
  'base.en': 'Xenova/whisper-base.en',
  'tiny.en': 'Xenova/whisper-tiny.en',
};

function resolveModel(model: string): string {
  if (model.includes('/')) return model;
  return MODEL_MAP[model] ?? 'Xenova/whisper-base.en';
}

export function createTransformersJsProvider(): TranscribeProvider {
  let asr: ReturnType<typeof pipeline> | null = null;
  return {
    name: 'transformersjs',
    async transcribe(track, opts) {
      // Kick off (and memoize) the model load BEFORE the first await, so concurrent
      // transcribes share one load instead of racing to instantiate the pipeline twice.
      asr ??= pipeline('automatic-speech-recognition', resolveModel(opts.model));
      const audio = await decodePcmF32(track, opts);
      const run = (await asr) as unknown as (
        input: Float32Array,
        gen: Record<string, unknown>,
      ) => Promise<{ text?: string } | Array<{ text?: string }>>;
      const out = await run(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false });
      const text = Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : (out.text ?? '');
      return text.trim();
    },
  };
}
