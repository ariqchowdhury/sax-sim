//! Native offline renderer & validation driver.
//!
//!   render --fingering Bb3 --pressure 4.0 --seconds 2 --out /tmp/x.wav --csv /tmp/x.csv
//!          [--set name=value]... [--keys LH1,LH2,...] [--geometry path] [--no-tract]
//!   render --table [--pressure 4] [--seconds 1.5]      pitch of every fingering vs target
//!   render --search                                    per fingering: first embouchure (pressure, lip force)
//!                                                      from a fixed list that sounds the written note
//!   render --threshold [--fingering Bb3]              oscillation threshold (kPa)
//!   render --peaks                                     linear input-impedance peak near each target (no reed)
//!   render ... --tongue-release 0.3                    tongued attack: tongue on reed, released at t
//!   render --bench                                     µs per 128-sample block per oversampling

use sax_engine::engine::Engine;
use sax_engine::params::{Param, PARAM_DEFS};
use sax_engine::telemetry::measure_f0;
use std::io::Write;

struct Opts {
    fingering: Option<String>,
    keys: Vec<String>,
    pressure: f64,
    seconds: f64,
    out: Option<String>,
    csv: Option<String>,
    sets: Vec<(String, f32)>,
    geometry: Option<String>,
    no_tract: bool,
    mode: String,
    fs: f32,
    /// seconds over which the lung-pressure target ramps from 0 (player's crescendo attack)
    attack: f64,
    /// tongued attack: tongue on the reed from t = 0, released at this time (s)
    tongue_release: f64,
    quiet: bool,
}

fn parse_args() -> Opts {
    let mut o = Opts {
        fingering: None,
        keys: vec![],
        pressure: 4.0,
        seconds: 2.0,
        out: None,
        csv: None,
        sets: vec![],
        geometry: None,
        no_tract: false,
        mode: "render".into(),
        fs: 48000.0,
        attack: 0.0,
        tongue_release: 0.0,
        quiet: false,
    };
    let a: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < a.len() {
        let next = |i: &mut usize| -> String {
            *i += 1;
            a.get(*i).cloned().unwrap_or_else(|| panic!("missing value for {}", a[*i - 1]))
        };
        match a[i].as_str() {
            "--fingering" | "-f" => o.fingering = Some(next(&mut i)),
            "--keys" => o.keys = next(&mut i).split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
            "--pressure" | "-p" => o.pressure = next(&mut i).parse().expect("pressure"),
            "--seconds" | "-s" => o.seconds = next(&mut i).parse().expect("seconds"),
            "--out" | "-o" => o.out = Some(next(&mut i)),
            "--csv" => o.csv = Some(next(&mut i)),
            "--geometry" | "-g" => o.geometry = Some(next(&mut i)),
            "--fs" => o.fs = next(&mut i).parse().expect("fs"),
            "--attack" => o.attack = next(&mut i).parse().expect("attack"),
            "--tongue-release" => o.tongue_release = next(&mut i).parse().expect("tongue release time"),
            "--set" => {
                let s = next(&mut i);
                let (k, v) = s.split_once('=').expect("--set name=value");
                o.sets.push((k.to_string(), v.parse().expect("value")));
            }
            "--os" => {
                let v = next(&mut i);
                o.sets.push(("oversample".into(), v.parse().expect("os")));
            }
            "--no-tract" => o.no_tract = true,
            "--table" => o.mode = "table".into(),
            "--search" => o.mode = "search".into(),
            "--threshold" => o.mode = "threshold".into(),
            "--bench" => o.mode = "bench".into(),
            "--peaks" => o.mode = "peaks".into(),
            "--quiet" | "-q" => o.quiet = true,
            "--help" | "-h" => {
                println!("{}", include_str!("render.rs").lines().take(9).collect::<Vec<_>>().join("\n"));
                std::process::exit(0);
            }
            x => panic!("unknown argument {x}"),
        }
        i += 1;
    }
    o
}

