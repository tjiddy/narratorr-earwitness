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
# Only LIBRARY_PATH is required — earwitness mints its own API key.
export LIBRARY_PATH=/srv/audiobooks
docker compose up -d
# → http://<host>:3000
```

First run downloads the Ollama model (~5 GB) before the app starts, and the Whisper
model on the first scan; both are cached in named volumes, so it's a one-time cost.

**Getting the API key.** earwitness generates + persists its own key to `/data/api-key`
(on the `earwitness-data` volume) on first boot and prints it once. Grab it with:
```sh
docker compose logs earwitness | grep "API key"
# or, any time:
docker compose exec earwitness cat /data/api-key
```
Hand that to narratorr's connector. `/api/*` requires it from the **network** as
`Authorization: Bearer <key>` **or** `X-Api-Key: <key>` (narratorr sends the latter);
loopback is trusted without it. To **bring your own**, write `/data/api-key` (or mount
it as a Docker secret) before first boot — don't pass it via env.

**Knobs** (env vars / compose substitution):
- `LIBRARY_PATH` *(required)* — host folder of audiobooks, mounted read-only at `/library`.
- `EARWITNESS_API_KEY_FILE` (default `/data/api-key`) — where the self-owned key is stored. Change the location, not the value-source; the key is never read from env.
- `EARWITNESS_LIBRARY_ROOT` (default `/audiobooks`; set to `/library` in the sample compose) — root that `POST /api/v1/attribution` resolves narratorr's library-relative paths against, with a containment guard. Point it at the same library mount.
- `OLLAMA_MODEL` (default `qwen2.5:7b-instruct`) — 7B on CPU is slow but fine for a batch scan; drop to a 3B if it drags.
- `WHISPER_MODEL` (default `base.en`) — CPU `base.en` mangles proper nouns (author/narrator names); bump to `small.en` or `medium` for accuracy at the cost of speed.

## App-only image

```sh
docker build -t narratorr-earwitness .
docker run -d -p 3000:3000 \
  -e BROWSE_ROOTS=/library \
  -e OLLAMA_HOST=http://host.docker.internal:11434 \
  -e WHISPER_BACKEND=openai-compat -e WHISPER_HOST=http://host.docker.internal:8000 \
  -v /srv/audiobooks:/library:ro \
  -v earwitness-data:/data \
  narratorr-earwitness
# The key is minted to /data/api-key on first boot — `docker logs <container> | grep "API key"`.
```

The bare image defaults to `WHISPER_BACKEND=openai-compat` (the GPU path) — point
`WHISPER_HOST` at a faster-whisper / whisper.cpp server. Switch to
`WHISPER_BACKEND=transformersjs` to run STT in-process with no external service.

## Adding a GPU

The CPU stack works everywhere; to accelerate, either give Ollama a GPU (uncomment
the `deploy.resources` block in `docker-compose.yml`) and/or run a real GPU Whisper
service and set `WHISPER_BACKEND=openai-compat` + `WHISPER_HOST` instead of the
in-process fallback. The model services need `nvidia-container-toolkit` on the host.

## Debugging an attribution miss

`POST /api/debug/attribution` (and a **Debug** tab in the UI) runs the real pipeline
against one file and returns the **full transcript + internal trace**, and can A/B Whisper
models in-process. It is **OFF by default** and exposes raw transcripts + absolute paths to
any API-key holder, so treat it as a temporary diagnostic, not a standing feature.

- **Enable:** set `EARWITNESS_DEBUG_ATTRIBUTION=true` and **recreate** the container — the
  flag is read at boot, so use `docker compose up -d --force-recreate earwitness` (NOT
  `restart`/`exec`). The Debug tab appears once it's on (the UI reads the flag from `/api/config`).
- **Model-override caveat:** a debug run that overrides the Whisper model shares the single
  in-process model slot with production, so it **evicts the live model** — the next real
  attribution pays a cold reload (~1.5 GB for large models). Debug is single-slot (one run
  at a time) but still competes with production for the transcribe semaphore. Overrides are
  allow-listed (known model names only) so a debug caller can't load an arbitrary remote model.
- **Disable when done:** set it back to `false` (or unset) and recreate. Don't leave it on.

## Volumes

- `earwitness-data` → `/data`: extraction/transcript cache (`/data/cache`), reports (`/data/reports`), and downloaded Whisper weights (`/data/models`).
- `ollama-models` → Ollama's model store.
- Your library is bind-mounted read-only.

## Notes

- `.env` is **not** part of the image (excluded via `.dockerignore`); configure via
  environment variables / compose only.
- Health: the container is healthy once `GET /` (the UI shell) returns 200.
