import { z } from 'zod';
import { extractionSchema, type Extraction } from '@shared/schemas.js';

// Bump when the prompt or schema changes — it's part of the extraction cache key,
// so old cached extractions are invalidated automatically.
export const PROMPT_VERSION = 'v1';

const SYSTEM_PROMPT = `You identify the audiobook from a transcript of its opening seconds.

The opening often contains a publisher intro like "Audible presents TITLE by AUTHOR, narrated by NARRATOR". Extract title, author, narrator, and publisher from it.

Rules:
- If the transcript is just story prose / contains NO publisher/title/author/narrator attribution, set "attributionPresent": false and leave title, author, narrator, publisher null. DO NOT infer them from the story content — guessing is worse than saying you don't know.
- For every non-null field you DO fill, copy the exact verbatim words from the transcript that justify it into the matching "evidence" field. If you cannot point to the words, the field must be null.
- "confidence" (0..1) reflects how clearly the attribution was stated. Lower it when audio is garbled or attribution is partial.
- Author and narrator may list multiple people; join them naturally (e.g. "Jane Doe and John Roe").
- Respond ONLY with JSON matching the schema.`;

// JSON Schema for Ollama's structured-output `format`, derived from the zod schema.
const jsonSchema = z.toJSONSchema(extractionSchema);

export interface ExtractOptions {
  host: string;
  model: string;
}

export async function extract(transcript: string, opts: ExtractOptions): Promise<Extraction> {
  const body = {
    model: opts.model,
    stream: false,
    format: jsonSchema,
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Transcript:\n"""\n${transcript}\n"""` },
    ],
  };

  const res = await fetch(`${opts.host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? '';
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`ollama returned non-JSON content: ${content.slice(0, 200)}`);
  }

  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`extraction did not match schema: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
