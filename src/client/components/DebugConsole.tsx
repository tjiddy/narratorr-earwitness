import { useState, type ElementType, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { debugAttribution, type DebugRequest, type DebugResult, type DebugRunResult, type DebugWindow } from '../api';
import { Button } from './Button';
import { Badge, type BadgeVariant } from './Badge';
import { FormField } from './FormField';
import { LibraryPicker } from './LibraryPicker';
import { FolderIcon, TagIcon, SlidersIcon } from './icons';

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const STATUS_BADGE: Record<string, BadgeVariant> = {
  match: 'success',
  mismatch: 'danger',
  partial: 'warning',
};
const statusVariant = (status: string): BadgeVariant => STATUS_BADGE[status] ?? 'muted';

// Section shell: a primary-tinted icon chip + Playfair heading + muted subtitle, in a
// glass card. Matches the app's editorial look (App.tsx / SettingsPage) and gives each
// concern its own breathing room.
function Section({
  icon: Icon,
  title,
  subtitle,
  className,
  children,
}: {
  icon: ElementType;
  title: string;
  subtitle?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`glass-card rounded-2xl p-5 sm:p-6 ${className ?? ''}`}>
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <h3 className="font-display text-lg font-semibold leading-tight">{title}</h3>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </div>
  );
}

function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border accent-primary"
      />
      <span>{label}</span>
    </label>
  );
}

