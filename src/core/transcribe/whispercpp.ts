import { cutWav } from '../audio.js';
import type { TranscribeProvider } from './provider.js';

// Adapter for whisper.cpp's bundled HTTP server: POST /inference (multipart),
// returns { text }. Alternative GPU path (ggml CUDA).
export function createWhisperCppProvider(host: string): TranscribeProvider {
  return {
    name: 'whispercpp',
    async transcribe(track, opts) {
      const wav = await cutWav(track, opts);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'intro.wav');
      form.append('temperature', '0');
      form.append('response_format', 'json');
      const res = await fetch(`${host}/inference`, { method: 'POST', body: form, signal: opts.signal ?? null });
      if (!res.ok) throw new Error(`whisper.cpp ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { text?: string };
      return (data.text ?? '').trim();
    },
  };
}
