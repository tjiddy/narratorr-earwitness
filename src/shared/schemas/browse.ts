import { z } from 'zod';

export const browseQuerySchema = z.object({
  path: z.string().optional(),
});

export const browseEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDir: z.boolean(),
});

export const browseResponseSchema = z.object({
  cwd: z.string(),
  parent: z.string().nullable(),
  browseRoots: z.array(z.string()),
  entries: z.array(browseEntrySchema),
});
export type BrowseResponse = z.infer<typeof browseResponseSchema>;
