import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ReadinessBanner } from './components/ReadinessBanner';
import { FolderPicker } from './components/FolderPicker';
import { ResultsTable } from './components/ResultsTable';
import { DebugConsole } from './components/DebugConsole';
import { SettingsPage } from './components/SettingsPage';
import { Tabs } from './components/Tabs';
import { Button } from './components/Button';
import { HeadphonesIcon, SearchIcon, ActivityIcon, SettingsIcon, SunIcon, MoonIcon } from './components/icons';
import { useTheme } from './hooks/useTheme';
import { startScan, getScan, getResults, cancelScan } from './api';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const STATUS_LABEL: Record<string, string> = {
  pending: 'Starting…',
  discovering: 'Discovering books…',
  processing: 'Listening…',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

type View = 'scan' | 'debug' | 'settings';

export function App() {
  const { theme, toggleTheme } = useTheme();
  const [view, setView] = useState<View>('scan');
  const [scanId, setScanId] = useState<string | null>(null);
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

  const tabs = [
    { value: 'scan', label: 'Scan', icon: <SearchIcon className="w-4 h-4" /> },
    { value: 'debug', label: 'Debug', icon: <ActivityIcon className="w-4 h-4" /> },
    { value: 'settings', label: 'Settings', icon: <SettingsIcon className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen gradient-bg noise-overlay">
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:h-20">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 rounded-xl bg-primary/20 blur-xl" />
              <div className="relative rounded-xl bg-gradient-to-br from-primary to-amber-500 p-2.5">
                <HeadphonesIcon className="h-6 w-6 text-primary-foreground" />
              </div>
            </div>
            <div>
              <h1 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">Earwitness</h1>
              <p className="hidden text-sm text-muted-foreground sm:block">
                Identify audiobooks by listening to the intro.
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={theme === 'dark' ? SunIcon : MoonIcon}
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          />
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <div className="flex items-center justify-between gap-3">
          <Tabs tabs={tabs} value={view} onChange={(v) => setView(v as View)} ariaLabel="Sections" />
          {view === 'scan' && scanId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setScanId(null);
                cancel.reset();
              }}
            >
              ← new scan
            </Button>
          )}
        </div>

        {view !== 'settings' && <ReadinessBanner />}

        {view === 'debug' && <DebugConsole />}
        {view === 'settings' && <SettingsPage />}

        {view === 'scan' && (
          <>
            {start.error && <p className="text-sm text-destructive">{String(start.error)}</p>}

            {!scanId && <FolderPicker busy={start.isPending} onScan={(root) => start.mutate(root)} />}

            {scanId && data && (
              <section className="space-y-4">
                <div className="glass-card rounded-2xl p-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{STATUS_LABEL[data.status] ?? data.status}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground">
                        {data.processed}/{data.total || '…'}
                      </span>
                      {active && (
                        <Button variant="secondary" size="sm" disabled={cancel.isPending} onClick={() => scanId && cancel.mutate(scanId)}>
                          {cancel.isPending ? 'Cancelling…' : 'Cancel'}
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  {data.currentBooks.length > 0 && active && (
                    <p className="mt-2 truncate text-xs text-muted-foreground">scanning: {data.currentBooks.join(', ')}</p>
                  )}
                  {data.error && <p className="mt-2 text-sm text-destructive">{data.error}</p>}
                </div>

                {results.data && results.data.results.length > 0 && <ResultsTable results={results.data.results} />}
              </section>
            )}

            {scanId && !data && <p className="text-sm text-muted-foreground">Starting scan…</p>}
          </>
        )}
      </main>
    </div>
  );
}
