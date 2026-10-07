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
