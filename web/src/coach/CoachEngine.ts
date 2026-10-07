// Promise API over the coach worker (analysis, segmentation, offline renders).
import type { FromCoachWorker, ToCoachWorker } from './analysis.worker';
import type { RenderJob } from './fit/engineHost';

export interface Caps { analyze: boolean; segment: boolean; room: boolean; resetState: boolean; seed: boolean }

export class CoachEngine {
  private worker: Worker;
  private id = 0;
  private waiting = new Map<number, { ok: (m: FromCoachWorker) => void; err: (e: Error) => void }>();
  readonly ready: Promise<Caps>;
  caps: Caps | null = null;

  constructor(wasmUrl: string, geometry: string) {
    this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    let resolveReady!: (c: Caps) => void, rejectReady!: (e: Error) => void;
    this.ready = new Promise((a, b) => { resolveReady = a; rejectReady = b; });
    this.worker.onmessage = (e: MessageEvent<FromCoachWorker>) => {
      const m = e.data;
      if (m.type === 'ready') { this.caps = m.caps; resolveReady(m.caps); return; }
      if (m.type === 'error' && m.id === undefined) { rejectReady(new Error(m.message)); return; }
      const id = (m as { id: number }).id;
      const w = this.waiting.get(id);
      if (!w) return;
      this.waiting.delete(id);
      if (m.type === 'error') w.err(new Error(m.message)); else w.ok(m);
    };
    this.post({ type: 'init', wasmUrl: new URL(wasmUrl, location.href).href, geometry });
  }

  private post(m: ToCoachWorker, t?: Transferable[]): void {
    this.worker.postMessage(m, t ?? []);
  }

  private call<T extends FromCoachWorker>(m: ToCoachWorker & { id: number }): Promise<T> {
    return new Promise((ok, err) => {
      this.waiting.set(m.id, { ok: ok as (x: FromCoachWorker) => void, err });
      this.post(m);
    });
  }

  async analyze(audio: Float32Array, sr: number, target: number): Promise<{ features: Float32Array; source: 'wasm' | 'fallback' }> {
    const r = await this.call<Extract<FromCoachWorker, { type: 'features' }>>({ type: 'analyze', id: ++this.id, audio, sr, target });
    return { features: r.features, source: r.source };
  }

  async segment(audio: Float32Array, sr: number): Promise<{ segments: [number, number][]; source: 'wasm' | 'fallback' }> {
    const r = await this.call<Extract<FromCoachWorker, { type: 'segments' }>>({ type: 'segment', id: ++this.id, audio, sr });
    return { segments: r.segments, source: r.source };
  }

  /** blind room estimate of a recording: 7 values or null when the engine has no sax_room */
  async room(audio: Float32Array, sr: number): Promise<number[] | null> {
    const r = await this.call<Extract<FromCoachWorker, { type: 'room' }>>({ type: 'room', id: ++this.id, audio, sr });
    return r.room;
  }

  /** offline render of a test note through the fitter's EngineHost (same renderer + extractor) */
  async render(job: RenderJob): Promise<{ features: Float32Array; audio?: Float32Array }> {
    const r = await this.call<Extract<FromCoachWorker, { type: 'rendered' }>>({ type: 'render', id: ++this.id, job });
    return { features: r.features, audio: r.audio };
  }
}
