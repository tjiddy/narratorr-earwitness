/**
 * Vertical-slice runner: discover -> ffmpeg -> transcribe -> extract -> tags ->
 * compare on the first N books under a path, printing each BookResult.
 *
 *   pnpm slice "C:\path\to\audiobooks" [limit=1]
 *
 * De-risks the whole pipeline against real audio before we build the server/UI.
 */
import { config } from '../src/server/config.js';
import { discover } from '../src/core/discover.js';
import { resolveFfmpeg } from '../src/core/ffmpeg.js';
import { Cache } from '../src/core/cache.js';
import { createTranscribeProvider } from '../src/core/transcribe/index.js';
import { processBook } from '../src/core/pipeline.js';

const root = process.argv[2] ?? config.browseRoots[0];
if (!root) {
  console.error('usage: pnpm slice <path-to-audiobooks> [limit]');
  process.exit(1);
}
const limit = Number(process.argv[3] ?? '1');

console.log(`whisper: ${config.whisper.backend} (${config.whisper.model}) | ollama: ${config.ollama.model}`);
const ffmpegPath = await resolveFfmpeg(config.ffmpegPath);
const books = await discover(root);
console.log(`discovered ${books.length} book(s) under ${root}\n`);

const provider = await createTranscribeProvider({ backend: config.whisper.backend, host: config.whisper.host });
const cache = new Cache(config.cacheDir);

for (const book of books.slice(0, limit)) {
  console.log(`=== ${book.name} ===`);
  console.log(`intro: ${book.introTrackPath} (${book.introTrackReason})`);
  const t0 = Date.now();
  const result = await processBook(book, {
    transcribe: provider,
    cache,
    ffmpegPath,
    offsetSeconds: config.introOffsetSeconds,
    seconds: config.introSeconds,
    whisperModel: config.whisper.model,
    ollama: config.ollama,
  });
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.dir(result, { depth: null });
  console.log('');
}
