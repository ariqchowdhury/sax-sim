//! Player's vocal tract (PHYSICS.md §7): glottis → pharynx → oral cavity →
//! mouth cavity sealed by the lips around the mouthpiece. A 1-D Webster FDTD
//! tube (same solver as the bore) at the internal time step but on a coarser
//! grid (Δx ≈ 5 mm; λ < 1 is stable, dispersion < 2 cents below 2 kHz), with an
//! articulatory area function (neutral Story/Maeda-style tract + Gaussian
//! tongue-body and tongue-tip constrictions). Soft walls: boundary-layer losses
//! ×3 (was ×10): gives tract resonance bandwidths of the order of measured
//! formant bandwidths (~60–100 Hz near 1 kHz, Fant 1972) and tract input-impedance
//! peaks of 15–50 MPa·s/m³ for a high front tongue, as measured on saxophonists
//! (Chen, Smith & Wolfe 2008/2011; Scavone et al. 2008). Air at 37 °C, saturated.

use crate::air::Air;
use crate::fdtd::Tube;

pub const TRACT_LEN: f64 = 0.17;
pub const WALL_LOSS_MULT: f64 = 3.0;
/// target spatial step (m)
pub const TRACT_DX: f64 = 0.005;
/// anechoic subglottal load ρc/A_sub of the simplified model (`sub_on` = false)
pub const SUBGLOTTAL_AREA: f64 = 2.5e-4;
/// glottal duct length for its viscous resistance (m)
pub const GLOTTIS_DUCT_LEN: f64 = 0.003;
/// length of the glottal section at the start of the tract area function (m)
pub const GLOTTIS_SECTION: f64 = 0.004;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TractControls {
    pub tongue_x: f64,
    pub tongue_y: f64,
    pub tongue_tip: f64,
    pub jaw_open: f64,
    /// glottal area (m²): the first tract section (≈ glottal slit + end corrections, one
    /// grid cell ≈ 5 mm) — its inertance ρℓ/A_g makes the glottal end reflective when the
    /// player narrows the glottis, which strengthens the tract resonances (altissimo).
    pub glottis_area: f64,
    /// tongue-dorsum contact length 0…1: σ of the tongue-body constriction 2 → 4 cm (a bunched
    /// tongue raised against the palate forms a long narrow channel, as for /i/–/u/)
    pub tongue_len: f64,
}

impl Default for TractControls {
    fn default() -> Self {
        TractControls { tongue_x: 0.5, tongue_y: 0.4, tongue_tip: 0.3, jaw_open: 0.3, glottis_area: 1.61e-4, tongue_len: 0.0 }
    }
}

/// Cross-sectional area (m²) at distance x (m) from the glottis (PHYSICS.md §7).
pub fn tract_area(x: f64, c: &TractControls) -> f64 {
    if x < GLOTTIS_SECTION {
        return c.glottis_area.clamp(0.02e-4, 1.8e-4);
    }
    let jaw = c.jaw_open.clamp(0.0, 1.0);
    // neutral tract (cm²)
    let base = if x < 0.020 {
        1.8
    } else if x < 0.075 {
        3.5
    } else if x < 0.095 {
        2.8
    } else if x < 0.150 {
        3.0 + 2.5 * jaw
    } else {
        2.0 + 2.0 * jaw
    };
    let mut a = base;
    // tongue body
    let xc = 0.065 + 0.075 * (1.0 - c.tongue_x.clamp(0.0, 1.0));
    let sig = 0.020 * (1.0 + c.tongue_len.clamp(0.0, 1.0));
    let g = (-(x - xc) * (x - xc) / (2.0 * sig * sig)).exp();
    a = (a * (1.0 - 0.97 * c.tongue_y.clamp(0.0, 1.0) * g)).max(0.10);
    // tongue tip
    let st = 0.006;
    let gt = (-(x - 0.158) * (x - 0.158) / (2.0 * st * st)).exp();
    a = (a * (1.0 - 0.9 * c.tongue_tip.clamp(0.0, 1.0) * gt)).max(0.15);
    a * 1e-4
}

