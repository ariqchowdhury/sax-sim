//! Tone analysis (M9, docs/COACHING.md "Feature vector"): one feature extractor for
//! recordings and simulator output alike.
//!
//! Pipeline for a single-note buffer:
//!   1. conditioning: DC/rumble high-pass (2nd-order, 40 Hz) + 50 and 60 Hz hum notches;
//!   2. RMS envelope (5 ms hop) → onset (10 % of the steady RMS), attack 10→90 %, steady
//!      segment (after attack + 80 ms, until the RMS falls below 70 % of steady − 80 ms);
//!   3. pitch track: YIN (CMNDF, threshold 0.2, first dip) on a 12 kHz decimated copy,
//!      refined at the full rate around the coarse lag with parabolic interpolation, 20 ms
//!      hop, f ∈ [target/2.4, 3.5·target] (no target: 50–2000 Hz); octave-error
//!      protection against the track median;
//!   4. vibrato: largest 3–9 Hz sinusoid of the detrended cents track (least squares);
//!      accepted if its amplitude ≥ 4 ¢ and it explains ≥ 30 % of the variance; removed
//!      before `pitch_std`;
//!   5. spectrum: Hann-windowed FFT of up to 0.75 s of the steady part; harmonic k level =
//!      energy in ±min(max(2 bins, 1.5 % k f0), f0/4) around the local peak near k f0; HNR = harmonic
//!      energy / remaining energy (50 Hz – min(8 kHz, Nyquist)); edge = 2–5 kHz energy re
//!      the 50 Hz – Nyquist total; subharmonic energy at (k + ½) f0, k = 0…4, re H1.
//!
//! Feature layout (append only) — see `idx` below and COACHING.md.

use core::f64::consts::PI;

pub const FEATURE_LEN: usize = 30;

pub mod idx {
    pub const F0: usize = 0;
    pub const CENTS: usize = 1;
    pub const PITCH_STD: usize = 2;
    pub const VIB_RATE: usize = 3;
    pub const VIB_DEPTH: usize = 4;
    pub const LEVEL: usize = 5;
    pub const CENTROID_REL: usize = 6;
    pub const H1: usize = 7; // … H10 = 16
    pub const ODD_EVEN: usize = 17;
    pub const TILT: usize = 18;
    pub const HNR: usize = 19;
    pub const EDGE: usize = 20;
    pub const ATTACK: usize = 21;
    pub const SCOOP: usize = 22;
    pub const SUBHARM: usize = 23;
    pub const REGIME: usize = 24;
    pub const VALID: usize = 25;
    pub const RELEASE_T60: usize = 26;
    pub const TAIL_RATIO: usize = 27;
    pub const NOISE_FLOOR: usize = 28;
    pub const RELEASE_CLEAN: usize = 29;
}

/// JSON field names, in index order (H1..H10 expanded).
pub const FEATURE_NAMES: [&str; FEATURE_LEN] = [
    "f0", "cents", "pitch_std", "vib_rate", "vib_depth", "level", "centroid_rel", "H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8",
    "H9", "H10", "odd_even", "tilt", "hnr", "edge", "attack", "scoop", "subharm", "regime", "valid", "release_t60", "tail_ratio",
    "noise_floor", "release_clean",
];

const FLOOR_DB: f64 = -120.0;

fn db(x: f64) -> f64 {
    if x > 0.0 {
        (10.0 * x.log10()).max(FLOOR_DB)
    } else {
        FLOOR_DB
    }
}

// ---------------------------------------------------------------- filters

struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    fn highpass(fc: f64, sr: f64, q: f64) -> Biquad {
        let w = 2.0 * PI * fc / sr;
        let (s, c) = (w.sin(), w.cos());
        let al = s / (2.0 * q);
        let a0 = 1.0 + al;
        Biquad { b0: (1.0 + c) / 2.0 / a0, b1: -(1.0 + c) / a0, b2: (1.0 + c) / 2.0 / a0, a1: -2.0 * c / a0, a2: (1.0 - al) / a0 }
    }
    fn notch(fc: f64, sr: f64, q: f64) -> Biquad {
        let w = 2.0 * PI * fc / sr;
        let (s, c) = (w.sin(), w.cos());
        let al = s / (2.0 * q);
        let a0 = 1.0 + al;
        Biquad { b0: 1.0 / a0, b1: -2.0 * c / a0, b2: 1.0 / a0, a1: -2.0 * c / a0, a2: (1.0 - al) / a0 }
    }
    fn run(&self, x: &mut [f64]) {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for v in x.iter_mut() {
            let y = self.b0 * *v + self.b1 * x1 + self.b2 * x2 - self.a1 * y1 - self.a2 * y2;
            x2 = x1;
            x1 = *v;
            y2 = y1;
            y1 = y;
            *v = y;
        }
    }
}

// ---------------------------------------------------------------- FFT

/// In-place iterative radix-2 complex FFT (n power of two).
pub fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let mut i = 0;
        while i < n {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (a, b) = (i + k, i + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let t = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = t;
            }
            i += len;
        }
        len <<= 1;
    }
}

// ---------------------------------------------------------------- envelope

