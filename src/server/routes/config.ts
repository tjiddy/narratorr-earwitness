import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { configResponseSchema } from '@shared/schemas.js';
import { config } from '../config.js';
import { isTrustedRequest } from '../auth.js';
import { probeReadiness } from '../probes.js';

export function registerConfigRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/config',
    { schema: { response: { 200: configResponseSchema } } },
    async (req) => {
      const { ollamaReachable, whisperReachable, ffmpeg: ff } = await probeReadiness();
      // Only trusted callers see absolute paths / internal hostnames.
      const trusted = isTrustedRequest(req);
      return {
        mode: config.mode,
        browseRoots: trusted ? config.browseRoots : [],
        introSeconds: config.introSeconds,
        ollama: {
          host: trusted ? config.ollama.host : null,
          model: config.ollama.model,
          reachable: ollamaReachable,
        },
        whisper: {
          host: trusted ? config.whisper.host : null,
          backend: config.whisper.backend,
          model: config.whisper.model,
          reachable: whisperReachable,
        },
        ffmpeg: { path: trusted ? ff.path : null, ok: ff.ok },
      };
    },
  );
}
