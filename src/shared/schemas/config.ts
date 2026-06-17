import { z } from 'zod';

// Readiness payload for the UI banner — reports whether each dependency is live.
// Absolute paths + internal hostnames (browseRoots, hosts, ffmpeg path) are only
// populated for trusted callers (loopback or API-key authed); untrusted callers
// get [] / null there but still see model names + reachability booleans.
export const configResponseSchema = z.object({
  mode: z.enum(['standalone', 'narratorr']),
  browseRoots: z.array(z.string()),
  introSeconds: z.number(),
  ollama: z.object({ host: z.string().nullable(), model: z.string(), reachable: z.boolean() }),
  whisper: z.object({
    host: z.string().nullable(),
    backend: z.string(),
    model: z.string(),
    reachable: z.boolean(),
  }),
  ffmpeg: z.object({ path: z.string().nullable(), ok: z.boolean() }),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

// Liveness + identity probe for narratorr's "Test Connection" (#1526). Gated by the
// same /api/* auth as everything else, so a 200 also confirms the caller's API key is
// valid — wrong key → 401, unreachable → network error. `ok` is always true on 200.
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(['standalone', 'narratorr']),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
