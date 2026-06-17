import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOverlay, saveOverlay, applyOverlay, mergeOverlay } from './runtime-config.js';
import type { AppConfig } from './config.js';

// Runtime-config overlay: env = defaults, config.json = overlay applied IN PLACE. These
// guard the three invariants the Settings page relies on: only allow-listed fields apply,
// the mutation is in place (so ProcessDeps' shared references see it), and garbage/unknown
// keys are ignored rather than trusted.

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ew-cfg-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function fakeConfig(): AppConfig {
  return {
    ollama: { host: 'env-host', model: 'env-model' },
    whisper: { host: 'env-whost', backend: 'openai-compat', model: 'env-wmodel' },
  } as unknown as AppConfig;
}

describe('loadOverlay', () => {
  it('returns {} when the file is missing', async () => {
    expect(await loadOverlay(path.join(dir, 'nope.json'))).toEqual({});
  });

  it('returns {} for invalid JSON', async () => {
    const f = path.join(dir, 'bad.json');
    await fs.writeFile(f, '{ not json');
    expect(await loadOverlay(f)).toEqual({});
  });

  it('rejects unknown keys (strict) → {}', async () => {
    const f = path.join(dir, 'evil.json');
    await fs.writeFile(f, JSON.stringify({ ollama: { model: 'm' }, libraryRoot: '/etc' }));
    expect(await loadOverlay(f)).toEqual({}); // libraryRoot is not overlay-editable
  });

  it('round-trips a valid overlay through saveOverlay', async () => {
    const f = path.join(dir, 'ok.json');
    const overlay = { ollama: { model: 'qwen' }, whisper: { backend: 'transformersjs' as const, model: 'base.en' } };
    await saveOverlay(f, overlay);
    expect(await loadOverlay(f)).toEqual(overlay);
  });
});

describe('applyOverlay', () => {
  it('mutates config sub-objects IN PLACE (same references) and only allow-listed fields', () => {
    const config = fakeConfig();
    const ollamaRef = config.ollama;
    const whisperRef = config.whisper;
    applyOverlay(config, { ollama: { model: 'new-model' } });
    expect(config.ollama).toBe(ollamaRef); // not reassigned — ProcessDeps' reference still valid
    expect(config.whisper).toBe(whisperRef);
    expect(config.ollama.model).toBe('new-model');
    expect(config.ollama.host).toBe('env-host'); // untouched field keeps the env default
  });

  it('applies a whisper backend/host/model change', () => {
    const config = fakeConfig();
    applyOverlay(config, { whisper: { backend: 'whispercpp', host: 'http://w:9000', model: 'large-v3' } });
    expect(config.whisper).toEqual({ host: 'http://w:9000', backend: 'whispercpp', model: 'large-v3' });
  });

  it('ignores an empty overlay', () => {
    const config = fakeConfig();
    applyOverlay(config, {});
    expect(config.ollama).toEqual({ host: 'env-host', model: 'env-model' });
  });
});

describe('mergeOverlay', () => {
  it('shallow-merges sub-objects so a partial save keeps the other override', () => {
    const merged = mergeOverlay({ ollama: { host: 'a', model: 'b' } }, { whisper: { model: 'c' } });
    expect(merged).toEqual({ ollama: { host: 'a', model: 'b' }, whisper: { model: 'c' } });
  });

  it('patch fields win over base', () => {
    const merged = mergeOverlay({ ollama: { model: 'old' } }, { ollama: { model: 'new' } });
    expect(merged.ollama?.model).toBe('new');
  });
});
