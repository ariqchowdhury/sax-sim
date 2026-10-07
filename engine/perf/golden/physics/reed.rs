//! Reed models. Stage 1 (M1–M3): single-DOF mass–spring–damper with a
//! progressive (curved-lay) Hunt–Crossley contact. Stage 2 (M4): distributed
//! Euler–Bernoulli beam (`reed_beam.rs`); both sit behind `ReedModel`.
//!
//! Sign convention: y = tip displacement toward the lay (closing), measured from
//! the unloaded rest position where the tip opening equals `tip_opening`.
//! Channel opening h = H − y (clipped at 0 for the flow).
//!
//!   m ÿ + r ẏ + K (y − y_eq) + F_c(y, ẏ) = S_r (p_mouth − p_mp) + F_tongue
//!
//! K = k_reed + k_lip, y_eq = F_lip / K. Integrated with the centred scheme
//! m δ_tt y + r δ_t· y + K μ_t· y = F, which is unconditionally stable for the
//! linear part; the contact force is linearised about yⁿ and treated the same way.

#[derive(Clone, Copy, Debug)]
pub struct ReedPhysParams {
    /// unloaded tip opening H (m)
    pub tip_opening: f64,
    /// stiffness at the tip (reed + lip) K (N/m)
    pub k: f64,
    /// static equilibrium displacement from lip force (m)
    pub y_eq: f64,
    /// mass (kg)
    pub m: f64,
    /// damping (N·s/m)
    pub r: f64,
    /// effective area for the pressure force (m²)
    pub s_r: f64,
    /// channel width (m)
    pub width: f64,
    /// displacement where lay contact begins (m)
    pub y_contact: f64,
    /// contact stiffness coefficient: F_c = kc·δ²  (N/m²)
    pub kc: f64,
    /// extra force from the tongue (N, toward closing)
    pub f_tongue: f64,
    /// extra damping from tongue (N·s/m)
    pub r_tongue: f64,
    /// reed-body mode (flexure between lip and tip that continues while the
    /// tip rests on the lay): area, stiffness, mass, damping
    pub s_b: f64,
    pub k_b: f64,
    pub m_b: f64,
    pub r_b: f64,
    /// amplitude-dependent lip damping coefficient (N·s/m per m² of excursion)
    pub r_nl: f64,
}

impl Default for ReedPhysParams {
    fn default() -> Self {
        derive_reed_params(&ReedControls::default())
    }
}

/// Player / mouthpiece controls that determine the reed's lumped parameters.
#[derive(Clone, Copy, Debug)]
pub struct ReedControls {
    pub reed_strength: f64,
    pub reed_damping: f64,
    pub lip_position_mm: f64,
    pub lip_force: f64,
    pub lip_damping: f64,
    pub tip_opening_mm: f64,
    pub facing_length_mm: f64,
    pub tongue_contact: f64,
    pub reed_width: f64,
}

impl Default for ReedControls {
    fn default() -> Self {
        ReedControls {
            reed_strength: 2.5,
            reed_damping: 0.3,
            lip_position_mm: 12.0,
            lip_force: 1.0,
            lip_damping: 0.4,
            tip_opening_mm: 1.9,
            facing_length_mm: 22.0,
            tongue_contact: 0.0,
            reed_width: 0.0135,
        }
    }
}

/// Map controls → lumped reed parameters (see docs/PHYSICS.md §reed).
/// Lipped reed resonance at the default embouchure (Hz), PHYSICS.md §5a: 1.6–2.2 kHz.
pub const REED_FR: f64 = 1900.0;

/// Tip stiffness (reed + lip, N/m, before the BODY_SHARE split) at the default embouchure.
pub const K_DEFAULT: f64 = 321.0;
/// Share of K provided by the lower lip at the default embouchure.
pub const LIP_SHARE: f64 = 0.85;
/// Lip tissue force scale A (N) of the exponential strain-stiffening law.
pub const LIP_A: f64 = 0.15;
/// Share of the moving mass (at the tip) that is lip tissue, at the default.
pub const LIP_MASS_SHARE: f64 = 0.5;
/// Static lip-force → tip-deflection factor (calibrated: H0 ≈ 1.03 mm at 1 N).
/// (×1.0905 compensates the tanh saturation at the default, so H0 is unchanged.)
pub const LIP_STATIC: f64 = 1.0905 * 0.55 * K_DEFAULT * (1.0 - LIP_SHARE) * 0.5 / (K_DEFAULT * 0.5);
/// Saturation of the static lip deflection (fraction of the tip opening).
pub const LIP_Y_SAT: f64 = 0.95;
/// Amplitude-dependent lip damping gain κ (0 = linear lip).
pub const LIP_NL_DAMP: f64 = 0.0;

