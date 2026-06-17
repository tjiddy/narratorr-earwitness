import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { libraryBrowseQuerySchema, libraryBrowseResponseSchema, errorResponseSchema } from '@shared/schemas.js';
import { AUDIO_EXTS } from '@core/discover.js';
import { config } from '../config.js';
import { realOrNull, resolveWithinRoot } from '../paths.js';

// GET /api/library-browse — walk the configured library root, returning library-RELATIVE
// paths (forward-slash, POSIX-ish) so the debug console can pick a book by clicking and
// drop the exact path POST /api/v1/attribution + the debug endpoint expect. Containment is
// enforced by resolveWithinRoot (the same guard the attribution endpoint uses).
export function registerLibraryRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/library-browse',
    {
      schema: {
        querystring: libraryBrowseQuerySchema,
        response: { 200: libraryBrowseResponseSchema, 400: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 503: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const realRoot = await realOrNull(config.libraryRoot);
      if (!realRoot) return reply.code(503).send({ error: `library root not accessible: ${config.libraryRoot}` });

      const toRel = (abs: string): string => path.relative(realRoot, abs).split(path.sep).join('/');

      // No path → list the library root itself.
      let dirReal: string;
      let cwd: string;
      const requested = req.query.path?.trim();
      if (!requested) {
        dirReal = realRoot;
        cwd = '';
      } else {
        const resolved = await resolveWithinRoot(requested, realRoot);
        if (!resolved.ok) {
          return resolved.reason === 'forbidden'
            ? reply.code(403).send({ error: 'path resolves outside the library root' })
            : reply.code(404).send({ error: 'path not found in the library' });
        }
        dirReal = resolved.real;
        cwd = toRel(dirReal);
      }

      const st = await fs.stat(dirReal).catch(() => null);
      if (!st?.isDirectory()) return reply.code(400).send({ error: 'path is not a directory' });

      const dirents = await fs.readdir(dirReal, { withFileTypes: true });
      const entries = dirents
        .filter((d) => d.isDirectory() || AUDIO_EXTS.has(path.extname(d.name).toLowerCase()))
        .map((d) => ({ name: d.name, path: toRel(path.join(dirReal, d.name)), isDir: d.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

      // parent: null at the root, '' (the root) for a direct child, else the relative parent.
      const parent = cwd === '' ? null : toRel(path.dirname(dirReal));
      return { root: realRoot, cwd, parent, entries };
    },
  );
}
