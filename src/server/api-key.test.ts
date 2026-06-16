import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureApiKey } from './api-key.js';

describe('ensureApiKey', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ew-key-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('generates and persists a key when the file is absent', async () => {
    const keyFile = path.join(dir, 'api-key');
    const r = await ensureApiKey(keyFile);
    expect(r.source).toBe('generated');
    expect(r.key).toMatch(/^[0-9a-f]{48}$/); // 24 random bytes, hex
    expect((await fs.readFile(keyFile, 'utf8')).trim()).toBe(r.key);
  });

  it('returns the SAME key on the next boot (reads the file, no rotation)', async () => {
    const keyFile = path.join(dir, 'api-key');
    const first = await ensureApiKey(keyFile);
    const second = await ensureApiKey(keyFile);
    expect(second.source).toBe('file');
    expect(second.key).toBe(first.key);
  });

  it('creates parent directories as needed', async () => {
    const keyFile = path.join(dir, 'nested', 'deeper', 'api-key');
    const r = await ensureApiKey(keyFile);
    expect(r.source).toBe('generated');
    expect((await fs.readFile(keyFile, 'utf8')).trim()).toBe(r.key);
  });

  it('honors a pre-existing bring-your-own key file (trimmed)', async () => {
    const keyFile = path.join(dir, 'api-key');
    await fs.writeFile(keyFile, '  my-own-secret  \n');
    const r = await ensureApiKey(keyFile);
    expect(r.source).toBe('file');
    expect(r.key).toBe('my-own-secret');
  });

  it('treats a blank key file as absent and regenerates', async () => {
    const keyFile = path.join(dir, 'api-key');
    await fs.writeFile(keyFile, '   \n');
    const r = await ensureApiKey(keyFile);
    expect(r.source).toBe('generated');
    expect(r.key).toMatch(/^[0-9a-f]{48}$/);
  });
});
