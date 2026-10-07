//! Geometry JSON (data/alto_sax.json) → discretised area functions.
//!
//! Coordinates: metres along the bore centreline from the reed tip.

use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ReedJ {
    pub length: f64,
    pub width: f64,
    pub vibrating_width: Option<f64>,
    pub tip_thickness: f64,
    pub heel_thickness: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct MouthpieceJ {
    pub length: f64,
    /// length of the mouthpiece air column up to the neck tenon (at nominal insertion)
    pub air_length: Option<f64>,
    pub profile: Vec<[f64; 2]>,
    pub reed: Option<ReedJ>,
    /// optional named landmarks (x positions) if the data provides them
    pub baffle_end: Option<f64>,
    pub chamber_start: Option<f64>,
    pub chamber_end: Option<f64>,
    pub throat_x: Option<f64>,
    pub nominal: Option<Value>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SectionJ {
    pub profile: Vec<[f64; 2]>,
    pub centerline: Vec<Vec<f64>>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct BellJ {
    pub end_x: f64,
    pub end_radius: f64,
    pub rim_center: Option<Vec<f64>>,
    pub rim_normal: Option<Vec<f64>>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ToneHoleJ {
    pub id: String,
    pub x: f64,
    pub radius: f64,
    pub chimney: f64,
    pub pad_rest: String,
    pub pad_open_height: f64,
    pub angle_deg: f64,
    pub octave_vent: bool,
    pub position: Option<Vec<f64>>,
    pub bore_radius: Option<f64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct KeyActionJ {
    pub hole: String,
    pub set: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct KeyJ {
    pub id: String,
    pub label: String,
    pub hand: String,
    pub kind: String,
    pub position: Vec<f64>,
    pub actions: Vec<KeyActionJ>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct FingeringJ {
    pub note: String,
    pub written_midi: i32,
    pub keys: Vec<String>,
    pub f_target: Option<f64>,
    pub register: Option<i32>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct GeometryJ {
    pub meta: Value,
    pub mouthpiece: MouthpieceJ,
    pub neck: SectionJ,
    pub body: SectionJ,
    pub bell: BellJ,
    pub tone_holes: Vec<ToneHoleJ>,
    pub keys: Vec<KeyJ>,
    pub linkages: Vec<Value>,
    pub octave_logic: Value,
    pub keywork_semantics: Value,
    pub fingerings: Vec<FingeringJ>,
}

pub fn parse(json: &str) -> Result<GeometryJ, String> {
    let g: GeometryJ = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if g.body.profile.len() < 2 {
        return Err("body.profile needs ≥2 points".into());
    }
    Ok(g)
}

/// Piecewise-linear radius function r(x).
#[derive(Clone, Debug, Default)]
pub struct Profile {
    pub pts: Vec<[f64; 2]>,
}

impl Profile {
    pub fn eval(&self, x: f64) -> f64 {
        let p = &self.pts;
        if p.is_empty() {
            return 0.01;
        }
        if x <= p[0][0] {
            return p[0][1];
        }
        let last = p[p.len() - 1];
        if x >= last[0] {
            return last[1];
        }
        // binary search
        let mut lo = 0;
        let mut hi = p.len() - 1;
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if p[mid][0] <= x {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let (x0, r0) = (p[lo][0], p[lo][1]);
        let (x1, r1) = (p[hi][0], p[hi][1]);
        if x1 - x0 <= 1e-12 {
            return r1;
        }
        r0 + (r1 - r0) * (x - x0) / (x1 - x0)
    }
    pub fn end_x(&self) -> f64 {
        self.pts.last().map(|p| p[0]).unwrap_or(0.0)
    }
}

/// Mouthpiece-shaping controls (params 13–18).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MouthpieceControls {
    pub baffle: f64,
    pub chamber: f64,
    pub throat_d_mm: f64,
    pub insertion_mm: f64,
}

impl Default for MouthpieceControls {
    fn default() -> Self {
        MouthpieceControls { baffle: 0.3, chamber: 0.5, throat_d_mm: 11.0, insertion_mm: 10.0 }
    }
}

/// Nominal insertion that the JSON coordinates correspond to (mm).
pub const NOMINAL_INSERTION_MM: f64 = 10.0;
pub const MAX_INSERTION_MM: f64 = 20.0;

/// Processed geometry: everything the engine needs, independent of grid.
#[derive(Clone, Debug, Default)]
pub struct Instrument {
    pub mp: Profile,
    pub rest: Profile,
    pub mp_len: f64,
    /// geometry-coordinate x where the bore ends (bell rim)
    pub end_x: f64,
    pub bell_radius: f64,
    pub reed_width: f64,
    pub holes: Vec<ToneHoleJ>,
    pub json: GeometryJ,
    // mouthpiece landmarks (geometry coords)
    pub baffle_end: f64,
    pub chamber_start: f64,
    pub chamber_end: f64,
    pub throat_x: f64,
    pub throat_r_nominal: f64,
}

impl Instrument {
    pub fn from_json(g: GeometryJ) -> Instrument {
        let mut mp_pts = g.mouthpiece.profile.clone();
        mp_pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(core::cmp::Ordering::Equal));
        let mp_len = g
            .mouthpiece
            .air_length
            .filter(|v| *v > 0.0)
            .or_else(|| mp_pts.last().map(|p| p[0]))
            .unwrap_or(0.075);
        let mut rest: Vec<[f64; 2]> = Vec::new();
        rest.extend(g.neck.profile.iter().cloned());
        rest.extend(g.body.profile.iter().cloned());
        rest.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(core::cmp::Ordering::Equal));
        let rest = Profile { pts: rest };
        let mut end_x = rest.end_x();
        if g.bell.end_x > end_x {
            end_x = g.bell.end_x;
        }
        let bell_radius = if g.bell.end_radius > 0.0 { g.bell.end_radius } else { rest.eval(end_x) };
        let reed_width = g
            .mouthpiece
            .reed
            .as_ref()
            .and_then(|r| r.vibrating_width.filter(|w| *w > 0.0).or(if r.width > 0.0 { Some(0.8 * r.width) } else { None }))
            .unwrap_or(0.0135);
        let mp = Profile { pts: mp_pts };
        // Landmarks: throat = narrowest point in the rear 60 % of the mouthpiece.
        let mut throat_x = g.mouthpiece.throat_x.unwrap_or(-1.0);
        if throat_x < 0.0 {
            let mut best = f64::MAX;
            for p in &mp.pts {
                if p[0] > 0.4 * mp_len && p[0] < 0.95 * mp_len && p[1] < best {
                    best = p[1];
                    throat_x = p[0];
                }
            }
            if throat_x < 0.0 {
                throat_x = 0.7 * mp_len;
            }
        }
        let baffle_end = g.mouthpiece.baffle_end.unwrap_or(0.3 * throat_x.min(mp_len));
        let chamber_start = g.mouthpiece.chamber_start.unwrap_or(baffle_end);
        let chamber_end = g.mouthpiece.chamber_end.unwrap_or(throat_x - 0.1 * mp_len);
        let throat_r_nominal = mp.eval(throat_x);
        let holes = g.tone_holes.clone();
        Instrument {
            mp,
            rest,
            mp_len,
            end_x,
            bell_radius,
            reed_width,
            holes,
            json: g,
            baffle_end,
            chamber_start,
            chamber_end,
            throat_x,
            throat_r_nominal,
        }
    }

    /// Shift (m) removed from the air column by pushing the mouthpiece further
    /// onto the cork than nominal.
    pub fn insertion_shift(ctrl: &MouthpieceControls) -> f64 {
        (ctrl.insertion_mm - NOMINAL_INSERTION_MM) * 1e-3
    }

    /// Total acoustic length from reed tip to bell rim (m).
    pub fn length(&self, ctrl: &MouthpieceControls) -> f64 {
        self.end_x - Self::insertion_shift(ctrl)
    }

    pub fn min_length(&self) -> f64 {
        self.end_x - (MAX_INSERTION_MM - NOMINAL_INSERTION_MM) * 1e-3
    }

    /// Map grid coordinate s (from tip, current insertion) to geometry x.
    pub fn s_to_x(&self, s: f64, ctrl: &MouthpieceControls) -> f64 {
        let d = Self::insertion_shift(ctrl);
        let join = self.mp_len - d.max(0.0);
        if s < join {
            s
        } else {
            s + d
        }
    }

    /// Map a geometry-coordinate position (holes) to grid coordinate.
    pub fn x_to_s(&self, x: f64, ctrl: &MouthpieceControls) -> f64 {
        if x < self.mp_len {
            x
        } else {
            x - Self::insertion_shift(ctrl)
        }
    }

    /// Mouthpiece radius with shaping controls applied.
    fn mp_radius(&self, x: f64, ctrl: &MouthpieceControls) -> f64 {
        let r0 = self.mp.eval(x);
        let def = MouthpieceControls::default();
        let mut area_f = 1.0;
        // Baffle: raised baffle reduces area just behind the tip window.
        if x < self.baffle_end && self.baffle_end > 0.0 {
            let w = smooth_bump(x / self.baffle_end);
            let f = |b: f64| 1.0 - 0.45 * b;
            area_f *= 1.0 + w * (f(ctrl.baffle) / f(def.baffle) - 1.0);
        }
        // Chamber volume scaling.
        if x > self.chamber_start && x < self.chamber_end {
            let u = (x - self.chamber_start) / (self.chamber_end - self.chamber_start);
            let w = smooth_bump(u);
            let f = |c: f64| 0.6 + 0.8 * c;
            area_f *= 1.0 + w * (f(ctrl.chamber) / f(def.chamber) - 1.0);
        }
        let mut r = r0 * area_f.max(0.05).sqrt();
        // Throat: blend toward requested throat radius with a bump of ±25 % mp length.
        let half_w = 0.2 * self.mp_len;
        let dxn = (x - self.throat_x).abs() / half_w;
        if dxn < 1.0 {
            let w = 0.5 * (1.0 + (core::f64::consts::PI * dxn).cos());
            let ratio = (ctrl.throat_d_mm * 0.5e-3) / self.throat_r_nominal.max(1e-4);
            // relative change of nominal throat radius (default 11 mm ↔ JSON value)
            let def_ratio = (def.throat_d_mm * 0.5e-3) / self.throat_r_nominal.max(1e-4);
            r *= 1.0 + w * (ratio / def_ratio - 1.0);
        }
        r
    }

    /// Bore radius at grid coordinate s.
    pub fn radius_at(&self, s: f64, ctrl: &MouthpieceControls) -> f64 {
        let d = Self::insertion_shift(ctrl);
        let join = self.mp_len - d.max(0.0);
        let r = if s < join {
            self.mp_radius(s, ctrl)
        } else if d < 0.0 && s < self.mp_len - d {
            // pulled out: gap of length |d| at the shank radius
            self.mp_radius(self.mp_len - 1e-6, ctrl).max(self.rest.eval(self.mp_len))
        } else {
            let x = s + d;
            if x < self.rest.pts.first().map(|p| p[0]).unwrap_or(0.0) {
                self.mp_radius(x.min(self.mp_len), ctrl)
            } else {
                self.rest.eval(x)
            }
        };
        r.max(5e-4)
    }
}

fn smooth_bump(u: f64) -> f64 {
    // 0 at u=0 and u=1 edges ramped over 20 %, 1 in between
    let e = 0.2;
    if u <= 0.0 || u >= 1.0 {
        0.0
    } else if u < e {
        let t = u / e;
        t * t * (3.0 - 2.0 * t)
    } else if u > 1.0 - e {
        let t = (1.0 - u) / e;
        t * t * (3.0 - 2.0 * t)
    } else {
        1.0
    }
}

/// Built-in fallback geometry (simple truncated cone with a mouthpiece and a
/// flaring bell, no tone holes) used before `sax_load_geometry` and in tests.
pub const FALLBACK_JSON: &str = r#"{
  "meta": {"name": "fallback cone"},
  "mouthpiece": {"length": 0.085,
    "profile": [[0.0,0.0045],[0.01,0.0065],[0.025,0.0085],[0.045,0.0085],[0.06,0.0055],[0.07,0.0062],[0.085,0.0072]],
    "reed": {"length": 0.068, "width": 0.017, "tip_thickness": 0.0001, "heel_thickness": 0.0028}},
  "neck": {"profile": [[0.085,0.0072],[0.33,0.0115]]},
  "body": {"profile": [[0.33,0.0115],[1.05,0.031],[1.12,0.04],[1.16,0.052],[1.19,0.062]]},
  "bell": {"end_x": 1.19, "end_radius": 0.062},
  "tone_holes": [], "keys": [], "linkages": [], "octave_logic": null, "fingerings": []
}"#;
