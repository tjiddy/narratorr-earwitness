import { promises as fs } from 'node:fs';
import path from 'node:path';

// Browse/scan containment: resolve symlinks with realpath and compare case-folded
// on Windows. String-prefix checks alone are exploitable (.. and symlink escapes);
// realpath collapses both before the boundary test.

function caseFold(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

export function isWithin(child: string, root: string): boolean {
  const c = caseFold(child);
  const r = caseFold(root);
  if (c === r) return true;
  const rWithSep = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(rWithSep);
}

/** Real, canonical roots (symlinks resolved); unreadable ones dropped. */
export async function realRoots(roots: string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map(realOrNull));
  return resolved.filter((r): r is string => r !== null);
}

/** Resolve `requested` and confirm it sits inside one of `roots`. Null = rejected. */
export async function resolveWithinRoots(requested: string, roots: string[]): Promise<string | null> {
  const real = await realOrNull(path.resolve(requested));
  if (!real) return null;
  const rroots = await realRoots(roots);
  return rroots.some((r) => isWithin(real, r)) ? real : null;
}

export function isRoot(real: string, rroots: string[]): boolean {
  const c = caseFold(real);
  return rroots.some((r) => caseFold(r) === c);
}
