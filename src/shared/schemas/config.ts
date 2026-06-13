import { z } from 'zod';

// Readiness payload for the UI banner — reports whether each dependency is live.
export const configResponseSchema = z.object({
  mode: z.enum(['standalone', 'narratorr']),
  browseRoots: z.array(z.string()),
  introSeconds: z.number(),
  ollama: z.object({ host: z.string(), model: z.string(), reachable: z.boolean() }),
  whisper: z.object({
    host: z.string(),
    backend: z.string(),
    model: z.string(),
    reachable: z.boolean(),
  }),
  ffmpeg: z.object({ path: z.string().nullable(), ok: z.boolean() }),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;
