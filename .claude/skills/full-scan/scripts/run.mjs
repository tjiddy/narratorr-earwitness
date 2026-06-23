// Library-audit DRIVER. Loops every narratorr book (data/audit-books.json) through
// earwitness's REAL attribution endpoint and writes a resumable JSONL of verdicts.
// It exercises the production pipeline (transcribe → extract → evidence-guard →
// compareIdentity against narratorr's metadata) — zero reimplementation.
//
// Run from PowerShell (loopback bypasses auth; no key needed for localhost):
//   node scratch/overnight/audit-run.mjs
// Env:
//   EW_URL          earwitness base URL          (default http://localhost:3000)
//   EW_API_KEY      x-api-key (only if remote)   (default '' → relies on loopback)
//   CONCURRENCY     in-flight requests           (default 3; server semaphore is the real throttle)
//   LIMIT           run only the first N pending (default all; use a small N for a plumbing test)
//   REQ_TIMEOUT_MS  per-book hard cap            (default 600000 = 10 min)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.AUDIT_DATA ? path.resolve(process.env.AUDIT_DATA) : path.join(HERE, 'data');
const IN = path.join(DATA, 'audit-books.json');
const OUT = path.join(DATA, 'audit-results.jsonl');

const EW_URL = (process.env.EW_URL || 'http://localhost:3000').replace(/\/$/, '');
const EW_API_KEY = process.env.EW_API_KEY || '';
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 600000);

const books = JSON.parse(await fs.readFile(IN, 'utf8'));

// resumable: skip ids already written (a crash/Ctrl-C keeps progress; cache makes reruns cheap)
const done = new Set();
try {
  for (const line of (await fs.readFile(OUT, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).id); } catch {}
  }
} catch {}

const pending = books.filter((b) => !done.has(b.id));
const todo = Number.isFinite(LIMIT) ? pending.slice(0, LIMIT) : pending;
console.log(`audit: ${books.length} books · ${done.size} already done · ${todo.length} to run @ concurrency ${CONCURRENCY}`);
console.log(`endpoint: ${EW_URL}/api/v1/attribution · auth: ${EW_API_KEY ? 'x-api-key' : 'loopback (no key)'}\n`);

async function attribute(b) {
  const expected = { title: b.title, authors: b.authors, narrators: b.narrators };
  const base = { id: b.id, rel: b.rel, title: b.title, audioFileCount: b.audioFileCount, expected };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const started = Date.now();
  try {
    const headers = { 'content-type': 'application/json' };
    if (EW_API_KEY) headers['x-api-key'] = EW_API_KEY;
    const res = await fetch(`${EW_URL}/api/v1/attribution`, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({ path: b.rel, expected, requestId: String(b.id) }),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ...base, httpStatus: res.status, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, ms };
    }
    const body = await res.json();
    return { ...base, httpStatus: 200, detection: body.detection ?? null, comparison: body.comparison ?? null, error: null, ms };
  } catch (e) {
    const ms = Date.now() - started;
    return { ...base, error: e.name === 'AbortError' ? `timeout >${REQ_TIMEOUT_MS}ms` : String(e?.message || e), ms };
  } finally {
    clearTimeout(timer);
  }
}

let completed = 0, flagged = 0, errored = 0;
async function worker(queue) {
  for (;;) {
    const b = queue.shift();
    if (!b) return;
    const r = await attribute(b);
    await fs.appendFile(OUT, JSON.stringify(r) + '\n');
    completed++;
    if (r.error) errored++;
    else if (r.comparison && r.comparison.status !== 'match' && r.comparison.status !== 'unknown') flagged++;
    const tag = r.error ? 'ERR     ' : r.comparison ? r.comparison.status.toUpperCase().padEnd(8) : 'NO-CMP  ';
    console.log(`[${String(completed).padStart(3)}/${todo.length}] ${tag} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.rel}`);
  }
}

const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker(queue)));
console.log(`\ndone. completed=${completed} · flagged=${flagged} · errored=${errored}`);
console.log(`results → ${OUT}\nbuild report → node scratch/overnight/audit-report.mjs`);
