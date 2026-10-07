//! 1-D Webster horn equation on a staggered grid (pressure p at nodes,
//! volume velocity U at half nodes), with visco-thermal boundary-layer losses.
//!
//!   (ρ/S) ∂U/∂t = −∂p/∂x − (k_vt /(S r)) · √s · U          (series, per unit length)
//!   (V/ρc²) ∂p/∂t = −ΔU                                     (per cell of volume V)
//!
//! Discretisation (Bilbao, "Numerical Sound Synthesis" ch. 9):
//!   U_{i+½}^{n+½} = U^{n−½} − (Δt S_{i+½}/(ρΔx)) (p_{i+1}−p_i) − loss
//!   p_i^{n+1}     = p_i^n − (ρc²Δt/V_i)(U_{i+½} − U_{i−½} + Σ U_branch)
//! with V_i = Δx (S_{i−½}+S_{i+½})/2, which is stable for λ = cΔt/Δx ≤ 1 for any
//! area profile. The √s boundary-layer operator is approximated by a sum of three
//! positive-real first-order high-pass sections a_k s/(s+b_k) (each passive),
//! fitted to √(jω) over 80 Hz–5 kHz (±10 %). Each section needs one state per
//! half node; the resistive part is treated trapezoidally (unconditionally
//! dissipative), the section states with an exact one-pole update.

use crate::air::Air;

pub const NPOLES: usize = 3;
/// √s ≈ Σ a_k s/(s+b_k)  (b in rad/s)
pub const LOSS_A: [f64; NPOLES] = [20.948067, 45.777930, 282.595182];
pub const LOSS_B: [f64; NPOLES] = [294.578962, 3973.918823, 53609.201726];

#[derive(Clone, Default)]
pub struct Tube {
    /// number of pressure nodes
    pub n: usize,
    pub dx: f64,
    pub dt: f64,
    /// pressure at nodes (Pa)
    pub p: Vec<f32>,
    /// volume velocity at half nodes (m³/s), len n−1
    pub u: Vec<f32>,
    /// loss-section states (a_k-scaled low-passed U), len n−1 each
    w0: Vec<f32>,
    w1: Vec<f32>,
    w2: Vec<f32>,
    /// U update coefficients
    cu1: Vec<f32>,
    cu2: Vec<f32>,
    cu3: Vec<f32>,
    /// ρc²Δt/V_i at nodes
    pub kp: Vec<f32>,
    /// state recursion w_k ← d_k·w_k + e_k·U  (d = 1−β, e = β·a)
    dk: [f32; NPOLES],
    ek: [f32; NPOLES],
    /// areas at half nodes (m²), len n−1 (kept for telemetry / boundary use)
    pub s_half: Vec<f64>,
    /// node volumes without branch additions
    pub vol: Vec<f64>,
    /// nodes [1, thermal_nodes) carry the thermal boundary-layer loss as an
    /// explicit shunt term on the pressure update (E2b); elsewhere it is lumped
    /// into the series term (cheaper; accurate where the bore is wide)
    pub thermal_nodes: usize,
    th0: Vec<f32>,
    th1: Vec<f32>,
    th2: Vec<f32>,
    cp1: Vec<f32>,
    cp2: Vec<f32>,
    cp3: Vec<f32>,
    /// additive inertance length per half node (m; tone-hole series
    /// corrections t_a, usually negative): L = ρ(Δx + dl)/S
    pub dl_half: Vec<f64>,
}

impl Tube {
    /// Allocate a tube with `n` nodes and room for `cap` nodes.
    pub fn with_capacity(cap: usize) -> Tube {
        let mut t = Tube::default();
        let c = cap.max(2);
        t.p.reserve(c);
        t.u.reserve(c);
        t.w0.reserve(c);
        t.w1.reserve(c);
        t.w2.reserve(c);
        t.cu1.reserve(c);
        t.cu2.reserve(c);
        t.cu3.reserve(c);
        t.kp.reserve(c);
        t.s_half.reserve(c);
        t.vol.reserve(c);
        t.dl_half.reserve(c);
        for v in [&mut t.th0, &mut t.th1, &mut t.th2, &mut t.cp1, &mut t.cp2, &mut t.cp3] {
            v.reserve(c);
        }
        t
    }

