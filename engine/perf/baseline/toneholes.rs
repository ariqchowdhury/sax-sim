//! Tone holes as side branches.
//!
//! A chimney of height t and radius a is much shorter than any wavelength of
//! interest (t ≲ 15 mm vs λ ≥ 100 mm at 3 kHz), so it is discretised as ONE
//! lumped cell of the same staggered scheme: its air volume S_h·t is added to the
//! compliance of the bore node it sits on, and its air mass (plus the inner
//! end correction and the pad-curtain mass) forms the series inertance of the
//! branch. The outer end sees the radiation load (R∥L). A pad at height h adds
//! the curtain inertance ρ·κ_p/h and a Poiseuille slit resistance
//! 12η·w_rim/(2πa·h³); as h → 0 the branch becomes rigid continuously. At
//! openness < ε the branch is exactly closed (U = 0, rigid cap).
//!
//! Volume-velocity conservation: U_branch is removed from the bore node's
//! continuity equation (p_i −= K_i·U_branch).

use crate::air::Air;
use crate::radiation::{radiation_rl, Termination};

pub const OPEN_EPS: f64 = 1e-3;
/// nonlinear jet-loss coefficient K (sharp-edged holes ≈ 0.6–1.4, Atig et al. 2004)
pub const NONLINEAR_K: f64 = 1.0;

#[derive(Clone, Debug)]
pub struct ToneHole {
    pub id: String,
    /// geometry x (from reed tip)
    pub x: f64,
    pub radius: f64,
    pub chimney: f64,
    pub pad_open_height: f64,
    pub rest_open: bool,
    pub octave_vent: bool,
    /// the hole sits between bore nodes `node` and `node+1` at fraction
    /// `alpha` (PHYSICS.md §1 "hole snapping": p_h = (1−α)p_i + α p_{i+1}, flow
    /// split with the same weights — adjoint pair, passive, no quantisation)
    pub node: usize,
    pub alpha: f64,
    /// bore radius at the hole (for inner end correction)
    pub bore_radius: f64,
    /// current & target openness 0..1
    pub openness: f64,
    pub target: f64,
    pub term: Termination,
    /// ρc²Δt/V of the two attached nodes (copied after coefficient update)
    pub kp: f32,
    pub kp1: f32,
    /// last configured openness (to avoid needless recomputation)
    cfg_open: f64,
    /// listener delay (internal samples) and gain
    pub delay: usize,
    pub gain: f64,
}

impl ToneHole {
    pub fn new(id: &str, x: f64, radius: f64, chimney: f64, pad_h: f64, rest_open: bool, octave: bool) -> Self {
        ToneHole {
            id: id.to_string(),
            x,
            radius: radius.max(5e-4),
            chimney: chimney.max(5e-4),
            pad_open_height: if pad_h > 0.0 { pad_h } else { 0.4 * radius.max(5e-4) },
            rest_open,
            octave_vent: octave,
            node: 0,
            alpha: 0.0,
            bore_radius: 0.0,
            openness: if rest_open { 1.0 } else { 0.0 },
            target: if rest_open { 1.0 } else { 0.0 },
            term: Termination::default(),
            kp: 0.0,
            kp1: 0.0,
            cfg_open: -1.0,
            delay: 0,
            gain: 1.0,
        }
    }

    pub fn area(&self) -> f64 {
        core::f64::consts::PI * self.radius * self.radius
    }

    /// Chimney volume added to the bore node compliance.
    pub fn volume(&self) -> f64 {
        self.area() * self.chimney
    }

    /// Inner (shunt) end correction, Dalmont et al. 2002 / Nederveen 1998.
    pub fn inner_correction(&self) -> f64 {
        let d = (self.radius / self.bore_radius.max(1e-4)).min(1.0);
        self.radius * (0.82 - 0.193 * d - 1.09 * d * d + 1.27 * d * d * d - 0.71 * d * d * d * d).max(0.1)
    }

    /// Branch pressure interpolated between the two attached nodes.
    #[inline]
    pub fn p_at(&self, p: &[f32]) -> f64 {
        (1.0 - self.alpha) * p[self.node] as f64 + self.alpha * p[self.node + 1] as f64
    }

