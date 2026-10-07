// Main-thread side of the impedance worker: mirrors params/keys into the worker's engine instance,
// debounces recomputation of the bore impedance (keys / mouthpiece / temperature) and of the vocal
// tract impedance (tongue / jaw / glottis — snappy, ~100 ms, for live tongue drags).
import type { FromImpedanceWorker, ImpedanceKind, ToImpedanceWorker } from './impedance.worker';
import { P } from './params';

/** params that change the passive air column (bore impedance uses a rigid reed, no tract) */
const BORE_PARAMS = new Set<number>([P.tip_opening, P.facing_length, P.baffle_height, P.chamber_size, P.throat_diameter, P.mouthpiece_insertion, P.temperature, P.oversample]);
/** params that change the vocal tract as the engine models it (incl. the player model's offsets) */
const TRACT_PARAMS = new Set<number>([P.tongue_x, P.tongue_y, P.tongue_tip, P.jaw_open, P.glottis_open, P.player_assist, P.dynamic, P.oversample]);

export interface ImpedanceResult {
  kind: ImpedanceKind;
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
  private pending: Record<ImpedanceKind, boolean> = { bore: true, tract: true };
  private timers: Record<ImpedanceKind, number> = { bore: 0, tract: 0 };
  private id = 0;
  /** latest bore result (kept as `result` for compatibility) */
  result: ImpedanceResult | null = null;
  tract: ImpedanceResult | null = null;
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
    if (m.type === 'ready') { this.ready = true; this.kick(); }
    else if (m.type === 'error') { this.error = m.message; this.busy = false; this.kick(); }
    else if (m.type === 'result') {
      this.busy = false;
      const r: ImpedanceResult = { kind: m.kind, n: m.n, fmin: m.fmin, fmax: m.fmax, mag: m.mag, phase: m.phase, ms: m.ms, at: performance.now() };
      if (m.kind === 'bore') this.result = r; else this.tract = r;
      this.onResult?.(r);
      this.kick();
    }
  }

  /** mirror every param (the worker's engine must match); schedule what it affects */
  setParam(id: number, value: number): void {
    this.post({ type: 'param', id, value });
    if (BORE_PARAMS.has(id)) this.schedule('bore', 250);
    if (TRACT_PARAMS.has(id)) this.schedule('tract', 100);
  }

  setKeys(keys: Float32Array): void {

    for (let i = 0; i < keys.length; i++) this.post({ type: 'key', index: i, value: keys[i] });
    this.schedule('bore', 120);
    this.schedule('tract', 120); // the player model voices the tract per fingering
  }

  private schedule(kind: ImpedanceKind, delay: number): void {
    clearTimeout(this.timers[kind]);
    this.timers[kind] = window.setTimeout(() => { this.pending[kind] = true; this.kick(); }, delay);
  }

  private kick(): void {
    if (!this.ready || this.busy) return;
    // the tract curve is cheap (~20–50 ms) and drives live tongue feedback: it goes first
    const kind: ImpedanceKind | null = this.pending.tract ? 'tract' : this.pending.bore ? 'bore' : null;
    if (!kind) return;
    this.pending[kind] = false;
    this.busy = true;
    this.post({ type: 'compute', kind, id: ++this.id, n: this.n, fmin: this.fmin, fmax: this.fmax });
  }

  /** frequency of grid index i */
  freq(i: number): number {
    return this.fmin * Math.pow(this.fmax / this.fmin, i / (this.n - 1));
  }
}
