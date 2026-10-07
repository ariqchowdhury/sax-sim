//! Engine-level tests: self-oscillation, threshold behaviour, robustness.

use sax_engine::engine::Engine;
use sax_engine::params::{Param, NUM_PARAMS, PARAM_DEFS};
use sax_engine::telemetry::{measure_f0, TELEMETRY_LEN};

fn geometry() -> Option<String> {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../data/alto_sax.json")).ok()
}

fn engine_with(keys: &[&str]) -> Option<Engine> {
    let g = geometry()?;
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(&g).unwrap();
    for k in keys {
        assert!(e.set_key_by_name(k, 1.0), "unknown key {k}");
    }
    e.snap_params();
    e.snap_pads();
    Some(e)
}

/// Run `secs` at lung pressure `kpa`; returns mouthpiece pressure samples.
fn run(e: &mut Engine, kpa: f32, secs: f64) -> Vec<f64> {
    e.set_param(Param::LungPressure as u32, kpa);
    let mut v = Vec::new();
    for _ in 0..(secs * 48000.0 / 128.0) as usize {
        let out = e.process(128);
        assert!(out.iter().all(|x| x.is_finite() && x.abs() <= 1.0));
        v.extend(e.cap_pmp[..128].iter().map(|x| *x as f64));
    }
    v
}

fn ac_rms(x: &[f64]) -> f64 {
    let m = x.iter().sum::<f64>() / x.len() as f64;
    (x.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / x.len() as f64).sqrt()
}

const LOW_BB: [&str; 7] = ["LH1", "LH2", "LH3", "RH1", "RH2", "RH3", "LH_Bb"];

#[test]
fn low_bb_self_oscillates_in_tune() {
    let Some(mut e) = engine_with(&LOW_BB) else { return };
    let p = run(&mut e, 3.0, 1.5);
    let tail = &p[p.len() - 24000..];
    assert!(ac_rms(tail) > 500.0, "no oscillation at 3 kPa");
    let f0 = measure_f0(tail, 48000.0);
    let cents = 1200.0 * (f0 / 138.591).log2();
    assert!(cents.abs() < 25.0, "low Bb f0 {f0:.2} Hz ({cents:+.1} cents)");
    assert_eq!(e.resets, 0);
}

#[test]
fn no_oscillation_below_threshold_and_stops() {
    let Some(mut e) = engine_with(&LOW_BB) else { return };
    let p = run(&mut e, 1.0, 1.0);
    assert!(ac_rms(&p[p.len() - 9600..]) < 50.0, "oscillates at 1 kPa from rest");
    // play, then drop pressure to zero: must decay to silence
    let _ = run(&mut e, 4.0, 1.0);
    let p = run(&mut e, 0.0, 1.0);
    assert!(ac_rms(&p[p.len() - 9600..]) < 5.0, "did not stop");
}

#[test]
fn robust_under_slams_and_random_params() {
    let Some(mut e) = engine_with(&[]) else { return };
    let nkeys = e.keywork.key_ids.len() as u32;
    let mut rng = 12345u64;
    let mut rnd = || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        (rng >> 11) as f64 / (1u64 << 53) as f64
    };
    for blk in 0..3000 {
        if blk % 25 == 0 {
            // pressure slam 0 ↔ 10 kPa
            e.set_param(Param::LungPressure as u32, if (blk / 25) % 2 == 0 { 10.0 } else { 0.0 });
        }
        if blk % 7 == 0 {
            let id = (rnd() * NUM_PARAMS as f64) as u32 % NUM_PARAMS as u32;
            if id != Param::LungPressure as u32 && (id != Param::Oversample as u32 || blk % 140 == 0) {
                let d = &PARAM_DEFS[id as usize];
                // include out-of-range and NaN inputs
                let v = match (rnd() * 10.0) as u32 {
                    0 => f32::NAN,
                    1 => d.max * 10.0,
                    _ => d.min + (d.max - d.min) * rnd() as f32,
                };
                e.set_param(id, v);
            }
        }
        if blk % 5 == 0 {
            e.set_key((rnd() * nkeys as f64) as u32, rnd() as f32);
        }
        let out = e.process(128);
        assert!(out.iter().all(|x| x.is_finite() && x.abs() <= 1.0), "bad output at block {blk}");
        assert!(e.telemetry.iter().all(|x| x.is_finite()), "bad telemetry at block {blk}");
    }
    assert_eq!(e.telemetry.len(), TELEMETRY_LEN);
    // geometry reload while running
    let g = geometry().unwrap();
    e.load_geometry_json(&g).unwrap();
    for _ in 0..100 {
        assert!(e.process(128).iter().all(|x| x.is_finite()));
    }
    assert_eq!(e.resets, 0, "NaN/overflow reset ({})", e.last_reset_reason);
}

