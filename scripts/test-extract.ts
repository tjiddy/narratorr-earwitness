/**
 * Live smoke test for the Ollama extraction path — no audio required.
 * Validates structured JSON output + the anti-hallucination rule (prose -> no attribution).
 *   pnpm tsx scripts/test-extract.ts
 */
import { config } from '../src/server/config.js';
import { extract } from '../src/core/extract.js';

const CLEAN_INTRO =
  'This is Audible. Simon and Schuster Audio presents The Shining, by Stephen King. Narrated by Campbell Scott.';

const PROSE_ONLY =
  'Jack Torrance thought: Officious little prick. The interview had not gone well, and the cold wind off the mountains rattled the windows of the Overlook Hotel as he climbed the stairs.';

for (const [label, transcript] of [
  ['CLEAN INTRO', CLEAN_INTRO],
  ['PROSE ONLY', PROSE_ONLY],
] as const) {
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  const result = await extract(transcript, config.ollama);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.dir(result, { depth: null });
}
