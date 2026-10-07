// AudioWorkletProcessor hosting the Rust/WASM saxophone engine.
// Runs in AudioWorkletGlobalScope: no fetch, no DOM, (often) no TextEncoder.
// Bundled separately by Vite via `?worker&url` (see EngineClient.ts).

import { SHM } from './shm';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: unknown): void;
declare const sampleRate: number;

interface SaxExports {
  memory: WebAssembly.Memory;
  sax_alloc(bytes: number): number;
  sax_free(ptr: number, bytes: number): void;
  sax_init(sampleRate: number): number;
  sax_load_geometry(ptr: number, len: number): number;
  sax_set_param(id: number, value: number): void;
  sax_set_key(index: number, pressed: number): void;
  sax_process(n: number): number;
  sax_telemetry_ptr(): number;
  sax_telemetry_len(): number;
  sax_pad_openness_ptr(): number;
}

export type ToWorklet =
  | { type: 'param'; id: number; value: number }
  | { type: 'key'; index: number; value: number }
  | { type: 'geometry'; json: string | Uint8Array; padCount: number };

export type FromWorklet =
  | { type: 'ready'; exports: string[] }
  | { type: 'error'; message: string }
  | { type: 'telemetry'; data: Float32Array; pads: Float32Array; frame: number }
  | PerfReport;

/**
 * CPU load of the audio thread, posted about twice a second.
 * load = time spent in process() / real time of the audio rendered (1.0 = no headroom: dropouts).
 * level: 'ok' | 'high' (≥ HIGH for ≥ 1 s → suggest a lower oversampling) |
 *        'overload' (≥ OVERLOAD for ≥ 3 s → audio is glitching persistently; the app may drop
 *        oversampling to `recommendOs` without asking).
 */
export interface PerfReport {
  type: 'perf';
  load: number;
  level: 'ok' | 'high' | 'overload';
  os: number;
  recommendOs: number;
  timer: 'performance' | 'date';
}

export interface WorkletOptions {
  wasmBytes: ArrayBuffer;
  /** present when crossOriginIsolated: seqlock-protected telemetry (no postMessage telemetry then) */
  shared: SharedArrayBuffer | null;
  geometry: Uint8Array | null;
  padCount: number;
  params: number[];
  keys: number[];
}

const REQUIRED = [
  'memory', 'sax_alloc', 'sax_init', 'sax_load_geometry', 'sax_set_param', 'sax_set_key',
  'sax_process', 'sax_telemetry_ptr', 'sax_telemetry_len', 'sax_pad_openness_ptr',
];

function utf8Encode(s: string): Uint8Array {
  const TE = (globalThis as { TextEncoder?: typeof TextEncoder }).TextEncoder;
  if (TE) return new TE().encode(s);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.codePointAt(i)!;
    if (c > 0xffff) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

/** Stub any imports the module declares (raw C-ABI builds normally have none). */
function makeImports(mod: WebAssembly.Module): WebAssembly.Imports {
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    const ns = (imports[imp.module] ??= {});
    if (imp.kind === 'function') ns[imp.name] = () => 0;
    else if (imp.kind === 'memory') ns[imp.name] = new WebAssembly.Memory({ initial: 32, maximum: 16384 });
  }
  return imports;
}

class SaxProcessor extends AudioWorkletProcessor {
  private ex: SaxExports | null = null;
  private dead = false;
  private queue: ToWorklet[] = [];
  private padCount: number;
  private telemetryEvery: number;
  private blockCounter = 0;
  private frame = 0;
  private memBuf: ArrayBuffer | null = null;
  private heap: Float32Array = new Float32Array(0);
  private shHead: Int32Array | null = null;
  private shTel: Float32Array | null = null;
  private shPads: Float32Array | null = null;
  // ---- CPU-load monitor (AudioWorkletGlobalScope may lack `performance`; Date.now() has 1 ms
  // resolution, but summing per-block differences is unbiased: each difference rounds to 0 or
  // 1 ms with probability proportional to the true duration)
  private now: () => number;
  private timer: 'performance' | 'date';
  private busyMs = 0;
  private perfBlocks = 0;
  private perfWindow: number;
  private highRun = 0;
  private overRun = 0;
  private os = 4;

