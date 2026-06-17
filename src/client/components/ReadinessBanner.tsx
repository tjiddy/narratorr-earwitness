import { useQuery } from '@tanstack/react-query';
import { getConfig } from '../api';
import { depStatuses } from '../readiness';

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-success' : 'bg-destructive'}`} />;
}

export function ReadinessBanner() {
  const { data } = useQuery({ queryKey: ['config'], queryFn: getConfig, refetchInterval: 10_000 });
  if (!data) return null;

  const deps = depStatuses(data);
  const failing = deps.filter((d) => !d.ok);

  return (
    <div className="space-y-2">
      <div className="glass-card flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-4 py-2 text-sm">
        <span className="font-medium text-muted-foreground">mode: {data.mode}</span>
        {deps.map((d) => (
          <span key={d.label} className="flex items-center gap-2">
            <Dot ok={d.ok} />
            {d.label}
          </span>
        ))}
      </div>

      {failing.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-500">
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