/// RMS envelope with hop `hop` samples (window = 2 hops).
fn envelope(x: &[f64], hop: usize) -> Vec<f64> {
    let n = x.len() / hop;
    let mut e = Vec::with_capacity(n);
    for f in 0..n {
        let a = (f * hop).saturating_sub(hop / 2);
        let b = (a + 2 * hop).min(x.len());
        let s: f64 = x[a..b].iter().map(|v| v * v).sum();
        e.push((s / (b - a).max(1) as f64).sqrt());
    }
    e
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

/// Onset / steady / release segmentation of a single note.
#[derive(Clone, Copy, Debug, Default)]
pub struct Segments {
    pub onset: usize,
    pub attack_end: usize,
    pub steady_start: usize,
    pub steady_end: usize,
    pub steady_rms: f64,
    pub attack_ms: f64,
}

fn segment_note(x: &[f64], sr: f64) -> Option<Segments> {
    let hop = ((sr * 0.005) as usize).max(1);
    let env = envelope(x, hop);
    if env.is_empty() {
        return None;
    }
    let peak = env.iter().cloned().fold(0.0, f64::max);
    if peak <= 1e-9 {
        return None;
    }
    // steady RMS: median of the frames above half the peak
    let mut loud: Vec<f64> = env.iter().cloned().filter(|v| *v > 0.5 * peak).collect();
    let steady = median(&mut loud);
    let first_loud = env.iter().position(|v| *v >= 0.7 * steady)?;
    // onset: last frame before the first loud one that is below 10 % of steady
    let mut on = first_loud;
    while on > 0 && env[on - 1] >= 0.1 * steady {
        on -= 1;
    }
    let mut a90 = on;
    while a90 < env.len() && env[a90] < 0.9 * steady {
        a90 += 1;
    }
    // sub-frame interpolation of the 10 % and 90 % crossings
    let cross = |i: usize, lvl: f64| -> f64 {
        if i == 0 || i >= env.len() {
            return i as f64;
        }
        let (a, b) = (env[i - 1], env[i]);
        if b <= a {
            i as f64
        } else {
            (i - 1) as f64 + ((lvl - a) / (b - a)).clamp(0.0, 1.0)
        }
    };
    let t10 = cross(on, 0.1 * steady);
    let t90 = cross(a90.min(env.len() - 1), 0.9 * steady);
    let attack_ms = ((t90 - t10).max(0.0)) * hop as f64 / sr * 1000.0;
    // release: last frame ≥ 70 % of steady
    let last = env.iter().rposition(|v| *v >= 0.7 * steady).unwrap_or(env.len() - 1);
    let guard = (0.08 * sr) as usize;
    let mut s0 = (a90 * hop + guard).min(x.len());
    let mut s1 = (last * hop).saturating_sub(guard);
    if s1 <= s0 + (0.15 * sr) as usize {
        // short note: middle half of the active region
        let a = on * hop;
        let b = (last + 1) * hop;
        s0 = a + (b - a) / 4;
        s1 = (a + 3 * (b - a) / 4).min(x.len());
    }
    if s1 <= s0 + 64 {
        return None;
    }
    Some(Segments { onset: (t10 * hop as f64) as usize, attack_end: a90 * hop, steady_start: s0, steady_end: s1, steady_rms: steady, attack_ms })
}

// ---------------------------------------------------------------- pitch

struct PitchTrack {
    /// (sample index of frame centre, f0 Hz or 0, aperiodicity)
    frames: Vec<(usize, f64, f64)>,
}

/// YIN cumulative-mean-normalised difference on `x` for lags 1..=maxlag.
fn cmndf(x: &[f64], w: usize, maxlag: usize, out: &mut Vec<f64>) {
    out.clear();
    out.push(1.0);
    let mut run = 0.0;
    for tau in 1..=maxlag {
        let mut d = 0.0;
        for j in 0..w {
            let e = x[j] - x[j + tau];
            d += e * e;
        }
        run += d;
        out.push(if run > 0.0 { d * tau as f64 / run } else { 1.0 });
    }
}

fn track_pitch(x: &[f64], sr: f64, a: usize, b: usize, fmin: f64, fmax: f64) -> PitchTrack {
    // 12 kHz decimated copy (windowed-sinc low-pass at 4.5 kHz)
    let dec = ((sr / 12000.0).round() as usize).max(1);
    let srd = sr / dec as f64;
    let xd: Vec<f64> = if dec > 1 {
        let taps = 8 * dec + 1;
        let mid = (taps / 2) as isize;
        let fc = 4500.0 / sr;
        let h: Vec<f64> = (0..taps)
            .map(|k| {
                let m = k as isize - mid;
                let s = if m == 0 { 2.0 * fc } else { (2.0 * PI * fc * m as f64).sin() / (PI * m as f64) };
                s * (0.5 - 0.5 * (2.0 * PI * k as f64 / (taps - 1) as f64).cos())
            })
            .collect();
        let hs: f64 = h.iter().sum();
        let n = x.len() / dec;
        (0..n)
            .map(|i| {
                let c = (i * dec) as isize;
                let mut s = 0.0;
                for (k, hk) in h.iter().enumerate() {
                    let j = c + k as isize - mid;
                    if j >= 0 && (j as usize) < x.len() {
                        s += hk * x[j as usize];
                    }
                }
                s / hs
            })
            .collect()
    } else {
        x.to_vec()
    };
    let maxlag = ((srd / fmin).ceil() as usize).max(4);
    let minlag = ((srd / fmax).floor() as usize).max(2);
    let w = (maxlag as f64 * 1.2) as usize + 2;
    let hop = (0.02 * sr) as usize;
    let mut frames = Vec::new();
    let mut d = Vec::with_capacity(maxlag + 1);
    let mut c = a;
    while c + 1 < b {
        let cd = c / dec;
        let start = cd.saturating_sub(w / 2 + maxlag / 2);
        if start + w + maxlag + 1 > xd.len() {
            if c + hop >= b {
                break;
            }
            c += hop;
            continue;
        }
        cmndf(&xd[start..], w, maxlag, &mut d);
        // first dip below threshold, else the global minimum
        let mut best = 0;
        for t in minlag..maxlag {
            if d[t] < 0.2 {
                let mut tt = t;
                while tt + 1 < maxlag && d[tt + 1] < d[tt] {
                    tt += 1;
                }
                best = tt;
                break;
            }
        }
        if best == 0 {
            let mut m = f64::MAX;
            for t in minlag..maxlag {
                if d[t] < m {
                    m = d[t];
                    best = t;
                }
            }
        }
        let ap = d[best];
        // refine at full rate around best·dec
        let f = refine(x, c, best * dec, dec, sr);
        frames.push((c, if ap < 0.45 { f } else { 0.0 }, ap));
        c += hop;
    }
    // octave-error protection: snap frames at ≈2× or ½× the median
    let mut fs: Vec<f64> = frames.iter().map(|f| f.1).filter(|v| *v > 0.0).collect();
    let med = median(&mut fs);
    if med > 0.0 {
        for fr in frames.iter_mut() {
            if fr.1 > 0.0 {
                let r = fr.1 / med;
                if (r - 2.0).abs() < 0.1 || (r - 0.5).abs() < 0.05 {
                    // re-estimate at the median-consistent lag
                    let lag = (sr / med).round() as usize;
                    fr.1 = refine(x, fr.0, lag, 2, sr);
                }
            }
        }
    }
    PitchTrack { frames }
}

/// Full-rate difference function around `lag0` (± `span`) on a window of ~3 periods
/// centred at `c`; parabolic interpolation of the minimum. Returns Hz.
fn refine(x: &[f64], c: usize, lag0: usize, span: usize, sr: f64) -> f64 {
    let lag0 = lag0.max(2);
    let w = (3 * lag0).max(64);
    let lo = lag0.saturating_sub(span + 1).max(1);
    let hi = lag0 + span + 1;
    let start = c.saturating_sub(w / 2);
    if start + w + hi + 1 > x.len() {
        return sr / lag0 as f64;
    }
    let dfun = |tau: usize| -> f64 {
        let mut d = 0.0;
        for j in start..start + w {
            let e = x[j] - x[j + tau];
            d += e * e;
        }
        d
    };
    let mut best = lo;
    let mut bv = f64::MAX;
    let mut vals = Vec::with_capacity(hi - lo + 1);
    for t in lo..=hi {
        let v = dfun(t);
        vals.push(v);
        if v < bv {
            bv = v;
            best = t;
        }
    }
    let i = best - lo;
    let mut lag = best as f64;
    if i > 0 && i + 1 < vals.len() {
        let (y0, y1, y2) = (vals[i - 1], vals[i], vals[i + 1]);
        let den = y0 - 2.0 * y1 + y2;
        if den > 0.0 {
            lag += (0.5 * (y0 - y2) / den).clamp(-1.0, 1.0);
        }
    }
    sr / lag
}

// ---------------------------------------------------------------- analysis

/// Analyse a mono single-note buffer. `target_hz` = expected sounding pitch of the
/// fingering at the user's reference (≤ 0: unknown → `cents` and `regime` relative to the
/// measured pitch, i.e. 0 and 1).
pub fn analyze(input: &[f32], sr: f32, target_hz: f32) -> [f32; FEATURE_LEN] {
    analyze_with(input, sr, target_hz, &AnalysisConfig::default())
}

/// `analyze` with an explicit configuration.
pub fn analyze_with(input: &[f32], sr: f32, target_hz: f32, cfg: &AnalysisConfig) -> [f32; FEATURE_LEN] {
    let mut out = [0.0f32; FEATURE_LEN];
    for k in 0..10 {
        out[idx::H1 + k] = FLOOR_DB as f32;
    }
    out[idx::SUBHARM] = FLOOR_DB as f32;
    out[idx::LEVEL] = FLOOR_DB as f32;
    out[idx::REGIME] = 1.0;
    out[idx::RELEASE_T60] = -1.0;
    out[idx::TAIL_RATIO] = FLOOR_DB as f32;
    out[idx::NOISE_FLOOR] = FLOOR_DB as f32;
    let sr = sr as f64;
    if !(sr > 1000.0) || input.len() < (0.1 * sr) as usize {
        return out;
    }
    let target = target_hz as f64;
    // 1. conditioning
    let mut x: Vec<f64> = input.iter().map(|v| if v.is_finite() { *v as f64 } else { 0.0 }).collect();
    Biquad::highpass(40.0, sr, 0.707).run(&mut x);
    // (the release-tail analysis uses the signal before the hum notches: their
    // high-Q ring-down after an abrupt stop would read as reverberation)
    let x_hp = x.clone();
    Biquad::notch(50.0, sr, 8.0).run(&mut x);
    Biquad::notch(60.0, sr, 8.0).run(&mut x);
    // 2. segmentation
    let Some(seg) = segment_note(&x, sr) else { return out };
    out[idx::ATTACK] = seg.attack_ms as f32;
    let fill_release = |out: &mut [f32; FEATURE_LEN], f0: f64| {
        let rel = release_info(&x_hp, sr, &seg, f0, cfg);
        out[idx::RELEASE_T60] = rel.t60 as f32;
        out[idx::TAIL_RATIO] = rel.tail_ratio as f32;
        out[idx::NOISE_FLOOR] = rel.noise_floor as f32;
        out[idx::RELEASE_CLEAN] = if rel.clean { 1.0 } else { 0.0 };
    };
    let steady = &x[seg.steady_start..seg.steady_end];
    let rms = (steady.iter().map(|v| v * v).sum::<f64>() / steady.len() as f64).sqrt();
    out[idx::LEVEL] = (20.0 * rms.max(1e-12).log10()).max(FLOOR_DB) as f32;
    // 3. pitch track over onset … steady end
    let (fmin, fmax) = if target > 0.0 { ((target / 2.4).max(40.0), (target * 3.5).min(0.45 * sr).min(4000.0)) } else { (50.0, 2000.0) };
    let tr = track_pitch(&x, sr, seg.onset, seg.steady_end, fmin, fmax);
    let mut st: Vec<(f64, f64)> = tr
        .frames
        .iter()
        .filter(|f| f.0 >= seg.steady_start && f.0 < seg.steady_end && f.1 > 0.0)
        .map(|f| (f.0 as f64 / sr, f.1))
        .collect();
    let n_steady = tr.frames.iter().filter(|f| f.0 >= seg.steady_start && f.0 < seg.steady_end).count();
    let mut fv: Vec<f64> = st.iter().map(|v| v.1).collect();
    let f0 = median(&mut fv);
    let valid = f0 > 0.0 && st.len() * 2 >= n_steady.max(1) && st.len() >= 3;
    if !valid {
        out[idx::VALID] = 0.0;
        fill_release(&mut out, 0.0);
        return out;
    }
    fill_release(&mut out, f0);
    // drop outliers (> 100 ¢ from the median) from the stability analysis
    st.retain(|v| (1200.0 * (v.1 / f0).log2()).abs() < 100.0);
    out[idx::F0] = f0 as f32;
    out[idx::VALID] = 1.0;
    // regime & cents
    let (regime, cents) = if target > 0.0 {
        let r = f0 / target;
        let reg = if (1200.0 * r.log2()).abs() < 300.0 {
            1.0
        } else if r >= 0.4 {
            (r * 2.0).round() / 2.0
        } else {
            1.0 / (1.0 / r).round()
        };
        let reg = if reg <= 0.0 { r } else { reg };
        (reg, 1200.0 * (f0 / (target * reg)).log2())
    } else {
        (1.0, 0.0)
    };
    out[idx::REGIME] = regime as f32;
    out[idx::CENTS] = cents as f32;
    // 4. vibrato & stability on the cents track (detrended)
    let cv: Vec<(f64, f64)> = st.iter().map(|v| (v.0, 1200.0 * (v.1 / f0).log2())).collect();
    let n = cv.len() as f64;
    let (mt, mc) = (cv.iter().map(|v| v.0).sum::<f64>() / n, cv.iter().map(|v| v.1).sum::<f64>() / n);
    let stt = cv.iter().map(|v| (v.0 - mt).powi(2)).sum::<f64>();
    let slope = if stt > 0.0 { cv.iter().map(|v| (v.0 - mt) * (v.1 - mc)).sum::<f64>() / stt } else { 0.0 };
    let mut res: Vec<f64> = cv.iter().map(|v| v.1 - mc - slope * (v.0 - mt)).collect();
    let var0 = res.iter().map(|v| v * v).sum::<f64>() / n;
    let dur = cv.last().map(|v| v.0).unwrap_or(0.0) - cv.first().map(|v| v.0).unwrap_or(0.0);
    let mut vib = (0.0, 0.0, 0.0, 0.0); // rate, amplitude, a, b
    if cv.len() >= 12 && dur > 0.4 {
        let mut best = (0.0, 0.0, 0.0, 0.0, 0.0); // power explained, rate, amp, a, b
        let mut f = 3.0;
        while f <= 9.0 {
            let w = 2.0 * PI * f;
            // least-squares a·sin + b·cos
            let (mut ss, mut cc, mut sc, mut ys, mut yc) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for (k, r) in res.iter().enumerate() {
                let t = cv[k].0;
                let (s, c) = ((w * t).sin(), (w * t).cos());
                ss += s * s;
                cc += c * c;
                sc += s * c;
                ys += r * s;
                yc += r * c;
            }
            let det = ss * cc - sc * sc;
            if det.abs() > 1e-12 {
                let a = (ys * cc - yc * sc) / det;
                let b = (yc * ss - ys * sc) / det;
                let expl = a * ys + b * yc;
                if expl > best.0 {
                    best = (expl, f, (a * a + b * b).sqrt(), a, b);
                }
            }
            f += 0.05;
        }
        if best.2 >= 4.0 && best.0 / n >= 0.3 * var0 {
            vib = (best.1, best.2, best.3, best.4);
        }
    }
    if vib.1 > 0.0 {
        let w = 2.0 * PI * vib.0;
        for (k, r) in res.iter_mut().enumerate() {
            let t = cv[k].0;
            *r -= vib.2 * (w * t).sin() + vib.3 * (w * t).cos();
        }
    }
    out[idx::VIB_RATE] = vib.0 as f32;
    out[idx::VIB_DEPTH] = vib.1 as f32;
    out[idx::PITCH_STD] = (res.iter().map(|v| v * v).sum::<f64>() / n).sqrt() as f32;
    // scoop: mean deviation over the first 100 ms after onset
    let on_t = seg.onset as f64 / sr;
    let sc: Vec<f64> = tr
        .frames
        .iter()
        .filter(|f| f.1 > 0.0 && (f.0 as f64 / sr) >= on_t && (f.0 as f64 / sr) < on_t + 0.1)
        .map(|f| 1200.0 * (f.1 / f0).log2())
        .filter(|c| c.abs() < 600.0)
        .collect();
    out[idx::SCOOP] = if sc.is_empty() { 0.0 } else { (sc.iter().sum::<f64>() / sc.len() as f64) as f32 };
    // 5. spectrum of (up to 0.75 s of) the steady part
    let maxn = (0.75 * sr) as usize;
    let len = steady.len().min(maxn);
    let off = (steady.len() - len) / 2;
    let seg_x = &steady[off..off + len];
    let mut nfft = 1;
    while nfft < len {
        nfft <<= 1;
    }
    let mut re = vec![0.0; nfft];
    let mut im = vec![0.0; nfft];
    for (k, v) in seg_x.iter().enumerate() {
        re[k] = v * (0.5 - 0.5 * (2.0 * PI * k as f64 / (len - 1).max(1) as f64).cos());
    }
    fft(&mut re, &mut im);
    let half = nfft / 2;
    let pw: Vec<f64> = (0..half).map(|k| re[k] * re[k] + im[k] * im[k]).collect();
    let bin = sr / nfft as f64;
    let band = |lo: f64, hi: f64| -> f64 {
        let a = ((lo / bin).ceil() as usize).min(half);
        let b = ((hi / bin).floor() as usize).min(half - 1);
        if b < a {
            0.0
        } else {
            pw[a..=b].iter().sum()
        }
    };
    let f_hi = (8000.0f64).min(0.5 * sr * 0.98);
    let mut harm_e = [0.0f64; 41];
    let mut harm_mask_e = 0.0;
    let kmax = ((f_hi / f0).floor() as usize).min(40);
    for k in 1..=kmax {
        let fk = k as f64 * f0;
        // half-width: ±1.5 % of k·f0 (≥ 2 bins) but never more than f0/4, so the
        // harmonic bands never overlap and the inter-harmonic noise is kept
        let hw = (0.015 * fk).max(2.0 * bin).min(0.25 * f0);
        // local peak near k·f0 (±3 %)
        let sw = (0.03 * fk).min(0.2 * f0);
        let a = (((fk - sw) / bin) as usize).max(1);
        let b = (((fk + sw) / bin).ceil() as usize).min(half - 1);
        let mut pk = (fk / bin).round() as usize;
        let mut pv = 0.0;
        for i in a..=b {
            if pw[i] > pv {
                pv = pw[i];
                pk = i;
            }
        }
        let c = pk as f64 * bin;
        let e = band(c - hw, c + hw);
        harm_e[k] = e;
        harm_mask_e += e;
    }
    let h1 = harm_e[1].max(1e-30);
    for k in 1..=10 {
        out[idx::H1 + k - 1] = if k <= kmax { (db(harm_e[k] / h1)) as f32 } else { FLOOR_DB as f32 };
    }
    out[idx::H1] = 0.0;
    // centroid in harmonic numbers, amplitude-weighted, up to 8 kHz
    let (mut num, mut den) = (0.0, 0.0);
    for k in 1..=kmax {
        let a = harm_e[k].sqrt();
        num += k as f64 * a;
        den += a;
    }
    out[idx::CENTROID_REL] = if den > 0.0 { (num / den) as f32 } else { 0.0 };
    let hs: [f64; 10] = core::array::from_fn(|k| out[idx::H1 + k] as f64);
    let hk = |k: usize| hs[k - 1];
    let odd: Vec<f64> = [3, 5, 7, 9].iter().filter(|&&k| k <= kmax).map(|&k| hk(k)).collect();
    let even: Vec<f64> = [2, 4, 6, 8, 10].iter().filter(|&&k| k <= kmax).map(|&k| hk(k)).collect();
    out[idx::ODD_EVEN] = if !odd.is_empty() && !even.is_empty() {
        (odd.iter().sum::<f64>() / odd.len() as f64 - even.iter().sum::<f64>() / even.len() as f64) as f32
    } else {
        0.0
    };
    // tilt: LS slope of H_k (dB) vs log2 k, k = 1..min(10, kmax)
    // (harmonics below −90 dB re H1 — absent — are excluded)
    let ks: Vec<usize> = (1..=kmax.min(10)).filter(|&k| hk(k) > -90.0).collect();
    let km = ks.len();
    if km >= 2 {
        let xs: Vec<f64> = ks.iter().map(|&k| (k as f64).log2()).collect();
        let ys: Vec<f64> = ks.iter().map(|&k| hk(k)).collect();
        let mx = xs.iter().sum::<f64>() / km as f64;
        let my = ys.iter().sum::<f64>() / km as f64;
        let sxx: f64 = xs.iter().map(|x| (x - mx).powi(2)).sum();
        let sxy: f64 = xs.iter().zip(ys.iter()).map(|(x, y)| (x - mx) * (y - my)).sum();
        out[idx::TILT] = if sxx > 0.0 { (sxy / sxx) as f32 } else { 0.0 };
    }
    let total_h = band(50.0, f_hi);
    let noise = (total_h - harm_mask_e).max(total_h * 1e-12);
    out[idx::HNR] = (db(harm_mask_e / noise)) as f32;
    let total = band(50.0, 0.5 * sr * 0.98);
    out[idx::EDGE] = if 2000.0 < 0.5 * sr { db(band(2000.0, (5000.0f64).min(0.5 * sr * 0.98)) / total.max(1e-30)) as f32 } else { FLOOR_DB as f32 };
    // subharmonic / multiphonic energy at (k + ½)·f0
    let mut sub = 0.0;
    for k in 0..5 {
        let fk = (k as f64 + 0.5) * f0;
        if fk < f_hi {
            let hw = (0.015 * fk).max(2.0 * bin).min(0.25 * f0);
            sub += band(fk - hw, fk + hw);
        }
    }
    out[idx::SUBHARM] = db(sub / h1) as f32;
    out
}

// ---------------------------------------------------------------- release / room

/// Release-tail measurements of one note (all levels in dB re the steady level).
#[derive(Clone, Copy, Debug)]
pub struct ReleaseInfo {
    /// reverberation time from the decay slope of the tail (s); −1 if not measurable
    pub t60: f64,
    /// mean power 50–300 ms after the release re steady power (dB)
    pub tail_ratio: f64,
    /// quietest 50 ms of the buffer re steady (dB)
    pub noise_floor: f64,
    /// abrupt (tongued/stopped) release rather than a fade-out
    pub clean: bool,
    /// reverberant level extrapolated back to the release instant (dB re steady),
    /// used for the direct-to-reverberant estimate; NaN if not measurable
    pub reverb_level: f64,
}

/// Minimum delay after the −6 dB point of the release before the tail is fitted.
const TAIL_SKIP: f64 = 0.05;
/// The air column keeps ringing at the played resonance after the reed stops:
/// T60_inst ≈ INST_T60_HZ / f0 (Q ≈ 40–50; Bb3 ≈ 0.7 s, G4 ≈ 0.4 s, C6 ≈ 0.13 s;
/// configurable, see `AnalysisConfig`). 95 Hz·s is the recommended real-alto value and,
/// since the bore wall-loss factor ×1.3 (round 7), also the simulator's own free decay
/// (it was 120 with smooth-wall losses). A tail decaying no slower than
/// INST_MARGIN·T60_inst is indistinguishable from that ring-down: no room
/// decay is reported for it.
pub const INST_T60_HZ: f64 = 95.0;
/// Value for real alto recordings (Q ≈ 40–50) — now equal to the default.
pub const INST_T60_HZ_REAL: f64 = 95.0;
pub const INST_MARGIN: f64 = 1.3;

/// Analysis configuration (passed explicitly; the only global copy lives at the
/// ABI layer, `sax_analysis_config`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnalysisConfig {
    /// instrument ring-down constant T60_inst·f0 (Hz·s): 95 (simulator and real alto)
    pub inst_t60_hz: f64,
}

