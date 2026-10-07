//! The coupled time-domain system:
//! lungs → glottis → vocal tract → reed channel → mouthpiece/neck/body (+tone
//! holes) → bell, radiated pressure → decimator → output.

use crate::air::Air;
use crate::fdtd::Tube;
use crate::flow::{channel_coefs, solve_channel};
use crate::geometry::{self, Instrument, MouthpieceControls};
use crate::keywork::Keywork;
use crate::lungs::Lungs;
use crate::params::{clamp_param, default_values, Param, NUM_PARAMS, PARAM_DEFS};
use crate::radiation::{radiation_rl, StepCoefs, Termination};
use crate::reed::{ReedControls, ReedModel};
use crate::resample::Decimator;
use crate::smoothing::Smoother;
use crate::telemetry::{self, idx, PitchTracker, N_PROFILE, SCOPE_LEN, SCOPE_STRIDE, TELEMETRY_LEN};
use crate::toneholes::{solve_cluster, HoleBank, ToneHole};
use crate::tract::{Tract, TractControls};

pub const MAX_BLOCK: usize = 512;
/// bore Δx = CFL_MARGIN · c_max Δt (see `nodes_for`)
pub const CFL_MARGIN: f64 = 1.04;
pub const MAX_OVERSAMPLE: usize = 8;
pub const MAX_HOLES: usize = 64;
/// output samples between control-rate updates
const CTRL_PERIOD: usize = 32;
/// output samples between updates of the standing-wave RMS profile (telemetry)
const PROFILE_STRIDE: usize = 8;
/// radiation delay line length (internal samples, power of two)
const RAD_RING: usize = 4096;
/// vena-contracta coefficient of the reed channel jet
pub const VENA_CONTRACTA: f64 = 0.7;
/// trachea cross-section (m²) for the anechoic subglottal load
const SUBGLOTTAL_AREA: f64 = 2.5e-4;
/// glottal area range (m²), PHYSICS.md §7
const GLOTTIS_MIN_AREA: f64 = 0.05e-4;
const GLOTTIS_MAX_AREA: f64 = 2.0e-4;
/// glottal duct length (m) and reed channel length (m) for the viscous terms
const GLOTTIS_LEN: f64 = 0.003;
const CHANNEL_LEN: f64 = 0.003;
/// output scaling: Pa at listener → digital full scale
const PA_TO_FS: f64 = 0.1;

pub struct Engine {
    pub fs: f64,
    pub os: usize,
    pub dt: f64,
    params: [f32; NUM_PARAMS],
    smooth: [Smoother; NUM_PARAMS],
    pub air: Air,
    pub inst: Instrument,
    pub keywork: Keywork,
    keys: Vec<f32>,
    hole_targets: Vec<f32>,
    pub pad_openness: Vec<f32>,
    pub bore: Tube,
    pub holes: Vec<ToneHole>,
    extra_vol: Vec<f64>,
    /// scratch: pⁿ at each hole's node
    hole_flow: Vec<f64>,
    /// indices of holes whose branch is not closed, sorted by node (rebuilt
    /// per output sample), and clusters of holes sharing bore nodes
    open_holes: Vec<usize>,
    clusters: Vec<(usize, usize)>,
    /// open single-hole branches with precomputed step constants (hot loop)
    bank: HoleBank,
    /// bank must be rebuilt from `holes` (its states are not live)
    holes_dirty: bool,
    /// bank's pⁿ must be re-read from the bore (after a rebuild / block start)
    bank_capture: bool,
    /// some pad is still slewing toward its target (or the open set / clusters
    /// must be re-derived): run the per-sample pad pass
    pads_moving: bool,
    pub bell: Termination,
    bell_c: StepCoefs,
    bell_gain: f64,
    bell_delay: usize,
    pub tract: Tract,
    /// acoustic vocal tract on (else mouth pressure = lung pressure)
    pub use_tract: bool,
    pub reed: ReedModel,
    lungs: Lungs,
    dec: Decimator,
    out: Vec<f32>,
    /// per-output-sample captures of the last block: mouthpiece pressure,
    /// mouth pressure, reed tip displacement, reed flow (offline analysis)
    pub cap_pmp: Vec<f32>,
    pub cap_pm: Vec<f32>,
    pub cap_y: Vec<f32>,
    pub cap_u: Vec<f32>,
    pub telemetry: Vec<f32>,
    pitch: PitchTracker,
    // dynamic state
    dp: f64,
    u_reed: f64,
    u_bern: f64,
    p_lung: f64,
    p_mouth: f64,
    ug_mean: f64,
    ug_coef: f64,
    /// glottis channel coefficients (a, b) and subglottal resistance
    glot_a: f64,
    glot_b: f64,
    r_sub: f64,
    /// reed-channel inlet fraction left free by the tongue (1 − 0.9·contact)
    tongue_inlet: f64,
    rad_ring: Vec<f32>,
    rad_pos: usize,
    dc_x1: f64,
    dc_y1: f64,
    dc_r: f64,
    mp_dc: f64,
    out_ms: f64,
    prof_ms: Vec<f32>,
    prof_idx: Vec<usize>,
    scope_p: [f32; SCOPE_LEN],
    scope_y: [f32; SCOPE_LEN],
    scope_pos: usize,
    sample_count: u64,
    ctrl_count: usize,
    pad_coef: f64,
    pad_coef_open: f64,
    // dirty flags
    need_rebuild: bool,
    bore_dirty: bool,
    tract_dirty: bool,
    reed_dirty: bool,
    mp_ctrl: MouthpieceControls,
    /// output fade-in gain after a grid rebuild / state reset (avoids clicks)
    fade: f64,
    fade_coef: f64,
    pub resets: u32,
    /// subsystem that triggered the last NaN/overflow reset (diagnostics)
    pub last_reset_reason: &'static str,
    pub last_cpu_us: f32,
    /// boundary-layer loss multiplier for the bore (1 = physical; validation knob)
    pub bore_loss_mult: f64,
    /// player model / auto-embouchure assistant (player_assist)
    pub player: crate::player::Player,
    /// requested lung pressure (Pa) before the player's scaling
    lung_target_pa: f64,
    /// bore radius below which thermal losses are an explicit shunt term (m)
    pub thermal_radius: f64,
    /// reed-channel vena-contracta coefficient α_vc
    pub vena_contracta: f64,
    /// effective length (m) of the reed-channel air plug for its inertia
    pub channel_inertia_len: f64,
}

