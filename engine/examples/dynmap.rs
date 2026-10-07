//! Dynamics map (pure physics, player_assist = 0): for a fingering, start each
//! note at an onset pressure where it speaks, then glide (0.3 s) to the target
//! embouchure/pressure and measure the settled tone over 0.5 s.
//!   cargo run --release --example dynmap -- NOTE onset_kPa "p=0.9,lip_force=2.8,jaw_open=0.6" ...
//! Prints SPL at 1 m (dB re 20 µPa), f0, cents vs target, centroid (Hz), beating fraction,
//! mouthpiece AC (Pa), p_M estimate.
use sax_engine::engine::Engine;
use sax_engine::params::Param;

pub fn centroid(x: &[f32], fs: f64) -> f64 {
    let n = x.len();
    let (mut num, mut den) = (0.0, 0.0);
    let mut f = 50.0;
    while f < 8000.0 {
        let w = 2.0 * std::f64::consts::PI * f / fs;
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        let c = 2.0 * w.cos();
        for (i, &v) in x.iter().enumerate() {
            let win = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos();
            let s0 = v as f64 * win + c * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        let m = (s1 * s1 + s2 * s2 - c * s1 * s2).max(0.0).sqrt();
        num += f * m * m;
        den += m * m;
        f += 25.0;
    }
    if den > 0.0 { num / den } else { 0.0 }
}

fn main() {
    // combos: "p=0.9,lip_force=2.8,lip_position=16,jaw_open=0.6" (p = lung kPa; others = engine params)
    let a: Vec<String> = std::env::args().collect();
    let geom = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../data/alto_sax.json")).unwrap();
    let note = a[1].clone();
    let onset: f32 = a[2].parse().unwrap();
    let combos: Vec<Vec<(String, f32)>> = a[3..]
        .iter()
        .map(|s| s.split(',').map(|kv| { let (k, v) = kv.split_once('=').expect("key=value"); (k.to_string(), v.parse().unwrap()) }).collect())
        .collect();
    let res: Vec<String> = std::thread::scope(|sc| {
        let hs: Vec<_> = combos
            .iter()
            .map(|c| {
                let (geom, note) = (&geom, &note);
                sc.spawn(move || {
                    let mut e = Engine::new(48000.0);
                    e.load_geometry_json(geom).unwrap();
                    let f = e.inst.json.fingerings.iter().find(|f| &f.note == note).unwrap().clone();
                    for k in &f.keys {
                        e.set_key_by_name(k, 1.0);
                    }
                    e.set_param(Param::PlayerAssist as u32, 0.0);
                    e.set_param(Param::BreathNoise as u32, 0.0);
                    e.snap_params();
                    e.snap_pads();
                    e.set_param(0, onset);
                    for _ in 0..(0.35 * 48000.0 / 128.0) as usize {
                        e.process(128);
                    }
                    // glide every given control from its current value to the target over 0.3 s
                    let tg: Vec<(u32, f32, f32)> = c
                        .iter()
                        .map(|(k, v)| {
                            let id = if k == "p" { 0 } else { Param::by_name(k).unwrap_or_else(|| panic!("param {k}")) as u32 };
                            let from = if id == 0 { onset } else { e.param(Param::by_name(k).unwrap()) };
                            (id, from, *v)
                        })
                        .collect();
                    let glide: f64 = std::env::var("GLIDE").ok().and_then(|v| v.parse().ok()).unwrap_or(0.3);
                    let nb = (glide * 48000.0 / 128.0) as usize;
                    for i in 0..nb {
                        let t = (i + 1) as f32 / nb as f32;
                        for &(id, a0, a1) in &tg {
                            e.set_param(id, a0 + (a1 - a0) * t);
                        }
                        e.process(128);
                    }
                    for _ in 0..(0.5 * 48000.0 / 128.0) as usize {
                        e.process(128);
                    }
                    let (mut out, mut pm, mut closed, mut nn) = (vec![], vec![], 0.0, 0.0);
                    let tip = e.reed.lumped.par.tip_opening;
                    let h0n = tip - e.reed.lumped.par.y_eq;
                    for _ in 0..(0.5 * 48000.0 / 128.0) as usize {
                        let y = e.process(128).to_vec();
                        out.extend_from_slice(&y);
                        pm.extend_from_slice(&e.cap_pmp[..128]);
                        for k in 0..128 {
                            nn += 1.0;
                            if tip - (e.cap_y[k] as f64) < 0.05 * h0n {
                                closed += 1.0;
                            }
                        }
                    }
                    let rms = (out.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / out.len() as f64).sqrt();
                    let spl = 20.0 * (rms / 0.1 / 2e-5).max(1e-9).log10();
                    let f0 = e.pitch_hz();
                    let cents = if f0 > 0.0 { 1200.0 * (f0 / f.f_target.unwrap()).log2() } else { f64::NAN };
                    let cen = if f0 > 0.0 { centroid(&out[out.len() - 4096..], 48000.0) } else { 0.0 };
                    let rp = &e.reed.lumped.par;
                    let h0 = rp.tip_opening - rp.y_eq;
                    let pmax = rp.k * h0 / rp.s_r;
                    let desc: Vec<String> = c.iter().map(|(k, v)| format!("{k}={v}")).collect();
                    format!(
                        "{:<60} | SPL={:5.1} dB  f0={:6.1} ({:+5.0}¢)  cen={:5.0}  beat={:.2}  pM={:.1}kPa γ={:.2}",
                        desc.join(","), spl, f0, cents, cen, closed / nn, pmax / 1e3, e.lung_pressure() / pmax
                    )
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for r in res {
        println!("{note} {r}");
    }
}
