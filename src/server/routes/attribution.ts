import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { attributionRequestSchema, attributionResponseSchema, errorResponseSchema } from '@shared/schemas.js';
import {
  AttributionCapacityError,
  AmbiguousPathError,
  LibraryRootError,
  PathForbiddenError,
  PathNotFoundError,
  ProcessingError,
  UnprocessableContentError,
} from '../services/attribution.service.js';
import type { AttributionService } from '../services/attribution.service.js';

// POST /api/v1/attribution — the locked narratorr contract (EARWITNESS-ATTRIBUTION-API-CONTRACT.md).
// Gated by the same /api/* auth as everything else (narratorr sends X-Api-Key).

const RETRY_AFTER_SECONDS = 30;

export function registerAttributionRoutes(app: FastifyInstance, attribution: AttributionService): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  a.post(
    '/api/v1/attribution',
    {
      schema: {
        body: attributionRequestSchema,
        response: {
          200: attributionResponseSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const retryable = (msg: string) => {
        reply.header('Retry-After', String(RETRY_AFTER_SECONDS));
        return reply.code(503).send({ error: msg });
      };
      try {
        const { detection, comparison } = await attribution.attribute({
          path: req.body.path,
          expected: req.body.expected,
          logger: req.log, // request-scoped (carries reqId) → narrates the whole chain
          // Per-stage timeouts in the pipeline guard hangs; no request-abort wiring needed for 1.0.
        });
        return {
          requestId: req.body.requestId ?? null,
          detection,
          ...(comparison ? { comparison } : {}),
        };
      } catch (err) {
        // Transient (retry me) → 503 + Retry-After.
        if (err instanceof AttributionCapacityError) return retryable(err.message);
        if (err instanceof LibraryRootError) return retryable(err.message);
        if (err instanceof ProcessingError) return retryable(err.message);
        // Permanent (don't retry) → 4xx, no Retry-After.
        if (err instanceof PathForbiddenError) return reply.code(403).send({ error: err.message });
        if (err instanceof PathNotFoundError) return reply.code(404).send({ error: err.message });
        if (err instanceof AmbiguousPathError) return reply.code(422).send({ error: err.message });
        if (err instanceof UnprocessableContentError) return reply.code(422).send({ error: err.message });
        throw err; // unknown → 500 via the app error handler
      }
    },
  );
}