impl Default for AnalysisConfig {
    fn default() -> Self {
        AnalysisConfig { inst_t60_hz: INST_T60_HZ }
    }
}

impl AnalysisConfig {
    /// Config with the given ring-down constant (≤ 0 or non-finite → default).
    pub fn with_inst_t60(v: f64) -> Self {
        AnalysisConfig { inst_t60_hz: if v > 0.0 && v.is_finite() { v } else { INST_T60_HZ } }
    }
}

fn release_info(x: &[f64], sr: f64, seg: &Segments, f0: f64, cfg: &AnalysisConfig) -> ReleaseInfo {
    let mut info = ReleaseInfo { t60: -1.0, tail_ratio: FLOOR_DB, noise_floor: FLOOR_DB, clean: false, reverb_level: f64::NAN };
    let hop = ((sr * 0.005) as usize).max(1);
    let env = envelope(x, hop);
    let fr = sr / hop as f64; // frames per second
    let steady_p = (seg.steady_rms * seg.steady_rms).max(1e-30);
    let pdb = |i: usize| 10.0 * (env[i] * env[i] / steady_p).max(1e-15).log10();
    // noise floor: quietest 50 ms (moving average of power)
    let w = ((0.05 * fr) as usize).max(1);
    if env.len() > w {
        let mut acc: f64 = env[..w].iter().map(|v| v * v).sum();
        let mut mn = acc;
        for i in w..env.len() {
            acc += env[i] * env[i] - env[i - w] * env[i - w];
            mn = mn.min(acc);
        }
        info.noise_floor = (10.0 * ((mn / w as f64).max(1e-30) / steady_p).log10()).max(FLOOR_DB);
    }
    let noise_p = 10f64.powf(info.noise_floor / 10.0) * steady_p;
    // release: last frame ≥ 70 % of steady, then the −6 dB crossing
    let Some(last) = env.iter().rposition(|v| *v >= 0.7 * seg.steady_rms) else { return info };
    let Some(tr) = (last..env.len()).find(|&i| env[i] < 0.5 * seg.steady_rms) else { return info };
    // clean (abrupt) release: no fade during the 300 ms before, and a fast drop
    let pre_a = last.saturating_sub((0.30 * fr) as usize);
    let pre_b = last.saturating_sub((0.05 * fr) as usize);
    let fade = if pre_b > pre_a + 4 {
        let n = (pre_b - pre_a) as f64;
        let ts: Vec<f64> = (pre_a..pre_b).map(|i| i as f64 / fr).collect();
        let ys: Vec<f64> = (pre_a..pre_b).map(pdb).collect();
        let (mt, my) = (ts.iter().sum::<f64>() / n, ys.iter().sum::<f64>() / n);
        let sxx: f64 = ts.iter().map(|t| (t - mt).powi(2)).sum();
        let sxy: f64 = ts.iter().zip(ys.iter()).map(|(t, y)| (t - mt) * (y - my)).sum();
        if sxx > 0.0 { sxy / sxx * 0.25 } else { 0.0 }
    } else {
        0.0
    };
    let fall_ms = (tr - last) as f64 / fr * 1000.0;
    info.clean = fade > -6.0 && fall_ms <= 40.0;
    // tail ratio 50–300 ms after the release
    let a = tr + (TAIL_SKIP * fr) as usize;
    let b = (tr + (0.30 * fr) as usize).min(env.len());
    if b > a + 2 {
        let p: f64 = env[a..b].iter().map(|v| v * v).sum::<f64>() / (b - a) as f64;
        info.tail_ratio = (10.0 * (p / steady_p).max(1e-15).log10()).max(FLOOR_DB);
    }
    // decay fit: Schroeder backward integral of (power − noise) on the tail, from
    // when the instrument's own ring-down has fallen ≳ 30 dB (≤ 0.3 s)
    let t_inst = if f0 > 0.0 { cfg.inst_t60_hz / f0 } else { 0.3 };
    let a = tr + ((0.5 * t_inst).clamp(TAIL_SKIP, 0.3) * fr) as usize;
    if a + 4 >= env.len() {
        return info;
    }
    let lim = (tr + (2.5 * fr) as usize).min(env.len());
    // tail end: first frame (after a) within 8 dB of the noise floor
    let end = (a..lim).find(|&i| env[i] * env[i] < noise_p * 10f64.powf(0.8)).unwrap_or(lim);
    if end < a + (0.06 * fr) as usize {
        return info;
    }
    let pw: Vec<f64> = env[a..end].iter().map(|v| (v * v - noise_p).max(0.0)).collect();
    let mut edc = vec![0.0; pw.len()];
    let mut acc = 0.0;
    for i in (0..pw.len()).rev() {
        acc += pw[i];
        edc[i] = acc;
    }
    let e0 = edc[0].max(1e-30);
    let edb: Vec<f64> = edc.iter().map(|v| 10.0 * (v / e0).max(1e-15).log10()).collect();
    let range = edb.iter().cloned().fold(0.0, f64::min);
    let stop = (-20.0f64).max(range + 3.0);
    if stop > -6.0 {
        return info; // < ~9 dB of usable decay
    }
    let pts: Vec<(f64, f64)> = edb.iter().enumerate().take_while(|(_, v)| **v >= stop).map(|(i, v)| (i as f64 / fr, *v)).collect();
    if pts.len() < 6 {
        return info;
    }
    let n = pts.len() as f64;
    let (mt, my) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n);
    let sxx: f64 = pts.iter().map(|p| (p.0 - mt).powi(2)).sum();
    let sxy: f64 = pts.iter().map(|p| (p.0 - mt) * (p.1 - my)).sum();
    let slope = if sxx > 0.0 { sxy / sxx } else { 0.0 };
    if slope < -1.0 && -60.0 / slope > INST_MARGIN * t_inst {
        info.t60 = (-60.0 / slope).min(10.0);
        // reverberant level at the release instant: tail power at a (dB re steady)
        // extrapolated back by TAIL_SKIP along the fitted decay
        let p_a: f64 = pw[..pw.len().min(3)].iter().sum::<f64>() / pw.len().min(3) as f64;
        info.reverb_level = 10.0 * (p_a / steady_p).max(1e-15).log10() - slope * ((a - tr) as f64 / fr);
    }
    info
}

