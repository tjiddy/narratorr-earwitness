import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { debugAttributionRequestSchema } from '@shared/schemas.js';
import { config } from '../config.js';
import {
  DebugBusyError,
  InvalidModelError,
  LibraryRootError,
  PathForbiddenError,
  PathNotFoundError,
} from '../services/attribution.service.js';
import type { AttributionService } from '../services/attribution.service.js';

// POST /api/debug/attribution — INTERNAL diagnostic console, NOT part of the narratorr
// contract. Registered ONLY when EARWITNESS_DEBUG_ATTRIBUTION is on (otherwise the route
// doesn't exist → 404). Still behind the normal /api auth (loopback or API key); since
// it runs in the same container reachable only via the published port, loopback-only would
// be unusable, so the env flag is the real guard — turn it OFF when you're done. The
// response intentionally returns full transcripts + internals, so don't leave it exposed.
export function registerDebugRoutes(app: FastifyInstance, attribution: AttributionService): void {
  if (!config.debugAttribution) return;

  app.log.warn(
    'DEBUG attribution console ENABLED (POST /api/debug/attribution) — it exposes full transcripts + internals to any API-key holder. Disable EARWITNESS_DEBUG_ATTRIBUTION when done.',
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/debug/attribution',
    // No response schema — the debug payload is free-form (full transcripts + trace).
    { schema: { body: debugAttributionRequestSchema } },
    async (req, reply) => {
      try {
        return await attribution.debugAttribute({
          path: req.body.path,
          expected: req.body.expected,
          whisperModel: req.body.whisperModel,
          ollamaModel: req.body.ollamaModel,
          returnTimestamps: req.body.returnTimestamps,
          forceFresh: req.body.forceFresh,
          runs: req.body.runs,
        });
      } catch (err) {
        if (err instanceof InvalidModelError) return reply.code(400).send({ error: err.message });
        if (err instanceof DebugBusyError) return reply.code(429).send({ error: err.message });
        if (err instanceof PathForbiddenError) return reply.code(403).send({ error: err.message });
        if (err instanceof PathNotFoundError) return reply.code(404).send({ error: err.message });
        if (err instanceof LibraryRootError) return reply.code(503).send({ error: err.message });
        throw err; // unknown → 500 via the app error handler
      }
    },
  );
}