/// Fraction of the free-reed equivalent volume carried by the body mode.
pub const BODY_SHARE: f64 = 0.5;

pub fn derive_reed_params(c: &ReedControls) -> ReedPhysParams {
    // --- geometry of the vibrating part
    // Vamp (cut) length of the reed; the lower lip touches it `lip_position`
    // from the tip. Free length tip↔lip plus a share of the reed under the lip.
    const VAMP: f64 = 35.0; // mm
    let l_eff = c.lip_position_mm + 8.0;
    let l_ref = 20.0;
    let len_ratio = l_ref / l_eff; // >1 when the lip is near the tip (stiffer)
    // Commercial strength → stiffness: ≈ +18 % per strength unit around 2.5.
    let strength = 0.55 + 0.18 * c.reed_strength;
    // Effective area for the pressure force; grows with the free length.
    // Calibrated with the stiffness so that the reed's equivalent volume
    // V_r = ρc²S_r²/K ≈ 1.08 cm³ at the default embouchure (Nederveen 1998;
    // same value as tools/tmm.py), with p_M = K·H0/S_r ≈ 6.7 kPa.
    let s_r = 4.94e-5 * (1.0 - BODY_SHARE) * len_ratio.powf(-0.5);
    let share = 1.0 - BODY_SHARE;
    // Lever between the lip contact (distance a = VAMP − lip_position from the
    // heel) and the tip of a cantilever: tip/contact deflection ρ = (3L−a)/(2a).
    // A stiffness (mass) k at the contact is seen at the tip as k/ρ².
    let a = (VAMP - c.lip_position_mm).max(1.0);
    let lever = |a: f64| {
        let rho = (3.0 * VAMP - a) / (2.0 * a);
        1.0 / (rho * rho)
    };
    let lever_rel = lever(a) / lever(VAMP - 12.0);
    // --- lower-lip soft tissue (strain-stiffening): F_t(δ) = A (e^{δ/δ0} − 1)
    // ⇒ tangent stiffness dF_t/dδ = (F + A)/δ0 grows linearly with lip force.
    let f_rel = (c.lip_force.max(0.0) + LIP_A) / (1.0 + LIP_A);
    // Stiffness at the tip: reed (cantilever ∝ 1/L³, softened to ∝ L⁻² by the
    // lay support) + lip tissue in parallel. At the default embouchure the lip
    // provides LIP_SHARE of K (total K unchanged from the previous calibration).
    let k_reed = K_DEFAULT * (1.0 - LIP_SHARE) * share * strength * len_ratio * len_ratio;
    let k_lip = K_DEFAULT * LIP_SHARE * share * f_rel * lever_rel;
    let k = k_reed + k_lip;
    // Static lip force is carried by the reed: tip deflection β·F/k_reed with
    // β = a²(3L−a)/(2L³) (cantilever) × lay-support factor (H0 ≈ 1.03 mm at 1 N).
    let beta = a * a * (3.0 * VAMP - a) / (2.0 * VAMP * VAMP * VAMP);
    // The reed wraps onto the curved lay as it is pushed, so the static
    // deflection saturates toward Y_SAT·H_tip (biting at 3 N leaves ~0.2 mm).
    let y_sat = LIP_Y_SAT * c.tip_opening_mm * 1e-3;
    let y_lin = LIP_STATIC * share * beta * c.lip_force / k_reed;
    let y_eq = y_sat * (y_lin / y_sat).tanh();
    // Masses: reed (∝ L^½ at the tip) + lip tissue moving with the reed (seen
    // through the lever); split LIP_MASS_SHARE / rest at the default, where
    // f_r = REED_FR (scaled by √strength as before).
    let w_def = 2.0 * core::f64::consts::PI * REED_FR;
    let m_def = K_DEFAULT * share / (w_def * w_def);
    let m = m_def * ((1.0 - LIP_MASS_SHARE) * len_ratio.powf(0.5) / strength + LIP_MASS_SHARE * lever_rel);
    let f_r = (k / m).sqrt() / (2.0 * core::f64::consts::PI);
    // Damping: intrinsic reed loss + lip tissue (more contact → more damping).
    let km = (k * m).sqrt();
    let r_lip = 0.6 * c.lip_damping * km * f_rel.sqrt();
    let r = (0.03 + 0.3 * c.reed_damping) * km + r_lip;
    let h_tip = c.tip_opening_mm * 1e-3;
    // Curved lay: contact (progressive stiffening as the reed rolls onto the
    // facing) starts when the reed has closed all but the last `phi` of its
    // equilibrium opening; longer facings make the roll-on more gradual.
    let phi = (0.12 * c.facing_length_mm / 22.0).clamp(0.05, 0.25);
    let h0 = (h_tip - y_eq).max(0.05 * h_tip);
    // amplitude-dependent lip damping: r_lip·κ·((y − y_eq)/H0)²
    let r_nl = r_lip * LIP_NL_DAMP / (h0 * h0);
    let y_contact = h_tip - phi * h0;
    let span = (h_tip - y_contact).max(1e-5);
    // At full closure the contact has added ≈ 15·K of stiffness.
    let kc = 7.5 * k / span;
    // Reed-body mode: the reed between lip and tip keeps bending while the tip
    // is on the lay, so part of the reed compliance survives beating. Its
    // equivalent volume is a fixed fraction BODY_SHARE of the total (≈1 cm³).
    let v_tip = 1.42e5 * s_r * s_r / k; // ρc²S²/K (nominal air)
    let v_b = v_tip * BODY_SHARE / (1.0 - BODY_SHARE);
    let s_b = s_r;
    let k_b = 1.42e5 * s_b * s_b / v_b;
    let w_b = 2.0 * core::f64::consts::PI * 1.5 * f_r;
    let m_b = k_b / (w_b * w_b);
    let r_b = (0.5 + 0.5 * c.lip_damping) * (k_b * m_b).sqrt();
    let f_tongue = 1.0 * c.tongue_contact;
    let r_tongue = c.tongue_contact * 6.0 * (k * m).sqrt();
    ReedPhysParams {
        tip_opening: h_tip,
        k,
        y_eq,
        m,
        r,
        s_r,
        width: c.reed_width,
        y_contact,
        kc,
        f_tongue,
        r_tongue,
        s_b,
        k_b,
        m_b,
        r_b,
        r_nl,
    }
}