pub struct Tract {
    pub tube: Tube,
    pub ctrl: TractControls,
    /// subglottal airways below the glottis (`sub_on`), else the anechoic load ρc/A_sub
    pub sub: Subglottal,
    pub sub_on: bool,
    /// glottal flow (m³/s) of the last step and the (p_pre, k) of its subglottal side
    pub u_glottis: f64,
    glot_pre: (f64, f64),
}

impl Tract {
    pub fn new(cap: usize) -> Self {
        let mut sub = Subglottal::default();
        sub.build(1.0 / 384000.0, &Air::breath()); // reserve the largest grid
        Tract { tube: Tube::with_capacity(cap), ctrl: TractControls::default(), sub, sub_on: true, u_glottis: 0.0, glot_pre: (0.0, 0.0) }
    }

    /// Pre-pressurise tract and subglottal airways at a static pressure.
    pub fn prefill(&mut self, p: f64) {
        self.tube.p.iter_mut().for_each(|x| *x = p as f32);
        self.sub.prefill(p);
    }

    pub fn clear_state(&mut self) {
        self.tube.clear_state();
        self.sub.clear_state();
        self.u_glottis = 0.0;
        self.glot_pre = (0.0, 0.0);
    }

    /// Glottis, first half: advance the subglottal airways and return (p_sub_pre, k_sub) such
    /// that the pressure below the glottis after this step is p_sub_pre − k_sub·U_g.
    /// Without the subglottal model: the anechoic load, p_sub = P_L − R_sub (U_g − Ū_g).
    #[inline]
    pub fn subglottal_pre(&mut self, p_lung: f64, ug_mean: f64, r_sub: f64) -> (f64, f64) {
        let r = if self.sub_on { self.sub.step(p_lung, ug_mean) } else { (p_lung + r_sub * ug_mean, r_sub) };
        self.glot_pre = r;
        r
    }

    /// Glottis, second half: the glottal flow of this step.
    #[inline]
    pub fn subglottal_post(&mut self, ug: f64) {
        if self.sub_on {
            self.sub.set_top(ug);
        }
        self.u_glottis = ug;
    }

    /// Pressure just below the glottis (Pa) after the last step.
    pub fn p_subglottal(&self) -> f64 {
        self.glot_pre.0 - self.glot_pre.1 * self.u_glottis
    }

    pub fn is_bad(&self) -> bool {
        self.tube.is_bad() || (self.sub_on && self.sub.is_bad())
    }

    /// Pressure impulse response at the mouth node (Pa per 1e-9 m³ volume impulse … scaled to
    /// Pa·s/m³ per sample: the input impedance's impulse response) with the glottis linearised
    /// about a mean flow `ug_mean` (Bernoulli 2ρŪ/(2A_g²) + viscous duct) and the subglottal
    /// airways (or the anechoic ρc/A_sub load when `sub_on` is false). Not real-time.
    pub fn mouth_impulse_response(&self, dt: f64, ug_mean: f64, steps: usize) -> Vec<f64> {
        let air = Air::breath();
        let mut t = self.tube.clone();
        t.clear_state();
        let mut sub = self.sub.clone();
        sub.clear_state();
        let m = t.n - 1;
        let ag = tract_area(0.0, &self.ctrl);
        let dg = ag / 0.018;
        let r_glot = air.rho * ug_mean.abs() / (ag * ag) + 12.0 * air.eta * GLOTTIS_DUCT_LEN / (ag * dg * dg);
        let r_sub = air.rho * air.c / SUBGLOTTAL_AREA;
        let mut z = Vec::with_capacity(steps);
        for s in 0..steps {
            t.step_u();
            let pm = t.p[m] as f64;
            let p0 = t.p[0] as f64;
            t.step_p_interior();
            let k0 = t.kp[0] as f64;
            let u0 = t.u[0] as f64;
            let (ps, ks) = if self.sub_on { sub.step(0.0, 0.0) } else { (0.0, r_sub) };
            let ug = (ps - p0 + k0 * u0) / (r_glot + ks + k0);
            t.p[0] = (p0 + k0 * (ug - u0)) as f32;
            if self.sub_on {
                sub.set_top(ug);
            }
            let km = t.kp[m] as f64;
            let uin = if s == 0 { 1e-9 / dt } else { 0.0 };
            t.p[m] = (pm + km * (t.u[m - 1] as f64 + uin)) as f32;
            z.push(t.p[m] as f64 * 1e9);
        }
        z
    }

