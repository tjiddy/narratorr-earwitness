import { z } from 'zod';

// The structured output we force out of the extraction LLM (Ollama `format`).
// `evidence.*` is the verbatim transcript span that justifies each field — the
// primary anti-hallucination guard. If a field can't be cited, it should be null
// and confidence should drop / attributionPresent should be false.
export const extractionSchema = z.object({
  attributionPresent: z.boolean(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  narrator: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.object({
    title: z.string().nullable(),
    author: z.string().nullable(),
    narrator: z.string().nullable(),
  }),
});

export type Extraction = z.infer<typeof extractionSchema>;
