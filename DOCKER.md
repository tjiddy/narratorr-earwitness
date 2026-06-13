# Running Earwitness in Docker

The image is a **single app container** (Node + ffmpeg) that builds the React UI and
the Fastify API and serves both on `:3000`. The GPU — if any — lives in the model
*services* (Ollama / Whisper), never in this image; the app only makes HTTP calls to
them. So there are two ways to deploy:

| Mode | When | How |
|---|---|---|
| **App-only image** | You already run Ollama (and maybe a Whisper service) on the host or elsewhere | `docker run` the image, point `OLLAMA_HOST` / `WHISPER_HOST` at them |
| **Full compose stack** | A from-scratch host (e.g. a GPU-less homelab) with nothing else installed | `docker compose up` — brings up the app + Ollama |

## Full stack (compose) — GPU-less homelab

Spins up the app + Ollama. Whisper runs **in-process** (transformers.js CPU), so
there's no separate STT container.

```sh
# LIBRARY_PATH is required; an API key is strongly recommended on a LAN.
export LIBRARY_PATH=/srv/audiobooks
export EARWITNESS_API_KEY=$(openssl rand -hex 24)
docker compose up -d
# → http://<host>:3000
```

First run downloads the Ollama model (~5 GB) before the app starts, and the Whisper
model on the first scan; both are cached in named volumes, so it's a one-time cost.

**Knobs** (env vars / compose substitution):
- `LIBRARY_PATH` *(required)* — host folder of audiobooks, mounted read-only at `/library`.
- `EARWITNESS_API_KEY` — when set, `/api/*` requires `Authorization: Bearer <key>`. Without it the API is **open on the LAN** and the app logs a warning at boot. (Setting a key also locks out the keyless browser UI — it's the API-consumer / Narratorr seam.)
- `OLLAMA_MODEL` (default `qwen2.5:7b-instruct`) — 7B on CPU is slow but fine for a batch scan; drop to a 3B if it drags.
- `WHISPER_MODEL` (default `base.en`) — CPU `base.en` mangles proper nouns (author/narrator names); bump to `small.en` or `medium` for accuracy at the cost of speed.

## App-only image

```sh
docker build -t narratorr-earwitness .
docker run -d -p 3000:3000 \
  -e BROWSE_ROOTS=/library \
  -e OLLAMA_HOST=http://host.docker.internal:11434 \
  -e WHISPER_BACKEND=openai-compat -e WHISPER_HOST=http://host.docker.internal:8000 \
  -e EARWITNESS_API_KEY=changeme \
  -v /srv/audiobooks:/library:ro \
  -v earwitness-data:/data \
  narratorr-earwitness
```

The bare image defaults to `WHISPER_BACKEND=openai-compat` (the GPU path) — point
`WHISPER_HOST` at a faster-whisper / whisper.cpp server. Switch to
`WHISPER_BACKEND=transformersjs` to run STT in-process with no external service.

## Adding a GPU

The CPU stack works everywhere; to accelerate, either give Ollama a GPU (uncomment
the `deploy.resources` block in `docker-compose.yml`) and/or run a real GPU Whisper
service and set `WHISPER_BACKEND=openai-compat` + `WHISPER_HOST` instead of the
in-process fallback. The model services need `nvidia-container-toolkit` on the host.

## Volumes

- `earwitness-data` → `/data`: extraction/transcript cache (`/data/cache`), reports (`/data/reports`), and downloaded Whisper weights (`/data/models`).
- `ollama-models` → Ollama's model store.
- Your library is bind-mounted read-only.

## Notes

- `.env` is **not** part of the image (excluded via `.dockerignore`); configure via
  environment variables / compose only.
- Health: the container is healthy once `GET /` (the UI shell) returns 200.
