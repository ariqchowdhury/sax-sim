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
}

#[derive(Clone, Debug)]
struct NoteInfo {
    mask: u64,
    f_target: f64,
    register: i32,
}

#[derive(Clone, Debug, Default)]
pub struct Player {
    notes: Vec<NoteInfo>,
    pub current: Option<usize>,
    /// adaptive register-locking state, −1 (lower) … +1 (raise)
    adapt: f64,
    silent_t: f64,
    hold_t: f64,
    pub out: PlayerOffsets,
}

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
                notes.push(NoteInfo { mask, f_target: f, register: reg.unwrap_or(if f > 340.0 { 2 } else { 1 }) });
            }
        };
        for f in &g.fingerings {
            add(&f.keys, f.f_target, f.register);
        }
        Player { notes, out: PlayerOffsets { pressure_scale: 1.0, ..Default::default() }, ..Default::default() }
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
        }
    }

    pub fn target_hz(&self) -> Option<f64> {
        self.current.map(|i| self.notes[i].f_target)
    }

    /// Control-rate update. `freq` = tracked playing frequency (0 = silent),
    /// `lung_pa` = requested lung pressure, `dt` = tick period (s).
    /// Returns true when the offsets changed.
    pub fn tick(&mut self, assist: f64, freq: f64, lung_pa: f64, tongue: f64, dt: f64) -> bool {
        let a = assist.clamp(0.0, 1.0);
        let mut o = PlayerOffsets { pressure_scale: 1.0, ..Default::default() };
        if a > 0.0 {
            if let Some(i) = self.current {
                let n = &self.notes[i];
                // feed-forward embouchure per note (what players do)
                if n.register == 1 && n.f_target < 180.0 {
                    o.pressure_scale -= 0.05;
                    o.jaw += 0.15;
                    o.tongue_y -= 0.10;
                } else if n.register >= 2 && n.f_target > 690.0 {
                    o.lip += 0.20;
                    o.pressure_scale += 0.10;
                    o.tongue_y += 0.30;
                    o.tongue_x -= 0.30;
                } else if n.register >= 2 {
                    o.lip += 0.10;
                    o.pressure_scale += 0.05;
                }
                // register locking feedback
                // no feedback while the tongue stops the reed (articulation) or
                // during the 120 ms after its release (note still starting)
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
                o.lip = o.lip * a + 0.5 * x;
                o.pressure_scale = 1.0 + (o.pressure_scale - 1.0) * a + 0.2 * x;
                o.tongue_y = o.tongue_y * a + 0.25 * x;
                o.tongue_x *= a;
                o.jaw = o.jaw * a - 0.15 * x;
            }
        }
        let changed = (o.lip - self.out.lip).abs() > 1e-3
            || (o.pressure_scale - self.out.pressure_scale).abs() > 1e-4
            || (o.tongue_y - self.out.tongue_y).abs() > 1e-3
            || (o.tongue_x - self.out.tongue_x).abs() > 1e-3
            || (o.jaw - self.out.jaw).abs() > 1e-3;
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
        let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 140.0, register: 1 }], ..Default::default() };
        p.on_keys(&[1.0]);
        assert_eq!(p.current, Some(0));
        for _ in 0..10000 {
            p.tick(0.0, 280.0, 4000.0, 0.0, 1e-3);
        }
        assert_eq!(p.out, PlayerOffsets { pressure_scale: 1.0, ..Default::default() });
    }

    #[test]
    fn overblown_note_is_pulled_down() {
        let mut p = Player { notes: vec![NoteInfo { mask: 1, f_target: 140.0, register: 1 }], ..Default::default() };
        p.on_keys(&[1.0]);
        for _ in 0..2000 {
            p.tick(1.0, 280.0, 4000.0, 0.0, 1e-3); // sounding the octave
        }
        assert!(p.out.lip < 0.0 && p.out.pressure_scale < 1.0, "{:?}", p.out);
    }
}