    /// Number of nodes: Δx ≈ TRACT_DX but never below c_max·Δt (CFL).
    pub fn nodes_for(dt: f64) -> usize {
        let dx = TRACT_DX.max(Air::c_max() * dt);
        ((TRACT_LEN / dx).floor() as usize).max(4) + 1
    }

    pub fn build(&mut self, dt: f64) {
        let n = Self::nodes_for(dt);
        self.tube.resize(n);
        self.sub.build(dt, &Air::breath());
    }

    pub fn update_coeffs(&mut self, dt: f64, air: &Air) {
        let n = self.tube.n;
        let dx = TRACT_LEN / (n - 1) as f64;
        for i in 0..n - 1 {
            self.tube.s_half[i] = tract_area((i as f64 + 0.5) * dx, &self.ctrl);
        }
        self.tube.set_coeffs(dx, dt, air, WALL_LOSS_MULT, None);
        // the subglottal airways depend on Δt and the (fixed) breath air only: refresh them only
        // when Δt changed — this runs at the control rate while the player moves the tongue
        if self.sub.dtf != dt as f32 {
            self.sub.set_coeffs(dt, air);
        }
    }
}

// ------------------------------------------------------------------ subglottal system

/// Weibel (1963) symmetric airway model A, generations 0 (trachea) … 9:
/// (duct diameter, duct length) in m. Generation g has 2^g ducts in parallel.
const WEIBEL: [(f64, f64); 10] = [
    (0.0180, 0.1200),
    (0.0122, 0.0476),
    (0.0083, 0.0190),
    (0.0056, 0.0076),
    (0.0045, 0.0127),
    (0.0035, 0.0107),
    (0.0028, 0.0090),
    (0.0023, 0.0076),
    (0.00186, 0.0064),
    (0.00154, 0.0054),
];
/// length scale applied to the Weibel lengths (adult at FRC: trachea 10.4 cm), diameters kept
/// (trachea 2.5 cm²) — places Sg1–Sg3 at ≈ 540, 1420, 2300 Hz (Fant / Ishizaka 1976 / Lulich 2010:
/// ≈ 550–650, 1350–1550, 2200–2400 Hz).
pub const SUBGLOTTAL_LEN_SCALE: f64 = 0.87;
/// airway wall per unit area (yielding cartilage + mucosa): mass (kg/m²), resistance (Pa·s/m),
/// stiffness (Pa/m). The mass/resistance follow soft-tissue values (Ishizaka et al. 1975/76);
/// the stiffness is that of a cartilaginous airway (static bulge ≈ 0.5 mm at 5 kPa).
pub const SUB_WALL_M: f64 = 8.0;
pub const SUB_WALL_R: f64 = 1.0e4;
pub const SUB_WALL_K: f64 = 1.0e7;
/// target spatial step (m): dispersion < 1 % below 2.5 kHz at the internal rates
pub const SUB_DX: f64 = 0.010;
/// reference frequency of the frequency-independent boundary-layer losses (Hz)
const SUB_LOSS_FREF: f64 = 1000.0;

/// Subglottal geometry at distance `s` (m) below the glottis: (total area m², duct count, duct
/// diameter m). Beyond generation 9 the tree is represented by its resistive termination.
pub fn subglottal_geom(s: f64) -> (f64, f64, f64) {
    let mut z = 0.0;
    for (g, &(d, l)) in WEIBEL.iter().enumerate() {
        z += l * SUBGLOTTAL_LEN_SCALE;
        if s < z || g == WEIBEL.len() - 1 {
            let n = (1u32 << g) as f64;
            return (n * core::f64::consts::PI * d * d / 4.0, n, d);
        }
    }
    unreachable!()
}

pub fn subglottal_len() -> f64 {
    WEIBEL.iter().map(|w| w.1).sum::<f64>() * SUBGLOTTAL_LEN_SCALE
}

