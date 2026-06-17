import { pipeline, env } from '@huggingface/transformers';
import { decodePcmF32 } from '../audio.js';
import { resolveModel } from './models.js';
import type { TranscribeProvider } from './provider.js';

// DEV / CPU-only fallback provider — in-process, no external service. Explicitly
// NOT the production path (that's the external GPU Whisper service via openai-compat).
// Lets us validate the whole pipeline with zero infra.

// transformers.js caches downloaded weights under node_modules by default, which a
// container rebuild/restart discards. Point it at a configurable dir (a mounted
// volume in Docker) so weights persist. Only applied when this backend is selected.
const TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE;
if (TRANSFORMERS_CACHE) env.cacheDir = TRANSFORMERS_CACHE;

export function createTransformersJsProvider(): TranscribeProvider {
  // Cache loaded pipelines BY RESOLVED MODEL so cross-model debug runs actually use the
  // requested model (the old singleton silently reused whichever loaded first). Capped at
  // ONE resident model: this runs in the same memory-constrained, GPU-less container that
  // serves production, and large-v3-turbo (~1.5GB) would OOM if held alongside the prod
  // model. This cache is SHARED with production, so a debug model-override EVICTS the live
  // model (it does not get its own slot — see P1-1 / DOCKER.md). On a switch we DISPOSE the
  // evicted pipeline's native session (delete() alone only drops the JS ref; the off-heap
  // ONNX session would otherwise linger until GC), and model transitions are SERIALIZED via
  // `transition` so two different models can't evict each other mid-load (safe even if
  // MAX_CONCURRENT_TRANSCRIBES is raised above 1).
  const MAX_RESIDENT = 1;
  const loaded = new Map<string, ReturnType<typeof pipeline>>();
  let transition: Promise<unknown> = Promise.resolve();
  return {
    name: 'transformersjs',
    async transcribe(track, opts) {
      const modelId = resolveModel(opts.model);
      let asr = loaded.get(modelId);
      if (!asr) {
        // Serialize behind any in-flight transition, then evict+dispose every OTHER
        // resident model before loading this one (MAX_RESIDENT enforced here).
        asr = transition.then(async () => {
          for (const [id, p] of loaded) {
            if (loaded.size <= MAX_RESIDENT) break; // modelId's own (pending) entry counts
            if (id === modelId) continue;
            loaded.delete(id);
            void Promise.resolve(p)
              .then((m) => (m as { dispose?: () => unknown }).dispose?.())
              .catch(() => {});
          }
          return pipeline('automatic-speech-recognition', modelId);
        });
        // A rejected load must not poison the cache (a rejected promise stays truthy and
        // would re-throw forever): drop our own entry on failure so the next call retries.
        void asr.catch(() => {
          if (loaded.get(modelId) === asr) loaded.delete(modelId);
        });
        transition = asr.then(
          () => undefined,
          () => undefined,
        );
        loaded.set(modelId, asr);
      }
      const audio = await decodePcmF32(track, opts);
      const run = (await asr) as unknown as (
        input: Float32Array,
        gen: Record<string, unknown>,
      ) => Promise<{ text?: string } | Array<{ text?: string }>>;
      // return_timestamps DEFAULTS TRUE: it lets the pipeline stitch the overlapping 30s
      // chunks reliably (we discard the timestamps, keep the text). With it off, a credit
      // line straddling a 30s boundary can be dropped — confirmed on "Virgin River", where
      // small.en lost the outro credit at false but recovered it at true (base.en got lucky
      // either way). The debug console can still force it off to compare.
      const out = await run(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: opts.returnTimestamps ?? true,
      });
      const text = Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : (out.text ?? '');
      return text.trim();
    },
  };
}
