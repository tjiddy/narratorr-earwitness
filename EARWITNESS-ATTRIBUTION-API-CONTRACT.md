# earwitness ↔ narratorr — Attribution API (Locked Contract)

**Parties:** earwitness ([github.com/tjiddy/narratorr-earwitness](https://github.com/tjiddy/narratorr-earwitness)) · narratorr API team
**Date:** 2026-06-16
**Status:** 🔒 **LOCKED.** earwitness proposed (`EARWITNESS-RESOLVE-API-PROPOSAL.md`, 2026-06-16) → narratorr signed off with one change + six answers (`narratorr:NARRATORR-EARWITNESS-CONTRACT-SIGNOFF.md`, 2026-06-16) → earwitness accepted the change (this doc). Build against this.
**Endpoint:** `POST /api/v1/attribution`
**Supersedes:** `EARWITNESS-RESOLVE-API-PROPOSAL.md`, `NARRATORR-INTEGRATION.md`.
**Amendment (post-sign-off, 2026-06-16 → v0.2.1):** error codes split by retry semantics — `503` is transient-only; permanent per-file failures are `422`. See changelog #5 and §2.
**Amendment (post-sign-off, 2026-06-16 → v0.3.0):** earwitness now **owns its API key** — generated + persisted on first boot, no longer set via an `EARWITNESS_API_KEY` env var. The wire protocol is unchanged (`X-Api-Key`); only **provisioning** changes for narratorr's connector. See changelog #6 and §7.1.
**Amendment (post-sign-off, 2026-06-16 → v0.4.0):** added **`GET /api/v1/health`** — narratorr's Test Connection probe (#1526), which earwitness had never implemented because it was never in this contract. See changelog #7 and §2.

---

## Changelog (proposal → locked contract)

1. **Endpoint renamed** `/api/v1/resolve` → **`/api/v1/attribution`.** `/resolve` only named the import half; "attribution" is honest in both modes (identify *and* verify). narratorr's counter, accepted.
2. **Multi-value fields gain a set breakdown** (`matched` / `missingExpected` / `unexpectedDetected`) on `authors`/`narrators`, alongside the rollup `status`. Lets narratorr tell "subset, all consistent" (no warning) from "contradiction" (warning) on multi-cast books.
3. **`confidence` is returned raw; no hidden threshold.** The evidence-guard stays (correctness — unsupported fields are nulled). A confidence *floor* below which a verdict is ignored is narratorr policy, so earwitness never folds low-confidence into `unknown` behind the scenes.
4. **All six §10 open questions resolved** (§10 below).
5. **Error codes split by retry semantics (amendment → v0.2.1).** A deterministic per-book failure (corrupt/undecodable audio) no longer returns `503`. `503` is now **transient-only** ("retry me"); permanent per-file failures return **`422`** ("don't retry"), alongside the ambiguous-folder case. This restores the invariant `200` ⟺ "I processed the audio," and lets the client decide retry on the **status code alone**. (The original overloaded `503` forced narratorr to guess transient-vs-permanent and bake in a workaround.)
6. **API key is self-owned, not env-provided (amendment → v0.3.0).** earwitness generates a random key on first boot and persists it (default `/data/api-key`, beside the cache dir so a cache wipe can't rotate it), printing it in the boot log. **The wire contract is unchanged — narratorr still sends `X-Api-Key: <key>`** — but *provisioning* changes: instead of an operator setting a shared `EARWITNESS_API_KEY` on both sides, narratorr reads earwitness's minted key (boot log, or `docker compose exec earwitness cat /data/api-key`) into its connector. Auth is enforced for **network** callers only; loopback is trusted. A stale `EARWITNESS_API_KEY` env is ignored (earwitness logs a warning). See §7.1.
7. **`GET /api/v1/health` added (amendment → v0.4.0).** narratorr's Test Connection (#1526) probes `GET /api/v1/health`; earwitness never implemented it because it was a narratorr-side decision that never landed in this contract, so the probe 404'd and narratorr reported "Unable to reach server." earwitness now serves it: `200 { ok, mode, version }`, gated by the same `/api/*` auth — so Test Connection validates the **key** too (wrong key → `401` → narratorr's "Invalid API key"). Liveness + identity only; dependency health stays in `/api/config`. See §2.

---

## TL;DR

- earwitness exposes **one stateless endpoint**, `POST /api/v1/attribution`: a file path (+ optional expected metadata) in → what it heard, with evidence, plus an optional per-field comparison verdict, out.
- **narratorr owns the loop.** On-demand "Ask earwitness" calls it once; the (post-1.0) overnight audit calls the *same* endpoint N times. earwitness never enumerates the library, holds batch state, or calls back.
- **earwitness reports facts + a grounded judgment; narratorr owns interpretation/policy.** We say "title: match, author: match, narrator: mismatch (heard X, tag says Y)"; narratorr decides that's "wrong edition" and what to do.
- The whole earwitness→narratorr direction is parked (no read-client, no narratorr key on our side, no audit-write endpoint, `path`-on-DTO optional). narratorr's 1.0 surface *shrinks*.

---

## 1. Shape of the integration

```
                 on-demand (1 book)        overnight batch (N books, post-1.0)
narratorr UI ──► "Ask earwitness" ──┐      "Audit library" ──► narratorr job worker
                                    │                                  │
                                    └────► POST /api/v1/attribution ◄──┘   (one call per book)
                                                      │
                                          earwitness: ffmpeg ─► Whisper ─► LLM extract
                                                      │         (evidence-guarded)
                                                      ▼
                                       { detection, comparison? }
                                                      │
narratorr stores the OUTCOME ◄────────────────────────┘
(history event + warning flag + reason; full transcript/analysis stays in earwitness)
```

- **One endpoint, three modes** (narratorr will use all three — see §C):
  - **No-Match** → no `expected` → detection only → use `detected` as a metadata-search hint.
  - **Review / low-confidence** → send the shaky guess as `expected` → `comparison` confirms or refutes.
  - **Confident match (audit)** → send canonical tags as `expected` → `comparison` catches a silent wrong-match.
- **earwitness stays a pure function:** path in → attribution out. No crawl, no resume state, no callbacks. (Independently sanity-checked against OpenAI Codex/gpt-5.5, which flagged earwitness-owns-the-batch as "integration creep that fossilizes into a second system of record." Agreed; avoided.)

---

## 2. The endpoint

### `POST /api/v1/attribution`

**Auth:** `X-Api-Key: <earwitness key>` (configured in narratorr's earwitness connector). earwitness owns this key — it generates + persists one on first boot; see §7.1 for how to retrieve it.

**Request:**

```ts
{
  path: string,                 // library-relative POSIX path to the book's audio FILE or FOLDER
  expected?: {                  // narratorr's current belief; omit for a pure "what is this?"
    title?: string,
    authors?: string[],
    narrators?: string[],
  },
  requestId?: string,           // optional, echoed back, for narratorr's own correlation/logging
}
```

- `path` is **relative to the shared library mount** both containers see (see §7.2). earwitness joins it to its configured root and refuses any escape.
- `expected` present ⇒ response includes `comparison`. Absent ⇒ `detection` only.
- File **or** folder accepted (single `.m4b`, or a folder of chapter files).

**Response (200):**

```ts
{
  requestId: string | null,

  // ── DETECTION: what earwitness heard. Always present. Evidence-guarded facts. ──
  detection: {
    attributionPresent: boolean,        // false = no citable spoken credit found (NOT a mismatch)
    detected: { title: string | null, authors: string[], narrators: string[] },
    evidence: {                         // verbatim transcript span backing each field, or null
      title: string | null, author: string | null, narrator: string | null,
    },
    confidence: number,                 // 0..1, RAW. narratorr thresholds per its own policy.
  },

  // ── COMPARISON: present only when `expected` was supplied. The grounded judgment. ──
  comparison?: {
    status: "match" | "mismatch" | "partial" | "unknown",   // overall rollup
    fields: {
      title:     SingleFieldComparison,
      authors:   MultiFieldComparison,
      narrators: MultiFieldComparison,
    },
  },
}

type SingleFieldComparison = {
  status: "match" | "mismatch" | "unknown",
  expected: string | null,
  detected: string | null,
  reason: string,                       // HUMAN-READABLE ONLY. Non-authoritative. DO NOT PARSE.
}

type MultiFieldComparison = {
  status: "match" | "mismatch" | "partial" | "unknown",
  expected: string[],
  detected: string[],
  // Set breakdown — how the two lists reconcile under identity matching:
  matched: { expected: string, detected: string }[],  // pairs judged the same identity
  missingExpected: string[],                           // expected, not heard in the audio
  unexpectedDetected: string[],                        // heard in the audio, not in expected  ← the contradiction signal
  reason: string,                                      // HUMAN-READABLE ONLY. DO NOT PARSE.
}
```

Rollup mapping for a multi-value field: all expected matched & nothing unexpected → `match`; some matched, none unexpected (a consistent subset) → `partial`; anything in `unexpectedDetected` (or a flat contradiction) → `mismatch`; no audio evidence → `unknown`. The overall `comparison.status` rolls the three fields up by severity: `mismatch` if any field mismatches, else `partial` if any is partial, else `match` if any matched, else `unknown`. narratorr applies its own policy on top (§C).

**Status codes:**

| Code | Meaning |
|---|---|
| `200` | Resolved. Always carries `detection`; `comparison` if `expected` was sent. Scanned-but-no-credit is a **200** with `attributionPresent:false`, not an error. |
| `400` | Malformed request (missing/empty `path`, bad body). |
| `401` | Missing/invalid API key. |
| `403` | `path` resolves outside the configured library root (traversal/escape). |
| `404` | No audio file found at `path`. |
| `422` | **Permanent — do not retry.** Either the audio is **undecodable/unprocessable** (corrupt, truncated, unsupported, or no audio in the intro window) **or** `path` is a folder with **multiple distinct books** (ambiguous). The two are told apart by the `error` message (`"unprocessable audio: …"` vs `"path is a folder with N distinct books …"`) — for the human reading the event, *not* for branching. |
| `503` | **Transient — retry with backoff.** Saturated (backpressure), a required dependency (Whisper/Ollama) down, the library mount unavailable, or a transcribe/extract **timeout**. Includes `Retry-After`. |

Errors use earwitness's **`{ error: string }`** envelope — a single human-readable message; the HTTP **status** is the machine-actionable code. (This is flat across every earwitness route, and differs from narratorr's own `{ error: { code, message } }` convention — branch on the status, not the body.)

**Retry semantics (the axis the batch worker cares about):** `200` → use it (incl. `attributionPresent:false` = "processed, no credit"). `503` → transient, retry with backoff. `422` → permanent, surrender this file and surface the message. The client branches on the **status code alone**, never on the error body.

### `GET /api/v1/health`

narratorr's **Test Connection** probe (#1526; added earwitness-side in v0.4.0). Shallow by design — liveness + identity only, **not** dependency health (Ollama/Whisper status lives in `/api/config`). Gated by the same `/api/*` auth as everything else, so a `200` confirms **both** reachability **and** a valid key.

**Request:** no body. Auth: `X-Api-Key` like every `/api/*` call (loopback is trusted, so a same-host probe needs no key).

**Response `200`:**
```json
{ "ok": true, "mode": "standalone", "version": "0.4.0" }
```
`mode` is `"standalone"` or `"narratorr"`; `version` is earwitness's package version. `401` if the key is missing/invalid. narratorr maps `200` → connected, `401`/`403` → "Invalid API key," anything else → "Unable to reach server."

---

## 3. Field mapping

| narratorr | → request |
|---|---|
| the book's file/folder path (internal; narratorr knows it) | `path` |
| current `title` / `authors[].name` / `narrators[].name` | `expected.*` |

| response | → narratorr |
|---|---|
| `detection.detected` / `evidence` / `confidence` | match candidate (import) + stored audit detail |
| `comparison.status` + per-field `status` + breakdown arrays | **machine-actionable signal** — drives warning/CODE policy |
| any `reason` | human display / audit trail only — never branched on |
| `detection.attributionPresent:false` | *unverified* — never a mismatch warning |

---

## 4. The two-stage model (and why it's two stages)

1. **Extraction — blind.** Transcribe the opening audio, then the LLM extracts title/author/narrator **without ever seeing `expected`.** Each detected field must be backed by a verbatim transcript span or it's nulled (evidence-guard). *Don't lead the witness:* if extraction saw the metadata it would hallucinate hearing exactly the tags, destroying earwitness's independence. Output (`detection`) is **frozen fact.**
2. **Comparison — sighted.** A *second* LLM step sees the frozen `detected` values **and** `expected`, judging per field whether they're the same identity. You can't lead a witness who's already testified — the statement is locked, so showing both sides is safe. Temperature 0, cached, and **forbidden from mutating `detection`** — it emits only `comparison`.

The immutability guarantee is load-bearing: the response always carries the **verbatim heard value** beside the verdict, so even if comparison ever over-matches, the raw fact is never hidden — a human or narratorr can see both and overrule.

---

## 5. Comparison semantics

### 5.1 Goal: identity, not string accuracy
The question is **"is this the audiobook narratorr thinks it is?"** — not "is the metadata string-perfect."
- Same human / work, different string → **`match`** ("Ron Artest"≡"Metta World Peace"; "King, Stephen"≡"Stephen King"; "John Ham"≡"John Hamm"; "read by"≡"narrated by"). The LLM's world knowledge is an asset.
- Different human / work → **`mismatch`** (tag "Ray Porter", audio "Jose Bautista"). The signal worth surfacing — usually a wrong import.
- Can't tell → **`unknown`** (no spoken credit for that field, **no `expected` value for that field**, or `attributionPresent:false` overall). A field is only judged when *both* sides have content.

### 5.2 The one guardrail
The only harmful failure is the LLM **fabricating an equivalence** to be agreeable and hiding a real wrong-book. The comparison prompt is instructed: *use knowledge to recognize when two names are the same person, but if they plausibly refer to different people, flag it — never invent a connection to force a match.* Conservative toward **difference**, generous toward **formatting**.

### 5.3 `attributionPresent:false` is not a mismatch
"Couldn't hear a citable credit" ≠ "your tag is wrong." Maps to `status:"unknown"`, never `mismatch`. narratorr commits to rendering it as *unverified*, never a warning (§C.1).

### 5.4 `reason` is quarantined
Free text for a human's eyes (UI tooltip, audit log). **Non-authoritative; consumers MUST NOT parse it.** Everything narratorr acts on is structured: the `status` enums, `expected`/`detected`, and the breakdown arrays. Any distinction narratorr needs programmatically gets **promoted to a structured field** — never smuggled into `reason`.

### 5.5 Facts vs. policy
earwitness will **not** emit conclusions like "correct book, wrong edition" — that's an unprovable inference and it's *policy*, which is narratorr's. earwitness hands the matrix; narratorr maps it (e.g. `title✓ author✓ narrator✗` → its "wrong edition / soft warning"; `title✗ author✗` → "wrong book / hard flag"). narratorr may version/retune its codes without an earwitness release.

### 5.6 "Couldn't process" ≠ "processed, no credit"
A `200` with `attributionPresent:false` means earwitness *did* process the audio and found no citable credit — fall back to folder parsing, and on the on-demand path tell the user "no intro credit, tag it manually." A **corrupt/undecodable file** is a *different* thing: earwitness never got to listen, so it returns **`422`** (permanent), and the user action is "re-rip the file." These drive the same *batch* fallback but different *human* actions on the 1.0 primary (import) path, so they stay distinct: folding "couldn't decode" into `attributionPresent:false` would erase that information exactly where it matters. Keeping `200` ⟺ "I processed the audio" is what preserves it.

---

## 6. The batch use case (narratorr-owned, post-1.0)

narratorr's server-side job worker: enqueue one task per book, call `POST /api/v1/attribution` with bounded concurrency, persist progress, record each outcome as it lands (re-scan replaces prior). No single "audit-everything" mega-request. The browser never holds a call — each can run minutes; server-to-server only, with a generous timeout. earwitness defends itself (§7.4); narratorr respects `503` + `Retry-After`. Synchronous request/response per book suffices; fire-and-forget (`submit → poll`) is an additive future option, not needed now.

---

## 7. Operational contract

### 7.1 Auth
narratorr → earwitness: `X-Api-Key`, the earwitness key configured in narratorr's connector. (earwitness also accepts `Authorization: Bearer <key>` for its own browser UI; narratorr should send `X-Api-Key`.)

**earwitness owns the key — it is not provisioned via env.** On first boot earwitness generates a random key and persists it to `EARWITNESS_API_KEY_FILE` (default `/data/api-key`, alongside the cache dir so a cache wipe can't rotate it), printing it once in the logs. Retrieve it with `docker compose exec earwitness cat /data/api-key` (or grep the boot logs) and paste it into narratorr's connector. To pin a specific key, write that file before first boot. Auth is enforced on the **network**; loopback is trusted, so the local UI/curl work without it.

### 7.2 Paths & mounts
narratorr sends a path **relative to the shared library mount** (both containers bind the same library at the same path, e.g. `/audiobooks`). earwitness joins it to a configured root (`EARWITNESS_LIBRARY_ROOT`, default `/audiobooks`) and **rejects any escape** — realpath + containment, symlink-escape rejection, absolute paths refused unless explicitly enabled (reusing the `discover.ts` guard). Both sides will confirm the mount path matches in the actual compose before launch.

### 7.3 Timeouts
A single call can run minutes (transcribe + extract + compare). narratorr's per-call timeout must accommodate that (configurable). earwitness enforces its own per-stage timeouts so a hung Whisper/Ollama can't wedge a worker.

### 7.4 Concurrency & backpressure
earwitness protects its own hardware: transcribe semaphore + per-book cap + a process-wide `MAX_ACTIVE_SCANS` ceiling returning **`503` + `Retry-After`** when saturated. narratorr drives concurrency and backs off on `503`.

### 7.5 Idempotency / caching
earwitness has a content-addressed two-level cache (transcript + extraction, keyed on file identity + model), so a retry after timeout re-runs **nearly free** (cached transcript/extraction, only the cheap compare re-does). No idempotency key needed for correctness; `requestId` is for narratorr's log correlation only.

---

## 8. Parked (prior direction)
- **`path` on the public book DTO** — optional now; narratorr passes `path` in the call.
- **`POST .../attribution-audit` write endpoint** — not needed; narratorr records outcomes itself.
- **earwitness's narratorr read-client + narratorr key on our side** — built, parked; resurfaces only for a future standalone-auditor mode.

---

## 9. Model / hardware (accepted, gated)
earwitness will default toward a low-spec working set (Gemma-class ~2GB + Whisper `small`/`base`), power users scale up to `qwen2.5:7b` / `large-v3-turbo`; keep `OLLAMA_HOST`/`WHISPER_HOST` offload first-class + documented; low default concurrency to avoid co-resident OOM. **Gated on narratorr's pending E2B-on-CPU benchmark** (per-book latency + extraction-quality diff vs `qwen2.5:7b`) before jointly blessing small as *the* default; the switch is env-overridable regardless. The evidence-guard makes a weak model fail-*safe* (unsupported → nulled → `unknown` → fall back to folder parse, never a wrong import).

---

## 10. Resolved open questions (sign-off)

1. **Name/version** — `POST /api/v1/attribution`, `v1`. ✅
2. **Who owns the comparison** — **earwitness.** narratorr sends `expected`, consumes `comparison`, and will not re-implement name-equivalence. ✅
3. **Multi-value detail** — **breakdown arrays** (`matched`/`missingExpected`/`unexpectedDetected`) + rollup `status`. ✅
4. **`partial`** — earwitness reports `partial` + arrays; **narratorr decides** (consistent subset → no warning; contradiction → warning). ✅
5. **Confidence** — **raw `confidence`**, no hidden threshold; evidence-guard stays; floor is narratorr policy. ✅
6. **Ambiguous folders** — **`422`**, no guessing; narratorr always sends a single book's path. ✅

---

## C. narratorr-side commitments (recorded)
1. **`attributionPresent:false` → unverified, never a mismatch warning.**
2. **Comparison-mode for Review-tier imports, not only No-Matches** (the three modes in §1).
3. **`reason` is display/audit only**; narratorr branches on `status` + arrays exclusively.

---

## 11. Worked examples
All assume `expected` was sent. `detection` abbreviated.

**A. Spelling variant → match**
```jsonc
// expected.narrators ["John Hamm"]; audio "narrated by John Ham"
"narrators": { "status": "match", "expected": ["John Hamm"], "detected": ["John Ham"],
  "matched": [{ "expected": "John Hamm", "detected": "John Ham" }],
  "missingExpected": [], "unexpectedDetected": [],
  "reason": "Same narrator; 'John Ham' is a spelling variant of 'John Hamm'." }
```

**B. Alternate name → match**
```jsonc
// expected.narrators ["Metta World Peace"]; audio "read by Ron Artest"
"narrators": { "status": "match", "expected": ["Metta World Peace"], "detected": ["Ron Artest"],
  "matched": [{ "expected": "Metta World Peace", "detected": "Ron Artest" }],
  "missingExpected": [], "unexpectedDetected": [],
  "reason": "Same person under a former name." }
```

**C. Consistent subset → partial (NOT a warning, per narratorr policy)**
```jsonc
// expected.narrators ["A. Reader","B. Voice","C. Speaker"]; audio only credits the lead
"narrators": { "status": "partial", "expected": ["A. Reader","B. Voice","C. Speaker"], "detected": ["A. Reader"],
  "matched": [{ "expected": "A. Reader", "detected": "A. Reader" }],
  "missingExpected": ["B. Voice","C. Speaker"], "unexpectedDetected": [],
  "reason": "Audio credited only the lead narrator; the other two were not named. No contradiction." }
```

**D. Contradiction → mismatch (the signal)**
```jsonc
// expected.narrators ["Ray Porter"]; audio "narrated by Jose Bautista"
"narrators": { "status": "mismatch", "expected": ["Ray Porter"], "detected": ["Jose Bautista"],
  "matched": [], "missingExpected": ["Ray Porter"], "unexpectedDetected": ["Jose Bautista"],
  "reason": "Different people; no plausible name equivalence." }
// narratorr policy, given title ✓ + author ✓ → "wrong edition / soft warning"
```

**E. No credit heard → unknown (NOT a warning)**
```jsonc
"detection": { "attributionPresent": false, "detected": { "title": null, "authors": [], "narrators": [] }, "confidence": 0 },
"comparison": { "status": "unknown", "fields": {
  "title":     { "status": "unknown", "expected": "The Stand", "detected": null, "reason": "No spoken title credit in the opening audio." },
  "authors":   { "status": "unknown", "expected": ["Stephen King"], "detected": [], "matched": [], "missingExpected": ["Stephen King"], "unexpectedDetected": [], "reason": "No spoken author credit." },
  "narrators": { "status": "unknown", "expected": ["Grover Gardner"], "detected": [], "matched": [], "missingExpected": ["Grover Gardner"], "unexpectedDetected": [], "reason": "No spoken narrator credit." }
}}
```

---

## Build status
- **earwitness — ✅ implemented (2026-06-16; error-code retry-split v0.2.1).** `POST /api/v1/attribution` route, the second (comparison) LLM stage (`src/core/compare-llm.ts`, identity match + deterministic set arithmetic/rollup, temp 0, cached), `EARWITNESS_LIBRARY_ROOT` + path-containment guard (`resolveWithinRoot`), in-flight cap → `503` + `Retry-After`, `X-Api-Key` accepted, and the transient-`503` / permanent-`422` split (ffmpeg-decode failure → `422`, timeout/dependency → `503`, ambiguous middle → transient default). Covered by tests. *Pending:* the small-model default flip (gated on the benchmark).
- **narratorr — pending.** The earwitness connector (toggle + URL + key + test) and the on-demand server-side call; `#1527` branches `200`-use / `503`-bounded-retry / `422`-surrender, `#1528` distinguishes "couldn't process — re-rip" (`422`) from transient (`503`) in the error event. Batch worker deferred post-1.0.

*Reflects earwitness's implementation as of 2026-06-16 (`src/server/routes/attribution.ts`, `src/server/services/attribution.service.ts`, `src/core/compare-llm.ts`, `src/server/paths.ts`, `src/server/config.ts`).*