/// The player's subglottal airways (trachea + bronchial tree, generations 0–9 of Weibel's
/// symmetric model) as a 1-D lossy transmission line of the total cross-section with
/// visco-thermal boundary-layer losses of the 2^g parallel ducts (series, at 1 kHz), yielding walls
/// (mass–resistance–stiffness per node) and a resistive termination ρc/A into the deeper
/// airways, which are driven by the lung pressure. Node 0 = deepest, node n−1 = just below the
/// glottis; U > 0 flows upward. Leapfrog at the internal rate, f32 state; arrays are padded to
/// a multiple of 4 with zero-gain lanes so every sweep is a fixed-length vector loop.
#[derive(Clone, Default)]
pub struct Subglottal {
    pub n: usize,
    pub dx: f64,
    /// padded length (multiple of 4, ≥ n)
    np: usize,
    /// pressure (Pa) at nodes 0..n (len np + 1)
    pub p: Vec<f32>,
    /// volume velocity (m³/s) of half node i stored at us[i + 1]; us[0] = 0 (len np + 1)
    us: Vec<f32>,
    /// wall volume velocity and volume displacement per node
    uw: Vec<f32>,
    xw: Vec<f32>,
    // U update: u ← au·u + bu·(p_i − p_{i+1})   (0 beyond n − 2)
    au: Vec<f32>,
    bu: Vec<f32>,
    // wall update: uw ← aw·uw + bw·(p − kw·xw)   (0 beyond n − 1)
    aw: Vec<f32>,
    bw: Vec<f32>,
    kw: Vec<f32>,
    // interior p update: p ← q1·p − q2·(U_out − U_in + U_wall); end/pad lanes (1, 0)
    q1: Vec<f32>,
    q2: Vec<f32>,
    /// end nodes (deep: with the termination; top: before the glottal flow)
    q1_0: f64,
    q2_0: f64,
    q1_top: f64,
    r_term: f64,
    /// R_t + ΣR: steady pressure drop per unit mean flow, compensated at the source
    r_dc: f64,
    /// top node: p_top = p_pre − k_top·U_g
    pub k_top: f64,
    p_pre: f64,
    pub(crate) dtf: f32,
}

impl Subglottal {
    pub fn nodes_for(dt: f64) -> usize {
        let dx = SUB_DX.max(1.02 * Air::c_max() * dt);
        ((subglottal_len() / dx).floor() as usize).max(4) + 1
    }

    pub fn build(&mut self, dt: f64, air: &Air) {
        let n = Self::nodes_for(dt);
        self.n = n;
        self.np = (n + 3) / 4 * 4;
        let np = self.np;
        for v in [&mut self.p, &mut self.us] {
            v.clear();
            v.resize(np + 1, 0.0);
        }
        for v in [&mut self.uw, &mut self.xw, &mut self.au, &mut self.bu, &mut self.aw, &mut self.bw, &mut self.kw, &mut self.q1, &mut self.q2] {
            v.clear();
            v.resize(np, 0.0);
        }
        self.set_coeffs(dt, air);
    }

