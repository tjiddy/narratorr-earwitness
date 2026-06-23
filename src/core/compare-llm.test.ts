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

// Route the main set-partition call vs the single-pair recovery calls (bug #4). The pair
// call's user content is `{ expected, heard }` (both strings); the main call's is
// `{ detected, expected }`. `pair(expected, heard)` decides each leftover-pair verdict.
function stubRouted(main: unknown, pair: (expected: string, heard: string) => boolean): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
    const user = JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
    const out =
      typeof user.heard === 'string' && typeof user.expected === 'string'
        ? { same: pair(user.expected, user.heard), reason: 'pairwise' }
        : main;
    return new Response(JSON.stringify({ message: { content: JSON.stringify(out) } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
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

  it('recovers multi-name pairs the one-shot matcher under-paired (bug #4)', async () => {
    // The Divorce: the set-partition call pairs only Marin Ireland and drops the two
    // obvious mishearings. Pairwise recovery re-judges the leftovers and recovers them →
    // a full match, not a false mismatch.
    const fn = stubRouted(
      {
        title: { same: true, reason: 'same' },
        authors: { matches: [{ expected: 'Freida McFadden', detected: 'Frida McFadden' }], reason: 'mishearing' },
        narrators: { matches: [{ expected: 'Marin Ireland', detected: 'Marin Ireland' }], reason: 'one only' },
      },
      (exp, heard) =>
        (exp === 'January LaVoy' && heard === 'January Lavoie') ||
        (exp === 'Edoardo Ballerini' && heard === 'Eduardo Ballerini'),
    );

    const cmp = await compareIdentity(
      detected({ title: 'The Divorce', authors: ['Frida McFadden'], narrators: ['January Lavoie', 'Marin Ireland', 'Eduardo Ballerini'] }),
      expected({ title: 'The Divorce', authors: ['Freida McFadden'], narrators: ['January LaVoy', 'Edoardo Ballerini', 'Marin Ireland'] }),
      deps(),
    );

    expect(cmp.fields.narrators.status).toBe('match');
    expect(cmp.fields.narrators.matched).toHaveLength(3);
    expect(cmp.fields.narrators.missingExpected).toEqual([]);
    expect(cmp.fields.narrators.unexpectedDetected).toEqual([]);
    expect(cmp.status).toBe('match');
    expect(fn.mock.calls.length).toBeGreaterThan(1); // main call + pairwise recovery calls
  });

  it('recovery never over-pairs genuinely different leftover names (cardinal-sin guard)', async () => {
    // Set-partition pairs nobody; pairwise recovery is asked and says NOT the same person.
    // The contradiction must survive — recovery only absorbs real mishearings.
    stubRouted(
      { title: { same: true, reason: 'same' }, authors: { matches: [], reason: 'n/a' }, narrators: { matches: [], reason: 'different' } },
      () => false,
    );

    const cmp = await compareIdentity(
      detected({ title: 'Murderbot', narrators: ['David Kwee'] }),
      expected({ title: 'Murderbot', narrators: ['Kevin R. Free'] }),
      deps(),
    );

    expect(cmp.fields.narrators.status).toBe('mismatch');
    expect(cmp.fields.narrators.matched).toEqual([]);
    expect(cmp.fields.narrators.unexpectedDetected).toEqual(['David Kwee']);
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

  // Error paths — mirror extract.test.ts. A comparable field (title here) forces the LLM
  // call, so these exercise callLlm's three throws rather than the all-unknown short-circuit.
  it('throws on a non-OK HTTP status from the compare LLM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(
      compareIdentity(detected({ title: 'Dune' }), expected({ title: 'Foundation' }), deps()),
    ).rejects.toThrow(/compare 500/i);
  });

  it('throws when the compare LLM returns non-JSON content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: { content: 'not json at all' } }), { status: 200 })),
    );
    await expect(
      compareIdentity(detected({ title: 'Dune' }), expected({ title: 'Foundation' }), deps()),
    ).rejects.toThrow(/non-JSON/i);
  });

  it('throws when the compare response does not match the schema', async () => {
    stubLlm({ foo: 'bar' }); // valid JSON, wrong shape
    await expect(
      compareIdentity(detected({ title: 'Dune' }), expected({ title: 'Foundation' }), deps()),
    ).rejects.toThrow(/schema/i);
  });
});
