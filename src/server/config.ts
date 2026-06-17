import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load .env for native dev (no-op if absent / already in env). Production passes
// real env vars (docker-compose), so a missing file is fine.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env — rely on process.env
}

// Anchor relative cache/report dirs to the repo root — two levels up from this
// module (src/server in dev, dist/server after bundling) — NOT process.cwd(),
// so launching from a different directory doesn't silently relocate state.
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolveFromRoot = (p: string) => (path.isAbsolute(p) ? p : path.resolve(APP_ROOT, p));

// App version for the /api/v1/health probe — read from package.json (copied into the
// runtime image, anchored to APP_ROOT). Falls back rather than crashing the server.
const version: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Numeric env var: empty/absent → default, otherwise require an all-digits string.
// Unlike parseInt ("60abc" → 60), a non-numeric value is rejected outright.
const intFromString = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) => (v.trim() === '' ? def : v.trim()))
    .pipe(z.string().regex(/^[+-]?\d+$/, 'must be an integer').transform((v) => parseInt(v, 10)));

const envSchema = z.object({
  PORT: intFromString('3000').pipe(z.number().int().min(1).max(65535)),
  NODE_ENV: z.string().default(''),
  // Pino log level. Default 'info' (both dev and prod) — earwitness narrates the
  // attribution chain at info, so the default must show it. Drop to 'warn' for quiet,
  // raise to 'debug' for full transcripts + evidence spans.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173').transform((v) => v || 'http://localhost:5173'),

  // Network exposure controls. BIND_HOST defaults to 0.0.0.0 so Docker/LAN keep
  // working. earwitness OWNS its API key — generated + persisted on first boot
  // (see server/api-key.ts), NOT provided via env. EARWITNESS_API_KEY_FILE only
  // overrides WHERE that key is stored (defaults to a sibling of the cache dir).
  BIND_HOST: z.string().default('0.0.0.0').transform((v) => v || '0.0.0.0'),
  EARWITNESS_API_KEY_FILE: z.string().optional(),

  BROWSE_ROOTS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => path.resolve(p)),
    ),

  OLLAMA_HOST: z.string().default('http://localhost:11434').transform((v) => v || 'http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen2.5:7b-instruct').transform((v) => v || 'qwen2.5:7b-instruct'),

  WHISPER_HOST: z.string().default('http://localhost:8000').transform((v) => v || 'http://localhost:8000'),
  WHISPER_BACKEND: z.enum(['whispercpp', 'openai-compat', 'transformersjs']).default('openai-compat'),
  WHISPER_MODEL: z.string().default('large-v3-turbo').transform((v) => v || 'large-v3-turbo'),

  INTRO_SECONDS: intFromString('60').pipe(z.number().int().min(5).max(600)),
  INTRO_OFFSET_SECONDS: intFromString('0').pipe(z.number().int().min(0).max(3600)),

  MAX_CONCURRENT_BOOKS: intFromString('2').pipe(z.number().int().min(1).max(32)),
  MAX_CONCURRENT_TRANSCRIBES: intFromString('1').pipe(z.number().int().min(1).max(16)),

  // Per-call timeouts (ms) so a hung Whisper/Ollama service can't wedge a worker
  // forever. 0 disables. Combined with the job abort signal in the pipeline.
  TRANSCRIBE_TIMEOUT_MS: intFromString('300000').pipe(z.number().int().min(0)),
  EXTRACT_TIMEOUT_MS: intFromString('120000').pipe(z.number().int().min(0)),

  // Process-wide cap on active+queued scans (backpressure). Excess → 503.
  MAX_ACTIVE_SCANS: intFromString('4').pipe(z.number().int().min(1).max(64)),

  // Tail-sampling: when the head intro window yields no complete attribution, also
  // transcribe the END of the file (Audible & co. put the credit there). Default on;
  // set false/0/no/off to disable (head-only, cheaper).
  TAIL_SAMPLING: z.string().optional(),

  // Debug attribution console (POST /api/debug/attribution). OFF by default — when on
  // it exposes full transcripts + internals + absolute paths to any API-key holder, and
  // in-process model swaps can disrupt live attribution. Turn on to debug, off when done.
  EARWITNESS_DEBUG_ATTRIBUTION: z.string().optional(),

  FFMPEG_PATH: z.string().optional(),
  CACHE_DIR: z.string().default('./.earwitness/cache').transform((v) => resolveFromRoot(v || './.earwitness/cache')),
  REPORTS_DIR: z.string().default('./.earwitness/reports').transform((v) => resolveFromRoot(v || './.earwitness/reports')),

  NARRATORR_URL: z.string().optional(),
  NARRATORR_API_KEY: z.string().optional(),

  // Shared library mount root that POST /api/v1/attribution resolves request paths
  // against. narratorr sends library-RELATIVE POSIX paths; we join + containment-guard
  // them here. Default matches the deployed compose's shared mount.
  EARWITNESS_LIBRARY_ROOT: z.string().default('/audiobooks').transform((v) => v || '/audiobooks'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment config:\n${z.prettifyError(parsed.error)}`);
}
const env = parsed.data;

const mode: 'standalone' | 'narratorr' =
  env.NARRATORR_URL && env.NARRATORR_API_KEY ? 'narratorr' : 'standalone';

// Trim a key (the key file's contents) to null when blank/whitespace, so an empty
// key file reads as "no key yet" and triggers regeneration rather than locking /api
// behind a bearer of empty string that nothing ever sends.
export const normalizeApiKey = (v: string | undefined): string | null => v?.trim() || null;

export const config = {
  version,
  logLevel: env.LOG_LEVEL ?? 'info',
  port: env.PORT,
  bindHost: env.BIND_HOST,
  // Filled at startup by ensureApiKey() (read-from-file or generate-and-persist).
  // Null only in unit tests that build the app directly without resolving a key —
  // registerAuth() then no-ops, matching the pre-key test behavior.
  apiKey: null as string | null,
  isDev: env.NODE_ENV !== 'production',
  corsOrigin: env.CORS_ORIGIN,
  mode,
  browseRoots: env.BROWSE_ROOTS,
  ollama: { host: env.OLLAMA_HOST, model: env.OLLAMA_MODEL },
  whisper: { host: env.WHISPER_HOST, backend: env.WHISPER_BACKEND, model: env.WHISPER_MODEL },
  introSeconds: env.INTRO_SECONDS,
  introOffsetSeconds: env.INTRO_OFFSET_SECONDS,
  maxConcurrentBooks: env.MAX_CONCURRENT_BOOKS,
  maxConcurrentTranscribes: env.MAX_CONCURRENT_TRANSCRIBES,
  transcribeTimeoutMs: env.TRANSCRIBE_TIMEOUT_MS,
  extractTimeoutMs: env.EXTRACT_TIMEOUT_MS,
  maxActiveScans: env.MAX_ACTIVE_SCANS,
  // Default on; only an explicit false/0/no/off disables it.
  tailSampling: !/^(false|0|no|off)$/i.test((env.TAIL_SAMPLING ?? '').trim()),
  // Default OFF; only an explicit true/1/yes/on enables the debug console.
  debugAttribution: /^(true|1|yes|on)$/i.test((env.EARWITNESS_DEBUG_ATTRIBUTION ?? '').trim()),
  ffmpegPath: env.FFMPEG_PATH ?? null,
  cacheDir: env.CACHE_DIR,
  reportsDir: env.REPORTS_DIR,
  libraryRoot: env.EARWITNESS_LIBRARY_ROOT,
  // Where earwitness persists its self-owned API key. Sibling of the cache dir by
  // default (i.e. /data in compose, ./.earwitness in dev) — deliberately NOT inside
  // the cache dir, so clearing the cache can't rotate the key out from under callers.
  apiKeyFile: env.EARWITNESS_API_KEY_FILE
    ? resolveFromRoot(env.EARWITNESS_API_KEY_FILE)
    : path.join(path.dirname(env.CACHE_DIR), 'api-key'),
};

export type AppConfig = typeof config;
