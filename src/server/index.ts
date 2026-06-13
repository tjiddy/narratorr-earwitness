import Fastify from 'fastify';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { Cache } from '@core/cache.js';
import { ReportStore } from '@core/store.js';
import { resolveFfmpeg } from '@core/ffmpeg.js';
import { createTranscribeProvider } from '@core/transcribe/index.js';
import { config } from './config.js';
import { ScanJobService } from './services/scan-job.service.js';
import { registerRoutes } from './routes/index.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: config.isDev ? 'info' : 'warn' } }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: config.corsOrigin });

  // ffmpeg is required for audio cutting; fall back to bare "ffmpeg" so the server
  // still boots and /api/config reports the problem rather than crashing.
  const ffmpegPath = await resolveFfmpeg(config.ffmpegPath).catch(() => config.ffmpegPath ?? 'ffmpeg');

  const scans = new ScanJobService({
    transcribe: createTranscribeProvider({ backend: config.whisper.backend, host: config.whisper.host }),
    cache: new Cache(config.cacheDir),
    reportStore: new ReportStore(config.reportsDir),
    ffmpegPath,
    offsetSeconds: config.introOffsetSeconds,
    seconds: config.introSeconds,
    whisperModel: config.whisper.model,
    ollama: config.ollama,
    maxConcurrentBooks: config.maxConcurrentBooks,
  });

  registerRoutes(app, { scans });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`earwitness server on :${config.port} (mode=${config.mode}, whisper=${config.whisper.backend})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
