import { Cache } from '@core/cache.js';
import { ReportStore } from '@core/store.js';
import { resolveFfmpeg } from '@core/ffmpeg.js';
import { createTranscribeProvider, withTranscribeLimit } from '@core/transcribe/index.js';
import type { ProcessDeps } from '@core/pipeline.js';
import { config } from './config.js';
import { ScanJobService } from './services/scan-job.service.js';
import { AttributionService } from './services/attribution.service.js';
import { buildApp } from './app.js';

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

async function main(): Promise<void> {
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

  // Loud warning (not a hard fail — homelab use) when the API is open on a
  // non-loopback interface: the filesystem-browsing API is reachable from the LAN.
  if (!isLoopbackHost(config.bindHost) && config.apiKey === null) {
    app.log.warn(
      `SECURITY: bound to ${config.bindHost} with NO EARWITNESS_API_KEY set — /api is reachable unauthenticated on the network. Set EARWITNESS_API_KEY or BIND_HOST=127.0.0.1.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
