import { z } from 'zod';
import { attributionSchema, evidenceSchema } from './result.js';

// CONTRACT with narratorr for POST /api/v1/attribution (EARWITNESS-ATTRIBUTION-API-CONTRACT.md).
// One stateless endpoint: a file path (+ optional expected metadata) in → what earwitness heard,
// with evidence, plus an optional per-field comparison verdict. Detection is evidence-guarded fact
// (blind extraction); comparison is the sighted identity judgment and may never mutate detection.

// --- status enums ---

// Multi-value fields (and the rollup) can be `partial`; a single field can't.
export const fieldStatusSchema = z.enum(['match', 'mismatch', 'partial', 'unknown']);
export type FieldStatus = z.infer<typeof fieldStatusSchema>;

export const singleFieldStatusSchema = z.enum(['match', 'mismatch', 'unknown']);
export type SingleFieldStatus = z.infer<typeof singleFieldStatusSchema>;

// --- per-field comparison ---

export const singleFieldComparisonSchema = z.object({
  status: singleFieldStatusSchema,
  expected: z.string().nullable(),
  detected: z.string().nullable(),
  reason: z.string(), // HUMAN-READABLE ONLY — non-authoritative, consumers MUST NOT parse it.
});
export type SingleFieldComparison = z.infer<typeof singleFieldComparisonSchema>;

export const multiFieldComparisonSchema = z.object({
  status: fieldStatusSchema,
  expected: z.array(z.string()),
  detected: z.array(z.string()),
  // How the two lists reconcile under identity matching:
  matched: z.array(z.object({ expected: z.string(), detected: z.string() })),
  missingExpected: z.array(z.string()), // expected, not heard in the audio
  unexpectedDetected: z.array(z.string()), // heard in the audio, not in expected ← contradiction signal
  reason: z.string(), // HUMAN-READABLE ONLY — DO NOT PARSE.
});
export type MultiFieldComparison = z.infer<typeof multiFieldComparisonSchema>;

export const comparisonSchema = z.object({
  status: fieldStatusSchema, // overall rollup
  fields: z.object({
    title: singleFieldComparisonSchema,
    authors: multiFieldComparisonSchema,
    narrators: multiFieldComparisonSchema,
  }),
});
export type Comparison = z.infer<typeof comparisonSchema>;

// --- detection (what earwitness heard; evidence-guarded facts) ---

export const detectionSchema = z.object({
  attributionPresent: z.boolean(), // false = no citable spoken credit found (NOT a mismatch)
  detected: attributionSchema,
  evidence: evidenceSchema,
  confidence: z.number().min(0).max(1), // RAW — narratorr thresholds per its own policy
});
export type Detection = z.infer<typeof detectionSchema>;

// --- request / response ---

export const attributionRequestSchema = z.object({
  path: z.string().min(1), // library-relative POSIX path to the book's audio FILE or FOLDER
  expected: z
    .object({
      title: z.string().optional(),
      authors: z.array(z.string()).optional(),
      narrators: z.array(z.string()).optional(),
    })
    .optional(), // omit for a pure "what is this?" (detection only)
  requestId: z.string().optional(), // echoed back for narratorr's correlation/logging
});
export type AttributionRequest = z.infer<typeof attributionRequestSchema>;

export const attributionResponseSchema = z.object({
  requestId: z.string().nullable(),
  detection: detectionSchema,
  comparison: comparisonSchema.optional(), // present only when `expected` was supplied
});
export type AttributionResponse = z.infer<typeof attributionResponseSchema>;
