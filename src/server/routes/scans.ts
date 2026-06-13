import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  startScanRequestSchema,
  startScanResponseSchema,
  scanProgressSchema,
  scanResultsSchema,
  errorResponseSchema,
  type BookResult,
} from '@shared/schemas.js';
import { config } from '../config.js';
import { resolveWithinRoots } from '../paths.js';
import { ScanCapacityError, type ScanJobService } from '../services/scan-job.service.js';

const idParams = z.object({ id: z.string() });

// `flagged=true` returns only books that aren't cleanly verified. Query params are
// strings, so accept the literal 'true'/'false' (avoids z.coerce.boolean, where
// "false" is truthy); anything else is a 400.
const resultsQuery = z.object({
  flagged: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/** A book worth a human's attention: has flags, lacks attribution, or errored. */
function isFlaggedBook(b: BookResult): boolean {
  return b.flags.length > 0 || !b.attributionPresent || b.error !== null;
}

export function registerScanRoutes(app: FastifyInstance, scans: ScanJobService): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  a.post(
    '/api/scans',
    {
      schema: {
        body: startScanRequestSchema,
        response: {
          200: startScanResponseSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const real = await resolveWithinRoots(req.body.root, config.browseRoots);
      if (!real) {
        return reply.code(403).send({ error: 'root is not inside an allowed browse root' });
      }
      try {
        return { id: scans.start(real) };
      } catch (err) {
        if (err instanceof ScanCapacityError) return reply.code(503).send({ error: err.message });
        throw err;
      }
    },
  );

  a.get(
    '/api/scans/:id',
    { schema: { params: idParams, response: { 200: scanProgressSchema, 404: errorResponseSchema } } },
    async (req, reply) => {
      const progress = scans.progress(req.params.id);
      if (!progress) return reply.code(404).send({ error: 'scan not found' });
      return progress;
    },
  );

  a.get(
    '/api/scans/:id/results',
    {
      schema: {
        params: idParams,
        querystring: resultsQuery,
        response: { 200: scanResultsSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const results = await scans.results(req.params.id);
      if (!results) return reply.code(404).send({ error: 'scan not found' });
      if (req.query.flagged) {
        return { ...results, results: results.results.filter(isFlaggedBook) };
      }
      return results;
    },
  );

  a.post(
    '/api/scans/:id/cancel',
    {
      schema: {
        params: idParams,
        response: { 200: z.object({ cancelled: z.boolean() }), 404: errorResponseSchema },
      },
    },
    async (req, reply) => {
      // 404 (not 200 {cancelled:false}) for a missing job — matches GET :id/results.
      if (!scans.cancel(req.params.id)) return reply.code(404).send({ error: 'scan not found' });
      return { cancelled: true };
    },
  );
}
