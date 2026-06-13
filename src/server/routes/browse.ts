import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { browseQuerySchema, browseResponseSchema, errorResponseSchema } from '@shared/schemas.js';
import { AUDIO_EXTS } from '@core/discover.js';
import { config } from '../config.js';
import { realOrNull, realRoots, isWithin, isRoot } from '../paths.js';

export function registerBrowseRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/browse',
    {
      schema: {
        querystring: browseQuerySchema,
        response: { 200: browseResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const browseRoots = config.browseRoots;
      const requested = req.query.path;

      // No path → virtual root listing the allowed mounts.
      if (!requested) {
        return {
          cwd: '',
          parent: null,
          browseRoots,
          entries: browseRoots.map((r) => ({ name: r, path: r, isDir: true })),
        };
      }

      const real = await realOrNull(path.resolve(requested));
      if (!real) return reply.code(404).send({ error: 'path not found' });

      const rroots = await realRoots(browseRoots);
      if (!rroots.some((r) => isWithin(real, r))) {
        return reply.code(403).send({ error: 'path is outside the allowed roots' });
      }

      const dirents = await fs.readdir(real, { withFileTypes: true });
      const entries = dirents
        .filter((d) => d.isDirectory() || AUDIO_EXTS.has(path.extname(d.name).toLowerCase()))
        .map((d) => ({ name: d.name, path: path.join(real, d.name), isDir: d.isDirectory() }))
        .sort((a, b) =>
          a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
        );

      return { cwd: real, parent: isRoot(real, rroots) ? null : path.dirname(real), browseRoots, entries };
    },
  );
}
