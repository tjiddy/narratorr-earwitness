// Pinned contract every Whisper backend adapts to. whisper.cpp-server (/inference)
// and OpenAI-compatible servers (/v1/audio/transcriptions) have different APIs, so
// each backend is an adapter behind this interface; the app only knows this shape.
export interface TranscribeOptions {
  ffmpegPath: string;
  offsetSeconds: number;
  seconds: number;
  model: string;
  signal?: AbortSignal | undefined;
  /** transformers.js only: emit token timestamps so chunked (>30s) audio stitches its
   *  overlapping windows reliably. Other backends ignore it. Default false. */
  returnTimestamps?: boolean | undefined;
}

export interface TranscribeProvider {
  readonly name: string;
  transcribe(track: string, opts: TranscribeOptions): Promise<string>;
  /** Optional ATOMIC snapshot of the current backend (the swappable holder implements it).
   *  Returns the backend name + a transcribe bound to THAT exact provider, still gated by
   *  the shared concurrency limit. A unit of work takes ONE snapshot and uses it for both the
   *  cache key (which embeds `name`) and the call, so the key can never drift from the
   *  provider that actually ran even if the backend is hot-swapped mid-run. Plain providers
   *  omit it (they don't swap); callers fall back to the provider itself. */
  snapshot?(): Pick<TranscribeProvider, 'name' | 'transcribe'>;
}
