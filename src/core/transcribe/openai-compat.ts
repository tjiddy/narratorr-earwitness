import { cutWav } from '../audio.js';
import type { TranscribeProvider } from './provider.js';

// Adapter for OpenAI-compatible STT servers (faster-whisper-server / speaches).
// This is the production/GPU path: POST /v1/audio/transcriptions with the wav file.
export function createOpenAiCompatProvider(host: string): TranscribeProvider {
  return {
    name: 'openai-compat',
    async transcribe(track, opts) {
      const wav = await cutWav(track, opts);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'intro.wav');
      form.append('model', opts.model);
      form.append('response_format', 'json');
      const res = await fetch(`${host}/v1/audio/transcriptions`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`whisper service ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { text?: string };
      return (data.text ?? '').trim();
    },
  };
}
