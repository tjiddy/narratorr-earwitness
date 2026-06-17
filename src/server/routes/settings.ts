import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  configOverlaySchema,
  settingsResponseSchema,
  rotateKeyResponseSchema,
  type SettingsResponse,
} from '@shared/schemas.js';
import { createTranscribeProvider, type SwappableTranscribeProvider } from '@core/transcribe/index.js';
import { config } from '../config.js';
import { isTrustedRequest } from '../auth.js';
import { probeReadiness, type ReadinessProbe } from '../probes.js';
import { loadOverlay, saveOverlay, applyOverlay, mergeOverlay } from '../runtime-config.js';
import { rotateApiKey } from '../api-key.js';

// Settings = the operator surface for runtime config (no env edits, no restart): view the
// effective Ollama/Whisper config + readiness, change the editable bits, view/rotate the
// API key. Gated by the normal /api/* auth; hosts/key are nulled for untrusted callers.
// All editable fields are the configOverlaySchema allow-list — nothing else is mutable.
export function registerSettingsRoutes(app: FastifyInstance, transcribe: SwappableTranscribeProvider): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  function buildResponse(req: FastifyRequest, probe: ReadinessProbe): SettingsResponse {
    const trusted = isTrustedRequest(req);
    return {
      apiKey: trusted ? config.apiKey : null,
      ollama: { host: trusted ? config.ollama.host : null, model: config.ollama.model, reachable: probe.ollamaReachable },
      whisper: {
        host: trusted ? config.whisper.host : null,
        backend: config.whisper.backend,
        model: config.whisper.model,
        reachable: probe.whisperReachable,
      },
      ffmpeg: { path: trusted ? probe.ffmpeg.path : null, ok: probe.ffmpeg.ok },
      libraryRoot: trusted ? config.libraryRoot : null,
    };
  }

  typed.get('/api/settings', { schema: { response: { 200: settingsResponseSchema } } }, async (req) =>
    buildResponse(req, await probeReadiness()),
  );

  // Serialize settings mutations: two concurrent saves must not interleave the
  // load→merge→build→save→apply→swap sequence (which would drop an edit or leave config,
  // config.json, and the live provider disagreeing).
  let mutation: Promise<unknown> = Promise.resolve();

  typed.post(
    '/api/settings',
    { schema: { body: configOverlaySchema, response: { 200: settingsResponseSchema } } },
    async (req) => {
      const run = mutation.then(async () => {
        // Merge onto the persisted overlay so a partial save doesn't drop other overrides.
        const next = mergeOverlay(await loadOverlay(config.configFile), req.body);
        const newBackend = next.whisper?.backend ?? config.whisper.backend;
        const newHost = next.whisper?.host ?? config.whisper.host;
        const swap = newBackend !== config.whisper.backend || newHost !== config.whisper.host;

        // Build the replacement provider FIRST, against the proposed config — if construction
        // (incl. the lazy transformers import) throws, we abort BEFORE persisting/applying, so
        // config.json, config.whisper, and the live provider can never disagree.
        const newProvider = swap ? await createTranscribeProvider({ backend: newBackend, host: newHost }) : null;

        // Commit: persist, then apply IN PLACE (mutates shared config sub-objects → live).
        // Ollama host/model and the Whisper MODEL need no rebuild (the pipeline reads them by
        // reference per book); only a backend/host change swaps the provider.
        await saveOverlay(config.configFile, next);
        applyOverlay(config, next);
        if (newProvider) {
          transcribe.setProvider(newProvider);
          req.log.warn({ backend: newBackend, host: newHost }, 'settings: whisper provider hot-swapped');
        }
      });
      mutation = run.catch(() => {}); // keep the chain alive if this save fails
      await run; // surface this request's error to the caller

      return buildResponse(req, await probeReadiness());
    },
  );

  // Rotate the self-owned API key. Mints + persists a new key, swaps it into config (so the
  // old key stops working immediately), and returns it ONCE — the UI must store the new key.
  typed.post('/api/settings/rotate-key', { schema: { response: { 200: rotateKeyResponseSchema } } }, async (req) => {
    const key = await rotateApiKey(config.apiKeyFile);
    config.apiKey = key;
    req.log.warn('settings: API key rotated — the previous key is now invalid');
    return { apiKey: key };
  });
}