#[test]
fn bad_geometry_is_rejected_engine_survives() {
    let mut e = Engine::new(48000.0);
    assert!(e.load_geometry_json("{ not json").is_err());
    assert!(e.load_geometry_json("{}").is_err());
    e.set_param(Param::LungPressure as u32, 3.0);
    for _ in 0..50 {
        assert!(e.process(128).iter().all(|x| x.is_finite()));
    }
}

/// Debug helper: find a param state that produces a reset (prints it).
#[test]
#[ignore]
fn find_nan_source() {
    let Some(mut e) = engine_with(&[]) else { return };
    let nkeys = e.keywork.key_ids.len() as u32;
    let mut rng = 12345u64;
    let mut rnd = || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        (rng >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut vals = [0f32; NUM_PARAMS];
    for i in 0..NUM_PARAMS { vals[i] = PARAM_DEFS[i].default; }
    for blk in 0..3000 {
        if blk % 25 == 0 {
            e.set_param(Param::LungPressure as u32, if (blk / 25) % 2 == 0 { 10.0 } else { 0.0 });
        }
        if blk % 7 == 0 {
            let id = (rnd() * NUM_PARAMS as f64) as u32 % NUM_PARAMS as u32;
            if id != Param::LungPressure as u32 && (id != Param::Oversample as u32 || blk % 140 == 0) {
                let d = &PARAM_DEFS[id as usize];
                let v = match (rnd() * 10.0) as u32 { 0 => f32::NAN, 1 => d.max * 10.0, _ => d.min + (d.max - d.min) * rnd() as f32 };
                e.set_param(id, v);
                vals[id as usize] = e.param(Param::from_id(id).unwrap());
            }
        }
        if blk % 5 == 0 { e.set_key((rnd() * nkeys as f64) as u32, rnd() as f32); }
        let r0 = e.resets;
        e.process(128);
        if e.resets != r0 {
            println!("reset at block {blk} ({}); params:", e.last_reset_reason);
            for i in 0..NUM_PARAMS { println!("  {} = {}", PARAM_DEFS[i].name, vals[i]); }
            break;
        }
    }
}

#[test]
fn corner_parameters_stay_finite_without_resets() {
    let Some(g) = geometry() else { return };
    let mut rng = 777u64;
    let mut rnd = || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        (rng >> 11) as f64 / (1u64 << 53) as f64
    };
    for case in 0..24 {
        let mut e = Engine::new(48000.0);
        e.load_geometry_json(&g).unwrap();
        // every param at a random corner of its range
        for id in 0..NUM_PARAMS as u32 {
            if id == Param::LungPressure as u32 || id == Param::MasterGain as u32 {
                continue;
            }
            let d = &PARAM_DEFS[id as usize];
            let v = if id == Param::Oversample as u32 { [1.0, 2.0, 4.0, 8.0][case % 4] } else if rnd() < 0.5 { d.min } else { d.max };
            e.set_param(id, v);
        }
        let nk = e.keywork.key_ids.len() as u32;
        for k in 0..nk {
            e.set_key(k, if rnd() < 0.5 { 1.0 } else { 0.0 });
        }
        e.snap_params();
        e.snap_pads();
        for (kpa, blocks) in [(10.0f32, 150), (0.0, 50), (3.0, 100)] {
            e.set_param(Param::LungPressure as u32, kpa);
            for _ in 0..blocks {
                assert!(e.process(128).iter().all(|x| x.is_finite()));
            }
        }
        assert_eq!(e.resets, 0, "case {case}: reset ({})", e.last_reset_reason);
    }
}

