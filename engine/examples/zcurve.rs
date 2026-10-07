use sax_engine::engine::Engine;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let geom = std::fs::read_to_string(std::env::var("GEOM").unwrap_or("../data/alto_sax.json".into())).unwrap();
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(&geom).unwrap();
    let f = e.inst.json.fingerings.iter().find(|f| f.note == a[1]).unwrap().clone();
    for k in &f.keys { e.set_key_by_name(k, 1.0); }
    e.snap_params(); e.snap_pads();
    let fs = 48000.0 * e.os as f64;
    let ir = e.impulse_response((fs * 1.0) as usize);
    let (f0, f1, df): (f64, f64, f64) = (a[2].parse().unwrap(), a[3].parse().unwrap(), a[4].parse().unwrap());
    let mut fr = f0;
    while fr <= f1 {
        let w = 2.0 * std::f64::consts::PI * fr / fs;
        let (mut re, mut im) = (0.0, 0.0);
        for (i, v) in ir.iter().enumerate() { re += v * (w * i as f64).cos(); im -= v * (w * i as f64).sin(); }
        println!("{:.1} {:.2}", fr, (re * re + im * im).sqrt() / fs / 1e6);
        fr += df;
    }
}