/// Recording-level room summary (`sax_room`).
#[derive(Clone, Copy, Debug, Default)]
pub struct RoomSummary {
    pub rt60: f64,
    pub rt60_spread: f64,
    pub drr: f64,
    pub noise_floor: f64,
    pub n_tails: usize,
    pub confidence: f64,
    /// 0 dry, 1 some room, 2 too reverberant, 3 uncertain
    pub verdict: u32,
    /// RT60 from a clap / impulsive transient (−1 if none found)
    pub clap_rt60: f64,
    /// median tail_ratio of the clean releases (dB re steady)
    pub tail_ratio: f64,
}

/// `sax_room` output: [rt60, rt60_spread, drr, noise_floor, n_tails, confidence,
/// verdict, clap_rt60, tail_ratio]
pub const ROOM_LEN: usize = 9;

impl RoomSummary {
    pub fn to_array(&self) -> [f32; ROOM_LEN] {
        [
            self.rt60 as f32,
            self.rt60_spread as f32,
            self.drr as f32,
            self.noise_floor as f32,
            self.n_tails as f32,
            self.confidence as f32,
            self.verdict as f32,
            self.clap_rt60 as f32,
            self.tail_ratio as f32,
        ]
    }
}

/// Verdict thresholds (validated with `examples/roomtest.rs`, see COACHING.md).
pub const DRY_RT60: f64 = 0.25;
pub const DRY_DRR: f64 = 6.0;
pub const WET_RT60: f64 = 0.6;
pub const WET_DRR: f64 = -2.0;

fn median_of(mut v: Vec<f64>) -> f64 {
    median(&mut v)
}

/// Combine all release tails of a recording (robust median) plus an optional clap.
pub fn room(input: &[f32], sr: f32) -> RoomSummary {
    room_with(input, sr, &AnalysisConfig::default())
}

