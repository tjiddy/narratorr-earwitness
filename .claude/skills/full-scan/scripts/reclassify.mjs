// SHARP re-judge of the 41 INCONCLUSIVE books that still credit a name NOT in the
// catalog after pairwise recovery. The first classify pass was too blunt (biased to
// INCONCLUSIVE). This separates the three real reasons a confident extra name appears:
//   EDITION_MISMATCH   audio clearly credits a DIFFERENT primary narrator than the
//                      catalog → the file is a different recording; catalog is wrong for it.
//   EXTRA_CONTRIBUTOR  heard name is a foreword/intro/afterword reader, translator, the
//                      AUTHOR, or a guest — an addition, not a contradiction.
//   GARBLE             a fragment, a pronoun ("me"), or too mangled to be a real name.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.AUDIT_DATA ? path.resolve(process.env.AUDIT_DATA) : path.join(HERE, 'data');
const IN = path.join(DATA, 'adjudication.jsonl');
const OUT = path.join(DATA, 'reclassify.jsonl');

const OLLAMA = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';

const adj = (await fs.readFile(IN, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const targets = adj.filter((a) => a.bucket === 'INCONCLUSIVE' && (a.stillUnexpected?.length ?? 0) > 0);
console.log(`reclassify: ${targets.length} contradicting books · model ${MODEL}\n`);

const SYS = `An audiobook's spoken opening/closing credit was transcribed by speech-to-text ("heardCredit" + "heardNarrators"). The catalog ("catalogNarrators") may describe a DIFFERENT edition/recording of the same book. After matching for mishearings, the audio still credits "extraHeard" — name(s) not found in the catalog. Decide WHY, using the raw heardCredit phrase:

- "EDITION_MISMATCH": the audio clearly and confidently credits a DIFFERENT primary narrator than the catalog — a clean "narrated by / read by / performed by X" naming a well-formed real person who is NOT a catalog narrator and NOT described as a foreword/guest/author. This means the audio file is a different recording than the catalog describes; the catalog's narrator is WRONG for this file.
- "EXTRA_CONTRIBUTOR": the extra heard name is explicitly a foreword/introduction/afterword reader, a translator, the book's AUTHOR reading a note, or a guest/with-credit — an ADDITION alongside a catalog narrator who IS still credited. The catalog's main narrator is still correct.
- "GARBLE": the extra "name" is a sentence fragment, a pronoun like "me"/"you", a run-on of an adjacent name, or too mangled to be a real distinct person.

Rules: base the decision on the heardCredit wording. If a catalog narrator also appears in heardNarrators AND the extra is introduced by foreword/with/author language, it is EXTRA_CONTRIBUTOR. Only choose EDITION_MISMATCH when NO catalog narrator is credited and the heard narrator is a clean confident different name. Respond ONLY with JSON.`;
const SCHEMA = {
  type: 'object',
  properties: {
    bucket: { type: 'string', enum: ['EDITION_MISMATCH', 'EXTRA_CONTRIBUTOR', 'GARBLE'] },
    suspectName: { type: 'string' },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['bucket', 'confidence', 'rationale'],
};

async function judge(a) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: SYS },
        {
          role: 'user',
          content: JSON.stringify({
            book: a.title,
            catalogNarrators: a.expected?.narrators ?? [],
            heardNarrators: a.detected?.narrators ?? [],
            extraHeard: a.stillUnexpected,
            heardCredit: a.evidence?.narrator ?? null,
          }),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.message?.content ?? '{}');
}

let n = 0;
for (const a of targets) {
  try {
    const j = await judge(a);
    const out = { id: a.id, rel: a.rel, title: a.title, catalogNarrators: a.expected?.narrators ?? [], heardNarrators: a.detected?.narrators ?? [], extraHeard: a.stillUnexpected, heardCredit: a.evidence?.narrator ?? null, ...j };
    await fs.appendFile(OUT, JSON.stringify(out) + '\n');
    n++;
    const flag = j.bucket === 'EDITION_MISMATCH' ? '  ⚑⚑' : '';
    console.log(`[${String(n).padStart(2)}/${targets.length}] ${j.bucket.padEnd(17)} ${a.title}${flag}`);
  } catch (e) {
    console.log(`[ERR] ${a.title}: ${e.message}`);
  }
}
console.log(`\ndone → ${OUT}`);
