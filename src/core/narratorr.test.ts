import { describe, it, expect, vi, afterEach } from 'vitest';
import { NarratorrClient } from './narratorr.js';
import type { AttributionAuditInput } from '@shared/schemas.js';

afterEach(() => vi.unstubAllGlobals());

function book(id: string, title: string) {
  return {
    id,
    title,
    authors: [{ id: 'a1', name: 'Frank Herbert' }],
    narrators: [],
    series: null,
    status: 'imported',
    path: `${title}/book.m4b`,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const sampleAudit: AttributionAuditInput = {
  scanId: 's1',
  scannedAt: '2026-06-15T00:00:00.000Z',
  attributionPresent: true,
  detected: { title: 'Dune', authors: ['Frank Herbert'], narrators: [] },
  confidence: 0.9,
  evidence: { title: 'Dune', author: 'Frank Herbert', narrator: null },
  flags: [],
  models: { stt: 'large-v3-turbo', llm: 'qwen2.5:7b-instruct' },
  transcriptExcerpt: 'Dune by Frank Herbert',
};

describe('NarratorrClient.listImportedBooks', () => {
  it('pages through every imported book and sends auth + filter', async () => {
    const all = [book('id1', 'A'), book('id2', 'B'), book('id3', 'C')];
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(url);
        expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('k');
        const params = new URL(url).searchParams;
        const offset = Number(params.get('offset'));
        const limit = Number(params.get('limit'));
        return jsonResponse({ data: all.slice(offset, offset + limit), total: all.length });
      }),
    );

    const client = new NarratorrClient('http://nar.test/', 'k'); // trailing slash tolerated
    const books = await client.listImportedBooks({ pageSize: 2 });

    expect(books.map((b) => b.id)).toEqual(['id1', 'id2', 'id3']);
    expect(calls).toHaveLength(2); // pages of 2 + 1
    expect(calls[0]).toBe('http://nar.test/api/v1/books?status=imported&limit=2&offset=0'); // no double slash
    expect(calls[1]).toContain('offset=2');
  });

  it('throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(new NarratorrClient('http://n', 'k').listImportedBooks()).rejects.toThrow(/500/);
  });

  it('throws on a schema-invalid response (id must be a string)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ id: 123, title: 'x' }], total: 1 })));
    await expect(new NarratorrClient('http://n', 'k').listImportedBooks()).rejects.toThrow(/invalid/i);
  });
});

describe('NarratorrClient.postAttributionAudit', () => {
  it('POSTs to the right URL with auth + JSON body (base64url id unencoded)', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(null, { status: 200 });
      }),
    );

    await new NarratorrClient('http://nar.test', 'k').postAttributionAudit('Ab-_12', sampleAudit);

    expect(captured?.url).toBe('http://nar.test/api/v1/books/Ab-_12/attribution-audit');
    expect(captured?.init.method).toBe('POST');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('k');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(captured?.init.body as string).detected.title).toBe('Dune');
  });

  it('throws on a non-OK audit POST', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 404 })));
    await expect(new NarratorrClient('http://n', 'k').postAttributionAudit('x', sampleAudit)).rejects.toThrow(/404/);
  });
});