    /// Effective node gain seen by the branch: (1−α)²K_i + α²K_{i+1}.
    #[inline]
    pub fn k_eff(&self) -> f64 {
        let a = self.alpha;
        (1.0 - a) * (1.0 - a) * self.kp as f64 + a * a * self.kp1 as f64
    }

    /// Remove branch flow `u` from the two nodes (adjoint of `p_at`).
    #[inline]
    pub fn apply(&self, p: &mut [f32], u: f64) {
        let a = self.alpha;
        p[self.node] = (p[self.node] as f64 - (1.0 - a) * self.kp as f64 * u) as f32;
        p[self.node + 1] = (p[self.node + 1] as f64 - a * self.kp1 as f64 * u) as f32;
    }

    /// Series (antisymmetric) length correction t_a (Keefe 1990 / Dalmont 2002),
    /// negative; `open` selects the open-hole (tanh) or closed-hole (coth) form.
    pub fn series_correction(&self, open: bool) -> f64 {
        let b = self.radius;
        let d = (b / self.bore_radius.max(1e-4)).min(1.0);
        let th = (1.84 * self.chimney / b).tanh().max(1e-6);
        let f = if open { th } else { 1.0 / th };
        -0.47 * b * d.powi(4) / (f + 0.62 * d * d + 0.64 * d)
    }

    /// Matching-volume length correction t_m (Nederveen 1998).
    pub fn matching_correction(&self) -> f64 {
        let d = (self.radius / self.bore_radius.max(1e-4)).min(1.0);
        self.radius * d * (1.0 + 0.207 * d * d * d) / 8.0
    }

    /// Recompute the branch network for the current openness (PHYSICS.md E3).
    pub fn configure(&mut self, dt: f64, air: &Air, force: bool) {
        let (rho, c) = (air.rho, air.c);
        if !force && (self.openness - self.cfg_open).abs() < 1e-5 {
            return;
        }
        self.cfg_open = self.openness;
        if self.openness < OPEN_EPS {
            self.term.close();
            return;
        }
        let was_closed = self.term.closed;
        let a = self.radius;
        let s = self.area();
        let h = (self.openness * self.pad_open_height).max(1e-7);
        // chimney + inner + matching-volume corrections
        let l_ch = rho * (self.chimney + self.inner_correction() + self.matching_correction()) / s;
        // pad curtain: area 2πah; κ_p calibrated so a fully open pad (h≈0.4a)
        // adds ≈0.3a of end correction (Nederveen / Dalmont pad corrections).
        let a_curtain = 2.0 * core::f64::consts::PI * a * h;
        let l_pad = rho * 0.24 * a / a_curtain;
        // viscous slit flow under nearly closed pad (rim width ~1 mm)
        let w_rim = 1.0e-3;
        let r_pad = 12.0 * air.eta * w_rim / (2.0 * core::f64::consts::PI * a * h * h * h);
        // visco-thermal boundary-layer resistance of the chimney air plug,
        // Re{Z} = k_vt·√(ω/2)/(S a) per unit length, evaluated at 400 Hz
        let k_vt = air.k_vt();
        let w_ref = 2.0 * core::f64::consts::PI * 400.0;
        let r_bl = k_vt * (0.5 * w_ref).sqrt() / (s * a) * (self.chimney + self.inner_correction());
        // radiation from hole in a pipe wall: between flanged and unflanged
        let (rr, lr) = radiation_rl(rho, c, a, 0.7, 1.0 / 3.0);
        self.term.set(dt, l_ch + l_pad, r_pad + r_bl, rr, lr);
        // jet separation at the sharp outer edge / pad curtain: Δp = K ρ U|U| /(2 S_e²)
        let s_exit = s.min(a_curtain);
        self.term.knl = NONLINEAR_K * rho / (2.0 * s_exit * s_exit);
        if was_closed {
            self.term.reset();
        }
    }