fn load_geometry_text(o: &Opts) -> String {
    let candidates = match &o.geometry {
        Some(p) => vec![p.clone()],
        None => vec![
            "data/alto_sax.json".into(),
            "../data/alto_sax.json".into(),
            concat!(env!("CARGO_MANIFEST_DIR"), "/../data/alto_sax.json").into(),
        ],
    };
    for c in &candidates {
        if let Ok(s) = std::fs::read_to_string(c) {
            return s;
        }
    }
    panic!("geometry not found in {:?}", candidates);
}

fn make_engine(o: &Opts, geom: &str) -> Engine {
    let mut e = Engine::new(o.fs);
    e.load_geometry_json(geom).expect("geometry");
    e.use_tract = !o.no_tract;
    if let Ok(v) = std::env::var("SAX_LOSS") {
        e.bore_loss_mult = v.parse().expect("SAX_LOSS");
    }
    if let Ok(v) = std::env::var("SAX_LCH") {
        e.channel_inertia_len = v.parse().expect("SAX_LCH");
    }
    if let Ok(v) = std::env::var("SAX_VC") {
        e.vena_contracta = v.parse().expect("SAX_VC");
    }
    if let Ok(v) = std::env::var("SAX_THERMAL_R") {
        e.thermal_radius = v.parse().expect("SAX_THERMAL_R");
    }
    for (k, v) in &o.sets {
        let p = Param::by_name(k).unwrap_or_else(|| panic!("unknown param {k}"));
        e.set_param(p as u32, *v);
    }
    e
}

fn fingering_keys(e: &Engine, name: &str) -> Vec<String> {
    let f = e
        .inst
        .json
        .fingerings
        .iter()
        .chain(std::iter::empty())
        .find(|f| f.note == name)
        .unwrap_or_else(|| panic!("fingering {name} not in geometry"));
    f.keys.clone()
}

fn apply_keys(e: &mut Engine, keys: &[String]) {
    e.release_all_keys();
    for k in keys {
        if !e.set_key_by_name(k, 1.0) {
            panic!("unknown key {k}");
        }
    }
}

struct Run {
    out: Vec<f32>,
    pmp: Vec<f64>,
    rows: Vec<[f32; 8]>,
}

/// Render `seconds` with lung pressure `kpa` set at t=0 (engine settles params first).
fn run(e: &mut Engine, kpa: f64, seconds: f64, record_rows: bool) -> Run {
    e.set_param(Param::LungPressure as u32, kpa as f32);
    let n_total = (seconds * e.fs) as usize;
    let mut r = Run { out: Vec::with_capacity(n_total), pmp: Vec::with_capacity(n_total), rows: vec![] };
    let block = 128;
    let mut done = 0;
    while done < n_total {
        let n = block.min(n_total - done);
        let buf = e.process(n).to_vec();
        r.out.extend_from_slice(&buf);
        // per-block scalar of mouthpiece pressure is not enough: grab the scope? use per-sample via single steps
        done += n;
        let _ = record_rows;
    }
    r
}

static ATTACK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TONGUE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Render in 128-sample blocks, capturing per-sample mouthpiece pressure & telemetry.
/// The lung-pressure target ramps linearly from 0 over the `--attack` time.
fn run_detailed(e: &mut Engine, kpa: f64, seconds: f64, record_rows: bool) -> Run {
    let attack = f64::from_bits(ATTACK.load(std::sync::atomic::Ordering::Relaxed));
    run_attack(e, kpa, seconds, record_rows, attack)
}

