import { z } from 'zod';

// GET /api/library-browse — walks the configured library root so the debug console can
// pick a book by clicking instead of hand-typing a library-relative path. Distinct from
// /api/browse (which lists the BROWSE_ROOTS for scanning, in absolute paths): every path
// here is library-RELATIVE — exactly what POST /api/v1/attribution + the debug console want.

export const libraryBrowseQuerySchema = z.object({
  // Library-relative dir to list. Omitted/empty → the library root itself.
  path: z.string().optional(),
});
export type LibraryBrowseQuery = z.infer<typeof libraryBrowseQuerySchema>;

export const libraryEntrySchema = z.object({
  name: z.string(),
  path: z.string(), // library-RELATIVE (POSIX-ish) path to this entry
  isDir: z.boolean(),
});
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;

export const libraryBrowseResponseSchema = z.object({
  root: z.string(), // absolute library root, for display ("relative to <root>")
  cwd: z.string(), // library-relative path of the listed dir ('' = root)
  parent: z.string().nullable(), // library-relative parent, or null at the root
  entries: z.array(libraryEntrySchema),
});
export type LibraryBrowseResponse = z.infer<typeof libraryBrowseResponseSchema>;
