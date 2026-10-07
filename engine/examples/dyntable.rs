//! Dynamic range through the player model: every fingering at dynamic pp/p/mf/f/ff
//! (player_assist 0.5, lung 3.5 kPa unless LUNG=…), 3 s from a plain attack, settled tail 0.6 s.
//!   cargo run --release --example dyntable [-- NOTE ...]
//! Per note: SPL at 1 m (dB re 20 µPa), centroid of the radiated spectrum (Hz), beating
//! fraction, cents vs target (in register = |¢| < 50). Then a per-register summary.
use sax_engine::engine::Engine;
use sax_engine::params::Param;

fn centroid(x: &[f32], fs: f64) -> f64 {
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

const DYN: [(f32, &str); 5] = [(0.0, "pp"), (0.25, "p"), (0.5, "mf"), (0.75, "f"), (1.0, "ff")];

struct R {
    spl: f64,
    cen: f64,
    beat: f64,
    cents: f64,
}

fn run(geom: &str, note: &str, dynamic: f32, lung: f32) -> R {
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(geom).unwrap();
    let f = e.inst.json.fingerings.iter().find(|f| f.note == note).unwrap().clone();
    for k in &f.keys {
        e.set_key_by_name(k, 1.0);
    }
    e.set_param(Param::BreathNoise as u32, 0.0);
    e.set_param(Param::Dynamic as u32, dynamic);
    e.snap_params();
    e.snap_pads();
    e.set_param(0, lung);
    for _ in 0..(2.4 * 48000.0 / 128.0) as usize {
        e.process(128);
    }
    let (mut out, mut closed, mut nn) = (vec![], 0.0, 0.0);
    for _ in 0..(0.6 * 48000.0 / 128.0) as usize {
        let y = e.process(128).to_vec();
        out.extend_from_slice(&y);
        let tip = e.reed.lumped.par.tip_opening;
        let h0 = tip - e.reed.lumped.par.y_eq;
        for k in 0..128 {
            nn += 1.0;
            if tip - (e.cap_y[k] as f64) < 0.05 * h0 {
                closed += 1.0;
            }
        }
    }
    let rms = (out.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / out.len() as f64).sqrt();
    let f0 = e.pitch_hz();
    R {
        spl: 20.0 * (rms / 0.1 / 2e-5).max(1e-6).log10(),
        cen: if f0 > 0.0 { centroid(&out[out.len() - 4096..], 48000.0) } else { 0.0 },
        beat: closed / nn,
        cents: if f0 > 0.0 { 1200.0 * (f0 / f.f_target.unwrap()).log2() } else { f64::NAN },
    }
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let lung: f32 = std::env::var("LUNG").ok().and_then(|v| v.parse().ok()).unwrap_or(3.5);
    let geom = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../data/alto_sax.json")).unwrap();
    let e = {
        let mut e = Engine::new(48000.0);
        e.load_geometry_json(&geom).unwrap();
        e
    };
    let fings: Vec<(String, i32)> = e
        .inst
        .json
        .fingerings
        .iter()
        .filter(|f| a.is_empty() || a.contains(&f.note))
        .map(|f| (f.note.clone(), f.register.unwrap_or(1)))
        .collect();
    let jobs: Vec<(usize, usize)> = (0..fings.len()).flat_map(|i| (0..DYN.len()).map(move |d| (i, d))).collect();
    let res: Vec<R> = std::thread::scope(|sc| {
        let chunks: Vec<_> = jobs
            .chunks((jobs.len() + 9) / 10)
            .map(|ch| {
                let (geom, fings) = (&geom, &fings);
                sc.spawn(move || ch.iter().map(|&(i, d)| run(geom, &fings[i].0, DYN[d].0, lung)).collect::<Vec<_>>())
            })
            .collect();
        chunks.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    print!("{:<5} reg", "note");
    for (_, n) in DYN {
        print!(" | {:^24}", n);
    }
    println!(" | range");
    let mut summary: std::collections::BTreeMap<i32, Vec<[f64; 6]>> = Default::default();
    for (i, (note, reg)) in fings.iter().enumerate() {
        print!("{:<5} {:>3}", note, reg);
        let r = &res[i * DYN.len()..(i + 1) * DYN.len()];
        for x in r {
            let ok = x.cents.abs() < 50.0;
            print!(" | {:5.1}dB {:4.0}Hz b{:.2} {}{:+4.0}", x.spl, x.cen, x.beat, if ok { ' ' } else { '!' }, x.cents);
        }
        let okall = r.iter().all(|x| x.cents.abs() < 50.0);
        println!(" | {:5.1}{}", r[4].spl - r[0].spl, if okall { "" } else { "  (out of register)" });
        summary.entry(*reg).or_default().push([r[0].spl, r[2].spl, r[4].spl, r[0].cen, r[4].cen, if okall { 1.0 } else { 0.0 }]);
    }
    println!("\nregister | n | pp dB | mf dB | ff dB | range dB (min..max) | centroid pp→ff Hz | all 5 dynamics in register");
    for (reg, v) in summary {
        let n = v.len() as f64;
        let m = |k: usize| v.iter().map(|x| x[k]).sum::<f64>() / n;
        let rng: Vec<f64> = v.iter().map(|x| x[2] - x[0]).collect();
        println!(
            "{:>8} | {:>2} | {:5.1} | {:5.1} | {:5.1} | {:5.1} ({:.1}..{:.1}) | {:4.0} → {:4.0} | {}/{}",
            reg,
            v.len(),
            m(0),
            m(1),
            m(2),
            rng.iter().sum::<f64>() / n,
            rng.iter().cloned().fold(f64::MAX, f64::min),
            rng.iter().cloned().fold(f64::MIN, f64::max),
            m(3),
            m(4),
            v.iter().filter(|x| x[5] > 0.5).count(),
            v.len()
        );
    }
}