fn smoothing_tau(p: usize) -> f64 {
    match p {
        x if x == Param::LungPressure as usize => 0.0, // handled by Lungs
        x if x == Param::Oversample as usize => 0.0,
        x if x == Param::ReedModel as usize => 0.0,
        x if x == Param::Subglottal as usize => 0.0,
        x if x == Param::Temperature as usize => 0.2,
        x if x == Param::TongueReedContact as usize => 0.004,
        _ => 0.02,
    }
}

impl Engine {
    pub fn new(fs: f32) -> Engine {
        let fs = if fs.is_finite() && fs > 8000.0 { fs as f64 } else { 48000.0 };
        let params = default_values();
        let mut smooth = [Smoother::new(0.0); NUM_PARAMS];
        for i in 0..NUM_PARAMS {
            smooth[i] = Smoother::new(params[i] as f64);
            smooth[i].set_time(smoothing_tau(i), fs / CTRL_PERIOD as f64);
        }
        let g = geometry::parse(geometry::FALLBACK_JSON).expect("fallback geometry");
        let mut e = Engine {
            fs,
            os: 4,
            dt: 1.0 / (fs * 4.0),
            params,
            smooth,
            air: Air::at(22.0),
            inst: Instrument::default(),
            keywork: Keywork::default(),
            keys: Vec::with_capacity(MAX_HOLES),
            hole_targets: Vec::with_capacity(MAX_HOLES),
            pad_openness: Vec::with_capacity(MAX_HOLES),
            bore: Tube::default(),
            holes: Vec::with_capacity(MAX_HOLES),
            extra_vol: Vec::new(),
            hole_flow: Vec::with_capacity(MAX_HOLES),
            open_holes: Vec::with_capacity(MAX_HOLES),
            clusters: Vec::with_capacity(MAX_HOLES),
            bank: HoleBank::with_capacity(MAX_HOLES),
            holes_dirty: true,
            bank_capture: true,
            pads_moving: true,
            bell: Termination::default(),
            bell_c: StepCoefs::default(),
            bell_gain: 1.0,
            bell_delay: 0,
            tract: Tract::new(Tract::nodes_for(1.0 / (fs * MAX_OVERSAMPLE as f64)) + 2),
            use_tract: true,
            reed: ReedModel::new(1.0 / (fs * 4.0)),
            lungs: Lungs::new(),
            dec: Decimator::new(),
            out: vec![0.0; MAX_BLOCK],
            cap_pmp: vec![0.0; MAX_BLOCK],
            cap_pm: vec![0.0; MAX_BLOCK],
            cap_y: vec![0.0; MAX_BLOCK],
            cap_u: vec![0.0; MAX_BLOCK],
            telemetry: vec![0.0; TELEMETRY_LEN],
            pitch: PitchTracker::new(fs),
            dp: 0.0,
            u_reed: 0.0,
            u_bern: 0.0,
            p_lung: 0.0,
            p_mouth: 0.0,
            ug_mean: 0.0,
            ug_coef: 0.0,
            glot_a: 0.0,
            glot_b: 0.0,
            r_sub: 0.0,
            tongue_inlet: 1.0,
            rad_ring: vec![0.0; RAD_RING],
            rad_pos: 0,
            dc_x1: 0.0,
            dc_y1: 0.0,
            dc_r: 1.0 - 2.0 * core::f64::consts::PI * 10.0 / fs,
            mp_dc: 0.0,
            out_ms: 0.0,
            prof_ms: vec![0.0; N_PROFILE],
            prof_idx: vec![0; N_PROFILE],
            scope_p: [0.0; SCOPE_LEN],
            scope_y: [0.0; SCOPE_LEN],
            scope_pos: 0,
            sample_count: 0,
            ctrl_count: 0,
            pad_coef: 0.0,
            pad_coef_open: 0.0,
            need_rebuild: true,
            bore_dirty: true,
            tract_dirty: true,
            reed_dirty: true,
            mp_ctrl: MouthpieceControls::default(),
            fade: 0.0,
            fade_coef: 0.0,
            resets: 0,
            last_reset_reason: "",
            last_cpu_us: 0.0,
            bore_loss_mult: 1.0,
            player: Default::default(),
            lung_target_pa: 0.0,
            thermal_radius: 0.012,
            vena_contracta: VENA_CONTRACTA,
            channel_inertia_len: crate::flow::CHANNEL_INERTIA_LEN,
        };
        e.telemetry[idx::N_PROFILE] = N_PROFILE as f32;
        e.load_instrument(g);
        e
    }

    pub fn load_geometry_json(&mut self, json: &str) -> Result<(), String> {
        let g = geometry::parse(json)?;
        if g.tone_holes.len() > MAX_HOLES {
            return Err(format!("too many tone holes ({} > {MAX_HOLES})", g.tone_holes.len()));
        }
        self.load_instrument(g);
        self.player.load_alternates(json, &self.keywork);
        self.player.on_keys(&self.keys);
        Ok(())
    }

    fn load_instrument(&mut self, g: geometry::GeometryJ) {
        self.keywork = Keywork::from_geometry(&g);
        self.bore_loss_mult = geometry::wall_loss_factor(&g);
        let inst = Instrument::from_json(g);
        self.holes.clear();
        for h in &inst.holes {
            let mut th = ToneHole::new(&h.id, h.x, h.radius, h.chimney, h.pad_open_height, h.pad_rest == "open", h.octave_vent);
            if let Some(br) = h.bore_radius {
                th.bore_radius = br;
            }
            self.holes.push(th);
        }
        let nh = self.holes.len();
        self.keys.clear();
        self.keys.resize(self.keywork.key_ids.len().max(1), 0.0);
        self.hole_targets.clear();
        self.hole_targets.resize(nh, 0.0);
        self.pad_openness.clear();
        self.pad_openness.resize(nh.max(1), 0.0);
        self.hole_flow.clear();
        self.hole_flow.resize(nh, 0.0);
        self.inst = inst;
        self.player = crate::player::Player::from_geometry(&self.inst.json, &self.keywork);
        self.player.on_keys(&self.keys);
        // Reserve for the worst case (max oversampling, shortest air column).
        let n_max = self.nodes_for(1.0 / (self.fs * MAX_OVERSAMPLE as f64)) + 2;
        self.bore = Tube::with_capacity(n_max);
        self.extra_vol = Vec::with_capacity(n_max);
        self.compute_radiation_geometry();
        self.evaluate_keys();
        for (i, h) in self.holes.iter_mut().enumerate() {
            h.openness = self.hole_targets[i] as f64;
        }
        self.need_rebuild = true;
        self.rebuild();
    }

