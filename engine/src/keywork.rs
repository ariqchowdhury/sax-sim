//! Key mechanism: key press amounts → pad openness targets, driven purely by the
//! `keys`, `linkages` and `keywork_semantics` of data/alto_sax.json.
//!
//! Semantics (verbatim from the data file / docs/PHYSICS.md "Keywork"):
//!   rules = [each key's actions, in key-array order, as {when_all:[key], hole, set}]
//!           ++ linkages (in order).
//!   state[h] = pad_rest(h) (open = 1, closed = 0).
//!   For each rule:
//!     a  = min( min_{k∈when_all} p_k , max_{k∈when_any} p_k )   (empty list → 1)
//!     a *= 1 − max_{k∈unless_any} p_k                           (empty list → 0)
//!     state[h] = state[h]·(1 − a) + target·a,   target = 1 'open', 0 'closed'.
//! This must stay identical to web/src/scene/keywork.ts.

use crate::geometry::GeometryJ;
use serde_json::Value;

#[derive(Clone, Debug, Default)]
pub struct Rule {
    pub hole: usize,
    pub target: f32,
    pub when_all: Vec<usize>,
    pub when_any: Vec<usize>,
    pub unless_any: Vec<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct Keywork {
    pub key_ids: Vec<String>,
    pub hole_ids: Vec<String>,
    pub rest: Vec<f32>,
    pub rules: Vec<Rule>,
    /// unknown key/hole names encountered while parsing (diagnostics)
    pub warnings: Vec<String>,
}

fn set_target(s: &str) -> Option<f32> {
    match s {
        "open" => Some(1.0),
        "closed" | "close" => Some(0.0),
        _ => None,
    }
}

impl Keywork {
    pub fn from_geometry(g: &GeometryJ) -> Keywork {
        let mut kw = Keywork::default();
        kw.key_ids = g.keys.iter().map(|k| k.id.clone()).collect();
        kw.hole_ids = g.tone_holes.iter().map(|h| h.id.clone()).collect();
        kw.rest = g.tone_holes.iter().map(|h| if h.pad_rest == "open" { 1.0 } else { 0.0 }).collect();
        let key_idx = |name: &str| kw_find(&g.keys.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(), name);
        let hole_idx = |name: &str| kw_find(&g.tone_holes.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), name);
        // 1) key actions
        for (ki, key) in g.keys.iter().enumerate() {
            for act in &key.actions {
                match (hole_idx(&act.hole), set_target(&act.set)) {
                    (Some(h), Some(t)) => kw.rules.push(Rule { hole: h, target: t, when_all: vec![ki], ..Default::default() }),
                    _ => kw.warnings.push(format!("key {} action on unknown hole/set {} {}", key.id, act.hole, act.set)),
                }
            }
        }
        // 2) linkages
        for l in &g.linkages {
            let hole = l.get("hole").and_then(Value::as_str).unwrap_or("");
            let set = l.get("set").and_then(Value::as_str).unwrap_or("");
            let (Some(h), Some(t)) = (hole_idx(hole), set_target(set)) else {
                kw.warnings.push(format!("linkage with unknown hole/set {hole} {set}"));
                continue;
            };
            let list = |field: &str, warnings: &mut Vec<String>| -> Vec<usize> {
                let mut v = Vec::new();
                if let Some(arr) = l.get(field).and_then(Value::as_array) {
                    for k in arr {
                        let name = k.as_str().unwrap_or("");
                        match key_idx(name) {
                            Some(i) => v.push(i),
                            None => warnings.push(format!("linkage refers to unknown key {name}")),
                        }
                    }
                }
                v
            };
            let mut w = Vec::new();
            let when_all = list("when_all", &mut w);
            let when_any = list("when_any", &mut w);
            let unless_any = list("unless_any", &mut w);
            kw.warnings.extend(w);
            kw.rules.push(Rule { hole: h, target: t, when_all, when_any, unless_any });
        }
        kw
    }

    pub fn key_index(&self, name: &str) -> Option<usize> {
        self.key_ids.iter().position(|k| k == name)
    }

    /// Evaluate: `pressed[k]` ∈ [0,1] per key → `out[h]` openness target per hole.
    pub fn evaluate(&self, pressed: &[f32], out: &mut [f32]) {
        let n = out.len().min(self.rest.len());
        out[..n].copy_from_slice(&self.rest[..n]);
        let p = |k: usize| -> f32 { pressed.get(k).copied().unwrap_or(0.0).clamp(0.0, 1.0) };
        for r in &self.rules {
            let all = r.when_all.iter().map(|&k| p(k)).fold(1.0f32, f32::min);
            let any = if r.when_any.is_empty() { 1.0 } else { r.when_any.iter().map(|&k| p(k)).fold(0.0f32, f32::max) };
            let unless = r.unless_any.iter().map(|&k| p(k)).fold(0.0f32, f32::max);
            let a = all.min(any) * (1.0 - unless);
            if r.hole < n {
                out[r.hole] = out[r.hole] * (1.0 - a) + r.target * a;
            }
        }
    }
}

