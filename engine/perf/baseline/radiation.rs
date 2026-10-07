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
//! with the previous step's flow.

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
    pub knl: f64,
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

    pub fn reset(&mut self) {
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
