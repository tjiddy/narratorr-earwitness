import { spawn } from 'node:child_process';

// Cut the intro window with ffmpeg and hand back either 16k mono float32 (for the
// in-process transformers.js provider) or a 16k mono WAV buffer (to upload to an
// HTTP Whisper service). Leading silence is trimmed so a quiet gap doesn't eat the
// window; musical splashes are NOT trimmed (would need VAD) — a known MVP limitation.

export const SAMPLE_RATE = 16_000;

export interface CutOptions {
  ffmpegPath: string;
  offsetSeconds: number;
  seconds: number;
}

function buildArgs(track: string, opts: CutOptions, format: 's16le' | 'wav'): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(opts.offsetSeconds),
    '-t', String(opts.seconds),
    '-i', track,
    // Trim leading silence conservatively (does not touch speech-level audio).
    '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.3',
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    '-f', format,
    ...(format === 's16le' ? ['-acodec', 'pcm_s16le'] : []),
    'pipe:1',
  ];
}

function runFfmpeg(ffmpegPath: string, args: string[], track: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const tail = Buffer.concat(err).toString('utf8').trim().split('\n').slice(-4).join('\n');
        reject(new Error(`ffmpeg failed (${code}) on ${track}: ${tail}`));
        return;
      }
      resolve(Buffer.concat(out));
    });
  });
}

/** First `seconds` of `track` as float32 PCM @16kHz mono, normalized to [-1, 1]. */
export async function decodePcmF32(track: string, opts: CutOptions): Promise<Float32Array> {
  const buf = await runFfmpeg(opts.ffmpegPath, buildArgs(track, opts, 's16le'), track);
  if (buf.length === 0) throw new Error(`ffmpeg produced no audio for ${track}`);
  const i16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i]! / 32768;
  return f32;
}

/** First `seconds` of `track` as a 16kHz mono WAV buffer (for HTTP upload). */
export async function cutWav(track: string, opts: CutOptions): Promise<Buffer> {
  const buf = await runFfmpeg(opts.ffmpegPath, buildArgs(track, opts, 'wav'), track);
  if (buf.length === 0) throw new Error(`ffmpeg produced no audio for ${track}`);
  return buf;
}
