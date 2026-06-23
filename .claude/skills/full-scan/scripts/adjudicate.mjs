// ADJUDICATION pass over the raw audit verdicts.
//
// Why: compareIdentity asks gemma4 to emit the FULL name set-partition in one shot.
// On multi-name lists it under-pairs (e.g. "The Divorce": it paired Marin Ireland but
// dropped Edoardo↔Eduardo and LaVoy↔Lavoie → false MISMATCH). Pairwise yes/no judgments
// are far more reliable than a one-shot set-partition, so we RE-JUDGE every flagged book:
//
//   Pass 1 (pairwise recovery): for each leftover (missingExpected × unexpectedDetected)
//     name pair, ask "is HEARD a plausible STT mishearing of EXPECTED — same real person?"
//     Greedily pair. Recompute field status from the recovered pairs.
//   Pass 2 (classify remainders): a book that STILL contradicts after recovery (heard a
//     specific person NOT in the catalog) gets one holistic call with the evidence snippet
//     → bucket {NARRATORR_SUSPECT | INCONCLUSIVE} + confidence + one-line rationale.
//
// Buckets written to data/adjudication.jsonl (one line per flagged book):
//   CLEAN          raw mismatch was a pairing artifact; narratorr is right.
//   PARTIAL_OK     heard a consistent SUBSET (fewer narrators, none contradicting).
//   NARRATORR_SUSPECT  earwitness confidently heard someone/something the catalog lacks.
//   INCONCLUSIVE   evidence too garbled / self-narration ambiguity → needs human + audio.
//
// Only mismatch/partial rows are adjudicated. match/unknown/error pass through untouched
// (the report reads those straight from audit-results.jsonl).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.AUDIT_DATA ? path.resolve(process.env.AUDIT_DATA) : path.join(HERE, 'data');
const IN = path.join(DATA, 'audit-results.jsonl');
const OUT = path.join(DATA, 'adjudication.jsonl');

const OLLAMA = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';

const rows = (await fs.readFile(IN, 'utf8'))
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// resumable
const done = new Set();
try {
  for (const line of (await fs.readFile(OUT, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).id); } catch {}
  }
} catch {}

const flagged = rows.filter(
  (r) => !r.error && r.comparison && (r.comparison.status === 'mismatch' || r.comparison.status === 'partial') && !done.has(r.id),
);
console.log(`adjudicate: ${flagged.length} flagged books to judge · model ${MODEL}\n`);

async function chat(system, user, schema) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: schema,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(data.message?.content ?? '{}');
}

const PAIR_SYS = `A speech-to-text system transcribed a spoken audiobook credit. Proper nouns — especially person names — are routinely MANGLED in spelling. Given one EXPECTED name (from the catalog) and one HEARD name (from speech-to-text), decide: is HEARD a plausible mishearing, homophone, transliteration, or formatting/ordering/initials/honorific variant of EXPECTED — i.e. the SAME real person? Examples of SAME person: Brick/Brink, Euan/Ewan, Stephen/Steven, "January LaVoy"/"January Lavoie", "Edoardo Ballerini"/"Eduardo Ballerini", "John Ham"/"John Hamm", "Khristine Hvam"/"Christine Vam". If HEARD has a different first name AND different surname with no phonetic overlap, they are DIFFERENT people. When genuinely unsure, answer false. Respond ONLY with JSON.`;
const PAIR_SCHEMA = { type: 'object', properties: { same: { type: 'boolean' }, reason: { type: 'string' } }, required: ['same', 'reason'] };

const CLASSIFY_SYS = `You are adjudicating a possible audiobook-catalog error. A speech-to-text system transcribed the spoken opening/closing credit of an audiobook ("heard"). The catalog believes "expected". After accounting for speech-to-text mishearings, some HEARD names/titles still do NOT correspond to anything in the catalog. Using the raw evidence transcript, classify:
- "NARRATORR_SUSPECT": the audio CLEARLY and confidently credits a specific person or title that the catalog is missing or contradicts (the catalog is probably wrong). Only choose this when the evidence names them cleanly and unambiguously.
- "INCONCLUSIVE": the evidence is garbled, ambiguous, could be a self-narration phrasing, could be a different book's preview, or you cannot confidently say the catalog is wrong.
Bias toward INCONCLUSIVE — a false accusation that the catalog is wrong is worse than a miss. Respond ONLY with JSON.`;
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: { bucket: { type: 'string', enum: ['NARRATORR_SUSPECT', 'INCONCLUSIVE'] }, confidence: { type: 'number' }, rationale: { type: 'string' } },
  required: ['bucket', 'confidence', 'rationale'],
};

