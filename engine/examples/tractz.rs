// Vocal-tract input impedance seen from the reed (mouth end), glottis end loaded by R.
use sax_engine::air::Air;
use sax_engine::tract::*;
fn main() {
    let a: Vec<f64> = std::env::args().skip(1).map(|s| s.parse().unwrap()).collect();
    let (ty, tx, loss) = (a[0], a[1], a[2]); let jaw = if a.len() > 3 { a[3] } else { 0.3 };
    let fs = 192000.0; let dt = 1.0 / fs;
    let mut t = Tract::new(64); t.build(dt);
    t.ctrl = TractControls { tongue_x: tx, tongue_y: ty, tongue_tip: 0.3, jaw_open: jaw, glottis_area: if a.len() > 4 { a[4] * 1e-4 } else { 1.61e-4 } };
    let air = Air::breath();
    let n = t.tube.n; let dx = TRACT_LEN / (n - 1) as f64;
    for i in 0..n - 1 { t.tube.s_half[i] = tract_area((i as f64 + 0.5) * dx, &t.ctrl); }
    t.tube.set_coeffs(dx, dt, &air, loss, None);
    let r_g = air.rho * air.c / 2.5e-4; // subglottal (anechoic trachea)
    let steps = (fs * 0.3) as usize; let mut ir = vec![];
    for s in 0..steps {
        t.tube.step_u(); let p0 = t.tube.p[0] as f64; let pl = t.tube.p[n - 1] as f64;
        t.tube.step_p_interior();
        let k0 = t.tube.kp[0] as f64; // glottis node: flow out through r_g (implicit)
        t.tube.p[0] = ((p0 - k0 * t.tube.u[0] as f64 * 0.0 + k0 * (-(t.tube.u[0] as f64)) - k0 * 0.5 * p0 / r_g) / (1.0 + 0.5 * k0 / r_g)) as f32;
        let kl = t.tube.kp[n - 1] as f64; let uin = if s == 0 { 1e-9 * fs } else { 0.0 };
        t.tube.p[n - 1] = (pl + kl * (t.tube.u[n - 2] as f64 + uin)) as f32;
        ir.push(t.tube.p[n - 1] as f64 * 1e9);
    }
    let mut f = 100.0; let mut prev = (0.0, 0.0); let mut up = false;
    while f < 3000.0 {
        let w = 2.0 * std::f64::consts::PI * f / fs; let (mut re, mut im) = (0.0, 0.0);
        for (i, v) in ir.iter().enumerate() { re += v * (w * i as f64).cos(); im += v * (w * i as f64).sin(); }
        let m = (re * re + im * im).sqrt() / fs / 1e6;
        if m < prev.1 && up { println!("peak {:.0} Hz  {:.1} MPa s/m3", prev.0, prev.1); }
        up = m > prev.1; prev = (f, m); f += 10.0;
    }
}
