import type { ConfigResponse } from '@shared/schemas.js';

// Single source of truth for "is this dependency live and, if not, what do I do
// about it" — shared by the readiness banner and the scan gate so they never drift.
export interface DepStatus {
  label: string;
  ok: boolean;
  remediation: string;
}

export function depStatuses(cfg: ConfigResponse): DepStatus[] {
  return [
    {
      label: 'ffmpeg',
      ok: cfg.ffmpeg.ok,
      remediation: 'Install ffmpeg and put it on your PATH (or set FFMPEG_PATH).',
    },
    {
      label: `ollama · ${cfg.ollama.model}`,
      ok: cfg.ollama.reachable,
      remediation: `Start Ollama, then pull the model: ollama pull ${cfg.ollama.model}`,
    },
    {
      label: `whisper · ${cfg.whisper.backend}`,
      ok: cfg.whisper.reachable,
      remediation:
        cfg.whisper.backend === 'transformersjs'
          ? 'The in-process model failed to load — check the server logs.'
          : 'Start the Whisper service at its configured host (or set WHISPER_BACKEND=transformersjs for a CPU fallback).',
    },
  ];
}

export const allReady = (cfg: ConfigResponse): boolean => depStatuses(cfg).every((d) => d.ok);
