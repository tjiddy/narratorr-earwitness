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

export const startScanRequestSchema = z.object({
  source: z.literal('local').default('local'),
  root: z.string().min(1),
});
export type StartScanRequest = z.infer<typeof startScanRequestSchema>;

export const startScanResponseSchema = z.object({ id: z.string() });

// Lightweight progress shape the frontend polls.
export const scanProgressSchema = z.object({
  id: z.string(),
  source: z.string(),
  root: z.string(),
  status: scanStatusSchema,
  total: z.number(),
  processed: z.number(),
  currentBook: z.string().nullable(),
  error: z.string().nullable(),
});
export type ScanProgress = z.infer<typeof scanProgressSchema>;

export const scanResultsSchema = scanProgressSchema.extend({
  results: z.array(bookResultSchema),
});
export type ScanResults = z.infer<typeof scanResultsSchema>;
