# Earwitness — MVP Plan

> Pre-implementation architecture plan. Reviewed by Codex (gpt-5.5) — its accepted points are folded
> in; see **"Review changelog"** at the bottom.

## Context

**Earwitness** identifies audiobooks by *listening* rather than trusting tags: it transcribes the
opening ~60s of a book and extracts `{title, author, narrator}` from the spoken publisher intro
("Simon & Schuster presents *The Shining* by Stephen King, narrated by Ray Porter"), then compares
that against the file's embedded tags and flags discrepancies.

It is a **Narratorr-adjacent** tool with two run modes:
- **Standalone** — user browses a mounted folder, picks a root, scans it. *(built tonight)*
- **Narratorr-integrated** — an API key pulls the work list from Narratorr's library API and posts a
  per-book audit back. *(seam + contract documented tonight, wired up later — Narratorr's APIs are
  being built in parallel and don't exist yet)*

**Hard constraints** (from the user):
- TypeScript everywhere; **mirror the Narratorr architecture** (`C:\Users\Todd\Code\narratorr`) *where
  it makes sense* — Fastify, zod everywhere, Vitest, strict tsconfig, Vite/React.
- **No database.** A scan is a transient batch job that emits a report; Narratorr is the system of
  record. Job state lives in-memory (mirrors Narratorr's in-memory `MatchJobService`); the only
  persistence is a file cache + an incrementally-flushed report.
- **No laptop-specific architecture.** Runs portably in a Docker container — no assumed GPU, no
  native CUDA compile, no Python *in the app*. GPU lives in the model *services'* config, not the app.

## Pipeline

`source (folder | Narratorr) → discover books → ffmpeg cut intro (offset + silence-trim) → Whisper transcribe → Ollama extract (+evidence) → read tags → field-specific fuzzy compare → result (flushed incrementally) → React report`

**Three design rules that matter:**
1. **Transcription stays unbiased** — we do NOT feed embedded tags to Whisper as hints. If we did,
   it would parrot the tags back and we'd never catch the wrong tags we exist to catch.
2. **Never hallucinate attribution.** `attributionPresent: false` (book-level) is a first-class
   outcome, distinct from "tag is wrong." If the intro is just story prose, we say "couldn't
   determine" — we do not guess.
3. **Evidence required.** The extractor must return the short transcript span that justifies each
   field (or null). No citable span ⇒ confidence drops / `attributionPresent=false`. This is the
   primary anti-hallucination guard — more reliable than a bare confidence number.

## Stack decisions

| Concern | Choice | Why |
|---|---|---|
| STT (Whisper) | **External Whisper HTTP service** behind a pinned `TranscribeProvider` interface, with a **per-backend adapter** | whisper.cpp-server (`/inference`) and OpenAI-compatible servers (`/v1/audio/transcriptions`) do **not** share an API, so we define our own request/response contract and adapt. App stays pure-TS, calls `WHISPER_HOST`. **GPU is the service's concern, not the app's.** Model by profile: GPU→`large-v3-turbo`, CPU→`small/medium` (turbo on CPU is brutal). transformers.js is a **dev/CPU-only fallback, not a co-equal path.** |
| Extraction LLM | **Ollama** via configurable `OLLAMA_HOST` | Host-agnostic HTTP, native JSON-schema structured output, honors "local". Default `qwen2.5:7b-instruct` (must be `ollama pull`-ed), configurable. |
| Audio cut | **ffmpeg** via `child_process` | Mirrors Narratorr's `src/core/utils/audio-processor.ts` spawn pattern (stream stderr, AbortSignal). Cut `INTRO_SECONDS` starting at `INTRO_OFFSET_SECONDS`, with leading silence/music trim (`silenceremove`). Resolve path via `FFMPEG_PATH` → PATH lookup (NOT hardcoded `/usr/bin/ffmpeg`). |
| Tag reading | **`music-metadata`** (TS) | Native equivalent of mutagen; reads m4b/mp3/m4a/flac + iTunes atoms (narrator commonly in composer/`©wrt`). |
| Fuzzy compare | **field-specific** normalize + Jaro-Winkler/Dice (`talisman`/`fastest-levenshtein`) | Title, author, narrator are different beasts; names need token/initial handling ("Ray" vs "Raymond" Porter) and **multi-person set matching** (authors/narrators are arrays in Narratorr). |

## Architecture — mirror Narratorr (single pnpm package)

```
src/
  client/        # Vite + React
    pages/       ScanSetup, ScanProgress, Results
    components/  FolderPicker, ResultsTable, FlagBadge, ReadinessBanner
    api.ts
  server/        # Fastify + zod-type-provider (mirror src/server/index.ts bootstrap)
    index.ts     config → CORS → error handler → registerRoutes → start worker → listen
    config.ts    env loading (mirror Narratorr config.ts)
    routes/      index.ts (registerRoutes), scans.ts, browse.ts, config.ts
    services/    scan-job.service.ts  (in-memory job Map + TTL + semaphore; mirror MatchJobService)
  core/
    sources/     types.ts (WorkSource iface), local-folder.ts  [narratorr.ts = documented stub]
    discover.ts  walk root → Book[] (folder-book grouping, natural sort, pick + justify intro track)
    ffmpeg.ts    portable ffmpeg path resolution
    audio.ts     cut intro (offset + silence-trim) → 16k mono PCM (spawn, AbortSignal)
    transcribe/  provider.ts (TranscribeProvider iface) + adapters (whispercpp.ts | openai-compat.ts | transformersjs.ts dev-only)
    extract.ts   Ollama HTTP + JSON-schema → {title,author,narrator,publisher,confidence,attributionPresent,evidence}
    tags.ts      music-metadata → embedded {title,authors[],narrators[],...}
    compare.ts   field-specific normalize + multi-person fuzzy → flags
    cache.ts     SPLIT caches: transcript (audio identity + STT settings) | extraction (transcript hash + LLM + prompt ver)
    store.ts     report writer — flushes each BookResult as it completes → reports/<scanId>.json
    pipeline.ts  per-book orchestration (cache lookup → ... → flush result)
  shared/
    schemas/     zod: scan, browse, book-result, flag, extraction, narratorr-contract  + schemas.ts barrel
```

**Conventions copied from Narratorr:** strict tsconfig (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ESM/bundler, `@/`,`@core/` aliases); zod
schemas in `src/shared/schemas/`; Fastify zod type provider; in-memory job Map + frontend polling
(no WebSocket for MVP); `getErrorMessage` util; Vitest (client jsdom / server node); scripts
(`dev` = concurrently server+client via `tsx watch` + `vite`, `build`, `start`). **Deliberate
divergence:** no Drizzle/SQLite — earwitness is a transient processor, not a system of record.

## State, caching & concurrency (no DB)

All zod-typed (`src/shared/schemas/`), shared verbatim between server and client.

- **In-memory job** (`ScanJob`, held in `scan-job.service`): `{ id, source, root, status
  (pending|discovering|processing|completed|failed|cancelled), total, processed, currentBook,
  results: BookResult[], error }`. TTL-cleaned like Narratorr's `MatchJobService`.
- **`BookResult`**: `{ name, sourcePath, introTrackPath, introTrackReason, attributionPresent,
  detected:{title,authors[],narrators[]}, confidence, evidence, tags:{title,authors[],narrators[]},
  flags: Flag[], transcriptExcerpt }`.
- **`Flag`** (field-level only): `{ field: title|author|narrator, tagValue, detectedValue,
  similarity, severity: mismatch|missing_tag|low_confidence }`. **`no_attribution` is NOT a flag** —
  it's the book-level `attributionPresent=false` state, surfaced separately in the UI.
- **Split file cache** (`core/cache.ts`, under `CACHE_DIR`):
  - *transcript* keyed by `sha(introTrackPath|size|mtimeMs|offset|seconds|sttModel|sttSettings)`
  - *extraction* keyed by `sha(transcriptHash|llmModel|promptVersion|schemaVersion)`
  Re-scans skip ffmpeg+Whisper *and* the LLM for unchanged inputs; crash-resume is cheap.
- **Incremental report** (`core/store.ts`): each `BookResult` is appended/flushed to
  `reports/<scanId>.json` as it completes — a 500-book scan that dies at book 480 keeps 480 results.
- **Concurrency** (config, NOT hardcoded): `MAX_CONCURRENT_BOOKS` (default 2), `MAX_CONCURRENT_TRANSCRIBES`
  (default 1 — single GPU serializes anyway), extraction effectively serial via Ollama. Semaphore
  pattern lifted from Narratorr's `MatchJobService`, tuned **lower** because STT/LLM are heavy.

## Server endpoints

- `GET  /api/config` → `{ mode, browseRoots, ollama:{reachable,model}, whisper:{reachable,model}, ffmpeg:{ok} }`
  — UI readiness banner (warn if any dependency missing).
- `GET  /api/browse?path=` → `{ parent, entries:[{name,path,isDir}] }`. **Containment via `fs.realpath`
  + symlink resolution + case-fold on Windows** (not string-prefix) against `BROWSE_ROOTS`.
- `POST /api/scans` `{ source:'local', root }` → validate root ∈ browseRoots, create scan, start
  async worker, return `{ id }`.
- `GET  /api/scans/:id` → progress (`status,total,processed,currentBook`) — frontend polls.
- `GET  /api/scans/:id/results?flagged=` → results + flags (also readable from `reports/<id>.json`).
- `POST /api/scans/:id/cancel` → AbortSignal into the worker.

## Extraction (Ollama)

System prompt: extract attribution from the opening-seconds transcript; **if no publisher/title/
author/narrator attribution is present (just story prose), set `attributionPresent=false` and leave
fields null — do not infer from story content. For every non-null field, return the verbatim
transcript span that justifies it.** Ollama `format` = JSON schema for
`{ attributionPresent:boolean, title, author, narrator, publisher: string|null, confidence:0..1,
evidence:{title?:string, author?:string, narrator?:string} }`.

## Frontend (Vite/React)

- **ScanSetup** — readiness banner; standalone folder picker (`/api/browse`); "Start scan".
- **ScanProgress** — poll `/api/scans/:id`, X/Y + current book.
- **Results** — table per book: detected vs tagged `{title,authors,narrators}` side-by-side,
  confidence, **separate "no attribution" state** vs field flag badges (`mismatch` / `missing_tag` /
  `low_confidence`), expandable transcript snippet + evidence spans + chosen-intro-track reason.
  Filter "only flagged", sort by severity.

## Narratorr integration contract (documented tonight, built later — hand to workflume)

- **Read (source) — CORRECTED against the real schema:**
  `GET {NARRATORR_URL}/api/library/books?limit&offset&status=imported` returns
  **`LibraryBookListResponse { data: LibraryBookListItem[], total }`** (paginated — NOT a bare
  array). Each item: `{ id, title, authors[].name, narrators[].name, path (NULLABLE), audio* }`. See
  `C:/Users/Todd/Code/narratorr/src/shared/schemas/library-book.ts:12`. Earwitness paginates, **skips
  / flags books with null `path`**, maps the rest → `BookRef`. Auth: `Authorization: Bearer
  {NARRATORR_API_KEY}` *(exact auth TBD — coordinate with workflume)*.
- **Write (sink) — PROPOSED, needs workflume to build (idempotent per-book audit, NOT per-flag):**
  `POST {NARRATORR_URL}/api/library/books/:id/attribution-audit` with one payload:
  `{ scanId, attributionPresent, detected:{title,authors[],narrators[]}, confidence, evidence,
  models:{stt,llm}, flags:[{field,tagValue,detectedValue,similarity,severity}] }`. Narratorr
  upserts/replaces the latest audit for that book.
- `WorkSource` interface (`core/sources/types.ts`) has `LocalFolderSource` now; `NarratorrApiSource`
  is the later drop-in. The reporter sink is likewise an interface (local report now, Narratorr POST later).

## Config (env — host-agnostic)

`MODE` (auto: narratorr if URL+key set, else standalone) · `BROWSE_ROOTS` · `OLLAMA_HOST` · `OLLAMA_MODEL` ·
`WHISPER_HOST` · `WHISPER_MODEL` · `INTRO_SECONDS` (default 60) · `INTRO_OFFSET_SECONDS` (default 0) ·
`MAX_CONCURRENT_BOOKS` (2) · `MAX_CONCURRENT_TRANSCRIBES` (1) · `FFMPEG_PATH` (optional) · `CACHE_DIR` ·
`REPORTS_DIR` · `NARRATORR_URL` / `NARRATORR_API_KEY`.

**Native dev** defaults to `localhost`. **Compose** examples must use service hostnames
(`http://ollama:11434`, `http://whisper:8000`) — `localhost` inside a container is wrong.

**Deployment = a docker-compose stack, not one image.** Three sibling services — `earwitness`
(Node + `apt install ffmpeg`), `ollama`, `whisper` — on a private network; GPU reserved for
`ollama` + `whisper` via `deploy.resources.reservations.devices` (graceful CPU fallback on
GPU-less hosts). Volumes: library (read-only), Ollama models, Whisper models, cache + reports.
`docker compose up` is the one-command bring-up. Docker *build* is a fast-follow; **tonight we dev
native** (`pnpm dev`) against locally-run `ollama` + a local Whisper server.

## Build order (tonight)

1. **Scaffold** — package.json, tsconfig, vite/vitest configs, dirs, `.env.example` (mirror Narratorr).
2. **Shared + cache** — zod schemas (`src/shared/schemas/`), `config.ts`, split `core/cache.ts` + `core/store.ts`.
3. **Stand up dev services** — local Ollama (`ollama pull` the extract model) + a local Whisper HTTP
   server; confirm GPU is used (or CPU-fallback works) before wiring the app.
4. **Vertical slice** — discover → ffmpeg → transcribe (remote Whisper) → extract (Ollama) → tags →
   compare on ONE book via a tiny script, to de-risk the two services + the `TranscribeProvider`
   adapter before building breadth.
5. **Core** — finish `core/*` modules + `pipeline.ts` (caching, concurrency semaphore, incremental flush).
6. **Server** — config, Fastify bootstrap, routes (config, browse w/ realpath containment, scans), scan-job service.
7. **Client** — folder picker, scan trigger, progress, results table.
8. **Wire + verify** end-to-end against a real folder.

## Verification

- **Unit (Vitest):** `discover` grouping/natural-sort + chosen-track reason; `compare` field-specific
  + multi-person ("Ray Porter" vs "Raymond Porter" ⇒ not flagged; "Stephen King" vs "Dean Koontz" ⇒
  mismatch; ["A","B"] narrators set matching); `extract` returns `attributionPresent:false` + no
  evidence on prose-only transcript (mock Ollama); browse rejects `..`/symlink escapes.
- **End-to-end:** `pnpm dev`, browse to a real audiobook folder (mix of clean-intro and stripped),
  scan, confirm: clean books resolve high-confidence with evidence spans; stripped books show
  book-level `no_attribution` (not field flags); tag mismatches flag correctly; chosen-intro-track
  reason is sane. Re-run → transcript + extraction served from split caches.
- **Readiness preflight:** `GET /api/config` reports ffmpeg ok, Ollama reachable + model present,
  Whisper service reachable.

## Risks / unknowns to validate during the slice

- Whisper service GPU/Blackwell (sm_120) support — whisper.cpp (ggml CUDA) vs faster-whisper
  (ctranslate2); validate during the slice. CPU profile (smaller model) keeps us unblocked.
- Ollama JSON-schema `format` output reliability + evidence-span quality with the chosen model.
- **Intro detection** is MVP-naive (first natural-sorted track, offset+silence-trim). Known
  unsolved: retail-sample files, multi-disc sets, chapter-aware M4B picking. We **surface the chosen
  track + reason** so a human catches bad picks rather than pretending it's solved.
- Whisper proper-noun mangling on uncommon names → why `compare` is fuzzy + field-specific from day one.

## Review changelog (Codex gpt-5.5, read-only)

Accepted: corrected Narratorr read contract (`{data,total}` + nullable path + pagination); write-back
as idempotent per-book audit; `no_attribution` as book-level state not a field flag; evidence-span
anti-hallucination guard; split transcript/extraction caches + incremental report flush; concurrency
as first-class low-default config; pinned `TranscribeProvider` + per-backend adapters with
transformers.js demoted to dev-only; model-by-profile; realpath/symlink/case-fold browse containment;
compose service-hostname defaults; field-specific multi-person comparison. Scoped down: full
intro-detection robustness deferred (cheap wins taken: offset, silence-trim, chosen-track provenance).