    /// Resize to `n` nodes (state zeroed). Does not allocate if within capacity.
    pub fn resize(&mut self, n: usize) {
        let n = n.max(2);
        self.n = n;
        for v in [&mut self.p, &mut self.kp] {
            v.clear();
            v.resize(n, 0.0);
        }
        for v in [&mut self.u, &mut self.w0, &mut self.w1, &mut self.w2, &mut self.cu1, &mut self.cu2, &mut self.cu3] {
            v.clear();
            v.resize(n - 1, 0.0);
        }
        self.s_half.clear();
        self.s_half.resize(n - 1, 1e-4);
        self.vol.clear();
        self.vol.resize(n, 0.0);
        self.dl_half.clear();
        self.dl_half.resize(n - 1, 0.0);
        for v in [&mut self.th0, &mut self.th1, &mut self.th2, &mut self.cp1, &mut self.cp2, &mut self.cp3] {
            v.clear();
            v.resize(n, 0.0);
        }
        self.thermal_nodes = self.thermal_nodes.min(n - 1);
    }

    pub fn clear_state(&mut self) {
        self.p.iter_mut().for_each(|x| *x = 0.0);
        for v in [&mut self.u, &mut self.w0, &mut self.w1, &mut self.w2] {
            v.iter_mut().for_each(|x| *x = 0.0);
        }
        for v in [&mut self.th0, &mut self.th1, &mut self.th2] {
            v.iter_mut().for_each(|x| *x = 0.0);
        }
    }

    /// Recompute all coefficients. `area_half(i)` gives S at x=(i+½)Δx.
    /// `extra_vol[i]` is added to node i's volume (closed side-branch volumes).
    /// `loss_mult` scales boundary-layer losses (0 = lossless, 1 = smooth rigid wall).
    pub fn set_coeffs(&mut self, dx: f64, dt: f64, air: &Air, loss_mult: f64, extra_vol: Option<&[f64]>) {
        let n = self.n;
        self.dx = dx;
        self.dt = dt;
        let rho = air.rho;
        let rc2 = rho * air.c * air.c;
        let kvt = air.k_vt();
        // purely viscous series factor (used where thermal is an explicit shunt)
        let kv = 2.0 * (rho * air.eta).sqrt();
        // thermal shunt factor: ℓ_t = kp · kt · S Δx / r
        let kt = 2.0 * (air.gamma - 1.0) / (rc2) * (air.eta / rho).sqrt() / air.nu;
        let nth = self.thermal_nodes.min(n - 1);
        let asum: f64 = LOSS_A.iter().sum();
        for k in 0..NPOLES {
            let beta = 1.0 - (-LOSS_B[k] * dt).exp();
            self.dk[k] = (1.0 - beta) as f32;
            self.ek[k] = (beta * LOSS_A[k]) as f32;
        }
        for i in 0..n - 1 {
            let s = self.s_half[i].max(1e-8);
            let r = (s / core::f64::consts::PI).sqrt();
            let k_series = if i + 1 < nth { kv } else { kvt };
            let ell = loss_mult * k_series * dt / (rho * r);
            let den = 1.0 + 0.5 * ell * asum;
            self.cu1[i] = ((1.0 - 0.5 * ell * asum) / den) as f32;
            // series corrections may shorten a cell by at most 7 % (the bore grid
            // keeps a matching CFL margin, engine::CFL_MARGIN)
            let dxe = dx + self.dl_half[i].max(-0.07 * dx);
            self.cu2[i] = (dt * s / (rho * dxe) / den) as f32;
            self.cu3[i] = (ell / den) as f32;
        }
        for i in 0..n {
            let sl = if i > 0 { self.s_half[i - 1] } else { 0.0 };
            let sr = if i < n - 1 { self.s_half[i] } else { 0.0 };
            let mut v = 0.5 * dx * (sl + sr);
            self.vol[i] = v;
            if let Some(ev) = extra_vol {
                if i < ev.len() {
                    v += ev[i];
                }
            }
            let kpi = rc2 * dt / v.max(1e-12);
            self.kp[i] = kpi as f32;
            if i >= 1 && i < nth {
                let sn = 0.5 * (sl + sr);
                let rn = (sn / core::f64::consts::PI).sqrt().max(1e-4);
                let ell_t = loss_mult * kpi * kt * sn * dx / rn;
                let den = 1.0 + 0.5 * ell_t * asum;
                self.cp1[i] = ((1.0 - 0.5 * ell_t * asum) / den) as f32;
                self.cp2[i] = (kpi / den) as f32;
                self.cp3[i] = (ell_t / den) as f32;
            }
        }
    }

