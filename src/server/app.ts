import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { config, APP_ROOT } from './config.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes/index.js';
import type { ScanJobService } from './services/scan-job.service.js';
import type { AttributionService } from './services/attribution.service.js';

export interface BuildAppOptions {
  scans: ScanJobService;
  attribution: AttributionService;
  // Defaults derive from config; overridable so tests can exercise prod static
  // serving without flipping NODE_ENV on the singleton config.
  serveStatic?: boolean;
  clientDir?: string;
}

/**
 * Build the fully-configured Fastify instance (no listen). Keeping this separate
 * from index.ts lets tests drive it with app.inject() and inject a fake service.
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const serveStatic = opts.serveStatic ?? !config.isDev;
  const clientDir = opts.clientDir ?? path.resolve(APP_ROOT, 'dist/client');

  // disableRequestLogging: the Docker healthcheck hammers GET / every 30s, which at
  // info level would bury the attribution logs in noise. We log completions ourselves
  // below, but ONLY for /api/* — so health probes + static assets stay silent.
  const app = Fastify({ logger: { level: config.logLevel }, disableRequestLogging: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      req.log.info(
        { method: req.method, url: req.url, statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) },
        'request completed',
      );
    }
  });

  // Normalize every error (incl. Fastify's schema-validation 400s, which otherwise
  // serialize as {statusCode,error,message}) into the {error} envelope all routes use.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: err.message || 'internal server error' });
  });

  await app.register(cors, { origin: config.corsOrigin });
  registerAuth(app);

  if (serveStatic) {
    await app.register(fastifyStatic, { root: clientDir });
    // SPA fallback: non-/api GETs return index.html so client-side routing works.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  registerRoutes(app, { scans: opts.scans, attribution: opts.attribution });
  return app;
}
