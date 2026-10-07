//! Decimation from the internal rate (fs·OS) to fs with a Kaiser-windowed
//! sinc FIR (passband to ≈20 kHz, ≥80 dB stopband from fs/2+4 kHz folding
//! point), evaluated only once per output sample (polyphase-equivalent cost).

pub const MAX_TAPS: usize = 512;

pub struct Decimator {
    pub factor: usize,
    taps: Vec<f32>,
    /// doubled ring buffer so the convolution reads one contiguous slice
    buf: Vec<f32>,
    pos: usize,
    phase: usize,
}

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let q = x * x / 4.0;
    for k in 1..50 {
        term *= q / (k as f64 * k as f64);
        sum += term;
        if term < 1e-12 * sum {
            break;
        }
    }
    sum
}

impl Decimator {
    pub fn new() -> Self {
        Decimator { factor: 1, taps: Vec::with_capacity(MAX_TAPS), buf: Vec::with_capacity(2 * MAX_TAPS), pos: 0, phase: 0 }
    }

    pub fn configure(&mut self, factor: usize, fs_out: f64) {
        self.factor = factor.max(1);
        self.taps.clear();
        self.buf.clear();
        self.pos = 0;
        self.phase = 0;
        if self.factor == 1 {
            self.taps.push(1.0);
            self.buf.resize(2, 0.0);
            return;
        }
        let fs_in = fs_out * self.factor as f64;
        // transition: 20 kHz (or 0.42 fs) .. fs - 20 kHz (alias-free audible band)
        let f_pass = (0.42 * fs_out).min(20000.0);
        let f_stop = fs_out - f_pass;
        let fc = 0.5 * (f_pass + f_stop) / fs_in; // normalised cutoff (cycles/sample)
        let dw = 2.0 * core::f64::consts::PI * (f_stop - f_pass) / fs_in;
        let atten = 80.0;
        let mut n = ((atten - 8.0) / (2.285 * dw)).ceil() as usize + 1;
        n = n.clamp(8, MAX_TAPS);
        let beta = 0.1102 * (atten - 8.7);
        let i0b = bessel_i0(beta);
        let mid = (n - 1) as f64 / 2.0;
        let mut sum = 0.0;
        let mut t = Vec::with_capacity(n);
        for k in 0..n {
            let m = k as f64 - mid;
            let sinc = if m.abs() < 1e-12 { 2.0 * fc } else { (2.0 * core::f64::consts::PI * fc * m).sin() / (core::f64::consts::PI * m) };
            let r = m / mid;
            let w = bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0b;
            let h = sinc * w;
            sum += h;
            t.push(h);
        }
        for h in t {
            self.taps.push((h / sum) as f32);
        }
        self.buf.resize(2 * self.taps.len(), 0.0);
    }

    /// Group delay in output samples.
    pub fn latency_out(&self) -> f64 {
        (self.taps.len() as f64 - 1.0) / 2.0 / self.factor as f64
    }

    pub fn reset(&mut self) {
        self.buf.iter_mut().for_each(|x| *x = 0.0);
        self.phase = 0;
    }

    /// Push one internal-rate sample; returns Some(output) every `factor` pushes.
    #[inline]
    pub fn push(&mut self, x: f32) -> Option<f32> {
        let n = self.taps.len();
        self.buf[self.pos] = x;
        self.buf[self.pos + n] = x;
        self.pos += 1;
        if self.pos == n {
            self.pos = 0;
        }
        self.phase += 1;
        if self.phase < self.factor {
            return None;
        }
        self.phase = 0;
        // buf[pos .. pos+n] holds samples oldest → newest; taps are symmetric
        let window = &self.buf[self.pos..self.pos + n];
        let taps = &self.taps[..n];
        let mut acc = [0.0f32; 4];
        let chunks = n / 4;
        for c in 0..chunks {
            for j in 0..4 {
                acc[j] += window[4 * c + j] * taps[4 * c + j];
            }
        }
        let mut s = acc[0] + acc[1] + acc[2] + acc[3];
        for k in 4 * chunks..n {
            s += window[k] * taps[k];
        }
        Some(s)
    }
}

impl Default for Decimator {
    fn default() -> Self {
        Self::new()
    }
}
