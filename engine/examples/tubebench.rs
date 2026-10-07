use sax_engine::{air::Air, fdtd::Tube};
fn main() {
    let air = Air::at(22.0);
    for &n in &[592usize, 92] {
        let mut t = Tube::with_capacity(n); t.resize(n);
        for i in 0..n - 1 { t.s_half[i] = 1e-4 * (1.0 + i as f64 * 0.01); }
        t.set_coeffs(1.0 / (n - 1) as f64, 1.0 / 192000.0, &air, 1.0, None);
        t.p[3] = 1.0;
        let steps = 192000 * 4;
        let t0 = std::time::Instant::now();
        for _ in 0..steps { t.step_u(); t.step_p_interior(); }
        let el = t0.elapsed().as_secs_f64();
        println!("n={n}: {:.3} ns/node-step  ({:.1} µs per 512 steps)  check {}", el * 1e9 / (steps * n) as f64, el * 1e6 / (steps as f64 / 512.0), t.p[n/2]);
    }
}
