import { ffmpegOk } from '@core/ffmpeg.js';
import { config } from './config.js';

// Dependency reachability probes, shared by GET /api/config and GET /api/settings so the
// readiness logic (and its 2s timeout) lives in one place. Reads config live, so it
// reflects runtime-config edits (Settings page) without a restart.

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ReadinessProbe {
  ollamaReachable: boolean;
  whisperReachable: boolean;
  ffmpeg: { path: string | null; ok: boolean };
}

export async function probeReadiness(): Promise<ReadinessProbe> {
  const [ollamaReachable, whisperReachable, ff] = await Promise.all([
    reachable(`${config.ollama.host}/api/version`),
    // transformers.js runs in-process — no service to reach.
    config.whisper.backend === 'transformersjs'
      ? Promise.resolve(true)
      : reachable(`${config.whisper.host}/health`),
    ffmpegOk(config.ffmpegPath),
  ]);
  return { ollamaReachable, whisperReachable, ffmpeg: ff };
}
