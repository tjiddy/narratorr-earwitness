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