    /// Listener position & per-source gain/delay (monopole 1/r, propagation delay).
    fn compute_radiation_geometry(&mut self) {
        let bell = &self.inst.json.bell;
        let (Some(rc), Some(rn)) = (bell.rim_center.as_ref(), bell.rim_normal.as_ref()) else {
            return;
        };
        if rc.len() < 3 || rn.len() < 3 {
            return;
        }
        // Listener 1 m in front of the bell rim along its axis (PHYSICS.md E4b).
        let lis = [rc[0] + rn[0], rc[1] + rn[1], rc[2] + rn[2]];
        let dist = |p: &[f64]| ((p[0] - lis[0]).powi(2) + (p[1] - lis[1]).powi(2) + (p[2] - lis[2]).powi(2)).sqrt();
        let d_bell = dist(rc);
        self.bell_gain = 1.0 / d_bell.max(0.1);
        let hole_dist = |h: &geometry::ToneHoleJ| h.position.as_ref().filter(|p| p.len() >= 3).map(|p| dist(p)).unwrap_or(d_bell);
        let dmin = self.inst.holes.iter().map(hole_dist).fold(d_bell, f64::min);
        let c = 345.0;
        let rate = self.fs * self.os as f64;
        self.bell_delay = (((d_bell - dmin) / c) * rate).round() as usize;
        for (h, hj) in self.holes.iter_mut().zip(self.inst.holes.iter()) {
            let d = hole_dist(hj);
            h.gain = 1.0 / d.max(0.1);
            h.delay = ((((d - dmin) / c) * rate).round() as usize).min(RAD_RING - 1);
        }
        self.bell_delay = self.bell_delay.min(RAD_RING - 1);
    }

    fn nodes_for(&self, dt: f64) -> usize {
        // CFL with margin for the tone-hole series corrections, which may
        // shorten a cell's inertance by up to MAX_SERIES_SHORTENING:
        // λ_max = 1/CFL_MARGIN/√(1−0.07) < 1
        let dx_min = Air::c_max() * dt * CFL_MARGIN;
        ((self.inst.min_length() / dx_min).floor() as usize).max(8) + 1
    }

    /// (Re)build all grids for the current oversampling. Resets acoustic state.
    fn rebuild(&mut self) {
        self.os = (self.params[Param::Oversample as usize].round() as usize).clamp(1, MAX_OVERSAMPLE);
        self.dt = 1.0 / (self.fs * self.os as f64);
        let n = self.nodes_for(self.dt);
        self.bore.resize(n);
        self.extra_vol.clear();
        self.extra_vol.resize(n, 0.0);
        self.tract.build(self.dt);
        self.reed.set_dt(self.dt);
        self.dec.configure(self.os, self.fs);
        self.lungs.configure(self.fs, self.fs * self.os as f64);
        self.pad_coef = 1.0 - (-1.0 / (0.006 * self.fs)).exp();
        self.pad_coef_open = 1.0 - (-1.0 / (0.010 * self.fs)).exp();
        self.ug_coef = 1.0 - (-1.0 / (0.02 * self.fs * self.os as f64)).exp();
        self.compute_radiation_geometry();
        self.sync_holes();
        self.pads_moving = true;
        for h in &mut self.holes {
            h.term.reset();
        }
        self.bell.reset();
        self.rad_ring.iter_mut().for_each(|x| *x = 0.0);
        self.dp = 0.0;
        self.u_reed = 0.0;
        self.u_bern = 0.0;
        self.p_mouth = 0.0;
        self.need_rebuild = false;
        self.fade = 0.0;
        self.fade_coef = 1.0 / (0.010 * self.fs);
        self.bore_dirty = true;
        self.tract_dirty = true;
        self.reed_dirty = true;
        self.update_coeffs(true);
        // Start the tract pre-pressurised at the current lung pressure so that a
        // grid rebuild while playing does not cause a huge transient.
        self.tract.prefill(self.p_lung);
        self.reed.reset();
    }

    fn mp_controls(&self) -> MouthpieceControls {
        MouthpieceControls {
            baffle: self.smooth[Param::BaffleHeight as usize].value,
            chamber: self.smooth[Param::ChamberSize as usize].value,
            throat_d_mm: self.smooth[Param::ThroatDiameter as usize].value,
            insertion_mm: self.smooth[Param::MouthpieceInsertion as usize].value,
        }
    }

    /// Reed controls as set by the user (no player offsets).
    fn base_reed_controls(&self) -> ReedControls {
        let v = |p: Param| self.smooth[p as usize].value;
        ReedControls {
            reed_strength: v(Param::ReedStrength),
            reed_damping: v(Param::ReedDamping),
            lip_position_mm: v(Param::LipPosition),
            lip_force: v(Param::LipForce),
            lip_damping: v(Param::LipDamping),
            tip_opening_mm: v(Param::TipOpening),
            facing_length_mm: v(Param::FacingLength),
            tongue_contact: v(Param::TongueReedContact),
            reed_width: self.inst.reed_width,
        }
    }

