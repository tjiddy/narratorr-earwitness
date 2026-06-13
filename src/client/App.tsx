import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ReadinessBanner } from './components/ReadinessBanner';
import { FolderPicker } from './components/FolderPicker';
import { ResultsTable } from './components/ResultsTable';
import { startScan, getResults } from './api';

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
  const [scanId, setScanId] = useState<string | null>(null);
  const start = useMutation({ mutationFn: startScan, onSuccess: setScanId });

  const scan = useQuery({
    queryKey: ['results', scanId],
    queryFn: () => getResults(scanId as string),
    enabled: scanId !== null,
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.status) ? false : 1000),
  });

  const data = scan.data;
  const pct = data && data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Earwitness</h1>
            <p className="text-sm text-neutral-500">Identify audiobooks by listening to the intro.</p>
          </div>
          {scanId && (
            <button className="text-sm text-neutral-400 hover:text-neutral-200" onClick={() => setScanId(null)}>
              ← new scan
            </button>
          )}
        </header>

        <ReadinessBanner />

        {start.error && <p className="text-sm text-rose-400">{String(start.error)}</p>}

        {!scanId && <FolderPicker busy={start.isPending} onScan={(root) => start.mutate(root)} />}

        {scanId && data && (
          <section className="space-y-4">
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-neutral-300">{STATUS_LABEL[data.status] ?? data.status}</span>
                <span className="text-neutral-500">
                  {data.processed}/{data.total || '…'}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800">
                <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              {data.currentBook && !TERMINAL.has(data.status) && (
                <p className="mt-2 truncate text-xs text-neutral-500">scanning: {data.currentBook}</p>
              )}
              {data.error && <p className="mt-2 text-sm text-rose-400">{data.error}</p>}
            </div>

            {data.results.length > 0 && <ResultsTable results={data.results} />}
          </section>
        )}

        {scanId && !data && <p className="text-sm text-neutral-500">Starting scan…</p>}
      </div>
    </main>
  );
}