/// Common interface of reed models.
pub trait Reed {
    /// Advance one step with pressure difference dp = p_mouth − p_mouthpiece.
    fn step(&mut self, dp: f64);
    /// Tip displacement (m, + toward lay).
    fn tip_displacement(&self) -> f64;
    /// Channel opening (m, ≥ 0).
    fn opening(&self) -> f64;
    /// Reed-swept volume flow into the mouthpiece (m³/s) for the last step.
    fn swept_flow(&self) -> f64;
}

#[derive(Clone, Debug)]
pub struct LumpedReed {
    pub par: ReedPhysParams,
    pub dt: f64,
    y: f64,
    y_prev: f64,
    yb: f64,
    yb_prev: f64,
    swept: f64,
    // cached step coefficients (recomputed by `prepare`)
    m_dt2: f64,
    inv_2dt: f64,
    inv_dt: f64,
    lin_a_inv: f64,
    body_a_inv: f64,
    body_c: f64,
    body_mb: f64,
}

impl LumpedReed {
    pub fn new(par: ReedPhysParams, dt: f64) -> Self {
        let mut r = LumpedReed {
            par,
            dt,
            y: par.y_eq,
            y_prev: par.y_eq,
            yb: 0.0,
            yb_prev: 0.0,
            swept: 0.0,
            m_dt2: 0.0,
            inv_2dt: 0.0,
            inv_dt: 0.0,
            lin_a_inv: 0.0,
            body_a_inv: 0.0,
            body_c: 0.0,
            body_mb: 0.0,
        };
        r.prepare();
        r
    }

    /// Replace the lumped parameters (state kept).
    pub fn set_par(&mut self, par: ReedPhysParams) {
        self.par = par;
        self.prepare();
    }

