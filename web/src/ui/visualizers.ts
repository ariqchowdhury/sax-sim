// Canvas visualizers: oscilloscope (mouthpiece pressure + reed displacement), spectrum (AnalyserNode),
// standing-wave plot along the bore. All buffers preallocated.
import type { Telemetry } from '../engine/EngineClient';
import { SCOPE_LEN } from '../engine/params';

const C = {
  bg: '#0d121b',
  grid: 'rgba(140,160,190,0.12)',
  text: 'rgba(200,214,235,0.7)',
  a: '#ffa94d',
  b: '#5ec8ff',
  c: '#b48cff',
};

abstract class CanvasView {
  protected ctx: CanvasRenderingContext2D;
  protected w = 0;
  protected h = 0;
  protected dpr = 1;
  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }
  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(10, r.width);
    this.h = Math.max(10, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.afterResize();
  }
  /** resizing clears the canvas: views that only redraw on change must redraw */
  protected afterResize(): void {}
  protected begin(): CanvasRenderingContext2D {
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.w, this.h);
    return g;
  }
  protected label(text: string, x: number, y: number, color = C.text): void {
    const g = this.ctx;
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillStyle = color;
    g.fillText(text, x, y);
  }
}

export class Scope extends CanvasView {
  private pScale = 1000;
  private rScale = 0.001;
  private lastSeq = -1;
  draw(t: Telemetry, live: boolean): void {
    if (live && t.seq === this.lastSeq) return;
    this.lastSeq = t.seq;
    const g = this.begin();
    const { w, h } = this;
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, h / 2); g.lineTo(w, h / 2);
    for (let i = 1; i < 8; i++) { g.moveTo((w * i) / 8, 0); g.lineTo((w * i) / 8, h); }
    g.stroke();
    if (!live) {
      this.label('mouthpiece pressure / reed — no signal', 8, 14);
      return;
    }
    let pm = 0, rm = 0;
    for (let i = 0; i < SCOPE_LEN; i++) {
      pm = Math.max(pm, Math.abs(t.scopePressure[i]));
      rm = Math.max(rm, Math.abs(t.scopeReed[i]));
    }
    this.pScale += (Math.max(50, pm) * 1.15 - this.pScale) * (pm * 1.15 > this.pScale ? 0.5 : 0.05);
    this.rScale += (Math.max(1e-5, rm) * 1.15 - this.rScale) * (rm * 1.15 > this.rScale ? 0.5 : 0.05);
    this.trace(t.scopePressure, this.pScale, C.a);
    this.trace(t.scopeReed, this.rScale, C.b);
    this.label(`p_mp ±${(this.pScale / 1000).toFixed(2)} kPa`, 8, 14, C.a);
    this.label(`reed ±${(this.rScale * 1000).toFixed(2)} mm`, 8, 27, C.b);
  }
  private trace(a: Float32Array, scale: number, color: string): void {
    const g = this.ctx, { w, h } = this;
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < SCOPE_LEN; i++) {
      const x = (w * i) / (SCOPE_LEN - 1);
      const y = h / 2 - (a[i] / scale) * (h * 0.45);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }
}

export class Spectrum extends CanvasView {
  private buf: Float32Array<ArrayBuffer> = new Float32Array(4096);
  private fMin = 60;
  private fMax = 10000;
  draw(an: AnalyserNode | null, f0: number, sampleRate: number): void {
    const g = this.begin();
    const { w, h } = this;
    const lx = (f: number): number => (Math.log(f / this.fMin) / Math.log(this.fMax / this.fMin)) * w;
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [100, 200, 500, 1000, 2000, 5000]) { g.moveTo(lx(f), 0); g.lineTo(lx(f), h); }
    g.stroke();
    for (const f of [100, 1000, 5000]) this.label(f >= 1000 ? `${f / 1000}k` : `${f}`, lx(f) + 2, h - 4);
    if (!an) {
      this.label('spectrum — start audio', 8, 14);
      return;
    }
    if (this.buf.length !== an.frequencyBinCount) this.buf = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(this.buf);
    const n = this.buf.length;
    const binHz = sampleRate / 2 / n;
    const dbMin = -120, dbMax = -10;
    // harmonic markers
    if (f0 > 20) {
      g.strokeStyle = 'rgba(180,140,255,0.25)';
      g.beginPath();
      for (let k = 1; k * f0 < this.fMax; k++) { const x = lx(k * f0); g.moveTo(x, 0); g.lineTo(x, h); }
      g.stroke();
    }
    g.fillStyle = 'rgba(94,200,255,0.18)';
    g.strokeStyle = C.b;
    g.lineWidth = 1.2;
    g.beginPath();
    let started = false;
    let lastX = -1;
    for (let i = 1; i < n; i++) {
      const f = i * binHz;
      if (f < this.fMin) continue;
      if (f > this.fMax) break;
      const x = lx(f);
      if (x - lastX < 0.75 && i < n - 1) continue;
      lastX = x;
      const y = h - ((Math.max(dbMin, Math.min(dbMax, this.buf[i])) - dbMin) / (dbMax - dbMin)) * h;
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke();
    this.label('spectrum (output)', 8, 14);
  }
}

