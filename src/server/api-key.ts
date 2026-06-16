import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeApiKey } from './config.js';

// earwitness OWNS its API key — it is never "provided" to us via env. On boot we read
// the key from a persisted file; if the file is absent (or blank) we mint a new one
// and write it. Bring-your-own = write that file yourself (or mount it as a Docker
// secret). The file lives outside the cache dir so clearing the cache can't rotate
// the key out from under narratorr.

export interface ResolvedApiKey {
  key: string;
  source: 'file' | 'generated';
  path: string;
}

export async function ensureApiKey(keyFile: string): Promise<ResolvedApiKey> {
  const existing = await readKey(keyFile);
  if (existing) return { key: existing, source: 'file', path: keyFile };

  const key = crypto.randomBytes(24).toString('hex');
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  // 0600 on creation; chmod is best-effort to tighten a pre-existing loose file
  // (both are effectively no-ops on win32, which is fine for dev).
  await fs.writeFile(keyFile, `${key}\n`, { mode: 0o600 });
  await fs.chmod(keyFile, 0o600).catch(() => {});
  return { key, source: 'generated', path: keyFile };
}

async function readKey(keyFile: string): Promise<string | null> {
  try {
    return normalizeApiKey(await fs.readFile(keyFile, 'utf8'));
  } catch {
    return null; // ENOENT (no key yet) or unreadable → treat as absent
  }
}