#[test]
fn beam_reed_plays_low_bb() {
    let Some(mut e) = engine_with(&LOW_BB) else { return };
    e.set_param(Param::ReedModel as u32, 1.0);
    e.set_param(Param::PlayerAssist as u32, 0.0);
    e.snap_params();
    let p = run(&mut e, 3.0, 1.5);
    let tail = &p[p.len() - 24000..];
    assert!(ac_rms(tail) > 500.0, "beam: no oscillation");
    let f0 = measure_f0(tail, 48000.0);
    let cents = 1200.0 * (f0 / 138.591).log2();
    assert!(cents.abs() < 25.0, "beam low Bb {f0:.2} Hz ({cents:+.1} c)");
    // reed shape telemetry is filled and finite
    let s = &e.telemetry[sax_engine::telemetry::IDX_REED_SHAPE..];
    assert!(s.iter().all(|v| v.is_finite()) && s[0] != 0.0);
}

#[test]
fn analysis_deterministic_with_seed() {
    use sax_engine::analysis::{analyze, idx};
    let Some(mut e) = engine_with(&["LH1", "LH2", "LH3"]) else { return };
    e.set_param(Param::BreathNoise as u32, 0.3); // noise on: the seed must matter
    let render = |e: &mut Engine| -> Vec<f32> {
        e.set_param(Param::LungPressure as u32, 3.5);
        let mut x = Vec::new();
        for _ in 0..(2.0 * 48000.0 / 128.0) as usize {
            x.extend_from_slice(e.process(128));
        }
        x
    };
    e.set_seed(7);
    e.reset_offline();
    let a = render(&mut e);
    e.reset_offline();
    let b = render(&mut e);
    assert_eq!(a, b, "two renders after reset with the same seed must be bit-identical");
    let fa = analyze(&a, 48000.0, 233.082);
    let fb = analyze(&b, 48000.0, 233.082);
    assert_eq!(fa, fb);
    assert_eq!(fa[idx::VALID], 1.0);
    assert!(fa[idx::CENTS].abs() < 30.0, "G4 cents {}", fa[idx::CENTS]);
    // a fresh engine with the same seed renders the same note identically
    let Some(mut e2) = engine_with(&["LH1", "LH2", "LH3"]) else { return };
    e2.set_param(Param::BreathNoise as u32, 0.3);
    e2.set_seed(7);
    e2.reset_offline();
    assert_eq!(render(&mut e2), a);
    // a different seed changes the noise
    e.set_seed(8);
    e.reset_offline();
    assert_ne!(render(&mut e), a);
}

