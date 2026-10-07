//! Distributed reed (M4): Euler–Bernoulli beam with tapered thickness, lay
//! (facing) contact, a distributed lower-lip Kelvin–Voigt foundation and tongue
//! contact near the tip — docs/PHYSICS.md §5b (Avanzini & van Walstijn 2004).
//!
//! Coordinate ξ from the reed tip (ξ = 0, free end) to the ligature clamp
//! (ξ = L_c, y = y' = 0). Deflection y(ξ) is positive toward the mouthpiece
//! (closing). Unknowns are the NB nodes ξ_i = iΔξ, i = 0…NB−1 (node NB is the
//! clamp). Energy-based discretisation:
//!   kinetic   ½ Σ m_i ẏ_i²,             m_i = ρ_r w e(ξ_i) Δξ (½ at the tip)
//!   potential ½ Σ_j β_j EI_j κ_j² Δξ,    κ_j = δ_ξξ y at j = 1…NB (ghost y_{NB+1} = y_{NB−1})
//! gives a symmetric positive-definite pentadiagonal stiffness K with the free
//! (moment- and shear-free) tip condition built in.
//!
//! Time stepping: θ-scheme (θ = ¼, unconditionally stable)
//!   M δ_tt y + C δ_t· y + K (θ y⁺ + (1−2θ) y + θ y⁻) = f,
//! C = η_r K_beam + diag(air, lip, contact, tongue damping). The lay penalty
//! f = −k_lay (−g)^1.5 Δξ (g = y_lay − y) is linearised about yⁿ (its slope
//! enters the implicit diagonal), so the per-step system is a pentadiagonal
//! SPD solve (LDLᵀ, O(NB)). The beam runs at ≈ 64 kHz (every `stride`
//! internal steps); between beam steps the tip is extrapolated with its
//! velocity and the swept flow is held.

pub const NB: usize = 24;
/// reed shape samples exported in telemetry
pub const PROFILE_N: usize = 32;
const THETA: f64 = 0.25;
/// target beam update rate (Hz)
pub const BEAM_RATE: f64 = 64000.0;

/// Physical constants of the reed (PHYSICS.md §5b table) — from the geometry
/// JSON where available.
#[derive(Clone, Copy, Debug)]
pub struct BeamGeom {
    /// tip → clamp length L_c (m)
    pub l_clamp: f64,
    /// reed width w (m) and pressure-loaded window width w_p (m)
    pub width: f64,
    pub w_p: f64,
    pub e_tip: f64,
    pub e_heel: f64,
    /// vamp (cut) length L_v (m)
    pub vamp: f64,
    /// window length (pressure loaded from the tip) (m)
    pub window: f64,
    /// Young's modulus at strength 2.5 (Pa), density (kg/m³)
    pub e_mod: f64,
    pub rho: f64,
    /// thickness taper exponent
    pub taper: f64,
    /// lip-force calibration gain (effective force = gain · lip_force)
    pub lip_gain: f64,
    /// lip-force saturation (N): effective force F_sat·tanh(F/F_sat)
    pub lip_fsat: f64,
    /// lip foundation stiffness k_l = (2 + lip_k_force·F)·1e5 N/m²
    pub lip_k_force: f64,
    /// lip-damping calibration gain on r_l
    pub lip_damp_gain: f64,
}

impl Default for BeamGeom {
    fn default() -> Self {
        BeamGeom {
            l_clamp: 0.040,
            width: 0.017,
            w_p: 0.0135,
            e_tip: 0.10e-3,
            e_heel: 2.8e-3,
            vamp: 0.035,
            window: 0.030,
            e_mod: BEAM_E_DEFAULT,
            rho: 500.0,
            taper: TAPER,
            lip_gain: LIP_GAIN,
            lip_fsat: LIP_FSAT,
            lip_k_force: LIP_K_FORCE,
            lip_damp_gain: LIP_DAMP_GAIN,
        }
    }
}

