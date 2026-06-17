import type { Attribution, Comparison, Detection } from '@shared/schemas.js';

// Shared shape of the debug-console trace + result, imported by BOTH the server
// (core/trace.ts, server/services/attribution.service.ts) and the client
// (client/api.ts) so the two can never drift. The debug HTTP response is
// intentionally schema-free (free-form transcripts + internals), so these plain
// interfaces — not a Zod schema — are the single source of truth for its shape.
// (The type-only barrel import above is erased at runtime, so there's no cycle.)

export interface WindowTrace {
  label: 'head' | 'tail';
  track: string;
  offset: number;
  seconds: number;
  cache: 'hit' | 'miss' | 'bypass';
  chars: number;
  transcript: string; // FULL transcript for this window (not the 400-char excerpt)
  rawExtraction:
    | { title: string | null; author: string | null; narrator: string | null; confidence: number; attributionPresent: boolean }
    | null;
  evidence: { title: string | null; author: string | null; narrator: string | null } | null;
  nulledByGuard: string[];
  detected: Attribution;
  attributionPresent: boolean;
  confidence: number;
  ms: number;
}

export interface PipelineTrace {
  book: { name: string; source: string; introTrackPath: string; tracks: string[]; firstTrack: string; lastTrack: string } | null;
  windows: WindowTrace[];
  selection: { tailSampled: boolean; headScore: number; tailScore: number; winner: 'head' | 'tail' } | null;
}

export interface DebugRun {
  detection: Detection;
  comparison?: Comparison;
  trace: PipelineTrace;
  error: string | null;
  errorKind: 'unprocessable' | 'transient' | null;
  totalMs: number;
  compareMs?: number;
}

export interface DebugConfig {
  whisperBackend: string;
  whisperModel: string;
  ollamaModel: string;
  seconds: number;
  offsetSeconds: number;
  tailSampling: boolean;
  returnTimestamps: boolean;
  forceFresh: boolean;
  modelOverridden: boolean;
}

export interface DebugResult {
  config: DebugConfig;
  runs: DebugRun[];
}
