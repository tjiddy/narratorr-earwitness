import { useQuery } from '@tanstack/react-query';
import { getConfig } from '../api';
import { depStatuses } from '../readiness';

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-500'}`} />;
}

export function ReadinessBanner() {
  const { data } = useQuery({ queryKey: ['config'], queryFn: getConfig, refetchInterval: 10_000 });
  if (!data) return null;

  const deps = depStatuses(data);
  const failing = deps.filter((d) => !d.ok);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2 text-sm">
        <span className="font-medium text-neutral-400">mode: {data.mode}</span>
        {deps.map((d) => (
          <span key={d.label} className="flex items-center gap-2 text-neutral-300">
            <Dot ok={d.ok} />
            {d.label}
          </span>
        ))}
      </div>

      {failing.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-200/90">
          {failing.map((d) => (
            <li key={d.label}>
              <span className="font-medium">{d.label} unavailable —</span> {d.remediation}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
