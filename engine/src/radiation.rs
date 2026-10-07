//! Passive lumped terminations: series inertance L_s + series resistance R_s
//! feeding a radiation load R_r ∥ L_r (parallel RL approximation of the
//! Levine–Schwinger impedance, matching the low-frequency end correction and
//! radiation resistance exactly):
//!
//!   Z_rad(jω) = jωL_r R_r / (R_r + jωL_r)
//!   low ω:  jωL_r + ω²L_r²/R_r   ⇒  L_r = ρδ/S,  R_r = Z_c·(δ/a)²/κ
//!   with δ the end correction and Re{Z}=Z_c (ka)²·κ (κ = 1/4 unflanged, 1/2 flanged).
//!
//! The network is integrated with the trapezoidal rule and solved *jointly*
//! with the update of the bore node it hangs on (node compliance included), so
//! the coupling is unconditionally stable and passive for any element values
//! (including L_s = 0 at the bell and R_s → ∞ for a closing pad).
//!
//!   node:  p⁺ = p_tmp − K·Ū,   p̄ = (pⁿ + p⁺)/2,  Ū = (I_sⁿ + I_s⁺)/2
//!   L_s δ_t I_s = p̄ − R_s Ī_s − R_r (Ī_s − Ī_L)      (Ī_s = θI⁺+(1−θ)Iⁿ)
//!   L_r δ_t I_L = R_r (Ī_s − Ī_L)
//! where p_tmp is the node pressure updated with all other flows.
//! R_s may include a flow-dependent jet-separation term knl·|U| (nonlinear
//! losses at small holes, Dalmont et al. 2002 / Atig et al. 2004), evaluated
//! with the previous step's flow. The quasi-steady coefficient knl0 is reduced by
//! a Strouhal-number factor 1/(1 + (St/St_c)²), St = ω r / v̂ (Ingard & Ising 1967;
//! Disselhorst & van Wijngaarden 1980; Atig et al. 2004): vortex shedding at the
//! hole edge only becomes quasi-steady once the acoustic particle displacement
//! v̂/ω exceeds the edge scale r. ω and v̂ are estimated from running mean squares
//! of the branch flow and its derivative (τ ≈ 5 ms), refreshed every 64 steps.
//! R_nl ≥ 0 is frozen within a step, so the branch stays passive.

#[derive(Clone, Copy, Debug, Default)]
pub struct Termination {
    /// L_s / (θΔt)
    a: f64,
    /// θ of the series branch: ½ (trapezoid) normally, 1 (backward Euler) when
    /// R_s dominates (nearly closed pad) to avoid the trapezoid's undamped
    /// Nyquist mode for stiff RL branches.
    theta: f64,
    rs: f64,
    /// nonlinear (jet separation) resistance coefficient: R_nl = knl·|U|
    /// (effective, = knl0 × Strouhal factor)
    pub knl: f64,
    /// quasi-steady coefficient K ρ /(2 S_e²) and the Strouhal parameters
    pub knl0: f64,
    /// edge length scale r (m) and 1/S_e (m⁻²) for St = ω r / (Û/S_e)
    pub st_r: f64,
    pub st_inv_s: f64,
    /// running mean squares of U and dU/dt, their update coefficient, step counter
    ums: f64,
    dms: f64,
    ms_a: f64,
    st_n: u32,
    rr: f64,
    /// 2 L_r / Δt
    b: f64,
    /// series current (at integer steps)
    pub is: f64,
    /// radiation-inertance current
    pub il: f64,
    /// flow leaving the node over the last step (m³/s)
    pub u: f64,
    /// dU/dt over the last step (for monopole radiation)
    pub dudt: f64,
    pub closed: bool,
    /// cached 1/(b + R_r) and the linear-part G, J coefficients
    inv_brr: f64,
    m11_lin: f64,
    inv_det_lin: f64,
}

/// Strouhal-number transition of the jet loss (St_c), mean-square time constant (s)
/// and refresh interval (steps) of the Strouhal factor.
pub const ST_C: f64 = 1.0;
pub const ST_TAU: f64 = 0.005;
pub const ST_EVERY: u32 = 64;

