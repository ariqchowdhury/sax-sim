use sax_engine::engine::Engine;
use sax_engine::params::Param;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let geom = std::fs::read_to_string("../data/alto_sax.json").unwrap();
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(&geom).unwrap();
    let f = e.inst.json.fingerings.iter().find(|f| f.note == a[1]).unwrap().clone();
    for k in &f.keys { e.set_key_by_name(k, 1.0); }
    e.snap_params(); e.snap_pads();
    e.set_param(Param::LungPressure as u32, a[2].parse().unwrap());
    for _ in 0..(48000 * 1) { e.process(1); }
    let mut umax = vec![0f64; e.holes.len()];
    let mut pmax = vec![0f64; e.holes.len()];
    for _ in 0..9600 { e.process(1); for (i,h) in e.holes.iter().enumerate() { umax[i] = umax[i].max(h.term.u.abs()); pmax[i] = pmax[i].max((e.bore.p[h.node] as f64).abs()); } }
    println!("f0 est {:.1}", e.pitch_hz());
    for (i,h) in e.holes.iter().enumerate() { if h.openness > 0.0 { let s = h.area(); println!("{:10} open={:.2} node={} |p|max={:7.0} |U|max={:.2e} v={:6.1} m/s Rnl={:.2e}", h.id, h.openness, h.node, pmax[i], umax[i], umax[i]/s, h.term.knl*umax[i]); } }
}