    fn prepare(&mut self) {
        let p = &self.par;
        let dt = self.dt;
        self.m_dt2 = p.m / (dt * dt);
        self.inv_2dt = 0.5 / dt;
        self.inv_dt = 1.0 / dt;
        let r = p.r + p.r_tongue;
        self.lin_a_inv = 1.0 / (self.m_dt2 + r * self.inv_2dt + 0.5 * p.k);
        let mb = p.m_b / (dt * dt);
        self.body_mb = mb;
        self.body_a_inv = 1.0 / (mb + p.r_b * self.inv_2dt + 0.5 * p.k_b);
        self.body_c = mb - p.r_b * self.inv_2dt + 0.5 * p.k_b;
    }
    pub fn reset(&mut self) {
        self.y = self.par.y_eq;
        self.y_prev = self.y;
        self.yb = 0.0;
        self.yb_prev = 0.0;
        self.swept = 0.0;
    }
    pub fn set_dt(&mut self, dt: f64) {
        // keep position & velocity
        let v = (self.y - self.y_prev) / self.dt;
        let vb = (self.yb - self.yb_prev) / self.dt;
        self.dt = dt;
        self.y_prev = self.y - v * dt;
        self.yb_prev = self.yb - vb * dt;
        self.prepare();
    }
    /// Lay contact (PHYSICS.md E5b): F_c = k_c δ² (1 + μ_c ẏ), δ = y − y_c > 0.
    /// Returns (elastic force, its slope dF/dy, Hunt–Crossley damping k_c δ² μ_c).
    #[inline]
    fn contact(&self, y: f64) -> (f64, f64, f64) {
        let p = &self.par;
        let d = y - p.y_contact;
        if d <= 0.0 {
            return (0.0, 0.0, 0.0);
        }
        let f = p.kc * d * d;
        (f, 2.0 * p.kc * d, CONTACT_MU * f)
    }
}

/// Hunt–Crossley dissipation coefficient μ_c (s/m), restitution ≈ 0.3 at ~1 m/s.
pub const CONTACT_MU: f64 = 0.7;

impl Reed for LumpedReed {
    #[inline]
    fn step(&mut self, dp: f64) {
        let p = &self.par;
        let y = self.y;
        let ym = self.y_prev;
        let (fc, kc, rc) = self.contact(y);
        let m_dt2 = self.m_dt2;
        let dy = y - p.y_eq;
        let rnl = p.r_nl * dy * dy;
        let r_tot = p.r + rc + p.r_tongue + rnl;
        let k_tot = p.k + kc;
        let f_ext = p.s_r * dp + p.f_tongue + p.k * p.y_eq - fc + kc * y;
        let b = 2.0 * m_dt2 * y - ym * (m_dt2 - r_tot * self.inv_2dt + 0.5 * k_tot);
        let a_inv = if kc == 0.0 && rc == 0.0 && rnl == 0.0 { self.lin_a_inv } else { 1.0 / (m_dt2 + r_tot * self.inv_2dt + 0.5 * k_tot) };
        let mut yn = (f_ext + b) * a_inv;
        if !yn.is_finite() {
            yn = p.y_eq;
        }
        // hard safety limit: reed cannot pass far through the lay or flip outward
        let yn = yn.clamp(-3.0 * p.tip_opening, 1.2 * p.tip_opening);
        self.y_prev = y;
        self.y = yn;
        // body mode (linear, same centred scheme, no contact)
        let bb = 2.0 * self.body_mb * self.yb - self.yb_prev * self.body_c;
        let ybn = (p.s_b * dp + bb) * self.body_a_inv;
        let ybn = if ybn.is_finite() { ybn.clamp(-p.tip_opening, p.tip_opening) } else { 0.0 };
        let yb = self.yb;
        self.yb_prev = yb;
        self.yb = ybn;
        self.swept = (p.s_r * (yn - y) + p.s_b * (ybn - yb)) * self.inv_dt;
    }
    #[inline]
    fn tip_displacement(&self) -> f64 {
        self.y
    }
    #[inline]
    fn opening(&self) -> f64 {
        (self.par.tip_opening - self.y).max(0.0)
    }
    #[inline]
    fn swept_flow(&self) -> f64 {
        self.swept
    }
}

/// Reed model selector: lumped (M1–M3) or distributed beam (M4, `reed_beam`).
/// Both are kept configured; only the active one is stepped.
#[derive(Clone, Debug)]
pub struct ReedModel {
    pub use_beam: bool,
    pub lumped: LumpedReed,
    pub beam: crate::reed_beam::BeamReed,
}

impl ReedModel {
    pub fn new(dt: f64) -> Self {
        ReedModel {
            use_beam: false,
            lumped: LumpedReed::new(Default::default(), dt),
            beam: crate::reed_beam::BeamReed::new(Default::default(), dt),
        }
    }

    pub fn set_dt(&mut self, dt: f64) {
        self.lumped.set_dt(dt);
        self.beam.set_dt(dt);
    }