/// Calibrated cane modulus at strength 2.5 (PHYSICS.md range 6–12 GPa); see
/// `default_beam_targets` test for the resulting H0, p_M, V_r, f_r.
pub const BEAM_E_DEFAULT: f64 = 7.0e9;
/// thickness taper exponent e(ξ) = e_tip + (e_heel − e_tip)(ξ/L_v)^TAPER
pub const TAPER: f64 = 1.8;
/// lip-force calibration gain
pub const LIP_GAIN: f64 = 7.0;
/// Lip-force saturation (N): the lip tissue spreads and the reed wraps onto
/// the lay, so the static push saturates (cf. the lumped reed's tanh law).
pub const LIP_FSAT: f64 = 1.0;
/// lip tissue stiffening with force (PHYSICS.md §5b: 6; 20 matches the lumped
/// reed's strain-stiffening lip at the default and altissimo embouchures)
pub const LIP_K_FORCE: f64 = 20.0;
/// lip-damping calibration gain
pub const LIP_DAMP_GAIN: f64 = 1.0;
/// Kelvin–Voigt internal damping at reed_damping = 0.3 (s)
pub const ETA_R: f64 = 6.0e-7;
/// air / fluid damping (1/s)
pub const GAMMA_R: f64 = 100.0;
/// lip-tissue damping transmitted along the whole vibrating part (mass-
/// proportional, 1/s per unit lip_damping) — calibrated so the lipped first
/// mode has q ≈ 0.35 at lip_damping 0.4 (PHYSICS.md §5a target 0.3–0.5)
pub const GAMMA_LIP: f64 = 7000.0;
/// lay penalty (N/m^2.5 per unit length) and its damping (N·s/m²). Softer
/// and more damped than PHYSICS.md's 1e10 / 2: with the stiffer penalty the
/// wet reed "chatters" on the facing at the beam rate and injects broadband
/// 10–20 kHz noise into the mouthpiece (+18 dB vs the lumped reed); 1e9 / 300
/// keeps the static closing pressure within 3 % and removes the artefact.
pub const K_LAY: f64 = 1.0e9;
pub const R_LAY: f64 = 300.0;
/// lip contact length (m)
pub const LIP_LEN: f64 = 0.010;

/// Embouchure / mouthpiece controls seen by the beam.
#[derive(Clone, Copy, Debug)]
pub struct BeamControls {
    pub reed_strength: f64,
    pub reed_damping: f64,
    pub lip_position_mm: f64,
    pub lip_force: f64,
    pub lip_damping: f64,
    pub tip_opening_mm: f64,
    pub facing_length_mm: f64,
    pub tongue_contact: f64,
}

