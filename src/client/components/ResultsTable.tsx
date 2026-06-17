import { useMemo, useState } from 'react';
import type { Attribution, BookResult, Flag } from '@shared/schemas.js';
import { Badge, type BadgeVariant } from './Badge';

// Map a flag severity to a Badge variant + a text color for the inline "heard" value.
const SEV_BADGE: Record<Flag['severity'], BadgeVariant> = {
  mismatch: 'danger',
  missing_tag: 'warning',
  low_confidence: 'info',
};
const SEV_TEXT: Record<Flag['severity'], string> = {
  mismatch: 'text-destructive',
  missing_tag: 'text-amber-500',
  low_confidence: 'text-sky-500',
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

type Category = 'mismatch' | 'no_attribution' | 'error' | 'clean';

// Mutually-exclusive triage bucket so the three concerns get their own counts/toggles
// instead of being lumped into one diluted "flagged" number.
function category(b: BookResult): Category {
  if (b.error) return 'error';
  if (b.flags.length > 0) return 'mismatch';
  if (!b.attributionPresent) return 'no_attribution';
  return 'clean';
}

function StatusChip({ book }: { book: BookResult }) {
  if (book.error) return <Badge variant="danger">error</Badge>;
  if (!book.attributionPresent) return <Badge variant="warning">no attribution</Badge>;
  if (book.flags.length > 0)
    return (
      <Badge variant="warning">
        {book.flags.length} flag{book.flags.length > 1 ? 's' : ''}
      </Badge>
    );
  return <Badge variant="success">verified</Badge>;
}

function FieldRow({ book, field }: { book: BookResult; field: 'title' | 'author' | 'narrator' }) {
  const flag = flagFor(book, field);
  const detected = attrValue(book.detected, field);
  const tagged = attrValue(book.tags, field);
  return (
    <div className="grid grid-cols-[5rem_1fr_1fr] items-baseline gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{field}</span>
      <span className={flag ? SEV_TEXT[flag.severity] : 'text-foreground'}>
        {detected || <span className="text-muted-foreground/50">—</span>}
      </span>
      <span className="text-muted-foreground">
        {tagged || <span className="text-muted-foreground/50">— (no tag)</span>}
        {flag && (
          <Badge variant={SEV_BADGE[flag.severity]} className="ml-2">
            {flag.severity}
            {flag.similarity !== null ? ` ${(flag.similarity * 100).toFixed(0)}%` : ''}
          </Badge>
        )}
      </span>
    </div>
  );
}

function BookCard({ book }: { book: BookResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="glass-card rounded-2xl">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="min-w-0 truncate font-medium">{book.name}</span>
        <span className="flex shrink-0 items-center gap-3">
          {book.attributionPresent && <span className="text-xs text-muted-foreground">{(book.confidence * 100).toFixed(0)}%</span>}
          <StatusChip book={book} />
        </span>
      </button>

      <div className="border-t border-border/50 px-4 py-2">
        <div className="grid grid-cols-[5rem_1fr_1fr] gap-2 pb-1 text-xs uppercase tracking-wide text-muted-foreground/70">
          <span />
          <span>heard</span>
          <span>tagged</span>
        </div>
        <FieldRow book={book} field="title" />
        <FieldRow book={book} field="author" />
        <FieldRow book={book} field="narrator" />
      </div>

      {open && (
        <div className="space-y-2 border-t border-border/50 px-4 py-3 text-sm">
          {book.error && <p className="text-destructive">error: {book.error}</p>}
          <p className="text-muted-foreground">
            <span className="text-muted-foreground/70">intro:</span> {book.introTrackReason}
          </p>
          {book.evidence && (book.evidence.title || book.evidence.author || book.evidence.narrator) && (
            <div className="text-muted-foreground">
              <span className="text-muted-foreground/70">evidence:</span>
              <ul className="ml-4 list-disc">
                {(['title', 'author', 'narrator'] as const).map((k) =>
                  book.evidence[k] ? (
                    <li key={k}>
                      <span className="text-muted-foreground">{k}:</span> “{book.evidence[k]}”
                    </li>
                  ) : null,
                )}
              </ul>
            </div>
          )}
          {book.transcriptExcerpt && (
            <p className="rounded-lg bg-muted/50 p-2 font-mono text-xs text-muted-foreground">{book.transcriptExcerpt}</p>
          )}
          <p className="truncate font-mono text-xs text-muted-foreground/70">{book.introTrackPath ?? book.sourcePath}</p>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  count,
  checked,
  onChange,
}: {
  label: string;
  count: number;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`flex items-center gap-2 ${count === 0 ? 'opacity-40' : ''}`}>
      <input type="checkbox" checked={checked} disabled={count === 0} onChange={(e) => onChange(e.target.checked)} />
      {label} ({count})
    </label>
  );
}

export function ResultsTable({ results }: { results: BookResult[] }) {
  const [filters, setFilters] = useState({ mismatch: false, no_attribution: false, error: false });

  const counts = useMemo(() => {
    const c = { mismatch: 0, no_attribution: 0, error: 0 };
    for (const b of results) {
      const cat = category(b);
      if (cat !== 'clean') c[cat] += 1;
    }
    return c;
  }, [results]);

  const anyFilter = filters.mismatch || filters.no_attribution || filters.error;
  const sorted = useMemo(() => {
    const filtered = anyFilter
      ? results.filter((b) => {
          const cat = category(b);
          return cat !== 'clean' && filters[cat];
        })
      : results;
    return [...filtered].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [results, filters, anyFilter]);

  const set = (key: keyof typeof filters) => (v: boolean) => setFilters((f) => ({ ...f, [key]: v }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
        <Toggle label="mismatches" count={counts.mismatch} checked={filters.mismatch} onChange={set('mismatch')} />
        <Toggle label="no attribution" count={counts.no_attribution} checked={filters.no_attribution} onChange={set('no_attribution')} />
        <Toggle label="errors" count={counts.error} checked={filters.error} onChange={set('error')} />
      </div>
      {sorted.map((book) => (
        <BookCard key={book.sourcePath} book={book} />
      ))}
    </div>
  );
}
