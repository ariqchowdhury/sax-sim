//! Player model (M3): an optional "auto-embouchure" assistant that does what
//! saxophonists do per note — loosen and drop the jaw for low notes, firm up
//! and add support for the upper register, voice the tract (high front
//! tongue) for palm-key notes — and, if the instrument still sounds in the
//! wrong register, nudges lip force / blowing pressure / tongue height until it
//! locks. `player_assist` = 0 leaves the pure physics untouched (all offsets 0).
//!
//! The intended note is recognised from the pressed keys (exact match against
//! `fingerings` / `alternate_fingerings` in the geometry). Unknown key
//! combinations get no feed-forward and no register feedback.

use crate::geometry::GeometryJ;
use crate::keywork::Keywork;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PlayerOffsets {
    /// added to lip_force (N)
    pub lip: f64,
    /// multiplies the lung-pressure target
    pub pressure_scale: f64,
    pub tongue_y: f64,
    pub tongue_x: f64,
    pub jaw: f64,
    /// added to lip_damping
    pub lip_damping: f64,
    /// added to lip_position (mm; dynamics: more mouthpiece at pp)
    pub lip_position: f64,
    /// altissimo voicing: weight 0…1 (ramped) of the absolute targets `alt`,
    /// plus a pitch-holding trim added to tongue_x after blending
    pub alt_w: f64,
    pub alt: AltVoicing,
    pub tx_trim: f64,
    /// player's own tongue on the reed (re-articulation), 0…1
    pub tongue: f64,
}

/// Absolute voicing targets of an altissimo fingering (NaN = not specified).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AltVoicing {
    pub lip_force: f64,
    pub lip_position: f64,
    pub lip_damping: f64,
    pub reed_damping: f64,
    pub glottis_open: f64,
    pub tongue_x: f64,
    pub tongue_y: f64,
    pub tongue_tip: f64,
    pub jaw_open: f64,
}

impl Default for AltVoicing {
    fn default() -> Self {
        let n = f64::NAN;
        AltVoicing { lip_force: n, lip_position: n, lip_damping: n, reed_damping: n, glottis_open: n, tongue_x: n, tongue_y: n, tongue_tip: n, jaw_open: n }
    }
}

/// Blend `base` toward the voicing target `t` with weight `w` (NaN target = keep).
#[inline]
pub fn blend(base: f64, t: f64, w: f64) -> f64 {
    if t.is_nan() || w <= 0.0 {
        base
    } else {
        base + w * (t - base)
    }
}

impl PlayerOffsets {
    /// True when the offsets leave every control untouched (pure physics).
    pub fn is_neutral(&self) -> bool {
        self.lip == 0.0
            && self.pressure_scale == 1.0
            && self.tongue_y == 0.0
            && self.tongue_x == 0.0
            && self.jaw == 0.0
            && self.lip_damping == 0.0
            && self.lip_position == 0.0
            && self.alt_w == 0.0
            && self.tx_trim == 0.0
            && self.tongue == 0.0
    }
}

#[derive(Clone, Debug, Default)]
struct NoteInfo {
    mask: u64,
    f_target: f64,
    register: i32,
    alt: Option<AltVoicing>,
    /// pad openness (0 closed … 1 open) per tone hole for this fingering (nearest-fingering
    /// matching of unrecognised key combinations)
    pads: Vec<f32>,
    /// auto-player table entry (`auto_player.entries`) for this key set
    auto: Option<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct Player {
    notes: Vec<NoteInfo>,
    pub current: Option<usize>,
    /// adaptive register-locking state, −1 (lower) … +1 (raise)
    adapt: f64,
    silent_t: f64,
    hold_t: f64,
    /// onset pressure boost (pp notes start above threshold, then the player
    /// relaxes onto the soft, hysteretic branch)
    boost: f64,
    /// altissimo voicing ramp state, the voicing being ramped, pitch trim
    alt_w: f64,
    alt_cur: AltVoicing,
    tx_trim: f64,
    lip_trim: f64,
    wrong_t: f64,
    dip_t: f64,
    /// altissimo "voice, then attack": remaining tongue-stop time, the altissimo
    /// fingering last selected and the previous requested lung pressure
    alt_gate_t: f64,
    alt_sel: Option<usize>,
    prev_lung: f64,
    /// dynamics excursion currently applied (0 = mf) and its learnt per-note limit
    dyn_w: f64,
    dyn_cap: Option<f64>,
    prev_freq: f64,
    dyn_trim: f64,
    bad_t: f64,
    dyn_retry: bool,
    emb_w: f64,
    /// the player's own (un-offset) reed/embouchure controls, set by the engine
    pub base: crate::reed::ReedControls,
    pub out: PlayerOffsets,
    /// auto player (param `auto_player`): voicing table, key mechanism (pad states of
    /// unrecognised key sets) and run-time state
    table: Option<AutoTable>,
    kw: Option<crate::keywork::Keywork>,
    pads_buf: Vec<f32>,
    keys_now: Vec<f32>,
    pub auto: AutoState,
    /// altissimo voicing replacing the note's notated one for one tick (auto-player table)
    alt_override: Option<AltVoicing>,
}


// ---- dynamics (PHYSICS.md §11/§12) ----------------------------------------------------------
// The oscillation is born subcritically (inverse Hopf) with an amplitude of order 0.3·p_M, so
// blowing pressure alone spans only ~6–12 dB. Players play pp by closing the reed: a pinched,
// well-damped lower lip on more mouthpiece lowers the reed opening H0 and the closing pressure
// p_M = K·H0/S_r (here ≈ 6.7 → 2 kPa), and they blow just above the soft branch's extinction
// (γ = p/p_M ≈ 0.35). The amplitude of the whole regime scales with p_M, so pp is ~25 dB below
// ff, not beating and dark; ff = loose, lightly damped lip and ≈ 2× the mf pressure (strong
// beating, bright). pp/ff are absolute embouchure targets blended in with the dynamic.

/// pp embouchure: lip force (N), lip position (mm from the tip), lip-damping offset
pub const DYN_PP_LIP_FORCE: f64 = 2.8;
/// palm-key notes (≥ DYN_PP_R2_FMAX): pp lip force (N) and blowing ratio γ
pub const DYN_PP_LIP_FORCE_PALM: f64 = 2.0;
pub const DYN_PP_GAMMA_PALM: f64 = 0.55;
/// palm-key notes ease toward pp more slowly (their soft branch is narrow), s
pub const DYN_RELAX_TAU_PALM: f64 = 1.0;
/// palm-key notes: pp lip position (mm) — a little less mouthpiece than the default
pub const DYN_PP_LIP_POS_PALM: f64 = 14.0;
pub const DYN_PP_LIP_POS: f64 = 16.0;
/// pp lip position for register-2 notes (mm): further in, against the pinched lip's sharpness
pub const DYN_PP_LIP_POS_R2: f64 = 18.5;
pub const DYN_PP_DAMP: f64 = 0.4;
/// pp blowing pressure as a fraction of the pp embouchure's closing pressure p_M
pub const DYN_PP_GAMMA: f64 = 0.42;
/// pp pitch trim on the lip position: gain (mm/(cent·s)) beyond a dead band (cents), limit (mm)
pub const DYN_TRIM_GAIN: f64 = 0.1;
pub const DYN_TRIM_DEADBAND: f64 = 8.0;
pub const DYN_TRIM_MAX: f64 = 3.0;
/// trim limit outside the upper register (mm): more mouthpiece cracks the low notes up and
/// drops the palm notes; their pp pitch is within ±10 ¢ without it
pub const DYN_TRIM_MAX_R1: f64 = 0.0;
/// upper-register pp lip position applies below this target frequency (Hz)
pub const DYN_PP_R2_FMAX: f64 = 720.0;
/// after a note dies or cracks at excursion w, the player limits it to DYN_BACKOFF·w
pub const DYN_BACKOFF: f64 = 0.85;
/// lag of the second gesture behind the first when moving away from mf (s)
pub const DYN_EMB_TAU: f64 = 0.12;
/// relaxation time from the mf onset (pressure and embouchure) to the soft target (s)
pub const DYN_RELAX_TAU: f64 = 0.3;
/// ff: lip-force and lip-damping offsets, pressure factor
pub const DYN_FF_LIP: f64 = -0.6;
pub const DYN_FF_DAMP: f64 = -0.4;
pub const DYN_FF_PRESSURE: f64 = 2.0;

/// Reed closing pressure p_M = K·H0/S_r (Pa) of an embouchure.
pub fn closing_pressure(c: &crate::reed::ReedControls) -> f64 {
    let r = crate::reed::derive_reed_params(c);
    r.k * (r.tip_opening - r.y_eq) / r.s_r
}

/// altissimo voicing ramp time (s), tongue_x pitch-trim gain (1/(cent·s)),
/// register-seek rate (1/s) and trim limit
pub const ALT_RAMP: f64 = 0.12;
pub const ALT_TRIM_GAIN: f64 = 0.001;
/// tongue trim acts only beyond this pitch error (cents)
pub const ALT_COARSE_CENTS: f64 = 20.0;
pub const ALT_SEEK_RATE: f64 = 0.1;
pub const ALT_TRIM_MAX: f64 = 0.1;
/// re-articulation when stuck below an altissimo target: after this long in
/// the wrong regime (s), the player touches the reed with the tongue for
/// ALT_DIP_TIME (s) — a light re-tongue — so the note restarts voiced
pub const ALT_REARTIC_AFTER: f64 = 0.12;
pub const ALT_DIP_TIME: f64 = 0.08;
/// "voice, then attack" (PHYSICS.md §11): on a new altissimo fingering or a new
/// attack the player keeps the tongue on the reed until the voicing ramp is in
/// place and at least ALT_SETTLE has passed — so the previous note's bore
/// oscillation, ringing down with amplitude time constant τ = Q/(πf) ≈ 60–150 ms
/// (Q ≈ 55, T60 ≈ 120/f0), has decayed enough (≳ 6–15 dB) that it no longer
/// seeds the low regime. Measured: pure physics locks 18/18 for
/// gaps ≥ 0.1 s, 6/18 at 0.05 s.
pub const ALT_SETTLE: f64 = 0.1;
/// lip-force pitch-trim gain (N/(cent·s)) and limit (N)
pub const ALT_LIP_GAIN: f64 = 0.006;
pub const ALT_LIP_MAX: f64 = 0.6;
/// the lip may relax by at most this much (a looser lip loses the altissimo regime)
pub const ALT_LIP_MIN: f64 = -0.25;

/// rate of the register-locking integrator (1/s)
const ADAPT_RATE: f64 = 2.5;

impl Player {
    pub fn from_geometry(g: &GeometryJ, kw: &Keywork) -> Player {
        let mut notes = Vec::new();
        let mut add = |keys: &[String], f: Option<f64>, reg: Option<i32>| {
            let mut mask = 0u64;
            for k in keys {
                if let Some(i) = kw.key_index(k) {
                    if i < 64 {
                        mask |= 1 << i;
                    }
                }
            }
            if let Some(f) = f {
                notes.push(NoteInfo { mask, f_target: f, register: reg.unwrap_or(if f > 340.0 { 2 } else { 1 }), pads: pads_of(kw, mask), ..Default::default() });
            }
        };
        for f in &g.fingerings {
            add(&f.keys, f.f_target, f.register);
        }
        Player {
            notes,
            out: PlayerOffsets { pressure_scale: 1.0, ..Default::default() },
            kw: Some(kw.clone()),
            pads_buf: vec![0.0; kw.hole_ids.len()],
            keys_now: Vec::with_capacity(kw.key_ids.len().max(64)),
            ..Default::default()
        }
    }

