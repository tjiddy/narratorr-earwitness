import { z } from 'zod';
import { bookResultSchema } from './result.js';

export const scanStatusSchema = z.enum([
  'pending',
  'discovering',
  'processing',
  'completed',
  'failed',
  'cancelled',
]);
export type ScanStatus = z.infer<typeof scanStatusSchema>;

// Single source-of-truth for the scan source — shared by the request and the
// progress/response shapes so the response can't silently widen to `string`.
export const sourceSchema = z.enum(['local']);
export type Source = z.infer<typeof sourceSchema>;

export const startScanRequestSchema = z.object({
  source: sourceSchema.default('local'),
  root: z.string().min(1),
});
export type StartScanRequest = z.infer<typeof startScanRequestSchema>;

export const startScanResponseSchema = z.object({ id: z.string() });

// Lightweight progress shape the frontend polls. `currentBooks` is a list because
// MAX_CONCURRENT_BOOKS>1 means several books are in flight at once.
export const scanProgressSchema = z.object({
  id: z.string(),
  source: sourceSchema,
  root: z.string(),
  status: scanStatusSchema,
  total: z.number(),
  processed: z.number(),
  currentBooks: z.array(z.string()),
  error: z.string().nullable(),
});
export type ScanProgress = z.infer<typeof scanProgressSchema>;

export const scanResultsSchema = scanProgressSchema.extend({
  results: z.array(bookResultSchema),
});
export type ScanResults = z.infer<typeof scanResultsSchema>;
