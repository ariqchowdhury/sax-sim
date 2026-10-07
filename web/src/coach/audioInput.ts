// Microphone capture (raw: no echo cancellation / noise suppression / AGC) and file decoding,
// both delivered as mono Float32Array at 48 kHz. Audio never leaves the browser.
import workletUrl from '../engine/worklet.ts?worker&url';

export const COACH_SR = 48000;

export class MicCapture {
  ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Float32Array[] = [];
  private buf = new Float32Array(2048);
  recording = false;
  /** peak level of the last meter read (0..1) and a sticky clip flag for the current take */
  peak = 0;
  clipped = false;
  deviceLabel = '';
  sampleRate = COACH_SR;

  async open(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: COACH_SR, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.deviceLabel = this.stream.getAudioTracks()[0]?.label ?? '';
    // the context resamples the device to 48 kHz if needed
    this.ctx = new AudioContext({ sampleRate: COACH_SR, latencyHint: 'interactive' });
    this.sampleRate = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule(workletUrl); // provides the 'sax-recorder' tap
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.node = new AudioWorkletNode(this.ctx, 'sax-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.analyser);
    src.connect(this.node).connect(mute).connect(this.ctx.destination);
    this.node.port.onmessage = (e: MessageEvent<{ type: 'data' | 'end'; data: Float32Array }>) => {
      if (e.data.data.length) this.chunks.push(e.data.data);
      if (e.data.type === 'end') this.onEnd?.();
    };
  }

  private onEnd: (() => void) | null = null;

  /** current input peak (call per frame for the level meter) */
  meter(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (let i = 0; i < this.buf.length; i++) p = Math.max(p, Math.abs(this.buf[i]));
    this.peak = p;
    if (this.recording && p >= 0.98) this.clipped = true;
    return p;
  }

  start(): void {
    if (!this.node) return;
    this.chunks = [];
    this.clipped = false;
    this.recording = true;
    this.node.port.postMessage({ type: 'start' });
  }

  stop(): Promise<Float32Array> {
    return new Promise((resolve) => {
      if (!this.node || !this.recording) { resolve(new Float32Array(0)); return; }
      this.recording = false;
      this.onEnd = () => {
        this.onEnd = null;
        const n = this.chunks.reduce((a, c) => a + c.length, 0);
        const out = new Float32Array(n);
        let o = 0;
        for (const c of this.chunks) { out.set(c, o); o += c.length; }
        this.chunks = [];
        resolve(out);
      };
      this.node.port.postMessage({ type: 'stop' });
    });
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }
}

/** decode any browser-supported audio file (WAV/MP3/M4A/…) to mono 48 kHz */
export async function decodeFile(file: Blob): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  const tmp = new OfflineAudioContext(1, 1, COACH_SR);
  const buf = await tmp.decodeAudioData(bytes); // resampled to the context rate (48 kHz)
  return mixdown(buf);
}

export function mixdown(buf: AudioBuffer): Float32Array {
  const n = buf.length, out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  if (buf.sampleRate !== COACH_SR) return resampleLinear(out, buf.sampleRate, COACH_SR);
  return out;
}

export function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  const n = Math.floor((x.length * to) / from), out = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    const t = i * r, j = Math.floor(t), f = t - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? 0) * f;
  }
  return out;
}

/** 16-bit mono WAV → Float32Array (for tests / round trips without decodeAudioData) */
export function encodeWav16(x: Float32Array, sr = COACH_SR): ArrayBuffer {
  const b = new ArrayBuffer(44 + x.length * 2), v = new DataView(b);
  const s = (o: number, t: string): void => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); s(8, 'WAVE'); s(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return b;
}