    /// Read `alternate_fingerings` entries with `register: 3` (altissimo) and
    /// their per-note `tract` / `embouchure` voicing from the geometry JSON.
    pub fn load_alternates(&mut self, json: &str, kw: &Keywork) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return };
        let Some(arr) = v.get("alternate_fingerings").and_then(|a| a.as_array()) else { return };
        for a in arr {
            if a.get("register").and_then(|r| r.as_i64()) != Some(3) {
                continue;
            }
            let Some(f) = a.get("f_target").and_then(|x| x.as_f64()) else { continue };
            let mut mask = 0u64;
            let mut ok = true;
            for k in a.get("keys").and_then(|k| k.as_array()).into_iter().flatten() {
                match k.as_str().and_then(|n| kw.key_index(n)) {
                    Some(i) if i < 64 => mask |= 1 << i,
                    _ => ok = false,
                }
            }
            if !ok {
                continue;
            }
            let get = |sec: &str, key: &str| a.get(sec).and_then(|s| s.get(key)).and_then(|x| x.as_f64()).unwrap_or(f64::NAN);
            let alt = AltVoicing {
                lip_force: get("embouchure", "lip_force"),
                lip_position: get("embouchure", "lip_position"),
                lip_damping: get("embouchure", "lip_damping"),
                reed_damping: get("embouchure", "reed_damping"),
                glottis_open: get("embouchure", "glottis_open"),
                tongue_x: get("tract", "tongue_x"),
                tongue_y: get("tract", "tongue_y"),
                tongue_tip: get("tract", "tongue_tip"),
                jaw_open: get("tract", "jaw_open"),
            };
            // standard fingerings take precedence on identical key sets
            if !self.notes.iter().any(|n| n.mask == mask) {
                self.notes.push(NoteInfo { mask, f_target: f, register: 3, alt: Some(alt), pads: pads_of(kw, mask), auto: None });
            }
        }
        self.load_auto_table(&v, kw);
    }

    /// Lagging part of the dynamics excursion (breath toward pp, lip toward ff):
    /// follows `w` with DYN_EMB_TAU, immediately when backing off toward mf.
    fn emb_lag(&mut self, w: f64, dt: f64) -> f64 {
        if w < self.emb_w {
            self.emb_w = w;
        } else {
            self.emb_w += (w - self.emb_w) * (dt / DYN_EMB_TAU).min(1.0);
        }
        self.emb_w
    }

    /// Forget all run-time adaptation (register locking, dynamics learning,
    /// altissimo ramps…) — keeps the note table, current fingering and the
    /// player's base controls. For deterministic back-to-back offline renders.
    pub fn reset_runtime(&mut self) {
        let fresh = Player {
            notes: core::mem::take(&mut self.notes),
            current: self.current,
            base: self.base,
            out: PlayerOffsets { pressure_scale: 1.0, ..Default::default() },
            table: self.table.take(),
            kw: self.kw.take(),
            pads_buf: core::mem::take(&mut self.pads_buf),
            keys_now: core::mem::take(&mut self.keys_now),
            auto: AutoState { voice: self.auto.voice, matched: self.auto.matched, ..Default::default() },
            ..Default::default()
        };
        *self = fresh;
    }

    /// Recognise the fingering from key press amounts.
    pub fn on_keys(&mut self, keys: &[f32]) {
        let mut mask = 0u64;
        for (i, &k) in keys.iter().enumerate().take(64) {
            if k > 0.5 {
                mask |= 1 << i;
            }
        }
        let prev = self.current;
        self.current = self.notes.iter().position(|n| n.mask == mask);
        self.keys_now.clear();
        self.keys_now.extend_from_slice(keys);
        self.match_voice();
        if self.current != prev {
            self.adapt = 0.0;
            self.silent_t = 0.0;
            self.hold_t = 0.12;
            self.dyn_cap = None;
            self.dyn_w = 0.0;
            self.dyn_retry = false;
            self.dyn_trim = 0.0;
        }
    }

    pub fn target_hz(&self) -> Option<f64> {
        self.current.map(|i| self.notes[i].f_target)
    }

    /// Control-rate update. `freq` = tracked playing frequency (0 = silent),
    /// `lung_pa` = requested lung pressure, `dt` = tick period (s).
    /// Returns true when the offsets changed.
    pub fn tick(&mut self, assist: f64, dynamic: f64, freq: f64, lung_pa: f64, tongue: f64, dt: f64) -> bool {
        self.tick_inner(assist, dynamic, freq, lung_pa, tongue, dt, false)
    }

    /// `tick` with the per-note feed-forward optionally disabled (auto player with a voicing
    /// table: the table already holds the per-note embouchure).
    #[allow(clippy::too_many_arguments)]
    fn tick_inner(&mut self, assist: f64, dynamic: f64, freq: f64, lung_pa: f64, tongue: f64, dt: f64, no_ff: bool) -> bool {
        let base = self.base;
        let a = assist.clamp(0.0, 1.0);
        let mut o = PlayerOffsets { pressure_scale: 1.0, ..Default::default() };
        if a > 0.0 {
            // --- dynamics through the embouchure (see the DYN_* constants)
            let d = dynamic.clamp(0.0, 1.0) - 0.5;
            // onset: soft notes start at the mf embouchure and pressure — where the
            // intended register is the stable one — and relax onto the soft branch
            // (relax only while the intended register sounds; a wrong regime keeps
            // the mf embouchure so the register lock below can act)
            let in_reg = match self.current {
                Some(i) if freq > 0.0 => (1200.0 * (freq / self.notes[i].f_target).log2()).abs() < 300.0,
                None => freq > 0.0,
                _ => false,
            };
            // A note that dies (soft branch lost) or cracks (wrong register) while
            // the player is easing toward pp/ff makes them back off to the mf
            // embouchure and remember a smaller excursion for this note — the
            // way a player learns how soft / loud a note will go.
            let held = tongue <= 0.2 && lung_pa >= 500.0;
            // (a single pitch-tracker frame — 20 ms — is not a crack: require 50 ms)
            if held && self.dyn_w > 0.15 && (freq <= 0.0 || !in_reg) {
                self.bad_t += dt;
            } else {
                self.bad_t = 0.0;
            }
            if self.bad_t > 0.05 {
                // first failure: retry once with a neutral throat/jaw (the low-note
                // voicing changes the tract load, which decides between the
                // fundamental and the octave on the soft branch); then cap
                let low_voiced = self.current.map(|i| self.notes[i].register == 1 && self.notes[i].f_target < 180.0).unwrap_or(false);
                if low_voiced && !self.dyn_retry {
                    self.dyn_retry = true;
                } else {
                    self.dyn_cap = Some((self.dyn_w * DYN_BACKOFF).min(self.dyn_cap.unwrap_or(1.0)));
                }
                self.boost = 1.0;
                self.bad_t = 0.0;
            }
            if !held || (freq <= 0.0 && self.dyn_w <= 0.15) {
                self.boost = 1.0;
            } else if in_reg {
                let palm_note = self.current.map(|i| self.notes[i].register >= 2 && self.notes[i].f_target >= DYN_PP_R2_FMAX).unwrap_or(false);
                let tau = if palm_note && d < 0.0 { DYN_RELAX_TAU_PALM } else { DYN_RELAX_TAU };
                self.boost *= 1.0 - dt / tau;
            }
            self.dyn_w = 0.0;
            if d < 0.0 {
                // weight toward the pp embouchure (eased so mp stays near mf)
                let t = -2.0 * d;
                let w = (t * t * (3.0 - 2.0 * t) * (1.0 - self.boost)).min(self.dyn_cap.unwrap_or(1.0));
                self.dyn_w = w;
                // Lip and breath move together so that γ = p/p_M falls smoothly
                // from the mf value to γ_pp: the blowing pressure follows the
                // closing pressure of the momentary embouchure. (Firming the lip at
                // still-high γ, or easing off the air before the lip has firmed,
                // both push low notes — 2nd impedance peak ≥ 1st — onto their
                // octave.) The breath command leads the lip by the lungs' lag.
                let we = self.emb_lag(w, dt);
                // pp lip position: register 1 at DYN_PP_LIP_POS (more mouthpiece there pushes
                // the low notes onto their octave), the upper register further in
                // (DYN_PP_LIP_POS_R2): a longer free reed has a larger equivalent volume and
                // flattens the pinched pp lip's sharpness; plus a pitch trim on the same lever
                // (palm-key notes ≥ 720 Hz (Eb6 up) drop to the lower register with more mouthpiece:
                // they keep the register-1 position)
                let reg2 = self.current.map(|i| self.notes[i].register >= 2 && self.notes[i].f_target < DYN_PP_R2_FMAX).unwrap_or(false);
                // palm-key notes: a softer pinch and relatively more air (their soft branch is
                // narrow: with the full pp pinch they fall silent or to the lower register)
                let palm = self.current.map(|i| self.notes[i].register >= 2 && self.notes[i].f_target >= DYN_PP_R2_FMAX).unwrap_or(false);
                let (lf_pp, gamma_pp) = if palm { (DYN_PP_LIP_FORCE_PALM, DYN_PP_GAMMA_PALM) } else { (DYN_PP_LIP_FORCE, DYN_PP_GAMMA) };
                // pitch trim (players "lip down" at pp by taking more mouthpiece; voicing —
                // jaw, tongue, glottis — moves the pp pitch by ≤ 3 ¢ in the model, so the lip
                // position is the lever): sharp → more mouthpiece, flat → less
                if let (Some(i), true) = (self.current, in_reg && we > 0.15) {
                    let c = 1200.0 * (freq / self.notes[i].f_target).log2();
                    let e = if c > DYN_TRIM_DEADBAND { c - DYN_TRIM_DEADBAND } else if c < -DYN_TRIM_DEADBAND { c + DYN_TRIM_DEADBAND } else { 0.0 };
                    let (lo, hi) = if reg2 { (-DYN_TRIM_MAX, DYN_TRIM_MAX) } else { (-DYN_TRIM_MAX_R1, DYN_TRIM_MAX_R1) };
                    self.dyn_trim = (self.dyn_trim + DYN_TRIM_GAIN * e * dt).clamp(lo, hi);
                }
                let lp_pp = if reg2 { DYN_PP_LIP_POS_R2 } else if palm { DYN_PP_LIP_POS_PALM } else { DYN_PP_LIP_POS };
                // (the trim acts in full from half-way to pp, so p is corrected too)
                let trim = self.dyn_trim * (2.0 * we).min(1.0);
                let lf = base.lip_force + we * (lf_pp - base.lip_force);
                let lp = base.lip_position_mm + we * (lp_pp - base.lip_position_mm) + trim;
                o.lip += lf - base.lip_force;
                o.lip_position += lp - base.lip_position_mm;
                o.lip_damping += DYN_PP_DAMP * we;
                let pm0 = closing_pressure(&base);
                // (the register lock below adds 0.5·adapt to the lip force; when it has loosened
                // the lip — a note that started on its octave — include it, or the note is blown
                // below its soft-branch threshold)
                let lock_lip = if self.current.is_some() { 0.5 * self.adapt.min(0.0) * (2.0 * a).min(1.0) } else { 0.0 };
                let lead = |x: f64| crate::reed::ReedControls {
                    lip_force: (base.lip_force + x * (lf_pp - base.lip_force) + lock_lip).clamp(0.0, 3.0),
                    lip_position_mm: base.lip_position_mm + x * (lp_pp - base.lip_position_mm) + trim,
                    ..base
                };
                let pm_w = closing_pressure(&lead(w));
                let lung = lung_pa.max(1.0);
                // γ at mf (the player's own) → γ_pp, geometrically
                let g_mf = lung / pm0;
                let g = g_mf * (gamma_pp / g_mf).min(1.0).powf(w);
                let p_w = (g * pm_w).min(lung);
                o.pressure_scale *= p_w / lung;
            } else {
                // toward ff, also entered from the mf onset (a loose lip at full
                // pressure would start low notes on their octave)
                let t = 2.0 * d;
                let w = (t * (1.0 - self.boost)).min(self.dyn_cap.unwrap_or(1.0));
                self.dyn_w = w;
                // toward ff the breath leads and the lip loosens after it
                let we = self.emb_lag(w, dt);
                o.pressure_scale *= DYN_FF_PRESSURE.powf(w);
                o.lip += DYN_FF_LIP * we;
                o.lip_damping += DYN_FF_DAMP * we;
                o.jaw += 0.2 * we;
            }
        }
        if a > 0.0 {
            if let Some(i) = self.current {
                let n = &self.notes[i];
                // feed-forward embouchure per note (what players do), collected
                // in f and applied scaled by a below
                let mut f = PlayerOffsets { pressure_scale: 1.0, ..Default::default() };
                if no_ff {
                } else if n.register == 1 && n.f_target < 180.0 && !self.dyn_retry {
                    f.pressure_scale -= 0.05;
                    f.jaw += 0.15;
                    f.tongue_y -= 0.10;
                } else if n.register >= 2 && n.f_target > 690.0 {
                    f.lip += 0.20;
                    f.pressure_scale += 0.10;
                    f.tongue_y += 0.30;
                    f.tongue_x -= 0.30;
                } else if n.register >= 2 {
                    f.lip += 0.10;
                    f.pressure_scale += 0.05;
                }
                o.lip += f.lip;
                o.pressure_scale *= f.pressure_scale;
                o.tongue_y += f.tongue_y;
                o.tongue_x += f.tongue_x;
                o.jaw += f.jaw;
                // register locking feedback
                // no feedback while the tongue stops the reed (articulation) or
                // during the 120 ms after its release (note still starting)
                // (also during the first 200 ms after the note speaks: the onset
                // transient often reads as a higher mode for a few periods)
                if freq > 0.0 && self.prev_freq <= 0.0 {
                    self.hold_t = self.hold_t.max(0.2);
                }
                if tongue > 0.2 {
                    self.hold_t = 0.12;
                    self.silent_t = 0.0;
                } else if self.hold_t > 0.0 {
                    self.hold_t -= dt;
                } else if lung_pa > 1000.0 {
                    let e = if freq > 0.0 {
                        self.silent_t = 0.0;
                        let c = 1200.0 * (freq / n.f_target).log2();
                        if c > 300.0 {
                            -1.0
                        } else if c < -300.0 {
                            1.0
                        } else {
                            0.0
                        }
                    } else {
                        self.silent_t += dt;
                        if self.silent_t > 0.15 {
                            0.5
                        } else {
                            0.0
                        }
                    };
                    self.adapt = (self.adapt + e * ADAPT_RATE * dt).clamp(-1.0, 1.0);
                }
                // feed-forward scales with a; the locking feedback is at full
                // strength from a = 0.5 up
                let fb = (2.0 * a).min(1.0);
                let x = self.adapt * fb;
                // (dynamics offsets above are already in o; they are not scaled by a)
                o.lip += f.lip * (a - 1.0) + 0.5 * x;
                // (the lock acts relative to the current pressure: at pp an additive
                // −0.2 would blow the note out)
                o.pressure_scale = o.pressure_scale * (1.0 + (f.pressure_scale - 1.0) * a) / f.pressure_scale * (1.0 + 0.2 * x);
                o.tongue_y += f.tongue_y * (a - 1.0) + 0.25 * x;
                o.tongue_x += f.tongue_x * (a - 1.0);
                o.jaw += f.jaw * (a - 1.0) - 0.15 * x;
            }
        }
        // --- altissimo voicing (register-3 alternate fingerings): ramp toward the
        // per-note absolute embouchure/tract targets like a player setting the
        // throat (~ALT_RAMP), and trim tongue_x from the pitch tracker.
        let alt_target = if a > 0.0 { self.current.and_then(|i| self.alt_override.or(self.notes[i].alt)) } else { None };
        if let Some(v) = alt_target {
            self.alt_cur = v;
        }
        let want = if alt_target.is_some() { (2.0 * a).min(1.0) } else { 0.0 };
        let stp = dt / ALT_RAMP;
        self.alt_w += (want - self.alt_w).clamp(-stp, stp);
        // voice, then attack: new altissimo selection or new attack → tongue on the
        // reed until voiced and the old oscillation has rung down; each attack
        // starts from the notated voicing (no trims carried over from the last note)
        let sel = if alt_target.is_some() { self.current } else { None };
        let attack = lung_pa > 500.0 && self.prev_lung <= 500.0;
        if sel.is_some() && (sel != self.alt_sel || attack) {
            self.alt_gate_t = ALT_SETTLE;
            if attack {
                self.tx_trim = 0.0;
                self.lip_trim = 0.0;
            }
        }
        self.alt_sel = sel;
        self.prev_lung = lung_pa;
        let gating = sel.is_some() && lung_pa > 300.0 && (self.alt_gate_t > 0.0 || self.alt_w < 0.95 * want);
        if self.alt_gate_t > 0.0 {
            self.alt_gate_t -= dt;
        }
        if let (Some(i), Some(_)) = (self.current, alt_target) {
            if freq > 0.0 && tongue < 0.2 {
                let c = 1200.0 * (freq / self.notes[i].f_target).log2();
                // fine pitch: lip force (continuous lever: more lip → sharper);
                // coarse: tongue_x (tract resonance; flat → tongue further
                // front), only for large errors because the tract-locked regime
                // is hysteretic in tongue_x; outside ±300 c seek the register.
                if c.abs() < 300.0 {
                    self.lip_trim = (self.lip_trim - ALT_LIP_GAIN * c * dt).clamp(ALT_LIP_MIN, ALT_LIP_MAX);
                    if c.abs() > ALT_COARSE_CENTS {
                        self.tx_trim = (self.tx_trim + ALT_TRIM_GAIN * c * dt).clamp(-ALT_TRIM_MAX, ALT_TRIM_MAX);
                    }
                } else {
                    let rate = if c < 0.0 { -ALT_SEEK_RATE } else { ALT_SEEK_RATE };
                    self.tx_trim = (self.tx_trim + rate * dt).clamp(-ALT_TRIM_MAX, ALT_TRIM_MAX);
                    // stuck in a lower regime (typical when slurring up from a
                    // palm note): once voiced, re-articulate with a short breath
                    // dip so the note restarts on the tract-supported regime
                    if c < 0.0 && self.alt_w >= 0.99 {
                        self.wrong_t += dt;
                        if self.wrong_t > ALT_REARTIC_AFTER {
                            self.dip_t = ALT_DIP_TIME;
                            self.wrong_t = -0.3;
                            // restart from the notated voicing
                            self.tx_trim = 0.0;
                            self.lip_trim = 0.0;
                        }
                    }
                }
            }
        } else if self.alt_w <= 0.0 {
            self.tx_trim = 0.0;
            self.lip_trim = 0.0;
        }
        if self.dip_t > 0.0 {
            self.dip_t -= dt;
            o.tongue = 1.0;
        }
        if gating {
            o.tongue = 1.0;
        }
        if alt_target.is_none() {
            self.wrong_t = 0.0;
        }
        self.prev_freq = freq;
        o.alt_w = self.alt_w;
        o.alt = self.alt_cur;
        o.tx_trim = self.tx_trim * self.alt_w;
        if !o.alt.lip_force.is_nan() {
            o.alt.lip_force += self.lip_trim;
        }
        let changed = (o.alt_w - self.out.alt_w).abs() > 1e-4
            || (o.tx_trim - self.out.tx_trim).abs() > 1e-4
            || o.tongue != self.out.tongue
            || (o.alt.lip_force - self.out.alt.lip_force).abs() > 1e-3
            || o.alt.lip_force.is_nan() != self.out.alt.lip_force.is_nan()
            || (o.lip - self.out.lip).abs() > 1e-3
            || (o.pressure_scale - self.out.pressure_scale).abs() > 1e-4
            || (o.tongue_y - self.out.tongue_y).abs() > 1e-3
            || (o.tongue_x - self.out.tongue_x).abs() > 1e-3
            || (o.jaw - self.out.jaw).abs() > 1e-3
            || (o.lip_damping - self.out.lip_damping).abs() > 1e-3
            || (o.lip_position - self.out.lip_position).abs() > 1e-2;
        if changed {
            self.out = o;
        }
        changed
    }
}

