// Messages between the fit worker pool (main thread) and its workers.
import type { RenderJob } from './engineHost.ts';

export type ToFitWorker =
  | { type: 'init'; wasm: ArrayBuffer | WebAssembly.Module | string; geometry: string }
  | { type: 'render'; id: number; job: RenderJob };

export type FromFitWorker =
  | { type: 'ready'; native: { analyze: boolean; reset: boolean; seed: boolean } }
  | { type: 'error'; id?: number; message: string }
  | { type: 'result'; id: number; features: Float32Array; audio?: Float32Array; ms: number };
