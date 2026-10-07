// Parallel evaluation of render jobs: a pool of workers, each owning one engine instance.
import { EngineHost, type RenderJob, type RenderResult } from './engineHost.ts';
import type { FromFitWorker, ToFitWorker } from './protocol.ts';

export interface Evaluator {
  readonly size: number;
  /** engine capabilities (native sax_analyze / reset / seed) once ready */
  readonly native: Promise<{ analyze: boolean; reset: boolean; seed: boolean }>;
  run(jobs: readonly RenderJob[]): Promise<RenderResult[]>;
  close(): void;
}

/** Minimal worker interface (browser Worker or a Node worker_threads adapter). */
export interface WorkerLike {
  postMessage(m: ToFitWorker, transfer?: Transferable[]): void;
  onmessage: ((m: FromFitWorker) => void) | null;
  terminate(): void;
}

/** Default pool size: hardwareConcurrency − 1 (audio/UI keep one core), capped. */
export function defaultPoolSize(cap = 8): number {
  const hc = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(cap, hc - 1));
}

interface Pending {
  job: RenderJob;
  resolve: (r: RenderResult) => void;
  reject: (e: Error) => void;
}

export class WorkerPool implements Evaluator {
  readonly size: number;
  readonly native: Promise<{ analyze: boolean; reset: boolean; seed: boolean }>;
  private workers: WorkerLike[] = [];
  private idle: WorkerLike[] = [];
  private queue: Pending[] = [];
  private inflight = new Map<number, Pending>();
  private byWorker = new Map<WorkerLike, number>();
  private nextId = 1;
  private failed: Error | null = null;

  /**
   * @param make   creates one worker
   * @param wasm   engine module, bytes or URL of engine.wasm (relaxed build picked automatically)
   */
  constructor(make: () => WorkerLike, wasm: WebAssembly.Module | ArrayBuffer | string, geometry: string, size = defaultPoolSize()) {
    this.size = size;
    const readies: Promise<{ analyze: boolean; reset: boolean; seed: boolean }>[] = [];
    for (let i = 0; i < size; i++) {
      const w = make();
      this.workers.push(w);
      readies.push(
        new Promise((resolve, reject) => {
          w.onmessage = (m) => {
            if (m.type === 'ready') {
              resolve(m.native);
              this.idle.push(w);
              this.pump();
            } else if (m.type === 'error' && m.id === undefined) {
              reject(new Error(m.message));
              this.fail(new Error(m.message));
            } else this.onResult(w, m);
          };
        }),
      );
      // a Module can be shared (structured-clonable); bytes are copied per worker
      w.postMessage({ type: 'init', wasm: wasm instanceof ArrayBuffer ? wasm.slice(0) : wasm, geometry });
    }
    this.native = Promise.all(readies).then((n) => n[0]);
  }

  run(jobs: readonly RenderJob[]): Promise<RenderResult[]> {
    if (this.failed) return Promise.reject(this.failed);
    const ps = jobs.map((job) => new Promise<RenderResult>((resolve, reject) => this.queue.push({ job, resolve, reject })));
    this.pump();
    return Promise.all(ps);
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const p = this.queue.shift()!;
      const id = this.nextId++;
      this.inflight.set(id, p);
      this.byWorker.set(w, id);
      w.postMessage({ type: 'render', id, job: p.job });
    }
  }

  private onResult(w: WorkerLike, m: FromFitWorker): void {
    if (m.type !== 'result' && m.type !== 'error') return;
    const id = m.id!;
    const p = this.inflight.get(id);
    this.inflight.delete(id);
    this.byWorker.delete(w);
    this.idle.push(w);
    if (p) {
      if (m.type === 'result') p.resolve({ features: m.features, audio: m.audio, ms: m.ms });
      else p.reject(new Error(m.message));
    }
    this.pump();
  }

  private fail(e: Error): void {
    this.failed = e;
    for (const p of this.queue.splice(0)) p.reject(e);
    for (const p of this.inflight.values()) p.reject(e);
    this.inflight.clear();
  }

  close(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.fail(new Error('pool closed'));
  }
}

/** Browser pool of module Web Workers. */
export function browserPool(wasmUrl: string, geometry: string, size = defaultPoolSize()): WorkerPool {
  const make = (): WorkerLike => {
    const w = new Worker(new URL('./fit.worker.ts', import.meta.url), { type: 'module' });
    const like: WorkerLike = {
      postMessage: (m, t) => w.postMessage(m, t ?? []),
      onmessage: null,
      terminate: () => w.terminate(),
    };
    w.onmessage = (e: MessageEvent<FromFitWorker>) => like.onmessage?.(e.data);
    return like;
  };
  return new WorkerPool(make, new URL(wasmUrl, location.href).href, geometry, size);
}

/** Single-threaded evaluator on the calling thread (fallback / debugging). */
export class InlineEvaluator implements Evaluator {
  readonly size = 1;
  readonly native: Promise<{ analyze: boolean; reset: boolean; seed: boolean }>;
  private host: EngineHost;
  constructor(module: WebAssembly.Module, geometry: string) {
    this.host = new EngineHost(module, geometry);
    this.native = Promise.resolve(this.host.native);
  }
  async run(jobs: readonly RenderJob[]): Promise<RenderResult[]> {
    return jobs.map((j) => this.host.render(j));
  }
  close(): void {}
}
