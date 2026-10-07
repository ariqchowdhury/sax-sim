// Calibration report for the beam reed at a given embouchure.
// usage: beamcal [lip_force] [lip_pos_mm] [strength]
use sax_engine::reed::Reed;
use sax_engine::reed_beam::*;
fn main() {
    let a: Vec<f64> = std::env::args().skip(1).map(|s| s.parse().unwrap()).collect();
    let mut c = BeamControls::default();
    if let Some(v) = a.first() { c.lip_force = *v; }
    if let Some(v) = a.get(1) { c.lip_position_mm = *v; }
    if let Some(v) = a.get(2) { c.reed_strength = *v; }
    let mut g = BeamGeom::default();
    if let Ok(e) = std::env::var("E") { g.e_mod = e.parse().unwrap(); }
    if let Ok(e) = std::env::var("TAPER") { g.taper = e.parse().unwrap(); }
    if let Ok(e) = std::env::var("FSAT") { g.lip_fsat = e.parse().unwrap(); }
    if let Ok(e) = std::env::var("KLF") { g.lip_k_force = e.parse().unwrap(); }
    if let Ok(e) = std::env::var("RL") { g.lip_damp_gain = e.parse().unwrap(); }
    if let Ok(e) = std::env::var("LIPG") { g.lip_gain = e.parse().unwrap(); }
    let fs = 192000.0;
    let mut b = BeamReed::new(g, 1.0 / fs);
    b.configure(&c);
    b.settle();
    let (h0, dv, dy) = b.static_compliance();
    let rc2 = 1.42e5;
    println!("H0 = {:.3} mm, tip compliance {:.3e} m/Pa → p_M(lin) ≈ {:.1} kPa, V_r = {:.2} cm³", h0 * 1e3, dy, h0 / dy / 1e3, rc2 * dv * 1e6);
    // static closing pressure: ramp dp slowly
    let mut pc = 0.0;
    for k in 0..400 {
        let dp = k as f64 * 100.0;
        for _ in 0..2000 { b.step(dp); }
        if b.opening() <= 1e-6 { pc = dp; break; }
    }
    println!("static closing pressure ≈ {:.1} kPa", pc / 1e3);
    // lipped resonance: settle at 0, then pressure impulse, track tip
    b.settle();
    let n = (0.03 * fs) as usize;
    let mut tip = Vec::new();
    for k in 0..n { b.step(if k < 2 { 2000.0 } else { 0.0 }); tip.push(b.tip_displacement()); }
    let m = tip.iter().sum::<f64>() / n as f64;
    // spectrum peak 300..6000 Hz
    let (mut best, mut bf) = (0.0, 0.0);
    let mut mags = vec![];
    let mut f = 300.0;
    while f < 6000.0 {
        let w = 2.0 * std::f64::consts::PI * f / fs;
        let (mut re, mut im) = (0.0, 0.0);
        for (i, v) in tip.iter().enumerate() { re += (v - m) * (w * i as f64).cos(); im += (v - m) * (w * i as f64).sin(); }
        let mg = (re * re + im * im).sqrt();
        mags.push((f, mg));
        if mg > best { best = mg; bf = f; }
        f += 10.0;
    }
    // half-power bandwidth
    let hp: Vec<_> = mags.iter().filter(|(_, m)| *m > best / 2f64.sqrt()).map(|(f, _)| *f).collect();
    let bw = hp.last().unwrap() - hp.first().unwrap();
    println!("lipped first mode ≈ {:.0} Hz, q ≈ {:.2}", bf, bw / bf);
}
