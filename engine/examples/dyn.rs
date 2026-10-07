// Dynamics probe (acoustics lead): slow crescendo from silence then decrescendo.
// Prints, per pressure step: mouthpiece AC rms, AC/p_lung, f0, mean reed flow (L/s),
// output level (dB re max), spectral centroid of the radiated signal, reed-closure fraction.
//   cargo run --release --example dyn -- G4 [param=value ...]
// env: SAX_VC (vena contracta), GEOM (geometry path), STEP (kPa, default 0.1), PMAX (default 6)
use sax_engine::engine::Engine;
use sax_engine::params::Param;

fn centroid(x: &[f32], fs: f64) -> f64 {
    // DFT magnitude via naive Goertzel bins every 25 Hz up to 6 kHz (cheap enough here)
    let n = x.len();
    let mut num = 0.0;
    let mut den = 0.0;
    let mut f = 50.0;
    while f < 6000.0 {
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
        num += f * m;
        den += m;
        f += 25.0;
    }
    if den > 0.0 { num / den } else { 0.0 }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let gp = std::env::var("GEOM").unwrap_or("../data/alto_sax.json".into());
    let geom = std::fs::read_to_string(gp).unwrap();
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(&geom).unwrap();
    if let Ok(v) = std::env::var("SAX_VC") {
        e.vena_contracta = v.parse().unwrap();
    }
    if let Ok(v) = std::env::var("SAX_BLM") {
        e.bore_loss_mult = v.parse().unwrap();
    }
    if let Ok(v) = std::env::var("SAX_LCH") {
        e.channel_inertia_len = v.parse().unwrap();
    }
    if let Ok(v) = std::env::var("SAX_NOTRACT") {
        e.use_tract = v != "0";
        e.use_tract = false;
    }
    let f = e.inst.json.fingerings.iter().find(|f| f.note == a[1]).unwrap().clone();
    for k in &f.keys {
        e.set_key_by_name(k, 1.0);
    }
    for kv in a.iter().skip(2) {
        let (k, v) = kv.split_once('=').unwrap();
        e.set_param(Param::by_name(k).unwrap() as u32, v.parse().unwrap());
    }
    e.snap_params();
    e.snap_pads();
    let step: f32 = std::env::var("STEP").ok().and_then(|v| v.parse().ok()).unwrap_or(0.1);
    let pmax: f32 = std::env::var("PMAX").ok().and_then(|v| v.parse().ok()).unwrap_or(6.0);
    let mut ps = vec![];
    let mut p = step;
    while p <= pmax + 1e-6 {
        ps.push(p);
        p += step;
    }
    let mut down: Vec<f32> = ps.iter().rev().cloned().collect();
    down.remove(0);
    let seq: Vec<(f32, &str)> = ps.iter().map(|&p| (p, "up")).chain(down.iter().map(|&p| (p, "down"))).collect();
    let mut rows = vec![];
    for (p, dir) in seq {
        e.set_param(0, p);
        for _ in 0..40 {
            e.process(128);
        }
        let (mut s, mut s2, mut n, mut fl, mut out2, mut closed) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        let mut outv: Vec<f32> = vec![];
        for _ in 0..24 {
            let y = e.process(128).to_vec();
            for k in 0..128 {
                let v = e.cap_pmp[k] as f64;
                s += v;
                s2 += v * v;
                n += 1.0;
                fl += e.cap_u[k] as f64;
                out2 += (y[k] as f64).powi(2);
                outv.push(y[k]);
            }
            if e.reed_h() < 1e-6 {
                closed += 1.0;
            }
        }
        let ac = (s2 / n - (s / n).powi(2)).max(0.0).sqrt();
        let lvl = 10.0 * (out2 / n + 1e-20).log10();
        let cen = if ac > 30.0 { centroid(&outv[outv.len() - 2048..], 48000.0) } else { 0.0 };
        rows.push((p, dir, ac, e.pitch_hz(), fl / n * 1000.0, lvl, cen, closed / 24.0));
    }
    let lmax = rows.iter().map(|r| r.5).fold(-1e9, f64::max);
    for r in rows {
        println!(
            "{:4} p={:.2} kPa  mpAC={:6.0} Pa  ac/p={:.2}  f0={:6.1}  U={:.3} L/s  out={:6.1} dB  centroid={:5.0} Hz  closed={:.2}",
            r.1, r.0, r.2, r.2 / (r.0 as f64 * 1000.0), r.3, r.4, r.5 - lmax, r.6, r.7
        );
    }
}
