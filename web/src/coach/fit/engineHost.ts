// One offline engine instance (engine.wasm) rendering test-set notes and analysing them.
// Environment-agnostic: used inside Web Workers (browser), worker_threads (Node tests) and inline.
import { P, PARAMS, PARAM_COUNT } from '../../engine/params.ts';
import { FEATURE_LEN, tsAnalyze } from './features.ts';

interface Ex {
  memory: WebAssembly.Memory;
  sax_alloc(n: number): number;
  sax_free(p: number, n: number): void;
  sax_init(sr: number): number;
  sax_load_geometry(p: number, n: number): number;
  sax_set_param(id: number, v: number): void;
  sax_set_key(i: number, v: number): void;
  sax_process(n: number): number;
  // M9 additions (optional until the DSP programmer's build lands)
  sax_analyze?(p: number, n: number, sr: number, targetHz: number): number;
  sax_analyze_len?(): number;
  sax_reset_state?(): void;
  sax_set_seed?(seed: number): void;
  sax_analysis_config?(instT60Hz: number): void;
}

export interface RenderJob {
  /** fingering name in data/alto_sax.json */
  note: string;
  /** engine param overrides (id, value) on top of the render baseline */
  params: [number, number][];
  oversample: number;
  /** rendered length (s) */
  seconds: number;
  seed: number;
  /**
   * soft notes: start at this (higher) lung pressure and glide to the note's pressure over
   * ATTACK_GLIDE — the way a pp is sustained on the soft (hysteretic) branch of the oscillation
   */
  attackPressure?: number;
  /** tongued attack: tongue on the reed for this long (s) while the breath builds (default 0.06) */
  tongueRelease?: number;
  /** also return the rendered audio (Pa at 1 m) */
  wantAudio?: boolean;
}

export interface RenderResult {
  features: Float32Array;
  audio?: Float32Array;
  /** wall time of the render + analysis (ms) */
  ms: number;
}

/** Engine output units → Pa at 1 m (engine PA_TO_FS = 0.1, master gain 1). */
const OUT_TO_PA = 10;
export const FS = 48000;
/** tongued attack: tongue on the reed for this long while the air pressure builds (s) */
const TONGUE_TIME = 0.06;
/** glide from the attack pressure to the note pressure (s), starting after the tongue release */
const ATTACK_GLIDE = 0.25;
/** instrument ring-down constant T60·f0 (Hz·s) for real alto recordings (simulator: default 120) */
export const REC_INST_T60 = 95;
/** breath-noise level used when the engine has a seedable RNG (else 0: deterministic) */
const BREATH_NOISE = 0.05;

interface Fingering {
  keys: number[];
  target: number;
}

export class EngineHost {
  private ex: Ex;
  private geom: Uint8Array;
  private fingerings = new Map<string, Fingering>();
  private keyCount: number;
  readonly native: { analyze: boolean; reset: boolean; seed: boolean };

  constructor(module: WebAssembly.Module, geometryJson: string) {
    const inst = new WebAssembly.Instance(module, {});
    this.ex = inst.exports as unknown as Ex;
    this.geom = new TextEncoder().encode(geometryJson);
    const g = JSON.parse(geometryJson) as {
      keys: { id: string }[];
      fingerings: { note: string; keys: string[]; f_target: number }[];
      alternate_fingerings?: { note: string; name?: string; keys: string[]; f_target?: number }[];
    };
    const kidx = new Map(g.keys.map((k, i) => [k.id, i]));
    this.keyCount = g.keys.length;
    for (const f of g.fingerings) this.fingerings.set(f.note, { keys: f.keys.map((k) => kidx.get(k)!).filter((i) => i !== undefined), target: f.f_target });
    for (const f of g.alternate_fingerings ?? []) {
      const name = f.name ? `${f.note} (${f.name})` : f.note;
      if (!this.fingerings.has(name) && f.f_target) this.fingerings.set(name, { keys: f.keys.map((k) => kidx.get(k)!).filter((i) => i !== undefined), target: f.f_target });
    }
    const ex = this.ex;
    this.native = {
      analyze: typeof ex.sax_analyze === 'function' && typeof ex.sax_analyze_len === 'function',
      reset: typeof ex.sax_reset_state === 'function',
      seed: typeof ex.sax_set_seed === 'function',
    };
    this.boot();
  }

  targetHz(note: string): number {
    const f = this.fingerings.get(note);
    if (!f) throw new Error(`unknown fingering ${note}`);
    return f.target;
  }

  private boot(): void {
    const ex = this.ex;
    if (ex.sax_init(FS) !== 0) throw new Error('sax_init failed');
    const p = ex.sax_alloc(this.geom.length);
    new Uint8Array(ex.memory.buffer, p, this.geom.length).set(this.geom);
    const rc = ex.sax_load_geometry(p, this.geom.length);
    ex.sax_free(p, this.geom.length);
    if (rc !== 0) throw new Error(`sax_load_geometry returned ${rc}`);
  }

