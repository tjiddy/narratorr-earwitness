import { describe, it, expect, vi, afterEach } from 'vitest';
import { extract } from './extract.js';

function ollamaResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { content } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID = {
  attributionPresent: true,
  title: 'The Shining',
  author: 'Stephen King',
  narrator: 'Campbell Scott',
  publisher: 'Audible',
  confidence: 0.9,
  evidence: { title: 'The Shining', author: 'Stephen King', narrator: 'Campbell Scott' },
};

afterEach(() => vi.unstubAllGlobals());

describe('extract', () => {
  it('returns a parsed extraction for a schema-valid response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ollamaResponse(JSON.stringify(VALID))));
    const out = await extract('transcript', { host: 'http://ollama.test', model: 'm' });
    expect(out.title).toBe('The Shining');
    expect(out.confidence).toBe(0.9);
  });

  it('throws when the response does not match the schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ollamaResponse(JSON.stringify({ foo: 'bar' }))));
    await expect(extract('t', { host: 'http://ollama.test', model: 'm' })).rejects.toThrow(/schema/i);
  });

  it('throws when the model returns non-JSON content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ollamaResponse('not json at all')));
    await expect(extract('t', { host: 'http://ollama.test', model: 'm' })).rejects.toThrow(/non-JSON/i);
  });

  it('throws on a non-OK HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(extract('t', { host: 'http://ollama.test', model: 'm' })).rejects.toThrow(/500/);
  });
});
