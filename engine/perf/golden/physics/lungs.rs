//! Air supply: lung pressure with first-order respiratory dynamics
//! (τ = 60 ms rising, 120 ms falling — PHYSICS.md §7) plus the turbulence
//! noise generator (white noise band-passed 1–8 kHz, ≈ unit variance).

pub struct Lungs {
    pub pressure: f64,
    pub target: f64,
    coef_up: f64,
    coef_down: f64,
    rng: u64,
    /// RNG seed restored by `reset_noise` (deterministic offline renders)
    seed: u64,
    hp_x1: f64,
    hp_y1: f64,
    hp_c: f64,
    lp1: f64,
    lp2: f64,
    lp_c: f64,
    gain: f64,
}

impl Lungs {
    pub fn new() -> Self {
        Lungs {
            pressure: 0.0,
            target: 0.0,
            coef_up: 1.0,
            coef_down: 1.0,
            rng: 0x9E3779B97F4A7C15,
            seed: 0x9E3779B97F4A7C15,
            hp_x1: 0.0,
            hp_y1: 0.0,
            hp_c: 0.9,
            lp1: 0.0,
            lp2: 0.0,
            lp_c: 0.5,
            gain: 1.0,
        }
    }
    /// `rate` = rate of `tick()` (output sample rate); `internal_rate` = rate of `noise()`.
    pub fn configure(&mut self, rate: f64, internal_rate: f64) {
        self.coef_up = 1.0 - (-1.0 / (0.060 * rate)).exp();
        self.coef_down = 1.0 - (-1.0 / (0.120 * rate)).exp();
        let tau = 2.0 * core::f64::consts::PI / internal_rate;
        self.hp_c = (-1000.0 * tau).exp();
        self.lp_c = 1.0 - (-8000.0 * tau).exp();
        // normalise: uniform[-1,1) has variance 1/3; band 1–8 kHz of fs/2
        let band = (7000.0 / (0.5 * internal_rate)).min(1.0);
        self.gain = (3.0 / band).sqrt();
    }
    pub fn set_target_pa(&mut self, pa: f64) {
        self.target = pa.max(0.0);
    }
    /// Seed the breath-noise generator (and restart it).
    pub fn set_seed(&mut self, seed: u64) {
        // splitmix-style scramble; xorshift state must be non-zero
        let mut z = seed.wrapping_add(0x9E3779B97F4A7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^= z >> 31;
        self.seed = if z == 0 { 1 } else { z };
        self.rng = self.seed;
    }
    pub fn reset_noise(&mut self) {
        self.rng = self.seed;
        self.hp_x1 = 0.0;
        self.hp_y1 = 0.0;
        self.lp1 = 0.0;
        self.lp2 = 0.0;
    }
    pub fn snap(&mut self) {
        self.pressure = self.target;
    }
    #[inline]
    pub fn tick(&mut self) -> f64 {
        let d = self.target - self.pressure;
        self.pressure += if d > 0.0 { self.coef_up } else { self.coef_down } * d;
        self.pressure
    }
    /// Band-limited unit-variance noise sample (internal rate).
    #[inline]
    pub fn noise(&mut self) -> f64 {
        // xorshift64*
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        let r = (x.wrapping_mul(0x2545F4914F6CDD1D) >> 11) as f64 * (1.0 / (1u64 << 53) as f64);
        let w = 2.0 * r - 1.0;
        // one-pole high-pass at 1 kHz, two one-pole low-passes at 8 kHz
        let hp = self.hp_c * (self.hp_y1 + w - self.hp_x1);
        self.hp_x1 = w;
        self.hp_y1 = hp;
        self.lp1 += self.lp_c * (hp - self.lp1);
        self.lp2 += self.lp_c * (self.lp1 - self.lp2);
        self.lp2 * self.gain
    }
}

impl Default for Lungs {
    fn default() -> Self {
        Self::new()
    }
}
