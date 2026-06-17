import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { debugAttribution, type DebugRequest, type DebugResult, type DebugRunResult, type DebugWindow } from '../api';

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const KEY_STORAGE = 'ew-debug-api-key';

export function DebugConsole() {
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [authors, setAuthors] = useState('');
  const [narrators, setNarrators] = useState('');
  const [whisperModel, setWhisperModel] = useState('');
  const [runs, setRuns] = useState(1);
  const [forceFresh, setForceFresh] = useState(true);
  const [returnTimestamps, setReturnTimestamps] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? '');

  const run = useMutation<DebugResult, Error, DebugRequest>({
    mutationFn: (body) => debugAttribution(body, apiKey),
  });

  const submit = () => {
    localStorage.setItem(KEY_STORAGE, apiKey);
    const expected =
      title || authors || narrators
        ? { ...(title ? { title } : {}), ...(authors ? { authors: csv(authors) } : {}), ...(narrators ? { narrators: csv(narrators) } : {}) }
        : undefined;
    run.mutate({
      path,
      ...(expected ? { expected } : {}),
      ...(whisperModel.trim() ? { whisperModel: whisperModel.trim() } : {}),
      returnTimestamps,
      forceFresh,
      runs,
    });
  };

  const field = 'w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600';
  const label = 'text-xs font-medium text-neutral-400';

  return (
    <section className="space-y-5">
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
        <div>
          <label className={label}>Library-relative path (file or folder)</label>
          <input className={field} value={path} onChange={(e) => setPath(e.target.value)} placeholder="Author/Series/Book Title" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className={label}>Expected title</label>
            <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Virgin River" />
          </div>
          <div>
            <label className={label}>Expected authors (comma-sep)</label>
            <input className={field} value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="Robyn Carr" />
          </div>
          <div>
            <label className={label}>Expected narrators (comma-sep)</label>
            <input className={field} value={narrators} onChange={(e) => setNarrators(e.target.value)} placeholder="Therese Plumb" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className={label}>Whisper model (blank = configured)</label>
            <input className={field} value={whisperModel} onChange={(e) => setWhisperModel(e.target.value)} placeholder="small.en" />
          </div>
          <div>
            <label className={label}>Runs</label>
            <input
              className={field}
              type="number"
              min={1}
              max={10}
              value={runs}
              onChange={(e) => setRuns(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
            />
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm text-neutral-300">
            <input type="checkbox" checked={forceFresh} onChange={(e) => setForceFresh(e.target.checked)} />
            force fresh (bypass cache)
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-neutral-300">
            <input type="checkbox" checked={returnTimestamps} onChange={(e) => setReturnTimestamps(e.target.checked)} />
            return_timestamps
          </label>
        </div>
        <div>
          <label className={label}>API key (X-Api-Key — from /data/api-key)</label>
          <input className={field} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="required from a non-loopback browser" />
        </div>
        <button
          className="justify-self-start rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white enabled:hover:bg-indigo-500 disabled:opacity-40"
          disabled={!path || run.isPending}
          onClick={submit}
        >
          {run.isPending ? 'Running…' : 'Run'}
        </button>
      </div>

      {run.error && <p className="text-sm text-rose-400">{String(run.error.message ?? run.error)}</p>}

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
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-400">
      <span className="text-neutral-300">{config.whisperBackend}</span> · whisper={config.whisperModel} · llm={config.ollamaModel} ·{' '}
      {config.seconds}s window · tail={String(config.tailSampling)} · ts={String(config.returnTimestamps)} · fresh={String(config.forceFresh)}
      {config.modelOverridden && (
        <span className="ml-2 rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-300">model overridden — evicted production model</span>
      )}
    </div>
  );
}

const pill = (status: string) => {
  const c =
    status === 'match'
      ? 'bg-emerald-900/50 text-emerald-300'
      : status === 'mismatch'
        ? 'bg-rose-900/50 text-rose-300'
        : status === 'partial'
          ? 'bg-amber-900/50 text-amber-300'
          : 'bg-neutral-800 text-neutral-400';
  return `rounded px-1.5 py-0.5 text-xs ${c}`;
};

function RunCard({ index, run, totalRuns }: { index: number; run: DebugRunResult; totalRuns: number }) {
  const d = run.detection;
  return (
    <div className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-neutral-200">
          Run {index + 1}/{totalRuns}
        </span>
        <span className="text-xs text-neutral-500">
          {run.totalMs}ms{run.compareMs !== undefined ? ` (compare ${run.compareMs}ms)` : ''}
        </span>
      </div>

      {run.error && <p className="text-sm text-rose-400">error ({run.errorKind}): {run.error}</p>}

      {run.trace.book && (
        <p className="text-xs text-neutral-500">
          {run.trace.book.tracks.length} track{run.trace.book.tracks.length === 1 ? '' : 's'} · head={base(run.trace.book.firstTrack)} · tail=
          {base(run.trace.book.lastTrack)}
        </p>
      )}

      {run.trace.windows.map((w, i) => (
        <WindowBlock key={i} w={w} />
      ))}

      {run.trace.selection && (
        <p className="text-xs text-neutral-400">
          selection: <span className="text-neutral-200">{run.trace.selection.winner}</span> (head {run.trace.selection.headScore} vs tail{' '}
          {run.trace.selection.tailScore}, tailSampled={String(run.trace.selection.tailSampled)})
        </p>
      )}

      <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3 text-sm">
        <p className="mb-1 text-xs font-medium text-neutral-400">DETECTION (confidence {d.confidence.toFixed(2)}, present={String(d.attributionPresent)})</p>
        <p className="text-neutral-200">title: {d.detected.title ?? <em className="text-neutral-600">—</em>}</p>
        <p className="text-neutral-200">authors: {d.detected.authors.join(', ') || <em className="text-neutral-600">—</em>}</p>
        <p className="text-neutral-200">narrators: {d.detected.narrators.join(', ') || <em className="text-neutral-600">—</em>}</p>
      </div>

      {run.comparison && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3 text-sm">
          <p className="mb-1 text-xs font-medium text-neutral-400">
            COMPARISON <span className={pill(run.comparison.status)}>{run.comparison.status}</span>
          </p>
          {(['title', 'authors', 'narrators'] as const).map((f) => {
            const c = run.comparison!.fields[f];
            return (
              <p key={f} className="text-neutral-300">
                {f}: <span className={pill(c.status)}>{c.status}</span> <span className="text-neutral-500">— {c.reason}</span>
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
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-neutral-300">
          {w.label} · {base(w.track)} @ {w.offset}s
        </span>
        <span className="text-neutral-500">
          cache={w.cache} · {w.chars} chars · {w.ms}ms
        </span>
      </div>
      {w.rawExtraction && (
        <p className="mt-1 text-xs text-neutral-400">
          raw: title={w.rawExtraction.title ?? '—'} / author={w.rawExtraction.author ?? '—'} / narrator={w.rawExtraction.narrator ?? '—'}{' '}
          (conf {w.rawExtraction.confidence.toFixed(2)})
          {w.nulledByGuard.length > 0 && <span className="ml-1 text-rose-400">nulled by guard: {w.nulledByGuard.join(', ')}</span>}
        </p>
      )}
      <button className="mt-1 text-xs text-indigo-400 hover:text-indigo-300" onClick={() => setOpen((o) => !o)}>
        {open ? 'hide transcript' : 'show transcript'}
      </button>
      {open && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-xs text-neutral-300">{w.transcript}</pre>}
    </div>
  );
}
