import { z } from 'zod';
import {
  narratorrBookListResponseSchema,
  type AttributionAuditInput,
  type NarratorrBook,
} from '@shared/schemas.js';

// HTTP client for the Narratorr v1.1 API (NARRATORR-INTEGRATION.md /
// narratorr:NARRATORR-V1.1-EARWITNESS-DESIGN.md). Auth is the `X-Api-Key` header.
// Read responses are validated but the schema is non-strict, so provider-side
// additive fields don't break us.

const DEFAULT_PAGE_SIZE = 200; // provider caps limit at 500

export class NarratorrClient {
  private readonly base: string;

  constructor(
    url: string,
    private readonly apiKey: string,
  ) {
    this.base = url.replace(/\/+$/, ''); // tolerate a trailing slash in NARRATORR_URL
  }

  private get authHeaders(): Record<string, string> {
    return { 'X-Api-Key': this.apiKey };
  }

  /** Page through GET /api/v1/books?status=imported and return every imported book. */
  async listImportedBooks(opts: { pageSize?: number; signal?: AbortSignal } = {}): Promise<NarratorrBook[]> {
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    const books: NarratorrBook[] = [];
    let offset = 0;

    for (;;) {
      const url = `${this.base}/api/v1/books?status=imported&limit=${pageSize}&offset=${offset}`;
      const res = await fetch(url, { headers: this.authHeaders, signal: opts.signal ?? null });
      if (!res.ok) {
        throw new Error(`narratorr GET /books ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const parsed = narratorrBookListResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(`narratorr /books response invalid: ${z.prettifyError(parsed.error)}`);
      }
      books.push(...parsed.data.data);
      offset += parsed.data.data.length;
      // Stop on a short/empty page even if `total` is stale — never loop forever.
      if (parsed.data.data.length === 0 || offset >= parsed.data.total) break;
    }
    return books;
  }

  /** POST a per-book attribution audit (idempotent upsert keyed by book on the provider). */
  async postAttributionAudit(
    publicId: string,
    audit: AttributionAuditInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const url = `${this.base}/api/v1/books/${encodeURIComponent(publicId)}/attribution-audit`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this.authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(audit),
      signal: opts.signal ?? null,
    });
    if (!res.ok) {
      throw new Error(`narratorr audit POST ${res.status} for ${publicId}: ${(await res.text()).slice(0, 300)}`);
    }
  }
}
