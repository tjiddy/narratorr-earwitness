import { z } from 'zod';

// CONTRACT with Narratorr v1.1 — mirrors the provider's committed design in the
// narratorr repo (NARRATORR-V1.1-EARWITNESS-DESIGN.md). Auth is the `X-Api-Key`
// header (any valid /api/v* key; no per-key scope). Read shapes are kept NON-strict
// on purpose: BookV1 is additive over time, so a forward-compatible client must not
// reject unknown fields.

// --- Read: GET /api/v1/books?status=imported&limit&offset ---

export const narratorrBookStatusSchema = z.enum([
  'wanted',
  'searching',
  'downloading',
  'importing',
  'imported',
  'missing',
  'failed',
]);
export type NarratorrBookStatus = z.infer<typeof narratorrBookStatusSchema>;

export const narratorrPersonSchema = z.object({ id: z.string(), name: z.string() });

export const narratorrBookSchema = z.object({
  id: z.string(), // opaque publicId (base64url) — treat as opaque, no charset assumptions
  title: z.string(),
  authors: z.array(narratorrPersonSchema),
  narrators: z.array(narratorrPersonSchema),
  series: z.object({ name: z.string(), position: z.number().nullable() }).nullable(),
  status: narratorrBookStatusSchema,
  // library-RELATIVE POSIX path to the audio file OR folder; null = skip (no path,
  // or path outside the configured library root). Join to EARWITNESS_LIBRARY_ROOT.
  path: z.string().nullable(),
  // Derived signals the provider exposes for its UI; earwitness produces (not consumes) them.
  attributionWarning: z.boolean().optional(),
  attributionUnverified: z.boolean().optional(),
});
export type NarratorrBook = z.infer<typeof narratorrBookSchema>;

export const narratorrBookListResponseSchema = z.object({
  data: z.array(narratorrBookSchema),
  total: z.number(),
});
export type NarratorrBookListResponse = z.infer<typeof narratorrBookListResponseSchema>;

// --- Write: POST /api/v1/books/:publicId/attribution-audit (idempotent upsert by book) ---
// Caps mirror the provider's `.max()` bounds so we never send a payload it would 400.
// Our real values sit well under every cap (excerpt ≤400, ≤3 flags, etc.).

export const attributionAuditInputSchema = z.object({
  scanId: z.string(),
  scannedAt: z.string(), // ISO-8601, set at POST time via new Date().toISOString()
  attributionPresent: z.boolean(),
  detected: z.object({
    title: z.string().max(1000).nullable(),
    authors: z.array(z.string().max(500)).max(64),
    narrators: z.array(z.string().max(500)).max(64),
  }),
  confidence: z.number().min(0).max(1),
  evidence: z.object({
    title: z.string().nullable(),
    author: z.string().nullable(),
    narrator: z.string().nullable(),
  }),
  flags: z
    .array(
      z.object({
        field: z.enum(['title', 'author', 'narrator']),
        tagValue: z.string().nullable(),
        detectedValue: z.string().nullable(),
        similarity: z.number().min(0).max(1).nullable(),
        severity: z.enum(['mismatch', 'missing_tag', 'low_confidence']),
      }),
    )
    .max(24),
  models: z.object({ stt: z.string().max(200), llm: z.string().max(200) }),
  transcriptExcerpt: z.string().max(8000).nullable(),
});
export type AttributionAuditInput = z.infer<typeof attributionAuditInputSchema>;
