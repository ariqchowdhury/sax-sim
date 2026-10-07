// small-signal tip response y_tip/Δp (magnitude, phase) for lumped and beam reeds
use sax_engine::reed::*;
use sax_engine::reed_beam::*;
fn resp(r: &mut dyn FnMut(f64) -> f64, f: f64, fs: f64) -> (f64, f64) {
    let n = (fs * 0.2) as usize; let a = 10.0; let w = 2.0 * std::f64::consts::PI * f / fs;
    let (mut re, mut im, mut cnt) = (0.0, 0.0, 0.0);
    for k in 0..n { let y = r(a * (w * k as f64).sin()); if k > n / 2 { re += y * (w * k as f64).sin(); im += y * (w * k as f64).cos(); cnt += 1.0; } }
    let mag = 2.0 * (re * re + im * im).sqrt() / cnt / a; (mag, im.atan2(re).to_degrees())
}
fn main() {
    let fs = 192000.0;
    let mut l = LumpedReed::new(derive_reed_params(&ReedControls::default()), 1.0 / fs);
    let mut b = BeamReed::new(BeamGeom::default(), 1.0 / fs);
    let y0l = l.tip_displacement(); let y0b = b.tip_displacement();
    for f in [140.0, 280.0, 420.0, 560.0, 800.0, 1200.0, 1600.0, 2000.0, 2500.0, 3500.0] {
        let (ml, pl) = resp(&mut |dp| { l.step(dp); l.tip_displacement() - y0l }, f, fs);
        let (mb, pb) = resp(&mut |dp| { b.step(dp); b.tip_displacement() - y0b }, f, fs);
        println!("{f:6.0} Hz  lumped {:.3e} m/Pa {:6.1}°   beam {:.3e} m/Pa {:6.1}°", ml, pl, mb, pb);
    }
}
