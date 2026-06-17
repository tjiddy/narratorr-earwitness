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
}
