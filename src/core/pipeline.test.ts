import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processBook, type ProcessDeps } from './pipeline.js';
import { Cache, sha, transcriptKey, extractionKey, fileIdentity } from './cache.js';
import { PROMPT_VERSION, SCHEMA_VERSION } from './extract.js';
import type { Book } from './discover.js';
import type { TranscribeProvider } from './transcribe/provider.js';
import { withTranscribeLimit } from './transcribe/index.js';

let tmp: string;
let counter = 0;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ew-pipe-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

async function makeFileBook(): Promise<Book> {
  const p = path.join(tmp, `book-${counter++}.m4b`);
  await fs.writeFile(p, 'x'); // real file → fileIdentity stat works; readTags fails → empty tags
  return {
    name: path.parse(p).name,
    source: p,
    introTrackPath: p,
    introTrackReason: 'single file',
    tracks: [p],
    isMultifile: false,
  };
}

const fixedProvider = (transcript: string): TranscribeProvider => ({
  name: 'fake',
  transcribe: async () => transcript,
});

function mockOllama(extraction: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ message: { content: JSON.stringify(extraction) } }), { status: 200 })),
  );
}

function freshDeps(provider: TranscribeProvider, over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    transcribe: provider,
    cache: new Cache(path.join(tmp, `cache-${counter++}`)),
    ffmpegPath: 'ffmpeg',
    offsetSeconds: 0,
    seconds: 60,
    whisperModel: 'test-model',
    ollama: { host: 'http://ollama.test', model: 'test-llm' },
    ...over,
  };
}

describe('processBook — evidence enforcement (P1-4)', () => {
  it('nulls a detected field whose evidence is null', async () => {
    const transcript = 'Audible presents The Shining by Stephen King, narrated by Campbell Scott.';
    mockOllama({
      attributionPresent: true,
      title: 'The Shining',
      author: 'Stephen King',
      narrator: 'Campbell Scott',
      publisher: null,
      confidence: 0.9,
      evidence: { title: 'The Shining', author: null, narrator: 'Campbell Scott' },
    });
    const res = await processBook(await makeFileBook(), freshDeps(fixedProvider(transcript)));
    expect(res.detected.title).toBe('The Shining');
    expect(res.detected.narrators).toEqual(['Campbell Scott']);
    expect(res.detected.authors).toEqual([]); // author span was null → dropped
    expect(res.attributionPresent).toBe(true);
  });

  it('nulls a field whose evidence is not present in the transcript', async () => {
    const transcript = 'Just some quiet story prose, nothing announced here at all.';
    mockOllama({
      attributionPresent: true,
      title: 'A Hallucinated Title',
      author: null,
      narrator: null,
      publisher: null,
      confidence: 0.8,
      evidence: { title: 'A Hallucinated Title', author: null, narrator: null },
    });
    const res = await processBook(await makeFileBook(), freshDeps(fixedProvider(transcript)));
    expect(res.detected.title).toBeNull();
    expect(res.attributionPresent).toBe(false); // nothing survived → downgraded
  });

  it('forces attributionPresent=false (not "verified") when nothing is evidence-backed', async () => {
    const transcript = 'The cold wind rattled the windows of the Overlook Hotel that night.';
    mockOllama({
      attributionPresent: true,
      title: 'X',
      author: 'Y',
      narrator: 'Z',
      publisher: null,
      confidence: 0.95,
      evidence: { title: null, author: null, narrator: null },
    });
    const res = await processBook(await makeFileBook(), freshDeps(fixedProvider(transcript)));
    expect(res.attributionPresent).toBe(false);
    expect(res.detected).toEqual({ title: null, authors: [], narrators: [] });
    expect(res.flags).toEqual([]);
  });
});

describe('processBook — extraction cache (P2-4)', () => {
  it('treats a schema-invalid cached extraction as a miss and re-extracts', async () => {
    const transcript = 'Audible presents Dune by Frank Herbert.';
    const book = await makeFileBook();
    const deps = freshDeps(fixedProvider(transcript));

    // Pre-seed the transcript cache (skip transcribe) and a GARBAGE extraction.
    const identity = await fileIdentity(book.introTrackPath);
    const tKey = transcriptKey({
      introTrackPath: book.introTrackPath,
      identity,
      offset: deps.offsetSeconds,
      seconds: deps.seconds,
      model: deps.whisperModel,
      backend: deps.transcribe.name,
    });
    await deps.cache.set('transcript', tKey, transcript);
    const eKey = extractionKey({
      transcriptHash: sha(transcript),
      model: deps.ollama.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
    });
    await deps.cache.set('extraction', eKey, { garbage: true });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                attributionPresent: true,
                title: 'Dune',
                author: 'Frank Herbert',
                narrator: null,
                publisher: null,
                confidence: 0.9,
                evidence: { title: 'Dune', author: 'Frank Herbert', narrator: null },
              }),
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await processBook(book, deps);
    expect(fetchMock).toHaveBeenCalledTimes(1); // didn't trust the bad cache entry
    expect(res.detected.title).toBe('Dune');
  });
});

describe('processBook — cancellation & concurrency (P1-3, P1-2)', () => {
  it('rethrows on job cancellation instead of recording an error result', async () => {
    const provider: TranscribeProvider = {
      name: 'fake',
      async transcribe(_t, opts) {
        if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return 'unused';
      },
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      processBook(await makeFileBook(), freshDeps(provider, { signal: controller.signal })),
    ).rejects.toThrow();
  });

  it('caps concurrent transcribes via withTranscribeLimit', async () => {
    let active = 0;
    let max = 0;
    const provider: TranscribeProvider = {
      name: 'fake',
      async transcribe() {
        active += 1;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return ''; // short transcript → early return, no extract call
      },
    };
    const limited = withTranscribeLimit(provider, 1);
    const books = await Promise.all([makeFileBook(), makeFileBook(), makeFileBook()]);
    await Promise.all(books.map((b) => processBook(b, freshDeps(limited))));
    expect(max).toBe(1);
  });
});
