// Engine tract impedance peak for given params: tractpeak name=value ...
use sax_engine::params::Param;
fn main() {
    let geom = std::fs::read_to_string("../data/alto_sax.json").unwrap();
    sax_engine::sax_init(48000.0);
    unsafe { sax_engine::sax_load_geometry(geom.as_ptr(), geom.len() as u32) };
    for kv in std::env::args().skip(1) {
        let (k, v) = kv.split_once('=').unwrap();
        sax_engine::sax_set_param(Param::by_name(k).unwrap() as u32, v.parse().unwrap());
    }
    let n = 400;
    let p = sax_engine::sax_compute_tract_impedance(n, 400.0, 2000.0);
    let z = unsafe { std::slice::from_raw_parts(p, 2 * n as usize) };
    let (mut bi, mut bz) = (0, 0.0f32);
    for i in 0..n as usize { if z[i] > bz { bz = z[i]; bi = i; } }
    let f = 400.0 * (2000.0f64 / 400.0).powf(bi as f64 / (n - 1) as f64);
    println!("tract peak {:.0} Hz {:.1} MPa s/m3", f, bz / 1e6);
}
