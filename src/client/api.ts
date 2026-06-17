import type {
  BrowseResponse,
  ConfigResponse,
  DebugResult,
  DebugRun,
  ScanProgress,
  ScanResults,
  WindowTrace,
} from '@shared/schemas.js';

// Surface the server's { error } envelope (all routes use it, incl. the normalized
// 400/500 handler) instead of re-wrapping raw status text.
async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return body.error;
    }
  } catch {
    // body wasn't JSON — fall through to status text
  }
  return `${res.status} ${res.statusText}`.trim();
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const getConfig = () => request<ConfigResponse>('/api/config');

export const browse = (path?: string) =>
  request<BrowseResponse>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);

export const getScan = (id: string) => request<ScanProgress>(`/api/scans/${id}`);

export const getResults = (id: string) => request<ScanResults>(`/api/scans/${id}/results`);

export const startScan = (root: string) =>
  request<{ id: string }>('/api/scans', jsonPost({ source: 'local', root })).then((r) => r.id);

export const cancelScan = (id: string) =>
  request<{ cancelled: boolean }>(`/api/scans/${id}/cancel`, { method: 'POST' });

// --- debug console types (shared with the server via @shared/schemas/debug.ts, so
// the client and server can never drift). Re-exported under the client's local names. ---
export type DebugWindow = WindowTrace;
export type DebugRunResult = DebugRun;
export type { DebugResult };

export interface DebugRequest {
  path: string;
  expected?: { title?: string; authors?: string[]; narrators?: string[] };
  whisperModel?: string;
  ollamaModel?: string;
  returnTimestamps?: boolean;
  forceFresh?: boolean;
  runs?: number;
}

export const debugAttribution = (body: DebugRequest, apiKey: string) =>
  request<DebugResult>('/api/debug/attribution', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
