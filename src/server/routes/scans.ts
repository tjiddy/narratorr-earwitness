import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  startScanRequestSchema,
  startScanResponseSchema,
  scanProgressSchema,
  scanResultsSchema,
  errorResponseSchema,
} from '@shared/schemas.js';
import { config } from '../config.js';
import { resolveWithinRoots } from '../paths.js';
import type { ScanJobService } from '../services/scan-job.service.js';

const idParams = z.object({ id: z.string() });

export function registerScanRoutes(app: FastifyInstance, scans: ScanJobService): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  a.post(
    '/api/scans',
    {
      schema: {
        body: startScanRequestSchema,
        response: { 200: startScanResponseSchema, 403: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const real = await resolveWithinRoots(req.body.root, config.browseRoots);
      if (!real) {
        return reply.code(403).send({ error: 'root is not inside an allowed browse root' });
      }
      return { id: scans.start(real) };
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
    { schema: { params: idParams, response: { 200: scanResultsSchema, 404: errorResponseSchema } } },
    async (req, reply) => {
      const results = scans.results(req.params.id);
      if (!results) return reply.code(404).send({ error: 'scan not found' });
      return results;
    },
  );

  a.post(
    '/api/scans/:id/cancel',
    { schema: { params: idParams, response: { 200: z.object({ cancelled: z.boolean() }) } } },
    async (req) => ({ cancelled: scans.cancel(req.params.id) }),
  );
}