/// Constants of the one-division joint node/termination step (`Termination::step_pre`).
#[derive(Clone, Copy, Debug, Default)]
pub struct StepCoefs {
    pub h22: f64,
    pub hk: f64,
    pub base_det: f64,
    pub m22: f64,
    pub rnl_min: f64,
    pub a_is: f64,
    pub b_il: f64,
    pub f1: f64,
    pub f2: f64,
    pub g1: f64,
    pub g2: f64,
}

/// Radiation parameters of an opening of radius `a` (m).
/// `delta_over_a` = end correction / a, `kappa` = Re{Z}/(Z_c (ka)²).
pub fn radiation_rl(rho: f64, c: f64, a: f64, delta_over_a: f64, kappa: f64) -> (f64, f64) {
    let s = core::f64::consts::PI * a * a;
    let zc = rho * c / s;
    let lr = rho * delta_over_a * a / s;
    let rr = zc * delta_over_a * delta_over_a / kappa;
    (rr, lr)
}

impl Termination {
    /// Configure. `ls`, `rs` series inertance & resistance; `rr`,`lr` radiation load.
    pub fn set(&mut self, dt: f64, ls: f64, rs: f64, rr: f64, lr: f64) {
        self.ms_a = (dt / ST_TAU).min(1.0);
        self.theta = if rs * dt > ls { 1.0 } else { 0.5 };
        self.a = ls / (self.theta * dt);
        self.rs = rs;
        self.rr = rr;
        self.b = 2.0 * lr / dt;
        self.closed = false;
        self.inv_brr = 1.0 / (self.b + rr).max(1e-300);
        self.m11_lin = self.a + rs + rr;
        let det = self.m11_lin * (self.b + rr) - rr * rr;
        self.inv_det_lin = if det > 1e-300 { 1.0 / det } else { 0.0 };
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.reset();
    }

    /// Configure the amplitude-dependent jet loss: quasi-steady coefficient
    /// `knl0` = Kρ/(2S_e²), edge scale `r` (m), exit area `s_exit` (m²).
    pub fn set_nonlinear(&mut self, knl0: f64, r: f64, s_exit: f64) {
        self.knl0 = knl0;
        self.st_r = r;
        self.st_inv_s = if s_exit > 0.0 { 1.0 / s_exit } else { 0.0 };
        self.update_strouhal();
    }

    /// knl = knl0 / (1 + (St/St_c)²), St = ω r / v̂ from the running mean squares.
    #[inline]
    fn update_strouhal(&mut self) {
        if self.knl0 == 0.0 || self.st_r <= 0.0 {
            self.knl = self.knl0;
            return;
        }
        let ums = self.ums.max(1e-30);
        let v_hat = (2.0 * ums).sqrt() * self.st_inv_s;
        let omega = (self.dms / ums).sqrt();
        let st = omega * self.st_r / v_hat.max(1e-9);
        let x = st / ST_C;
        self.knl = self.knl0 / (1.0 + x * x);
    }

    #[inline]
    fn track(&mut self, u: f64, dudt: f64) {
        let a = self.ms_a;
        self.ums += a * (u * u - self.ums);
        self.dms += a * (dudt * dudt - self.dms);
        self.st_n += 1;
        if self.st_n >= ST_EVERY {
            self.st_n = 0;
            self.update_strouhal();
        }
    }

    pub fn reset(&mut self) {
        self.ums = 0.0;
        self.dms = 0.0;
        self.st_n = 0;
        self.update_strouhal();
        self.is = 0.0;
        self.il = 0.0;
        self.u = 0.0;
        self.dudt = 0.0;
    }

