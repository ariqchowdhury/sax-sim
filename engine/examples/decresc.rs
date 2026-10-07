// slow decrescendo: prints mouthpiece AC rms vs lung pressure
use sax_engine::engine::Engine;
use sax_engine::params::Param;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let geom = std::fs::read_to_string("../data/alto_sax.json").unwrap();
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(&geom).unwrap();
    let f = e.inst.json.fingerings.iter().find(|f| f.note == a[1]).unwrap().clone();
    for k in &f.keys { e.set_key_by_name(k, 1.0); }
    for kv in a.iter().skip(2) { let (k, v) = kv.split_once('=').unwrap(); e.set_param(Param::by_name(k).unwrap() as u32, v.parse().unwrap()); }
    e.snap_params(); e.snap_pads();
    let mut p = 3.5f32;
    e.set_param(0, p);
    for _ in 0..375 { e.process(128); }
    while p > 0.6 {
        let mut s = 0.0; let mut s2 = 0.0; let mut n = 0.0;
        for _ in 0..30 { e.process(128); for k in 0..128 { let v = e.cap_pmp[k] as f64; s += v; s2 += v * v; n += 1.0; } }
        let ac = (s2 / n - (s / n).powi(2)).max(0.0).sqrt();
        println!("p={:.2} kPa  mpAC={:6.0} Pa  ac/p={:.2}  f0={:.1}", p, ac, ac / (p as f64 * 1000.0), e.pitch_hz());
        p -= 0.1; e.set_param(0, p);
    }
}