    pub fn set_coeffs(&mut self, dt: f64, air: &Air) {
        let n = self.n;
        let len = subglottal_len();
        let dx = len / (n - 1) as f64;
        self.dx = dx;
        self.dtf = dt as f32;
        let (rho, c) = (air.rho, air.c);
        let rc2 = rho * c * c;
        let w = 2.0 * core::f64::consts::PI * SUB_LOSS_FREF;
        // visco-thermal boundary-layer loss lumped into the series branch (as the bore's k_vt,
        // PHYSICS.md E2): a shunt conductance would leak the static lung pressure
        let rv = (w * rho * air.eta / 2.0).sqrt() * (1.0 + (air.gamma - 1.0) / air.nu);
        let geo = |s: f64| subglottal_geom(s.clamp(0.0, len - 1e-9));
        let mut r_sum = 0.0;
        self.au.iter_mut().for_each(|x| *x = 0.0);
        self.bu.iter_mut().for_each(|x| *x = 0.0);
        for i in 0..n - 1 {
            // half node i at depth (n − 1.5 − i)·Δx below the glottis
            let (a, nd, d) = geo((n as f64 - 1.5 - i as f64) * dx);
            let l = rho * dx / a;
            // N ducts in parallel: R = P_duct/(N·a_duct²)·√(ωρη/2)·Δx
            let ad = a / nd;
            let r = core::f64::consts::PI * d / (nd * ad * ad) * rv * dx;
            r_sum += r;
            let den = l / dt + 0.5 * r;
            self.au[i] = ((l / dt - 0.5 * r) / den) as f32;
            self.bu[i] = (1.0 / den) as f32;
        }
        for k in 0..self.np {
            self.aw[k] = 0.0;
            self.bw[k] = 0.0;
            self.kw[k] = 0.0;
            self.q1[k] = 1.0;
            self.q2[k] = 0.0;
        }
        for k in 0..n {
            let end = k == 0 || k == n - 1;
            let h = if end { 0.5 * dx } else { dx };
            let s = if k == 0 {
                len - 0.25 * dx
            } else if k == n - 1 {
                0.25 * dx
            } else {
                (n as f64 - 1.0 - k as f64) * dx
            };
            let (a, nd, d) = geo(s);
            let cn = a * h / rc2;
            let sw = nd * core::f64::consts::PI * d * h; // wall area
            let (m, rw) = (SUB_WALL_M / sw, SUB_WALL_R / sw);
            let den = m / dt + 0.5 * rw;
            self.aw[k] = ((m / dt - 0.5 * rw) / den) as f32;
            self.bw[k] = (1.0 / den) as f32;
            self.kw[k] = (SUB_WALL_K / sw) as f32;
            let mut den = cn / dt;
            if k == 0 {
                self.r_term = rho * c / a;
                den += 1.0 / self.r_term;
            }
            let q1 = (cn / dt) / den;
            if k == 0 {
                self.q1_0 = q1;
                self.q2_0 = 1.0 / den;
            } else if k == n - 1 {
                self.q1_top = q1;
                self.k_top = 1.0 / den;
            } else {
                self.q1[k] = q1 as f32;
                self.q2[k] = (1.0 / den) as f32;
            }
        }
        self.r_dc = self.r_term + r_sum;
    }

    /// Fill with a static lung pressure (walls at equilibrium, no flow).
    pub fn prefill(&mut self, p: f64) {
        let n = self.n;
        self.p.iter_mut().for_each(|x| *x = 0.0);
        self.p[..n].iter_mut().for_each(|x| *x = p as f32);
        self.us.iter_mut().for_each(|x| *x = 0.0);
        self.uw.iter_mut().for_each(|x| *x = 0.0);
        for k in 0..self.np {
            self.xw[k] = if k < n { (p / self.kw[k] as f64) as f32 } else { 0.0 };
        }
    }

    pub fn clear_state(&mut self) {
        self.prefill(0.0);
    }

    /// Advance U, walls and every node but the top one; returns (p_pre, k_top): the top node's
    /// new pressure will be p_pre − k_top·U_g (U_g = glottal flow, out of the top node).
    /// The lungs drive the deep end through ρc/A with the steady drop R_dc·Ū compensated
    /// (the player sets the lung pressure, so the operating point is unchanged).
    #[inline]
    pub fn step(&mut self, p_lung: f64, u_mean: f64) -> (f64, f64) {
        let (n, np) = (self.n, self.np);
        let m = n - 1;
        // fixed-length, equal-length slices: no bounds checks, vector loops
        {
            let (pl, pr) = (&self.p[..np], &self.p[1..np + 1]);
            let u = &mut self.us[1..np + 1];
            let (au, bu) = (&self.au[..np], &self.bu[..np]);
            for i in 0..np {
                u[i] = au[i] * u[i] + bu[i] * (pl[i] - pr[i]);
            }
        }
        {
            let (uw, xw, p) = (&mut self.uw[..np], &mut self.xw[..np], &self.p[..np]);
            let (aw, bw, kw) = (&self.aw[..np], &self.bw[..np], &self.kw[..np]);
            let dt = self.dtf;
            for k in 0..np {
                let v = aw[k] * uw[k] + bw[k] * (p[k] - kw[k] * xw[k]);
                uw[k] = v;
                xw[k] += v * dt;
            }
        }
        let (p0, pm) = (self.p[0] as f64, self.p[m] as f64);
        {
            let p = &mut self.p[..np];
            let (q1, q2, uw) = (&self.q1[..np], &self.q2[..np], &self.uw[..np]);
            let (ul, ur) = (&self.us[..np], &self.us[1..np + 1]);
            for k in 0..np {
                p[k] = q1[k] * p[k] - q2[k] * (ur[k] - ul[k] + uw[k]);
            }
        }
        let ps = p_lung + self.r_dc * u_mean;
        self.p[0] = (self.q1_0 * p0 + self.q2_0 * (ps / self.r_term - self.us[1] as f64 - self.uw[0] as f64)) as f32;
        self.p_pre = self.q1_top * pm + self.k_top * (self.us[m] as f64 - self.uw[m] as f64);
        (self.p_pre, self.k_top)
    }