/// `reset_offline` must make an engine indistinguishable from a fresh one:
/// render note A, reset, render B == fresh engine (same seed) rendering B, and
/// render B twice in a row with resets → bit-identical; at oversample 2 and 4.
#[test]
fn reset_equals_fresh_engine() {
    let Some(g) = geometry() else { return };
    let fing = |e: &Engine, n: &str| -> Vec<String> { e.inst.json.fingerings.iter().find(|f| f.note == n).unwrap().keys.clone() };
    let setup = |e: &mut Engine, note: &str, os: f32, kpa: f32| {
        e.set_param(Param::Oversample as u32, os);
        e.set_param(Param::BreathNoise as u32, 0.3);
        e.release_all_keys();
        for k in fing(e, note) {
            e.set_key_by_name(&k, 1.0);
        }
        e.set_param(Param::LungPressure as u32, kpa);
        e.process(0); // apply an oversample change (rebuild) if any
        e.reset_offline();
    };
    let render = |e: &mut Engine, secs: f64| -> Vec<f32> {
        let mut x = Vec::new();
        for _ in 0..(secs * 48000.0 / 128.0) as usize {
            x.extend_from_slice(e.process(128));
        }
        x
    };
    for (os, beam) in [(2.0f32, 0.0f32), (4.0, 0.0), (4.0, 1.0)] {
        let mut fresh = Engine::new(48000.0);
        fresh.load_geometry_json(&g).unwrap();
        fresh.set_param(Param::ReedModel as u32, beam);
        fresh.set_seed(5);
        setup(&mut fresh, "D5", os, 4.0);
        let want = render(&mut fresh, 0.8);

        let mut e = Engine::new(48000.0);
        e.load_geometry_json(&g).unwrap();
        e.set_param(Param::ReedModel as u32, beam);
        e.set_seed(5);
        setup(&mut e, "G4", os, 3.0);
        let _ = render(&mut e, 0.7); // a different note first
        setup(&mut e, "D5", os, 4.0);
        let a = render(&mut e, 0.8);
        setup(&mut e, "D5", os, 4.0);
        let b = render(&mut e, 0.8);
        let first_diff = |x: &[f32], y: &[f32]| x.iter().zip(y).position(|(p, q)| p != q);
        assert_eq!(first_diff(&a, &b), None, "os {os} beam {beam}: render → reset → render differs");
        assert_eq!(first_diff(&a, &want), None, "os {os} beam {beam}: reset engine differs from a fresh engine");
    }
}

// ---------------------------------------------------------------- auto player

const STD_NOTES: [&str; 33] = [
    "Bb3", "B3", "C4", "C#4", "D4", "Eb4", "E4", "F4", "F#4", "G4", "G#4", "A4", "Bb4", "B4", "C5", "C#5", "D5", "Eb5", "E5", "F5", "F#5", "G5", "G#5", "A5", "Bb5", "B5", "C6", "C#6", "D6", "Eb6", "E6", "F6", "F#6",
];

fn fingering(e: &Engine, note: &str) -> (Vec<String>, f64) {
    let f = e.inst.json.fingerings.iter().find(|f| f.note == note).unwrap();
    (f.keys.clone(), f.f_target.unwrap())
}

fn press(e: &mut Engine, keys: &[String]) {
    e.release_all_keys();
    for k in keys {
        assert!(e.set_key_by_name(k, 1.0));
    }
}

fn auto_engine(g: &str, os: f32) -> Engine {
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(g).unwrap();
    e.set_param(Param::BreathNoise as u32, 0.0);
    e.set_param(Param::Oversample as u32, os);
    e.set_param(Param::AutoPlayer as u32, 1.0);
    e
}

fn cents(f: f64, t: f64) -> f64 {
    if f > 0.0 {
        1200.0 * (f / t).log2()
    } else {
        f64::NAN
    }
}

/// Every standard fingering at pp / mf / ff sounds in its register with the auto player
/// (default setup; the user's own embouchure/tract values are deliberately off).
#[test]
fn auto_player_all_fingerings_in_register() {
    let Some(g) = geometry() else { return };
    let jobs: Vec<(&str, f32)> = STD_NOTES.iter().flat_map(|n| [0.15f32, 0.5, 0.9].into_iter().map(move |d| (*n, d))).collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let res = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..8 {
            s.spawn(|| loop {
                let j = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if j >= jobs.len() {
                    break;
                }
                let (n, d) = jobs[j];
                let mut e = auto_engine(&g, 2.0);
                let (keys, ft) = fingering(&e, n);
                press(&mut e, &keys);
                e.set_param(Param::Dynamic as u32, d);
                // user controls the auto player must ignore
                e.set_param(Param::LipForce as u32, 2.6);
                e.set_param(Param::TongueY as u32, 0.95);
                e.set_param(Param::GlottisOpen as u32, 0.05);
                e.snap_params();
                e.snap_pads();
                e.set_param(Param::LungPressure as u32, 3.5);
                let mut y = vec![];
                for _ in 0..(1.5 * 48000.0 / 128.0) as usize {
                    y.extend_from_slice(e.process(128));
                }
                let fv = sax_engine::analysis::analyze(&y[y.len() / 2..], 48000.0, ft as f32);
                let f = if fv[sax_engine::analysis::idx::VALID] > 0.0 { fv[sax_engine::analysis::idx::F0] as f64 } else { 0.0 };
                res.lock().unwrap().push((n, d, cents(f, ft)));
            });
        }
    });
    let r = res.into_inner().unwrap();
    let bad: Vec<_> = r.iter().filter(|x| !(x.2.abs() < 100.0)).collect();
    let ok = r.len() - bad.len();
    eprintln!("auto player: {ok}/{} in register; failures {bad:?}", r.len());
    assert!(ok as f64 >= 0.97 * r.len() as f64, "{ok}/{} in register; failures {bad:?}", r.len());
}

