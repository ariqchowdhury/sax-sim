//! Loss-model trade-off study driver (see engine/perf/loss_study.py).
//!
//!   loss_study bore  <out.bin> [--os 4] [--poles a1,a2,a3:b1,b2,b3] [--thermal-r 0.012] [--seconds 1]
//!       writes the reed-end impulse response z(t) (rigid reed, Pa per m³/s) of every fingering,
//!       f32 LE, one after the other; prints the bore kernel cost (ns per node-step, C#5 bore)
//!   loss_study tract <out.bin> [--os 4] [--dx 0.005] [--poles ...]
//!       vocal-tract input impedance IR (mouth end, anechoic trachea) for the neutral tract
use sax_engine::air::Air;
use sax_engine::engine::Engine;
use sax_engine::fdtd::Tube;
use sax_engine::params::Param;
use sax_engine::tract::{tract_area, TractControls, TRACT_LEN, WALL_LOSS_MULT};
use std::io::Write;

fn arg(a: &[String], k: &str) -> Option<String> {
    a.iter().position(|x| x == k).and_then(|i| a.get(i + 1).cloned())
}

fn poles(a: &[String]) -> Option<([f64; 3], [f64; 3])> {
    arg(a, "--poles").map(|s| {
        let (x, y) = s.split_once(':').expect("a1,a2,a3:b1,b2,b3");
        let p = |t: &str| -> [f64; 3] {
            let v: Vec<f64> = t.split(',').map(|q| q.parse().unwrap()).collect();
            [v[0], v[1], v[2]]
        };
        (p(x), p(y))
    })
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mode = a[1].clone();
    let out = a[2].clone();
    let os: f32 = arg(&a, "--os").map(|s| s.parse().unwrap()).unwrap_or(4.0);
    let secs: f64 = arg(&a, "--seconds").map(|s| s.parse().unwrap()).unwrap_or(1.0);
    let lp = poles(&a);
    let mut f = std::io::BufWriter::new(std::fs::File::create(&out).unwrap());
    if mode == "tract" {
        let dx_t: f64 = arg(&a, "--dx").map(|s| s.parse().unwrap()).unwrap_or(0.005);
        let fs = 48000.0 * os as f64;
        let dt = 1.0 / fs;
        let n = ((TRACT_LEN / dx_t.max(Air::c_max() * dt)).floor() as usize).max(4) + 1;
        let mut t = Tube::with_capacity(n);
        t.resize(n);
        t.loss_ab = lp;
        let ctrl = TractControls::default();
        let dx = TRACT_LEN / (n - 1) as f64;
        for i in 0..n - 1 {
            t.s_half[i] = tract_area((i as f64 + 0.5) * dx, &ctrl);
        }
        let air = Air::breath();
        t.set_coeffs(dx, dt, &air, WALL_LOSS_MULT, None);
        let r_g = air.rho * air.c / 2.5e-4;
        let steps = (fs * secs) as usize;
        for s in 0..steps {
            let (p0, pl) = (t.p[0] as f64, t.p[n - 1] as f64);
            t.step();
            let k0 = t.kp[0] as f64;
            t.p[0] = ((p0 - k0 * t.u[0] as f64 - k0 * 0.5 * p0 / r_g) / (1.0 + 0.5 * k0 / r_g)) as f32;
            let kl = t.kp[n - 1] as f64;
            let uin = if s == 0 { fs } else { 0.0 }; // unit volume impulse
            t.p[n - 1] = (pl + kl * (t.u[n - 2] as f64 + uin)) as f32;
            f.write_all(&(t.p[n - 1]).to_le_bytes()).unwrap();
        }
        println!("tract nodes={n} dx={:.4}", dx);
        return;
    }
    let thr: Option<f64> = arg(&a, "--thermal-r").map(|s| s.parse().unwrap());
    let geom = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../data/alto_sax.json")).unwrap();
    let e0 = Engine::new(48000.0);
    let mut e0 = e0;
    e0.load_geometry_json(&geom).unwrap();
    let fings = e0.inst.json.fingerings.clone();
    let mk = |keys: &[String]| {
        let mut e = Engine::new(48000.0);
        e.load_geometry_json(&geom).unwrap();
        e.set_param(Param::Oversample as u32, os);
        e.bore.loss_ab = lp;
        if let Some(r) = thr {
            e.thermal_radius = r;
        }
        e.release_all_keys();
        for k in keys {
            e.set_key_by_name(k, 1.0);
        }
        e.snap_params();
        e.snap_pads();
        e
    };
    let irs: Vec<Vec<f64>> = std::thread::scope(|sc| {
        let hs: Vec<_> = fings
            .iter()
            .map(|fg| {
                let mk = &mk;
                sc.spawn(move || {
                    let e = mk(&fg.keys);
                    let steps = (secs * 48000.0 * e.os as f64) as usize;
                    e.impulse_response(steps)
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for ir in &irs {
        for &v in ir {
            f.write_all(&(v as f32).to_le_bytes()).unwrap();
        }
    }
    // kernel cost on the C#5 bore
    let cs5 = fings.iter().find(|q| q.note == "C#5").unwrap();
    let e = mk(&cs5.keys);
    let mut b = e.bore.clone();
    for i in 0..b.n {
        b.p[i] = (100.0 * (i as f64 * 0.1).sin()) as f32;
    }
    let steps = 100_000;
    let mut best = f64::MAX;
    for _ in 0..5 {
        let t0 = std::time::Instant::now();
        for _ in 0..steps {
            b.step();
        }
        best = best.min(t0.elapsed().as_secs_f64());
    }
    println!(
        "fingerings={} os={} n={} thermal_nodes={} kernel={:.3} ns/node-step ({:.1} µs per 128-sample block)",
        fings.len(),
        e.os,
        b.n,
        b.thermal_nodes,
        best * 1e9 / (steps * b.n) as f64,
        best / steps as f64 * 1e6 * 128.0 * e.os as f64
    );
}
