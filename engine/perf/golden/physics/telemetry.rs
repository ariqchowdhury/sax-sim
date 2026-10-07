//! Telemetry block (layout fixed by docs/ARCHITECTURE.md) and a cheap pitch
//! estimator (YIN-lite on the mouthpiece pressure decimated to fs/4).

pub const N_PROFILE: usize = 128;
pub const SCOPE_LEN: usize = 64;
/// scope decimation (output samples per scope sample)
pub const SCOPE_STRIDE: usize = 4;
pub const IDX_PROFILE: usize = 17;
pub const IDX_RMS: usize = IDX_PROFILE + N_PROFILE;
pub const IDX_SCOPE_P: usize = IDX_RMS + N_PROFILE;
pub const IDX_SCOPE_Y: usize = IDX_SCOPE_P + SCOPE_LEN;
/// reed deflection along the reed, tip → clamp (m, + toward lay) — appended (M4)
pub const REED_SHAPE_LEN: usize = 32;
pub const IDX_REED_SHAPE: usize = IDX_SCOPE_Y + SCOPE_LEN;
pub const TELEMETRY_LEN: usize = IDX_REED_SHAPE + REED_SHAPE_LEN;

pub mod idx {
    pub const LUNG: usize = 0;
    pub const MOUTH: usize = 1;
    pub const MOUTHPIECE: usize = 2;
    pub const REED_Y: usize = 3;
    pub const REED_H: usize = 4;
    pub const FLOW: usize = 5;
    pub const FREQ: usize = 6;
    pub const OUT_RMS: usize = 7;
    pub const CPU_US: usize = 8;
    pub const N_PROFILE: usize = 16;
}

/// YIN-lite pitch tracker.
pub struct PitchTracker {
    rate: f64,
    decim: usize,
    acc: f64,
    acc_n: usize,
    buf: [f32; Self::BUF],
    pos: usize,
    filled: usize,
    since: usize,
    pub freq: f64,
    diff: [f32; Self::MAXLAG + 1],
    /// running power for silence detection
    power: f64,
}

impl PitchTracker {
    const BUF: usize = 512;
    const WIN: usize = 300;
    const MAXLAG: usize = 200;

