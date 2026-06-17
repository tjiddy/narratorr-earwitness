import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { libraryBrowse } from '../api';
import { Button } from './Button';
import { FolderIcon, MusicIcon, ChevronUpIcon } from './icons';

// Library-relative file browser for the debug console: click a folder to navigate, "Use"
// to drop its library-relative path into the attribution form. A book is usually a folder
// (all tracks under it resolve to one book), so both folders and audio files are pickable.
export function LibraryPicker({ onPick, onClose }: { onPick: (relPath: string) => void; onClose?: () => void }) {
  const [path, setPath] = useState<string | undefined>(undefined);
  const { data, isLoading, error } = useQuery({
    queryKey: ['library-browse', path ?? '__root__'],
    queryFn: () => libraryBrowse(path),
  });

  const atRoot = !data || data.cwd === '';

  return (
    <div className="glass-card overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm">{data?.cwd || '/ (library root)'}</div>
          {data?.root && <div className="truncate text-xs text-muted-foreground">relative to {data.root}</div>}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={ChevronUpIcon}
            disabled={atRoot || data?.parent === null}
            onClick={() => setPath(data?.parent || undefined)}
          >
            Up
          </Button>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>

      <div className="max-h-80 overflow-auto p-2">
        {isLoading && <p className="px-2 py-4 text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="px-2 py-4 text-sm text-destructive">{String(error)}</p>}
        {data && data.entries.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">No subfolders or audio files here.</p>
        )}
        {data?.entries.map((e) =>
          e.isDir ? (
            <div key={e.path} className="flex items-center gap-1">
              <button
                onClick={() => setPath(e.path)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
              >
                <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{e.name}</span>
              </button>
              <Button variant="ghost" size="sm" onClick={() => onPick(e.path)}>
                Use
              </Button>
            </div>
          ) : (
            <button
              key={e.path}
              onClick={() => onPick(e.path)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
            >
              <MusicIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{e.name}</span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}
