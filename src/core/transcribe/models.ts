// Pure model-name mapping for the in-process transformers.js backend. Kept SEPARATE from
// transformersjs.ts (which statically imports the heavy @huggingface/transformers package)
// so other modules — e.g. the debug model-override allow-list in the attribution service —
// can read the known model names WITHOUT pulling that package into a non-transformersjs boot
// (the transcribe factory lazy-imports transformersjs.ts for exactly this reason).

export const MODEL_MAP: Record<string, string> = {
  'large-v3-turbo': 'onnx-community/whisper-large-v3-turbo',
  'large-v3': 'onnx-community/whisper-large-v3',
  small: 'Xenova/whisper-small',
  'small.en': 'Xenova/whisper-small.en',
  base: 'Xenova/whisper-base',
  'base.en': 'Xenova/whisper-base.en',
  'tiny.en': 'Xenova/whisper-tiny.en',
};

// The safe, known model identifiers. Request-supplied overrides (the debug console) are
// allow-listed against these at the service boundary so an arbitrary HF repo id can never
// be loaded from request input — see AttributionService.validateDebugModels.
export const TRANSFORMERS_MODEL_ALIASES: readonly string[] = Object.keys(MODEL_MAP);

export function resolveModel(model: string): string {
  // Defense-in-depth: never resolve a traversal/URL-looking id to a loadable model
  // (request overrides are already allow-listed upstream; this guards the config path too).
  if (model.includes('..') || model.includes('://')) return 'Xenova/whisper-base.en';
  if (model.includes('/')) return model; // an explicit HF repo id (operator-configured only)
  return MODEL_MAP[model] ?? 'Xenova/whisper-base.en';
}
