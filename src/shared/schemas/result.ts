import { z } from 'zod';

// Authors/narrators are arrays to mirror Narratorr's model and to handle
// multi-cast books. Title stays single.
export const attributionSchema = z.object({
  title: z.string().nullable(),
  authors: z.array(z.string()),
  narrators: z.array(z.string()),
});
export type Attribution = z.infer<typeof attributionSchema>;

export const flagFieldSchema = z.enum(['title', 'author', 'narrator']);
// NOTE: `no_attribution` is deliberately NOT here — it's a book-level outcome
// (`attributionPresent=false`), not a per-field flag. Keeps "couldn't verify"
// distinct from "tag is wrong".
export const flagSeveritySchema = z.enum(['mismatch', 'missing_tag', 'low_confidence']);

export const flagSchema = z.object({
  field: flagFieldSchema,
  tagValue: z.string().nullable(),
  detectedValue: z.string().nullable(),
  similarity: z.number().min(0).max(1).nullable(),
  severity: flagSeveritySchema,
});
export type Flag = z.infer<typeof flagSchema>;

export const evidenceSchema = z.object({
  title: z.string().nullable(),
  author: z.string().nullable(),
  narrator: z.string().nullable(),
});

export const bookResultSchema = z.object({
  name: z.string(),
  sourcePath: z.string(),
  introTrackPath: z.string().nullable(),
  introTrackReason: z.string(),
  attributionPresent: z.boolean(),
  detected: attributionSchema,
  confidence: z.number().min(0).max(1),
  evidence: evidenceSchema,
  tags: attributionSchema,
  flags: z.array(flagSchema),
  transcriptExcerpt: z.string().nullable(),
  error: z.string().nullable(),
  // When `error` is set, whether it's permanent for this file (undecodable audio →
  // don't retry) or transient (timeout / dependency → retry). null when no error.
  // `.default(null)` keeps older reports (written before this field) valid on re-read.
  errorKind: z.enum(['unprocessable', 'transient']).nullable().default(null),
});
export type BookResult = z.infer<typeof bookResultSchema>;
