//! Micro-benchmark of the bore kernel on the real C#5 bore at 2×/4×/8×: the
//! fused SIMD `Tube::step` vs the scalar two-pass reference (`step_u` +
//! `step_p_interior`), with their max deviation.
//!   cargo run --release --example kernbench
use sax_engine::engine::Engine;
fn main() {
    let geom = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../data/alto_sax.json")).unwrap();
    for os in [2.0f32, 4.0, 8.0] {
        let mut e = Engine::new(48000.0);
        e.load_geometry_json(&geom).unwrap();
        e.set_param(21, os);
        e.snap_params();
        e.snap_pads();
        let n = e.bore.n;
        let steps = 400_000;
        let init = |t: &mut sax_engine::fdtd::Tube| {
            for i in 0..t.n {
                t.p[i] = (1000.0 * (-((i as f64 - 50.0) / 8.0).powi(2)).exp()) as f32;
            }
        };
        let mut a = e.bore.clone();
        init(&mut a);
        let mut b = e.bore.clone();
        init(&mut b);
        let (mut ta, mut tb) = (f64::MAX, f64::MAX);
        for _ in 0..8 {
            let t0 = std::time::Instant::now();
            for _ in 0..steps / 8 {
                a.step_u();
                a.step_p_interior();
            }
            ta = ta.min(t0.elapsed().as_secs_f64() * 8.0);
            let t0 = std::time::Instant::now();
            for _ in 0..steps / 8 {
                b.step();
            }
            tb = tb.min(t0.elapsed().as_secs_f64() * 8.0);
        }
        let md = a.p.iter().zip(&b.p).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        let pk = a.p.iter().map(|x| x.abs()).fold(0.0f32, f32::max);
        println!(
            "os={os} n={n} nth={}: scalar two-pass reference {:.3} ns/node-step, fused SIMD {:.3} ns/node-step  (max|Δp|/peak {:.1e})",
            e.bore.thermal_nodes,
            ta * 1e9 / (steps * n) as f64,
            tb * 1e9 / (steps * n) as f64,
            md / pk
        );
    }
}
