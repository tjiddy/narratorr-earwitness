---
name: full-scan
description: >-
  Run a complete earwitness library audit end-to-end against narratorr's catalog:
  scaffold the local GPU stack, dump the book list, transcribe + attribute every
  book, adjudicate the mismatches (pairwise recovery → cause classification), build
  the glorious HTML report, then tear down and clean up. Trigger when Todd says
  "do a full scan", "audit the library", "re-audit", or "/full-scan". Optional arg
  "fresh" forces a full re-transcribe (default is incremental, cache-reuse).
---

# Full library scan

One command → the whole audit pipeline. When invoked, execute these phases in order,
driving and monitoring each step. This is an **operator playbook for you (the agent)**,
not an autonomous script — you run the commands, watch for the known failure modes,
and apply the human-judgment gate in Phase 5.

**Stack:** local on host `YODA` (RTX 5090). speaches (faster-whisper large-v3) in Docker
on :8000 · ollama (gemma4) native on :11434 · earwitness on :3000 · audio at `Z:/`
(mapped to `\\jabba\audiobooks`). Loopback bypasses earwitness auth.

**Modes:**
- **incremental (default)** — reuse earwitness's transcript cache. Safe because the
  transcript cache key includes the file's `(size, mtimeMs)` (`cache.ts:fileIdentity`,
  fed in `pipeline.ts`): a re-downloaded / different edition has a different byte size →
  cache miss → re-transcribe → the new narrator IS caught. Unchanged files are cache hits
  (fast). The per-scan `audit-results.jsonl` is always rebuilt so every book is re-judged.
- **`fresh`** — additionally wipe the earwitness transcript cache first → full re-transcribe
  of all books (~hours on the 5090). Use only when the Whisper model or pipeline changed.

**Product stance (non-negotiable):** false positives are the cardinal sin; precision over
recall. NEVER report "the catalog is wrong" on the raw matcher's verdict — the raw mismatch
count is ~80% speech-to-text noise. The adjudication + the Phase-5 human gate exist to keep
false accusations out of the report.

Set a working dir once and reuse it for all phases:
```
SKILL=.claude/skills/full-scan
AUDIT_DATA=scratch/audit/data        # gitignored; persists the per-scan jsonl + report
```

---

## Phase 0 — Preflight / scaffold the stack

1. **Z: drive** — `Test-Path Z:/`; if missing: `net use Z: \\jabba\audiobooks /persistent:yes`
   (jabba is on the home LAN, no VPN). If jabba is unreachable, stop and tell Todd.
2. **speaches** — `docker start speaches`, then poll `http://localhost:8000/v1/models` until 200
   (model reload ~10–60s). If the container doesn't exist, create it (`--gpus all`, publish 8000,
   the persisted models volume). Ensure `Systran/faster-whisper-large-v3` is installed
   (`POST /v1/models/Systran/faster-whisper-large-v3` if absent — speaches does NOT auto-download).
3. **ollama** — confirm `gemma4:latest` is present (`ollama list`). Use gemma4 — it is the
   gold-review-validated model; do not swap it.
4. **earwitness :3000** — ensure the GPU env is active. Back up the current `.env`
   (`cp .env scratch/audit/.env.prescan`) then write the scan config:
   ```
   WHISPER_BACKEND=openai-compat
   WHISPER_HOST=http://localhost:8000
   WHISPER_MODEL=Systran/faster-whisper-large-v3
   OLLAMA_MODEL=gemma4:latest
   EARWITNESS_LIBRARY_ROOT=Z:/
   ```
   Start the server in the background: `pnpm exec tsx src/server/index.ts`. Confirm it answers
   on :3000 (any route; a 404 means it's up).
5. **`fresh` mode only** — wipe the earwitness transcript cache now (the `.earwitness/` cache dir)
   so every book re-transcribes.

## Phase 1 — Dump the book list

Dump narratorr's imported books through the container's libSQL (no sqlite3 CLI). Base64 the
dump script so quoting survives the host→ssh→container→node boundary:
```
mkdir -p $AUDIT_DATA
B64=$(base64 -w0 $SKILL/scripts/dump-books.mjs)
~/.claude/scripts/docker-exec.sh --container narratorr "cd /app && echo $B64 | base64 -d | node" \
  > $AUDIT_DATA/audit-books.json
```
Sanity-check the count (`node -e "console.log(JSON.parse(fs.readFileSync('...')).length)"`).
Expect ~430+. **Schema drift:** if the dump errors on an unknown table/column, introspect live —
`docker-exec --container narratorr "cd /app && node -e \"const {createClient}=require('@libsql/client');const db=createClient({url:'file:/config/narratorr.db'});db.execute('PRAGMA table_info(books)').then(r=>console.log(r.rows))\""` — and adjust `dump-books.mjs` (books / book_authors+authors / book_narrators+narrators).

## Phase 2 — Execute the scan

Archive any previous run's jsonl into a timestamped folder first (so the driver re-runs every
book; transcribe is served from cache where the file is unchanged):
```
# if $AUDIT_DATA/audit-results.jsonl exists → move it + adjudication.jsonl + reclassify.jsonl
#   into $AUDIT_DATA/archive/<stamp>/
AUDIT_DATA=$AUDIT_DATA CONCURRENCY=2 REQ_TIMEOUT_MS=600000 node $SKILL/scripts/run.mjs
```
Run it in the background and monitor; it prints `[n/total] STATUS  Author/Title` per book and is
**resumable** (re-running skips ids already in `audit-results.jsonl`). Progress =
`(Get-Content $AUDIT_DATA/audit-results.jsonl).Count` / total.

