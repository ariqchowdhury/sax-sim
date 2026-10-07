// Coach worker: one offline engine instance (the fitter's EngineHost, so recordings and simulated
// notes go through the same renderer and the same feature extractor — `sax_analyze` when the engine
// has it, else the shared TS stand-in) plus note segmentation (`sax_segment` when available).
import { EngineHost, type RenderJob } from './fit/engineHost';
import { segmentJS } from './segment';

export type ToCoachWorker =
  | { type: 'init'; wasmUrl: string; geometry: string }
  | { type: 'analyze'; id: number; audio: Float32Array; sr: number; target: number }
  | { type: 'segment'; id: number; audio: Float32Array; sr: number }
  | { type: 'render'; id: number; job: RenderJob }
  | { type: 'room'; id: number; audio: Float32Array; sr: number };

export type FromCoachWorker =
  | { type: 'ready'; caps: { analyze: boolean; segment: boolean; room: boolean; resetState: boolean; seed: boolean } }
  | { type: 'error'; id?: number; message: string }
  | { type: 'features'; id: number; features: Float32Array; source: 'wasm' | 'fallback' }
  | { type: 'segments'; id: number; segments: [number, number][]; source: 'wasm' | 'fallback' }
  | { type: 'rendered'; id: number; features: Float32Array; audio?: Float32Array }
  | { type: 'room'; id: number; room: number[] | null };

interface SegEx {
  memory: WebAssembly.Memory;
  sax_alloc(n: number): number; sax_free(p: number, n: number): void;
  sax_segment?(ptr: number, n: number, sr: number): number;
  sax_room?(ptr: number, n: number, sr: number): number;
  sax_analyze?(ptr: number, n: number, sr: number, target: number): number;
  sax_analyze_len?(): number;
  sax_analysis_config?(instT60Hz: number): void;
}

/** real recordings: instrument ring-down T60·f0 ≈ 95 (docs/COACHING.md); simulator output keeps 120 */
const RECORDING_T60_HZ = 95;

/** analyse a *recording* on the lightweight instance (config 95), else the host's extractor */
function analyzeRecording(audio: Float32Array, sr: number, target: number): { features: Float32Array; source: 'wasm' | 'fallback' } {
  const e = segEx;
  if (e?.sax_analyze && e.sax_analyze_len) {
    e.sax_analysis_config?.(RECORDING_T60_HZ);
    const p = e.sax_alloc(audio.length * 4);
    new Float32Array(e.memory.buffer, p, audio.length).set(audio);
    const r = e.sax_analyze(p, audio.length, sr, target);
    const features = new Float32Array(e.memory.buffer, r, e.sax_analyze_len()).slice();
    e.sax_free(p, audio.length * 4);
    return { features, source: 'wasm' };
  }
  return { features: host!.analyze(audio, sr, target), source: host!.native.analyze ? 'wasm' : 'fallback' };
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<ToCoachWorker>) => void) | null; postMessage(m: FromCoachWorker, t?: Transferable[]): void };
let host: EngineHost | null = null;
let segEx: SegEx | null = null;
const queue: ToCoachWorker[] = [];

async function init(m: Extract<ToCoachWorker, { type: 'init' }>): Promise<void> {
  try {
    const res = await fetch(m.wasmUrl);
    if (!res.ok) throw new Error(`engine.wasm: HTTP ${res.status}`);
    const mod = await WebAssembly.compile(await res.arrayBuffer());
    host = new EngineHost(mod, m.geometry);
    const inst = await WebAssembly.instantiate(mod, {});
    segEx = inst.exports as unknown as SegEx;
    ctx.postMessage({ type: 'ready', caps: { analyze: host.native.analyze, segment: typeof segEx.sax_segment === 'function', room: typeof segEx.sax_room === 'function', resetState: host.native.reset, seed: host.native.seed } });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
  for (const q of queue.splice(0)) handle(q);
}

function segment(audio: Float32Array, sr: number): { segments: [number, number][]; source: 'wasm' | 'fallback' } {
  const e = segEx;
  if (e?.sax_segment) {
    // assumed layout: [count, start0, end0, start1, end1, …] (samples)
    const p = e.sax_alloc(audio.length * 4);
    new Float32Array(e.memory.buffer, p, audio.length).set(audio);
    const r = e.sax_segment(p, audio.length, sr);
    const count = new Float32Array(e.memory.buffer, r, 1)[0];
    let segs: [number, number][] | null = null;
    if (Number.isInteger(count) && count >= 0 && count < 1000) {
      const v = new Float32Array(e.memory.buffer, r, 1 + 2 * count);
      segs = [];
      for (let i = 0; i < count; i++) segs.push([Math.round(v[1 + 2 * i]), Math.round(v[2 + 2 * i])]);
    }
    e.sax_free(p, audio.length * 4);
    if (segs) return { segments: segs, source: 'wasm' };
  }
  return { segments: segmentJS(audio, sr), source: 'fallback' };
}

function handle(m: ToCoachWorker): void {
  if (m.type === 'init') { void init(m); return; }
  if (!host) { queue.push(m); return; }
  try {
    if (m.type === 'analyze') {
      ctx.postMessage({ type: 'features', id: m.id, ...analyzeRecording(m.audio, m.sr, m.target) });
    } else if (m.type === 'segment') {
      ctx.postMessage({ type: 'segments', id: m.id, ...segment(m.audio, m.sr) });
    } else if (m.type === 'room') {
      // [rt60, rt60_spread, drr, noise_floor, n_tails, confidence, verdict, clap_rt60, tail_ratio] (docs/COACHING.md)
      const e = segEx;
      let room: number[] | null = null;
      if (e?.sax_room) {
        e.sax_analysis_config?.(RECORDING_T60_HZ);
        const p = e.sax_alloc(m.audio.length * 4);
        new Float32Array(e.memory.buffer, p, m.audio.length).set(m.audio);
        const r = e.sax_room(p, m.audio.length, m.sr);
        room = Array.from(new Float32Array(e.memory.buffer, r, 9));
        e.sax_free(p, m.audio.length * 4);
      }
      ctx.postMessage({ type: 'room', id: m.id, room });
    } else if (m.type === 'render') {
      const r = host.render(m.job);
      ctx.postMessage({ type: 'rendered', id: m.id, features: r.features, audio: r.audio }, r.audio ? [r.audio.buffer] : []);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', id: (m as { id?: number }).id, message: err instanceof Error ? err.message : String(err) });
  }
}

ctx.onmessage = (ev) => handle(ev.data);
