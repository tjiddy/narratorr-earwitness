import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import type { ScanJobService } from '../services/scan-job.service.js';
import type { AttributionService } from '../services/attribution.service.js';

// GET /api/library-browse returns LIBRARY-RELATIVE (forward-slash) paths and is contained
// to config.libraryRoot via resolveWithinRoot — the same guard the attribution endpoint
// uses. Inject defaults to a loopback peer, so the /api gate passes without a key.

const fakeScans = () =>
  ({ start: () => 'x', progress: () => null, results: async () => null, cancel: () => false }) as unknown as ScanJobService;
const fakeAttribution = () => ({ attribute: async () => ({ detection: {} }) }) as unknown as AttributionService;
const fakeTranscribe = () => ({ name: 'fake', transcribe: async () => '', setProvider() {} });
const build = () => buildApp({ scans: fakeScans(), attribution: fakeAttribution(), transcribe: fakeTranscribe(), serveStatic: false });

let root: string;
let prevRoot: string;
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ew-lib-')));
  await fs.mkdir(path.join(root, 'Author', 'Book'), { recursive: true });
  await fs.writeFile(path.join(root, 'Author', 'Book', 'track1.m4b'), '');
  await fs.writeFile(path.join(root, 'loose.m4b'), '');
  await fs.writeFile(path.join(root, 'readme.txt'), ''); // non-audio → filtered out
  prevRoot = config.libraryRoot;
  config.libraryRoot = root;
});
afterAll(async () => {
  config.libraryRoot = prevRoot;
  await fs.rm(root, { recursive: true, force: true });
});

const get = (p?: string) => ({ method: 'GET' as const, url: `/api/library-browse${p ? `?path=${encodeURIComponent(p)}` : ''}` });

describe('GET /api/library-browse', () => {
  it('lists the library root (relative paths, cwd empty, no parent)', async () => {
    const app = await build();
    const res = await app.inject(get());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cwd).toBe('');
    expect(body.parent).toBeNull();
    expect(body.root).toBe(root);
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('Author');
    expect(names).toContain('loose.m4b');
    expect(names).not.toContain('readme.txt'); // non-audio filtered
    const author = body.entries.find((e: { name: string }) => e.name === 'Author');
    expect(author).toMatchObject({ path: 'Author', isDir: true });
    await app.close();
  });

  it('descends into a subdir with relative cwd + parent', async () => {
    const app = await build();
    const res = await app.inject(get('Author/Book'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cwd).toBe('Author/Book');
    expect(body.parent).toBe('Author');
    expect(body.entries.map((e: { path: string }) => e.path)).toContain('Author/Book/track1.m4b');
    await app.close();
  });

  it('a direct child has the root ("") as its parent', async () => {
    const app = await build();
    const res = await app.inject(get('Author'));
    expect(res.json().parent).toBe('');
    await app.close();
  });

  it('403s a traversal escape', async () => {
    const app = await build();
    expect((await app.inject(get('../..'))).statusCode).toBe(403);
    await app.close();
  });

  it('403s an absolute path', async () => {
    const app = await build();
    expect((await app.inject(get(root))).statusCode).toBe(403);
    await app.close();
  });

  it('404s a missing path', async () => {
    const app = await build();
    expect((await app.inject(get('Nope/Missing'))).statusCode).toBe(404);
    await app.close();
  });
});
