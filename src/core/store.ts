import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ScanResults } from '@shared/schemas.js';

// Incremental report writer. The scan job flushes after each book completes, so a
// crash mid-scan keeps everything done so far. Full-file rewrite per flush is fine
// at MVP scale (a few hundred books, small JSON); revisit if libraries get huge.
export class ReportStore {
  constructor(private readonly dir: string) {}

  private file(scanId: string): string {
    return path.join(this.dir, `${scanId}.json`);
  }

  // Write to a unique temp file then atomically rename over the target, so a crash
  // mid-write can't truncate the only durable copy of an in-progress scan. The temp
  // name is unique per write so concurrent flushes don't clobber each other's temp.
  async write(report: ScanResults): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const final = this.file(report.id);
    const tmp = `${final}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(report, null, 2));
      await fs.rename(tmp, final);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  // null = no report on disk yet (ENOENT). A real I/O error or corrupt JSON throws,
  // so the caller can tell "never written" apart from "broken" instead of masking both.
  async read(scanId: string): Promise<ScanResults | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(scanId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(raw) as ScanResults;
  }
}