    /// Move openness toward target (first order; `coef_close` / `coef_open` for
    /// finger-driven closing τ≈6 ms and spring-driven opening τ≈10 ms) — called
    /// per output sample.
    #[inline]
    pub fn slew(&mut self, coef_close: f64, coef_open: f64) {
        let d = self.target - self.openness;
        if d.abs() > 1e-6 {
            self.openness += if d < 0.0 { coef_close } else { coef_open } * d;
            if (self.target - self.openness).abs() < 2e-4 {
                self.openness = self.target;
            }
        }
    }
}

/// Maximum number of open holes solved jointly (holes sharing bore nodes).
pub const MAX_CLUSTER: usize = 8;

/// Jointly update a cluster of open branches whose node pairs overlap.
/// Unknowns Ū_h; with p̄_h = (p_old_h + p_new_h)/2,
/// p_new_n = p_tmp_n − K_n Σ_g w_gn Ū_g and Ū_h = G_h p̄_h + J_h:
///     Ū_h + (G_h/2) Σ_g C_hg Ū_g = G_h (p_old_h + p_tmp_h)/2 + J_h,
///     C_hg = Σ_n w_hn w_gn K_n.
/// Exact joint (implicit) solution — no Gauss–Seidel splitting error.
pub fn solve_cluster(holes: &mut [ToneHole], idx: &[usize], p_old: &[f64], p: &mut [f32], inv_dt: f64) {
    let m = idx.len();
    if m == 0 {
        return;
    }
    if m == 1 {
        let h = &mut holes[idx[0]];
        let ptmp = h.p_at(p);
        let u = h.term.step(p_old[idx[0]], ptmp, h.k_eff(), inv_dt);
        h.apply(p, u);
        return;
    }
    let m = m.min(MAX_CLUSTER);
    let mut a = [[0.0f64; MAX_CLUSTER]; MAX_CLUSTER];
    let mut r = [0.0f64; MAX_CLUSTER];
    for (ii, &hi) in idx[..m].iter().enumerate() {
        let h = &holes[hi];
        let (g, j) = h.term.affine();
        let ptmp = h.p_at(p);
        r[ii] = g * 0.5 * (p_old[hi] + ptmp) + j;
        let wh = [(h.node, 1.0 - h.alpha, h.kp as f64), (h.node + 1, h.alpha, h.kp1 as f64)];
        for (jj, &gi) in idx[..m].iter().enumerate() {
            let q = &holes[gi];
            let wg = [(q.node, 1.0 - q.alpha), (q.node + 1, q.alpha)];
            let mut c = 0.0;
            for &(nh, w1, k) in &wh {
                for &(ng, w2) in &wg {
                    if nh == ng {
                        c += w1 * w2 * k;
                    }
                }
            }
            a[ii][jj] = 0.5 * g * c + if ii == jj { 1.0 } else { 0.0 };
        }
    }
    // Gaussian elimination with partial pivoting (diagonally dominant in practice)
    for col in 0..m {
        let mut piv = col;
        for row in col + 1..m {
            if a[row][col].abs() > a[piv][col].abs() {
                piv = row;
            }
        }
        a.swap(col, piv);
        r.swap(col, piv);
        let d = a[col][col];
        if d.abs() < 1e-300 {
            continue;
        }
        for row in col + 1..m {
            let f = a[row][col] / d;
            if f != 0.0 {
                for k in col..m {
                    a[row][k] -= f * a[col][k];
                }
                r[row] -= f * r[col];
            }
        }
    }
    let mut u = [0.0f64; MAX_CLUSTER];
    for row in (0..m).rev() {
        let mut s = r[row];
        for k in row + 1..m {
            s -= a[row][k] * u[k];
        }
        u[row] = if a[row][row].abs() > 1e-300 { s / a[row][row] } else { 0.0 };
    }
    for (ii, &hi) in idx[..m].iter().enumerate() {
        holes[hi].term.finish(u[ii], inv_dt);
    }
    for (ii, &hi) in idx[..m].iter().enumerate() {
        let h = &holes[hi];
        h.apply(p, u[ii]);
    }
    // (clusters larger than MAX_CLUSTER: remaining branches one by one)
    for &hi in &idx[m..] {
        let h = &mut holes[hi];
        let ptmp = h.p_at(p);
        let uu = h.term.step(p_old[hi], ptmp, h.k_eff(), inv_dt);
        h.apply(p, uu);
    }
}
