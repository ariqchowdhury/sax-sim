use sax_engine::reed::Reed;
use sax_engine::reed_beam::*;
fn main() {
    let mut b = BeamReed::new(BeamGeom::default(), 1.0 / 192000.0);
    let n = 192000 * 5;
    let t0 = std::time::Instant::now();
    let mut acc = 0.0;
    for k in 0..n { b.step(2000.0 * ((k as f64) * 0.02).sin() + 2000.0); acc += b.opening(); }
    let el = t0.elapsed().as_secs_f64();
    println!("beam: {:.1} ns per internal step (192k), {:.2}% of real time  [{acc:.3}]", el * 1e9 / n as f64, 100.0 * el / 5.0);
}
