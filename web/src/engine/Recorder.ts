// WAV recording of the engine output and CSV capture of telemetry.
import type { EngineClient, Telemetry } from './EngineClient';
import { PARAMS } from './params';

export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 16-bit PCM mono WAV */
export function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 32767, true);
  return buf;
}

export class WavRecorder {
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private samples = 0;
  recording = false;
  onStop: ((seconds: number) => void) | null = null;

  constructor(private engine: EngineClient) {}

  get seconds(): number {
    return this.samples / (this.engine.ctx?.sampleRate ?? 48000);
  }

  /** requires audio to be running (the recorder processor lives in the engine's worklet module) */
  start(): boolean {
    const ctx = this.engine.ctx, src = this.engine.node;
    if (!ctx || !src) return false;
    if (!this.node) {
      this.node = new AudioWorkletNode(ctx, 'sax-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(this.node);
      this.node.connect(mute).connect(ctx.destination);
      this.node.port.onmessage = (e: MessageEvent<{ type: 'data' | 'end'; data: Float32Array }>) => {
        if (e.data.data.length) { this.chunks.push(e.data.data); this.samples += e.data.data.length; }
        if (e.data.type === 'end') this.finish();
      };
    }
    this.chunks = [];
    this.samples = 0;
    this.recording = true;
    this.node.port.postMessage({ type: 'start' });
    return true;
  }

  stop(): void {
    if (!this.recording || !this.node) return;
    this.recording = false;
    this.node.port.postMessage({ type: 'stop' }); // → 'end' message with the last samples
  }

  private finish(): void {
    const sr = this.engine.ctx?.sampleRate ?? 48000;
    const secs = this.samples / sr;
    if (this.samples > 0) download(`sax-${stamp()}.wav`, encodeWav(this.chunks, sr), 'audio/wav');
    this.chunks = [];
    this.onStop?.(secs);
  }
}

/** Telemetry → CSV (scalars + all params at each telemetry block, ~60 Hz) */
export class TelemetryCapture {
  capturing = false;
  private rows: string[] = [];
  private t0 = 0;
  constructor(engine: EngineClient, private params: Float32Array, private fingering: () => string) {
    engine.onTelemetry((t) => this.onTel(t));
  }
  get rowCount(): number {
    return this.rows.length;
  }
  start(): void {
    this.rows = [];
    this.t0 = performance.now();
    this.capturing = true;
  }
  stop(): void {
    if (!this.capturing) return;
    this.capturing = false;
    const head = ['t_s', 'lung_pa', 'mouth_pa', 'mouthpiece_pa', 'reed_y_m', 'reed_h_m', 'flow_m3s', 'freq_hz', 'out_rms', 'fingering', ...PARAMS.map((p) => p.name)];
    download(`sax-telemetry-${stamp()}.csv`, [head.join(','), ...this.rows].join('\n') + '\n', 'text/csv');
    this.rows = [];
  }
  private onTel(t: Telemetry): void {
    if (!this.capturing) return;
    const p: string[] = [];
    for (let i = 0; i < PARAMS.length; i++) p.push(String(+this.params[i].toFixed(5)));
    this.rows.push([((performance.now() - this.t0) / 1000).toFixed(4), t.lungPressure, t.mouthPressure, t.mouthpiecePressure, t.reedDisplacement, t.reedOpening, t.flow, t.frequency, t.outputRms, `"${this.fingering()}"`, ...p].join(','));
  }
}
