import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configOverlaySchema, type ConfigOverlay } from '@shared/schemas.js';
import type { AppConfig } from './config.js';

// Runtime config overlay: env vars are the DEFAULTS, `<dataDir>/config.json` is the
// operator's overlay (written by the Settings page). Only ollama.host/.model and
// whisper.backend/.host/.model are overlay-editable — everything else stays env-only, so
// the overlay can't escalate into paths, ports, cache dirs, or the library root.
//
// Overlays are applied by MUTATING config sub-objects IN PLACE (never reassigning
// config.ollama = {...}), because ProcessDeps holds references to those very objects —
// an in-place edit is what makes a Settings change take effect live, without a restart.

/** Read + validate the overlay file. Missing/invalid/garbage → `{}` (env defaults win). */
export async function loadOverlay(file: string): Promise<ConfigOverlay> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = configOverlaySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {}; // ENOENT / unreadable / invalid JSON → no overlay
  }
}

/** Apply the overlay onto `config` in place (only the allow-listed fields). */
export function applyOverlay(config: AppConfig, overlay: ConfigOverlay): void {
  if (overlay.ollama?.host) config.ollama.host = overlay.ollama.host;
  if (overlay.ollama?.model) config.ollama.model = overlay.ollama.model;
  if (overlay.whisper?.backend) config.whisper.backend = overlay.whisper.backend;
  if (overlay.whisper?.host) config.whisper.host = overlay.whisper.host;
  if (overlay.whisper?.model) config.whisper.model = overlay.whisper.model;
}

/** Persist the overlay 0600 (mirrors api-key.ts). chmod is best-effort (no-op on win32). */
export async function saveOverlay(file: string, overlay: ConfigOverlay): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
}

/** Merge a partial edit onto an existing overlay (sub-object shallow merge), so a save
 *  that only changes ollama doesn't drop a previously-persisted whisper override. */
export function mergeOverlay(base: ConfigOverlay, patch: ConfigOverlay): ConfigOverlay {
  return {
    ollama: { ...base.ollama, ...patch.ollama },
    whisper: { ...base.whisper, ...patch.whisper },
  };
}