    /// Apply embouchure / mouthpiece controls to both models.
    pub fn set_controls(&mut self, c: &ReedControls) {
        self.lumped.set_par(derive_reed_params(c));
        self.beam.configure(&crate::reed_beam::BeamControls {
            reed_strength: c.reed_strength,
            reed_damping: c.reed_damping,
            lip_position_mm: c.lip_position_mm,
            lip_force: c.lip_force,
            lip_damping: c.lip_damping,
            tip_opening_mm: c.tip_opening_mm,
            facing_length_mm: c.facing_length_mm,
            tongue_contact: c.tongue_contact,
        });
    }

    pub fn reset(&mut self) {
        self.lumped.reset();
        self.beam.reset();
    }

    #[inline]
    pub fn step(&mut self, dp: f64) {
        if self.use_beam {
            self.beam.step(dp)
        } else {
            self.lumped.step(dp)
        }
    }
    #[inline]
    pub fn opening(&self) -> f64 {
        if self.use_beam {
            self.beam.opening()
        } else {
            self.lumped.opening()
        }
    }
    #[inline]
    pub fn swept_flow(&self) -> f64 {
        if self.use_beam {
            self.beam.swept_flow()
        } else {
            self.lumped.swept_flow()
        }
    }
    #[inline]
    pub fn tip_displacement(&self) -> f64 {
        if self.use_beam {
            self.beam.tip_displacement()
        } else {
            self.lumped.tip_displacement()
        }
    }
    /// Reed deflection sampled from tip to clamp (m). For the lumped model a
    /// cantilever-like shape scaled by the tip displacement.
    pub fn profile(&self, out: &mut [f32]) {
        if self.use_beam {
            self.beam.profile(out);
        } else {
            let n = out.len().max(2);
            let y = self.lumped.tip_displacement();
            for (k, o) in out.iter_mut().enumerate() {
                let u = 1.0 - k as f64 / (n - 1) as f64;
                *o = (y * u * u) as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Default embouchure hits the PHYSICS.md §5a target table.
    #[test]
    fn default_reed_targets() {
        let p = derive_reed_params(&ReedControls::default());
        let rc2 = 1.42e5; // ρc² at ~22 °C
        let h0 = p.tip_opening - p.y_eq;
        let p_m = p.k * h0 / p.s_r;
        let v_r = rc2 * p.s_r * p.s_r / p.k + rc2 * p.s_b * p.s_b / p.k_b;
        let f_r = (p.k / p.m).sqrt() / (2.0 * core::f64::consts::PI);
        let q = p.r / (p.k * p.m).sqrt();
        assert!((0.9e-3..=1.1e-3).contains(&h0), "H0 {h0}");
        assert!((6.0e3..=9.0e3).contains(&p_m), "p_M {p_m}");
        assert!((0.9e-6..=1.2e-6).contains(&v_r), "V_r {v_r}");
        assert!((1600.0..=2200.0).contains(&f_r), "f_r {f_r}");
        assert!((0.3..=0.5).contains(&q), "q {q}");
    }

    /// Static closing: Δp ≈ p_M closes the channel (contact begins).
    #[test]
    fn static_closing_pressure() {
        let par = derive_reed_params(&ReedControls::default());
        let h0 = par.tip_opening - par.y_eq;
        let p_m = par.k * h0 / par.s_r;
        let mut r = LumpedReed::new(par, 1.0 / 192000.0);
        for _ in 0..192000 {
            r.step(0.9 * p_m);
        }
        assert!(r.opening() < 0.2 * h0 && r.opening() > 0.0, "opening {}", r.opening());
        let mut r = LumpedReed::new(par, 1.0 / 192000.0);
        for _ in 0..192000 {
            r.step(1.5 * p_m);
        }
        assert!(r.opening() < 0.05 * h0, "not closed at 1.5 p_M: {}", r.opening());
    }
}

#[cfg(test)]
mod lip_tests {
    use super::*;
    /// Default embouchure unchanged by the lip model; trends with lip force.
    #[test]
    fn lip_force_trends() {
        let at = |f: f64| derive_reed_params(&ReedControls { lip_force: f, ..Default::default() });
        let d = at(1.0);
        let h0 = d.tip_opening - d.y_eq;
        assert!((h0 - 1.03e-3).abs() < 0.02e-3, "default H0 {h0}");
        let (lo, hi) = (at(0.6), at(1.4));
        assert!(hi.k > d.k && d.k > lo.k, "lip stiffening");
        assert!(hi.y_eq > d.y_eq && d.y_eq > lo.y_eq);
        assert!(at(3.0).tip_opening - at(3.0).y_eq > 0.0, "never exactly shut statically");
    }
}
