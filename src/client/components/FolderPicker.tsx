import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browse, getConfig } from '../api';
import { allReady } from '../readiness';
import { Button } from './Button';
import { FolderIcon, MusicIcon, ChevronUpIcon } from './icons';

export function FolderPicker({ onScan, busy }: { onScan: (root: string) => void; busy: boolean }) {
  const [path, setPath] = useState<string | undefined>(undefined);
  const { data, isLoading, error } = useQuery({
    queryKey: ['browse', path ?? '__root__'],
    queryFn: () => browse(path),
  });
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: getConfig, refetchInterval: 10_000 });

  const atVirtualRoot = !data || data.cwd === '';
  // Gate scanning while a dependency is down (optimistic until config loads).
  const ready = cfg ? allReady(cfg) : true;
  const scanDisabled = atVirtualRoot || busy || !ready;

  return (
    <div className="glass-card overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
        <div className="min-w-0 truncate font-mono text-sm text-muted-foreground">
          {data?.cwd || 'select a root folder'}
        </div>
        <div className="flex shrink-0 gap-2">
          {/* At a root boundary `parent` is null and Up returns to the root list
              (server returns parent:null, so it can't 403 by walking above a root). */}
          <Button variant="secondary" size="sm" icon={ChevronUpIcon} disabled={atVirtualRoot} onClick={() => setPath(data?.parent ?? undefined)}>
            Up
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={scanDisabled}
            title={!ready ? 'A required dependency is unavailable — see the readiness banner.' : undefined}
            onClick={() => data && onScan(data.cwd)}
          >
            {busy ? 'Starting…' : 'Scan this folder'}
          </Button>
        </div>
      </div>

      {!atVirtualRoot && !ready && (
        <p className="border-b border-border/50 px-4 py-2 text-xs text-amber-500">
          Scanning is disabled until ffmpeg, Ollama and Whisper are all reachable.
        </p>
      )}

      <div className="max-h-96 overflow-auto p-2">
        {isLoading && <p className="px-2 py-4 text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="px-2 py-4 text-sm text-destructive">{String(error)}</p>}
        {data && data.entries.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {atVirtualRoot
              ? 'No browse roots configured — set BROWSE_ROOTS in .env.'
              : 'No subfolders or audio files here.'}
          </p>
        )}
        {data?.entries.map((e) => (
          <button
            key={e.path}
            disabled={!e.isDir}
            onClick={() => e.isDir && setPath(e.path)}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
              e.isDir ? 'hover:bg-muted' : 'cursor-default text-muted-foreground'
            }`}
          >
            <span className="shrink-0 text-muted-foreground">
              {e.isDir ? <FolderIcon className="h-4 w-4" /> : <MusicIcon className="h-4 w-4" />}
            </span>
            <span className="truncate">{e.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