  constructor(options: { processorOptions: WorkletOptions }) {
    super();
    const o = options.processorOptions;
    this.padCount = o.padCount;
    this.telemetryEvery = Math.max(1, Math.round((sampleRate * 0.0166) / 128));
    if (o.shared) {
      this.shHead = new Int32Array(o.shared, 0, SHM.HEADER);
      this.shTel = new Float32Array(o.shared, SHM.HEADER * 4, SHM.TEL_CAP);
      this.shPads = new Float32Array(o.shared, SHM.HEADER * 4 + SHM.TEL_CAP * 4, SHM.PAD_CAP);
      this.telemetryEvery = 2; // cheap: just a memcpy into shared memory
    }
    const perf = (globalThis as { performance?: { now(): number } }).performance;
    if (perf && typeof perf.now === 'function') {
      this.now = () => perf.now();
      this.timer = 'performance';
    } else {
      this.now = () => Date.now();
      this.timer = 'date';
    }
    this.perfWindow = Math.max(1, Math.round((sampleRate * 0.5) / 128));
    if (o.params.length > 21) this.os = Math.round(o.params[21]);
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      this.queue.push(e.data);
    };
    try {
      const mod = new WebAssembly.Module(o.wasmBytes);
      const inst = new WebAssembly.Instance(mod, makeImports(mod));
      const ex = inst.exports as unknown as SaxExports;
      const missing = REQUIRED.filter((n) => !(n in inst.exports));
      if (missing.length) throw new Error(`engine.wasm missing exports: ${missing.join(', ')}`);
      const rc = ex.sax_init(sampleRate);
      if (rc !== 0) throw new Error(`sax_init returned ${rc}`);
      this.ex = ex;
      if (o.geometry) this.loadGeometry(o.geometry);
      o.params.forEach((v, id) => ex.sax_set_param(id, v));
      o.keys.forEach((v, i) => ex.sax_set_key(i, v));
      this.port.postMessage({ type: 'ready', exports: Object.keys(inst.exports) } satisfies FromWorklet);
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.dead = true;
    this.ex = null;
    this.port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies FromWorklet);
  }

  private loadGeometry(json: string | Uint8Array): void {
    const ex = this.ex!;
    const bytes = typeof json === 'string' ? utf8Encode(json) : json;
    const ptr = ex.sax_alloc(bytes.length);
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    const rc = ex.sax_load_geometry(ptr, bytes.length);
    if (typeof ex.sax_free === 'function') ex.sax_free(ptr, bytes.length);
    if (rc !== 0) this.port.postMessage({ type: 'error', message: `sax_load_geometry returned ${rc}` } satisfies FromWorklet);
  }

  private f32(): Float32Array {
    const buf = this.ex!.memory.buffer;
    if (buf !== this.memBuf) {
      this.memBuf = buf;
      this.heap = new Float32Array(buf);
    }
    return this.heap;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const ex = this.ex;
    if (!ex || this.dead) {
      return !this.dead;
    }
    const t0 = this.now();
    try {
      // drain control messages
      for (let i = 0; i < this.queue.length; i++) {
        const m = this.queue[i];
        if (m.type === 'param') {
          ex.sax_set_param(m.id, m.value);
          if (m.id === 21) this.os = Math.round(m.value);
        }
        else if (m.type === 'key') ex.sax_set_key(m.index, m.value);
        else if (m.type === 'geometry') {
          this.padCount = m.padCount;
          this.loadGeometry(m.json);
        }
      }
      this.queue.length = 0;

      const n = out && out[0] ? out[0].length : 128;
      const ptr = ex.sax_process(n);
      const heap = this.f32();
      if (out && out.length) {
        const base = ptr >>> 2;
        out[0].set(heap.subarray(base, base + n));
        for (let c = 1; c < out.length; c++) out[c].set(out[0]);
      }
      this.frame += n;

      if (++this.blockCounter >= this.telemetryEvery) {
        this.blockCounter = 0;
        const tp = ex.sax_telemetry_ptr() >>> 2;
        const tl = ex.sax_telemetry_len();
        const pp = ex.sax_pad_openness_ptr() >>> 2;
        const head = this.shHead;
        if (head && this.shTel && this.shPads) {
          // seqlock write: odd = writing
          const tlc = Math.min(tl, SHM.TEL_CAP), pc = Math.min(this.padCount, SHM.PAD_CAP);
          const seq = Atomics.add(head, SHM.SEQ, 1) + 1;
          this.shTel.set(heap.subarray(tp, tp + tlc));
          this.shPads.set(heap.subarray(pp, pp + pc));
          head[SHM.TEL_LEN] = tlc;
          head[SHM.PAD_COUNT] = pc;
          head[SHM.FRAME] = this.frame | 0;
          Atomics.store(head, SHM.SEQ, seq + 1);
        } else {
          const data = heap.slice(tp, tp + tl);
          const pads = heap.slice(pp, pp + this.padCount);
          this.port.postMessage({ type: 'telemetry', data, pads, frame: this.frame } satisfies FromWorklet, [data.buffer, pads.buffer]);
        }
      }
      this.monitor(this.now() - t0, n);
    } catch (err) {
      this.fail(err);
      return false;
    }
    return true;
  }

  /** Accumulate the block's CPU time; every ~0.5 s report the load and a quality hint. */
  private monitor(ms: number, n: number): void {
    this.busyMs += ms;
    if (++this.perfBlocks < this.perfWindow) return;
    const load = this.busyMs / ((this.perfBlocks * n * 1000) / sampleRate);
    this.busyMs = 0;
    this.perfBlocks = 0;
    // thresholds: 'high' at 60 % for 1 s (2 windows), 'overload' at 95 % for 3 s (6 windows)
    this.highRun = load >= 0.6 ? this.highRun + 1 : 0;
    this.overRun = load >= 0.95 ? this.overRun + 1 : 0;
    const level: PerfReport['level'] = this.overRun >= 6 ? 'overload' : this.highRun >= 2 ? 'high' : 'ok';
    if (level === 'overload') this.overRun = 0; // one recommendation per 3 s of overload
    const recommendOs = this.os > 1 ? Math.max(1, Math.floor(this.os / 2)) : 1;
    this.port.postMessage({ type: 'perf', load, level, os: this.os, recommendOs, timer: this.timer } satisfies FromWorklet);
  }
}

registerProcessor('sax-engine', SaxProcessor);

/** Tap that forwards its (mono) input to the main thread while recording (WAV export). */
class RecorderProcessor extends AudioWorkletProcessor {
  private recording = false;
  private chunk = new Float32Array(16384);
  private fill = 0;
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ type: 'start' | 'stop' }>) => {
      if (e.data.type === 'start') { this.recording = true; this.fill = 0; }
      else { this.flush(true); this.recording = false; }
    };
  }
  private flush(final: boolean): void {
    if (this.fill > 0 || final) {
      const out = this.chunk.slice(0, this.fill);
      this.port.postMessage({ type: final ? 'end' : 'data', data: out }, [out.buffer]);
      this.fill = 0;
    }
  }
  process(inputs: Float32Array[][]): boolean {
    if (!this.recording) return true;
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.chunk[this.fill++] = ch[i];
      if (this.fill === this.chunk.length) this.flush(false);
    }
    return true;
  }
}
registerProcessor('sax-recorder', RecorderProcessor);
