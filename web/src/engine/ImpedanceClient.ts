// Main-thread side of the impedance worker: mirrors params/keys, debounces recomputation.
import type { FromImpedanceWorker, ToImpedanceWorker } from './impedance.worker';

/** params that change the passive air column (impedance uses a rigid reed, no vocal tract) */
const ACOUSTIC_PARAMS = new Set([13, 14, 15, 16, 17, 18, 19, 21]);

export interface ImpedanceResult {
  n: number;
  fmin: number;
  fmax: number;
  mag: Float32Array;
  phase: Float32Array;
  ms: number;
  /** performance.now() when received */
  at: number;
}

export class ImpedanceClient {
  private worker: Worker | null = null;
  private ready = false;
  private busy = false;
  private dirty = true;
  private timer = 0;
  private id = 0;
  result: ImpedanceResult | null = null;
  error: string | null = null;
  onResult: ((r: ImpedanceResult) => void) | null = null;
  readonly n = 480;
  readonly fmin = 60;
  readonly fmax = 3000;

  constructor(wasmUrl: string, geometry: string, params: Float32Array, keys: Float32Array) {
    try {
      this.worker = new Worker(new URL('./impedance.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      this.error = String(err);
      return;
    }
    this.worker.onmessage = (e: MessageEvent<FromImpedanceWorker>) => this.onMessage(e.data);
    this.post({ type: 'init', wasmUrl: new URL(wasmUrl, location.href).href, geometry, params: Array.from(params), keys: Array.from(keys) });
  }

  private post(m: ToImpedanceWorker): void {
    this.worker?.postMessage(m);
  }

  private onMessage(m: FromImpedanceWorker): void {
    if (m.type === 'ready') { this.ready = true; this.schedule(0); }
    else if (m.type === 'error') { this.error = m.message; this.busy = false; }
    else if (m.type === 'result') {
      this.busy = false;
      this.result = { n: m.n, fmin: m.fmin, fmax: m.fmax, mag: m.mag, phase: m.phase, ms: m.ms, at: performance.now() };
      this.onResult?.(this.result);
      if (this.dirty) this.schedule(60);
    }
  }

  setParam(id: number, value: number): void {
    if (!ACOUSTIC_PARAMS.has(id)) return;
    this.post({ type: 'param', id, value });
    this.schedule(250);
  }

  setKeys(keys: Float32Array): void {
    for (let i = 0; i < keys.length; i++) this.post({ type: 'key', index: i, value: keys[i] });
    this.schedule(120);
  }

  private schedule(delay: number): void {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.kick(), delay);
  }

  private kick(): void {
    if (!this.ready || this.busy || !this.dirty) return;
    this.dirty = false;
    this.busy = true;
    this.post({ type: 'compute', id: ++this.id, n: this.n, fmin: this.fmin, fmax: this.fmax });
  }

  /** frequency of grid index i */
  freq(i: number): number {
    return this.fmin * Math.pow(this.fmax / this.fmin, i / (this.n - 1));
  }
}