    fn reed_controls(&self) -> ReedControls {
        let v = |p: Param| self.smooth[p as usize].value;
        let (po, w) = (&self.player.out, self.player.out.alt_w);
        use crate::player::blend;
        ReedControls {
            reed_strength: v(Param::ReedStrength),
            reed_damping: blend(v(Param::ReedDamping), po.alt.reed_damping, w),
            lip_position_mm: blend(v(Param::LipPosition) + po.lip_position, po.alt.lip_position, w).clamp(2.0, 22.0),
            lip_force: blend(v(Param::LipForce) + po.lip, po.alt.lip_force, w).clamp(0.0, 3.0),
            lip_damping: blend(v(Param::LipDamping) + po.lip_damping, po.alt.lip_damping, w).clamp(0.0, 1.0),
            tip_opening_mm: v(Param::TipOpening),
            facing_length_mm: v(Param::FacingLength),
            tongue_contact: v(Param::TongueReedContact).max(po.tongue),
            reed_width: self.inst.reed_width,
        }
    }

    /// Recompute coefficients flagged dirty (control rate, never allocates).
    fn update_coeffs(&mut self, force: bool) {
        let temp = self.smooth[Param::Temperature as usize].value;
        if self.bore_dirty || force {
            self.sync_holes();
            self.pads_moving = true; // hole nodes may move → re-derive clusters
            self.air = Air::at(temp);
            let ctrl = self.mp_controls();
            self.mp_ctrl = ctrl;
            let n = self.bore.n;
            let len = self.inst.length(&ctrl);
            let dx = len / (n - 1) as f64;
            for i in 0..n - 1 {
                let r = self.inst.radius_at((i as f64 + 0.5) * dx, &ctrl);
                self.bore.s_half[i] = core::f64::consts::PI * r * r;
            }
            self.extra_vol.iter_mut().for_each(|v| *v = 0.0);
            for h in self.holes.iter_mut() {
                let s = self.inst.x_to_s(h.x, &ctrl) / dx;
                let node = (s.floor() as usize).clamp(1, n - 3);
                h.node = node;
                h.alpha = (s - node as f64).clamp(0.0, 1.0);
                self.extra_vol[node] += (1.0 - h.alpha) * h.volume();
                self.extra_vol[node + 1] += h.alpha * h.volume();
            }
            // tone-hole series corrections t_a spread over the hole's footprint
            // (diameter 2b) on the main-bore inertances
            self.bore.dl_half.iter_mut().for_each(|v| *v = 0.0);
            for h in self.holes.iter() {
                let open = h.openness >= crate::toneholes::OPEN_EPS;
                let ta = h.series_correction(open);
                let centre = (h.node as f64 + h.alpha) * dx;
                let i0 = ((centre - h.radius) / dx).floor().max(0.0) as usize;
                let i1 = (((centre + h.radius) / dx).ceil() as usize).min(n - 2);
                let cnt = (i1 + 1 - i0.min(i1)) as f64;
                for i in i0.min(i1)..=i1 {
                    self.bore.dl_half[i] += ta / cnt;
                }
            }
            // explicit thermal shunt losses where the bore is narrow (r < THERMAL_R)
            let mut nth = 1;
            while nth < n - 1 && self.inst.radius_at(nth as f64 * dx, &ctrl) < self.thermal_radius {
                nth += 1;
            }
            self.bore.thermal_nodes = nth;
            self.bore.set_coeffs(dx, self.dt, &self.air, self.bore_loss_mult, Some(&self.extra_vol));
            for h in self.holes.iter_mut() {
                h.kp = self.bore.kp[h.node];
                h.kp1 = self.bore.kp[h.node + 1];
                if h.bore_radius <= 0.0 {
                    h.bore_radius = self.inst.radius_at((h.node as f64 + h.alpha) * dx, &ctrl);
                }
                h.configure(self.dt, &self.air, true);
            }
            let rb = if self.inst.bell_radius > 0.0 { self.inst.bell_radius } else { self.inst.radius_at(len - 0.5 * dx, &ctrl) };
            let (rr, lr) = radiation_rl(self.air.rho, self.air.c, rb, 0.6133, 0.25);
            self.bell.set(self.dt, 0.0, 0.0, rr, lr);
            self.bell_c = self.bell.step_coefs(self.bore.kp[n - 1] as f64);
            // profile sample indices
            for j in 0..N_PROFILE {
                self.prof_idx[j] = ((j as f64) * (n - 1) as f64 / (N_PROFILE - 1) as f64).round() as usize;
            }
            self.bore_dirty = false;
            self.tract_dirty = true; // air changed
        }
        if self.tract_dirty || force {
            let v = |p: Param| self.smooth[p as usize].value;
            let (po, w) = (self.player.out, self.player.out.alt_w);
            use crate::player::blend;
            let glottis = blend(v(Param::GlottisOpen), po.alt.glottis_open, w).clamp(0.0, 1.0);
            self.tract.ctrl = TractControls {
                tongue_x: (blend(v(Param::TongueX) + po.tongue_x, po.alt.tongue_x, w) + po.tx_trim).clamp(0.0, 1.0),
                tongue_y: blend(v(Param::TongueY) + po.tongue_y, po.alt.tongue_y, w).clamp(0.0, 1.0),
                tongue_tip: blend(v(Param::TongueTip), po.alt.tongue_tip, w).clamp(0.0, 1.0),
                jaw_open: blend(v(Param::JawOpen) + po.jaw, po.alt.jaw_open, w).clamp(0.0, 1.0),
                glottis_area: GLOTTIS_MIN_AREA + glottis * (GLOTTIS_MAX_AREA - GLOTTIS_MIN_AREA),
                tongue_len: v(Param::TongueLength).clamp(0.0, 1.0),
            };
            let breath = Air::breath();
            let sub_on = v(Param::Subglottal) >= 0.5;
            if sub_on && !self.tract.sub_on {
                self.tract.sub.prefill(self.p_lung);
            }
            self.tract.sub_on = sub_on;
            self.tract.update_coeffs(self.dt, &breath);
            // glottis (PHYSICS.md §7): Bernoulli + viscous duct, d_g = A_g / 1.8 cm
            let g = glottis;
            let ag = GLOTTIS_MIN_AREA + g * (GLOTTIS_MAX_AREA - GLOTTIS_MIN_AREA);
            let dg = ag / 0.018;
            self.glot_a = breath.rho / (2.0 * ag * ag);
            self.glot_b = 12.0 * breath.eta * GLOTTIS_LEN / (ag * dg * dg);
            self.r_sub = breath.rho * breath.c / SUBGLOTTAL_AREA;
            self.tract_dirty = false;
        }
        if self.reed_dirty || force {
            let rc = self.reed_controls();
            self.reed.set_controls(&rc);
            self.tongue_inlet = 1.0 - 0.9 * self.smooth[Param::TongueReedContact as usize].value.max(self.player.out.tongue).clamp(0.0, 1.0);
            self.reed_dirty = false;
        }
    }