export function DebugConsole() {
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [authors, setAuthors] = useState('');
  const [narrators, setNarrators] = useState('');
  const [whisperModel, setWhisperModel] = useState('');
  const [ollamaModel, setOllamaModel] = useState('');
  const [runs, setRuns] = useState(1);
  const [forceFresh, setForceFresh] = useState(true);
  // Defaults true to mirror the transformersjs production default (reliable chunk stitching);
  // uncheck to compare the off behavior.
  const [returnTimestamps, setReturnTimestamps] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  const run = useMutation<DebugResult, Error, DebugRequest>({
    mutationFn: (body) => debugAttribution(body),
  });

  const submit = () => {
    const expected =
      title || authors || narrators
        ? { ...(title ? { title } : {}), ...(authors ? { authors: csv(authors) } : {}), ...(narrators ? { narrators: csv(narrators) } : {}) }
        : undefined;
    run.mutate({
      path,
      ...(expected ? { expected } : {}),
      ...(whisperModel.trim() ? { whisperModel: whisperModel.trim() } : {}),
      ...(ollamaModel.trim() ? { ollamaModel: ollamaModel.trim() } : {}),
      returnTimestamps,
      forceFresh,
      runs,
    });
  };

  // Only a WHISPER override evicts the in-process (single-resident) model; an Ollama
  // override just points at a different external LLM, so it's harmless.
  const whisperOverride = whisperModel.trim() !== '';

  return (
    <section className="space-y-5">
      {/* 1 — Book selection */}
      <Section
        icon={FolderIcon}
        title="Book"
        subtitle="Pick the library book to analyze"
        className="animate-fade-in-up"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <FormField
            id="dbg-path"
            label="Library-relative path (file or folder)"
            value={path}
            onChange={setPath}
            placeholder="Author/Series/Book Title"
            className="flex-1"
          />
          <Button variant="secondary" icon={FolderIcon} onClick={() => setShowPicker((s) => !s)}>
            {showPicker ? 'Hide' : 'Browse'}
          </Button>
        </div>
        {showPicker && (
          <div className="mt-3">
            <LibraryPicker
              onPick={(rel) => {
                setPath(rel);
                setShowPicker(false);
              }}
              onClose={() => setShowPicker(false)}
            />
          </div>
        )}
      </Section>

      {/* 2 — Expected metadata */}
      <Section
        icon={TagIcon}
        title="Expected metadata"
        subtitle="Optional — what it SHOULD be, compared against what earwitness hears"
        className="animate-fade-in-up stagger-1"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField id="dbg-title" label="Title" value={title} onChange={setTitle} placeholder="Virgin River" />
          <FormField id="dbg-authors" label="Authors (comma-separated)" value={authors} onChange={setAuthors} placeholder="Robyn Carr" />
          <FormField id="dbg-narrators" label="Narrators (comma-separated)" value={narrators} onChange={setNarrators} placeholder="Therese Plumb" />
        </div>
      </Section>

      {/* 3 — Models & run options */}
      <Section
        icon={SlidersIcon}
        title="Models & run options"
        subtitle="Leave a model blank to use the configured default"
        className="animate-fade-in-up stagger-2"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField id="dbg-whisper" label="Whisper model" value={whisperModel} onChange={setWhisperModel} placeholder="small.en" hint="override the STT model" />
          <FormField id="dbg-ollama" label="Ollama model" value={ollamaModel} onChange={setOllamaModel} placeholder="qwen2.5:7b-instruct" hint="override the extraction LLM" />
          <FormField
            id="dbg-runs"
            label="Runs"
            type="number"
            value={String(runs)}
            onChange={(v) => setRuns(Math.min(10, Math.max(1, Number(v) || 1)))}
            min={1}
            max={10}
            hint="re-run to eyeball variance"
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3">
          <CheckRow checked={forceFresh} onChange={setForceFresh} label="force fresh (bypass cache)" />
          <CheckRow checked={returnTimestamps} onChange={setReturnTimestamps} label="return_timestamps" />
        </div>

        {whisperOverride && (
          <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            ⚠ A Whisper model override runs against the shared single-resident model cache — it evicts the live production
            model while this run executes, briefly disrupting concurrent attribution.
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border/50 pt-5">
          <Button variant="primary" disabled={!path || run.isPending} loading={run.isPending} onClick={submit}>
            {run.isPending ? 'Running…' : 'Run analysis'}
          </Button>
          {!path && <span className="text-sm text-muted-foreground">Select a book above to run.</span>}
        </div>
      </Section>

      {run.error && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {String(run.error.message ?? run.error)}
        </p>
      )}

      {run.data && (
        <div className="space-y-4 animate-fade-in-up">
          <ConfigBar config={run.data.config} />
          {run.data.runs.map((r, i) => (
            <RunCard key={i} index={i} run={r} totalRuns={run.data!.runs.length} />
          ))}
        </div>
      )}
    </section>
  );
}

function Chip({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5">
      <span className="text-muted-foreground/70">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

function ConfigBar({ config }: { config: DebugResult['config'] }) {
  return (
    <div className="glass-card flex flex-wrap items-center gap-2 rounded-2xl p-4 text-xs">
      <Badge variant="info">{config.whisperBackend}</Badge>
      <Chip label="whisper" value={config.whisperModel} />
      <Chip label="llm" value={config.ollamaModel} />
      <Chip label="window" value={`${config.seconds}s`} />
      <Chip label="tail" value={String(config.tailSampling)} />
      <Chip label="ts" value={String(config.returnTimestamps)} />
      <Chip label="fresh" value={String(config.forceFresh)} />
      {config.modelOverridden && <Badge variant="warning">model overridden — evicted production model</Badge>}
    </div>
  );
}

function RunCard({ index, run, totalRuns }: { index: number; run: DebugRunResult; totalRuns: number }) {
  const d = run.detection;
  return (
    <div className="glass-card space-y-3 rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <span className="font-display text-base font-semibold">
          Run {index + 1}
          <span className="text-muted-foreground">/{totalRuns}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {run.totalMs}ms{run.compareMs !== undefined ? ` (compare ${run.compareMs}ms)` : ''}
        </span>
      </div>

      {run.error && (
        <p className="text-sm text-destructive">
          error ({run.errorKind}): {run.error}
        </p>
      )}

      {run.trace.book && (
        <p className="text-xs text-muted-foreground">
          {run.trace.book.tracks.length} track{run.trace.book.tracks.length === 1 ? '' : 's'} · head={base(run.trace.book.firstTrack)} · tail=
          {base(run.trace.book.lastTrack)}
        </p>
      )}

      {run.trace.windows.map((w, i) => (
        <WindowBlock key={i} w={w} />
      ))}

      {run.trace.selection && (
        <p className="text-xs text-muted-foreground">
          selection: <span className="text-foreground">{run.trace.selection.winner}</span> (head {run.trace.selection.headScore} vs tail{' '}
          {run.trace.selection.tailScore}, tailSampled={String(run.trace.selection.tailSampled)})
        </p>
      )}

      <div className="rounded-xl bg-muted/40 p-3 text-sm">
        <p className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          DETECTION
          <Badge variant={d.attributionPresent ? 'success' : 'muted'}>{d.attributionPresent ? 'present' : 'none'}</Badge>
          <span className="text-muted-foreground/70">conf {d.confidence.toFixed(2)}</span>
        </p>
        <dl className="grid grid-cols-[5rem_1fr] gap-y-1">
          <dt className="text-muted-foreground">title</dt>
          <dd>{d.detected.title ?? <em className="text-muted-foreground/50">—</em>}</dd>
          <dt className="text-muted-foreground">authors</dt>
          <dd>{d.detected.authors.join(', ') || <em className="text-muted-foreground/50">—</em>}</dd>
          <dt className="text-muted-foreground">narrators</dt>
          <dd>{d.detected.narrators.join(', ') || <em className="text-muted-foreground/50">—</em>}</dd>
        </dl>
      </div>

      {run.comparison && (
        <div className="rounded-xl bg-muted/40 p-3 text-sm">
          <p className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            COMPARISON <Badge variant={statusVariant(run.comparison.status)}>{run.comparison.status}</Badge>
          </p>
          {(['title', 'authors', 'narrators'] as const).map((f) => {
            const c = run.comparison!.fields[f];
            return (
              <p key={f} className="flex items-center gap-2 py-0.5 text-muted-foreground">
                <span className="w-20 shrink-0">{f}</span>
                <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                <span className="text-muted-foreground/70">— {c.reason}</span>
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WindowBlock({ w }: { w: DebugWindow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl bg-muted/40 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">
          <Badge variant="muted" className="mr-1.5">
            {w.label}
          </Badge>
          {base(w.track)} @ {w.offset}s
        </span>
        <span className="text-muted-foreground">
          cache={w.cache} · {w.chars} chars · {w.ms}ms
        </span>
      </div>
      {w.rawExtraction && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          raw: title={w.rawExtraction.title ?? '—'} / author={w.rawExtraction.author ?? '—'} / narrator={w.rawExtraction.narrator ?? '—'}{' '}
          (conf {w.rawExtraction.confidence.toFixed(2)})
          {w.nulledByGuard.length > 0 && <span className="ml-1 text-destructive">nulled by guard: {w.nulledByGuard.join(', ')}</span>}
        </p>
      )}
      <button className="mt-1.5 text-xs font-medium text-primary hover:underline" onClick={() => setOpen((o) => !o)}>
        {open ? 'hide transcript' : 'show transcript'}
      </button>
      {open && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-background/60 p-3 text-xs text-muted-foreground">{w.transcript}</pre>}
    </div>
  );
}