    /// U^{n−½} → U^{n+½} at all interior half nodes.
    /// (Plain indexed loop over equal-length slices: LLVM drops the bounds
    /// checks and vectorises it — 4×f32 NEON natively, simd128 in wasm.)
    #[inline]
    pub fn step_u(&mut self) {
        let m = self.n - 1;
        let p0 = &self.p[..m];
        let p1 = &self.p[1..m + 1];
        let u = &mut self.u[..m];
        let w0 = &mut self.w0[..m];
        let w1 = &mut self.w1[..m];
        let w2 = &mut self.w2[..m];
        let c1 = &self.cu1[..m];
        let c2 = &self.cu2[..m];
        let c3 = &self.cu3[..m];
        let [d0, d1, d2] = self.dk;
        let [e0, e1, e2] = self.ek;
        for i in 0..m {
            let un = c1[i] * u[i] - c2[i] * (p1[i] - p0[i]) + c3[i] * (w0[i] + w1[i] + w2[i]);
            u[i] = un;
            w0[i] = d0 * w0[i] + e0 * un;
            w1[i] = d1 * w1[i] + e1 * un;
            w2[i] = d2 * w2[i] + e2 * un;
        }
    }

    /// p^n → p^{n+1} at interior nodes 1..n−2 (end nodes handled by caller).
    #[inline]
    pub fn step_p_interior(&mut self) {
        let n = self.n;
        if n < 3 {
            return;
        }
        let nth = self.thermal_nodes.min(n - 1).max(1);
        // nodes 1..nth: with explicit thermal shunt loss
        if nth > 1 {
            let m = nth - 1;
            let p = &mut self.p[1..m + 1];
            let ul = &self.u[..m];
            let ur = &self.u[1..m + 1];
            let (c1, c2, c3) = (&self.cp1[1..m + 1], &self.cp2[1..m + 1], &self.cp3[1..m + 1]);
            let (t0, t1, t2) = (&mut self.th0[1..m + 1], &mut self.th1[1..m + 1], &mut self.th2[1..m + 1]);
            let [d0, d1, d2] = self.dk;
            let [e0, e1, e2] = self.ek;
            for i in 0..m {
                let pn = c1[i] * p[i] - c2[i] * (ur[i] - ul[i]) + c3[i] * (t0[i] + t1[i] + t2[i]);
                p[i] = pn;
                t0[i] = d0 * t0[i] + e0 * pn;
                t1[i] = d1 * t1[i] + e1 * pn;
                t2[i] = d2 * t2[i] + e2 * pn;
            }
        }
        // remaining interior nodes nth..n−2: lossless shunt
        if nth < n - 1 {
            let m = n - 1 - nth;
            let p = &mut self.p[nth..nth + m];
            let kp = &self.kp[nth..nth + m];
            let ul = &self.u[nth - 1..nth - 1 + m];
            let ur = &self.u[nth..nth + m];
            for i in 0..m {
                p[i] -= kp[i] * (ur[i] - ul[i]);
            }
        }
    }

    /// Stored acoustic energy (J) — used by passivity tests.
    pub fn energy(&self, air: &Air) -> f64 {
        let rho = air.rho;
        let rc2 = rho * air.c * air.c;
        let mut e = 0.0;
        for i in 0..self.n {
            let v = self.vol[i];
            e += 0.5 * v / rc2 * (self.p[i] as f64).powi(2);
        }
        for i in 0..self.n - 1 {
            let l = rho * self.dx / self.s_half[i];
            e += 0.5 * l * (self.u[i] as f64).powi(2);
        }
        e
    }

