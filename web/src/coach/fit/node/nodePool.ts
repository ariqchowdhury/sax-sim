// WorkerPool on Node worker_threads (tests / benchmarks). Node ≥ 23 runs the .ts worker directly.
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { WorkerPool, type WorkerLike } from '../pool.ts';

export function nodePool(wasm: WebAssembly.Module, geometry: string, size = Math.max(1, Math.min(8, os.availableParallelism() - 1))): WorkerPool {
  const make = (): WorkerLike => {
    const w = new Worker(new URL('./nodeWorker.ts', import.meta.url));
    const like: WorkerLike = {
      postMessage: (m, t) => w.postMessage(m, (t ?? []) as never),
      onmessage: null,
      terminate: () => void w.terminate(),
    };
    w.on('message', (m) => like.onmessage?.(m));
    w.on('error', (e) => like.onmessage?.({ type: 'error', message: String(e) }));
    return like;
  };
  return new WorkerPool(make, wasm, geometry, size);
}