/// `room` with an explicit configuration.
pub fn room_with(input: &[f32], sr: f32, cfg: &AnalysisConfig) -> RoomSummary {
    let mut out = RoomSummary { rt60: -1.0, rt60_spread: -1.0, drr: FLOOR_DB, noise_floor: FLOOR_DB, n_tails: 0, confidence: 0.0, verdict: 3, clap_rt60: -1.0, tail_ratio: FLOOR_DB };
    let srf = sr as f64;
    let segs = segment(input, sr);
    let mut x: Vec<f64> = input.iter().map(|v| if v.is_finite() { *v as f64 } else { 0.0 }).collect();
    Biquad::highpass(40.0, srf, 0.707).run(&mut x);
    let (mut t60s, mut drrs, mut tails, mut floors) = (vec![], vec![], vec![], vec![]);
    let mut n_clean = 0usize;
    for (k, &(a, e)) in segs.iter().enumerate() {
        if e - a < (0.5 * srf) as usize {
            continue; // claps, clicks, short blips: no steady part
        }
        let b = segs.get(k + 1).map(|s| s.0).unwrap_or(x.len());
        let sub = &x[a..b];
        let Some(sg) = segment_note(sub, srf) else { continue };
        // f0 from 0.5 s at the centre of the steady part (cheap)
        let mid = (sg.steady_start + sg.steady_end) / 2;
        let half = ((0.25 * srf) as usize).min((sg.steady_end - sg.steady_start) / 2);
        let tr = track_pitch(sub, srf, mid - half, mid + half, 60.0, 2000.0);
        let mut fs: Vec<f64> = tr.frames.iter().map(|f| f.1).filter(|v| *v > 0.0).collect();
        let f0 = median(&mut fs);
        let ri = release_info(sub, srf, &sg, f0, cfg);
        floors.push(ri.noise_floor);
        if ri.clean {
            tails.push(ri.tail_ratio);
            n_clean += 1;
        }
        if ri.clean && ri.t60 > 0.0 {
            t60s.push(ri.t60);
            if ri.reverb_level.is_finite() {
                let r = 10f64.powf(ri.reverb_level / 10.0);
                drrs.push(if r < 0.999 { 10.0 * ((1.0 - r) / r).log10() } else { -15.0 });
            }
        }
    }
    // noise floor re the loudest note: quietest 50 ms of the whole file
    {
        let hop = ((srf * 0.01) as usize).max(1);
        let env = envelope(&x, hop);
        if env.len() > 5 {
            let mut p: Vec<f64> = env.windows(5).map(|w| w.iter().map(|v| v * v).sum::<f64>() / 5.0).collect();
            let mx = p.iter().cloned().fold(0.0, f64::max).max(1e-30);
            let mn = p.iter().cloned().fold(f64::MAX, f64::min);
            p.clear();
            out.noise_floor = (10.0 * (mn.max(1e-30) / mx).log10()).max(FLOOR_DB);
        }
    }
    // clap: the first impulsive event, up to the end of the first sustained (≥ 0.5 s) note's
    // segment (a reverberant clap merges with the note into one segment); its decay is fitted
    // up to the note's onset
    let first_seg = segs.iter().find(|s| s.1 - s.0 >= (0.5 * srf) as usize);
    let limit = first_seg.map(|s| s.1).unwrap_or(x.len());
    let noise_rms = {
        let hop = ((srf * 0.002) as usize).max(1);
        let mut env = envelope(&x, hop);
        if env.is_empty() {
            0.0
        } else {
            let k = env.len() / 20;
            env.select_nth_unstable_by(k, |a, b| a.partial_cmp(b).unwrap());
            env[k]
        }
    };
    let clap = clap_estimate(&x, srf, limit, noise_rms);
    out.clap_rt60 = clap.as_ref().map(|c| c.rt60).unwrap_or(-1.0);
    out.n_tails = t60s.len();
    let usable_tail = tails.iter().cloned().filter(|v| *v > FLOOR_DB).collect::<Vec<_>>();
    let med_tail = if usable_tail.is_empty() { FLOOR_DB } else { median_of(usable_tail) };
    let mut tail_rt60 = -1.0;
    if !t60s.is_empty() {
        let m = median_of(t60s.clone());
        let mad = median_of(t60s.iter().map(|v| (v - m).abs()).collect());
        tail_rt60 = m;
        out.rt60 = m;
        out.rt60_spread = 1.4826 * mad;
        if !drrs.is_empty() {
            out.drr = median_of(drrs);
        }
    }
    // confidence: number of tails, their agreement and the decay range above the noise
    let n_term = (out.n_tails as f64 / 3.0).min(1.0);
    let agree = if out.rt60 > 0.0 && out.rt60_spread >= 0.0 { (1.0 - out.rt60_spread / out.rt60).clamp(0.0, 1.0) } else { 0.0 };
    let snr = ((-out.noise_floor - 30.0) / 30.0).clamp(0.0, 1.0);
    out.confidence = if out.rt60 > 0.0 { n_term * (0.5 + 0.5 * agree) * (0.5 + 0.5 * snr) } else { 0.0 };
    // a clap is a direct room measurement (no instrument ring-down to separate): when its
    // decay was followed over ≥ 15 dB it is the primary estimate, the note tails only confirm
    if let Some(c) = &clap {
        let clap_conf = 0.6 + 0.3 * ((c.range_db - 15.0) / 10.0).clamp(0.0, 1.0);
        if c.range_db >= 15.0 || out.rt60 <= 0.0 {
            out.rt60 = c.rt60;
            // a single note tail's DRR cannot overrule the clap's decay
            if out.n_tails < 2 {
                out.drr = FLOOR_DB;
            }
            if tail_rt60 > 0.0 {
                let rel = (tail_rt60 - c.rt60).abs() / c.rt60;
                out.rt60_spread = (tail_rt60 - c.rt60).abs();
                // agreeing tails raise the confidence, disagreeing ones lower it a little
                out.confidence = if rel < 0.3 { clap_conf.max(out.confidence).max(0.9) } else { 0.85 * clap_conf };
            } else {
                out.rt60_spread = 0.0;
                out.confidence = clap_conf;
            }
        }
    }
    // verdict
    // clean releases whose tails never decay slower than the instrument's own ring-down
    let dry_by_tail = out.n_tails == 0 && n_clean >= 2;
    out.tail_ratio = med_tail;
    out.verdict = if out.rt60 > 0.0 && out.confidence >= 0.3 {
        if out.rt60 >= WET_RT60 || (out.drr.is_finite() && out.drr > FLOOR_DB && out.drr <= WET_DRR) {
            2
        } else if out.rt60 < DRY_RT60 || out.drr >= DRY_DRR {
            0
        } else {
            1
        }
    } else if dry_by_tail {
        out.confidence = (0.8 * (n_clean as f64 / 3.0).min(1.0)).max(out.confidence);
        0
    } else {
        3
    };
    out
}

/// Clap estimate: RT60 (s) and the decay range used by the fit (dB).
struct Clap {
    rt60: f64,
    range_db: f64,
}

/// RT60 from the first clap-like transient in `x[..limit]` (None if none).
///
/// The first impulsive event (rises within 10 ms, falls 6 dB within 30 ms, ≥ 30× the
/// noise floor) is located; its decay is followed until the next event starts (envelope
/// smoothed over 20 ms rising 6 dB above its running minimum: the first note's onset) or
/// `limit`. Schroeder backward integration of the noise-subtracted power, with the energy
/// missing after a truncated decay added back assuming the fitted exponential (Lundeby-style,
/// 3 iterations) — without it a decay cut short by the next note reads 10–20 % short.
/// Fit range −5 dB … −25 dB (or down to 3 dB above the lowest level reached, ≥ 10 dB).
fn clap_estimate(x: &[f64], sr: f64, limit: usize, noise_rms: f64) -> Option<Clap> {
    let hop = ((sr * 0.002) as usize).max(1);
    let n = limit.min(x.len()) / hop;
    if n < 20 {
        return None;
    }
    let env = envelope(&x[..n * hop], hop);
    let fr = sr / hop as f64;
    let floor = noise_rms.max(1e-9);
    let w10 = (0.01 * fr).max(1.0) as usize;
    let w30 = (0.03 * fr).max(1.0) as usize;
    // first impulsive local maximum
    let mut found = None;
    let mut i = 1;
    while i + 1 < env.len() {
        let v = env[i];
        if v >= 30.0 * floor && v >= env[i - 1] && v >= env[i + 1] {
            // the local peak of the burst (within 10 ms)
            let (pi, pv) = (i..(i + w10).min(env.len())).fold((i, v), |a, k| if env[k] > a.1 { (k, env[k]) } else { a });
            let rise_ok = pi < w10 || env[pi - w10] < 0.1 * pv;
            let fall_ok = (pi..(pi + w30 + 1).min(env.len())).any(|k| env[k] < 0.5 * pv);
            if rise_ok && fall_ok {
                found = Some((pi, pv));
                break;
            }
            // not impulsive (e.g. a note): skip past this event
            i = pi + w30;
            continue;
        }
        i += 1;
    }
    let (pi, _) = found?;
    // end of the free decay: the next event's onset (20 ms smoothed power +6 dB over its minimum)
    let a = pi + (0.005 * fr) as usize;
    let w20 = (0.02 * fr).max(1.0) as usize;
    let mut end = env.len();
    let mut run_min = f64::MAX;
    let mut k = a;
    while k + w20 <= env.len() {
        let pw = env[k..k + w20].iter().map(|v| v * v).sum::<f64>() / w20 as f64;
        if pw > 4.0 * run_min && pw > 16.0 * floor * floor {
            end = k;
            break;
        }
        run_min = run_min.min(pw);
        k += 1;
    }
    if end < a + (0.05 * fr) as usize {
        return None;
    }
    let np = floor * floor;
    let pw: Vec<f64> = env[a..end].iter().map(|v| (v * v - np).max(0.0)).collect();
    let fit = |edc: &[f64]| -> Option<(f64, f64)> {
        let e0 = edc[0].max(1e-30);
        let lv: Vec<f64> = edc.iter().map(|v| 10.0 * (v / e0).max(1e-15).log10()).collect();
        // lowest level the direct (non-extrapolated) data reaches reliably
        let lo = (-25.0f64).max(lv[lv.len().saturating_sub(1).max(0)] + 3.0);
        if lo > -15.0 {
            return None;
        }
        let pts: Vec<(f64, f64)> = lv.iter().enumerate().map(|(i, v)| (i as f64 / fr, *v)).filter(|p| p.1 <= -5.0 && p.1 >= lo).collect();
        if pts.len() < 6 {
            return None;
        }
        let m = pts.len() as f64;
        let (mt, my) = (pts.iter().map(|p| p.0).sum::<f64>() / m, pts.iter().map(|p| p.1).sum::<f64>() / m);
        let sxx: f64 = pts.iter().map(|p| (p.0 - mt).powi(2)).sum();
        let sxy: f64 = pts.iter().map(|p| (p.0 - mt) * (p.1 - my)).sum();
        if sxx <= 0.0 || sxy / sxx > -1.0 {
            return None;
        }
        Some((sxy / sxx, -5.0 - lo))
    };
    let edc_with = |tail: f64| -> Vec<f64> {
        let mut edc = vec![0.0; pw.len()];
        let mut acc = tail;
        for i in (0..pw.len()).rev() {
            acc += pw[i];
            edc[i] = acc;
        }
        edc
    };
    // the level range the raw data covers (before tail compensation) bounds the fit
    let mut edc = edc_with(0.0);
    let (mut slope, mut range) = fit(&edc)?;
    let wend = w20.min(pw.len());
    let p_end = pw[pw.len() - wend..].iter().sum::<f64>() / wend as f64;
    for _ in 0..3 {
        // power decays as 10^(slope·t/10): remaining energy = p_end · τ_p (frames)
        let tau_frames = 10.0 / (core::f64::consts::LN_10 * -slope) * fr;
        edc = edc_with(p_end * tau_frames);
        match fit(&edc) {
            Some((s2, r2)) => {
                slope = s2;
                range = range.max(r2);
            }
            None => break,
        }
    }
    Some(Clap { rt60: (-60.0 / slope).min(10.0), range_db: range })
}

