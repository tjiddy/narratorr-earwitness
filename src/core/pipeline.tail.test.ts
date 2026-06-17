import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the tags module: give the pipeline a known duration (so it locates a tail
// window) and empty embedded tags. Kept in its own test file so the mock doesn't
// leak into pipeline.test.ts.
vi.mock('./tags.js', () => ({
  readTags: async () => ({ title: null, authors: [], narrators: [] }),
  getAudioDuration: vi.fn(async () => 600), // 10 min → tail window at offset 540 (overridable per-test)
}));

import { processBook, type ProcessDeps } from './pipeline.js';
import { getAudioDuration } from './tags.js';
import { Cache } from './cache.js';
import type { Book } from './discover.js';
import type { TranscribeProvider } from './transcribe/provider.js';

let tmp: string;
let counter = 0;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ew-tail-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

async function makeFileBook(): Promise<Book> {
  const p = path.join(tmp, `book-${counter++}.m4b`);
  await fs.writeFile(p, 'x');
  return { name: path.parse(p).name, source: p, introTrackPath: p, introTrackReason: 'single file', tracks: [p] };
}

const HEAD = 'This is Audible. Chapter one. The cold wind rattled the windows that night.';
const TAIL = 'This has been Tourist Season, written by Bryn Weaver, narrated by Sam Brentmore.';

// Provider returns the head transcript for the head window and the tail transcript
// for the tail window (offset jumps to ~540 for a 600s file with a 60s window).
const windowedProvider = (): TranscribeProvider => ({
  name: 'fake',
  transcribe: async (_t, opts) => (opts.offsetSeconds >= 100 ? TAIL : HEAD),
});

// Ollama mock that extracts attribution only from the tail transcript (the head is
// pure story prose with no credit).
function mockOllamaByContent(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const hasCredit = body.includes('Bryn Weaver');
      const extraction = hasCredit
        ? {
            attributionPresent: true,
            title: 'Tourist Season',
            author: 'Bryn Weaver',
            narrator: 'Sam Brentmore',
            publisher: null,
            confidence: 0.9,
            evidence: { title: 'Tourist Season', author: 'Bryn Weaver', narrator: 'Sam Brentmore' },
          }
        : {
            attributionPresent: false,
            title: null,
            author: null,
            narrator: null,
            publisher: null,
            confidence: 0,
            evidence: { title: null, author: null, narrator: null },
          };
      return new Response(JSON.stringify({ message: { content: JSON.stringify(extraction) } }), { status: 200 });
    }),
  );
}

function deps(over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    transcribe: windowedProvider(),
    cache: new Cache(path.join(tmp, `cache-${counter++}`)),
    ffmpegPath: 'ffmpeg',
    offsetSeconds: 0,
    seconds: 60,
    whisperModel: 'm',
    ollama: { host: 'http://ollama.test', model: 'm' },
    ...over,
  };
}

describe('processBook — tail sampling', () => {
  it('falls back to the tail when the head has no credit, and keeps the tail result', async () => {
    mockOllamaByContent();
    const res = await processBook(await makeFileBook(), deps());
    expect(res.attributionPresent).toBe(true);
    expect(res.detected.title).toBe('Tourist Season');
    expect(res.detected.authors).toEqual(['Bryn Weaver']);
    expect(res.detected.narrators).toEqual(['Sam Brentmore']);
    // The chosen window is the tail, so its excerpt is what we surface.
    expect(res.transcriptExcerpt).toContain('Bryn Weaver');
  });

  it('does NOT sample the tail when disabled (head-only → no attribution)', async () => {
    mockOllamaByContent();
    const res = await processBook(await makeFileBook(), deps({ tailSampling: false }));
    expect(res.attributionPresent).toBe(false);
    expect(res.detected.title).toBeNull();
  });

  it('multi-file book: tail reads the LAST track, not the tail of track 1', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'multi-'));
    const f1 = path.join(dir, '01.m4b');
    const f2 = path.join(dir, '02.m4b');
    await fs.writeFile(f1, 'x');
    await fs.writeFile(f2, 'x');
    const book: Book = { name: 'Multi', source: dir, introTrackPath: f1, introTrackReason: 'first', tracks: [f1, f2] };

    const calls: Array<{ track: string; offset: number }> = [];
    const provider: TranscribeProvider = {
      name: 'fake',
      transcribe: async (track, opts) => {
        calls.push({ track, offset: opts.offsetSeconds });
        return track === f2 ? TAIL : HEAD; // credit lives in the LAST track
      },
    };
    mockOllamaByContent();

    const res = await processBook(book, deps({ transcribe: provider }));
    expect(res.detected.authors).toEqual(['Bryn Weaver']); // resolved from the tail = last track
    expect(calls.some((c) => c.track === f1)).toBe(true); // head read track 1
    const tailCall = calls.find((c) => c.track === f2);
    expect(tailCall).toBeDefined(); // tail read track 2 (NOT the tail of track 1)
    expect(tailCall!.offset).toBeGreaterThan(100); // near the end (duration 600 - 60 = 540)
  });

  it('skips the tail when the head already resolves a complete attribution', async () => {
    // Head transcript carries the full credit → no tail transcription needed.
    const provider: TranscribeProvider = {
      name: 'fake',
      transcribe: async () => 'Recorded Books presents Fool by Christopher Moore, narrated by Euan Morton.',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                attributionPresent: true,
                title: 'Fool',
                author: 'Christopher Moore',
                narrator: 'Euan Morton',
                publisher: null,
                confidence: 0.95,
                evidence: { title: 'Fool', author: 'Christopher Moore', narrator: 'Euan Morton' },
              }),
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const res = await processBook(await makeFileBook(), deps({ transcribe: provider }));
    expect(res.detected.title).toBe('Fool');
    expect(res.detected.authors).toEqual(['Christopher Moore']);
    // Head-only: one transcript fetch worth of extraction (no tail extraction call).
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('skips the tail when the file duration is unknown (no second transcription)', async () => {
    vi.mocked(getAudioDuration).mockResolvedValueOnce(null); // ffprobe couldn't read it
    const offsets: number[] = [];
    const provider: TranscribeProvider = {
      name: 'fake',
      transcribe: async (_t, opts) => {
        offsets.push(opts.offsetSeconds);
        return HEAD; // prose, no credit → head incomplete → tail would be attempted
      },
    };
    mockOllamaByContent();
    const res = await processBook(await makeFileBook(), deps({ transcribe: provider }));
    expect(res.attributionPresent).toBe(false); // head had no credit, tail skipped
    expect(offsets).toHaveLength(1); // only the head window was transcribed
  });

  it('skips the tail when a single file is too short for a non-overlapping tail window', async () => {
    vi.mocked(getAudioDuration).mockResolvedValueOnce(60); // == head end (offset 0 + 60s) → no room
    const offsets: number[] = [];
    const provider: TranscribeProvider = {
      name: 'fake',
      transcribe: async (_t, opts) => {
        offsets.push(opts.offsetSeconds);
        return HEAD;
      },
    };
    mockOllamaByContent();
    const res = await processBook(await makeFileBook(), deps({ transcribe: provider }));
    expect(res.attributionPresent).toBe(false);
    expect(offsets).toHaveLength(1); // duration - seconds (0) not > headEnd (60) → tail skipped
  });
});
