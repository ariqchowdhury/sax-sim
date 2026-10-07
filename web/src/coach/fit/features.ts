// Feature vector layout (docs/COACHING.md "Feature vector — analysis.rs v1"; append only) and a
// TypeScript stand-in extractor used until the engine exports `sax_analyze`. The stand-in follows
// the same definitions so the fitting code can be developed and tested now; the engine's
// `analysis.rs` is the reference (one feature extractor for everything) and replaces it as soon
// as it is available (EngineHost picks it automatically).

export const F = {
  f0: 0,
  cents: 1,
  pitch_std: 2,
  vib_rate: 3,
  vib_depth: 4,
  level: 5,
  centroid_rel: 6,
  h1: 7, // H1..H10 at 7..16 (dB re H1, H1 = 0)
  odd_even: 17,
  tilt: 18,
  hnr: 19,
  edge: 20,
  attack: 21,
  scoop: 22,
  subharm: 23,
  regime: 24,
  valid: 25,
} as const;

export const FEATURE_LEN = 26;
export const N_HARM = 10;

export const FEATURE_NAMES: readonly string[] = [
  'f0', 'cents', 'pitch_std', 'vib_rate', 'vib_depth', 'level', 'centroid_rel',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10',
  'odd_even', 'tilt', 'hnr', 'edge', 'attack', 'scoop', 'subharm', 'regime', 'valid',
];

/** Analyse a mono buffer (feature vector of FEATURE_LEN). */
export type AnalyzeFn = (x: Float32Array, sampleRate: number, targetHz: number) => Float32Array;

// ---------------------------------------------------------------------------------------------
// Stand-in extractor
// ---------------------------------------------------------------------------------------------

const db = (x: number): number => 10 * Math.log10(Math.max(x, 1e-30));

/** Cumulative-mean-normalised difference pitch estimate (YIN) of one frame; 0 if unvoiced. */
function yin(x: Float32Array, start: number, win: number, sr: number, fmin: number, fmax: number): number {
  const minLag = Math.max(2, Math.floor(sr / fmax));
  const maxLag = Math.min(Math.ceil(sr / fmin), x.length - start - win - 1);
  if (maxLag <= minLag + 2) return 0;
  const d = new Float64Array(maxLag + 2);
  let run = 0;
  d[0] = 1;
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    let s = 0;
    for (let j = 0; j < win; j++) {
      const e = x[start + j] - x[start + j + tau];
      s += e * e;
    }
    run += s;
    d[tau] = run > 0 ? (s * tau) / run : 1;
  }
  let best = 0;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (d[tau] < 0.15) {
      while (tau + 1 <= maxLag && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (!best) {
    // no clear dip: global minimum if reasonably periodic
    let m = 1;
    for (let tau = minLag; tau <= maxLag; tau++) if (d[tau] < m) { m = d[tau]; best = tau; }
    if (m > 0.35) return 0;
  }
  const y0 = d[best - 1], y1 = d[best], y2 = d[best + 1];
  const den = y0 - 2 * y1 + y2;
  const off = Math.abs(den) > 1e-12 ? Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / den)) : 0;
  return sr / (best + off);
}

/** Hann-windowed copy of x[a..b). */
function windowed(x: Float32Array, a: number, b: number): Float64Array {
  const n = b - a;
  const y = new Float64Array(n);
  for (let k = 0; k < n; k++) y[k] = x[a + k] * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / n));
  return y;
}

/** DFT magnitude² (normalised) of a pre-windowed segment at frequency f. */
function bin(y: Float64Array, f: number, sr: number): number {
  const n = y.length;
  const w = (2 * Math.PI * f) / sr;
  const c = Math.cos(w), s = Math.sin(w);
  let cr = 1, ci = 0, re = 0, im = 0;
  for (let k = 0; k < n; k++) {
    const v = y[k];
    re += v * cr;
    im += v * ci;
    const t = cr * c - ci * s;
    ci = cr * s + ci * c;
    cr = t;
    if ((k & 1023) === 1023) {
      const m = 1 / Math.hypot(cr, ci);
      cr *= m;
      ci *= m;
    }
  }
  return (re * re + im * im) / (n * n);
}

/** In-place radix-2 FFT power spectrum of a Hann-windowed segment (length = power of two). */
function powerSpectrum(x: Float32Array, a: number, n: number): Float64Array {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) re[k] = (a + k < x.length ? x[a + k] : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / n));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  const p = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

/**
 * Stand-in for `analysis.rs` (same feature definitions, simpler estimators): vibrato is not
 * separated (vib_* = 0), noise is estimated from the inter-harmonic spectrum.
 */