export class BorePlot extends CanvasView {
  private lastSeq = -1;
  draw(t: Telemetry, live: boolean, peak: number): void {
    if (live && t.seq === this.lastSeq) return;
    this.lastSeq = t.seq;
    const g = this.begin();
    const { w, h } = this;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(0, h / 2); g.lineTo(w, h / 2);
    g.stroke();
    this.label('reed', 4, h - 4);
    this.label('bell', w - 26, h - 4);
    if (!live || t.nProfile < 2) {
      this.label('pressure along bore — no signal', 8, 14);
      return;
    }
    const n = t.nProfile;
    const sc = (h * 0.45) / Math.max(1, peak);
    g.fillStyle = 'rgba(255,169,77,0.12)';
    g.beginPath();
    for (let i = 0; i < n; i++) { const x = (w * i) / (n - 1); const y = h / 2 - t.profileRms[i] * 1.414 * sc; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    for (let i = n - 1; i >= 0; i--) { const x = (w * i) / (n - 1); g.lineTo(x, h / 2 + t.profileRms[i] * 1.414 * sc); }
    g.fill();
    g.strokeStyle = C.a;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < n; i++) { const x = (w * i) / (n - 1); const y = h / 2 - t.profile[i] * sc; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
    this.label(`standing wave ±${(peak / 1000).toFixed(2)} kPa`, 8, 14, C.a);
  }
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
export function noteName(f: number): string {
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

export interface ImpedanceData {
  n: number;
  fmin: number;
  fmax: number;
  mag: Float32Array;
  phase?: Float32Array;
  ms: number;
}

/** local maxima with ≥ `minProm` dB prominence, sub-bin interpolated: [freqs, mags] */
function findPeaks(d: { n: number; fmin: number; fmax: number }, mag: Float32Array, minProm = 3): [number[], number[]] {
  const fs: number[] = [], ms: number[] = [];
  const n = d.n;
  for (let i = 2; i < n - 2; i++) {
    if (!(mag[i] > mag[i - 1] && mag[i] >= mag[i + 1])) continue;
    let lo = i, hi = i;
    while (lo > 0 && mag[lo - 1] <= mag[lo]) lo--;
    while (hi < n - 1 && mag[hi + 1] <= mag[hi]) hi++;
    const prom = 20 * Math.log10(mag[i] / Math.max(mag[lo], mag[hi], 1e-9));
    if (prom < minProm) continue;
    const a = Math.log(mag[i - 1]), b = Math.log(mag[i]), c = Math.log(mag[i + 1]);
    const off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / (a - 2 * b + c || 1)));
    fs.push(d.fmin * Math.pow(d.fmax / d.fmin, (i + off) / (n - 1)));
    ms.push(mag[i]);
  }
  return [fs, ms];
}

/**
 * Input impedance on a log-f axis: Z_bore (purple, peaks numbered), optional overlays of the vocal
 * tract seen from the reed Z_tract (cyan) and the series sum |Z_bore + Z_tract| (white) that the
 * reed actually works against, with the tract-resonance marker and the playing frequency.
 */
export class ImpedancePlot extends CanvasView {
  /** bore resonance peaks (Hz), ascending */
  peaks: number[] = [];
  private peakMag: number[] = [];
  private data: ImpedanceData | null = null;
  private tract: ImpedanceData | null = null;
  private sum: Float32Array | null = null;
  /** dominant tract resonance (Hz) in 400–2500 Hz, 0 if none; and its |Z| (Pa·s/m³) */
  tractRes = 0;
  tractResMag = 0;
  /** peaks of |Z_bore + Z_tract| */
  sumPeaks: number[] = [];
  showTract = true;
  private lastF0 = -1;
  private dirty = true;
  status = 'computing…';
  private dbMin = 0;
  private dbMax = 50;

  protected override afterResize(): void {
    this.dirty = true;
  }

  setData(d: ImpedanceData): void {
    this.data = d;
    [this.peaks, this.peakMag] = findPeaks(d, d.mag);
    this.combine();
  }

  setTract(d: ImpedanceData): void {
    this.tract = d;
    const [fs, ms] = findPeaks(d, d.mag, 1);
    this.tractRes = 0;
    this.tractResMag = 0;
    for (let k = 0; k < fs.length; k++) if (fs[k] > 400 && fs[k] < 2500 && ms[k] > this.tractResMag) { this.tractRes = fs[k]; this.tractResMag = ms[k]; }
    this.combine();
  }

