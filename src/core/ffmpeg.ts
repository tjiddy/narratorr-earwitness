import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Portable ffmpeg resolution — env override, else rely on PATH. Never hardcode a
// platform path (Narratorr hardcodes /usr/bin/ffmpeg, which only works in its container).
export async function resolveFfmpeg(configured: string | null): Promise<string> {
  const candidate = configured && configured.trim() ? configured : 'ffmpeg';
  await probeFfmpeg(candidate); // throws if not runnable
  return candidate;
}

export async function probeFfmpeg(ffmpegPath: string): Promise<string> {
  const { stdout } = await execFileAsync(ffmpegPath, ['-version']);
  const first = stdout.split('\n')[0] ?? '';
  return first.match(/ffmpeg version (\S+)/)?.[1] ?? first.trim();
}

export async function ffmpegOk(configured: string | null): Promise<{ path: string | null; ok: boolean }> {
  const candidate = configured && configured.trim() ? configured : 'ffmpeg';
  try {
    await probeFfmpeg(candidate);
    return { path: candidate, ok: true };
  } catch {
    return { path: configured, ok: false };
  }
}
