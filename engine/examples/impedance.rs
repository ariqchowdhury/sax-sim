// Usage: impedance <keys comma-separated | fingering name> [os]
// Prints the first impedance peaks of the engine's bore (from its impulse response).
use sax_engine::engine::Engine;
use sax_engine::params::Param;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let geom = std::fs::read_to_string("../data/alto_sax.json").unwrap();
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(&geom).unwrap();
    if let Some(os) = args.get(2) { e.set_param(Param::Oversample as u32, os.parse().unwrap()); }
    let name = args.get(1).cloned().unwrap_or("Bb3".into());
    let keys: Vec<String> = match e.inst.json.fingerings.iter().find(|f| f.note == name) {
        Some(f) => f.keys.clone(),
        None => name.split(',').map(String::from).collect(),
    };
    for k in &keys { if !k.is_empty() { assert!(e.set_key_by_name(k, 1.0), "key {k}"); } }
    if let Ok(v) = std::env::var("LOSS") { e.bore_loss_mult = v.parse().unwrap(); }
    e.snap_params(); e.snap_pads();
    let fs = 48000.0 * e.os as f64;
    let ir = e.impulse_response((fs * 1.0) as usize);
    // DFT on a grid 20..3000 Hz, 0.5 Hz resolution via Goertzel-like direct sum on decimated window
    let mut f = 40.0; let mut mags = vec![];
    while f < 2500.0 {
        let w = 2.0 * std::f64::consts::PI * f / fs;
        let (mut re, mut im) = (0.0, 0.0);
        let (c, s) = (w.cos(), w.sin());
        let (mut cr, mut ci) = (1.0f64, 0.0f64);
        for v in &ir { re += v * cr; im -= v * ci; let t = cr * c - ci * s; ci = cr * s + ci * c; cr = t; }
        mags.push((f, (re * re + im * im).sqrt() / fs)); f += 0.5;
    }
    println!("engine peaks (Hz, |Z| MPa s/m^3):");
    for i in 1..mags.len() - 1 {
        if mags[i].1 > mags[i - 1].1 && mags[i].1 > mags[i + 1].1 && mags[i].1 > 2e6 {
            println!("  {:8.2}  {:7.2}", mags[i].0, mags[i].1 / 1e6);
        }
    }
}
