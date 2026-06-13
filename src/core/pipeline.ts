import type { Attribution, BookResult } from '@shared/schemas.js';
import type { Book } from './discover.js';
import { Cache, fileIdentity, sha, transcriptKey, extractionKey } from './cache.js';
import type { TranscribeProvider } from './transcribe/index.js';
import { extract, PROMPT_VERSION } from './extract.js';
import { readTags } from './tags.js';
import { compareAttribution, splitPeople } from './compare.js';

const MIN_TRANSCRIPT_CHARS = 15;
const EXCERPT_CHARS = 400;

export interface ProcessDeps {
  transcribe: TranscribeProvider;
  cache: Cache;
  ffmpegPath: string;
  offsetSeconds: number;
  seconds: number;
  whisperModel: string;
  ollama: { host: string; model: string };
}

function emptyAttr(): Attribution {
  return { title: null, authors: [], narrators: [] };
}
function emptyEvidence() {
  return { title: null, author: null, narrator: null };
}

/**
 * Run one book through the full pipeline. Transcript and extraction are served
 * from / written to the split file cache, so re-runs of unchanged files are cheap.
 * Per-book errors are captured into the result rather than thrown — one bad file
 * shouldn't sink a whole scan.
 */
export async function processBook(book: Book, deps: ProcessDeps): Promise<BookResult> {
  const base = {
    name: book.name,
    sourcePath: book.source,
    introTrackPath: book.introTrackPath,
    introTrackReason: book.introTrackReason,
  };

  try {
    const identity = await fileIdentity(book.introTrackPath);

    // 1. Transcribe (cached)
    const tKey = transcriptKey({
      introTrackPath: book.introTrackPath,
      identity,
      offset: deps.offsetSeconds,
      seconds: deps.seconds,
      model: deps.whisperModel,
      backend: deps.transcribe.name,
    });
    let transcript = await deps.cache.get<string>('transcript', tKey);
    if (transcript === null) {
      transcript = await deps.transcribe.transcribe(book.introTrackPath, {
        ffmpegPath: deps.ffmpegPath,
        offsetSeconds: deps.offsetSeconds,
        seconds: deps.seconds,
        model: deps.whisperModel,
      });
      await deps.cache.set('transcript', tKey, transcript);
    }

    const tags = await readTags(book.introTrackPath);
    const transcriptExcerpt = transcript.slice(0, EXCERPT_CHARS);

    // No usable speech → book-level "couldn't determine", no field flags.
    if (transcript.replace(/\s/g, '').length < MIN_TRANSCRIPT_CHARS) {
      return {
        ...base,
        attributionPresent: false,
        detected: emptyAttr(),
        confidence: 0,
        evidence: emptyEvidence(),
        tags,
        flags: [],
        transcriptExcerpt,
        error: null,
      };
    }

    // 2. Extract (cached)
    const eKey = extractionKey({
      transcriptHash: sha(transcript),
      model: deps.ollama.model,
      promptVersion: PROMPT_VERSION,
    });
    let extraction = await deps.cache.get<Awaited<ReturnType<typeof extract>>>('extraction', eKey);
    if (extraction === null) {
      extraction = await extract(transcript, deps.ollama);
      await deps.cache.set('extraction', eKey, extraction);
    }

    const detected = {
      title: extraction.title,
      authors: splitPeople(extraction.author),
      narrators: splitPeople(extraction.narrator),
    };

    const flags = extraction.attributionPresent
      ? compareAttribution(detected, tags, extraction.confidence)
      : [];

    return {
      ...base,
      attributionPresent: extraction.attributionPresent,
      detected,
      confidence: extraction.confidence,
      evidence: extraction.evidence,
      tags,
      flags,
      transcriptExcerpt,
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      attributionPresent: false,
      detected: emptyAttr(),
      confidence: 0,
      evidence: emptyEvidence(),
      tags: emptyAttr(),
      flags: [],
      transcriptExcerpt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