fn kw_find(list: &[&str], name: &str) -> Option<usize> {
    list.iter().position(|s| *s == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::parse;

    const J: &str = r#"{
      "body": {"profile": [[0.0,0.01],[1.0,0.05]]},
      "tone_holes": [
        {"id":"A","x":0.5,"radius":0.007,"chimney":0.004,"pad_rest":"open"},
        {"id":"C","x":0.4,"radius":0.005,"chimney":0.004,"pad_rest":"open"},
        {"id":"Gs","x":0.6,"radius":0.007,"chimney":0.004,"pad_rest":"closed"},
        {"id":"oct_neck","x":0.15,"radius":0.0014,"chimney":0.004,"pad_rest":"closed"},
        {"id":"oct_body","x":0.33,"radius":0.0015,"chimney":0.004,"pad_rest":"closed"}
      ],
      "keys": [
        {"id":"OCT","actions":[]},
        {"id":"LH2","actions":[{"hole":"A","set":"closed"}]},
        {"id":"LH3","actions":[]},
        {"id":"LH_Gs","actions":[{"hole":"Gs","set":"open"}]},
        {"id":"RH1","actions":[]}
      ],
      "linkages": [
        {"when_any":["LH2"],"hole":"C","set":"closed"},
        {"when_any":["RH1"],"hole":"Gs","set":"closed"},
        {"when_all":["OCT"],"unless_any":["LH3"],"hole":"oct_neck","set":"open"},
        {"when_all":["OCT","LH3"],"hole":"oct_body","set":"open"}
      ]
    }"#;

    #[test]
    fn keywork_rules() {
        let g = parse(J).unwrap();
        let kw = Keywork::from_geometry(&g);
        assert!(kw.warnings.is_empty(), "{:?}", kw.warnings);
        let mut out = vec![0.0; 5];
        // nothing pressed → rest
        kw.evaluate(&[0.0; 5], &mut out);
        assert_eq!(out, vec![1.0, 1.0, 0.0, 0.0, 0.0]);
        // LH2 closes A (action) and C (linkage)
        kw.evaluate(&[0.0, 1.0, 0.0, 0.0, 0.0], &mut out);
        assert_eq!(out[0], 0.0);
        assert_eq!(out[1], 0.0);
        // G# key opens Gs; RH1 (articulated G#) closes it again
        kw.evaluate(&[0.0, 0.0, 0.0, 1.0, 0.0], &mut out);
        assert_eq!(out[2], 1.0);
        kw.evaluate(&[0.0, 0.0, 0.0, 1.0, 1.0], &mut out);
        assert_eq!(out[2], 0.0);
        // octave logic
        kw.evaluate(&[1.0, 0.0, 0.0, 0.0, 0.0], &mut out);
        assert_eq!((out[3], out[4]), (1.0, 0.0));
        kw.evaluate(&[1.0, 0.0, 1.0, 0.0, 0.0], &mut out);
        assert_eq!((out[3], out[4]), (0.0, 1.0));
        // fractional: OCT 0.5, LH3 0.5 → neck a=0.25, body a=0.5
        kw.evaluate(&[0.5, 0.0, 0.5, 0.0, 0.0], &mut out);
        assert!((out[3] - 0.25).abs() < 1e-6 && (out[4] - 0.5).abs() < 1e-6);
        // half-pressed LH2: A state 1*(1-.5)+0 = .5
        kw.evaluate(&[0.0, 0.5, 0.0, 0.0, 0.0], &mut out);
        assert!((out[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn keywork_real_data_fingerings() {
        // If the real data file is present, every standard fingering must
        // reference known keys and produce a valid state.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../data/alto_sax.json");
        let Ok(s) = std::fs::read_to_string(path) else { return };
        let g = parse(&s).unwrap();
        let kw = Keywork::from_geometry(&g);
        assert!(kw.warnings.is_empty(), "{:?}", kw.warnings);
        let mut out = vec![0.0; kw.hole_ids.len()];
        for f in &g.fingerings {
            let mut pressed = vec![0.0; kw.key_ids.len()];
            for k in &f.keys {
                let i = kw.key_index(k).unwrap_or_else(|| panic!("fingering {} unknown key {}", f.note, k));
                pressed[i] = 1.0;
            }
            kw.evaluate(&pressed, &mut out);
            assert!(out.iter().all(|v| (0.0..=1.0).contains(v)));
        }
        // Bb3: everything below the mouthpiece closed except nothing open
        let pressed: Vec<f32> = kw
            .key_ids
            .iter()
            .map(|k| if ["LH1", "LH2", "LH3", "RH1", "RH2", "RH3", "LH_Bb"].contains(&k.as_str()) { 1.0 } else { 0.0 })
            .collect();
        kw.evaluate(&pressed, &mut out);
        for (i, h) in kw.hole_ids.iter().enumerate() {
            assert_eq!(out[i], 0.0, "hole {h} should be closed for low Bb");
        }
    }
}
