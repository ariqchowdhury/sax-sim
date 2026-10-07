// release ring-down of the dry simulated instrument per note (tongued stop)
use sax_engine::analysis::{self, idx};
use sax_engine::engine::Engine;
use sax_engine::params::Param;
fn main() {
    let geom = std::fs::read_to_string("../data/alto_sax.json").unwrap();
    let sr = 48000.0;
    for n in ["Bb3", "D4", "G4", "C5", "C#5", "G5", "C6", "F6"] {
        for tongued in [true, false] {
            let mut e = Engine::new(sr as f32);
            e.load_geometry_json(&geom).unwrap();
            let f = e.inst.json.fingerings.iter().find(|f| f.note == n).unwrap().clone();
            for k in &f.keys { e.set_key_by_name(k, 1.0); }
            e.snap_params(); e.snap_pads();
            e.set_param(Param::LungPressure as u32, 3.5);
            let mut x: Vec<f32> = vec![];
            for b in 0..(3.2 * sr / 128.0) as usize {
                let t = b as f64 * 128.0 / sr;
                if t >= 2.0 {
                    if tongued { e.set_param(Param::TongueReedContact as u32, 1.0); e.set_param(Param::LungPressure as u32, 0.0); }
                    else { e.set_param(Param::LungPressure as u32, (3.5 * (1.0 - (t - 2.0) / 0.6)).max(0.0) as f32); }
                }
                x.extend_from_slice(e.process(128));
            }
            let a = analysis::analyze(&x, sr as f32, f.f_target.unwrap() as f32);
            println!("{n:4} {} t60 {:5.2} s  tail {:6.1} dB  clean {}  nf {:6.1}", if tongued { "tongued" } else { "faded  " }, a[idx::RELEASE_T60], a[idx::TAIL_RATIO], a[idx::RELEASE_CLEAN], a[idx::NOISE_FLOOR]);
        }
    }
}