// ---------------------------------------------------------------- segmentation

/// Split a recording into note segments (energy + pitch change). Returns
/// (start, end) sample pairs.
pub fn segment(input: &[f32], sr: f32) -> Vec<(usize, usize)> {
    let sr = sr as f64;
    let mut x: Vec<f64> = input.iter().map(|v| if v.is_finite() { *v as f64 } else { 0.0 }).collect();
    if x.len() < (0.2 * sr) as usize {
        return vec![];
    }
    Biquad::highpass(40.0, sr, 0.707).run(&mut x);
    let hop = (0.01 * sr) as usize;
    let env = envelope(&x, hop);
    let edb: Vec<f64> = env.iter().map(|v| 20.0 * v.max(1e-9).log10()).collect();
    let peak = edb.iter().cloned().fold(-200.0, f64::max);
    let mut sorted = edb.clone();
    let floor = {
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        sorted[sorted.len() / 10]
    };
    let thr = (peak - 35.0).max(floor + 12.0).min(peak - 6.0);
    // active regions
    let mut regions = Vec::new();
    let mut i = 0;
    let n = edb.len();
    while i < n {
        if edb[i] > thr {
            let a = i;
            while i < n && edb[i] > thr {
                i += 1;
            }
            regions.push((a, i));
        } else {
            i += 1;
        }
    }
    // genuine gaps: below the gate for > 80 ms (shorter dips — a breath bump, a tongue
    // touch inside a slur — are bridged); drop regions < 150 ms
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for r in regions {
        if let Some(last) = merged.last_mut() {
            if r.0 - last.1 <= 8 {
                last.1 = r.1;
                continue;
            }
        }
        merged.push(r);
    }
    merged.retain(|r| r.1 - r.0 >= 15);
    // inside a sounding region the level may do anything (swells, messa di voce, slow
    // attacks, a quiet plateau before the note speaks fully): split only on
    //  (1) a dip ≥ 20 dB below the surrounding level lasting > 80 ms (re-articulation in a
    //      reverberant room, where the level never reaches the global gate), or
    //  (2) a sustained pitch change: > 70 ¢ for ≥ 60 ms, confirmed on the spectrum (the
    //      time-domain tracker can be biased by ~1 semitone in period-doubled or very soft
    //      passages, which must not split a note)
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (a, b) in merged {
        let mut pieces = vec![];
        // (1) local dips
        {
            let w = 20; // 200 ms context on each side
            let mut start = a;
            let mut k = a;
            while k < b {
                let lref = edb[k.saturating_sub(w).max(a)..k.max(a + 1)].iter().cloned().fold(-200.0, f64::max);
                let mut e = k;
                while e < b && edb[e] < lref - 20.0 {
                    e += 1;
                }
                let rref = edb[e..(e + w).min(b)].iter().cloned().fold(-200.0, f64::max);
                if e - k > 8 && e < b && rref - 20.0 > edb[k..e].iter().cloned().fold(-200.0, f64::max) {
                    pieces.push((start, k));
                    start = e;
                    k = e;
                } else {
                    k = e.max(k + 1);
                }
            }
            pieces.push((start, b));
        }
        for (pa, pb) in pieces {
            if pb - pa < 15 {
                continue;
            }
            let (s0, s1) = (pa * hop, (pb * hop).min(x.len()));
            let tr = track_pitch(&x, sr, s0, s1, 60.0, 2000.0);
            let fr = &tr.frames; // 20 ms hop
            let mut cuts = vec![s0];
            let mut ref_f = 0.0;
            let mut ref_t = s0;
            let mut k = 0;
            while k < fr.len() {
                let f = fr[k].1;
                if f > 0.0 {
                    if ref_f == 0.0 {
                        ref_f = f;
                        ref_t = fr[k].0;
                    } else if (1200.0 * (f / ref_f).log2()).abs() > 70.0 {
                        // persistent for ≥ 60 ms (3 frames)?
                        let span = 3.min(fr.len() - k);
                        let pers = span >= 3 && (k..k + span).all(|j| fr[j].1 > 0.0 && (1200.0 * (fr[j].1 / f).log2()).abs() < 50.0);
                        if pers {
                            let cut = fr[k].0;
                            let win = (0.12 * sr) as usize;
                            let before = (cut.saturating_sub(win).max(ref_t), cut);
                            // after-window skips 40 ms of the old note's ring-down
                            let a0 = (cut + (0.04 * sr) as usize).min(s1);
                            let after = (a0, (a0 + win).min(s1));
                            let (fb, mb) = spectral_peak(&x, sr, before.0, before.1, ref_f);
                            let (fa, _) = spectral_peak(&x, sr, after.0, after.1, f);
                            // the old pitch still sounding at (almost) its former level after the
                            // cut: a tracker octave / subharmonic jump on an unchanged note
                            let (fo, mo) = spectral_peak(&x, sr, after.0, after.1, ref_f);
                            let (lb, la) = ((before.1 - before.0) as f64, (after.1 - after.0) as f64);
                            let (fa0, _) = spectral_peak(&x, sr, after.0, after.1, f);
                            // (when the old pitch is a harmonic of the new one — a slur down an
                            // octave or a 12th — it keeps sounding as that harmonic: no test)
                            let old_is_harm = fa0 > 0.0 && fb > fa0 && {
                                let r = fb / fa0;
                                let k = r.round();
                                (2.0..=4.0).contains(&k) && (1200.0 * (r / k).log2()).abs() < 50.0
                            };
                            let persists = !old_is_harm && fo > 0.0 && fb > 0.0 && (1200.0 * (fo / fb).log2()).abs() < 50.0 && mo / la.max(1.0) > 0.3 * mb / lb.max(1.0);
                            // or the tracker had locked onto a harmonic (the note speaking with a
                            // dominant 2nd/3rd partial) and now finds the fundamental, which was
                            // already sounding before the cut
                            let (_, ma) = spectral_peak(&x, sr, after.0, after.1, f);
                            let (fn_, mn) = spectral_peak(&x, sr, before.0, before.1, f);
                            let harm = fa > 0.0 && fb > fa && {
                                let r = fb / fa;
                                let k = r.round();
                                (2.0..=4.0).contains(&k) && (1200.0 * (r / k).log2()).abs() < 50.0
                            };
                            let emerged = harm && fn_ > 0.0 && (1200.0 * (fn_ / fa).log2()).abs() < 50.0 && mn / lb.max(1.0) > 0.06 * ma / la.max(1.0);
                            let real = !persists && !emerged && fb > 0.0 && fa > 0.0 && (1200.0 * (fa / fb).log2()).abs() > 70.0;
                            if real && cut - *cuts.last().unwrap() >= (0.15 * sr) as usize {
                                cuts.push(cut);
                                ref_f = f;
                                ref_t = cut;
                            } else if !real {
                                // tracker excursion: keep the reference, skip the run
                                k += span;
                                continue;
                            }
                        }
                    } else {
                        ref_f = 0.9 * ref_f + 0.1 * f;
                    }
                }
                k += 1;
            }
            // a pitch change within the first 250 ms of a sounding region is the attack
            // (a note speaking first in the wrong register, a scoop), not a new note
            if cuts.len() >= 2 && cuts[1] - s0 < (0.25 * sr) as usize {
                cuts.remove(1);
            }
            cuts.push(s1);
            for w in cuts.windows(2) {
                if w[1] > w[0] + (0.15 * sr) as usize {
                    out.push((w[0], w[1]));
                }
            }
        }
    }
    // merge neighbours with the same stable pitch separated by < 100 ms (a breath or a dip
    // that briefly crossed the gate inside one sustained note)
    let mut res: Vec<(usize, usize)> = Vec::new();
    let mut res_f: Vec<f64> = Vec::new();
    for (a, b) in out {
        let f = seg_pitch(&x, sr, a, b);
        if let (Some(last), Some(lf)) = (res.last_mut(), res_f.last()) {
            if a >= last.1 && a - last.1 < (0.1 * sr) as usize && f > 0.0 && *lf > 0.0 && (1200.0 * (f / lf).log2()).abs() < 50.0 {
                last.1 = b;
                continue;
            }
        }
        res.push((a, b));
        res_f.push(f);
    }
    res
}

/// Median tracked pitch of the middle half of `x[a..b]` refined on the spectrum (0 if unvoiced).
fn seg_pitch(x: &[f64], sr: f64, a: usize, b: usize) -> f64 {
    let q = (b - a) / 4;
    let tr = track_pitch(x, sr, a + q, b - q, 60.0, 2000.0);
    let mut fs: Vec<f64> = tr.frames.iter().map(|f| f.1).filter(|v| *v > 0.0).collect();
    if fs.len() < 3 {
        return 0.0;
    }
    let g = median(&mut fs);
    spectral_f0(x, sr, a + q, b - q, g)
}