    /// True if any state is non-finite or absurdly large.
    pub fn is_bad(&self) -> bool {
        let lim = 1.0e7f32;
        self.p.iter().any(|x| !(x.abs() < lim)) || self.u.iter().any(|x| !(x.abs() < 10.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tube(n: usize, len: f64, fs: f64, area: impl Fn(f64) -> f64, loss: f64) -> (Tube, Air) {
        let air = Air::at(20.0);
        let mut t = Tube::with_capacity(n);
        t.resize(n);
        let dx = len / (n - 1) as f64;
        for i in 0..n - 1 {
            t.s_half[i] = area((i as f64 + 0.5) * dx);
        }
        t.set_coeffs(dx, 1.0 / fs, &air, loss, None);
        (t, air)
    }

    /// Lossless tube closed at both ends (rigid: U=0 at the boundaries — the
    /// end nodes just integrate the adjacent half-node flow).
    fn step_closed(t: &mut Tube) {
        t.step_u();
        t.step_p_interior();
        let n = t.n;
        t.p[0] -= t.kp[0] * t.u[0];
        t.p[n - 1] += t.kp[n - 1] * t.u[n - 2];
    }

    #[test]
    fn lossless_closed_tube_no_growth() {
        let fs = 192000.0;
        let len = 1.0;
        let c = Air::at(20.0).c;
        let n = (len / (Air::c_max() / fs)).floor() as usize + 1;
        // a conical-ish varying profile to exercise variable area
        let (mut t, air) = tube(n, len, fs, |x| 1e-4 * (1.0 + 8.0 * x).powi(2), 0.0);
        let _ = c;
        // initial Gaussian pressure pulse
        for i in 0..n {
            let x = i as f64 / (n - 1) as f64;
            t.p[i] = (1000.0 * (-((x - 0.3) / 0.03).powi(2)).exp()) as f32;
        }
        // The discrete energy of the staggered scheme is conserved exactly up to
        // an O(Δt) cross term; the physical energy estimate must stay bounded
        // (no growth) over 1 s ≈ 340 round trips.
        let e0 = t.energy(&air);
        let mut e_max: f64 = 0.0;
        for step in 0..(fs as usize) {
            step_closed(&mut t);
            if step % 997 == 0 {
                e_max = e_max.max(t.energy(&air));
            }
        }
        let e1 = t.energy(&air);
        assert!(e_max < 1.05 * e0, "energy grew: {e0} → max {e_max}");
        assert!(e1 > 0.9 * e0, "lossless tube lost energy: {e0} → {e1}");
        assert!(!t.is_bad());
    }

    #[test]
    fn lossy_tube_decays() {
        let fs = 192000.0;
        let n = (0.7 / (Air::c_max() / fs)).floor() as usize + 1;
        let (mut t, air) = tube(n, 0.7, fs, |_| 2e-4, 1.0);
        for i in 0..n {
            t.p[i] = (1000.0 * (-(((i as f64) - 100.0) / 10.0).powi(2)).exp()) as f32;
        }
        let e0 = t.energy(&air);
        let mut prev = e0;
        for k in 0..20 {
            for _ in 0..10000 {
                step_closed(&mut t);
            }
            let e = t.energy(&air);
            assert!(e <= prev * 1.02, "energy grew at chunk {k}: {prev} → {e}");
            prev = e;
        }
        assert!(prev < 0.9 * e0, "no decay: {e0} → {prev}");
    }

    /// Cylinder closed at x=0, open (p=0) at x=L: resonances (2k−1)c/4L.
    #[test]
    fn cylinder_resonances() {
        let fs = 192000.0;
        let len = 0.5;
        let air = Air::at(20.0);
        let n = (len / (Air::c_max() / fs)).floor() as usize + 1;
        let (mut t, _) = tube(n, len, fs, |_| 2e-4, 0.0);
        let steps = (fs * 0.5) as usize;
        let mut rec = Vec::with_capacity(steps);
        t.p[0] = 1.0;
        for _ in 0..steps {
            t.step_u();
            t.step_p_interior();
            t.p[0] -= t.kp[0] * t.u[0];
            t.p[n - 1] = 0.0;
            rec.push(t.p[0] as f64);
        }
        // DFT magnitude peaks near the analytic resonances
        for k in 1..=4 {
            let f_exact = (2 * k - 1) as f64 * air.c / (4.0 * len);
            let mut best = (0.0, 0.0);
            let mut f = f_exact * 0.97;
            while f < f_exact * 1.03 {
                let w = 2.0 * core::f64::consts::PI * f / fs;
                let (mut re, mut im) = (0.0, 0.0);
                for (i, v) in rec.iter().enumerate() {
                    let win = 0.5 - 0.5 * (2.0 * core::f64::consts::PI * i as f64 / steps as f64).cos();
                    re += v * win * (w * i as f64).cos();
                    im += v * win * (w * i as f64).sin();
                }
                let m = re * re + im * im;
                if m > best.1 {
                    best = (f, m);
                }
                f += f_exact * 0.0005;
            }
            let cents = 1200.0 * (best.0 / f_exact).log2();
            assert!(cents.abs() < 5.0, "mode {k}: {} vs {} ({cents:.1} cents)", best.0, f_exact);
        }
    }
}
