import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { debugAttributionRequestSchema } from '@shared/schemas.js';
import {
  DebugBusyError,
  InvalidModelError,
  LibraryRootError,
  PathForbiddenError,
  PathNotFoundError,
} from '../services/attribution.service.js';
import type { AttributionService } from '../services/attribution.service.js';

// POST /api/debug/attribution — INTERNAL diagnostic console, NOT part of the narratorr
// contract. Always registered (v0.8.0 dropped the EARWITNESS_DEBUG_ATTRIBUTION env flag —
// "want to debug, just click"). It stays behind the normal /api auth (loopback or API
// key), which is the guard on a trusted LAN. The response intentionally returns full
// transcripts + internals, and request-supplied model overrides are allow-listed in the
// service (validateDebugModels) so an arbitrary model can never be loaded from request input.
export function registerDebugRoutes(app: FastifyInstance, attribution: AttributionService): void {
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