    /// Close the step with the glottal flow U_g (out of the top node).
    #[inline]
    pub fn set_top(&mut self, ug: f64) {
        let m = self.n - 1;
        self.p[m] = (self.p_pre - self.k_top * ug) as f32;
    }

    /// Volume velocity at half node i (upward, m³/s).
    pub fn u(&self, i: usize) -> f32 {
        self.us[i + 1]
    }

    pub fn is_bad(&self) -> bool {
        self.p.iter().any(|x| !(x.abs() < 1.0e7)) || self.us.iter().any(|x| !(x.abs() < 10.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub_at(fs: f64) -> (Subglottal, f64) {
        let dt = 1.0 / fs;
        let mut s = Subglottal::default();
        s.build(dt, &Air::breath());
        s.clear_state();
        (s, dt)
    }

    /// |Z| at the glottis from the impulse response, local maxima below 3 kHz.
    fn sub_peaks(fs: f64) -> Vec<(f64, f64)> {
        let (mut s, dt) = sub_at(fs);
        let steps = (0.15 / dt) as usize;
        let mut z = Vec::with_capacity(steps);
        for k in 0..steps {
            s.step(0.0, 0.0);
            s.set_top(if k == 0 { -1e-9 / dt } else { 0.0 });
            z.push(s.p[s.n - 1] as f64 * 1e9 * dt);
        }
        let mag = |f: f64| {
            let w = 2.0 * core::f64::consts::PI * f * dt;
            let (mut re, mut im) = (0.0, 0.0);
            for (k, v) in z.iter().enumerate() {
                re += v * (w * k as f64).cos();
                im -= v * (w * k as f64).sin();
            }
            (re * re + im * im).sqrt()
        };
        let fs_: Vec<f64> = (0..290).map(|i| 100.0 + 10.0 * i as f64).collect();
        let m: Vec<f64> = fs_.iter().map(|&f| mag(f)).collect();
        (1..m.len() - 1).filter(|&i| m[i] > m[i - 1] && m[i] >= m[i + 1]).map(|i| (fs_[i], m[i])).collect()
    }

    #[test]
    fn subglottal_resonances() {
        for fs in [96000.0, 192000.0] {
            let pk = sub_peaks(fs);
            assert!(pk.len() >= 3, "{pk:?}");
            let want = [(480.0, 620.0), (1300.0, 1550.0), (2150.0, 2450.0)];
            for (k, &(lo, hi)) in want.iter().enumerate() {
                assert!(pk[k].0 > lo && pk[k].0 < hi, "Sg{} at {} Hz (fs {fs})", k + 1, pk[k].0);
                // damped: peak a few × ρc/A_trachea, not a high-Q resonance
                assert!(pk[k].1 > 2e6 && pk[k].1 < 1.5e7, "Sg{} |Z| {}", k + 1, pk[k].1);
            }
        }
    }

    #[test]
    fn subglottal_static_pressure_and_stability() {
        let (mut s, _) = sub_at(192000.0);
        let pl = 5000.0;
        s.prefill(pl);
        // steady glottal flow 0.2 L/s with the mean known: the top settles at the lung pressure
        let ug = 2e-4;
        let mut top = 0.0;
        for k in 0..192000 {
            let ac = 1e-4 * ((k as f64 * 0.037).sin());
            s.step(pl, ug);
            s.set_top(ug + if k < 96000 { ac } else { 0.0 });
            top = s.p[s.n - 1] as f64;
        }
        assert!((top - pl).abs() < 5.0, "top {top}");
        assert!(!s.is_bad());
        // and a silent system stays silent
        let (mut s, _) = sub_at(48000.0);
        for _ in 0..1000 {
            s.step(0.0, 0.0);
            s.set_top(0.0);
        }
        assert!(s.p.iter().all(|&x| x == 0.0));
    }
}
