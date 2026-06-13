import { useMemo, useState } from 'react';
import type { Attribution, BookResult, Flag } from '@shared/schemas.js';

const SEV_STYLE: Record<Flag['severity'], string> = {
  mismatch: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
  missing_tag: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  low_confidence: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
};

function flagFor(book: BookResult, field: 'title' | 'author' | 'narrator'): Flag | undefined {
  return book.flags.find((f) => f.field === field);
}

function attrValue(a: Attribution, field: 'title' | 'author' | 'narrator'): string {
  if (field === 'title') return a.title ?? '';
  return (field === 'author' ? a.authors : a.narrators).join(', ');
}

function rank(b: BookResult): number {
  if (b.error) return 0;
  if (b.flags.some((f) => f.severity === 'mismatch')) return 1;
  if (b.flags.length > 0) return 2;
  if (!b.attributionPresent) return 3;
  return 4;
}

function StatusChip({ book }: { book: BookResult }) {
  if (book.error) return <Chip className="border-rose-500/40 bg-rose-500/15 text-rose-300">error</Chip>;
  if (!book.attributionPresent)
    return <Chip className="border-amber-500/40 bg-amber-500/15 text-amber-300">no attribution</Chip>;
  if (book.flags.length > 0)
    return (
      <Chip className="border-orange-500/40 bg-orange-500/15 text-orange-300">
        {book.flags.length} flag{book.flags.length > 1 ? 's' : ''}
      </Chip>
    );
  return <Chip className="border-emerald-500/40 bg-emerald-500/15 text-emerald-300">verified</Chip>;
}

function Chip({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

function FieldRow({ book, field }: { book: BookResult; field: 'title' | 'author' | 'narrator' }) {
  const flag = flagFor(book, field);
  const detected = attrValue(book.detected, field);
  const tagged = attrValue(book.tags, field);
  return (
    <div className="grid grid-cols-[5rem_1fr_1fr] items-baseline gap-2 py-1 text-sm">
      <span className="text-neutral-500">{field}</span>
      <span className={flag ? SEV_STYLE[flag.severity].replace(/border-\S+|bg-\S+/g, '') : 'text-neutral-200'}>
        {detected || <span className="text-neutral-600">—</span>}
      </span>
      <span className="text-neutral-400">
        {tagged || <span className="text-neutral-600">— (no tag)</span>}
        {flag && (
          <span className={`ml-2 rounded border px-1.5 py-0.5 text-xs ${SEV_STYLE[flag.severity]}`}>
            {flag.severity}
            {flag.similarity !== null ? ` ${(flag.similarity * 100).toFixed(0)}%` : ''}
          </span>
        )}
      </span>
    </div>
  );
}

function BookCard({ book }: { book: BookResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="min-w-0 truncate font-medium text-neutral-100">{book.name}</span>
        <span className="flex shrink-0 items-center gap-3">
          {book.attributionPresent && (
            <span className="text-xs text-neutral-500">{(book.confidence * 100).toFixed(0)}%</span>
          )}
          <StatusChip book={book} />
        </span>
      </button>

      <div className="border-t border-neutral-800 px-4 py-2">
        <div className="grid grid-cols-[5rem_1fr_1fr] gap-2 pb-1 text-xs uppercase tracking-wide text-neutral-600">
          <span />
          <span>heard</span>
          <span>tagged</span>
        </div>
        <FieldRow book={book} field="title" />
        <FieldRow book={book} field="author" />
        <FieldRow book={book} field="narrator" />
      </div>

      {open && (
        <div className="space-y-2 border-t border-neutral-800 px-4 py-3 text-sm">
          {book.error && <p className="text-rose-400">error: {book.error}</p>}
          <p className="text-neutral-500">
            <span className="text-neutral-600">intro:</span> {book.introTrackReason}
          </p>
          {book.evidence && (book.evidence.title || book.evidence.author || book.evidence.narrator) && (
            <div className="text-neutral-400">
              <span className="text-neutral-600">evidence:</span>
              <ul className="ml-4 list-disc">
                {(['title', 'author', 'narrator'] as const).map((k) =>
                  book.evidence[k] ? (
                    <li key={k}>
                      <span className="text-neutral-500">{k}:</span> “{book.evidence[k]}”
                    </li>
                  ) : null,
                )}
              </ul>
            </div>
          )}
          {book.transcriptExcerpt && (
            <p className="rounded-md bg-neutral-950/60 p-2 font-mono text-xs text-neutral-400">
              {book.transcriptExcerpt}
            </p>
          )}
          <p className="truncate font-mono text-xs text-neutral-600">{book.introTrackPath ?? book.sourcePath}</p>
        </div>
      )}
    </div>
  );
}

export function ResultsTable({ results }: { results: BookResult[] }) {
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const sorted = useMemo(() => {
    const filtered = onlyFlagged
      ? results.filter((b) => b.flags.length > 0 || !b.attributionPresent || b.error)
      : results;
    return [...filtered].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [results, onlyFlagged]);

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-neutral-400">
        <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
        only flagged ({results.filter((b) => b.flags.length > 0 || !b.attributionPresent || b.error).length})
      </label>
      {sorted.map((book) => (
        <BookCard key={book.sourcePath} book={book} />
      ))}
    </div>
  );
}