export const tsAnalyze: AnalyzeFn = (x, sr, targetHz) => {
  const out = new Float32Array(FEATURE_LEN);
  out[F.subharm] = -120;
  const n = x.length;
  // --- RMS envelope (10 ms frames) → onset, steady part
  const hop = Math.round(sr * 0.01);
  const nf = Math.floor(n / hop);
  const env = new Float64Array(nf);
  for (let i = 0; i < nf; i++) {
    let s = 0;
    for (let k = 0; k < hop; k++) s += x[i * hop + k] ** 2;
    env[i] = Math.sqrt(s / hop);
  }
  const tail = Array.from(env.slice(Math.floor(nf / 2))).sort((a, b) => a - b);
  const steadyRms = tail.length ? tail[Math.floor(tail.length / 2)] : 0;
  if (!(steadyRms > 0)) return out;
  let onset = env.findIndex((v) => v > 0.1 * steadyRms);
  if (onset < 0) onset = 0;
  let t90 = onset;
  while (t90 < nf && env[t90] < 0.9 * steadyRms) t90++;
  out[F.attack] = (t90 - onset) * 10;
  // steady part: from max(onset + 150 ms, 90 % point + 50 ms) to the end
  const a = Math.min(n - 4096, Math.max(onset + 15, t90 + 5) * hop);
  const b = n;
  if (a < 0 || b - a < 2048) return out;
  // --- pitch track over the steady part (≥ 2.2-period frames, 40 ms hop)
  const fmin = Math.max(40, targetHz / 2.6), fmax = Math.min(4000, targetHz * 3.6);
  const win = Math.round(Math.max(0.015, 2.2 / targetHz) * sr);
  const track: number[] = [];
  for (let s = a; s + win + sr / fmin + 2 < b; s += Math.round(0.04 * sr)) {
    const f = yin(x, s, win, sr, fmin, fmax);
    if (f > 0) track.push(f);
  }
  if (track.length < 3) return out;
  const sorted = [...track].sort((p, q) => p - q);
  let f0 = sorted[Math.floor(sorted.length / 2)];
  const y = windowed(x, a, b);
  // refine on the windowed DFT peak (±1 %)
  {
    let lo = f0 * 0.99, hi = f0 * 1.01;
    for (let it = 0; it < 3; it++) {
      let best = 0, bf = f0;
      for (let i = 0; i <= 10; i++) {
        const f = lo + ((hi - lo) * i) / 10;
        const m = bin(y, f, sr);
        if (m > best) { best = m; bf = f; }
      }
      const st = (hi - lo) / 10;
      lo = bf - st;
      hi = bf + st;
    }
    f0 = 0.5 * (lo + hi);
  }
  out[F.valid] = 1;
  out[F.f0] = f0;
  // regime: partial number of the sounding pitch relative to the intended one
  const ratio = f0 / targetHz;
  const cands = [0.5, 1, 1.5, 2, 2.5, 3, 4];
  let reg = 1;
  for (const c of cands) if (Math.abs(Math.log2(ratio / c)) < Math.abs(Math.log2(ratio / reg))) reg = c;
  out[F.regime] = reg;
  out[F.cents] = 1200 * Math.log2(f0 / (targetHz * reg));
  const cents = track.map((f) => 1200 * Math.log2(f / f0)).filter((c) => Math.abs(c) < 300);
  const mc = cents.reduce((s, c) => s + c, 0) / Math.max(1, cents.length);
  out[F.pitch_std] = Math.sqrt(cents.reduce((s, c) => s + (c - mc) ** 2, 0) / Math.max(1, cents.length));
  // --- level (RMS of the steady part)
  let e = 0;
  for (let k = a; k < b; k++) e += x[k] * x[k];
  out[F.level] = db(e / (b - a));
  // --- harmonics
  const hp = new Float64Array(N_HARM);
  for (let k = 1; k <= N_HARM; k++) hp[k - 1] = k * f0 < 0.48 * sr ? bin(y, k * f0, sr) : 1e-30;
  for (let k = 0; k < N_HARM; k++) out[F.h1 + k] = db(hp[k]) - db(hp[0]);
  let odd = 0, even = 0;
  for (const k of [3, 5, 7, 9]) odd += out[F.h1 + k - 1];
  for (const k of [2, 4, 6, 8, 10]) even += out[F.h1 + k - 1];
  out[F.odd_even] = odd / 4 - even / 5;
  {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 1; k <= N_HARM; k++) {
      const lx = Math.log2(k), ly = out[F.h1 + k - 1];
      sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
    }
    out[F.tilt] = (N_HARM * sxy - sx * sy) / (N_HARM * sxx - sx * sx);
  }
  // --- spectrum-based: centroid (harmonic region ≤ 8 kHz), HNR, edge, subharmonic
  const nfft = 1 << Math.min(15, Math.floor(Math.log2(b - a)));
  const ps = powerSpectrum(x, a, nfft);
  const df = sr / nfft;
  let tot = 0, edge = 0, num = 0, den = 0, harm = 0;
  for (let k = 1; k < ps.length; k++) {
    const f = k * df;
    if (f > 8000) break;
    tot += ps[k];
    if (f >= 2000 && f <= 5000) edge += ps[k];
    num += f * ps[k];
    den += ps[k];
    // within ±3 % of a harmonic → harmonic energy
    const h = Math.round(f / f0);
    if (h >= 1 && Math.abs(f - h * f0) < Math.max(0.03 * f0, 2 * df)) harm += ps[k];
  }
  out[F.centroid_rel] = den > 0 ? num / den / f0 : 0;
  out[F.hnr] = db(harm) - db(Math.max(tot - harm, 1e-12 * tot));
  out[F.edge] = db(edge) - db(tot);
  const sub = bin(y, 0.5 * f0, sr) + bin(y, 1.5 * f0, sr);
  out[F.subharm] = Math.max(-120, db(sub) - db(hp[0]));
  // --- scoop: pitch in the first 100 ms after the onset vs steady f0
  const s0 = onset * hop;
  const sc: number[] = [];
  for (let s = s0; s < s0 + 0.1 * sr && s + win + sr / fmin + 2 < n; s += Math.round(0.01 * sr)) {
    const f = yin(x, s, Math.round(0.02 * sr), sr, fmin, fmax);
    if (f > 0) {
      const c = 1200 * Math.log2(f / f0);
      if (Math.abs(c) < 300) sc.push(c);
    }
  }
  out[F.scoop] = sc.length ? sc.reduce((p, q) => p + q, 0) / sc.length : 0;
  return out;
};
