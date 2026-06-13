import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { configResponseSchema } from '@shared/schemas.js';
import { ffmpegOk } from '@core/ffmpeg.js';
import { config } from '../config.js';

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
    async () => {
      const [ollamaReachable, whisperReachable, ff] = await Promise.all([
        reachable(`${config.ollama.host}/api/version`),
        // transformers.js runs in-process — no service to reach.
        config.whisper.backend === 'transformersjs'
          ? Promise.resolve(true)
          : reachable(`${config.whisper.host}/health`),
        ffmpegOk(config.ffmpegPath),
      ]);
      return {
        mode: config.mode,
        browseRoots: config.browseRoots,
        introSeconds: config.introSeconds,
        ollama: { host: config.ollama.host, model: config.ollama.model, reachable: ollamaReachable },
        whisper: {
          host: config.whisper.host,
          backend: config.whisper.backend,
          model: config.whisper.model,
          reachable: whisperReachable,
        },
        ffmpeg: ff,
      };
    },
  );
}
