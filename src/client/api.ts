import type { BrowseResponse, ConfigResponse, ScanProgress, ScanResults } from '@shared/schemas.js';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export const getConfig = () => getJson<ConfigResponse>('/api/config');

export const browse = (path?: string) =>
  getJson<BrowseResponse>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);

export const getScan = (id: string) => getJson<ScanProgress>(`/api/scans/${id}`);

export const getResults = (id: string) => getJson<ScanResults>(`/api/scans/${id}/results`);

export async function startScan(root: string): Promise<string> {
  const res = await fetch('/api/scans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'local', root }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

export async function cancelScan(id: string): Promise<void> {
  await fetch(`/api/scans/${id}/cancel`, { method: 'POST' });
}
