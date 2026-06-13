# syntax=docker/dockerfile:1

# Single app image: builds the React client + Fastify server, then serves BOTH on
# :3000 in production (the server hosts dist/client via @fastify/static). GPU lives
# in the model SERVICES (Ollama / Whisper), never in this image — it only makes HTTP
# calls to them. ffmpeg is the one OS dependency (resolved via PATH by the app).

############################ builder ############################
FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable
# Install all deps (incl. dev) for the build. Lockfile copied first for layer caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

############################ runtime ############################
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    CACHE_DIR=/data/cache \
    REPORTS_DIR=/data/reports \
    TRANSFORMERS_CACHE=/data/models

# ffmpeg for audio cutting. corepack so we can do a prod-only install.
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Production deps only (the server bundle externalizes them, so node_modules must
# be present at runtime). onnxruntime-node ships its native binary in-package, so
# pnpm v10 skipping its build script is fine.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Built client + server (APP_ROOT resolves to /app, client at /app/dist/client).
COPY --from=builder /app/dist ./dist

# /data holds cache, reports, and model weights — mount a volume here.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000

# The SPA shell at / is public even when an API key is set, so it's a clean liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
