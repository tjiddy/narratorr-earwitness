import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { healthResponseSchema } from '@shared/schemas.js';
import { config } from '../config.js';

// GET /api/v1/health — narratorr's "Test Connection" probe (#1526). Deliberately
// shallow: it reports liveness + identity only, NOT dependency health (Ollama/Whisper
// live in /api/config). It sits under /api/*, so the global auth gate also makes this
// a key check — a 200 means "reachable AND the key is valid."
export function registerHealthRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/health',
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({ ok: true as const, mode: config.mode, version: config.version }),
  );
}