// ---- auto player (param `auto_player`, PHYSICS.md "Auto player") ----------------------------
// Keys-only mode: the player sets — not offsets — the ten player controls below from a voicing
// table keyed by the recognised fingering and `dynamic` (pp 0 · mf 0.5 · ff 1, interpolated),
// adapted to the mouthpiece/reed setup, plus feedback (register lock, pitch trim on the lip,
// altissimo "voice then attack", re-tongue rescue). Bits of `auto_player_mask` hand single
// controls back to the user. The table is `auto_player` in the geometry JSON (schema v1); while
// a note has no entry the player falls back to its built-in voicing: the player-assist model
// (feed-forward + dynamics + register lock at assist 0.5) around the default controls, blowing
// AUTO_MF_PRESSURE scaled with the setup's closing pressure.

/// number of player controls and their order (also the `auto_player_mask` bits and telemetry)
pub const N_CTL: usize = 10;
pub mod ctl {
    pub const LIP_FORCE: usize = 0;
    pub const LIP_POSITION: usize = 1;
    pub const LIP_DAMPING: usize = 2;
    pub const TONGUE_X: usize = 3;
    pub const TONGUE_Y: usize = 4;
    pub const TONGUE_TIP: usize = 5;
    pub const TONGUE_LENGTH: usize = 6;
    pub const JAW_OPEN: usize = 7;
    pub const GLOTTIS_OPEN: usize = 8;
    /// lung pressure (Pa internally; kPa in params and telemetry)
    pub const LUNG_PRESSURE: usize = 9;
    pub const NAMES: [&str; super::N_CTL] =
        ["lip_force", "lip_position", "lip_damping", "tongue_x", "tongue_y", "tongue_tip", "tongue_length", "jaw_open", "glottis_open", "lung_pressure"];
}
/// setup params the voicing adapts to (order of `auto_player.setup_reference`)
pub const N_SETUP: usize = 9;
pub const SETUP_NAMES: [&str; N_SETUP] =
    ["tip_opening", "facing_length", "baffle_height", "chamber_size", "throat_diameter", "mouthpiece_insertion", "reed_strength", "reed_model", "temperature"];
