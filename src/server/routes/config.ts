import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { configResponseSchema } from '@shared/schemas.js';
import { ffmpegOk } from '@core/ffmpeg.js';
import { config } from '../config.js';
import { isTrustedRequest } from '../auth.js';

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function registerConfigRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/config',
    { schema: { response: { 200: configResponseSchema } } },
    async (req) => {
      const [ollamaReachable, whisperReachable, ff] = await Promise.all([
        reachable(`${config.ollama.host}/api/version`),
        // transformers.js runs in-process — no service to reach.
        config.whisper.backend === 'transformersjs'
          ? Promise.resolve(true)
          : reachable(`${config.whisper.host}/health`),
        ffmpegOk(config.ffmpegPath),
      ]);
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
