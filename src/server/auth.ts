import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from './config.js';

// Network-exposure controls. The homelab default is an OPEN API on the LAN; setting
// EARWITNESS_API_KEY locks /api/* down (the seam Narratorr-mode needs). "Trusted"
// callers — loopback, or anyone presenting the key — additionally get the fuller
// /api/config payload (absolute roots + internal hostnames).

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');
}

export function hasValidKey(req: FastifyRequest): boolean {
  if (config.apiKey === null) return false;
  // Accept `Authorization: Bearer <key>` (the UI/our own clients) OR `X-Api-Key: <key>`
  // (narratorr's connector, and the convention across narratorr's own APIs).
  return (
    req.headers.authorization === `Bearer ${config.apiKey}` || req.headers['x-api-key'] === config.apiKey
  );
}

/** Trusted = authenticated with the API key, or connecting over loopback. */
export function isTrustedRequest(req: FastifyRequest): boolean {
  return hasValidKey(req) || isLoopback(req.ip);
}

/**
 * When an API key is configured, require `Authorization: Bearer <key>` on every
 * /api/* request. Static assets / the SPA shell stay public so the UI still loads.
 * With no key set the API is open (homelab default); index.ts logs a loud warning
 * when that combines with a non-loopback bind.
 */
export function registerAuth(app: FastifyInstance): void {
  if (config.apiKey === null) return;
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!hasValidKey(req)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