    pub fn set_param(&mut self, id: u32, value: f32) {
        let i = id as usize;
        if i >= NUM_PARAMS {
            return;
        }
        let v = clamp_param(i, value);
        self.params[i] = v;
        self.smooth[i].target = v as f64;
        if i == Param::LungPressure as usize {
            self.lung_target_pa = v as f64 * 1000.0;
            self.lungs.set_target_pa(self.lung_target_pa * self.player.out.pressure_scale);
        }
        if i == Param::Oversample as usize && v.round() as usize != self.os {
            self.need_rebuild = true;
        }
        if i == Param::ReedModel as usize {
            let beam = v >= 0.5;
            if beam != self.reed.use_beam {
                self.reed.use_beam = beam;
                self.reed.reset();
            }
        }
    }

    pub fn param(&self, id: Param) -> f32 {
        self.params[id as usize]
    }

    /// Snap all smoothed params to targets (offline rendering setup).
    pub fn snap_params(&mut self) {
        for s in self.smooth.iter_mut() {
            s.snap();
        }
        self.lungs.snap();
        if self.need_rebuild {
            self.rebuild();
        }
        self.update_coeffs(true);
    }

    pub fn set_key(&mut self, index: u32, pressed: f32) {
        let i = index as usize;
        if i < self.keys.len() {
            self.keys[i] = if pressed.is_finite() { pressed.clamp(0.0, 1.0) } else { 0.0 };
            self.evaluate_keys();
        }
    }

    pub fn set_key_by_name(&mut self, name: &str, pressed: f32) -> bool {
        if let Some(i) = self.keywork.key_index(name) {
            self.set_key(i as u32, pressed);
            true
        } else {
            false
        }
    }

    pub fn release_all_keys(&mut self) {
        self.keys.iter_mut().for_each(|k| *k = 0.0);
        self.evaluate_keys();
    }

    /// Jump pads to their targets (offline rendering setup).
    pub fn snap_pads(&mut self) {
        self.sync_holes();
        self.pads_moving = true;
        for h in self.holes.iter_mut() {
            h.openness = h.target;
        }
        self.bore_dirty = true;
        self.update_coeffs(true);
        self.open_holes.clear();
        for (k, h) in self.holes.iter().enumerate() {
            if !h.term.closed {
                self.open_holes.push(k);
            }
        }
        self.build_clusters();
    }

    fn evaluate_keys(&mut self) {
        let nh = self.holes.len();
        if nh == 0 {
            return;
        }
        self.keywork.evaluate(&self.keys, &mut self.hole_targets[..nh]);
        self.player.on_keys(&self.keys);
        for (h, t) in self.holes.iter_mut().zip(self.hole_targets.iter()) {
            h.target = *t as f64;
        }
        self.pads_moving = true;
    }

    /// Make `holes[..].term` authoritative again (copy the live bank states back)
    /// and schedule a bank rebuild — call before touching hole configuration/state.
    fn sync_holes(&mut self) {
        if !self.holes_dirty {
            self.bank.flush(&mut self.holes);
            self.holes_dirty = true;
        }
    }

    fn control_tick(&mut self) {
        let mut bore = false;
        let mut tract = false;
        let mut reed = false;
        for i in 0..NUM_PARAMS {
            let s = &mut self.smooth[i];
            if s.value == s.target {
                continue;
            }
            s.tick();
            let range = (PARAM_DEFS[i].max - PARAM_DEFS[i].min) as f64;
            if (s.value - s.target).abs() < 1e-5 * range {
                s.snap();
            }
            match i {
                x if x == Param::Temperature as usize
                    || x == Param::BaffleHeight as usize
                    || x == Param::ChamberSize as usize
                    || x == Param::ThroatDiameter as usize
                    || x == Param::MouthpieceInsertion as usize =>
                {
                    bore = true
                }
                x if x == Param::TongueX as usize
                    || x == Param::TongueY as usize
                    || x == Param::TongueTip as usize
                    || x == Param::JawOpen as usize
                    || x == Param::GlottisOpen as usize
                    || x == Param::Subglottal as usize
                    || x == Param::TongueLength as usize =>
                {
                    tract = true
                }
                x if x == Param::ReedStrength as usize
                    || x == Param::ReedDamping as usize
                    || x == Param::LipPosition as usize
                    || x == Param::LipForce as usize
                    || x == Param::LipDamping as usize
                    || x == Param::TipOpening as usize
                    || x == Param::FacingLength as usize
                    || x == Param::TongueReedContact as usize =>
                {
                    reed = true
                }
                _ => {}
            }
        }
        // player model
        let assist = self.smooth[Param::PlayerAssist as usize].value;
        self.player.base = self.base_reed_controls();
        if self.player.tick(assist, self.smooth[Param::Dynamic as usize].value, self.pitch.freq, self.lung_target_pa, self.smooth[Param::TongueReedContact as usize].value, CTRL_PERIOD as f64 / self.fs) {
            reed = true;
            tract = true;
            self.lungs.set_target_pa(self.lung_target_pa * self.player.out.pressure_scale);
        }
        self.bore_dirty |= bore;
        self.tract_dirty |= tract;
        self.reed_dirty |= reed;
        if self.bore_dirty || self.tract_dirty || self.reed_dirty {
            self.update_coeffs(false);
        }
    }