fn run_attack(e: &mut Engine, kpa: f64, seconds: f64, record_rows: bool, attack: f64) -> Run {
    e.set_param(Param::LungPressure as u32, if attack > 0.0 { 0.0 } else { kpa as f32 });
    let n_total = (seconds * e.fs) as usize;
    let mut r = Run { out: Vec::with_capacity(n_total), pmp: Vec::with_capacity(n_total), rows: vec![] };
    let mut done = 0;
    let tongue = f64::from_bits(TONGUE.load(std::sync::atomic::Ordering::Relaxed));
    if tongue > 0.0 {
        e.set_param(Param::TongueReedContact as u32, 1.0);
    }
    while done < n_total {
        let n = 128.min(n_total - done);
        if tongue > 0.0 && done as f64 / e.fs >= tongue {
            e.set_param(Param::TongueReedContact as u32, 0.0);
        }
        if attack > 0.0 {
            let t = done as f64 / e.fs;
            e.set_param(Param::LungPressure as u32, (kpa * (t / attack).min(1.0)) as f32);
        }
        let y = e.process(n).to_vec();
        for k in 0..n {
            r.out.push(y[k]);
            r.pmp.push(e.cap_pmp[k] as f64);
            if record_rows {
                r.rows.push([
                    (done + k) as f32 / e.fs as f32,
                    y[k],
                    e.lung_pressure() as f32,
                    e.cap_pm[k],
                    e.cap_pmp[k],
                    e.cap_y[k],
                    e.cap_u[k],
                    e.pitch_hz() as f32,
                ]);
            }
        }
        done += n;
    }
    r
}

fn write_wav(path: &str, x: &[f32], fs: u32) {
    let mut f = std::fs::File::create(path).expect("wav create");
    let data_len = (x.len() * 4) as u32;
    let mut h = Vec::new();
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data_len).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&fs.to_le_bytes());
    h.extend_from_slice(&(fs * 4).to_le_bytes());
    h.extend_from_slice(&4u16.to_le_bytes());
    h.extend_from_slice(&32u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_len.to_le_bytes());
    f.write_all(&h).unwrap();
    let mut b = Vec::with_capacity(x.len() * 4);
    for v in x {
        b.extend_from_slice(&v.to_le_bytes());
    }
    f.write_all(&b).unwrap();
}

fn ac_rms(x: &[f64]) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    let m = x.iter().sum::<f64>() / x.len() as f64;
    (x.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / x.len() as f64).sqrt()
}

fn cents(f: f64, target: f64) -> f64 {
    1200.0 * (f / target).log2()
}

fn main() {
    let o = parse_args();
    ATTACK.store(o.attack.to_bits(), std::sync::atomic::Ordering::Relaxed);
    TONGUE.store(o.tongue_release.to_bits(), std::sync::atomic::Ordering::Relaxed);
    let geom = load_geometry_text(&o);
    match o.mode.as_str() {
        "bench" => bench(&o, &geom),
        "table" => table(&o, &geom),
        "threshold" => threshold(&o, &geom),
        "peaks" => peaks(&o, &geom),
        "search" => search(&o, &geom),
        _ => render(&o, &geom),
    }
}

fn setup_keys(e: &mut Engine, o: &Opts) {
    let keys = if !o.keys.is_empty() {
        o.keys.clone()
    } else if let Some(f) = &o.fingering {
        fingering_keys(e, f)
    } else {
        vec![]
    };
    apply_keys(e, &keys);
    e.snap_params();
    e.snap_pads();
}

fn render(o: &Opts, geom: &str) {
    let mut e = make_engine(o, geom);
    setup_keys(&mut e, o);
    let t0 = std::time::Instant::now();
    let r = run_detailed(&mut e, o.pressure, o.seconds, o.csv.is_some());
    let el = t0.elapsed().as_secs_f64();
    let n = r.pmp.len();
    let tail = &r.pmp[n.saturating_sub((0.5 * e.fs) as usize)..];
    let f0 = measure_f0(tail, e.fs);
    let target = o.fingering.as_ref().and_then(|f| e.inst.json.fingerings.iter().find(|x| &x.note == f)).and_then(|f| f.f_target);
    println!(
        "fingering={} pressure={} kPa os={} f0={:.2} Hz{} mp_rms={:.0} Pa out_rms={:.4} resets={} render_time={:.3}s ({:.1}x realtime incl. telemetry)",
        o.fingering.clone().unwrap_or_else(|| o.keys.join("+")),
        o.pressure,
        e.os,
        f0,
        target.map(|t| format!(" target={:.2} ({:+.1} cents)", t, cents(f0, t))).unwrap_or_default(),
        ac_rms(tail),
        (r.out.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / r.out.len().max(1) as f64).sqrt(),
        e.resets,
        el,
        o.seconds / el
    );
    if let Some(p) = &o.out {
        write_wav(p, &r.out, e.fs as u32);
    }
    if let Some(p) = &o.csv {
        let mut f = std::io::BufWriter::new(std::fs::File::create(p).unwrap());
        writeln!(f, "t,out,p_lung,p_mouth,p_mouthpiece,reed_y,flow,f0_est").unwrap();
        for row in &r.rows {
            writeln!(f, "{:.6},{:.6},{:.2},{:.2},{:.2},{:.4e},{:.4e},{:.2}", row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]).unwrap();
        }
    }
}

