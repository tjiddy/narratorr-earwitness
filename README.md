# narratorr-earwitness

Earwitness identifies audiobooks by **listening** to them instead of trusting their tags. It
transcribes the opening seconds of a book, extracts the spoken publisher intro — *"Audible
presents **The Shining** by **Stephen King**, narrated by **Campbell Scott**"* — with a local
LLM, then compares what it heard against the file's embedded tags and flags the mismatches.

It's a **standalone sidecar** to [Narratorr](https://github.com/) (Sonarr/Radarr for
audiobooks): point it at a folder, scan, and get a per-book report of what the audio actually
says vs. what the metadata claims. The GPU, if any, lives in the model *services* (Ollama /
Whisper) — the app only makes HTTP calls to them.

## Three rules it won't break

1. **Transcription stays unbiased.** Tags are never fed to Whisper as hints — otherwise it would
   just parrot the (possibly wrong) tags back, and we'd never catch them.
2. **It never hallucinates attribution.** "Couldn't determine" (`attributionPresent: false`) is a
   first-class, book-level outcome, distinct from "the tag is wrong." Story prose with no intro
   yields *no guess*.
3. **Evidence is required.** Every detected field must be backed by the verbatim transcript span
   that justifies it, and that span must actually appear in the transcript — enforced in code, not
   just asked of the prompt. Unsupported fields are nulled; if nothing survives, the book is
   "couldn't determine," never a green "verified."

## How it works

```
discover books → ffmpeg cut intro (offset + silence-trim) → Whisper transcribe
  → Ollama extract {title, author, narrator} (+ evidence spans)
  → read embedded tags → field-specific fuzzy compare → flag mismatches → report
```

Transcripts and extractions are cached (split by audio identity+STT settings and by transcript
hash+model+prompt+schema version), so re-scans skip ffmpeg, Whisper, *and* the LLM for unchanged
files. Reports are flushed to disk incrementally — a scan that dies at book 480 of 500 keeps 480
results. There is **no database**; Earwitness is a transient processor (Narratorr is the system
of record). See [`PLAN.md`](PLAN.md) for the full design.

## Run it (dev)

Requires **Node 24**, **pnpm**, **ffmpeg** on `PATH`, and an **Ollama** instance for extraction.
For transcription you can either point at a Whisper HTTP service *or* use the in-process
transformers.js CPU fallback (zero STT infra — downloads a small model on first scan).

```bash
pnpm install
cp .env.example .env          # then set BROWSE_ROOTS to the folder(s) you want to scan
ollama pull qwen2.5:7b-instruct
pnpm dev                      # server :3000, client :5173
```

Open http://localhost:5173, pick a root folder, and scan. For a fully infra-free first run, set
`WHISPER_BACKEND=transformersjs` (CPU) in `.env`; for quality, point `WHISPER_HOST` at a GPU
Whisper service and use `WHISPER_BACKEND=openai-compat`.

The readiness banner reports whether ffmpeg / Ollama / Whisper are reachable and gates scanning
until they are.

## Configuration

All config is environment variables (`.env` for dev, real env in Docker). See
[`.env.example`](.env.example) for the annotated list. The essentials:

| Var | Default | Purpose |
|---|---|---|
| `BROWSE_ROOTS` | — | Folder(s) the picker may browse/scan (comma-separated, absolute) |
| `OLLAMA_HOST` / `OLLAMA_MODEL` | `localhost:11434` / `qwen2.5:7b-instruct` | Extraction LLM |
| `WHISPER_BACKEND` | `openai-compat` | `openai-compat` / `whispercpp` (HTTP) or `transformersjs` (in-process CPU) |
| `WHISPER_HOST` / `WHISPER_MODEL` | `localhost:8000` / `large-v3-turbo` | Transcription service |
| `EARWITNESS_API_KEY_FILE` | `<cache>/../api-key` | Where earwitness persists its **self-owned** key (minted on first boot, printed once). Override the location, not the source — the key isn't read from env. `/api/*` requires it from the network (`Bearer` or `X-Api-Key`); loopback is trusted |
| `BIND_HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | Pino level. The attribution chain logs at `info`; `debug` adds full transcripts + evidence spans |
| `MAX_CONCURRENT_BOOKS` / `MAX_CONCURRENT_TRANSCRIBES` | `2` / `1` | Concurrency caps |

## Docker

A single image (Node + ffmpeg) builds the React UI and Fastify API and serves both on `:3000`.
A sample GPU-less compose stack brings up the app + Ollama with Whisper running in-process:

```bash
LIBRARY_PATH=/srv/audiobooks docker compose up -d
# → http://<host>:3000  (earwitness mints its key to /data/api-key and logs it once)
```

Full details (app-only vs full-stack modes, GPU, volumes, the name-quality tradeoff of CPU
Whisper) are in [`DOCKER.md`](DOCKER.md).

### Published images

CI ([`.github/workflows/docker.yml`](.github/workflows/docker.yml)) builds a multi-arch
(amd64/arm64) image and pushes to **Docker Hub `narratorr/narratorr-earwitness`** and **GHCR
`ghcr.io/tjiddy/narratorr-earwitness`**:

- **Release** — push a semver tag (`git tag v0.1.0 && git push origin v0.1.0`) → `:latest`, `:0.1.0`,
  `:0.1` + a GitHub Release.
- **Bleeding edge** — run the workflow manually (Actions → *Build & Push Docker Image* → Run) → `:edge`.

Quality gates (lint/typecheck/test/build) run first, and the pushed image is smoke-tested before
the job succeeds. Requires repo secrets **`DOCKERHUB_USERNAME`** and **`DOCKERHUB_TOKEN`**.

## API

All under `/api` (gated for network callers by the self-owned API key; loopback is trusted):

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/health` | Liveness + identity `{ ok, mode, version }` — narratorr's Test Connection probe (auth-gated, so it also validates the key) |
| `POST /api/v1/attribution` | Identify/verify one audiobook by path → `{ detection, comparison? }` (the narratorr integration endpoint) |
| `GET /api/config` | Readiness + mode (paths/hosts shown only to loopback/authed callers) |
| `GET /api/browse?path=` | Browse within `BROWSE_ROOTS` (realpath + symlink containment) |
| `POST /api/scans` | Start a scan `{ source: 'local', root }` → `{ id }` |
| `GET /api/scans/:id` | Live progress |
| `GET /api/scans/:id/results?flagged=` | Per-book results (optionally only flagged ones) |
| `POST /api/scans/:id/cancel` | Cancel an in-flight scan |

## Verify

```bash
pnpm verify   # lint + typecheck + test + build
```

## Status & roadmap

MVP per [`PLAN.md`](PLAN.md). Verified end-to-end against a real 21-book library. Known and
intentional gaps:

- **Tail-sampling is the #1 next feature.** ~71% of the test library had no credit in the first
  60s — Audible commonly puts it at the *end*. Sampling the last ~60s too unlocks most of an
  Audible `.m4b` library.
- **CPU Whisper mangles proper nouns** (the exact author/narrator names we verify). Use a GPU
  `large-v3-turbo` service via `openai-compat` for production accuracy; `transformersjs`/`base.en`
  is the zero-infra fallback.
- **Narratorr integration is contract-only** — the read/write shapes are documented in
  [`src/shared/schemas/narratorr.ts`](src/shared/schemas/narratorr.ts); the client is wired later,
  once Narratorr's endpoints exist.

## License

GPL-3.0-only.
