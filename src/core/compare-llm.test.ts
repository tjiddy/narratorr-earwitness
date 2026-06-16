import { describe, it, expect, vi, afterEach } from 'vitest';
import { compareIdentity, type Expected } from './compare-llm.js';
import type { Attribution } from '@shared/schemas.js';
import type { Cache } from './cache.js';

afterEach(() => vi.unstubAllGlobals());

// In-memory Cache stand-in.
function memCache(): Cache {
  const m = new Map<string, unknown>();
  return {
    get: async (ns: string, key: string) => (m.has(`${ns}:${key}`) ? m.get(`${ns}:${key}`) : null),
    set: async (ns: string, key: string, v: unknown) => void m.set(`${ns}:${key}`, v),
  } as unknown as Cache;
}

// Stub Ollama /api/chat to return a forced structured-output payload.
function stubLlm(out: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify({ message: { content: JSON.stringify(out) } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const deps = () => ({ host: 'http://ollama.test', model: 'm', cache: memCache() });

const detected = (over: Partial<Attribution> = {}): Attribution => ({
  title: null,
  authors: [],
  narrators: [],
  ...over,
});
const expected = (over: Partial<Expected> = {}): Expected => ({
  title: null,
  authors: [],
  narrators: [],
  ...over,
});

describe('compareIdentity', () => {
  it('treats a former/stage name as the same person (match)', async () => {
    stubLlm({
      title: { same: true, reason: 'same' },
      authors: { matches: [{ expected: 'Frank Herbert', detected: 'Frank Herbert' }], reason: 'same' },
      narrators: { matches: [{ expected: 'Metta World Peace', detected: 'Ron Artest' }], reason: 'former name' },
    });

    const cmp = await compareIdentity(
      detected({ title: 'Dune', authors: ['Frank Herbert'], narrators: ['Ron Artest'] }),
      expected({ title: 'Dune', authors: ['Frank Herbert'], narrators: ['Metta World Peace'] }),
      deps(),
    );

    expect(cmp.status).toBe('match');
    expect(cmp.fields.narrators.status).toBe('match');
    expect(cmp.fields.narrators.matched).toHaveLength(1);
    expect(cmp.fields.narrators.unexpectedDetected).toEqual([]);
  });

  it('flags a different person as mismatch (unexpectedDetected is the contradiction signal)', async () => {
    stubLlm({
      title: { same: true, reason: 'same' },
      authors: { matches: [{ expected: 'Frank Herbert', detected: 'Frank Herbert' }], reason: 'same' },
      narrators: { matches: [], reason: 'different people' },
    });

    const cmp = await compareIdentity(
      detected({ title: 'Dune', authors: ['Frank Herbert'], narrators: ['Jose Bautista'] }),
      expected({ title: 'Dune', authors: ['Frank Herbert'], narrators: ['Ray Porter'] }),
      deps(),
    );

    expect(cmp.status).toBe('mismatch');
    expect(cmp.fields.narrators.status).toBe('mismatch');
    expect(cmp.fields.narrators.unexpectedDetected).toEqual(['Jose Bautista']);
    expect(cmp.fields.narrators.missingExpected).toEqual(['Ray Porter']);
  });

  it('treats a consistent subset as partial, not a mismatch', async () => {
    stubLlm({
      title: { same: true, reason: 'same' },
      authors: { matches: [{ expected: 'Frank Herbert', detected: 'Frank Herbert' }], reason: 'same' },
      narrators: { matches: [{ expected: 'A Reader', detected: 'A Reader' }], reason: 'lead only' },
    });

    const cmp = await compareIdentity(
      detected({ title: 'Dune', authors: ['Frank Herbert'], narrators: ['A Reader'] }),
      expected({ title: 'Dune', authors: ['Frank Herbert'], narrators: ['A Reader', 'B Voice', 'C Speaker'] }),
      deps(),
    );

    expect(cmp.fields.narrators.status).toBe('partial');
    expect(cmp.fields.narrators.missingExpected).toEqual(['B Voice', 'C Speaker']);
    expect(cmp.fields.narrators.unexpectedDetected).toEqual([]);
    expect(cmp.status).toBe('partial'); // title+author match, narrator partial → partial
  });

  it('drops a hallucinated pairing (string not in the provided lists)', async () => {
    stubLlm({
      title: { same: false, reason: 'n/a' },
      authors: { matches: [], reason: 'n/a' },
      // detected name "Someone Else" is not in the detected list → must be dropped
      narrators: { matches: [{ expected: 'Ray Porter', detected: 'Someone Else' }], reason: 'bogus' },
    });

    const cmp = await compareIdentity(
      detected({ narrators: ['Jose Bautista'] }),
      expected({ narrators: ['Ray Porter'] }),
      deps(),
    );

    expect(cmp.fields.narrators.matched).toEqual([]);
    expect(cmp.fields.narrators.unexpectedDetected).toEqual(['Jose Bautista']);
    expect(cmp.fields.narrators.status).toBe('mismatch');
  });

  it('returns title mismatch when the works differ', async () => {
    stubLlm({
      title: { same: false, reason: 'different works' },
      authors: { matches: [], reason: 'n/a' },
      narrators: { matches: [], reason: 'n/a' },
    });

    const cmp = await compareIdentity(
      detected({ title: 'Dune' }),
      expected({ title: 'Foundation' }),
      deps(),
    );

    expect(cmp.fields.title.status).toBe('mismatch');
    expect(cmp.status).toBe('mismatch');
  });

  it('never calls the LLM when there is nothing to compare (all unknown)', async () => {
    const fn = stubLlm({}); // should not be hit
    const cmp = await compareIdentity(
      detected(), // attributionPresent:false equivalent — nothing heard
      expected({ title: 'The Stand', authors: ['Stephen King'], narrators: ['Grover Gardner'] }),
      deps(),
    );

    expect(fn).not.toHaveBeenCalled();
    expect(cmp.status).toBe('unknown');
    expect(cmp.fields.narrators.status).toBe('unknown');
    // Nothing heard → surface expected-but-unheard, but never a contradiction.
    expect(cmp.fields.narrators.missingExpected).toEqual(['Grover Gardner']);
    expect(cmp.fields.narrators.unexpectedDetected).toEqual([]);
  });

  it('caches on (detected, expected, model) — a repeat call does not re-hit the LLM', async () => {
    const fn = stubLlm({
      title: { same: true, reason: 'same' },
      authors: { matches: [], reason: 'n/a' },
      narrators: { matches: [], reason: 'n/a' },
    });
    const shared = deps();
    const d = detected({ title: 'Dune' });
    const e = expected({ title: 'Dune' });

    await compareIdentity(d, e, shared);
    await compareIdentity(d, e, shared);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