fn table(o: &Opts, geom: &str) {
    let e0 = make_engine(o, geom);
    let fings: Vec<_> = e0.inst.json.fingerings.clone();
    let results: Vec<(String, f64, f64, f64, u32)> = std::thread::scope(|sc| {
        let hs: Vec<_> = fings
            .iter()
            .map(|f| {
                let geom = geom.to_string();
                sc.spawn(move || {
                    let mut e = make_engine(o, &geom);
                    apply_keys(&mut e, &f.keys);
                    e.snap_params();
                    e.snap_pads();
                    let r = run_detailed(&mut e, o.pressure, o.seconds, false);
                    let n = r.pmp.len();
                    let tail = &r.pmp[n.saturating_sub((0.5 * e.fs) as usize)..];
                    let f0 = if ac_rms(tail) > 50.0 { measure_f0(tail, e.fs) } else { 0.0 };
                    (f.note.clone(), f.f_target.unwrap_or(0.0), f0, ac_rms(tail), e.resets)
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    println!("{:<6} {:>9} {:>9} {:>8} {:>8} {:>7}", "note", "target", "f0", "cents", "mp_rms", "ratio");
    for (note, t, f0, rms, resets) in &results {
        let c = if *f0 > 0.0 && *t > 0.0 { cents(*f0, *t) } else { f64::NAN };
        // detect register jumps: nearest harmonic ratio
        let ratio = if *t > 0.0 && *f0 > 0.0 { f0 / t } else { 0.0 };
        println!("{:<6} {:>9.2} {:>9.2} {:>+8.1} {:>8.0} {:>7.3}{}", note, t, f0, c, rms, ratio, if *resets > 0 { " RESET" } else { "" });
    }
}

fn oscillates(o: &Opts, geom: &str, keys: &[String], kpa: f64, secs: f64) -> (bool, f64) {
    let mut e = make_engine(o, geom);
    apply_keys(&mut e, keys);
    e.snap_params();
    e.snap_pads();
    let r = run_detailed(&mut e, kpa, secs, false);
    let n = r.pmp.len();
    let tail = &r.pmp[n - (0.2 * e.fs) as usize..];
    let rms = ac_rms(tail);
    (rms > (0.05 * kpa * 1000.0).max(50.0), rms)
}

fn threshold(o: &Opts, geom: &str) {
    let e0 = make_engine(o, geom);
    let keys = if !o.keys.is_empty() { o.keys.clone() } else { fingering_keys(&e0, o.fingering.as_deref().unwrap_or("Bb3")) };
    drop(e0);
    // onset threshold: bisection on constant pressure from rest
    let (mut lo, mut hi) = (0.05, 10.0);
    if !oscillates(o, geom, &keys, hi, o.seconds.max(1.5)).0 {
        println!("no oscillation even at 10 kPa");
        return;
    }
    for _ in 0..12 {
        let mid = 0.5 * (lo + hi);
        if oscillates(o, geom, &keys, mid, o.seconds.max(1.5)).0 {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    println!("onset threshold ({}): {:.3} kPa", o.fingering.as_deref().unwrap_or("Bb3"), hi);
    // extinction: play at 1.5×threshold then ramp down slowly
    let mut e = make_engine(o, geom);
    apply_keys(&mut e, &keys);
    e.snap_params();
    e.snap_pads();
    let _ = run(&mut e, hi * 1.5, 1.0, false);
    let mut p = hi * 1.5;
    let mut ext = 0.0;
    while p > 0.05 {
        p -= 0.025;
        let r = run_detailed(&mut e, p, 0.1, false);
        let rms = ac_rms(&r.pmp);
        if rms < (0.05 * hi * 1000.0).max(50.0) {
            ext = p;
            break;
        }
    }
    println!("extinction (slow decrescendo): {:.3} kPa", ext);
    for &kpa in &[0.0, lo * 0.8, hi * 1.2, 10.0] {
        let (osc, rms) = oscillates(o, geom, &keys, kpa, 1.0);
        println!("  p={:.2} kPa → oscillating={} mp_rms={:.0} Pa", kpa, osc, rms);
    }
}

#[repr(C)]
struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}
extern "C" {
    fn clock_gettime(clk: i32, tp: *mut Timespec) -> i32;
}
/// Per-thread CPU time (s): robust against other processes loading the machine.
fn thread_cpu_s() -> f64 {
    #[cfg(target_os = "macos")]
    const CLOCK_THREAD_CPUTIME_ID: i32 = 16;
    #[cfg(not(target_os = "macos"))]
    const CLOCK_THREAD_CPUTIME_ID: i32 = 3;
    let mut t = Timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe {
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &mut t);
    }
    t.tv_sec as f64 + 1e-9 * t.tv_nsec as f64
}

fn bench(o: &Opts, geom: &str) {
    for os in [1u32, 2, 4, 8] {
        let mut e = make_engine(o, geom);
        e.set_param(Param::Oversample as u32, os as f32);
        let keys = fingering_keys(&e, o.fingering.as_deref().unwrap_or("Bb3"));
        apply_keys(&mut e, &keys);
        e.snap_params();
        e.snap_pads();
        e.set_param(Param::LungPressure as u32, o.pressure as f32);
        // warm up 0.5 s
        for _ in 0..(0.5 * e.fs as f64 / 128.0) as usize {
            e.process(128);
        }
        // best of 5 one-second trials, thread CPU time (robust to other load)
        let blocks = (1.0 * e.fs as f64 / 128.0) as usize;
        let mut el = f64::MAX;
        for _ in 0..5 {
            let t0 = thread_cpu_s();
            for _ in 0..blocks {
                e.process(128);
            }
            el = el.min(thread_cpu_s() - t0);
        }
        let us = el * 1e6 / blocks as f64;
        let budget = 128.0 / e.fs as f64 * 1e6;
        println!(
            "os={} bore_nodes={} tract_nodes={} : {:.1} µs / 128-sample block  ({:.1}x realtime, {:.1}% of one core)",
            os,
            e.bore.n,
            e.tract.tube.n,
            us,
            budget / us,
            100.0 * us / budget
        );
    }
    let _ = PARAM_DEFS.len();
}

/// |Z_in(f)| of the engine's air column from its impulse response (Goertzel sum).
fn z_mag(ir: &[f64], fs: f64, f: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * f / fs;
    let (c, s) = (w.cos(), w.sin());
    let (mut cr, mut ci) = (1.0f64, 0.0f64);
    let (mut re, mut im) = (0.0, 0.0);
    for v in ir {
        re += v * cr;
        im -= v * ci;
        let t = cr * c - ci * s;
        ci = cr * s + ci * c;
        cr = t;
    }
    (re * re + im * im).sqrt() / fs
}

fn peaks(o: &Opts, geom: &str) {
    let e0 = make_engine(o, geom);
    let fings: Vec<_> = e0.inst.json.fingerings.clone();
    let res: Vec<(String, f64, f64, f64)> = std::thread::scope(|sc| {
        let hs: Vec<_> = fings
            .iter()
            .map(|f| {
                sc.spawn(move || {
                    let mut e = make_engine(o, geom);
                    apply_keys(&mut e, &f.keys);
                    e.snap_params();
                    e.snap_pads();
                    let fs = e.fs * e.os as f64;
                    let ir = e.impulse_response((0.6 * fs) as usize);
                    let t = f.f_target.unwrap_or(440.0);
                    let (mut best, mut bf) = (0.0, 0.0);
                    let mut fr = t * 2f64.powf(-350.0 / 1200.0);
                    while fr < t * 2f64.powf(350.0 / 1200.0) {
                        let m = z_mag(&ir, fs, fr);
                        if m > best {
                            best = m;
                            bf = fr;
                        }
                        fr *= 2f64.powf(1.0 / 1200.0);
                    }
                    (f.note.clone(), t, bf, best / 1e6)
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    println!("{:<6} {:>8} {:>9} {:>7} {:>8}", "note", "target", "peak_Hz", "cents", "|Z|MPa");
    for (n, t, f, z) in res {
        println!("{:<6} {:>8.2} {:>9.2} {:>+7.1} {:>8.1}", n, t, f, cents(f, t), z);
    }
}

/// Emulates a player adapting the embouchure: for each fingering try a fixed,
/// ordered list of (lung pressure, lip force) and keep the first that sounds the
/// intended note (within ±100 cents). Also reports the default-embouchure result.
fn search(o: &Opts, geom: &str) {
    let e0 = make_engine(o, geom);
    let fings: Vec<_> = e0.inst.json.fingerings.clone();
    // (lung kPa, lip force N, attack s) in order of preference
    // (lung kPa, lip force N, attack s, voiced = high-front tongue "altissimo" tract)
    let mut cands: Vec<(f64, f32, f64, bool)> = vec![];
    for &voiced in &[false, true] {
        for &lf in &[1.0f32, 0.6, 1.4, 1.8, 0.3] {
            for &att in &[0.0, 0.3] {
                for &p in &[3.0, 3.5, 2.6, 4.2, 5.0, 2.3, 6.0] {
                    cands.push((p, lf, att, voiced));
                }
            }
        }
    }
    let res: Vec<(String, f64, f64, f64, f32, f64, bool)> = std::thread::scope(|sc| {
        let hs: Vec<_> = fings
            .iter()
            .map(|f| {
                let cands = &cands;
                sc.spawn(move || {
                    let t = f.f_target.unwrap_or(440.0);
                    let play = |p: f64, lf: f32, att: f64, voiced: bool| -> f64 {
                        let mut e = make_engine(o, geom);
                        e.set_param(Param::LipForce as u32, lf);
                        if voiced {
                            e.set_param(Param::TongueY as u32, 0.7);
                            e.set_param(Param::TongueX as u32, 0.2);
                        }
                        apply_keys(&mut e, &f.keys);
                        e.snap_params();
                        e.snap_pads();
                        let r = run_attack(&mut e, p, o.seconds, false, att);
                        let n = r.pmp.len();
                        let tail = &r.pmp[n.saturating_sub((0.5 * e.fs) as usize)..];
                        if ac_rms(tail) > 50.0 && e.resets == 0 {
                            measure_f0(tail, e.fs)
                        } else {
                            0.0
                        }
                    };
                    let f_def = play(o.pressure, 1.0, 0.0, false);
                    for &(p, lf, att, v) in cands.iter() {
                        let f0 = play(p, lf, att, v);
                        if f0 > 0.0 && cents(f0, t).abs() < 100.0 {
                            return (f.note.clone(), t, f_def, p, lf, f0, v);
                        }
                    }
                    (f.note.clone(), t, f_def, 0.0, 0.0, 0.0, false)
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    println!("{:<6} {:>8} | {:>8} {:>8} | {:>5} {:>4} {:>8} {:>7}", "note", "target", "f0@def", "cents", "kPa", "lipN", "f0", "cents");
    let mut worst: f64 = 0.0;
    for (n, t, fd, p, lf, f0, v) in res {
        let cd = if fd > 0.0 { cents(fd, t) } else { f64::NAN };
        if f0 > 0.0 {
            worst = worst.max(cents(f0, t).abs());
            println!("{:<6} {:>8.2} | {:>8.2} {:>+8.1} | {:>5.1} {:>4.1} {:>8.2} {:>+7.1}{}", n, t, fd, cd, p, lf, f0, cents(f0, t), if v { " voiced" } else { "" });
        } else {
            println!("{:<6} {:>8.2} | {:>8.2} {:>+8.1} |   (no embouchure in the list sounds this note)", n, t, fd, cd);
        }
    }
    println!("worst |cents| among notes that sound: {:.1}", worst);
}
