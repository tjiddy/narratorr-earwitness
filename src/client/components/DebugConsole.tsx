import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { debugAttribution, type DebugRequest, type DebugResult, type DebugRunResult, type DebugWindow } from '../api';
import { Button } from './Button';
import { Badge, type BadgeVariant } from './Badge';
import { FormField } from './FormField';
import { LibraryPicker } from './LibraryPicker';
import { FolderIcon } from './icons';

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

export function DebugConsole() {
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [authors, setAuthors] = useState('');
  const [narrators, setNarrators] = useState('');
  const [whisperModel, setWhisperModel] = useState('');
  const [ollamaModel, setOllamaModel] = useState('');
  const [runs, setRuns] = useState(1);
  const [forceFresh, setForceFresh] = useState(true);
  const [returnTimestamps, setReturnTimestamps] = useState(false);
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
      <div className="glass-card grid grid-cols-1 gap-3 rounded-2xl p-4">
        <div className="flex items-end gap-2">
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
          <LibraryPicker
            onPick={(rel) => {
              setPath(rel);
              setShowPicker(false);
            }}
            onClose={() => setShowPicker(false)}
          />
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField id="dbg-title" label="Expected title" value={title} onChange={setTitle} placeholder="Virgin River" />
          <FormField id="dbg-authors" label="Expected authors (comma-sep)" value={authors} onChange={setAuthors} placeholder="Robyn Carr" />
          <FormField id="dbg-narrators" label="Expected narrators (comma-sep)" value={narrators} onChange={setNarrators} placeholder="Therese Plumb" />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <FormField id="dbg-whisper" label="Whisper model (blank = configured)" value={whisperModel} onChange={setWhisperModel} placeholder="small.en" />
          <FormField id="dbg-ollama" label="Ollama model (blank = configured)" value={ollamaModel} onChange={setOllamaModel} placeholder="qwen2.5:7b-instruct" />
          <FormField
            id="dbg-runs"
            label="Runs"
            type="number"
            value={String(runs)}
            onChange={(v) => setRuns(Math.min(10, Math.max(1, Number(v) || 1)))}
            min={1}
            max={10}
          />
          <div className="flex flex-col justify-end gap-2 pb-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={forceFresh} onChange={(e) => setForceFresh(e.target.checked)} />
              force fresh (bypass cache)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={returnTimestamps} onChange={(e) => setReturnTimestamps(e.target.checked)} />
              return_timestamps
            </label>
          </div>
        </div>

        {whisperOverride && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            ⚠ A Whisper model override runs against the shared single-resident model cache — it evicts the live production
            model while this run executes, briefly disrupting concurrent attribution.
          </p>
        )}

        <Button variant="primary" className="justify-self-start" disabled={!path || run.isPending} loading={run.isPending} onClick={submit}>
          {run.isPending ? 'Running…' : 'Run'}
        </Button>
      </div>

      {run.error && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {String(run.error.message ?? run.error)}
        </p>
      )}

      {run.data && (
        <div className="space-y-4">
          <ConfigBar config={run.data.config} />
          {run.data.runs.map((r, i) => (
            <RunCard key={i} index={i} run={r} totalRuns={run.data!.runs.length} />
          ))}
        </div>
      )}
    </section>
  );
}

function ConfigBar({ config }: { config: DebugResult['config'] }) {
  return (
    <div className="glass-card rounded-xl p-3 text-xs text-muted-foreground">
      <span className="text-foreground">{config.whisperBackend}</span> · whisper={config.whisperModel} · llm={config.ollamaModel} ·{' '}
      {config.seconds}s window · tail={String(config.tailSampling)} · ts={String(config.returnTimestamps)} · fresh={String(config.forceFresh)}
      {config.modelOverridden && (
        <Badge variant="warning" className="ml-2">
          model overridden — evicted production model
        </Badge>
      )}
    </div>
  );
}

function RunCard({ index, run, totalRuns }: { index: number; run: DebugRunResult; totalRuns: number }) {
  const d = run.detection;
  return (
    <div className="glass-card space-y-3 rounded-2xl p-4">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">
          Run {index + 1}/{totalRuns}
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
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          DETECTION (confidence {d.confidence.toFixed(2)}, present={String(d.attributionPresent)})
        </p>
        <p>title: {d.detected.title ?? <em className="text-muted-foreground/50">—</em>}</p>
        <p>authors: {d.detected.authors.join(', ') || <em className="text-muted-foreground/50">—</em>}</p>
        <p>narrators: {d.detected.narrators.join(', ') || <em className="text-muted-foreground/50">—</em>}</p>
      </div>

      {run.comparison && (
        <div className="rounded-xl bg-muted/40 p-3 text-sm">
          <p className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            COMPARISON <Badge variant={statusVariant(run.comparison.status)}>{run.comparison.status}</Badge>
          </p>
          {(['title', 'authors', 'narrators'] as const).map((f) => {
            const c = run.comparison!.fields[f];
            return (
              <p key={f} className="flex items-center gap-2 text-muted-foreground">
                {f}: <Badge variant={statusVariant(c.status)}>{c.status}</Badge> <span className="text-muted-foreground/70">— {c.reason}</span>
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
          {w.label} · {base(w.track)} @ {w.offset}s
        </span>
        <span className="text-muted-foreground">
          cache={w.cache} · {w.chars} chars · {w.ms}ms
        </span>
      </div>
      {w.rawExtraction && (
        <p className="mt-1 text-xs text-muted-foreground">
          raw: title={w.rawExtraction.title ?? '—'} / author={w.rawExtraction.author ?? '—'} / narrator={w.rawExtraction.narrator ?? '—'}{' '}
          (conf {w.rawExtraction.confidence.toFixed(2)})
          {w.nulledByGuard.length > 0 && <span className="ml-1 text-destructive">nulled by guard: {w.nulledByGuard.join(', ')}</span>}
        </p>
      )}
      <button className="mt-1 text-xs text-primary hover:underline" onClick={() => setOpen((o) => !o)}>
        {open ? 'hide transcript' : 'show transcript'}
      </button>
      {open && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-background/60 p-2 text-xs text-muted-foreground">{w.transcript}</pre>}
    </div>
  );
}
