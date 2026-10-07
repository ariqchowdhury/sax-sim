// Attack-history test (acoustics lead): play a previous note, stop blowing, then attack an
// altissimo fingering; report whether it locks.
//   history <assist> <alt_note> <prev_note> <prev_dur_s> <gap_s> [pressure_kPa] [prep_s] [pure]
// prep_s: time the new fingering (and, with `pure`, the altissimo voicing params) is set BEFORE the
//         re-attack (0 = keys change at the attack instant).
// pure:   assist 0 + the explicit embouchure/tract of the alternate entry applied as params.
use sax_engine::engine::Engine;
use sax_engine::params::Param;
use serde_json::Value;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let assist: f32 = a[1].parse().unwrap();
    let alt_note = &a[2];
    let prev = &a[3];
    let prev_dur: f64 = a[4].parse().unwrap();
    let gap: f64 = a[5].parse().unwrap();
    let p: f32 = a.get(6).map(|s| s.parse().unwrap()).unwrap_or(4.5);
    let prep: f64 = a.get(7).map(|s| s.parse().unwrap()).unwrap_or(0.0);
    let pure = a.get(8).map(|s| s == "pure").unwrap_or(false);
    let gp = std::env::var("GEOM").unwrap_or("../data/alto_sax.json".into());
    let geom = std::fs::read_to_string(&gp).unwrap();
    let j: Value = serde_json::from_str(&geom).unwrap();
    let alt = j["alternate_fingerings"].as_array().unwrap().iter()
        .find(|x| x["note"].as_str() == Some(alt_note) && x["register"].as_i64() == Some(3)).expect("alt").clone();
    let alt_keys: Vec<String> = alt["keys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_string()).collect();
    let f_target = alt["f_target"].as_f64().unwrap();
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(&geom).unwrap();
    e.set_param(Param::PlayerAssist as u32, assist);
    if let Ok(v) = std::env::var("OS") {
        e.set_param(Param::Oversample as u32, v.parse().unwrap());
    }
    let keyseq: f64 = std::env::var("KEYSEQ").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let step_attack = std::env::var("STEP").is_ok();
    let fs = 48000.0;
    let prev_keys: Vec<String> = e.inst.json.fingerings.iter().find(|f| &f.note == prev).unwrap().keys.clone();
    for k in &prev_keys {
        e.set_key_by_name(k, 1.0);
    }
    e.snap_params();
    e.snap_pads();
    let block = 128usize;
    let run = |e: &mut Engine, secs: f64| {
        let n = (secs * fs / block as f64).ceil() as usize;
        for _ in 0..n {
            e.process(block);
        }
    };
    // previous note: 50 ms attack ramp, hold
    let ramp_blocks = (0.05 * fs / block as f64) as usize;
    for i in 0..ramp_blocks {
        e.set_param(0, p * (i + 1) as f32 / ramp_blocks as f32);
        e.process(block);
    }
    run(&mut e, prev_dur);
    // release (optionally stopping the reed with the tongue during the gap)
    let tongue_stop = std::env::var("TONGUE").is_ok();
    e.set_param(0, 0.0);
    if tongue_stop {
        e.set_param(Param::TongueReedContact as u32, 1.0);
    }
    let apply_alt = |e: &mut Engine| {
        if keyseq > 0.0 {
            // finger by finger: release old keys not in the new fingering, then press new ones,
            // keyseq seconds apart (intermediate fingerings are seen by the player)
            for k in &prev_keys {
                if !alt_keys.contains(k) {
                    e.set_key_by_name(k, 0.0);
                    let n = (keyseq * fs / block as f64).ceil() as usize;
                    for _ in 0..n { e.process(block); }
                }
            }
            for k in &alt_keys {
                e.set_key_by_name(k, 1.0);
                let n = (keyseq * fs / block as f64).ceil() as usize;
                for _ in 0..n { e.process(block); }
            }
        } else {
            e.release_all_keys();
            for k in &alt_keys {
                e.set_key_by_name(k, 1.0);
            }
        }
        if pure {
            for blk in ["embouchure", "tract"] {
                if let Some(o) = alt[blk].as_object() {
                    for (k, v) in o {
                        if let Some(id) = Param::by_name(k) {
                            e.set_param(id as u32, v.as_f64().unwrap() as f32);
                        }
                    }
                }
            }
        }
    };
    if gap - prep > 0.0 {
        run(&mut e, gap - prep);
        apply_alt(&mut e);
        run(&mut e, prep);
    } else {
        run(&mut e, gap);
        apply_alt(&mut e);
    }
    if tongue_stop {
        e.set_param(Param::TongueReedContact as u32, 0.0);
    }
    if step_attack {
        e.set_param(0, p);
    } else {
        for i in 0..ramp_blocks {
            e.set_param(0, p * (i + 1) as f32 / ramp_blocks as f32);
            e.process(block);
        }
    }
    run(&mut e, 0.6);
    // measure: fraction of last 0.4 s near target
    let mut ok = 0;
    let mut tot = 0;
    let mut last = 0.0;
    for _ in 0..((0.4 * fs) as usize / block) {
        e.process(block);
        let f = e.pitch_hz();
        last = f;
        tot += 1;
        if f > 0.0 && (1200.0 * (f / f_target).log2()).abs() < 100.0 {
            ok += 1;
        }
    }
    let c = if last > 0.0 { 1200.0 * (last / f_target).log2() } else { f64::NAN };
    println!("{} {:.2} {:.1} {:.0}", if ok * 2 > tot { "LOCK" } else { "FAIL" }, ok as f64 / tot as f64, last, c);
}