impl Default for BeamControls {
    fn default() -> Self {
        BeamControls {
            reed_strength: 2.5,
            reed_damping: 0.3,
            lip_position_mm: 12.0,
            lip_force: 1.0,
            lip_damping: 0.4,
            tip_opening_mm: 1.9,
            facing_length_mm: 22.0,
            tongue_contact: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BeamReed {
    pub geom: BeamGeom,
    pub ctrl: BeamControls,
    dt_int: f64,
    stride: usize,
    cnt: usize,
    dt: f64,
    pub dx: f64,
    pub y: [f64; NB],
    yp: [f64; NB],
    m: [f64; NB],
    kb0: [f64; NB],
    kb1: [f64; NB],
    kb2: [f64; NB],
    klip: [f64; NB],
    cdiag: [f64; NB],
    eta: f64,
    pub lay: [f64; NB],
    load: [f64; NB],
    sweep: [f64; NB],
    fconst: [f64; NB],
    // precomputed constant parts of the system matrix A
    a_diag_lin: [f64; NB],
    a1: [f64; NB],
    a2: [f64; NB],
    /// cached K_beam·yⁿ⁻¹ (from the previous step)
    ky_prev: [f64; NB],
    /// UDUᵀ factorisation of the step matrix, computed from the clamp end:
    /// rows above the highest contact node are reused between steps
    u1: [f64; NB],
    u2: [f64; NB],
    dinv: [f64; NB],
    dval: [f64; NB],
    /// highest node index whose diagonal differed from the linear one at the
    /// last factorisation (NB = whole factorisation invalid)
    dirty_hi: usize,
    // scratch
    d: [f64; NB],
    l1: [f64; NB],
    l2: [f64; NB],
    z: [f64; NB],
    tip_opening: f64,
    dp_acc: f64,
    // outputs
    y_tip: f64,
    v_tip: f64,
    swept: f64,
    sub: usize,
}

/// Thickness at ξ.
fn thickness(g: &BeamGeom, xi: f64) -> f64 {
    let u = (xi / g.vamp).clamp(0.0, 1.0);
    g.e_tip + (g.e_heel - g.e_tip) * u.powf(g.taper)
}

/// LDLᵀ solve of a symmetric pentadiagonal system (diag a0, super-diagonals a1, a2).
/// `x` holds the right-hand side on entry and the solution on exit.
#[inline]
pub fn penta_solve(a0: &[f64; NB], a1: &[f64; NB], a2: &[f64; NB], x: &mut [f64; NB], d: &mut [f64; NB], l1: &mut [f64; NB], l2: &mut [f64; NB]) {
    // factorisation: L[i][i-1] = l1[i], L[i][i-2] = l2[i]; d holds 1/D on exit
    let (mut dm1, mut dm2) = (0.0f64, 0.0f64); // D[i-1], D[i-2]
    for i in 0..NB {
        let mut di = a0[i];
        let mut l2i = 0.0;
        let mut l1i = 0.0;
        if i >= 2 {
            let t = a2[i - 2]; // = l2·D[i-2]
            l2i = t * d[i - 2];
            di -= l2i * t;
        }
        if i >= 1 {
            let v = a1[i - 1] - l2i * l1[i - 1] * dm2;
            l1i = v * d[i - 1];
            di -= l1i * v;
        }
        l2[i] = l2i;
        l1[i] = l1i;
        d[i] = 1.0 / di;
        dm2 = dm1;
        dm1 = di;
    }
    // forward: L z = b
    for i in 0..NB {
        let mut v = x[i];
        if i >= 1 {
            v -= l1[i] * x[i - 1];
        }
        if i >= 2 {
            v -= l2[i] * x[i - 2];
        }
        x[i] = v;
    }
    for i in 0..NB {
        x[i] *= d[i];
    }
    // backward: Lᵀ x = w
    for i in (0..NB).rev() {
        let mut v = x[i];
        if i + 1 < NB {
            v -= l1[i + 1] * x[i + 1];
        }
        if i + 2 < NB {
            v -= l2[i + 2] * x[i + 2];
        }
        x[i] = v;
    }
}

impl BeamReed {
    pub fn new(geom: BeamGeom, dt_int: f64) -> Self {
        let mut b = BeamReed {
            geom,
            ctrl: BeamControls::default(),
            dt_int,
            stride: 1,
            cnt: 0,
            dt: dt_int,
            dx: geom.l_clamp / NB as f64,
            y: [0.0; NB],
            yp: [0.0; NB],
            m: [0.0; NB],
            kb0: [0.0; NB],
            kb1: [0.0; NB],
            kb2: [0.0; NB],
            klip: [0.0; NB],
            cdiag: [0.0; NB],
            eta: ETA_R,
            lay: [0.0; NB],
            load: [0.0; NB],
            sweep: [0.0; NB],
            fconst: [0.0; NB],
            a_diag_lin: [0.0; NB],
            a1: [0.0; NB],
            a2: [0.0; NB],
            ky_prev: [0.0; NB],
            u1: [0.0; NB],
            u2: [0.0; NB],
            dinv: [0.0; NB],
            dval: [0.0; NB],
            dirty_hi: NB,
            d: [0.0; NB],
            l1: [0.0; NB],
            l2: [0.0; NB],
            z: [0.0; NB],
            tip_opening: 1.9e-3,
            dp_acc: 0.0,
            y_tip: 0.0,
            v_tip: 0.0,
            swept: 0.0,
            sub: 0,
        };
        b.set_dt(dt_int);
        b.configure(&BeamControls::default());
        b.settle();
        b
    }

    pub fn set_dt(&mut self, dt_int: f64) {
        self.dt_int = dt_int;
        self.stride = ((1.0 / dt_int) / BEAM_RATE).round().max(1.0) as usize;
        self.dt = dt_int * self.stride as f64;
        self.cnt = 0;
        self.dp_acc = 0.0;
        self.yp = self.y; // restart at rest velocity
        self.prepare_matrix();
        self.refresh_cache();
    }

    pub fn set_geom(&mut self, g: BeamGeom) {
        self.geom = g;
        self.dx = g.l_clamp / NB as f64;
        let c = self.ctrl;
        self.configure(&c);
    }

    /// Recompute all distributed coefficients from the controls (control rate;
    /// O(NB), no allocation).
    pub fn configure(&mut self, c: &BeamControls) {
        self.ctrl = *c;
        let g = self.geom;
        let dx = self.dx;
        let strength = 0.55 + 0.18 * c.reed_strength;
        let e_mod = g.e_mod * strength;
        self.tip_opening = c.tip_opening_mm * 1e-3;
        let f_l = c.facing_length_mm * 1e-3;
        let lip_c = c.lip_position_mm * 1e-3;
        // mass, beam stiffness band
        let mut ei = [0.0; NB + 1];
        for (j, eij) in ei.iter_mut().enumerate() {
            let e = thickness(&g, j as f64 * dx);
            *eij = e_mod * g.width * e * e * e / 12.0;
        }
        for i in 0..NB {
            let e = thickness(&g, i as f64 * dx);
            self.m[i] = g.rho * g.width * e * dx * if i == 0 { 0.5 } else { 1.0 };
            self.kb0[i] = 0.0;
            self.kb1[i] = 0.0;
            self.kb2[i] = 0.0;
        }
        let s = 1.0 / (dx * dx * dx); // EI Δξ / Δξ⁴
        for j in 1..=NB {
            if j < NB {
                // κ_j = (y_{j−1} − 2y_j + y_{j+1})/Δξ²  (y_NB = 0)
                let w = ei[j] * s;
                let idx = [j - 1, j, j + 1];
                let c = [1.0, -2.0, 1.0];
                for a in 0..3 {
                    for b in a..3 {
                        let (p, q) = (idx[a], idx[b]);
                        if p >= NB || q >= NB {
                            continue;
                        }
                        let v = w * c[a] * c[b];
                        match q - p {
                            0 => self.kb0[p] += v,
                            1 => self.kb1[p] += v,
                            2 => self.kb2[p] += v,
                            _ => {}
                        }
                    }
                }
            } else {
                // clamp: κ_NB = 2 y_{NB−1}/Δξ², weight ½
                let w = 0.5 * ei[NB] * s;
                self.kb0[NB - 1] += w * 4.0;
            }
        }
        // lip foundation, damping, loads, lay
        let k_l = (2.0 + g.lip_k_force * c.lip_force) * 1e5;
        let r_l = (20.0 + 150.0 * c.lip_damping) * g.lip_damp_gain;
        self.eta = ETA_R * (c.reed_damping / 0.3).max(0.05);
        let r_t = 0.15 * c.tongue_contact.clamp(0.0, 1.0);
        let f_t = 1.0 * c.tongue_contact.clamp(0.0, 1.0);
        let tongue_len = 0.003;
        let n_tongue = ((tongue_len / dx).ceil() as usize).max(1);
        for i in 0..NB {
            let xi = i as f64 * dx;
            let w8 = if i == 0 { 0.5 } else { 1.0 };
            let on_lip = (xi - lip_c).abs() <= 0.5 * LIP_LEN;
            self.klip[i] = if on_lip { k_l * dx } else { 0.0 };
            self.cdiag[i] = (GAMMA_R + GAMMA_LIP * c.lip_damping * g.lip_damp_gain) * self.m[i] + if on_lip { r_l * dx } else { 0.0 } + if i < n_tongue { r_t / n_tongue as f64 } else { 0.0 };
            self.load[i] = if xi < g.window && !on_lip { g.w_p * dx * w8 } else { 0.0 };
            self.sweep[i] = if xi < g.window { g.w_p * dx * w8 } else { 0.0 };
            let u = ((f_l - xi) / f_l.max(1e-4)).max(0.0);
            self.lay[i] = self.tip_opening * u * u;
            self.fconst[i] = if i < n_tongue { f_t / n_tongue as f64 } else { 0.0 };
        }
        // lip offset y_lip so that the static lip force equals F (no contact):
        // (K_beam + K_lip) s = K_lip·1  →  F = y_lip Σ k_lip,i (1 − s_i)
        let mut a0 = [0.0; NB];
        for i in 0..NB {
            a0[i] = self.kb0[i] + self.klip[i];
            self.z[i] = self.klip[i];
        }
        let (kb1, kb2) = (self.kb1, self.kb2);
        let mut zz = self.z;
        penta_solve(&a0, &kb1, &kb2, &mut zz, &mut self.d, &mut self.l1, &mut self.l2);
        let mut denom = 0.0;
        for i in 0..NB {
            denom += self.klip[i] * (1.0 - zz[i]);
        }
        let f_eff = g.lip_fsat * (c.lip_force / g.lip_fsat).tanh();
        let y_lip = if denom > 0.0 { g.lip_gain * f_eff / denom } else { 0.0 };
        for i in 0..NB {
            self.fconst[i] += self.klip[i] * y_lip;
        }
        self.prepare_matrix();
        self.refresh_cache();
    }

    pub(crate) fn refresh_cache(&mut self) {
        let yp = self.yp;
        let mut k = [0.0; NB];
        self.band_mul_all(&yp, &mut k);
        self.ky_prev = k;
    }

    fn prepare_matrix(&mut self) {
        self.dirty_hi = NB;
        let dt = self.dt;
        let (idt2, i2dt) = (1.0 / (dt * dt), 0.5 / dt);
        for i in 0..NB {
            self.a_diag_lin[i] = self.m[i] * idt2 + (self.eta * self.kb0[i] + self.cdiag[i]) * i2dt + THETA * (self.kb0[i] + self.klip[i]);
            self.a1[i] = (self.eta * i2dt + THETA) * self.kb1[i];
            self.a2[i] = (self.eta * i2dt + THETA) * self.kb2[i];
        }
    }

    /// Run the static problem to equilibrium (Δp = 0) from rest — used after
    /// construction and resets.
    pub fn settle(&mut self) {
        self.y = [0.0; NB];
        self.yp = [0.0; NB];
        self.ky_prev = [0.0; NB];
        // heavy-damped pseudo-time iterations: θ-scheme converges quickly
        for _ in 0..4000 {
            self.beam_step(0.0);
        }
        self.yp = self.y;
        self.refresh_cache();
        self.y_tip = self.y[0];
        self.v_tip = 0.0;
        self.swept = 0.0;
        self.cnt = 0;
        self.dp_acc = 0.0;
    }

    /// K_beam·v for all rows (branch-free band loops).
    #[inline]
    fn band_mul_all(&self, v: &[f64; NB], out: &mut [f64; NB]) {
        for i in 0..NB {
            out[i] = self.kb0[i] * v[i];
        }
        for i in 0..NB - 1 {
            out[i] += self.kb1[i] * v[i + 1];
            out[i + 1] += self.kb1[i] * v[i];
        }
        for i in 0..NB - 2 {
            out[i] += self.kb2[i] * v[i + 2];
            out[i + 2] += self.kb2[i] * v[i];
        }
    }

    /// UDUᵀ factorisation of the pentadiagonal step matrix (diag a0, a1, a2),
    /// recomputing rows top−1 … 0 (rows ≥ top are reused).
    #[inline]
    fn factor_udu(&mut self, a0: &[f64; NB], top: usize) {
        let top = top.min(NB);
        for i in (0..top).rev() {
            let mut di = a0[i];
            let mut u2i = 0.0;
            let mut u1i = 0.0;
            if i + 2 < NB {
                let t = self.a2[i]; // = u2·D[i+2]
                u2i = t * self.dinv[i + 2];
                di -= u2i * t;
            }
            if i + 1 < NB {
                let v = self.a1[i] - u2i * self.u1[i + 1] * if i + 2 < NB { self.dval[i + 2] } else { 0.0 };
                u1i = v * self.dinv[i + 1];
                di -= u1i * v;
            }
            self.u1[i] = u1i;
            self.u2[i] = u2i;
            self.dval[i] = di;
            self.dinv[i] = 1.0 / di;
        }
    }

    /// Solve U D Uᵀ x = b in place.
    #[inline]
    fn solve_udu(&self, x: &mut [f64; NB]) {
        // U z = b (from the clamp end)
        for i in (0..NB).rev() {
            let mut v = x[i];
            if i + 1 < NB {
                v -= self.u1[i] * x[i + 1];
            }
            if i + 2 < NB {
                v -= self.u2[i] * x[i + 2];
            }
            x[i] = v;
        }
        for i in 0..NB {
            x[i] *= self.dinv[i];
        }
        // Uᵀ x = w
        for i in 0..NB {
            let mut v = x[i];
            if i >= 1 {
                v -= self.u1[i - 1] * x[i - 1];
            }
            if i >= 2 {
                v -= self.u2[i - 2] * x[i - 2];
            }
            x[i] = v;
        }
    }

    /// One beam time step of length `dt` with uniform pressure difference dp.
    fn beam_step(&mut self, dp: f64) {
        let dt = self.dt;
        let (idt2, i2dt) = (1.0 / (dt * dt), 0.5 / dt);
        let mut a0 = self.a_diag_lin;
        let mut hi_contact: usize = 0; // 1 + highest node in contact (0 = none)
        let mut rhs = [0.0; NB];
        let mut ky = [0.0; NB];
        self.band_mul_all(&self.y, &mut ky);
        let eta = self.eta;
        for i in 0..NB {
            let y = self.y[i];
            let ym = self.yp[i];
            // lay contact, linearised about yⁿ
            let g = self.lay[i] - y;
            let (fc, kc, rc) = if g < 0.0 {
                let del = -g;
                let sq = del.sqrt();
                (K_LAY * del * sq * self.dx, 1.5 * K_LAY * sq * self.dx, R_LAY * self.dx)
            } else {
                (0.0, 0.0, 0.0)
            };
            if kc != 0.0 {
                a0[i] += rc * i2dt + THETA * kc;
                hi_contact = i + 1;
            }
            let kb_ym = self.ky_prev[i];
            let klip = self.klip[i];
            let ktot_y = ky[i] + (klip + kc) * y;
            let ktot_ym = kb_ym + (klip + kc) * ym;
            let c_ym = eta * kb_ym + (self.cdiag[i] + rc) * ym;
            let f = self.load[i] * dp + self.fconst[i] - fc + kc * y;
            let m = self.m[i] * idt2;
            rhs[i] = f + 2.0 * m * y - (1.0 - 2.0 * THETA) * ktot_y - (m * ym - c_ym * i2dt + THETA * ktot_ym);
        }
        self.ky_prev = ky;
        // refactor rows [0, top) only: rows ≥ top have their linear diagonal
        // both now and at the previous factorisation
        let top = if self.dirty_hi >= NB { NB } else { self.dirty_hi.max(hi_contact) };
        self.factor_udu(&a0, top);
        self.dirty_hi = hi_contact;
        self.solve_udu(&mut rhs);
        let mut sw = 0.0;
        for i in 0..NB {
            let mut yn = rhs[i];
            if !yn.is_finite() {
                yn = 0.0;
            }
            // safety: never further than 3 tip openings outward / 1.2 inward
            yn = yn.clamp(-3.0 * self.tip_opening, 1.2 * self.tip_opening.max(self.lay[i]) + 1e-4);
            sw += self.sweep[i] * (yn - self.y[i]);
            self.yp[i] = self.y[i];
            self.y[i] = yn;
        }
        self.swept = sw / dt;
        self.v_tip = (self.y[0] - self.yp[0]) / dt;
    }

    pub fn reset(&mut self) {
        self.settle();
    }

    /// Deflection sampled at PROFILE_N points from tip to clamp (m).
    pub fn profile(&self, out: &mut [f32]) {
        let n = out.len();
        for (k, o) in out.iter_mut().enumerate() {
            let xi = k as f64 / (n - 1).max(1) as f64 * NB as f64; // node units, NB = clamp
            let i = xi.floor() as usize;
            let f = xi - i as f64;
            let ya = if i < NB { self.y[i] } else { 0.0 };
            let yb = if i + 1 < NB { self.y[i + 1] } else { 0.0 };
            *o = (ya + f * (yb - ya)) as f32;
        }
    }

    /// Static small-signal quantities at the current equilibrium (for
    /// calibration/tests): returns (H0, compliance dV/dp of swept volume, tip
    /// compliance dy0/dp) using the linear stiffness incl. current contacts.
    pub fn static_compliance(&mut self) -> (f64, f64, f64) {
        let mut a0 = [0.0; NB];
        for i in 0..NB {
            let g = self.lay[i] - self.y[i];
            let kc = if g < 0.0 { 1.5 * K_LAY * (-g).sqrt() * self.dx } else { 0.0 };
            a0[i] = self.kb0[i] + self.klip[i] + kc;
        }
        let mut x = self.load;
        let (k1, k2) = (self.kb1, self.kb2);
        penta_solve(&a0, &k1, &k2, &mut x, &mut self.d, &mut self.l1, &mut self.l2);
        let mut dv = 0.0;
        for i in 0..NB {
            dv += self.sweep[i] * x[i];
        }
        ((self.tip_opening - self.y[0]).max(0.0), dv, x[0])
    }
}

impl crate::reed::Reed for BeamReed {
    #[inline]
    fn step(&mut self, dp: f64) {
        self.dp_acc += dp;
        self.cnt += 1;
        if self.cnt >= self.stride {
            let d = self.dp_acc / self.cnt as f64;
            self.cnt = 0;
            self.dp_acc = 0.0;
            self.beam_step(d);
            self.y_tip = self.y[0];
            self.sub = 0;
        } else {
            self.sub += 1;
            self.y_tip += self.v_tip * self.dt_int;
        }
    }
    #[inline]
    fn tip_displacement(&self) -> f64 {
        self.y_tip
    }
    #[inline]
    fn opening(&self) -> f64 {
        (self.tip_opening - self.y_tip).max(0.0)
    }
    #[inline]
    fn swept_flow(&self) -> f64 {
        self.swept
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uniform_geom() -> BeamGeom {
        BeamGeom { e_tip: 1.0e-3, e_heel: 1.0e-3, ..BeamGeom::default() }
    }

    fn free_ctrl() -> BeamControls {
        // no lip, no lay contact (huge tip opening, facing length ~0)
        BeamControls { lip_force: 0.0, lip_damping: 0.0, lip_position_mm: 1000.0, tip_opening_mm: 1000.0, facing_length_mm: 1000.0, ..Default::default() }
    }

    /// Uniform cantilever under uniform load q: tip deflection qL⁴/(8EI).
    #[test]
    fn static_cantilever_deflection() {
        let g = uniform_geom();
        let mut b = BeamReed::new(g, 1.0 / 96000.0);
        let mut c = free_ctrl();
        c.reed_strength = 2.5; // strength factor 1.0
        b.configure(&c);
        // static solve K y = load·Δp with full-length uniform load
        let dp = 100.0;
        let mut x = [0.0; NB];
        for i in 0..NB {
            x[i] = g.w_p * b.dx * if i == 0 { 0.5 } else { 1.0 } * dp;
        }
        let a0 = b.kb0;
        let (k1, k2) = (b.kb1, b.kb2);
        let (mut d, mut l1, mut l2) = ([0.0; NB], [0.0; NB], [0.0; NB]);
        penta_solve(&a0, &k1, &k2, &mut x, &mut d, &mut l1, &mut l2);
        let ei = g.e_mod * g.width * 1e-9 / 12.0;
        let q = g.w_p * dp;
        let exact = q * g.l_clamp.powi(4) / (8.0 * ei);
        let err = (x[0] - exact) / exact;
        assert!(err.abs() < 0.03, "tip {} vs {} ({:.2} %)", x[0], exact, err * 100.0);
    }

    /// First bending mode of the uniform cantilever: f1 = 1.875²/(2π)·√(EI/(ρA L⁴)).
    #[test]
    fn first_mode_frequency() {
        let g = uniform_geom();
        let fs = 400000.0;
        let mut b = BeamReed::new(g, 1.0 / fs);
        let mut c = free_ctrl();
        c.reed_damping = 0.0001;
        b.configure(&c);
        b.y = [0.0; NB];
        b.yp = [0.0; NB];
        // kick: small static-shaped tip deflection, then free vibration
        for i in 0..NB {
            let u = 1.0 - i as f64 / NB as f64;
            b.y[i] = 1e-6 * u * u;
            b.yp[i] = b.y[i];
        }
        b.refresh_cache();
        let n = (0.05 / b.dt) as usize;
        let mut tip = Vec::with_capacity(n);
        for _ in 0..n {
            b.beam_step(0.0);
            tip.push(b.y[0]);
        }
        // zero-crossing period of the tip (dominated by mode 1)
        let mean = tip.iter().sum::<f64>() / n as f64;
        let mut cr = vec![];
        for k in 1..n {
            let (a, bb) = (tip[k - 1] - mean, tip[k] - mean);
            if a < 0.0 && bb >= 0.0 {
                cr.push((k - 1) as f64 + a / (a - bb));
            }
        }
        let f_num = (cr.len() - 1) as f64 / ((cr[cr.len() - 1] - cr[0]) * b.dt);
        let ei = g.e_mod * g.width * 1e-9 / 12.0;
        let ra = g.rho * g.width * 1e-3;
        let f_ex = 1.875104f64.powi(2) / (2.0 * core::f64::consts::PI) * (ei / (ra * g.l_clamp.powi(4))).sqrt();
        let err = (f_num - f_ex) / f_ex;
        assert!(err.abs() < 0.03, "f1 {f_num:.1} vs {f_ex:.1} Hz ({:.2} %)", err * 100.0);
    }
}