/// Chromatic legato scale Bb3 → F#6 at mf with the air on throughout.
#[test]
fn auto_player_legato_scale() {
    let Some(g) = geometry() else { return };
    let mut e = auto_engine(&g, 2.0);
    let (k0, _) = fingering(&e, STD_NOTES[0]);
    press(&mut e, &k0);
    e.snap_params();
    e.snap_pads();
    e.set_param(Param::LungPressure as u32, 3.5);
    let mut bad = vec![];
    for n in STD_NOTES {
        let (keys, ft) = fingering(&e, n);
        press(&mut e, &keys);
        let mut x = vec![];
        // (the first note includes the attack)
        let dur = if n == STD_NOTES[0] { 1.0 } else { 0.5 };
        for _ in 0..(dur * 48000.0 / 128.0) as usize {
            // radiated sound (the mouthpiece pressure of low notes has a strong 2nd harmonic)
            x.extend(e.process(128).iter().map(|v| *v as f64));
        }
        let c = cents(measure_f0(&x[x.len() / 2..], 48000.0), ft);
        if !(c.abs() < 100.0) {
            bad.push((n, c));
        }
        // the air stays on: the lungs never drop below 1 kPa in a slur
        assert!(e.telemetry[sax_engine::telemetry::IDX_PLAYER + 9] > 1.0, "{n}: air dropped");
    }
    eprintln!("legato scale: {}/33 in register {bad:?}", 33 - bad.len());
    assert!(bad.len() <= 1, "notes out of register in the slur: {bad:?}");
}

/// `auto_player_mask`: owned controls stay at the user's value, the others are the player's.
#[test]
fn auto_player_mask_honoured() {
    let Some(g) = geometry() else { return };
    let mut e = auto_engine(&g, 2.0);
    let (keys, ft) = fingering(&e, "G4");
    press(&mut e, &keys);
    // user owns lip_force (bit 0) and tongue_y (bit 4)
    e.set_param(Param::AutoPlayerMask as u32, ((1 << 0) | (1 << 4)) as f32);
    e.set_param(Param::LipForce as u32, 1.4);
    e.set_param(Param::TongueY as u32, 0.2);
    e.set_param(Param::JawOpen as u32, 0.95);
    e.snap_params();
    e.snap_pads();
    let x = run(&mut e, 3.5, 1.0);
    let p = sax_engine::telemetry::IDX_PLAYER;
    let t = &e.telemetry;
    assert!((t[p] - 1.4).abs() < 1e-5, "lip_force {}", t[p]);
    assert!((t[p + 4] - 0.2).abs() < 1e-5, "tongue_y {}", t[p + 4]);
    assert!((t[p + 7] - 0.95).abs() > 0.2, "jaw stays the player's: {}", t[p + 7]);
    assert!(cents(measure_f0(&x[x.len() / 2..], 48000.0), ft).abs() < 100.0);
    assert_eq!(t[p + 10] as i32, 9, "recognised fingering index (G4)");
    assert!(t[p + 12] >= 1.0, "state {}", t[p + 12]);
    // switching the auto player off returns every control to the user's
    e.set_param(Param::AutoPlayer as u32, 0.0);
    e.set_param(Param::PlayerAssist as u32, 0.0);
    e.process(128);
    e.process(128);
    let t = &e.telemetry;
    assert!((t[p + 7] - 0.95).abs() < 1e-5 && (t[p + 4] - 0.2).abs() < 1e-5 && (t[p + 9] - 3.5).abs() < 1e-3, "{:?}", &t[p..p + 13]);
}