  /** Render one note from silence and analyse it. */
  render(job: RenderJob): RenderResult {
    const t0 = Date.now();
    const ex = this.ex;
    const fing = this.fingerings.get(job.note);
    if (!fing) throw new Error(`unknown fingering ${job.note}`);
    // baseline: defaults, pure physics (player_assist 0), deterministic
    for (let id = 0; id < PARAM_COUNT; id++) ex.sax_set_param(id, PARAMS[id].default);
    ex.sax_set_param(P.player_assist, 0);
    ex.sax_set_param(P.oversample, job.oversample);
    ex.sax_set_param(P.breath_noise, this.native.seed ? BREATH_NOISE : 0);
    let lung = 3.5;
    for (const [id, v] of job.params) {
      if (id === P.lung_pressure) lung = v;
      else ex.sax_set_param(id, v);
    }
    for (let k = 0; k < this.keyCount; k++) ex.sax_set_key(k, 0);
    for (const k of fing.keys) ex.sax_set_key(k, 1);
    if (this.native.reset) ex.sax_reset_state!();
    else this.rebootKeepingSettings(job, lung, fing);
    if (this.native.seed) ex.sax_set_seed!(job.seed >>> 0);
    // tongued attack: reed stopped by the tongue while the breath builds, then released
    ex.sax_set_param(P.tongue_reed_contact, 1);
    const p0 = job.attackPressure !== undefined && job.attackPressure > lung ? job.attackPressure : lung;
    ex.sax_set_param(P.lung_pressure, p0);
    const total = Math.round(job.seconds * FS);
    const audio = new Float32Array(total);
    const tongueEnd = Math.round((job.tongueRelease ?? TONGUE_TIME) * FS);
    let tongueOn = true;
    for (let done = 0; done < total; ) {
      if (tongueOn && done >= tongueEnd) {
        ex.sax_set_param(P.tongue_reed_contact, 0);
        tongueOn = false;
      }
      if (p0 !== lung && done >= tongueEnd) {
        const t = Math.min(1, (done - tongueEnd) / (ATTACK_GLIDE * FS));
        if (t <= 1) ex.sax_set_param(P.lung_pressure, p0 + (lung - p0) * t);
      }
      const n = Math.min(128, total - done);
      const ptr = ex.sax_process(n) >>> 2;
      const heap = new Float32Array(ex.memory.buffer, ptr * 4, n);
      for (let i = 0; i < n; i++) audio[done + i] = heap[i] * OUT_TO_PA;
      done += n;
    }
    const features = this.analyze(audio, FS, fing.target, 'simulation');
    return { features, audio: job.wantAudio ? audio : undefined, ms: Date.now() - t0 };
  }

  /** Without sax_reset_state: fresh engine (same instance), then the same settings again. */
  private rebootKeepingSettings(job: RenderJob, lung: number, fing: Fingering): void {
    const ex = this.ex;
    this.boot();
    for (let id = 0; id < PARAM_COUNT; id++) ex.sax_set_param(id, PARAMS[id].default);
    ex.sax_set_param(P.player_assist, 0);
    ex.sax_set_param(P.oversample, job.oversample);
    ex.sax_set_param(P.breath_noise, 0);
    for (const [id, v] of job.params) if (id !== P.lung_pressure) ex.sax_set_param(id, v);
    ex.sax_set_param(P.lung_pressure, 0);
    void lung;
    for (const k of fing.keys) ex.sax_set_key(k, 1);
  }

  /**
   * Feature vector of a mono buffer: the engine's `sax_analyze` when present, else the TS stand-in.
   * `source` sets the analyser's instrument ring-down constant for this call (docs/COACHING.md
   * `sax_analysis_config`): real recordings 95 Hz·s, simulator renders the default (120) — set on
   * every call, so the two never leak into each other on a shared instance.
   */
  analyze(x: Float32Array, sampleRate: number, targetHz: number, source: 'recording' | 'simulation' = 'recording'): Float32Array {
    const ex = this.ex;
    if (!this.native.analyze) return tsAnalyze(x, sampleRate, targetHz);
    ex.sax_analysis_config?.(source === 'recording' ? REC_INST_T60 : -1);
    const bytes = x.length * 4;
    const p = ex.sax_alloc(bytes);
    new Float32Array(ex.memory.buffer, p, x.length).set(x);
    const r = ex.sax_analyze!(p, x.length, sampleRate, targetHz) >>> 2;
    const len = ex.sax_analyze_len!();
    const out = new Float32Array(FEATURE_LEN);
    out.set(new Float32Array(ex.memory.buffer, r * 4, Math.min(len, FEATURE_LEN)));
    ex.sax_free(p, bytes);
    return out;
  }
}