  private combine(): void {
    const b = this.data, t = this.tract;
    this.sum = null;
    this.sumPeaks = [];
    if (b && t && b.phase && t.phase && b.n === t.n && b.fmin === t.fmin && b.fmax === t.fmax) {
      const s = new Float32Array(b.n);
      for (let i = 0; i < b.n; i++) {
        const re = b.mag[i] * Math.cos(b.phase[i]) + t.mag[i] * Math.cos(t.phase[i]);
        const im = b.mag[i] * Math.sin(b.phase[i]) + t.mag[i] * Math.sin(t.phase[i]);
        s[i] = Math.hypot(re, im);
      }
      this.sum = s;
      this.sumPeaks = findPeaks(b, s)[0];
    }
    let mx = 1;
    const scan = (a: Float32Array | null | undefined): void => { if (a) for (let i = 0; i < a.length; i++) mx = Math.max(mx, a[i]); };
    scan(b?.mag);
    if (this.showTract) { scan(t?.mag); scan(this.sum); }
    this.dbMax = Math.ceil((20 * Math.log10(mx / 1e6) + 4) / 5) * 5;
    this.dbMin = this.dbMax - 55;
    this.dirty = true;
  }

  setShowTract(on: boolean): void {
    this.showTract = on;
    this.combine();
  }

  /** 1-based index of the bore impedance peak the note is playing on (within ±120 cents), else 0 */
  peakIndexFor(f0: number): number {
    let best = 0, bc = 120;
    for (let k = 0; k < this.peaks.length; k++) {
      const c = Math.abs(1200 * Math.log2(f0 / this.peaks[k]));
      if (c < bc) { bc = c; best = k + 1; }
    }
    return best;
  }

  draw(f0: number): void {
    if (!this.dirty && Math.abs(f0 - this.lastF0) < 0.5) return;
    this.dirty = false;
    this.lastF0 = f0;
    const g = this.begin();
    const { w, h } = this;
    const d = this.data;
    const fmin = d?.fmin ?? 60, fmax = d?.fmax ?? 3000;
    const lx = (f: number): number => (Math.log(f / fmin) / Math.log(fmax / fmin)) * w;
    const dbMin = this.dbMin, dbMax = this.dbMax; // dB re 1 MPa·s/m³
    const ly = (m: number): number => h - 12 - ((20 * Math.log10(Math.max(m, 1) / 1e6) - dbMin) / (dbMax - dbMin)) * (h - 26);
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [100, 200, 500, 1000, 2000]) { g.moveTo(lx(f), 0); g.lineTo(lx(f), h); }
    g.stroke();
    for (const f of [100, 200, 500, 1000, 2000]) this.label(f >= 1000 ? `${f / 1000}k` : `${f}`, lx(f) + 2, h - 3);
    if (!d) {
      this.label(`input impedance — ${this.status}`, 8, 14);
      return;
    }
    if (f0 > 20) {
      g.strokeStyle = 'rgba(255,169,77,0.35)';
      g.setLineDash([3, 3]);
      g.beginPath();
      for (let k = 2; k * f0 < fmax; k++) { const x = lx(k * f0); g.moveTo(x, 14); g.lineTo(x, h); }
      g.stroke();
      g.setLineDash([]);
      g.strokeStyle = C.a;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(lx(f0), 14); g.lineTo(lx(f0), h);
      g.stroke();
    }
    const curve = (a: Float32Array, color: string, width: number): void => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (let i = 0; i < a.length; i++) {
        const x = (w * i) / (a.length - 1), y = ly(a[i]);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    };
    const t = this.showTract ? this.tract : null;
    if (t) curve(t.mag, 'rgba(94,200,255,0.85)', 1.2);
    curve(d.mag, C.c, 1.5);
    if (t && this.sum) curve(this.sum, 'rgba(255,255,255,0.75)', 1.1);
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let k = 0; k < this.peaks.length && k < 7; k++) {
      const x = lx(this.peaks[k]), y = ly(this.peakMag[k]);
      g.fillStyle = '#e3d4ff';
      g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
      if (k < 5) g.fillText(`${k + 1}:${Math.round(this.peaks[k])}`, Math.min(w - 48, x + 3), Math.max(24, y - 4));
    }
    if (t && this.tractRes > 0) {
      const x = lx(this.tractRes);
      g.strokeStyle = 'rgba(94,200,255,0.9)';
      g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x, h - 12); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#9fdcff';
      g.fillText(`tract ${Math.round(this.tractRes)} Hz`, Math.max(2, Math.min(w - 84, x - 40)), h - 14);
    }
    // legend
    const items: [string, string][] = [['Z_bore', C.c]];
    if (t) items.push(['Z_tract', '#5ec8ff'], ['|Z_bore+Z_tract|', '#ffffff']);
    let lxp = w - 6;
    for (let k = items.length - 1; k >= 0; k--) {
      const [txt, col] = items[k];
      const tw = g.measureText(txt).width;
      lxp -= tw;
      g.fillStyle = col;
      g.fillText(txt, lxp, 12);
      g.fillRect(lxp - 9, 8, 6, 2);
      lxp -= 16;
    }
    this.label(`|Z_in| · ${d.ms.toFixed(0)} ms`, 8, 24, C.text);
  }
}
