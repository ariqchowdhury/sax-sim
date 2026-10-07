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

#[derive(Clone, Debug)]
struct NoteInfo {
    mask: u64,
    f_target: f64,
    register: i32,
    alt: Option<AltVoicing>,
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
                notes.push(NoteInfo { mask, f_target: f, register: reg.unwrap_or(if f > 340.0 { 2 } else { 1 }), alt: None });
            }
        };
        for f in &g.fingerings {
            add(&f.keys, f.f_target, f.register);
        }
        Player { notes, out: PlayerOffsets { pressure_scale: 1.0, ..Default::default() }, ..Default::default() }
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
                self.notes.push(NoteInfo { mask, f_target: f, register: 3, alt: Some(alt) });
            }
        }
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
                if n.register == 1 && n.f_target < 180.0 && !self.dyn_retry {
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
        let alt_target = if a > 0.0 { self.current.and_then(|i| self.notes[i].alt) } else { None };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_assist_is_pure_physics() {
        let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 140.0, register: 1, alt: None }], ..Default::default() };
        p.on_keys(&[1.0]);
        assert_eq!(p.current, Some(0));
        for _ in 0..10000 {
            p.tick(0.0, 0.0, 280.0, 4000.0, 0.0, 1e-3);
        }
        assert!(p.out.is_neutral(), "{:?}", p.out);
    }

    #[test]
    fn overblown_note_is_pulled_down() {
        let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 140.0, register: 1, alt: None }], ..Default::default() };
        p.on_keys(&[1.0]);
        for _ in 0..2000 {
            p.tick(1.0, 0.5, 280.0, 4000.0, 0.0, 1e-3); // sounding the octave
        }
        assert!(p.out.lip < 0.0 && p.out.pressure_scale < 1.0, "{:?}", p.out);
    }

    #[test]
    fn dynamic_mapping() {
        let mk = || {
            let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 440.0, register: 2, alt: None }], ..Default::default() };
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
            let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 440.0, register: 2, alt: None }], ..Default::default() };
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
            let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: f, register: reg, alt: None }], ..Default::default() };
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
        let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 932.0, register: 3, alt: Some(v) }], ..Default::default() };
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
        let mut q = Player { notes: vec![NoteInfo { mask: 1, f_target: 932.0, register: 3, alt: Some(v) }], ..Default::default() };
        q.on_keys(&[1.0]);
        q.tick(0.0, 0.5, 0.0, 4500.0, 0.0, 1.0);
        assert_eq!(q.out.alt_w, 0.0);
    }
}