    /// Affine relation of the step-averaged branch flow to the step-averaged
    /// branch pressure: Ū = G·p̄ + J (trapezoid/θ discretisation of the network,
    /// nonlinear resistance frozen at the previous step's |U|). Closed → (0, 0).
    #[inline]
    pub fn affine(&self) -> (f64, f64) {
        if self.closed {
            return (0.0, 0.0);
        }
        let rr = self.rr;
        let m22 = self.b + rr;
        let rnl = self.knl * self.u.abs();
        let inv = if rnl < 1e-6 * self.m11_lin {
            self.inv_det_lin
        } else {
            let det = (self.m11_lin + rnl) * m22 - rr * rr;
            if !(det > 1e-300) {
                return (0.0, 0.0);
            }
            1.0 / det
        };
        (m22 * inv, (m22 * self.a * self.is + rr * self.b * self.il) * inv)
    }

    /// Commit the step given the solved step-averaged flow Ū.
    #[inline]
    pub fn finish(&mut self, ubar: f64, inv_dt: f64) {
        if self.closed {
            self.u = 0.0;
            self.dudt = 0.0;
            return;
        }
        let il_bar = (self.b * self.il + self.rr * ubar) * self.inv_brr;
        let th = self.theta;
        self.is = (ubar - (1.0 - th) * self.is) / th;
        self.il = 2.0 * il_bar - self.il;
        // radiated monopole strength from the step-averaged flow
        self.dudt = (ubar - self.u) * inv_dt;
        self.u = ubar;
        self.track(ubar, self.dudt);
    }

    /// Per-step constants of `step` for a node of gain `k` (valid until the next
    /// `set`): the same network solved with ONE division per step.
    ///   Ū = [m22·½(pⁿ+p_tmp) + m22·a·I_s + R_r·b·I_L] / [(m11 + R_nl)·m22 − R_r² + ½·m22·k]
    ///   I_s ← Ū/θ − (1−θ)/θ·I_s,   I_L ← (2b/(b+R_r) − 1)·I_L + 2R_r/(b+R_r)·Ū
    /// (algebraically identical to `affine` + `finish`, including the
    /// R_nl < 10⁻⁶·m11 cut-off).
    pub fn step_coefs(&self, k: f64) -> StepCoefs {
        let m22 = self.b + self.rr;
        let th = if self.theta > 0.0 { self.theta } else { 0.5 };
        StepCoefs {
            h22: 0.5 * m22,
            hk: 0.5 * m22 * k,
            base_det: self.m11_lin * m22 - self.rr * self.rr,
            m22,
            rnl_min: 1e-6 * self.m11_lin,
            a_is: m22 * self.a,
            b_il: self.rr * self.b,
            f1: 2.0 * self.b * self.inv_brr - 1.0,
            f2: 2.0 * self.rr * self.inv_brr,
            g1: 1.0 / th,
            g2: (1.0 - th) / th,
        }
    }

    /// `step` with precomputed `StepCoefs` (open termination only).
    #[inline]
    pub fn step_pre(&mut self, c: &StepCoefs, p_old: f64, p_tmp: f64, inv_dt: f64) -> f64 {
        // (like `affine`, the jet-loss term is dropped below 10⁻⁶·m11)
        let rnl = self.knl * self.u.abs();
        let d = if rnl < c.rnl_min { c.base_det } else { c.base_det + c.m22 * rnl };
        let u = if d > 1e-300 { (c.h22 * (p_old + p_tmp) + c.a_is * self.is + c.b_il * self.il) / (d + c.hk) } else { 0.0 };
        self.is = c.g1 * u - c.g2 * self.is;
        self.il = c.f1 * self.il + c.f2 * u;
        self.dudt = (u - self.u) * inv_dt;
        self.u = u;
        self.track(u, self.dudt);
        u
    }

    /// Joint step with a single node. `p_old` = pⁿ, `p_tmp` = node pressure after
    /// all other flows, `k` = ρc²Δt/V of the node. Returns Ū leaving the node;
    /// the caller sets p^{n+1} = p_tmp − k·Ū.
    #[inline]
    pub fn step(&mut self, p_old: f64, p_tmp: f64, k: f64, inv_dt: f64) -> f64 {
        let (g, j) = self.affine();
        let u = (g * 0.5 * (p_old + p_tmp) + j) / (1.0 + 0.5 * g * k);
        self.finish(u, inv_dt);
        u
    }
}
