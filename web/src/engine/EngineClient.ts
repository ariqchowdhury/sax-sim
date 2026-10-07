// Main-thread API to the audio engine running in an AudioWorklet.
import workletUrl from './worklet.ts?worker&url';
import type { FromWorklet, ToWorklet, WorkletOptions } from './worklet';
import { PARAM_COUNT, SCOPE_LEN, T, clampParam, defaultValues } from './params';
import { SHM, SHM_BYTES } from './shm';

export type EngineStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'no-engine'; message: string }
  | { state: 'running' }
  | { state: 'suspended' }
  | { state: 'error'; message: string };

const MAX_PROFILE = 512;

/** Telemetry decoded into preallocated arrays (no per-frame allocation on the reader side). */
export class Telemetry {
  lungPressure = 0;
  mouthPressure = 0;
  mouthpiecePressure = 0;
  reedDisplacement = 0;
  reedOpening = 0;
  flow = 0;
  frequency = 0;
  outputRms = 0;
  cpuUs = 0;
  nProfile = 0;
  readonly profile = new Float32Array(MAX_PROFILE);
  readonly profileRms = new Float32Array(MAX_PROFILE);
  readonly scopePressure = new Float32Array(SCOPE_LEN);
  readonly scopeReed = new Float32Array(SCOPE_LEN);
  pads: Float32Array;
  /** monotonically increasing on every decoded block */
  seq = 0;
  /** performance.now() of last decode */
  time = 0;
  valid = false;

  constructor(padCount: number) {
    this.pads = new Float32Array(Math.max(1, padCount));
  }

  /** full latest telemetry block (incl. any fields appended after the documented layout) */
  readonly raw = new Float32Array(SHM.TEL_CAP);
  rawLen = 0;
  /** index in `raw` of the first value after the documented layout (17 + 2N + 128) */
  tailStart = 0;

  /** d[0..n) telemetry, pads[0..np) — copies into preallocated arrays */
  decode(d: Float32Array, n: number, pads: Float32Array, np: number): void {
    const len = Math.min(n, this.raw.length);
    for (let i = 0; i < len; i++) this.raw[i] = d[i];
    this.rawLen = len;
    const r = this.raw;
    this.lungPressure = r[T.lung_pressure];
    this.mouthPressure = r[T.mouth_pressure];
    this.mouthpiecePressure = r[T.mouthpiece_pressure];
    this.reedDisplacement = r[T.reed_displacement];
    this.reedOpening = r[T.reed_opening];
    this.flow = r[T.flow];
    this.frequency = r[T.frequency];
    this.outputRms = r[T.output_rms];
    this.cpuUs = r[T.cpu_us];
    let np2 = Math.round(r[T.n_profile] || 0);
    const avail = len - T.profile_start - 2 * SCOPE_LEN;
    np2 = Math.max(0, Math.min(np2, MAX_PROFILE, Math.floor(avail / 2)));
    this.nProfile = np2;
    const p0 = T.profile_start;
    for (let i = 0; i < np2; i++) {
      this.profile[i] = r[p0 + i];
      this.profileRms[i] = r[p0 + np2 + i];
    }
    const s0 = p0 + 2 * np2;
    for (let i = 0; i < SCOPE_LEN; i++) {
      this.scopePressure[i] = s0 + i < len ? r[s0 + i] : 0;
      this.scopeReed[i] = s0 + SCOPE_LEN + i < len ? r[s0 + SCOPE_LEN + i] : 0;
    }
    this.tailStart = s0 + 2 * SCOPE_LEN;
    if (np !== this.pads.length) this.pads = new Float32Array(np);
    for (let i = 0; i < np; i++) this.pads[i] = pads[i];
    this.seq++;
    this.time = performance.now();
    this.valid = true;
  }
}

export interface EngineClientOptions {
  wasmUrl?: string;
  geometryJson: string | null;
  padCount: number;
  keyCount: number;
}

export class EngineClient {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  readonly params: Float32Array = defaultValues();
  readonly keys: Float32Array;
  readonly telemetry: Telemetry;
  status: EngineStatus = { state: 'idle' };

  private statusListeners: ((s: EngineStatus) => void)[] = [];
  private telemetryListeners: ((t: Telemetry) => void)[] = [];
  private opts: EngineClientOptions;
  /** SharedArrayBuffer telemetry (null → postMessage fallback) */
  shared: SharedArrayBuffer | null = null;
  private shHead: Int32Array | null = null;
  private shTel: Float32Array | null = null;
  private shPads: Float32Array | null = null;
  private lastSeq = -1;
  private scratchTel = new Float32Array(SHM.TEL_CAP);
  private scratchPads = new Float32Array(SHM.PAD_CAP);
  /** 'shared' | 'message' — how telemetry arrives */
  get transport(): string {
    return this.shared ? 'SharedArrayBuffer' : 'postMessage';
  }

