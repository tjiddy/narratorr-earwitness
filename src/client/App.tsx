import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ReadinessBanner } from './components/ReadinessBanner';
import { FolderPicker } from './components/FolderPicker';
import { ResultsTable } from './components/ResultsTable';
import { DebugConsole } from './components/DebugConsole';
import { startScan, getScan, getResults, cancelScan, getConfig } from './api';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const STATUS_LABEL: Record<string, string> = {
  pending: 'Starting…',
  discovering: 'Discovering books…',
  processing: 'Listening…',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function App() {
  const [view, setView] = useState<'scan' | 'debug'>('scan');
  const [scanId, setScanId] = useState<string | null>(null);
  // The Debug tab only exists when the server has EARWITNESS_DEBUG_ATTRIBUTION on —
  // otherwise the route 404s, so showing the tab would be a dead end.
  const configQuery = useQuery({ queryKey: ['config'], queryFn: getConfig });
  const debugEnabled = configQuery.data?.debugAttribution ?? false;
  const start = useMutation({ mutationFn: startScan, onSuccess: setScanId });
  const cancel = useMutation({ mutationFn: cancelScan });

  // Poll the LIGHT progress endpoint every second…
  const progress = useQuery({
    queryKey: ['scan', scanId],
    queryFn: () => getScan(scanId as string),
    enabled: scanId !== null,
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.status) ? false : 1000),
  });

  // …and pull the HEAVY results only when progress advances or the scan ends,
  // instead of re-downloading every book list once a second.
  const results = useQuery({
    queryKey: ['results', scanId],
    queryFn: () => getResults(scanId as string),
    enabled: scanId !== null,
  });

  const processed = progress.data?.processed ?? 0;
  const status = progress.data?.status;
  const { refetch: refetchResults } = results;
  useEffect(() => {
    if (scanId) void refetchResults();
  }, [scanId, processed, status, refetchResults]);

  const data = progress.data;
  const pct = data && data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;
  const active = data ? !TERMINAL.has(data.status) : false;

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Earwitness</h1>
            <p className="text-sm text-neutral-500">Identify audiobooks by listening to the intro.</p>
          </div>
          {view === 'scan' && scanId && (
            <button
              className="text-sm text-neutral-400 hover:text-neutral-200"
              onClick={() => {
                setScanId(null);
                cancel.reset();
              }}
            >
              ← new scan
            </button>
          )}
        </header>

        {debugEnabled && (
          <nav className="flex gap-2 border-b border-neutral-800 pb-2 text-sm">
            {(['scan', 'debug'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-3 py-1 ${view === v ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'}`}
              >
                {v === 'scan' ? 'Scan' : 'Debug'}
              </button>
            ))}
          </nav>
        )}

        <ReadinessBanner />

        {view === 'debug' && debugEnabled && <DebugConsole />}

        {view === 'scan' && start.error && <p className="text-sm text-rose-400">{String(start.error)}</p>}

        {view === 'scan' && !scanId && <FolderPicker busy={start.isPending} onScan={(root) => start.mutate(root)} />}

        {view === 'scan' && scanId && data && (
          <section className="space-y-4">
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-neutral-300">{STATUS_LABEL[data.status] ?? data.status}</span>
                <div className="flex items-center gap-3">
                  <span className="text-neutral-500">
                    {data.processed}/{data.total || '…'}
                  </span>
                  {active && (
                    <button
                      className="rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 enabled:hover:bg-neutral-800 disabled:opacity-40"
                      disabled={cancel.isPending}
                      onClick={() => scanId && cancel.mutate(scanId)}
                    >
                      {cancel.isPending ? 'Cancelling…' : 'Cancel'}
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800">
                <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              {data.currentBooks.length > 0 && active && (
                <p className="mt-2 truncate text-xs text-neutral-500">scanning: {data.currentBooks.join(', ')}</p>
              )}
              {data.error && <p className="mt-2 text-sm text-rose-400">{data.error}</p>}
            </div>

            {results.data && results.data.results.length > 0 && <ResultsTable results={results.data.results} />}
          </section>
        )}

        {view === 'scan' && scanId && !data && <p className="text-sm text-neutral-500">Starting scan…</p>}
      </div>
    </main>
  );
}
