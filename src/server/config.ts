import path from 'node:path';
import { z } from 'zod';

// Load .env for native dev (no-op if absent / already in env). Production passes
// real env vars (docker-compose), so a missing file is fine.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env — rely on process.env
}

const intFromString = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) => parseInt(v || def, 10))
    .pipe(z.number().int());

const envSchema = z.object({
  PORT: intFromString('3000').pipe(z.number().int().min(1).max(65535)),
  NODE_ENV: z.string().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:5173').transform((v) => v || 'http://localhost:5173'),

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

  FFMPEG_PATH: z.string().optional(),
  CACHE_DIR: z.string().default('./.earwitness/cache').transform((v) => path.resolve(v || './.earwitness/cache')),
  REPORTS_DIR: z.string().default('./.earwitness/reports').transform((v) => path.resolve(v || './.earwitness/reports')),

  NARRATORR_URL: z.string().optional(),
  NARRATORR_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment config:\n${z.prettifyError(parsed.error)}`);
}
const env = parsed.data;

const mode: 'standalone' | 'narratorr' =
  env.NARRATORR_URL && env.NARRATORR_API_KEY ? 'narratorr' : 'standalone';

export const config = {
  port: env.PORT,
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
  ffmpegPath: env.FFMPEG_PATH ?? null,
  cacheDir: env.CACHE_DIR,
  reportsDir: env.REPORTS_DIR,
  narratorr:
    mode === 'narratorr'
      ? { url: env.NARRATORR_URL as string, apiKey: env.NARRATORR_API_KEY as string }
      : null,
};

export type AppConfig = typeof config;
