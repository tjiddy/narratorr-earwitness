> [!WARNING]
> **SUPERSEDED (2026-06-16) by [`EARWITNESS-ATTRIBUTION-API-CONTRACT.md`](./EARWITNESS-ATTRIBUTION-API-CONTRACT.md) (the locked contract).**
> This document describes the original "earwitness pulls the library and POSTs audits back" direction.
> After narratorr's 2026-06-15 direction doc, the integration inverted: **narratorr calls a single
> stateless earwitness `POST /api/v1/attribution` endpoint** and owns the loop. The asks below (`path` on
> the book DTO, the `attribution-audit` write endpoint) are now **parked/optional**, not blockers. Kept for
> historical context and the §4.3 reasoning, which still holds. Read the contract instead.

---

# Narratorr ↔ Earwitness — API Integration Handoff

**For:** the Narratorr API team
**From:** Earwitness ([github.com/tjiddy/narratorr-earwitness](https://github.com/tjiddy/narratorr-earwitness))
**Status:** ⚠️ Superseded — see banner above.

---

## TL;DR — what we need from you

1. **Add a file `path` to `GET /api/v1/books`** (per-book, nullable). Earwitness can't locate the audio to scan without it. *(Blocker for read-mode.)*
2. **Add an attribution-audit write endpoint** — `POST /api/v1/books/:publicId/attribution-audit` (idempotent upsert, schema in §4.2). *(Blocker for write-back.)*
3. **Decide how to surface a discrepancy** — a derived "needs review" indicator, or a separate `attributionStatus` field. **Do not add it to the lifecycle `status` enum** (reasoning in §4.3).

Everything else (the books list, auth, pagination, envelopes) already exists and we'll conform to it.

---

## 1. What Earwitness is

Earwitness identifies audiobooks by **listening** rather than trusting tags. It transcribes the opening seconds of a book (Whisper), extracts the spoken publisher intro — *"Audible presents **The Shining** by **Stephen King**, narrated by **Campbell Scott**"* — with a local LLM, then compares that against the embedded tags and flags discrepancies. It is **evidence-required**: every detected field must be backed by a verbatim transcript span, or it's dropped.

It's a standalone sidecar. Narratorr is the system of record; Earwitness is a transient processor that emits per-book audits. It already runs against a local folder; this doc is about wiring it to Narratorr.

## 2. How the integration works (two seams)

- **Read (source).** Earwitness pulls the list of `imported` books from Narratorr, and for each one with a known file path, scans the audio.
- **Write (sink).** For each book, Earwitness POSTs back an **attribution audit** — what it heard, the evidence, and any field-level discrepancies. Narratorr surfaces books with a flagged audit for the user to review.

Two run modes: **standalone** (browse a mounted folder — works today) and **narratorr** (pull the worklist from the API, post audits back — this integration). Mode auto-selects when `NARRATORR_URL` + `NARRATORR_API_KEY` are configured.

```
Narratorr  --GET /api/v1/books (imported, +path)-->  Earwitness
Earwitness --(ffmpeg → Whisper → LLM → compare)-->   audit
Earwitness --POST .../attribution-audit----------->  Narratorr  --> "needs review" badge/filter
```

## 3. What already exists (verified against the code, 2026-06-14)

### Library list — `GET /api/v1/books` ✅
`src/server/routes/v1/books.ts`, schema `src/shared/schemas/v1/books.ts`.

- Query: `limit` (1–500), `offset` (≥0), `status` (`imported` etc.), plus `author/narrator/series/sortField/sortDirection`.
- Response envelope: `{ data: BookV1[], total }` (`src/shared/schemas/v1/common.ts`).
- `BookV1`: `{ id: string /*publicId*/, title, authors: {id,name}[], narrators: {id,name}[], series: {name, position|null}|null, status }`.

This is great and we'll consume it as-is **except** it's missing `path` (§4.1).

### Auth — `X-Api-Key` ✅
`src/server/plugins/auth.ts`, `src/server/services/auth.service.ts`. UUID key generated in Narratorr settings (DB, not env), sent as `X-Api-Key: <key>` (or `?apikey=`), validated with a timing-safe hash compare, scoped to `/api/v*` routes. Earwitness will send the configured key as `X-Api-Key`. No change needed.

## 4. What's missing / what we need built

### 4.1 `path` on the book read — **BLOCKER**

`BookV1` returns title/people/series/status but nothing that locates the audio on disk. Earwitness needs the file (or folder) path to transcribe it.

**Ask:** add a nullable `path` to `BookV1`:

```typescript
// add to bookV1Schema
path: z.string().nullable(),   // absolute path to the book's audio file OR folder, as Narratorr sees it; null if unknown/missing
```

- Folder *or* file is fine — Earwitness's discovery handles both (single `.m4b`, or a folder of chapter files).
- **Mount expectation:** the path must be valid inside Earwitness's container. In the deployed compose both services bind the same library at the same container path (`/audiobooks`), so a path like `/audiobooks/Stephen King/The Stand` resolves directly. If your container path differs, tell us and we'll translate, but matching mounts is simplest.
- Earwitness **skips and reports** books with `path: null` (can't scan what it can't find).

### 4.2 Attribution-audit write endpoint — **BLOCKER for write-back**

No endpoint to record a per-book attribution result exists today (only `search`/`grab` are v1 writes; the internal `PUT /api/books/:id` overwrites metadata, which is the wrong tool — we do **not** want Earwitness mutating the library's canonical metadata).

**Ask:** `POST /api/v1/books/:publicId/attribution-audit`, **idempotent** — upsert the *latest* audit per book (a re-scan replaces the prior one).

Request body (mirror your `.strict()` v1 style):

```typescript
export const attributionAuditInputSchema = z.object({
  scanId: z.string(),                  // Earwitness scan-run id (uuid)
  scannedAt: z.string(),               // ISO-8601
  attributionPresent: z.boolean(),     // false = intro had no citable attribution ("couldn't determine") — NOT the same as a mismatch
  detected: z.object({                 // what Earwitness heard (evidence-backed only)
    title: z.string().nullable(),
    authors: z.array(z.string()),
    narrators: z.array(z.string()),
  }),
  confidence: z.number().min(0).max(1),
  evidence: z.object({                 // verbatim transcript spans justifying each field
    title: z.string().nullable(),
    author: z.string().nullable(),
    narrator: z.string().nullable(),
  }),
  flags: z.array(z.object({            // field-level discrepancies vs the tags
    field: z.enum(['title', 'author', 'narrator']),
    tagValue: z.string().nullable(),
    detectedValue: z.string().nullable(),
    similarity: z.number().min(0).max(1).nullable(),
    severity: z.enum(['mismatch', 'missing_tag', 'low_confidence']),
  })),
  models: z.object({ stt: z.string(), llm: z.string() }),  // provenance, e.g. { stt: "large-v3-turbo", llm: "qwen2.5:7b-instruct" }
  transcriptExcerpt: z.string().nullable(),
}).strict();
```

- **Response:** `200` with the stored audit (echo + any server-side `id`/`updatedAt`), in your single-resource envelope convention; or `204` if you'd rather not echo.
- **Errors:** your `{ error: { code, message } }` envelope — `404` unknown `publicId`, `401` bad/missing key.
- **Storage:** one latest audit per book (a column/JSON blob or a `book_attribution_audit` row keyed by book id). History isn't required for v1 (see open questions).

### 4.3 Surfacing the discrepancy — **design decision (your call)**

We want flagged books visible in the Narratorr UI. **Please don't encode this in the lifecycle `status` enum** (`wanted → … → imported`). A discrepancy is an *annotation on an already-imported book*, not a lifecycle stage. Folding it into `status` is destructive (you'd lose `imported`), can't coexist with `imported`, and a bare label can't carry the audit detail.

Two clean options:

- **Option A — derived indicator (recommended to start).** Compute `hasAttributionWarning` from "latest audit has any `flags`" (and/or `attributionPresent === false`, your policy). Expose it as a book field + a `?attributionWarning=true` filter. No new stored state; auto-clears when a clean re-scan replaces the audit.
- **Option B — separate field.** Add `attributionStatus: 'ok' | 'warning' | 'unverified' | 'error' | null` on the book, orthogonal to `status`, set when an audit is posted. First-class queryable/sortable; costs a migration and explicit clear-on-resolve.

Either keeps lifecycle `status` clean. We lean A unless you want it queryable/sortable, then B.

## 5. Field mapping

| Narratorr `BookV1` | → Earwitness |
|---|---|
| `id` (publicId string) | book ref / audit target |
| `title`, `authors[].name`, `narrators[].name` | the "tagged" values to compare against |
| `path` *(requested §4.1)* | audio location to transcribe |
| `status` | filter to `imported` |

| Earwitness audit | → Narratorr |
|---|---|
| `detected` / `evidence` / `confidence` | stored audit detail |
| `flags[]` | drives the warning indicator (§4.3) |
| `attributionPresent: false` | "couldn't determine" (distinct from mismatch) |
| `models` | provenance (which STT/LLM produced it) |

## 6. Conventions we'll follow

Offset/limit pagination · opaque `publicId` strings · `{ data, total }` list envelope · `X-Api-Key` auth · `{ error: { code, message } }` errors · `.strict()` schemas. We mirror your v1 surface exactly.

## 7. Open questions

1. **Path representation / mounts** — return Narratorr's own path and we match the mount, or do you want us to send a library-relative path?
2. **Does `attributionPresent: false` count as a warning?** Our view: surface it as a *separate* "unverified" state, not a "mismatch" warning (we couldn't hear a credit ≠ the tag is wrong). Your `attributionStatus` enum in Option B captures both.
3. **Audit history vs latest-only** — we assume latest-only (upsert). Want a history table?
4. **Batch/rate** — a single library scan POSTs one audit per book. Any rate limits or a bulk endpoint you'd prefer at large library sizes?

## 8. What Earwitness will do on its side

Once §4.1 lands we can ship **read-only mode** (pull `imported` books → scan → local report) even before the write endpoint exists. Once §4.2 lands we wire the post-back. We'll build the client against the schemas above with an HTTP mock now, so flipping it on is config-only when your endpoints ship. Auth is already accounted for (`X-Api-Key`).

---

*Schemas/citations reflect a read of the Narratorr codebase on 2026-06-14; adjust paths if the code has moved.*