    /// One internal time step. Returns the radiated-pressure sample (Pa at listener).
    #[inline]
    fn step(&mut self) -> f64 {
        let rho = self.air.rho;
        let inv_dt = 1.0 / self.dt;
        // --- reed (driven by Δp of the previous step)
        self.reed.step(self.dp);
        let (h, u_sw) = (self.reed.opening(), self.reed.swept_flow());
        let n = self.bore.n;
        // pⁿ at the open branches (the fast bank keeps it from its last solve)
        if self.bank_capture {
            self.bank.capture(&self.bore.p);
            self.bank_capture = false;
        }
        for &(a, b) in self.bank.multi.iter() {
            for &k in self.open_holes[a..b].iter() {
                self.hole_flow[k] = self.holes[k].p_at(&self.bore.p);
            }
        }
        let p_bell_old = self.bore.p[n - 1] as f64;
        // --- volume velocities and interior pressures (fused sweep)
        self.bore.step();
        if self.use_tract {
            self.tract.tube.step();
        }
        // bell end node, solved jointly with the radiation load
        {
            let k = self.bore.kp[n - 1] as f64;
            let p_tmp = p_bell_old + k * self.bore.u[n - 2] as f64;
            let ub = self.bell.step_pre(&self.bell_c, p_bell_old, p_tmp, inv_dt);
            self.bore.p[n - 1] = (p_tmp - k * ub) as f32;
        }
        // tone-hole branches, each solved jointly with its node(s)
        self.bank.solve(&mut self.bore.p, inv_dt);
        for &(a, b) in self.bank.multi.iter() {
            solve_cluster(&mut self.holes, &self.open_holes[a..b], &self.hole_flow, &mut self.bore.p, inv_dt);
        }
        // --- turbulence noise (PHYSICS.md §6): U_n = 0.1·bn·U_f·ξ, ξ band-passed
        // 1–8 kHz, faded in above jet Reynolds number Re = U_f/(w ν) ≈ 1200
        let bn = self.smooth[Param::BreathNoise as usize].value;
        let w_eff = self.inst.reed_width * self.tongue_inlet;
        let noise_reed = if bn > 0.0 {
            let re = self.u_bern.abs() / (self.inst.reed_width * self.air.eta / rho);
            let gate = ((re - 1200.0) / 600.0).clamp(0.0, 1.0);
            if gate > 0.0 {
                0.1 * bn * gate * self.u_bern.abs() * self.lungs.noise()
            } else {
                0.0
            }
        } else {
            0.0
        };
        // --- glottis (lungs → tract node 0) and mouth pressure
        let (pm_old, km, ut) = if self.use_tract {
            let t = &self.tract.tube;
            let kg = t.kp[0] as f64;
            let pg = t.p[0] as f64;
            let u0 = t.u[0] as f64;
            // subglottal airways (tract.rs): p_sub = p_sub_pre − k_sub·U_g
            let (ps, ks) = self.tract.subglottal_pre(self.p_lung, self.ug_mean, self.r_sub);
            let t = &mut self.tract.tube;
            let kk = kg + ks;
            let rhs = ps - pg + kg * u0;
            let ug = solve_channel(rhs, kk, self.glot_a, self.glot_b);
            self.ug_mean += self.ug_coef * (ug - self.ug_mean);
            t.p[0] = (pg + kg * (ug - u0)) as f32;
            let m = t.n - 1;
            let r = (t.p[m] as f64, t.kp[m] as f64, t.u[m - 1] as f64);
            self.tract.subglottal_post(ug);
            r
        } else {
            (self.p_lung, 0.0, 0.0)
        };
        // --- reed junction: mouth node ↔ mouthpiece node 0 (PHYSICS.md E6)
        let p0 = self.bore.p[0] as f64;
        let k0 = self.bore.kp[0] as f64;
        let ub0 = self.bore.u[0] as f64;
        let (ca, cb) = channel_coefs(rho, self.air.eta, self.vena_contracta, w_eff, h, CHANNEL_LEN);
        let u_extra = u_sw + noise_reed;
        let ktot = km + k0;
        let b = (pm_old + km * ut) - (p0 - k0 * ub0);
        // reed-channel air inertia ρ ℓ/(w h) (implicit, backward Euler in U)
        let li = if h > 1e-9 && w_eff > 0.0 { rho * self.channel_inertia_len / (w_eff * h) * inv_dt } else { 0.0 };
        let u_b = solve_channel(b - ktot * u_extra + li * self.u_bern, ktot + li, ca, cb);
        let u_r = u_b + u_extra;
        let p0n = p0 + k0 * (u_r - ub0);
        let pmn = if self.use_tract {
            let pm = pm_old + km * (ut - u_r);
            let m = self.tract.tube.n - 1;
            self.tract.tube.p[m] = pm as f32;
            pm
        } else {
            self.p_lung
        };
        self.bore.p[0] = p0n as f32;
        self.dp = pmn - p0n;
        self.p_mouth = pmn;
        self.u_reed = u_r;
        self.u_bern = u_b;
        // --- radiation: monopoles ρ/(4πr)·dU/dt, delayed per source
        let mask = RAD_RING - 1;
        let pos = self.rad_pos;
        let mut now = self.bell.dudt * self.bell_gain;
        if self.bell_delay > 0 {
            self.rad_ring[(pos + self.bell_delay) & mask] += now as f32;
            now = 0.0;
        }
        for f in self.bank.fast.iter() {
            let v = f.term.dudt * f.gain;
            if f.delay == 0 {
                now += v;
            } else {
                self.rad_ring[(pos + f.delay) & mask] += v as f32;
            }
        }
        for &(a, b) in self.bank.multi.iter() {
            for &k in self.open_holes[a..b].iter() {
                let hole = &self.holes[k];
                let v = hole.term.dudt * hole.gain;
                if hole.delay == 0 {
                    now += v;
                } else {
                    self.rad_ring[(pos + hole.delay) & mask] += v as f32;
                }
            }
        }
        let delayed = self.rad_ring[pos] as f64;
        self.rad_ring[pos] = 0.0;
        self.rad_pos = (pos + 1) & mask;
        (now + delayed) * rho / (4.0 * core::f64::consts::PI)
    }

    /// Sort open holes by node and group those whose node pairs overlap.
    fn build_clusters(&mut self) {
        let holes = &self.holes;
        let oh = &mut self.open_holes;
        // insertion sort by node (≤ 64 elements, no allocation)
        for i in 1..oh.len() {
            let mut j = i;
            while j > 0 && holes[oh[j - 1]].node > holes[oh[j]].node {
                oh.swap(j - 1, j);
                j -= 1;
            }
        }
        self.clusters.clear();
        let mut start = 0;
        for i in 1..=oh.len() {
            if i == oh.len() || holes[oh[i]].node > holes[oh[i - 1]].node + 1 {
                if i > start {
                    self.clusters.push((start, i));
                }
                start = i;
            }
        }
    }

