import type { PipelineTrace } from '@shared/schemas.js';

// The debug trace SHAPES live in @shared (schemas/debug.ts) so the client and server
// share one definition and can't drift. This module keeps the pipeline-facing factory
// and re-exports the types so core/server code can keep importing from '@core/trace.js'.
// The pipeline fills the trace ONLY when a collector is passed in (ProcessDeps.trace),
// exactly like the optional logger — never affects behavior; absent in the normal path.
export type { WindowTrace, PipelineTrace } from '@shared/schemas.js';

export function newPipelineTrace(): PipelineTrace {
  return { book: null, windows: [], selection: null };
}
