import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Split file cache for the two expensive, deterministic steps. Transcript is keyed
// by audio identity + STT settings; extraction by transcript hash + LLM + prompt
// version. A re-scan of unchanged files skips ffmpeg+Whisper AND the LLM.

export function sha(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export interface FileIdentity {
  size: number;
  mtimeMs: number;
}

export async function fileIdentity(filePath: string): Promise<FileIdentity> {
  const st = await fs.stat(filePath);
  return { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

export function transcriptKey(p: {
  introTrackPath: string;
  identity: FileIdentity;
  offset: number;
  seconds: number;
  model: string;
  backend: string;
}): string {
  return sha(
    [p.introTrackPath, p.identity.size, p.identity.mtimeMs, p.offset, p.seconds, p.model, p.backend].join('|'),
  );
}

export function extractionKey(p: {
  transcriptHash: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
}): string {
  return sha([p.transcriptHash, p.model, p.promptVersion, p.schemaVersion].join('|'));
}

export class Cache {
  constructor(private readonly dir: string) {}

  private file(namespace: string, key: string): string {
    return path.join(this.dir, namespace, `${key}.json`);
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(namespace, key), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const f = this.file(namespace, key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify(value));
  }
}
