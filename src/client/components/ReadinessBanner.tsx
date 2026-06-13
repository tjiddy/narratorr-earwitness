import { useQuery } from '@tanstack/react-query';
import { getConfig } from '../api';

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-500'}`} />;
}

export function ReadinessBanner() {
  const { data } = useQuery({ queryKey: ['config'], queryFn: getConfig, refetchInterval: 10_000 });
  if (!data) return null;

  const items = [
    { label: 'ffmpeg', ok: data.ffmpeg.ok },
    { label: `ollama · ${data.ollama.model}`, ok: data.ollama.reachable },
    { label: `whisper · ${data.whisper.backend}`, ok: data.whisper.reachable },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2 text-sm">
      <span className="font-medium text-neutral-400">mode: {data.mode}</span>
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-2 text-neutral-300">
          <Dot ok={i.ok} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
