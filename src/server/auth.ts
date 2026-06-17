import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

// Network-exposure controls. earwitness always has a self-owned API key (generated +
// persisted on first boot, see api-key.ts), so /api/* is locked on the network by
// default. "Trusted" callers — loopback, or anyone presenting the key — pass the auth
// gate AND get the fuller /api/config payload (absolute roots + internal hostnames).

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');
}

// Constant-time credential compare: hash both sides to a fixed length first so neither
// the length nor an early-mismatch position leaks via timing. A plain `===` short-circuits
// on the first differing byte and is a (theoretical) key-recovery oracle.
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function hasValidKey(req: FastifyRequest): boolean {
  if (config.apiKey === null) return false;
  // Accept `Authorization: Bearer <key>` (the UI/our own clients) OR `X-Api-Key: <key>`
  // (narratorr's connector, and the convention across narratorr's own APIs).
  const auth = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];
  if (typeof auth === 'string' && safeEqual(auth, `Bearer ${config.apiKey}`)) return true;
  if (typeof xApiKey === 'string' && safeEqual(xApiKey, config.apiKey)) return true;
  return false;
}

/** Trusted = authenticated with the API key, or connecting over loopback. */
export function isTrustedRequest(req: FastifyRequest): boolean {
  return hasValidKey(req) || isLoopback(req.ip);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF hardening (NOT human auth — that's deferred). Loopback is trusted without a key, so a
 * malicious page open in a browser ON the server box could otherwise forge a state-changing
 * request (e.g. rotate the key, or repoint the Whisper host at an exfil server) via a simple
 * cross-origin POST. Browsers attach `Origin` to such requests, so we reject an unsafe method
 * whose Origin is a real cross-origin browser origin. Same-origin (the UI this server serves)
 * and the configured dev origin (vite :5173) are allowed; requests with NO Origin (narratorr,
 * curl — non-browser machine clients) are unaffected.
 */
function isCrossOriginWrite(req: FastifyRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.origin;
  if (!origin) return false; // non-browser client — no Origin header to forge with
  if (origin === config.corsOrigin) return false; // configured dev origin
  try {
    return new URL(origin).host !== req.headers.host; // allow same-origin (host matches)
  } catch {
    return true; // malformed Origin → treat as cross-origin
  }
}

/**
 * Gate /api/* on trust: loopback (local UI / debug console / host curl) passes, the
 * network must present the key as `Authorization: Bearer <key>` or `X-Api-Key: <key>`.
 * Static assets / the SPA shell stay public so the UI still loads. config.apiKey is
 * null only in unit tests that build the app without resolving a key (then no-op);
 * in production ensureApiKey() always sets one before the app is built.
 */
export function registerAuth(app: FastifyInstance): void {
  if (config.apiKey === null) return;
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!isTrustedRequest(req)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    // Even for a trusted (e.g. loopback) caller, block a forged cross-origin write.
    if (isCrossOriginWrite(req)) {
      return reply.code(403).send({ error: 'cross-origin request rejected' });
    }
  });
}
