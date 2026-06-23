// Dump narratorr's imported books → the audit book-list JSON the scan driver consumes.
//
// RUNS INSIDE the narratorr container (it uses the container's bundled @libsql/client —
// there is no sqlite3 CLI). The skill base64-encodes this file and pipes it through
// docker-exec; stdout (a JSON array) is captured locally to <AUDIT_DATA>/audit-books.json.
//
//   B64=$(base64 -w0 dump-books.mjs)
//   ~/.claude/scripts/docker-exec.sh --container narratorr \
//     "cd /app && echo $B64 | base64 -d | node" > audit-books.json
//
// Output shape (one per imported book with a folder path):
//   { id, title, status, rel, path, audioFileCount, authors[], narrators[] }
//   rel = path minus the leading "/audiobooks/" (what earwitness's library root expects).
//
// Schema assumed (narratorr, Drizzle): books(id,title,status,path,audio_file_count),
//   authors(id,name) ↔ book_authors(book_id,author_id),
//   narrators(id,name) ↔ book_narrators(book_id,narrator_id).
// If the dump errors on an unknown column/table, introspect live and adjust:
//   docker-exec --container narratorr "cd /app && node -e \"...PRAGMA table_info(books)...\""
//   (the SKILL.md 'Schema drift' note has the full recipe.)
import { createClient } from '@libsql/client';

const DB = process.env.DUMP_DB || 'file:/config/narratorr.db';
const db = createClient({ url: DB.startsWith('file:') ? DB : `file:${DB}` });

const pickCount = (row) => row.audio_file_count ?? row.audioFileCount ?? row.file_count ?? null;
const relOf = (p) => String(p ?? '').replace(/^\/audiobooks\//, '').replace(/^\/+/, '');

const names = async (table, fk, lookup) => {
  const { rows } = await db.execute({
    sql: `SELECT j.${fk} AS book_id, n.name AS name
            FROM ${table} j JOIN ${lookup} n ON n.id = j.${lookup.replace(/s$/, '')}_id`,
    args: [],
  });
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.book_id)) m.set(r.book_id, []);
    if (r.name) m.get(r.book_id).push(r.name);
  }
  return m;
};

const { rows: books } = await db.execute('SELECT * FROM books');
const authorsBy = await names('book_authors', 'book_id', 'authors');
const narratorsBy = await names('book_narrators', 'book_id', 'narrators');

const out = books
  .map((b) => ({
    id: b.id,
    title: b.title,
    status: b.status,
    path: b.path,
    rel: relOf(b.path),
    audioFileCount: pickCount(b),
    authors: authorsBy.get(b.id) ?? [],
    narrators: narratorsBy.get(b.id) ?? [],
  }))
  .filter((b) => b.status === 'imported' && b.rel);

process.stdout.write(JSON.stringify(out));
process.stderr.write(`dumped ${out.length} imported books\n`);