**Known failure — speaches segfault (exit 139):** under sustained load speaches dies (`fetch failed`
errors, sub-second per book). When you see it: `docker start speaches`, wait for :8000, strip the
errored lines from `audit-results.jsonl` (they get recorded as `error`), and re-run at
**`CONCURRENCY=1`** (gentler — it survived at 1 last time). The corrupt-file case is different: an
HTTP 422 "ffmpeg failed" is a genuinely unreadable m4b — leave it errored, don't retry forever.

## Phase 3 — Adjudicate (the precision layer)

The raw verdict over-reports mismatches (gemma4 under-pairs multi-narrator lists in one shot).
Recover pairwise, then classify the genuine contradictions:
```
AUDIT_DATA=$AUDIT_DATA node $SKILL/scripts/adjudicate.mjs    # → adjudication.jsonl
AUDIT_DATA=$AUDIT_DATA node $SKILL/scripts/reclassify.mjs    # → reclassify.jsonl
```
- `adjudicate.mjs`: pairwise name recovery → CLEAN (false mismatch, catalog right) / PARTIAL_OK
  (consistent subset) / INCONCLUSIVE (still contradicts).
- `reclassify.mjs`: sharp re-judge of the contradicting INCONCLUSIVE → EDITION_MISMATCH /
  EXTRA_CONTRIBUTOR (foreword/author/guest — catalog still right) / GARBLE.

## Phase 4 — Build the report

```
AUDIT_DATA=$AUDIT_DATA AUDIT_OUT=scratch/audit/earwitness-audit-report.html \
  node $SKILL/scripts/report.mjs
```
Consolidates all three jsonl + the hand-verified curation overrides into a self-contained HTML
report (design: Playfair Display + DM Sans + amber + IBM Plex Mono, dark glass). It prints the
final tally and asserts the category counts sum to the book total.

## Phase 5 — Human-judgment gate (do NOT skip)

The auto-classified `EDITION_MISMATCH` list still contains false positives the classifier can't
catch — a **producer/director intro** ("this is X, director of …"), an **author interview** bonus
segment, or the **author's own name** misheard as a narrator. These are same-surname / role-word
traps. Before trusting the report:
1. Read every `EDITION_MISMATCH` entry's verbatim `heardCredit` (the report shows it).
2. For each, ask: *is this actually a "narrated by / read by X" credit naming a different real
   person?* If it's a producer line, an interview, the author, or a fragment → it's a FALSE ALARM,
   the catalog is right.
3. Update the curation overrides at the top of `scripts/report.mjs` (`FALSE_ALARM`,
   `GARBLE_RESCUE` for real mismatches the sharp pass misfiled as GARBLE, `TIER2_AUTHOR_NARRATED`,
   `NEEDS_LISTEN`), then rebuild (Phase 4). These overrides are library-specific and accumulate
   across scans — they encode verified human judgment, so review and extend them each run.
4. Deliver the final report to Todd with `SendUserFile`.

## Phase 6 — Teardown + cleanup

Default = **keep the report + the transcript cache** (so the next scan stays fast):
1. Stop earwitness (kill the :3000 process).
2. `docker stop speaches` (stop, NOT `rm` — keeps the large-v3 volume warm for next time).
3. Restore the dev env: `cp scratch/audit/.env.prescan .env`.
4. Archive this run's intermediates: move `audit-results.jsonl`, `adjudication.jsonl`,
   `reclassify.jsonl` into `$AUDIT_DATA/archive/<stamp>/`. KEEP the HTML report and the
   earwitness transcript cache.
5. Leave Z: mapped (harmless).

Report what happened: book count, final tally (catalog-confirmed % / confirmed edition mismatches
/ false alarms caught / no-credit / unreadable), and where the report landed.
