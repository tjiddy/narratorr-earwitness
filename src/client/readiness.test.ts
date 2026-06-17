import { describe, it, expect } from 'vitest';
import { depStatuses, allReady } from './readiness.js';
import type { ConfigResponse } from '@shared/schemas.js';

// readiness.ts is the pure logic the UI uses to gate scanning + render remediation. It's
// the one client module worth unit-testing (the rest is thin fetch glue / JSX).

function cfg(over: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    mode: 'standalone',
    browseRoots: [],
    introSeconds: 60,
    ollama: { host: null, model: 'qwen', reachable: true },
    whisper: { host: null, backend: 'openai-compat', model: 'large-v3-turbo', reachable: true },
    ffmpeg: { path: null, ok: true },
    debugAttribution: false,
    ...over,
  };
}

describe('readiness', () => {
  it('allReady is true only when every dependency is up', () => {
    expect(allReady(cfg())).toBe(true);
    expect(allReady(cfg({ ffmpeg: { path: null, ok: false } }))).toBe(false);
    expect(allReady(cfg({ ollama: { host: null, model: 'qwen', reachable: false } }))).toBe(false);
    expect(allReady(cfg({ whisper: { host: null, backend: 'openai-compat', model: 'm', reachable: false } }))).toBe(false);
  });

  it('returns one status per dependency and surfaces the ollama model in its remediation', () => {
    const st = depStatuses(cfg({ ollama: { host: null, model: 'gemma3', reachable: false } }));
    expect(st).toHaveLength(3);
    const ollama = st.find((d) => d.label.includes('gemma3'));
    expect(ollama?.ok).toBe(false);
    expect(ollama?.remediation).toMatch(/ollama pull gemma3/);
  });

  it('gives a transformersjs-specific remediation for the in-process backend', () => {
    const st = depStatuses(cfg({ whisper: { host: null, backend: 'transformersjs', model: 'base.en', reachable: false } }));
    const whisper = st.find((d) => d.label.includes('transformersjs'));
    expect(whisper?.ok).toBe(false);
    expect(whisper?.remediation).toMatch(/in-process model failed/i);
  });
});
