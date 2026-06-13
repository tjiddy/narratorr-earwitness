import { z } from 'zod';
import { attributionSchema, evidenceSchema, flagSchema } from './result.js';

// CONTRACT with Narratorr — documented now, wired later (its APIs are being built
// in parallel). Shapes mirror Narratorr's real schemas so the two line up.

// Read (source): GET /api/library/books?limit&offset&status=imported
// Returns a PAGINATED envelope, NOT a bare array. `path` is nullable.
// See C:/Users/Todd/Code/narratorr/src/shared/schemas/library-book.ts
export const libraryBookListItemSchema = z.object({
  id: z.number(),
  title: z.string(),
  authors: z.array(z.object({ name: z.string() })),
  narrators: z.array(z.object({ name: z.string() })),
  path: z.string().nullable(),
});
export type LibraryBookListItem = z.infer<typeof libraryBookListItemSchema>;

export const libraryBookListResponseSchema = z.object({
  data: z.array(libraryBookListItemSchema),
  total: z.number(),
});
export type LibraryBookListResponse = z.infer<typeof libraryBookListResponseSchema>;

// Write (sink) — PROPOSED, idempotent per-book audit (NOT a per-flag firehose).
// POST /api/library/books/:id/attribution-audit
export const attributionAuditSchema = z.object({
  scanId: z.string(),
  attributionPresent: z.boolean(),
  detected: attributionSchema,
  confidence: z.number().min(0).max(1),
  evidence: evidenceSchema,
  models: z.object({ stt: z.string(), llm: z.string() }),
  flags: z.array(flagSchema),
});
export type AttributionAudit = z.infer<typeof attributionAuditSchema>;
