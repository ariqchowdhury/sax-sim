//! Parameter smoothing (one-pole, per-sample or per-block).

#[derive(Clone, Copy, Debug)]
pub struct Smoother {
    pub value: f64,
    pub target: f64,
    coef: f64,
}

impl Smoother {
    pub fn new(v: f64) -> Self {
        Smoother { value: v, target: v, coef: 1.0 }
    }
    /// Set time constant `tau` (s) for updates happening at rate `rate` (Hz).
    pub fn set_time(&mut self, tau: f64, rate: f64) {
        self.coef = if tau <= 0.0 { 1.0 } else { 1.0 - (-1.0 / (tau * rate)).exp() };
    }
    #[inline]
    pub fn tick(&mut self) -> f64 {
        self.value += self.coef * (self.target - self.value);
        self.value
    }
    pub fn snap(&mut self) {
        self.value = self.target;
    }
    pub fn settled(&self, eps: f64) -> bool {
        (self.value - self.target).abs() <= eps
    }
}
