import { promises as fs } from 'node:fs';
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

  async write(report: ScanResults): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(report.id), JSON.stringify(report, null, 2));
  }

  async read(scanId: string): Promise<ScanResults | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(scanId), 'utf8')) as ScanResults;
    } catch {
      return null;
    }
  }
}