/// Unrecognised key combination: the nearest fingering's voicing, never silent.
#[test]
fn auto_player_unknown_fingering_nearest() {
    let Some(g) = geometry() else { return };
    let mut e = auto_engine(&g, 2.0);
    // G4 plus a stray side key
    let (mut keys, _) = fingering(&e, "G4");
    keys.push("RH_side_Bb".into());
    press(&mut e, &keys);
    e.snap_params();
    e.snap_pads();
    let x = run(&mut e, 3.5, 1.0);
    let p = sax_engine::telemetry::IDX_PLAYER;
    assert_eq!(e.telemetry[p + 10], -1.0);
    assert_eq!(e.telemetry[p + 11], 1.0, "nearest-fingering voicing");
    assert!(ac_rms(&x[x.len() / 2..]) > 100.0, "sounds");
}

/// A v1 `auto_player` table entry drives the controls (dynamic interpolation, setup adaptation).
#[test]
fn auto_player_table_v1() {
    let Some(g) = geometry() else { return };
    let mut v: serde_json::Value = serde_json::from_str(&g).unwrap();
    let keys = v["fingerings"].as_array().unwrap().iter().find(|f| f["note"] == "G4").unwrap()["keys"].clone();
    let voc = |lf: f64, lp: f64| serde_json::json!({"lip_force": lf, "lip_position": 12.0, "lip_damping": 0.4, "tongue_x": 0.5, "tongue_y": 0.4,
        "tongue_tip": 0.3, "tongue_length": 0.0, "jaw_open": 0.35, "glottis_open": 0.8, "lung_pressure": lp, "reed_damping": 0.25});
    v["auto_player"] = serde_json::json!({
        "version": 1,
        "controls": ["lip_force","lip_position","lip_damping","tongue_x","tongue_y","tongue_tip","tongue_length","jaw_open","glottis_open","lung_pressure"],
        "setup_reference": {"tip_opening":1.9,"facing_length":22,"baffle_height":0.3,"chamber_size":0.5,"throat_diameter":11,"mouthpiece_insertion":10,"reed_strength":2.5,"reed_model":0,"temperature":22},
        "entries": [{"note":"G4","register":1,"group":"low","keys":keys,"f_target":233.08,
            "voicing":{"pp":voc(1.6, 2.0),"mf":voc(1.0, 3.5),"ff":voc(0.6, 6.0)}}],
        "adaptation": {"pM_reference": 6710.0, "lip_trim_cents_per_N": {"low": 15.0, "mid": 30.0, "palm": 25.0, "altissimo": 40.0},
            "per_param": {"mouthpiece_insertion": {"jaw_open": {"low": 0.01}}},
            "validity": {"mouthpiece_insertion": [5, 15]}}
    });
    let g2 = v.to_string();
    let mut e = auto_engine(&g2, 2.0);
    let (k, _) = fingering(&e, "G4");
    press(&mut e, &k);
    e.set_param(Param::Dynamic as u32, 0.25); // half-way pp–mf
    e.set_param(Param::MouthpieceInsertion as u32, 20.0); // beyond validity: clamped to 15
    e.snap_params();
    e.snap_pads();
    run(&mut e, 3.5, 0.6);
    let p = sax_engine::telemetry::IDX_PLAYER;
    let t = e.telemetry[p..p + 13].to_vec();
    // lung pressure: (2.0 + 3.5)/2 kPa (± the register lock / setup scaling: same reed setup)
    assert!((t[9] - 2.75).abs() < 0.3, "lung {t:?}");
    // jaw: 0.35 + 0.01·(15 − 10)
    assert!((t[7] - 0.40).abs() < 0.03, "jaw {t:?}");
    // lip force near (1.6 + 1.0)/2 (pitch trim ≤ 0.6 N)
    assert!((t[0] - 1.3).abs() < 0.65, "lip {t:?}");
    assert_eq!(t[11], 0.0);
}
