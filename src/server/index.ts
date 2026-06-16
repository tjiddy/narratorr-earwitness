import { Cache } from '@core/cache.js';
import { ReportStore } from '@core/store.js';
import { resolveFfmpeg } from '@core/ffmpeg.js';
import { createTranscribeProvider, withTranscribeLimit } from '@core/transcribe/index.js';
import type { ProcessDeps } from '@core/pipeline.js';
import { config } from './config.js';
import { ensureApiKey } from './api-key.js';
import { ScanJobService } from './services/scan-job.service.js';
import { AttributionService } from './services/attribution.service.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  // Resolve our self-owned API key BEFORE building the app so registerAuth() sees it.
  // config.apiKey is the single source auth reads; fill it in once at startup.
  const apiKey = await ensureApiKey(config.apiKeyFile);
  config.apiKey = apiKey.key;

  // ffmpeg is required for audio cutting; fall back to bare "ffmpeg" so the server
  // still boots and /api/config reports the problem rather than crashing.
  const ffmpegPath = await resolveFfmpeg(config.ffmpegPath).catch(() => config.ffmpegPath ?? 'ffmpeg');

  // One shared, concurrency-limited provider so MAX_CONCURRENT_TRANSCRIBES caps the
  // heavy STT step process-wide even while books run in parallel.
  const transcribe = withTranscribeLimit(
    await createTranscribeProvider({ backend: config.whisper.backend, host: config.whisper.host }),
    config.maxConcurrentTranscribes,
  );

  // Shared pipeline deps — one cache + provider instance backs both the batch
  // scanner and the per-file attribution endpoint.
  const processDeps: ProcessDeps = {
    transcribe,
    cache: new Cache(config.cacheDir),
    ffmpegPath,
    offsetSeconds: config.introOffsetSeconds,
    seconds: config.introSeconds,
    whisperModel: config.whisper.model,
    ollama: config.ollama,
    transcribeTimeoutMs: config.transcribeTimeoutMs,
    extractTimeoutMs: config.extractTimeoutMs,
  };

  const scans = new ScanJobService({
    ...processDeps,
    reportStore: new ReportStore(config.reportsDir),
    maxConcurrentBooks: config.maxConcurrentBooks,
    maxActiveScans: config.maxActiveScans,
  });

  const attribution = new AttributionService({
    ...processDeps,
    libraryRoot: config.libraryRoot,
    maxActive: config.maxActiveScans,
  });

  const app = await buildApp({ scans, attribution });

  await app.listen({ port: config.port, host: config.bindHost });
  app.log.info(`earwitness on ${config.bindHost}:${config.port} (mode=${config.mode}, whisper=${config.whisper.backend})`);
  app.log.info(`cache=${config.cacheDir} reports=${config.reportsDir}`);

  // Print the key on EVERY boot so it's always grep-able straight from the logs.
  // Use warn, not info — the prod logger runs at level 'warn' (app.ts), so an info
  // line would be silently dropped in the container. /api/* requires it from the
  // network; loopback (local UI / curl) is trusted.
  if (apiKey.source === 'generated') {
    app.log.warn(`No API key found — generated one and saved it to ${apiKey.path}`);
  }
  app.log.warn(`API key: ${apiKey.key}  (send as X-Api-Key to narratorr; persisted at ${apiKey.path})`);

  // We no longer take the key from env — warn if a stale EARWITNESS_API_KEY lingers so
  // an operator who expects it honored isn't silently confused.
  if (process.env.EARWITNESS_API_KEY?.trim()) {
    app.log.warn(
      `EARWITNESS_API_KEY env is set but IGNORED — earwitness owns its key (${apiKey.path}). To use a specific key, write it to that file (or set EARWITNESS_API_KEY_FILE).`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