pub const SETUP_DEFAULT: [f64; N_SETUP] = [1.9, 22.0, 0.3, 0.5, 11.0, 10.0, 2.5, 0.0, 22.0];
/// built-in mf voicing (the default player controls) and blowing pressure at the reference setup
pub const AUTO_DEFAULT: [f64; N_CTL] = [1.0, 12.0, 0.4, 0.5, 0.4, 0.3, 0.0, 0.3, 0.8, 3500.0];
pub const AUTO_MF_PRESSURE: f64 = 3500.0;
/// control ranges (as the params)
pub const CTL_MIN: [f64; N_CTL] = [0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
pub const CTL_MAX: [f64; N_CTL] = [3.0, 22.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 10000.0];
/// note-change ramp of the embouchure/tract controls (s): a player's transition
pub const AUTO_RAMP_TAU: f64 = 0.08;
/// pitch trim on the lip force: gain (N/(cent·s)), dead band (cents), limits (N), and the
/// default sensitivity used without a table (cents per N, measured on the model)
pub const AUTO_TRIM_GAIN: f64 = 0.02;
pub const AUTO_TRIM_DEADBAND: f64 = 6.0;
pub const AUTO_TRIM_MAX: f64 = 0.6;
/// the lip may relax by at most this much for pitch (a looser lip loses the register)
pub const AUTO_TRIM_MIN: f64 = -0.35;
/// built-in voicing: lip force per mm of tip opening beyond 1.9 mm, per group (low, mid, palm, alt)
pub const AUTO_LIP_PER_TIP: [f64; 4] = [0.4, 0.7, 1.0, 1.0];
/// register rescue (auto mode): a note sounding below its register gets a firmer lip (up to
/// AUTO_RESCUE_LIP N, at AUTO_RESCUE_RATE N/s), one above it a looser lip and less air; after
/// AUTO_RESCUE_AFTER (s) a re-tongue (ALT_DIP_TIME) restarts it on the intended regime
pub const AUTO_RESCUE_AFTER: f64 = 0.15;
pub const AUTO_RESCUE_LIP: f64 = 0.8;
pub const AUTO_RESCUE_RATE: f64 = 1.5;
/// overblown notes: the lip relaxes by up to this much (N), the air by 30 %/N of it
pub const AUTO_RESCUE_LIP_DOWN: f64 = 0.5;
/// unrecognised key sets: nearest fingering by pad states if within this many pads (Σ|Δ|)
pub const AUTO_NEAREST_MAX: f64 = 4.0;
/// state flag (telemetry): 0 idle/off, 1 settling, 2 locked, 3 struggling
pub const STATE_IDLE: f32 = 0.0;
pub const STATE_SETTLING: f32 = 1.0;
pub const STATE_LOCKED: f32 = 2.0;
pub const STATE_STRUGGLING: f32 = 3.0;

#[derive(Clone, Debug, Default)]
struct AutoEntry {
    /// voicing at pp, mf, ff (10 controls, lung pressure in Pa)
    v: [[f64; N_CTL]; 3],
    /// optional 11th control: reed damping at pp, mf, ff (NaN = the user's)
    rd: [f64; 3],
    /// note group (0 low, 1 mid, 2 palm, 3 altissimo), from the entry or derived
    group: usize,
}

#[derive(Clone, Debug, Default)]
pub struct AutoTable {
    entries: Vec<AutoEntry>,
    setup_ref: [f64; N_SETUP],
    /// pitch sensitivity of the lip force per group (low, mid, palm, altissimo), cents per N
    lip_trim: [f64; 4],
    /// linear setup corrections: (setup index, control, group 0–3 or −1 all, slope)
    per_param: Vec<(usize, usize, i32, f64)>,
    validity: [(f64, f64); N_SETUP],
}

/// Run-time state and outputs of the auto player.
#[derive(Clone, Copy, Debug, Default)]
pub struct AutoState {
    /// effective controls in use (lung pressure in Pa), valid when `on`
    pub ctl: [f64; N_CTL],
    /// player's tongue on the reed (gating / re-articulation), 0…1
    pub tongue: f64,
    /// reed damping of the voicing (NaN = the user's)
    pub reed_damping: f64,
    /// auto mode active (set by `tick_auto`, cleared by `auto_off`)
    pub on: bool,
    /// note whose voicing is used (exact or nearest), how it matched (0 exact, 1 nearest,
    /// 2 default voicing), status flag
    pub voice: Option<usize>,
    pub matched: u8,
    pub state: f32,
    ramp: [f64; N_CTL],
    ramp_init: bool,
    trim: f64,
    good_t: f64,
    bad_t: f64,
    since: f64,
    last_voice: Option<usize>,
    out_of_range: bool,
    rescue: f64,
    low_t: f64,
    dip_t: f64,
    /// table-voicing dynamics onset: 1 = at mf … 0 = at the requested dynamic; 1 − excursion cap
    boost: f64,
    cap_lost: f64,
    fail_t: f64,
    prev_gate: bool,
}

impl AutoState {
    /// fraction of the requested dynamic excursion currently applied
    fn dyn_reach(&self) -> f64 {
        ((1.0 - self.boost) * (1.0 - self.boost) * (3.0 - 2.0 * (1.0 - self.boost))).min(1.0 - self.cap_lost)
    }
}

/// Pad openness of a key mask.
fn pads_of(kw: &crate::keywork::Keywork, mask: u64) -> Vec<f32> {
    let keys: Vec<f32> = (0..kw.key_ids.len()).map(|i| if i < 64 && mask & (1 << i) != 0 { 1.0 } else { 0.0 }).collect();
    let mut out = vec![0.0; kw.hole_ids.len()];
    kw.evaluate(&keys, &mut out);
    out
}

/// Note group of the table's per-group data: 0 low (register 1), 1 mid (register 2 up to
/// C#6), 2 palm (D6–F#6), 3 altissimo (register 3).
fn group_of(register: i32, f: f64) -> usize {
    match register {
        r if r >= 3 => 3,
        2 if f > 690.0 => 2,
        2 => 1,
        _ => 0,
    }
}

impl Player {
    fn load_auto_table(&mut self, v: &serde_json::Value, kw: &crate::keywork::Keywork) {
        let Some(a) = v.get("auto_player") else { return };
        let Some(entries) = a.get("entries").and_then(|e| e.as_array()) else { return };
        let mut t = AutoTable { setup_ref: SETUP_DEFAULT, lip_trim: [f64::NAN; 4], validity: [(f64::NEG_INFINITY, f64::INFINITY); N_SETUP], ..Default::default() };
        if let Some(r) = a.get("setup_reference") {
            for (k, n) in SETUP_NAMES.iter().enumerate() {
                if let Some(x) = r.get(*n).and_then(|x| x.as_f64()) {
                    t.setup_ref[k] = x;
                }
            }
        }
        if let Some(ad) = a.get("adaptation") {
            if let Some(lt) = ad.get("lip_trim_cents_per_N") {
                for (k, n) in ["low", "mid", "palm", "altissimo"].iter().enumerate() {
                    if let Some(x) = lt.get(*n).and_then(|x| x.as_f64()) {
                        t.lip_trim[k] = x;
                    }
                }
            }
            if let Some(pp) = ad.get("per_param").and_then(|x| x.as_object()) {
                for (sp, ctls) in pp {
                    let Some(si) = SETUP_NAMES.iter().position(|n| n == sp) else { continue };
                    for (cn, groups) in ctls.as_object().into_iter().flatten() {
                        let Some(ci) = ctl::NAMES.iter().position(|n| n == cn) else { continue };
                        match groups {
                            serde_json::Value::Number(x) => t.per_param.push((si, ci, -1, x.as_f64().unwrap_or(0.0))),
                            serde_json::Value::Object(m) => {
                                for (g, x) in m {
                                    let gi = ["low", "mid", "palm", "altissimo"].iter().position(|n| n == g).map(|i| i as i32).unwrap_or(-1);
                                    if let Some(x) = x.as_f64() {
                                        t.per_param.push((si, ci, gi, x));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            if let Some(va) = ad.get("validity").and_then(|x| x.as_object()) {
                for (sp, r) in va {
                    let Some(si) = SETUP_NAMES.iter().position(|n| n == sp) else { continue };
                    if let (Some(lo), Some(hi)) = (r.get(0).and_then(|x| x.as_f64()), r.get(1).and_then(|x| x.as_f64())) {
                        t.validity[si] = (lo, hi);
                    }
                }
            }
        }
        for e in entries {
            let Some(f) = e.get("f_target").and_then(|x| x.as_f64()) else { continue };
            let mut mask = 0u64;
            let mut ok = true;
            for k in e.get("keys").and_then(|k| k.as_array()).into_iter().flatten() {
                match k.as_str().and_then(|n| kw.key_index(n)) {
                    Some(i) if i < 64 => mask |= 1 << i,
                    _ => ok = false,
                }
            }
            let Some(vo) = e.get("voicing") else { continue };
            let mut ent = AutoEntry { rd: [f64::NAN; 3], ..Default::default() };
            let reg = e.get("register").and_then(|x| x.as_i64()).map(|r| r as i32);
            ent.group = match e.get("group").and_then(|g| g.as_str()) {
                Some("low") => 0,
                Some("mid") => 1,
                Some("palm") => 2,
                Some("altissimo") => 3,
                _ => group_of(reg.unwrap_or(if f > 340.0 { 2 } else { 1 }), f),
            };
            for (di, dn) in ["pp", "mf", "ff"].iter().enumerate() {
                ent.rd[di] = vo.get(*dn).and_then(|d| d.get("reed_damping")).and_then(|x| x.as_f64()).unwrap_or(f64::NAN);
                for c in 0..N_CTL {
                    let x = vo.get(*dn).and_then(|d| d.get(ctl::NAMES[c])).and_then(|x| x.as_f64());
                    // missing values: the default control (tongue_length 0 unless noted)
                    ent.v[di][c] = match x {
                        Some(x) if c == ctl::LUNG_PRESSURE => x * 1000.0,
                        Some(x) => x,
                        None => f64::NAN,
                    };
                }
            }
            // entries the table itself marks as failing at every dynamic (`achieved.*.ok` all
            // false) are skipped: the note then uses the built-in voicing
            let failing = ["pp", "mf", "ff"].iter().all(|d| e.get("achieved").and_then(|a| a.get(*d)).and_then(|x| x.get("ok")).and_then(|x| x.as_bool()) == Some(false));
            if !ok || failing || ent.v[1].iter().all(|x| x.is_nan()) {
                continue;
            }
            for di in [0, 2] {
                for c in 0..N_CTL {
                    if ent.v[di][c].is_nan() {
                        ent.v[di][c] = ent.v[1][c];
                    }
                }
            }
            for di in 0..3 {
                for c in 0..N_CTL {
                    if ent.v[di][c].is_nan() {
                        ent.v[di][c] = if c == ctl::LUNG_PRESSURE { AUTO_MF_PRESSURE } else { AUTO_DEFAULT[c] };
                    }
                }
            }
            for di in [0, 2] {
                if ent.rd[di].is_nan() {
                    ent.rd[di] = ent.rd[1];
                }
            }
            let ei = t.entries.len();
            t.entries.push(ent);
            match self.notes.iter().position(|n| n.mask == mask) {
                Some(ni) => self.notes[ni].auto = Some(ei),
                None => self.notes.push(NoteInfo { mask, f_target: f, register: reg.unwrap_or(if f > 340.0 { 2 } else { 1 }), alt: None, pads: pads_of(kw, mask), auto: Some(ei) }),
            }
        }
        if !t.entries.is_empty() {
            self.table = Some(t);
        }
    }

    /// True when a voicing table (`auto_player` in the geometry) is loaded.
    pub fn has_auto_table(&self) -> bool {
        self.table.is_some()
    }

    /// Voicing source for the current keys: exact fingering, else the nearest by pad state.
    fn match_voice(&mut self) {
        if let Some(i) = self.current {
            self.auto.voice = Some(i);
            self.auto.matched = 0;
            return;
        }
        let Some(kw) = self.kw.as_ref() else {
            self.auto.voice = None;
            self.auto.matched = 2;
            return;
        };
        kw.evaluate(&self.keys_now, &mut self.pads_buf);
        let mut best = (f64::MAX, None);
        for (i, n) in self.notes.iter().enumerate() {
            if n.pads.len() != self.pads_buf.len() {
                continue;
            }
            let d: f64 = n.pads.iter().zip(self.pads_buf.iter()).map(|(a, b)| (a - b).abs() as f64).sum();
            if d < best.0 {
                best = (d, Some(i));
            }
        }
        if best.0 <= AUTO_NEAREST_MAX {
            self.auto.voice = best.1;
            self.auto.matched = 1;
        } else {
            self.auto.voice = None;
            self.auto.matched = 2;
        }
    }

    /// Auto-player control-rate update.
    /// `user` = the user's own control values (lung pressure in Pa: the breath gate — the player
    /// blows while it is > 0, at its own pressure unless the user owns `lung_pressure`),
    /// `mask` = controls the user owns, `setup` = SETUP_NAMES values, `base_reed` = user reed
    /// controls (setup part used), `tongue` = user's tongue on the reed. Returns true when the
    /// effective controls changed.
    #[allow(clippy::too_many_arguments)]
    pub fn tick_auto(&mut self, dynamic: f64, freq: f64, user: &[f64; N_CTL], mask: u32, setup: &[f64; N_SETUP], base_reed: &crate::reed::ReedControls, tongue: f64, dt: f64) -> bool {
        let gate = user[ctl::LUNG_PRESSURE] > 0.0;
        let owns = |c: usize| mask & (1 << c) != 0;
        let voice = self.auto.voice;
        let entry = match (&self.table, voice) {
            (Some(t), Some(v)) => self.notes[v].auto.map(|e| &t.entries[e]),
            _ => None,
        };
        // closing pressure of the reference embouchure on this setup vs the reference setup
        let ref_emb = |tip: f64, facing: f64, strength: f64| crate::reed::ReedControls {
            lip_force: AUTO_DEFAULT[ctl::LIP_FORCE],
            lip_position_mm: AUTO_DEFAULT[ctl::LIP_POSITION],
            lip_damping: AUTO_DEFAULT[ctl::LIP_DAMPING],
            tip_opening_mm: tip,
            facing_length_mm: facing,
            reed_strength: strength,
            tongue_contact: 0.0,
            ..*base_reed
        };
        let sref = self.table.as_ref().map(|t| t.setup_ref).unwrap_or(SETUP_DEFAULT);
        let pm_ratio = closing_pressure(&ref_emb(setup[0], setup[1], setup[6])) / closing_pressure(&ref_emb(sref[0], sref[1], sref[6])).max(1.0);
        let (reg, f_t) = voice.map(|v| (self.notes[v].register, self.notes[v].f_target)).unwrap_or((1, 0.0));
        let grp = match (&self.table, voice) {
            (Some(t), Some(v)) => self.notes[v].auto.map(|e| t.entries[e].group).unwrap_or_else(|| group_of(reg, f_t)),
            _ => group_of(reg, f_t),
        };
        // --- target voicing
        let d_user = dynamic.clamp(0.0, 1.0);
        // table voicings: every attack starts on the mf voicing — where the intended register is
        // the stable one — and eases to the requested dynamic once the note sounds in register
        // (like the assist model's pp/ff onset); a note that dies or cracks on the way makes the
        // player restart from mf and cap the excursion for this note (×DYN_BACKOFF)
        let d = if entry.is_some() { 0.5 + (d_user - 0.5) * self.auto.dyn_reach() } else { d_user };
        let mut tgt = [0.0; N_CTL];
        let mut out_of_range = false;
        let tongue_out;
        if let Some(e) = entry {
            let t = self.table.as_ref().unwrap();
            let lerp = |x: [f64; 3]| if d <= 0.5 { x[0] + (x[1] - x[0]) * d / 0.5 } else { x[1] + (x[2] - x[1]) * (d - 0.5) / 0.5 };
            for c in 0..N_CTL {
                tgt[c] = lerp([e.v[0][c], e.v[1][c], e.v[2][c]]);
            }
            self.auto.reed_damping = lerp(e.rd);
            // p_M ratio at the voicing's own lip controls (pp's heavy lip saturates the reed's
            // static deflection, so p_M scales differently with tip/strength than at mf)
            let emb = |tip: f64, facing: f64, strength: f64| crate::reed::ReedControls {
                lip_force: tgt[ctl::LIP_FORCE],
                lip_position_mm: tgt[ctl::LIP_POSITION],
                lip_damping: tgt[ctl::LIP_DAMPING],
                ..ref_emb(tip, facing, strength)
            };
            let r = closing_pressure(&emb(setup[0], setup[1], setup[6])) / closing_pressure(&emb(sref[0], sref[1], sref[6])).max(1.0);
            tgt[ctl::LUNG_PRESSURE] *= if r.is_finite() && r > 0.0 { r } else { pm_ratio };
            for &(si, ci, g, slope) in &t.per_param {
                if g >= 0 && g as usize != grp {
                    continue;
                }
                let (lo, hi) = t.validity[si];
                let x = setup[si].clamp(lo, hi);
                tgt[ci] += slope * (x - t.setup_ref[si]);
            }
            for si in 0..N_SETUP {
                let (lo, hi) = t.validity[si];
                if setup[si] < lo || setup[si] > hi {
                    out_of_range = true;
                }
            }
            // feedback: register lock + altissimo gating/trims of the assist model around the
            // table voicing (no feed-forward, no dynamics: both are in the table)
            let alt = if reg >= 3 {
                Some(AltVoicing { lip_force: tgt[0], lip_position: tgt[1], lip_damping: tgt[2], tongue_x: tgt[3], tongue_y: tgt[4], tongue_tip: tgt[5], jaw_open: tgt[7], glottis_open: tgt[8], ..Default::default() })
            } else {
                None
            };
            self.base = crate::reed::ReedControls { lip_force: tgt[0], lip_position_mm: tgt[1], lip_damping: tgt[2], ..*base_reed };
            self.alt_override = alt;
            self.tick_inner(0.5, 0.5, freq, if gate { tgt[ctl::LUNG_PRESSURE] } else { 0.0 }, tongue, dt, true);
            self.alt_override = None;
            let o = self.out;
            let w = o.alt_w;
            tgt[0] = blend(tgt[0] + o.lip, o.alt.lip_force, w);
            tgt[1] = blend(tgt[1] + o.lip_position, o.alt.lip_position, w);
            tgt[2] = blend(tgt[2] + o.lip_damping, o.alt.lip_damping, w);
            tgt[3] = blend(tgt[3] + o.tongue_x, o.alt.tongue_x, w) + o.tx_trim;
            tgt[4] = blend(tgt[4] + o.tongue_y, o.alt.tongue_y, w);
            tgt[5] = blend(tgt[5], o.alt.tongue_tip, w);
            tgt[7] = blend(tgt[7] + o.jaw, o.alt.jaw_open, w);
            tgt[8] = blend(tgt[8], o.alt.glottis_open, w);
            tgt[ctl::LUNG_PRESSURE] *= o.pressure_scale;
            tongue_out = o.tongue;
        } else {
            // built-in voicing: the assist model (assist 0.5) around the default controls
            self.auto.reed_damping = f64::NAN;
            let mut b = AUTO_DEFAULT;
            // a wider tip opening needs a firmer lip to keep the reed's working opening (and the
            // upper register); measured on the palm notes: +1 N per mm
            b[ctl::LIP_FORCE] += AUTO_LIP_PER_TIP[grp] * (setup[0] - SETUP_DEFAULT[0]);
            b[ctl::LUNG_PRESSURE] = AUTO_MF_PRESSURE * pm_ratio;
            self.base = crate::reed::ReedControls { lip_force: b[0], lip_position_mm: b[1], lip_damping: b[2], ..*base_reed };
            // (no fingering → no register target: keep the voicing of the nearest note)
            let cur = self.current;
            if cur.is_none() {
                self.current = voice;
            }
            self.tick_inner(0.5, d, freq, if gate { b[ctl::LUNG_PRESSURE] } else { 0.0 }, tongue, dt, false);
            self.current = cur;
            let o = self.out;
            let w = o.alt_w;
            tgt[0] = blend(b[0] + o.lip, o.alt.lip_force, w);
            tgt[1] = blend(b[1] + o.lip_position, o.alt.lip_position, w);
            tgt[2] = blend(b[2] + o.lip_damping, o.alt.lip_damping, w);
            tgt[3] = blend(b[3] + o.tongue_x, o.alt.tongue_x, w) + o.tx_trim;
            tgt[4] = blend(b[4] + o.tongue_y, o.alt.tongue_y, w);
            tgt[5] = blend(b[5], o.alt.tongue_tip, w);
            tgt[6] = b[6];
            tgt[7] = blend(b[7] + o.jaw, o.alt.jaw_open, w);
            tgt[8] = blend(b[8], o.alt.glottis_open, w);
            tgt[ctl::LUNG_PRESSURE] = b[ctl::LUNG_PRESSURE] * o.pressure_scale;
            tongue_out = o.tongue;
        }
        // --- pitch trim on the lip force (registers 1–2; altissimo has its own trim)
        let in_reg = match (self.current, freq > 0.0) {
            (Some(i), true) => (1200.0 * (freq / self.notes[i].f_target).log2()).abs() < 100.0,
            _ => false,
        };
        let cents = match (self.current, freq > 0.0) {
            (Some(i), true) => 1200.0 * (freq / self.notes[i].f_target).log2(),
            _ => 0.0,
        };
        if gate && in_reg && reg < 3 && tongue < 0.2 && self.auto.since > 0.25 && !owns(ctl::LIP_FORCE) {
            let e = if cents > AUTO_TRIM_DEADBAND { cents - AUTO_TRIM_DEADBAND } else if cents < -AUTO_TRIM_DEADBAND { cents + AUTO_TRIM_DEADBAND } else { 0.0 };
            // normalise the gain by the group's sensitivity (table) — default 40 ¢/N
            let sens = self.table.as_ref().map(|t| t.lip_trim[grp]).filter(|x| x.is_finite() && x.abs() > 1.0).unwrap_or(40.0);
            self.auto.trim = (self.auto.trim - AUTO_TRIM_GAIN * 40.0 / sens * e * dt).clamp(AUTO_TRIM_MIN, AUTO_TRIM_MAX);
        }
        if voice != self.auto.last_voice {
            self.auto.trim = 0.0;
            self.auto.rescue = 0.0;
            self.auto.low_t = 0.0;
            // (a slur keeps half of the excursion: the next note re-centres partly toward mf)
            self.auto.boost = self.auto.boost.max(0.5);
            self.auto.cap_lost = 0.0;
            self.auto.since = 0.0;
            self.auto.good_t = 0.0;
            self.auto.bad_t = 0.0;
            self.auto.last_voice = voice;
        }
        // register rescue: stuck below the register (cracked down / octave low) → firmer lip;
        // above it (overblown) → looser lip and less air; plus a re-tongue to restart
        let off = match (self.current, freq > 0.0) {
            (Some(i), true) => 1200.0 * (freq / self.notes[i].f_target).log2(),
            _ => 0.0,
        };
        let wrong = if off < -300.0 { 1.0 } else if off > 300.0 { -1.0 } else { 0.0 };
        let mut rescue_tongue = 0.0;
        if gate && wrong != 0.0 && tongue < 0.2 && self.auto.since > 0.2 && reg < 3 {
            self.auto.low_t += dt;
            let (lo, hi) = (-AUTO_RESCUE_LIP_DOWN, AUTO_RESCUE_LIP);
            self.auto.rescue = (self.auto.rescue + wrong * AUTO_RESCUE_RATE * dt).clamp(lo, hi);
            if self.auto.low_t > AUTO_RESCUE_AFTER {
                self.auto.dip_t = ALT_DIP_TIME;
                self.auto.low_t = -0.2;
            }
        } else if !gate {
            self.auto.rescue = 0.0;
            self.auto.low_t = 0.0;
        }
        if self.auto.dip_t > 0.0 {
            self.auto.dip_t -= dt;
            rescue_tongue = 1.0;
        }
        if self.auto.rescue < 0.0 {
            tgt[ctl::LUNG_PRESSURE] *= 1.0 + 0.3 * self.auto.rescue;
        }
        tgt[ctl::LIP_FORCE] += self.auto.trim + self.auto.rescue;
        // --- user-owned controls, ranges, note-change ramps
        for c in 0..N_CTL {
            if owns(c) {
                tgt[c] = user[c];
            }
            tgt[c] = tgt[c].clamp(CTL_MIN[c], CTL_MAX[c]);
        }
        if !gate && !owns(ctl::LUNG_PRESSURE) {
            tgt[ctl::LUNG_PRESSURE] = 0.0;
        }
        if !self.auto.ramp_init {
            self.auto.ramp = tgt;
            self.auto.ramp_init = true;
        }
        let k = (dt / AUTO_RAMP_TAU).min(1.0);
        let mut ctl_out = [0.0; N_CTL];
        for c in 0..N_CTL {
            // pressure: the lungs have their own dynamics; user-owned controls follow the user
            if c == ctl::LUNG_PRESSURE || owns(c) {
                self.auto.ramp[c] = tgt[c];
            } else {
                self.auto.ramp[c] += k * (tgt[c] - self.auto.ramp[c]);
            }
            ctl_out[c] = self.auto.ramp[c];
        }
        // --- dynamics onset (table voicings)
        if gate && !self.auto.prev_gate {
            self.auto.boost = 1.0;
        }
        self.auto.prev_gate = gate;
        let sounding_ok = if self.current.is_some() { in_reg } else { freq > 0.0 };
        if gate && tongue < 0.2 && tongue_out < 0.5 {
            if sounding_ok && self.auto.since > 0.1 {
                self.auto.boost *= 1.0 - (dt / DYN_RELAX_TAU).min(1.0);
                self.auto.fail_t = 0.0;
            } else if self.auto.dyn_reach() > 0.15 && (d_user - 0.5).abs() > 0.05 {
                self.auto.fail_t += dt;
                if self.auto.fail_t > 0.05 {
                    self.auto.cap_lost = 1.0 - (self.auto.dyn_reach() * DYN_BACKOFF).min(1.0 - self.auto.cap_lost);
                    self.auto.boost = 1.0;
                    self.auto.fail_t = 0.0;
                }
            }
        }
        // --- status
        self.auto.since += dt;
        if gate && tongue < 0.2 && tongue_out < 0.5 {
            // (no recognised fingering: no pitch target — sounding is all we can check)
            let ok = if self.current.is_some() { in_reg && cents.abs() < 30.0 } else { freq > 0.0 };
            if ok {
                self.auto.good_t += dt;
                self.auto.bad_t = 0.0;
            } else {
                self.auto.bad_t += dt;
                self.auto.good_t = 0.0;
            }
        }
        self.auto.out_of_range = out_of_range;
        self.auto.state = if !gate {
            STATE_IDLE
        } else if self.auto.bad_t > 0.6 || (out_of_range && self.auto.bad_t > 0.3) {
            STATE_STRUGGLING
        } else if self.auto.good_t > 0.1 {
            STATE_LOCKED
        } else {
            STATE_SETTLING
        };
        let tongue_out = tongue_out.max(rescue_tongue);
        let changed = !self.auto.on || tongue_out != self.auto.tongue || (0..N_CTL).any(|c| (ctl_out[c] - self.auto.ctl[c]).abs() > if c == ctl::LUNG_PRESSURE { 1.0 } else { 1e-4 });
        self.auto.ctl = ctl_out;
        self.auto.tongue = tongue_out;
        self.auto.on = true;
        changed
    }

    /// Leave auto mode (next activation starts its ramps from the targets).
    pub fn auto_off(&mut self) {
        if self.auto.on {
            self.auto.on = false;
            self.auto.ramp_init = false;
            self.auto.state = STATE_IDLE;
            self.out = PlayerOffsets { pressure_scale: 1.0, ..Default::default() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_assist_is_pure_physics() {
        let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 140.0, register: 1, alt: None, ..Default::default() }], ..Default::default() };
        p.on_keys(&[1.0]);
        assert_eq!(p.current, Some(0));
        for _ in 0..10000 {
            p.tick(0.0, 0.0, 280.0, 4000.0, 0.0, 1e-3);
        }
        assert!(p.out.is_neutral(), "{:?}", p.out);
    }

    #[test]
    fn overblown_note_is_pulled_down() {
        let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 140.0, register: 1, alt: None, ..Default::default() }], ..Default::default() };
        p.on_keys(&[1.0]);
        for _ in 0..2000 {
            p.tick(1.0, 0.5, 280.0, 4000.0, 0.0, 1e-3); // sounding the octave
        }
        assert!(p.out.lip < 0.0 && p.out.pressure_scale < 1.0, "{:?}", p.out);
    }

    #[test]
    fn dynamic_mapping() {
        let mk = || {
            let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 440.0, register: 2, alt: None, ..Default::default() }], ..Default::default() };
            p.on_keys(&[1.0]);
            p
        };
        // mf = no offsets (in register, sounding)
        let mut p = mk();
        for _ in 0..3000 {
            p.tick(0.5, 0.5, 440.0, 3500.0, 0.0, 1e-3);
        }
        let mf = p.out;
        // pp: once sounding, pressure relaxes below mf, lip firmer & more damped
        let mut p = mk();
        for _ in 0..3000 {
            p.tick(0.5, 0.0, 440.0, 3500.0, 0.0, 1e-3);
        }
        assert!(p.out.pressure_scale < 0.6 * mf.pressure_scale && p.out.lip > mf.lip && p.out.lip_damping > 0.0, "{:?}", p.out);
        // ff: more pressure, looser lip
        let mut p = mk();
        for _ in 0..3000 {
            p.tick(0.5, 1.0, 440.0, 3500.0, 0.0, 1e-3);
        }
        assert!(p.out.pressure_scale > 1.5 * mf.pressure_scale && p.out.lip < mf.lip, "{:?}", p.out);
        // assist 0: dynamic ignored
        let mut p = mk();
        p.tick(0.0, 0.0, 440.0, 3500.0, 0.0, 1e-3);
        assert!(p.out.is_neutral(), "{:?}", p.out);
    }

    #[test]
    fn pp_embouchure_trajectory_and_backoff() {
        let mk = || {
            let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 440.0, register: 2, alt: None, ..Default::default() }], ..Default::default() };
            p.on_keys(&[1.0]);
            p
        };
        // pp: closed-down embouchure (more lip force, more mouthpiece) and a blowing
        // pressure of γ_pp·p_M of that embouchure
        let mut p = mk();
        for _ in 0..3000 {
            p.tick(0.5, 0.0, 440.0, 3500.0, 0.0, 1e-3);
        }
        let pp = PlayerOffsets { ..p.out };
        assert!(pp.lip > 1.5 && pp.lip_position > 3.0, "{pp:?}");
        // (register-2 note below DYN_PP_R2_FMAX: the upper-register pp lip position)
        let pm_pp = closing_pressure(&crate::reed::ReedControls { lip_force: DYN_PP_LIP_FORCE, lip_position_mm: DYN_PP_LIP_POS_R2, ..Default::default() });
        let p_blow = 3500.0 * pp.pressure_scale;
        assert!((p_blow / pm_pp - DYN_PP_GAMMA).abs() < 0.03, "γ = {}", p_blow / pm_pp);
        // the note dies on the way down: back off to mf and stay above that point
        let mut p = mk();
        for _ in 0..400 {
            p.tick(0.5, 0.0, 440.0, 3500.0, 0.0, 1e-3);
        }
        let w_fail = p.dyn_w;
        for _ in 0..200 {
            p.tick(0.5, 0.0, 0.0, 3500.0, 0.0, 1e-3);
        }
        for _ in 0..3000 {
            p.tick(0.5, 0.0, 440.0, 3500.0, 0.0, 1e-3);
        }
        assert!(w_fail > 0.3 && p.dyn_w <= DYN_BACKOFF * w_fail + 1e-9, "{w_fail} → {}", p.dyn_w);
        assert!(p.out.pressure_scale > pp.pressure_scale, "{:?}", p.out);
    }

    #[test]
    fn pp_pitch_trim_takes_more_mouthpiece_when_sharp() {
        let mk = |f: f64, reg: i32| {
            let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: f, register: reg, alt: None, ..Default::default() }], ..Default::default() };
            p.on_keys(&[1.0]);
            p
        };
        // register 2, 40 ¢ sharp at pp: the lip position goes beyond the pp target
        let mut p = mk(523.0, 2);
        let sharp = 523.0 * 2f64.powf(40.0 / 1200.0);
        for _ in 0..3000 {
            p.tick(0.5, 0.0, sharp, 3500.0, 0.0, 1e-3);
        }
        let target = DYN_PP_LIP_POS_R2 - p.base.lip_position_mm;
        assert!(p.out.lip_position > target + 1.0, "{:?}", p.out);
        // in tune: no trim
        let mut q = mk(523.0, 2);
        for _ in 0..3000 {
            q.tick(0.5, 0.0, 523.0, 3500.0, 0.0, 1e-3);
        }
        assert!((q.out.lip_position - target).abs() < 0.05, "{:?}", q.out);
        // register 1 (and palm notes): never trimmed (more mouthpiece cracks them)
        let mut r = mk(233.0, 1);
        for _ in 0..3000 {
            r.tick(0.5, 0.0, 233.0 * 2f64.powf(40.0 / 1200.0), 3500.0, 0.0, 1e-3);
        }
        assert!((r.out.lip_position - (DYN_PP_LIP_POS - r.base.lip_position_mm)).abs() < 0.05, "{:?}", r.out);
    }

    #[test]
    fn altissimo_voicing_ramps_and_releases() {
        let v = AltVoicing { lip_force: 1.8, tongue_x: 0.06, tongue_y: 0.96, ..Default::default() };
        let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 932.0, register: 3, alt: Some(v), ..Default::default() }], ..Default::default() };
        p.on_keys(&[1.0]);
        p.tick(0.5, 0.5, 0.0, 4500.0, 0.0, 0.03);
        assert!(p.out.alt_w > 0.0 && p.out.alt_w < 0.5, "ramp starts gradually: {}", p.out.alt_w);
        for _ in 0..20 {
            p.tick(0.5, 0.5, 932.0, 4500.0, 0.0, 0.01);
        }
        assert!((p.out.alt_w - 1.0).abs() < 1e-9 && p.out.alt.tongue_y == 0.96);
        assert_eq!(blend(0.4, p.out.alt.tongue_y, p.out.alt_w), 0.96);
        // releasing the fingering ramps the voicing out
        p.on_keys(&[0.0]);
        for _ in 0..20 {
            p.tick(0.5, 0.5, 0.0, 4500.0, 0.0, 0.01);
        }
        assert_eq!(p.out.alt_w, 0.0);
        // assist 0: never voiced
        let mut q = Player { notes: vec![NoteInfo { mask: 1, f_target: 932.0, register: 3, alt: Some(v), ..Default::default() }], ..Default::default() };
        q.on_keys(&[1.0]);
        q.tick(0.0, 0.5, 0.0, 4500.0, 0.0, 1.0);
        assert_eq!(q.out.alt_w, 0.0);
    }

    #[test]
    fn auto_player_sets_controls_and_honours_mask() {
        let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 233.0, register: 1, alt: None, ..Default::default() }], ..Default::default() };
        p.on_keys(&[1.0]);
        let reed = crate::reed::ReedControls::default();
        let user = [2.7, 20.0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.05, 4000.0];
        // no mask: the player's own voicing, whatever the user's values
        for _ in 0..200 {
            p.tick_auto(0.5, 233.0, &user, 0, &SETUP_DEFAULT, &reed, 0.0, 1e-3);
        }
        assert!(p.auto.on);
        let c = p.auto.ctl;
        assert!((c[ctl::LIP_FORCE] - 1.0).abs() < 0.2 && (c[ctl::GLOTTIS_OPEN] - 0.8).abs() < 1e-9, "{c:?}");
        assert!((c[ctl::LUNG_PRESSURE] - AUTO_MF_PRESSURE).abs() < 0.1 * AUTO_MF_PRESSURE, "{c:?}");
        // mask: lip_force and lung_pressure owned → exactly the user's
        let m = (1 << ctl::LIP_FORCE) | (1 << ctl::LUNG_PRESSURE);
        p.tick_auto(0.5, 233.0, &user, m, &SETUP_DEFAULT, &reed, 0.0, 1e-3);
        assert_eq!(p.auto.ctl[ctl::LIP_FORCE], 2.7);
        assert_eq!(p.auto.ctl[ctl::LUNG_PRESSURE], 4000.0);
        assert!((p.auto.ctl[ctl::JAW_OPEN] - 0.9).abs() > 0.3);
        // breath gate off: no air (unless owned)
        let mut u2 = user;
        u2[ctl::LUNG_PRESSURE] = 0.0;
        p.tick_auto(0.5, 0.0, &u2, 0, &SETUP_DEFAULT, &reed, 0.0, 1e-3);
        assert_eq!(p.auto.ctl[ctl::LUNG_PRESSURE], 0.0);
        assert_eq!(p.auto.state, STATE_IDLE);
        // a harder setup (higher closing pressure) is blown harder
        let mut q = Player { notes: p.notes.clone(), ..Default::default() };
        q.on_keys(&[1.0]);
        let mut hard = SETUP_DEFAULT;
        hard[6] = 3.5;
        q.tick_auto(0.5, 233.0, &user, 0, &hard, &crate::reed::ReedControls { reed_strength: 3.5, ..reed }, 0.0, 1e-3);
        assert!(q.auto.ctl[ctl::LUNG_PRESSURE] > 1.1 * AUTO_MF_PRESSURE, "{}", q.auto.ctl[ctl::LUNG_PRESSURE]);
        // leaving auto mode clears it
        p.auto_off();
        assert!(!p.auto.on);
    }
}