    fn reset_state(&mut self) {
        self.sync_holes();
        self.bore.clear_state();
        self.tract.clear_state();
        for h in self.holes.iter_mut() {
            h.term.reset();
        }
        self.bell.reset();
        self.reed.reset();
        self.dec.reset();
        self.rad_ring.iter_mut().for_each(|x| *x = 0.0);
        self.dp = 0.0;
        self.u_reed = 0.0;
        self.u_bern = 0.0;
        self.dc_x1 = 0.0;
        self.dc_y1 = 0.0;
        self.ug_mean = 0.0;
        self.mp_dc = 0.0;
        self.out_ms = 0.0;
        self.p_mouth = 0.0;
        self.prof_ms.iter_mut().for_each(|x| *x = 0.0);
        self.scope_p.iter_mut().for_each(|x| *x = 0.0);
        self.scope_y.iter_mut().for_each(|x| *x = 0.0);
        self.cap_pmp.iter_mut().for_each(|x| *x = 0.0);
        self.cap_pm.iter_mut().for_each(|x| *x = 0.0);
        self.cap_y.iter_mut().for_each(|x| *x = 0.0);
        self.cap_u.iter_mut().for_each(|x| *x = 0.0);
        self.pitch.reset();
        self.lungs.reset_noise();
        self.fade = 0.0;
        self.resets += 1;
    }

    /// Silence all acoustic / reed / lung / player run-time state, keeping geometry,
    /// params and keys (`sax_reset_state`): two renders after a reset with the same
    /// seed are bit-identical.
    pub fn reset_offline(&mut self) {
        // 1. bring every control to its target (params, pads, coefficients) …
        if self.need_rebuild {
            self.rebuild();
        }
        for i in 0..self.smooth.len() {
            self.smooth[i].snap();
        }
        self.player.reset_runtime();
        self.snap_pads();
        self.update_coeffs(true);
        // 2. … then clear every dynamic state, so nothing depends on the history
        self.reset_state();
        self.resets = self.resets.saturating_sub(1);
        self.lungs.pressure = 0.0;
        self.p_lung = 0.0;
        self.lungs.set_target_pa(self.lung_target_pa);
        self.ctrl_count = 0;
        self.sample_count = 0;
        self.scope_pos = 0;
        self.rad_pos = 0;
        self.dec.reset_full();
        self.pitch.reset();
        self.bank_capture = true;
    }

    /// Seed the breath-noise RNG (`sax_set_seed`).
    pub fn set_seed(&mut self, seed: u32) {
        self.lungs.set_seed(seed as u64);
    }

    /// Output scale: digital full scale per Pa at the 1 m listener.
    pub const OUTPUT_PA_TO_FS: f64 = PA_TO_FS;

    /// Advance `n` output samples; returns the output buffer.
    pub fn process(&mut self, n: usize) -> &[f32] {
        #[cfg(not(target_arch = "wasm32"))]
        let t0 = std::time::Instant::now();
        let n = n.min(MAX_BLOCK);
        if self.need_rebuild {
            self.rebuild();
        }
        let gain = self.smooth[Param::MasterGain as usize].value;
        let mut out_ms_acc = 0.0;
        // bore pressures may have been touched between blocks (state resets)
        self.bank_capture = true;
        for s in 0..n {
            if self.ctrl_count == 0 {
                self.control_tick();
            }
            self.ctrl_count = (self.ctrl_count + 1) % CTRL_PERIOD;
            self.p_lung = self.lungs.tick();
            // pads (skipped while every pad rests at its target: nothing changes)
            if self.pads_moving {
                self.sync_holes();
                self.open_holes.clear();
                let mut moving = false;
                for (k, h) in self.holes.iter_mut().enumerate() {
                    let was_closed = h.openness < crate::toneholes::OPEN_EPS;
                    h.slew(self.pad_coef, self.pad_coef_open);
                    if was_closed != (h.openness < crate::toneholes::OPEN_EPS) {
                        // open/closed series correction changes → refresh bore coefficients
                        self.bore_dirty = true;
                    }
                    h.configure(self.dt, &self.air, false);
                    self.pad_openness[k] = h.openness as f32;
                    if !h.term.closed {
                        self.open_holes.push(k);
                    }
                    // `slew` leaves a pad alone within 1e-6 of its target
                    moving |= (h.target - h.openness).abs() > 1e-6;
                }
                self.build_clusters();
                self.pads_moving = moving;
            }
            if self.holes_dirty {
                self.bank.build(&self.holes, &self.open_holes, &self.clusters);
                self.holes_dirty = false;
                self.bank_capture = true;
            }
            let mut y = 0.0f32;
            for _ in 0..self.os {
                let r = self.step();
                if let Some(o) = self.dec.push(r as f32) {
                    y = o;
                }
            }
            // DC block + gain + soft limit
            if self.fade < 1.0 {
                self.fade = (self.fade + self.fade_coef).min(1.0);
            }
            let x = y as f64 * PA_TO_FS * gain * self.fade;
            let dc = x - self.dc_x1 + self.dc_r * self.dc_y1;
            self.dc_x1 = x;
            self.dc_y1 = dc;
            let mut o = dc;
            if !o.is_finite() {
                o = 0.0;
            }
            let lim = 0.95;
            if o.abs() > lim {
                o = o.signum() * (lim + (1.0 - lim) * ((o.abs() - lim) / (1.0 - lim)).tanh());
            }
            self.out[s] = o as f32;
            out_ms_acc += o * o;
            // telemetry at output rate
            let pmp = self.bore.p[0] as f64;
            self.cap_pmp[s] = pmp as f32;
            self.cap_pm[s] = self.p_mouth as f32;
            self.cap_y[s] = self.reed_y() as f32;
            self.cap_u[s] = self.u_reed as f32;
            self.mp_dc += 0.0005 * (pmp - self.mp_dc);
            self.pitch.push(pmp - self.mp_dc);
            self.sample_count += 1;
            if self.sample_count % SCOPE_STRIDE as u64 == 0 {
                self.scope_p[self.scope_pos] = pmp as f32;
                self.scope_y[self.scope_pos] = self.reed_y() as f32;
                self.scope_pos = (self.scope_pos + 1) % SCOPE_LEN;
            }
            if self.sample_count % PROFILE_STRIDE as u64 == 0 {
                // RMS profile (mean square, τ≈150 ms, sampled at fs/PROFILE_STRIDE)
                let c = (PROFILE_STRIDE as f64 / (0.15 * self.fs)) as f32;
                for j in 0..N_PROFILE {
                    let pv = self.bore.p[self.prof_idx[j]];
                    self.prof_ms[j] += c * (pv * pv - self.prof_ms[j]);
                }
            }
        }
        // hole states back into `holes` (health check, observers)
        if !self.holes_dirty {
            self.bank.flush(&mut self.holes);
        }
        // health check
        let bad = if self.bore.is_bad() {
            Some("bore")
        } else if self.use_tract && self.tract.is_bad() {
            Some("tract")
        } else if !self.dp.is_finite() {
            Some("dp")
        } else if !self.reed_y().is_finite() {
            Some("reed")
        } else if self.holes.iter().any(|h| !(h.term.u.is_finite() && h.term.il.is_finite() && h.term.is.is_finite())) {
            Some("holes")
        } else if !self.bell.u.is_finite() {
            Some("bell")
        } else {
            None
        };
        if let Some(why) = bad {
            self.last_reset_reason = why;
            self.reset_state();
            for o in self.out[..n].iter_mut() {
                *o = 0.0;
            }
        }
        if n > 0 {
            self.out_ms += 0.5 * (out_ms_acc / n as f64 - self.out_ms);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.last_cpu_us = t0.elapsed().as_secs_f64() as f32 * 1e6;
        }
        self.fill_telemetry();
        &self.out[..n]
    }

