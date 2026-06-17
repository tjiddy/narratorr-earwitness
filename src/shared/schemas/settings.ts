import { z } from 'zod';

// Runtime-config (Settings page) shapes, shared by the server (runtime-config.ts +
// routes/settings.ts) and the client (api.ts + SettingsPage). env supplies defaults; the
// overlay persisted to <dataDir>/config.json holds the operator's edits. Only these
// fields are editable — paths/ports/roots stay env-only (no privilege-escalation surface).

export const whisperBackendSchema = z.enum(['transformersjs', 'openai-compat', 'whispercpp']);
export type WhisperBackendName = z.infer<typeof whisperBackendSchema>;

// The overlay = the POST /api/settings body. strictObject so an unknown key is a 400, not
// a silently-ignored field — the editable surface is exactly this and nothing more.
export const configOverlaySchema = z.strictObject({
  ollama: z
    .strictObject({
      host: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
    })
    .optional(),
  whisper: z
    .strictObject({
      backend: whisperBackendSchema.optional(),
      host: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
    })
    .optional(),
});
export type ConfigOverlay = z.infer<typeof configOverlaySchema>;

// GET/POST /api/settings response: the EFFECTIVE config (env + overlay) plus live
// readiness + the API key. Hosts/paths/key are nulled for untrusted callers (mirrors
// /api/config) — though the /api/* gate already keeps untrusted callers out when a key is set.
export const settingsResponseSchema = z.object({
  apiKey: z.string().nullable(),
  ollama: z.object({ host: z.string().nullable(), model: z.string(), reachable: z.boolean() }),
  whisper: z.object({
    host: z.string().nullable(),
    backend: z.string(),
    model: z.string(),
    reachable: z.boolean(),
  }),
  ffmpeg: z.object({ path: z.string().nullable(), ok: z.boolean() }),
  libraryRoot: z.string().nullable(),
});
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

export const rotateKeyResponseSchema = z.object({ apiKey: z.string() });
export type RotateKeyResponse = z.infer<typeof rotateKeyResponseSchema>;