// Greedily recover pairs from leftover expected × detected via pairwise LLM judgments.
async function recover(missingExpected, unexpectedDetected) {
  const recovered = [];
  const expLeft = [...missingExpected];
  const detLeft = [...unexpectedDetected];
  for (let di = 0; di < detLeft.length; di++) {
    for (let ei = 0; ei < expLeft.length; ei++) {
      if (expLeft[ei] == null) continue;
      const r = await chat(PAIR_SYS, JSON.stringify({ expected: expLeft[ei], heard: detLeft[di] }), PAIR_SCHEMA);
      if (r.same) {
        recovered.push({ expected: expLeft[ei], detected: detLeft[di], reason: r.reason });
        expLeft[ei] = null;
        detLeft[di] = null;
        break;
      }
    }
  }
  return {
    recovered,
    stillMissing: expLeft.filter(Boolean),
    stillUnexpected: detLeft.filter(Boolean),
  };
}

function fieldStatus(matchedCount, stillMissing, stillUnexpected) {
  if (stillUnexpected.length > 0) return 'mismatch';
  if (stillMissing.length > 0) return matchedCount > 0 ? 'partial' : 'mismatch';
  return 'match';
}

async function adjudicate(r) {
  const f = r.comparison.fields;
  const det = r.detection?.detected ?? { title: null, authors: [], narrators: [] };

  // Pass 1 — pairwise recovery on the two multi-fields.
  const aRec = await recover(f.authors.missingExpected ?? [], f.authors.unexpectedDetected ?? []);
  const nRec = await recover(f.narrators.missingExpected ?? [], f.narrators.unexpectedDetected ?? []);

  // Title: if it mismatched, re-ask as a single same-work judgment (ignore subtitle/series).
  let titleStatus = f.title.status;
  if (f.title.status === 'mismatch') {
    const t = await chat(
      `Do these two strings name the SAME audiobook work? Ignore subtitle, series, volume, edition, and formatting wording. Respond ONLY with JSON {same, reason}.`,
      JSON.stringify({ expected: f.title.expected, heard: f.title.detected }),
      PAIR_SCHEMA,
    );
    if (t.same) titleStatus = 'match';
  }

  const aMatched = (f.authors.matched?.length ?? 0) + aRec.recovered.length;
  const nMatched = (f.narrators.matched?.length ?? 0) + nRec.recovered.length;
  const aStatus = (f.authors.status === 'unknown') ? 'unknown' : fieldStatus(aMatched, aRec.stillMissing, aRec.stillUnexpected);
  const nStatus = (f.narrators.status === 'unknown') ? 'unknown' : fieldStatus(nMatched, nRec.stillMissing, nRec.stillUnexpected);

  const statuses = [titleStatus, aStatus, nStatus];
  const newStatus = statuses.includes('mismatch') ? 'mismatch' : statuses.includes('partial') ? 'partial' : statuses.includes('match') ? 'match' : 'unknown';

  const stillUnexpected = [...aRec.stillUnexpected, ...nRec.stillUnexpected];

  let bucket, classify = null;
  if (newStatus === 'match') {
    bucket = 'CLEAN';
  } else if (newStatus === 'partial' && stillUnexpected.length === 0) {
    bucket = 'PARTIAL_OK';
  } else {
    // Genuine contradiction after recovery → classify with evidence.
    classify = await chat(
      CLASSIFY_SYS,
      JSON.stringify({
        expected: r.expected,
        heard: det,
        evidence: r.detection?.evidence ?? null,
        unresolved: { stillMissingExpected: [...aRec.stillMissing, ...nRec.stillMissing], stillUnexpectedHeard: stillUnexpected, titleStatus },
      }),
      CLASSIFY_SCHEMA,
    );
    bucket = classify.bucket;
  }

  return {
    id: r.id,
    rel: r.rel,
    title: r.title,
    rawStatus: r.comparison.status,
    newStatus,
    bucket,
    recovered: { authors: aRec.recovered, narrators: nRec.recovered, titleFixed: f.title.status === 'mismatch' && titleStatus === 'match' },
    stillMissing: [...aRec.stillMissing, ...nRec.stillMissing],
    stillUnexpected,
    classify,
    expected: r.expected,
    detected: det,
    evidence: r.detection?.evidence ?? null,
  };
}

let n = 0;
for (const r of flagged) {
  try {
    const a = await adjudicate(r);
    await fs.appendFile(OUT, JSON.stringify(a) + '\n');
    n++;
    const extra = a.bucket === 'NARRATORR_SUSPECT' ? `  ⚑ ${a.stillUnexpected.join(', ') || '(title)'}` : '';
    console.log(`[${String(n).padStart(3)}/${flagged.length}] ${a.rawStatus}→${a.newStatus.padEnd(8)} ${a.bucket.padEnd(17)} ${a.rel}${extra}`);
  } catch (e) {
    console.log(`[ERR] ${r.rel}: ${e.message}`);
    await fs.appendFile(OUT, JSON.stringify({ id: r.id, rel: r.rel, title: r.title, rawStatus: r.comparison.status, bucket: 'ADJ_ERROR', error: e.message }) + '\n');
  }
}
console.log(`\ndone. adjudicated ${n} books → ${OUT}`);