    /// Pressure impulse response at the reed end of the instrument (current
    /// fingering, pads at their present openness) to a unit volume-velocity
    /// impulse with a rigid reed — the time-domain input impedance z(t) at the
    /// internal rate. Works on copies; does not disturb the running state.
    /// (Not real-time safe: allocates. For validation & the M5 impedance plot.)
    pub fn impulse_response(&self, steps: usize) -> Vec<f64> {
        let mut bore = self.bore.clone();
        bore.clear_state();
        let mut holes = self.holes.clone();
        let mut bell = self.bell;
        bell.reset();
        for h in holes.iter_mut() {
            h.term.reset();
        }
        let inv_dt = 1.0 / self.dt;
        let n = bore.n;
        let mut pold = vec![0.0; holes.len()];
        let mut out = Vec::with_capacity(steps);
        for s in 0..steps {
            for (k, h) in holes.iter().enumerate() {
                pold[k] = h.p_at(&bore.p);
            }
            let pb = bore.p[n - 1] as f64;
            let p0 = bore.p[0] as f64;
            bore.step();
            let k = bore.kp[n - 1] as f64;
            let pt = pb + k * bore.u[n - 2] as f64;
            let ub = bell.step(pb, pt, k, inv_dt);
            bore.p[n - 1] = (pt - k * ub) as f32;
            for &(a, b) in self.clusters.iter() {
                solve_cluster(&mut holes, &self.open_holes[a..b], &pold, &mut bore.p, inv_dt);
            }
            let uin = if s == 0 { 1.0 * inv_dt * 1e-9 } else { 0.0 }; // 1e-9 m³ volume impulse
            bore.p[0] = (p0 + bore.kp[0] as f64 * (uin - bore.u[0] as f64)) as f32;
            out.push(bore.p[0] as f64 * 1e9);
        }
        out
    }

    pub fn reed_y(&self) -> f64 {
        self.reed.tip_displacement()
    }
    pub fn reed_h(&self) -> f64 {
        self.reed.opening()
    }
    pub fn mouthpiece_pressure(&self) -> f64 {
        self.bore.p[0] as f64
    }
    pub fn mouth_pressure(&self) -> f64 {
        self.p_mouth
    }
    pub fn lung_pressure(&self) -> f64 {
        self.p_lung
    }
    pub fn reed_flow(&self) -> f64 {
        self.u_reed
    }
    pub fn pitch_hz(&self) -> f64 {
        self.pitch.freq
    }
    pub fn decimator_latency(&self) -> f64 {
        self.dec.latency_out()
    }

    fn fill_telemetry(&mut self) {
        let t = &mut self.telemetry;
        t[idx::LUNG] = self.p_lung as f32;
        t[idx::MOUTH] = self.p_mouth as f32;
        t[idx::MOUTHPIECE] = self.bore.p[0];
        t[idx::REED_Y] = self.reed.tip_displacement() as f32;
        t[idx::REED_H] = self.reed.opening() as f32;
        self.reed.profile(&mut t[telemetry::IDX_REED_SHAPE..telemetry::IDX_REED_SHAPE + telemetry::REED_SHAPE_LEN]);
        t[idx::FLOW] = self.u_reed as f32;
        t[idx::FREQ] = self.pitch.freq as f32;
        t[idx::OUT_RMS] = self.out_ms.max(0.0).sqrt() as f32;
        t[idx::CPU_US] = self.last_cpu_us;
        t[idx::SUBGLOTTAL] = if self.use_tract { self.tract.p_subglottal() } else { self.p_lung } as f32;
        t[idx::GLOTTAL_FLOW] = if self.use_tract { self.tract.u_glottis } else { self.u_reed } as f32;
        t[idx::N_PROFILE] = N_PROFILE as f32;
        for j in 0..N_PROFILE {
            t[telemetry::IDX_PROFILE + j] = self.bore.p[self.prof_idx[j]];
            t[telemetry::IDX_RMS + j] = self.prof_ms[j].max(0.0).sqrt();
        }
        for j in 0..SCOPE_LEN {
            let k = (self.scope_pos + j) % SCOPE_LEN;
            t[telemetry::IDX_SCOPE_P + j] = self.scope_p[k];
            t[telemetry::IDX_SCOPE_Y + j] = self.scope_y[k];
        }
    }
}
