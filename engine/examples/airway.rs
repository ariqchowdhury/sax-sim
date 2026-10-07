// Airway (subglottal + vocal tract) impedance study.
//   airway sub                       subglottal input impedance at the glottis (peaks, bandwidths)
//   airway tract [name=value ...]    tract impedance at the reed, subglottal on/off
use sax_engine::air::Air;
use sax_engine::params::Param;
use sax_engine::tract::Subglottal;

fn dft(z: &[f64], dt: f64, f: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * f * dt;
    let (mut re, mut im) = (0.0, 0.0);
    for (k, v) in z.iter().enumerate() {
        re += v * (w * k as f64).cos();
        im -= v * (w * k as f64).sin();
    }
    (re * re + im * im).sqrt() * dt
}

fn peaks(fs: &[f64], m: &[f64]) -> Vec<(f64, f64, f64)> {
    let mut out = vec![];
    for i in 1..m.len() - 1 {
        if m[i] > m[i - 1] && m[i] > m[i + 1] {
            let h = m[i] / 2f64.sqrt();
            let (mut a, mut b) = (i, i);
            while a > 0 && m[a] > h {
                a -= 1;
            }
            while b < m.len() - 1 && m[b] > h {
                b += 1;
            }
            out.push((fs[i], m[i] / 1e6, fs[b] - fs[a]));
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(|s| s.as_str()).unwrap_or("sub");
    let fs: Vec<f64> = (0..600).map(|i| 100.0 + 5.0 * i as f64).collect();
    if mode == "bench" {
        let dt = 1.0 / 192000.0;
        let mut s = Subglottal::default();
        s.build(dt, &Air::breath());
        s.prefill(4000.0);
        let mut acc = 0.0;
        let steps = 4_000_000;
        let mut best = f64::MAX;
        for _ in 0..5 {
        let t0 = std::time::Instant::now();
        for k in 0..steps {
            let (pp, kk) = s.step(4000.0, 1e-4);
            let ug = 1e-4 + 1e-4 * ((k % 97) as f64 / 97.0 - 0.5);
            acc += pp - kk * ug;
            s.set_top(ug);
        }
        best = best.min(t0.elapsed().as_secs_f64() * 1e9 / steps as f64);
        }
        let ns = best;
        println!("subglottal step: {:.1} ns  → {:.1} µs per 128-sample block at os=4 ({})", ns, ns * 512.0 / 1000.0, acc > 0.0);
        return;
    }
    if mode == "sub" {
        let dt = 1.0 / 192000.0;
        let mut s = Subglottal::default();
        s.build(dt, &Air::breath());
        s.clear_state();
        let steps = (0.15 / dt) as usize;
        let mut z = Vec::with_capacity(steps);
        for k in 0..steps {
            s.step(0.0, 0.0);
            s.set_top(if k == 0 { -1e-9 / dt } else { 0.0 });
            z.push(s.p[s.n - 1] as f64 * 1e9);
        }
        let m: Vec<f64> = fs.iter().map(|&f| dft(&z, dt, f)).collect();
        println!("subglottal n={} dx={:.1} mm", s.n, s.dx * 1e3);
        for (f, zz, bw) in peaks(&fs, &m) {
            println!("  peak {:.0} Hz  {:.2} MPa·s/m³  BW {:.0} Hz", f, zz, bw);
        }
        return;
    }
    let geom = std::fs::read_to_string("../data/alto_sax.json").unwrap();
    sax_engine::sax_init(48000.0);
    unsafe { sax_engine::sax_load_geometry(geom.as_ptr(), geom.len() as u32) };
    for kv in args.iter().skip(1).filter(|a| a.contains('=')) {
        let (k, v) = kv.split_once('=').unwrap();
        sax_engine::sax_set_param(Param::by_name(k).unwrap() as u32, v.parse().unwrap());
    }
    if mode == "scan" {
        // best interior tract peak per band over a voicing grid
        let bands = [(500.0f64, 550.0f64), (550.0, 600.0), (600.0, 650.0), (650.0, 700.0), (700.0, 750.0), (750.0, 800.0), (900.0, 1400.0)];
        let (lo, hi) = (400.0f64, 1600.0f64);
        let n = 300u32;
        let fl: Vec<f64> = (0..n).map(|i| lo * (hi / lo).powf(i as f64 / (n - 1) as f64)).collect();
        let sgs: Vec<f32> = args.get(1).map(|s| vec![s.parse().unwrap()]).unwrap_or(vec![0.0, 1.0]);
        let extra: Vec<(String, f32)> = args.iter().skip(2).map(|kv| { let (k, v) = kv.split_once('=').unwrap(); (k.to_string(), v.parse().unwrap()) }).collect();
        for sg in sgs {
            let mut bmax = vec![(0.0f64, 0.0f64, String::new()); bands.len()];
            for ty in [0.0f32, 0.3, 0.6, 0.8, 0.9, 1.0] {
                for tx in [0.0f32, 0.25, 0.5, 0.75, 1.0] {
                    for tt in [0.0f32, 0.5, 1.0] {
                        for jaw in [0.0f32, 0.3, 0.7, 1.0] {
                            for gl in [0.0f32, 0.1, 0.3, 0.8] {
                                for (k, v) in [("subglottal", sg), ("tongue_y", ty), ("tongue_x", tx), ("tongue_tip", tt), ("jaw_open", jaw), ("glottis_open", gl), ("player_assist", 0.0)] {
                                    sax_engine::sax_set_param(Param::by_name(k).unwrap() as u32, v);
                                }
                                for (k, v) in extra.iter() {
                                    sax_engine::sax_set_param(Param::by_name(k).unwrap() as u32, *v);
                                }
                                let p = sax_engine::sax_compute_tract_impedance(n, lo as f32, hi as f32);
                                let z = unsafe { std::slice::from_raw_parts(p, 2 * n as usize) };
                                for i in 1..n as usize - 1 {
                                    if z[i] > z[i - 1] && z[i] >= z[i + 1] {
                                        for (b, &(a, c)) in bands.iter().enumerate() {
                                            if fl[i] >= a && fl[i] < c && z[i] as f64 > bmax[b].0 {
                                                bmax[b] = (z[i] as f64, fl[i], format!("ty={ty} tx={tx} tt={tt} jaw={jaw} gl={gl}"));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            println!("subglottal={sg}");
            for (b, &(a, c)) in bands.iter().enumerate() {
                println!("  {:4.0}–{:4.0} Hz: {:5.1} MPa at {:4.0} Hz ({})", a, c, bmax[b].0 / 1e6, bmax[b].1, bmax[b].2);
            }
        }
        return;
    }
    for on in [false, true] {
        sax_engine::sax_set_param(Param::Subglottal as u32, on as u8 as f32);
        let n = 600u32;
        let p = sax_engine::sax_compute_tract_impedance(n, 100.0, 3095.0);
        let z = unsafe { std::slice::from_raw_parts(p, 2 * n as usize) };
        let fl: Vec<f64> = (0..n).map(|i| 100.0 * (3095.0f64 / 100.0).powf(i as f64 / (n - 1) as f64)).collect();
        let m: Vec<f64> = z[..n as usize].iter().map(|&x| x as f64).collect();
        let pk = peaks(&fl, &m);
        print!("sub={} :", on as u8);
        for (f, zz, bw) in pk.iter().filter(|p| p.1 > 0.5) {
            print!("  {:.0} Hz {:.1} MPa (BW {:.0})", f, zz, bw);
        }
        println!();
    }
}