  /**
   * Pull the latest telemetry from shared memory (seqlock read). Call once per animation frame.
   * Allocation-free. Returns true if a new block was decoded.
   */
  poll(): boolean {
    const head = this.shHead;
    if (!head || !this.shTel || !this.shPads) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const s1 = Atomics.load(head, SHM.SEQ);
      if (s1 & 1) continue; // writer active
      if (s1 === this.lastSeq) return false;
      const tl = head[SHM.TEL_LEN], pc = head[SHM.PAD_COUNT];
      for (let i = 0; i < tl; i++) this.scratchTel[i] = this.shTel[i];
      for (let i = 0; i < pc; i++) this.scratchPads[i] = this.shPads[i];
      if (Atomics.load(head, SHM.SEQ) !== s1) continue; // torn read → retry
      this.lastSeq = s1;
      if (tl > 0) {
        this.telemetry.decode(this.scratchTel, tl, this.scratchPads, pc);
        for (const l of this.telemetryListeners) l(this.telemetry);
        return true;
      }
      return false;
    }
    return false;
  }

  constructor(opts: EngineClientOptions) {
    this.opts = opts;
    this.keys = new Float32Array(Math.max(1, opts.keyCount));
    this.telemetry = new Telemetry(opts.padCount);
  }

  onStatus(cb: (s: EngineStatus) => void): void {
    this.statusListeners.push(cb);
    cb(this.status);
  }

  onTelemetry(cb: (t: Telemetry) => void): void {
    this.telemetryListeners.push(cb);
  }

  private setStatus(s: EngineStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  get running(): boolean {
    return this.status.state === 'running';
  }

  /** Probe whether engine.wasm has been built, without starting audio. */
  async probe(): Promise<boolean> {
    const bytes = await this.fetchWasm().catch(() => null);
    if (!bytes) {
      this.setStatus({ state: 'no-engine', message: 'engine not built — run `npm run build:engine`' });
      return false;
    }
    return true;
  }

  private async fetchWasm(): Promise<ArrayBuffer | null> {
    const url = this.opts.wasmUrl ?? `${import.meta.env.BASE_URL}engine.wasm`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // Vite's SPA fallback can answer 200 with index.html: check the wasm magic number.
    const h = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (h.length < 4 || h[0] !== 0x00 || h[1] !== 0x61 || h[2] !== 0x73 || h[3] !== 0x6d) return null;
    return buf;
  }

  /** Must be called from a user gesture (click / key). */
  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (this.node) this.setStatus({ state: 'running' });
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    // resume synchronously within the gesture
    void ctx.resume();
    this.setStatus({ state: 'loading' });
    try {
      const wasmBytes = await this.fetchWasm();
      if (!wasmBytes) {
        this.setStatus({ state: 'no-engine', message: 'engine not built — run `npm run build:engine`' });
        return;
      }
      await ctx.audioWorklet.addModule(workletUrl);
      const geometry = this.opts.geometryJson ? new TextEncoder().encode(this.opts.geometryJson) : null;
      this.shared = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated ? new SharedArrayBuffer(SHM_BYTES) : null;
      if (this.shared) {
        this.shHead = new Int32Array(this.shared, 0, SHM.HEADER);
        this.shTel = new Float32Array(this.shared, SHM.HEADER * 4, SHM.TEL_CAP);
        this.shPads = new Float32Array(this.shared, SHM.HEADER * 4 + SHM.TEL_CAP * 4, SHM.PAD_CAP);
      }
      const processorOptions: WorkletOptions = {
        wasmBytes,
        shared: this.shared,
        geometry,
        padCount: this.opts.padCount,
        params: Array.from(this.params),
        keys: Array.from(this.keys),
      };
      const node = new AudioWorkletNode(ctx, 'sax-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      this.node = node;
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.onMessage(e.data);
      node.onprocessorerror = () => this.setStatus({ state: 'error', message: 'audio processor crashed' });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0.6;
      this.analyser = analyser;
      node.connect(analyser);
      node.connect(ctx.destination);
      ctx.onstatechange = () => {
        if (this.status.state === 'running' || this.status.state === 'suspended') {
          this.setStatus({ state: ctx.state === 'running' ? 'running' : 'suspended' });
        }
      };
    } catch (err) {
      this.setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async suspend(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  private onMessage(m: FromWorklet): void {
    if (m.type === 'ready') this.setStatus({ state: 'running' });
    else if (m.type === 'error') this.setStatus({ state: 'error', message: m.message });
    else if (m.type === 'telemetry') {
      this.telemetry.decode(m.data, m.data.length, m.pads, m.pads.length);
      for (const l of this.telemetryListeners) l(this.telemetry);
    }
  }

  private post(m: ToWorklet): void {
    this.node?.port.postMessage(m);
  }

  setParam(id: number, value: number): void {
    if (id < 0 || id >= PARAM_COUNT) return;
    const v = clampParam(id, value);
    if (this.params[id] === v) return;
    this.params[id] = v;
    this.post({ type: 'param', id, value: v });
  }

  setKey(index: number, pressed: number): void {
    if (index < 0 || index >= this.keys.length) return;
    if (this.keys[index] === pressed) return;
    this.keys[index] = pressed;
    this.post({ type: 'key', index, value: pressed });
  }

  setGeometry(json: string, padCount: number): void {
    this.post({ type: 'geometry', json, padCount });
  }
}