    pub fn new(fs: f64) -> Self {
        let decim = ((fs / 12000.0).round() as usize).max(1);
        PitchTracker {
            rate: fs / decim as f64,
            decim,
            acc: 0.0,
            acc_n: 0,
            buf: [0.0; Self::BUF],
            pos: 0,
            filled: 0,
            since: 0,
            freq: 0.0,
            diff: [0.0; Self::MAXLAG + 1],
            power: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.acc = 0.0;
        self.acc_n = 0;
        self.buf = [0.0; Self::BUF];
        self.filled = 0;
        self.since = 0;
        self.freq = 0.0;
        self.power = 0.0;
    }

    /// Feed one output-rate sample (DC-removed mouthpiece pressure).
    #[inline]
    pub fn push(&mut self, x: f64) {
        self.acc += x;
        self.acc_n += 1;
        if self.acc_n < self.decim {
            return;
        }
        let v = self.acc / self.acc_n as f64;
        self.acc = 0.0;
        self.acc_n = 0;
        self.power += 0.002 * (v * v - self.power);
        self.buf[self.pos] = v as f32;
        self.pos = (self.pos + 1) % Self::BUF;
        self.filled = (self.filled + 1).min(Self::BUF);
        self.since += 1;
        if self.since >= 240 && self.filled == Self::BUF {
            self.since = 0;
            self.estimate();
        }
    }

    fn estimate(&mut self) {
        // silence: < ~20 Pa rms
        if self.power < 400.0 {
            self.freq = 0.0;
            return;
        }
        let n = Self::BUF;
        let start = self.pos; // oldest
        let get = |i: usize| self.buf[(start + i) % n];
        let mut lin = [0.0f32; Self::BUF];
        for (i, l) in lin.iter_mut().enumerate() {
            *l = get(i);
        }
        let w = Self::WIN;
        let maxlag = Self::MAXLAG.min(n - w - 1);
        let minlag = ((self.rate / 2000.0) as usize).max(2);
        self.diff[0] = 1.0;
        // Cumulative-mean-normalised difference, computed lazily in lag order
        // and only as far as the search below needs it (the first dip under 0.2
        // and its local minimum) — identical values, typically 2–5× fewer lags.
        let mut run = 0.0f32;
        let mut done = 0usize; // diff[1..=done] valid
        let mut ensure = |upto: usize, diff: &mut [f32; Self::MAXLAG + 1]| {
            while done < upto {
                let tau = done + 1;
                let d = sq_diff(&lin[..w], &lin[tau..tau + w]);
                run += d;
                diff[tau] = if run > 0.0 { d * tau as f32 / run } else { 1.0 };
                done = tau;
            }
        };
        let mut best = 0usize;
        for tau in minlag..maxlag {
            ensure(tau, &mut self.diff);
            if self.diff[tau] < 0.2 {
                // descend to local minimum
                let mut t = tau;
                while t + 1 < maxlag && {
                    ensure(t + 1, &mut self.diff);
                    self.diff[t + 1] < self.diff[t]
                } {
                    t += 1;
                }
                best = t;
                break;
            }
        }
        if best > 0 {
            ensure(best + 1, &mut self.diff);
        }
        if best == 0 {
            self.freq = 0.0;
            return;
        }
        let (y0, y1, y2) = (self.diff[best - 1] as f64, self.diff[best] as f64, self.diff[best + 1] as f64);
        let den = y0 - 2.0 * y1 + y2;
        let off = if den.abs() > 1e-12 { 0.5 * (y0 - y2) / den } else { 0.0 };
        let lag = best as f64 + off.clamp(-1.0, 1.0);
        self.freq = self.rate / lag;
    }
}

/// Σ (a_j − b_j)² with 8 independent partial sums (vectorises to 2×4 lanes).
#[inline]
fn sq_diff(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let mut acc = [0.0f32; 8];
    let mut ca = a.chunks_exact(8);
    let mut cb = b.chunks_exact(8);
    for (x, y) in (&mut ca).zip(&mut cb) {
        for k in 0..8 {
            let e = x[k] - y[k];
            acc[k] += e * e;
        }
    }
    let mut d = ((acc[0] + acc[4]) + (acc[1] + acc[5])) + ((acc[2] + acc[6]) + (acc[3] + acc[7]));
    for (x, y) in ca.remainder().iter().zip(cb.remainder()) {
        let e = x - y;
        d += e * e;
    }
    d
}

/// Accurate offline f0 estimate (native renderer / tests): YIN for the coarse
/// period, then average period from interpolated upward zero crossings of the
/// signal band-passed around f0.
pub fn measure_f0(x: &[f64], fs: f64) -> f64 {
    let n = x.len();
    if n < 2048 {
        return 0.0;
    }
    let mean = x.iter().sum::<f64>() / n as f64;
    let y: Vec<f64> = x.iter().map(|v| v - mean).collect();
    // coarse YIN on a 4096 window
    let w = 2048.min(n / 2);
    let maxlag = ((fs / 60.0) as usize).min(n - w - 1);
    let minlag = (fs / 2500.0) as usize;
    let mut d = vec![0.0; maxlag + 1];
    let mut run = 0.0;
    let mut cm = vec![1.0; maxlag + 1];
    for tau in 1..=maxlag {
        let mut s = 0.0;
        for j in 0..w {
            let e = y[j] - y[j + tau];
            s += e * e;
        }
        d[tau] = s;
        run += s;
        cm[tau] = if run > 0.0 { s * tau as f64 / run } else { 1.0 };
    }
    let mut best = 0;
    for tau in minlag.max(2)..maxlag {
        if cm[tau] < 0.15 {
            let mut t = tau;
            while t + 1 < maxlag && cm[t + 1] < cm[t] {
                t += 1;
            }
            best = t;
            break;
        }
    }
    if best == 0 {
        // fall back to global minimum
        let mut m = f64::MAX;
        for tau in minlag.max(2)..maxlag {
            if cm[tau] < m {
                m = cm[tau];
                best = tau;
            }
        }
        if m > 0.5 {
            return 0.0;
        }
    }
    let f_coarse = fs / best as f64;
    // band-pass (2nd-order resonator, Q=3) around f_coarse, run twice
    let bp = |inp: &[f64]| -> Vec<f64> {
        let w0 = 2.0 * core::f64::consts::PI * f_coarse / fs;
        let q = 3.0;
        let alpha = w0.sin() / (2.0 * q);
        let (b0, b2) = (alpha, -alpha);
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * w0.cos();
        let a2 = 1.0 - alpha;
        let mut out = vec![0.0; inp.len()];
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for (i, &xv) in inp.iter().enumerate() {
            let yv = (b0 * xv + b2 * x2 - a1 * y1 - a2 * y2) / a0;
            x2 = x1;
            x1 = xv;
            y2 = y1;
            y1 = yv;
            out[i] = yv;
        }
        out
    };
    let z = bp(&bp(&y));
    let skip = (8.0 * fs / f_coarse) as usize; // filter settling
    let mut crossings = Vec::new();
    for i in skip.max(1)..n {
        if z[i - 1] < 0.0 && z[i] >= 0.0 {
            let t = (i - 1) as f64 + z[i - 1] / (z[i - 1] - z[i]);
            crossings.push(t);
        }
    }
    if crossings.len() < 3 {
        return f_coarse;
    }
    let periods = (crossings.len() - 1) as f64;
    let span = crossings[crossings.len() - 1] - crossings[0];
    fs * periods / span
}