fn spectral_f0(x: &[f64], sr: f64, a: usize, b: usize, guess: f64) -> f64 {
    spectral_peak(x, sr, a, b, guess).0
}

/// Frequency and magnitude of the strongest spectral peak within ±150 ¢ of `guess` in
/// `x[a..b]` (Hann, ≤ 0.17 s centred, zero-padded, parabolic interpolation; (0, 0) if none).
fn spectral_peak(x: &[f64], sr: f64, a: usize, b: usize, guess: f64) -> (f64, f64) {
    if b <= a + 64 || guess <= 0.0 {
        return (0.0, 0.0);
    }
    let len = (b - a).min(8192);
    let st = a + (b - a - len) / 2;
    let nf = 32768;
    let (mut re, mut im) = (vec![0.0; nf], vec![0.0; nf]);
    for i in 0..len {
        let w = 0.5 - 0.5 * (2.0 * PI * i as f64 / (len - 1) as f64).cos();
        re[i] = x[st + i] * w;
    }
    fft(&mut re, &mut im);
    let mag = |k: usize| (re[k] * re[k] + im[k] * im[k]).sqrt();
    let df = sr / nf as f64;
    let lo = ((guess * 2f64.powf(-0.125)) / df).floor().max(1.0) as usize;
    let hi = (((guess * 2f64.powf(0.125)) / df).ceil() as usize).min(nf / 2 - 2);
    if hi <= lo + 2 {
        return (0.0, 0.0);
    }
    let (mut bk, mut bm) = (lo, 0.0);
    for k in lo..=hi {
        let m = mag(k);
        if m > bm {
            bm = m;
            bk = k;
        }
    }
    if bk == lo || bk == hi || bm <= 0.0 {
        return (0.0, 0.0); // no peak inside the window
    }
    let (y0, y1, y2) = (mag(bk - 1).ln(), bm.ln(), mag(bk + 1).ln());
    let d = 0.5 * (y0 - y2) / (y0 - 2.0 * y1 + y2);
    ((bk as f64 + if d.is_finite() { d.clamp(-0.5, 0.5) } else { 0.0 }) * df, bm)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic note: attack ramp, harmonics a_k (linear), noise, vibrato.
    fn synth(sr: f64, dur: f64, f0: f64, amps: &[f64], noise: f64, vib: (f64, f64), attack_s: f64, seed: u64) -> Vec<f32> {
        let n = (sr * dur) as usize;
        let mut ph = 0.0;
        let mut rng = seed | 1;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f64 / sr;
            let f = f0 * 2f64.powf(vib.1 * (2.0 * PI * vib.0 * t).sin() / 1200.0);
            ph += 2.0 * PI * f / sr;
            let mut s = 0.0;
            for (k, a) in amps.iter().enumerate() {
                s += a * ((k + 1) as f64 * ph).sin();
            }
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            let r = (rng >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0;
            s += noise * r;
            let env = if t < 0.05 { 0.0 } else { ((t - 0.05) / attack_s).min(1.0) } * if t > dur - 0.2 { ((dur - t) / 0.2).max(0.0) } else { 1.0 };
            out.push((0.2 * env * s) as f32);
        }
        out
    }

    #[test]
    fn pure_tone_features() {
        let sr = 48000.0;
        let amps = [1.0, 0.5, 0.25, 0.125, 0.0625];
        let x = synth(sr, 2.0, 233.08, &amps, 0.0, (0.0, 0.0), 0.04, 1);
        let f = analyze(&x, sr as f32, 233.08);
        assert_eq!(f[idx::VALID], 1.0);
        assert!((f[idx::F0] - 233.08).abs() < 0.1, "f0 {}", f[idx::F0]);
        assert!(f[idx::CENTS].abs() < 0.5);
        assert!(f[idx::PITCH_STD] < 1.0, "pitch_std {}", f[idx::PITCH_STD]);
        assert_eq!(f[idx::VIB_DEPTH], 0.0);
        for k in 2..=5 {
            let want = 20.0 * (amps[k - 1] / amps[0]).log10();
            let got = f[idx::H1 + k - 1] as f64;
            assert!((got - want).abs() < 0.5, "H{k} {got} vs {want}");
        }
        assert!(f[idx::H1 + 6] < -80.0, "H7 absent: {}", f[idx::H1 + 6]);
        assert!((f[idx::TILT] as f64 + 13.5).abs() < 4.0, "tilt {}", f[idx::TILT]);
        assert!(f[idx::HNR] > 30.0, "hnr {}", f[idx::HNR]);
        assert!((f[idx::ATTACK] - 32.0).abs() < 8.0, "attack {} (10→90 % of a 40 ms linear ramp = 32 ms)", f[idx::ATTACK]);
        assert!(f[idx::SUBHARM] < -60.0);
        assert_eq!(f[idx::REGIME], 1.0);
    }

    #[test]
    fn vibrato_noise_and_regime() {
        let sr = 44100.0;
        let amps = [1.0, 0.7, 0.4, 0.3, 0.2, 0.1];
        let x = synth(sr, 3.0, 440.0, &amps, 0.05, (5.5, 20.0), 0.06, 7);
        let f = analyze(&x, sr as f32, 440.0);
        assert!((f[idx::VIB_RATE] - 5.5).abs() < 0.3, "vib rate {}", f[idx::VIB_RATE]);
        assert!((f[idx::VIB_DEPTH] - 20.0).abs() < 4.0, "vib depth {}", f[idx::VIB_DEPTH]);
        assert!(f[idx::PITCH_STD] < 4.0, "pitch_std after vibrato removal {}", f[idx::PITCH_STD]);
        assert!(f[idx::HNR] > 5.0 && f[idx::HNR] < 40.0, "noisy hnr {}", f[idx::HNR]);
        // same note analysed against a target an octave higher → cracked down
        let g = analyze(&x, sr as f32, 880.0);
        assert_eq!(g[idx::REGIME], 0.5);
        assert!(g[idx::CENTS].abs() < 2.0);
        // and against the lower octave → cracked up
        let h = analyze(&x, sr as f32, 220.0);
        assert_eq!(h[idx::REGIME], 2.0);
    }

    #[test]
    fn subharmonic_and_silence() {
        let sr = 48000.0;
        // multiphonic-like: add a component at 1.5·f0
        let n = (2.0 * sr) as usize;
        let x: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / sr;
                (0.2 * ((2.0 * PI * 300.0 * t).sin() + 0.3 * (2.0 * PI * 450.0 * t).sin() + 0.2 * (2.0 * PI * 600.0 * t).sin())) as f32
            })
            .collect();
        let f = analyze(&x, sr as f32, 300.0);
        assert!((f[idx::SUBHARM] as f64 + 10.5).abs() < 2.0, "subharm {}", f[idx::SUBHARM]);
        let z = vec![0.0f32; n];
        let g = analyze(&z, sr as f32, 300.0);
        assert_eq!(g[idx::VALID], 0.0);
        assert!(g.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn hum_and_dc_robust() {
        let sr = 48000.0;
        let mut x = synth(sr, 2.0, 155.56, &[1.0, 0.6, 0.5, 0.3], 0.0, (0.0, 0.0), 0.03, 3);
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f64 / sr;
            *v += (0.05 + 0.03 * (2.0 * PI * 60.0 * t).sin()) as f32;
        }
        let f = analyze(&x, sr as f32, 155.56);
        assert!(f[idx::CENTS].abs() < 1.0, "cents {}", f[idx::CENTS]);
        assert!((f[idx::H1 + 1] as f64 - 20.0 * 0.6f64.log10()).abs() < 1.0);
    }

    #[test]
    fn segments_multi_note() {
        let sr = 48000.0;
        let mut x = Vec::new();
        for (f, d) in [(233.08, 1.0), (0.0, 0.3), (311.13, 0.8), (349.23, 0.8)] {
            let n = (sr * d) as usize;
            for i in 0..n {
                let t = i as f64 / sr;
                x.push(if f > 0.0 { (0.2 * (2.0 * PI * f * t).sin() + 0.1 * (4.0 * PI * f * t).sin()) as f32 } else { 0.0 });
            }
        }
        let s = segment(&x, sr as f32);
        assert_eq!(s.len(), 3, "{s:?}");
        // second cut is the legato pitch change at 2.1 s
        let cut = s[2].0 as f64 / sr;
        assert!((cut - 2.1).abs() < 0.06, "legato cut at {cut}");
    }

    /// Sequence of notes (f0 Hz, 0 = silence) with per-note envelope g(t/dur) (linear amplitude),
    /// 4 harmonics, light noise.
    fn seq(sr: f64, notes: &[(f64, f64, &dyn Fn(f64) -> f64)]) -> Vec<f32> {
        let mut x = Vec::new();
        let mut ph = 0.0;
        let mut r = 777u64;
        for &(f, d, env) in notes {
            let n = (sr * d) as usize;
            for i in 0..n {
                let u = i as f64 / n as f64;
                ph += 2.0 * PI * f / sr;
                r ^= r << 13;
                r ^= r >> 7;
                r ^= r << 17;
                let nz = 1e-4 * ((r >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0);
                let s = if f > 0.0 { env(u) * (ph.sin() + 0.5 * (2.0 * ph).sin() + 0.3 * (3.0 * ph).sin() + 0.2 * (4.0 * ph).sin()) } else { 0.0 };
                x.push((0.2 * s + nz) as f32);
            }
        }
        x
    }

    fn db(v: f64) -> f64 {
        10f64.powf(v / 20.0)
    }

    /// fade in/out 30 ms at the ends of a note
    fn edge(u: f64, d: f64) -> f64 {
        ((u * d) / 0.03).min(1.0).min(((1.0 - u) * d) / 0.03).max(0.0)
    }

    #[test]
    fn segments_swell_plateau() {
        // the coach e2e case: loud note, then F6 rising to a −9 dB plateau (0.3–0.7 s) and an
        // 8 dB swell, then another note
        let sr = 48000.0;
        let flat = |u: f64| edge(u, 1.0);
        let f6 = |u: f64| {
            let t = u * 1.6;
            let g = if t < 0.3 { db(-9.0) * t / 0.3 } else if t < 0.7 { db(-9.0) } else if t < 1.0 { db(-9.0 + 8.0 * (t - 0.7) / 0.3) } else { db(-1.0) };
            g * edge(u, 1.6)
        };
        let sil = |_u: f64| 0.0;
        let x = seq(sr, &[(392.0, 1.0, &flat), (0.0, 0.3, &sil), (1396.9, 1.6, &f6), (0.0, 0.3, &sil), (523.25, 1.0, &flat)]);
        let s = segment(&x, sr as f32);
        assert_eq!(s.len(), 3, "{s:?}");
    }

    #[test]
    fn segments_dynamics_do_not_split() {
        let sr = 48000.0;
        let sil = |_u: f64| 0.0;
        // crescendo −30 → 0 dB, decrescendo 0 → −30 dB, messa di voce −25 → 0 → −25 dB,
        // slow 400 ms attack, each 2 s, separated by 0.4 s rests
        let cresc = |u: f64| db(-30.0 + 30.0 * u) * edge(u, 2.0);
        let decresc = |u: f64| db(-30.0 * u) * edge(u, 2.0);
        let messa = |u: f64| db(-25.0 + 25.0 * (1.0 - (2.0 * u - 1.0).abs())) * edge(u, 2.0);
        let slow = |u: f64| ((u * 2.0) / 0.4).min(1.0) * edge(u, 2.0);
        let x = seq(sr, &[(0.0, 0.3, &sil), (293.66, 2.0, &cresc), (0.0, 0.4, &sil), (440.0, 2.0, &decresc), (0.0, 0.4, &sil), (698.46, 2.0, &messa), (0.0, 0.4, &sil), (233.08, 2.0, &slow), (0.0, 0.3, &sil)]);
        let s = segment(&x, sr as f32);
        assert_eq!(s.len(), 4, "{:?}", s.iter().map(|p| (p.0 as f64 / sr, p.1 as f64 / sr)).collect::<Vec<_>>());
    }

    #[test]
    fn segments_legato_intervals() {
        // continuous legato: octave up, octave down, semitone, a 12th up (harmonic relations
        // must still split), each 0.7 s, with a slow swell on the last note
        let sr = 48000.0;
        let sil = |_u: f64| 0.0;
        let one = |_u: f64| 1.0;
        let swell = |u: f64| db(-12.0 + 12.0 * u) * edge(u, 0.9);
        let fin = |u: f64| edge(u, 0.7).max(if u < 0.5 { 1.0 } else { 0.0 });
        let x = seq(sr, &[(0.0, 0.3, &sil), (392.0, 0.7, &fin), (784.0, 0.7, &one), (392.0, 0.7, &one), (415.3, 0.7, &one), (1245.9, 0.9, &swell), (0.0, 0.3, &sil)]);
        let s = segment(&x, sr as f32);
        let t: Vec<(f64, f64)> = s.iter().map(|p| (p.0 as f64 / sr, p.1 as f64 / sr)).collect();
        assert_eq!(s.len(), 5, "{t:?}");
        for (k, want) in [1.0, 1.7, 2.4, 3.1].iter().enumerate() {
            assert!((t[k + 1].0 - want).abs() < 0.08, "cut {k} at {} (want {want}) {t:?}", t[k + 1].0);
        }
    }

    #[test]
    fn segments_gap_and_repeated_note() {
        // same pitch re-articulated with a 120 ms gap → two notes; a 40 ms dip → one note
        let sr = 48000.0;
        let flat = |u: f64| edge(u, 1.0);
        let sil = |_u: f64| 0.0;
        let x = seq(sr, &[(0.0, 0.2, &sil), (349.23, 1.0, &flat), (0.0, 0.12, &sil), (349.23, 1.0, &flat), (0.0, 0.3, &sil)]);
        assert_eq!(segment(&x, sr as f32).len(), 2);
        let dip = |u: f64| if (u * 2.0 - 1.0).abs() < 0.01 { 0.0 } else { 1.0 } * edge(u, 2.0);
        let x = seq(sr, &[(0.0, 0.2, &sil), (349.23, 2.0, &dip), (0.0, 0.3, &sil)]);
        assert_eq!(segment(&x, sr as f32).len(), 1);
    }

    /// Abrupt stop: dry → no room decay; with an exponential reverb tail of known
    /// RT60 the release-tail estimate recovers it.
    #[test]
    fn release_t60_estimate() {
        let sr = 48000.0;
        let n = (3.0 * sr) as usize;
        let stop = (1.8 * sr) as usize;
        let dry: Vec<f64> = (0..n)
            .map(|i| {
                let t = i as f64 / sr;
                if i > (0.05 * sr) as usize && i < stop { 0.2 * ((2.0 * PI * 523.25 * t).sin() + 0.5 * (4.0 * PI * 523.25 * t).sin()) } else { 0.0 }
            })
            .collect();
        let f: Vec<f32> = dry.iter().map(|v| *v as f32).collect();
        let a = analyze(&f, sr as f32, 523.25);
        assert_eq!(a[idx::RELEASE_T60], -1.0, "dry: {}", a[idx::RELEASE_T60]);
        assert_eq!(a[idx::RELEASE_CLEAN], 1.0);
        for &rt in &[0.6, 1.0] {
            // direct + exponentially decaying noise tail (DRR 0 dB), FFT convolution
            let m = (1.3 * rt * sr) as usize;
            let mut h = vec![0.0; m];
            h[0] = 1.0;
            let mut r = 12345u64;
            let mut e = 0.0;
            for k in 200..m {
                r ^= r << 13;
                r ^= r >> 7;
                r ^= r << 17;
                let w = (r >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0;
                h[k] = w * (-(k as f64 / sr) * 6.91 / rt).exp();
                e += h[k] * h[k];
            }
            for v in h.iter_mut().skip(200) {
                *v /= e.sqrt();
            }
            let mut nf = 1;
            while nf < n + m {
                nf <<= 1;
            }
            let (mut ar, mut ai, mut br, mut bi) = (vec![0.0; nf], vec![0.0; nf], vec![0.0; nf], vec![0.0; nf]);
            ar[..n].copy_from_slice(&dry);
            br[..m].copy_from_slice(&h);
            fft(&mut ar, &mut ai);
            fft(&mut br, &mut bi);
            for k in 0..nf {
                let (x, y) = (ar[k] * br[k] - ai[k] * bi[k], ar[k] * bi[k] + ai[k] * br[k]);
                ar[k] = x;
                ai[k] = -y;
            }
            fft(&mut ar, &mut ai);
            let y: Vec<f32> = (0..n).map(|i| (ar[i] / nf as f64) as f32).collect();
            let b = analyze(&y, sr as f32, 523.25);
            let est = b[idx::RELEASE_T60] as f64;
            assert!((est - rt).abs() < 0.25 * rt, "RT60 {rt}: estimated {est}");
            assert!(b[idx::TAIL_RATIO] > a[idx::TAIL_RATIO] + 20.0);
        }
    }

    #[test]
    fn clap_truncated_by_note() {
        // clap at 0.1 s in a 1.0 s room; a tone starts 0.4 s later and cuts the decay short
        let sr = 48000.0;
        let mut r = 12345u64;
        let mut rnd = || {
            r ^= r << 13;
            r ^= r >> 7;
            r ^= r << 17;
            (r >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
        };
        let n = (2.5 * sr) as usize;
        let mut x = vec![0.0f32; n];
        let c0 = (0.1 * sr) as usize;
        for i in 0..(0.005 * sr) as usize {
            x[c0 + i] += (0.8 * rnd()) as f32;
        }
        for i in c0..n {
            let t = (i - c0) as f64 / sr;
            x[i] += (0.05 * rnd() * (-6.91 * t / 1.0).exp()) as f32;
        }
        for i in (0.5 * sr) as usize..(2.3 * sr) as usize {
            x[i] += (0.3 * (2.0 * PI * 233.0 * i as f64 / sr).sin()) as f32;
        }
        let rm = room(&x, sr as f32);
        assert!((rm.clap_rt60 - 1.0).abs() < 0.15, "clap {}", rm.clap_rt60);
        assert!((rm.rt60 - rm.clap_rt60).abs() < 1e-9, "clap is primary");
    }

    #[test]
    fn inst_t60_config() {
        assert_eq!(AnalysisConfig::default().inst_t60_hz, INST_T60_HZ);
        assert_eq!(AnalysisConfig::with_inst_t60(95.0).inst_t60_hz, 95.0);
        assert_eq!(AnalysisConfig::with_inst_t60(-1.0), AnalysisConfig::default());
        // the constant only affects the release analysis, and only through `cfg`
        let sr = 48000.0;
        let x: Vec<f32> = (0..(2.0 * sr) as usize)
            .map(|i| if i < (1.5 * sr) as usize { (0.2 * (2.0 * PI * 311.13 * i as f64 / sr).sin()) as f32 } else { 0.0 })
            .collect();
        let a = analyze(&x, sr as f32, 311.13);
        let b = analyze_with(&x, sr as f32, 311.13, &AnalysisConfig::with_inst_t60(95.0));
        assert_eq!(a[..idx::RELEASE_T60], b[..idx::RELEASE_T60]);
    }
}
