// Web Worker owning a second (non-audio) engine instance used only for the input-impedance plot.
// sax_compute_impedance is not real-time safe (~0.1–0.3 s), so it must never run in the worklet.

export type ToImpedanceWorker =
  | { type: 'init'; wasmUrl: string; geometry: string; params: number[]; keys: number[] }
  | { type: 'param'; id: number; value: number }
  | { type: 'key'; index: number; value: number }
  | { type: 'compute'; id: number; n: number; fmin: number; fmax: number };

export type FromImpedanceWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; n: number; fmin: number; fmax: number; mag: Float32Array; phase: Float32Array; ms: number };

interface Ex {
  memory: WebAssembly.Memory;
  sax_alloc(n: number): number;
  sax_free(p: number, n: number): void;
  sax_init(sr: number): number;
  sax_load_geometry(p: number, n: number): number;
  sax_set_param(id: number, v: number): void;
  sax_set_key(i: number, v: number): void;
  sax_compute_impedance?(n: number, fmin: number, fmax: number): number;
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<ToImpedanceWorker>) => void) | null; postMessage(m: FromImpedanceWorker, t?: Transferable[]): void };
let ex: Ex | null = null;
const pending: ToImpedanceWorker[] = [];

async function init(m: Extract<ToImpedanceWorker, { type: 'init' }>): Promise<void> {
  try {
    const res = await fetch(m.wasmUrl);
    if (!res.ok) throw new Error(`engine.wasm: HTTP ${res.status}`);
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
    const e = instance.exports as unknown as Ex;
    if (typeof e.sax_compute_impedance !== 'function') throw new Error('engine.wasm has no sax_compute_impedance (rebuild the engine)');
    e.sax_init(48000);
    const bytes = new TextEncoder().encode(m.geometry);
    const p = e.sax_alloc(bytes.length);
    new Uint8Array(e.memory.buffer, p, bytes.length).set(bytes);
    const rc = e.sax_load_geometry(p, bytes.length);
    e.sax_free(p, bytes.length);
    if (rc !== 0) throw new Error(`sax_load_geometry returned ${rc}`);
    m.params.forEach((v, i) => e.sax_set_param(i, v));
    m.keys.forEach((v, i) => e.sax_set_key(i, v));
    ex = e;
    ctx.postMessage({ type: 'ready' });
    for (const q of pending.splice(0)) handle(q);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function handle(m: ToImpedanceWorker): void {
  if (m.type === 'init') { void init(m); return; }
  if (!ex) { pending.push(m); return; }
  if (m.type === 'param') ex.sax_set_param(m.id, m.value);
  else if (m.type === 'key') ex.sax_set_key(m.index, m.value);
  else if (m.type === 'compute') {
    const t0 = performance.now();
    const ptr = ex.sax_compute_impedance!(m.n, m.fmin, m.fmax);
    const all = new Float32Array(ex.memory.buffer, ptr, 2 * m.n);
    const mag = all.slice(0, m.n), phase = all.slice(m.n);
    ctx.postMessage({ type: 'result', id: m.id, n: m.n, fmin: m.fmin, fmax: m.fmax, mag, phase, ms: performance.now() - t0 }, [mag.buffer, phase.buffer]);
  }
}

ctx.onmessage = (e) => handle(e.data);
