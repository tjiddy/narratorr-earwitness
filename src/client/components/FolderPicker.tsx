import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browse } from '../api';

export function FolderPicker({ onScan, busy }: { onScan: (root: string) => void; busy: boolean }) {
  const [path, setPath] = useState<string | undefined>(undefined);
  const { data, isLoading, error } = useQuery({
    queryKey: ['browse', path ?? '__root__'],
    queryFn: () => browse(path),
  });

  const atVirtualRoot = !data || data.cwd === '';

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="min-w-0 truncate font-mono text-sm text-neutral-400">
          {data?.cwd || 'select a root folder'}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 enabled:hover:bg-neutral-800 disabled:opacity-40"
            disabled={atVirtualRoot}
            onClick={() => setPath(data?.parent ?? undefined)}
          >
            ↑ Up
          </button>
          <button
            className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white enabled:hover:bg-indigo-400 disabled:opacity-40"
            disabled={atVirtualRoot || busy}
            onClick={() => data && onScan(data.cwd)}
          >
            {busy ? 'Starting…' : 'Scan this folder'}
          </button>
        </div>
      </div>

      <div className="max-h-96 overflow-auto p-2">
        {isLoading && <p className="px-2 py-4 text-sm text-neutral-500">Loading…</p>}
        {error && <p className="px-2 py-4 text-sm text-rose-400">{String(error)}</p>}
        {data && data.entries.length === 0 && (
          <p className="px-2 py-4 text-sm text-neutral-500">
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
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
              e.isDir ? 'text-neutral-200 hover:bg-neutral-800' : 'cursor-default text-neutral-500'
            }`}
          >
            <span className="w-4 text-center">{e.isDir ? '📁' : '🎧'}</span>
            <span className="truncate">{e.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
