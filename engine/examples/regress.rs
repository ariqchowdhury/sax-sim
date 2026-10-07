//! Performance-regression harness: renders a fixed, deterministic set of
//! scenarios (breath noise off) and either writes them as a golden set or
//! compares against one.
//!
//!   cargo run --release --example regress -- write <dir> [filter]
//!   cargo run --release --example regress -- check <dir> [filter]
//!
//! Two kinds of scenario:
//! * `lin_*` — blowing BELOW the oscillation threshold, with fingering, lung
//!   pressure and tonguing steps: every subsystem (reed, flow, tract, bore,
//!   tone holes incl. pad slews and joint clusters, radiation, decimator) runs,
//!   but the system is stable, so rounding differences stay at rounding level.
//!   Checked sample by sample: RMS relative error ‖a−b‖/‖b‖ < 1e-4 on the output
//!   and on the mouthpiece pressure.
//! * self-oscillating notes — the onset grows from rounding-level seeds, so any
//!   change in float rounding (FMA, reassociation) shifts the onset time and
//!   hence the phase of the limit cycle; sample-wise comparison is meaningless.
//!   Checked on the settled tail (last 0.6 s): playing frequency within
//!   0.1 cent, RMS within 0.5 %, harmonics 1–10 (those above −40 dB) within
//!   0.2 dB, for mouthpiece pressure and output.
//!
//! Exit code 1 if any scenario fails. Driven by `engine/perf/regress.sh`.

use sax_engine::engine::Engine;
use sax_engine::params::Param;
use sax_engine::telemetry::measure_f0;

const REL_TOL: f64 = 1e-4;
const CENT_TOL: f64 = 0.1;
const RMS_TOL: f64 = 0.005;
const HARM_DB_TOL: f64 = 0.2;

enum Ev {
    Fing(&'static str),
    Set(Param, f32),
}

struct Case {
    name: &'static str,
    os: u32,
    kpa: f32,
    seconds: f64,
    beam: bool,
    tract: bool,
    assist: f32,
    start: &'static str,
    events: Vec<(f64, Ev)>,
}

impl Case {
    fn linear(&self) -> bool {
        self.name.starts_with("lin_")
    }
}

fn cases() -> Vec<Case> {
    use Ev::*;
    // player_assist = 0 throughout: its register-locking integrator accumulates
    // while the note is still silent, so its final operating point depends on
    // the onset time (±1 ¢ for rounding-level changes) — pure physics only
    let c = |name, os, start, kpa| Case { name, os, kpa, seconds: 2.0, beam: false, tract: true, assist: 0.0, start, events: vec![] };
    let lin = |name, os, start| {
        let mut k = c(name, os, start, 1.2);
        k.assist = 0.0;
        k.seconds = 0.5;
        k.events = vec![
            (0.08, Set(Param::LungPressure, 0.6)),
            (0.12, Fing("Bb3")),
            (0.2, Set(Param::LungPressure, 1.5)),
            (0.22, Set(Param::TongueReedContact, 1.0)),
            (0.25, Fing("D6")),
            (0.3, Set(Param::TongueReedContact, 0.0)),
            (0.33, Set(Param::MouthpieceInsertion, 14.0)),
            (0.38, Fing("C#5")),
            (0.42, Set(Param::LungPressure, 0.3)),
        ];
        k
    };
    let mut v = vec![lin("lin_cs5_os4", 4, "C#5"), lin("lin_cs5_os8", 8, "C#5"), lin("lin_g4_os2", 2, "G4")];
    let mut lb = lin("lin_cs5_beam_os4", 4, "C#5");
    lb.beam = true;
    v.push(lb);
    let mut lt = lin("lin_e4_notract_os4", 4, "E4");
    lt.tract = false;
    v.push(lt);
    v.extend([
        c("cs5_os4", 4, "C#5", 4.0),
        c("g4_os4", 4, "G4", 4.0),
        c("cs5_os2", 2, "C#5", 4.0),
        c("cs5_os8", 8, "C#5", 4.0),
        c("d6_os4", 4, "D6", 5.0),
    ]);
    // (Bb3 is not used for tone checks: at 4 kPa it sits in a slowly modulated,
    // not strictly periodic regime whose tail depends on the onset history)
    v.push(c("d4_os4", 4, "D4", 4.0));
    v.push(c("e4_os4", 4, "E4", 4.0));
    let mut a = c("g4_notract_os4", 4, "G4", 4.0);
    a.tract = false;
    v.push(a);
    let mut b = c("cs5_beam_os4", 4, "C#5", 4.0);
    b.beam = true;
    b.seconds = 1.5;
    v.push(b);
    // fingering transitions (pad slews, cluster changes) + param ramps
    // (bore / tract / reed coefficient updates while playing)
    let mut t = c("legato_params_os4", 4, "Bb3", 4.0);
    t.seconds = 2.2;
    t.events = vec![
        (0.25, Fing("C#5")),
        (0.45, Set(Param::Temperature, 30.0)),
        (0.5, Fing("G4")),
        (0.6, Set(Param::MouthpieceInsertion, 14.0)),
        (0.7, Set(Param::TongueY, 0.7)),
        (0.75, Fing("E4")),
        (0.85, Set(Param::LipForce, 1.3)),
        (0.9, Fing("C#5")),
        (1.0, Set(Param::TongueReedContact, 1.0)),
        (1.05, Set(Param::TongueReedContact, 0.0)),
    ];
    v.push(t);
    v
}

fn geometry() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../data/alto_sax.json")).expect("data/alto_sax.json")
}

fn set_fingering(e: &mut Engine, note: &str) {
    let keys = e.inst.json.fingerings.iter().find(|f| f.note == note).unwrap_or_else(|| panic!("no fingering {note}")).keys.clone();
    e.release_all_keys();
    for k in &keys {
        assert!(e.set_key_by_name(k, 1.0), "unknown key {k}");
    }
}

fn render(c: &Case, geom: &str) -> (Vec<f32>, Vec<f32>) {
    let mut e = Engine::new(48000.0);
    e.load_geometry_json(geom).unwrap();
    e.use_tract = c.tract;
    e.set_param(Param::BreathNoise as u32, 0.0);
    e.set_param(Param::Oversample as u32, c.os as f32);
    e.set_param(Param::ReedModel as u32, if c.beam { 1.0 } else { 0.0 });
    e.set_param(Param::PlayerAssist as u32, c.assist);
    set_fingering(&mut e, c.start);
    e.snap_params();
    e.snap_pads();
    e.set_param(Param::LungPressure as u32, c.kpa);
    let total = (c.seconds * e.fs) as usize;
    let (mut out, mut pmp) = (Vec::with_capacity(total), Vec::with_capacity(total));
    let mut ev = 0;
    let mut done = 0;
    while done < total {
        let t = done as f64 / e.fs;
        while ev < c.events.len() && c.events[ev].0 <= t {
            match &c.events[ev].1 {
                Ev::Fing(f) => set_fingering(&mut e, f),
                Ev::Set(p, v) => e.set_param(*p as u32, *v),
            }
            ev += 1;
        }
        let n = 128.min(total - done);
        let y = e.process(n);
        out.extend_from_slice(y);
        pmp.extend_from_slice(&e.cap_pmp[..n]);
        done += n;
    }
    (out, pmp)
}

const FS: f64 = 48000.0;

/// Hann-windowed DFT magnitude of x at frequency f (Hz).
fn dft_mag(x: &[f64], f: f64) -> f64 {
    let n = x.len();
    let w = 2.0 * std::f64::consts::PI * f / FS;
    let (c, s) = (w.cos(), w.sin());
    let (mut cr, mut ci) = (1.0f64, 0.0f64);
    let (mut re, mut im) = (0.0, 0.0);
    for (k, v) in x.iter().enumerate() {
        let win = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / n as f64).cos();
        re += v * win * cr;
        im += v * win * ci;
        let t = cr * c - ci * s;
        ci = cr * s + ci * c;
        cr = t;
    }
    (re * re + im * im).sqrt() / n as f64
}

/// Precise playing frequency: coarse estimate refined to the windowed-DFT peak.
fn f0_precise(x: &[f64]) -> f64 {
    let f = measure_f0(x, FS);
    if !(f > 0.0) {
        return 0.0;
    }
    let mut lo = f * 0.99;
    let mut hi = f * 1.01;
    for _ in 0..4 {
        let k = 24;
        let mut best = (0, 0.0);
        let mags: Vec<f64> = (0..=k).map(|i| dft_mag(x, lo + (hi - lo) * i as f64 / k as f64)).collect();
        for (i, &m) in mags.iter().enumerate() {
            if m > best.1 {
                best = (i, m);
            }
        }
        let step = (hi - lo) / k as f64;
        let fc = lo + step * best.0 as f64;
        lo = fc - step;
        hi = fc + step;
    }
    0.5 * (lo + hi)
}

struct Tone {
    f0: f64,
    rms: f64,
    /// harmonic levels (dB) 1..=10
    harm: [f64; 10],
}

fn tone(x: &[f32], f0: f64) -> Tone {
    let x: Vec<f64> = x.iter().map(|&v| v as f64).collect();
    let mean = x.iter().sum::<f64>() / x.len() as f64;
    let x: Vec<f64> = x.iter().map(|v| v - mean).collect();
    let rms = (x.iter().map(|v| v * v).sum::<f64>() / x.len() as f64).sqrt();
    let mut harm = [f64::NEG_INFINITY; 10];
    if f0 > 0.0 {
        for (k, h) in harm.iter_mut().enumerate() {
            let f = f0 * (k + 1) as f64;
            if f < 0.45 * FS {
                *h = 20.0 * dft_mag(&x, f).max(1e-30).log10();
            }
        }
    }
    Tone { f0, rms, harm }
}

/// (Δf0 cents, ΔRMS rel, worst harmonic Δ dB)
fn compare_tone(a: &[f32], g: &[f32]) -> (f64, f64, f64) {
    let tail = (0.6 * FS) as usize;
    let at = &a[a.len().saturating_sub(tail)..];
    let gt = &g[g.len().saturating_sub(tail)..];
    let gf = f0_precise(&gt.iter().map(|&v| v as f64).collect::<Vec<_>>());
    let af = f0_precise(&at.iter().map(|&v| v as f64).collect::<Vec<_>>());
    let ta = tone(at, af);
    let tg = tone(gt, gf);
    let cents = if ta.f0 > 0.0 && tg.f0 > 0.0 {
        1200.0 * (ta.f0 / tg.f0).log2()
    } else if ta.f0 == tg.f0 {
        0.0
    } else {
        f64::INFINITY
    };
    let drms = (ta.rms - tg.rms).abs() / tg.rms.max(1e-30);
    let top = tg.harm.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mut dh: f64 = 0.0;
    for k in 0..10 {
        if tg.harm[k] > top - 40.0 {
            dh = dh.max((ta.harm[k] - tg.harm[k]).abs());
        }
    }
    (cents, drms, dh)
}

fn write_f32(path: &std::path::Path, x: &[f32]) {
    let b: Vec<u8> = x.iter().flat_map(|v| v.to_le_bytes()).collect();
    std::fs::write(path, b).unwrap();
}

fn read_f32(path: &std::path::Path) -> Vec<f32> {
    let b = std::fs::read(path).unwrap_or_else(|_| panic!("missing {}", path.display()));
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// (max|Δ|/peak, ‖Δ‖/‖ref‖)
fn errs(a: &[f32], r: &[f32]) -> (f64, f64) {
    let peak = r.iter().fold(0.0f64, |m, &v| m.max((v as f64).abs())).max(1e-30);
    let (mut md, mut s2, mut r2) = (0.0f64, 0.0f64, 0.0f64);
    for (&x, &y) in a.iter().zip(r) {
        let d = x as f64 - y as f64;
        md = md.max(d.abs());
        s2 += d * d;
        r2 += (y as f64).powi(2);
    }
    if a.len() != r.len() {
        return (f64::INFINITY, f64::INFINITY);
    }
    (md / peak, (s2 / r2.max(1e-300)).sqrt())
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("usage: regress write|check <dir> [case-filter]");
        std::process::exit(2);
    }
    let dir = std::path::PathBuf::from(&a[2]);
    let filt = a.get(3).cloned().unwrap_or_default();
    let geom = geometry();
    std::fs::create_dir_all(&dir).unwrap();
    let all = cases();
    let sel: Vec<&Case> = all.iter().filter(|c| c.name.contains(&filt)).collect();
    // render all scenarios in parallel
    let res: Vec<_> = std::thread::scope(|s| {
        let hs: Vec<_> = sel.iter().map(|c| s.spawn(|| render(c, &geom))).collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut fail = false;
    for (c, (out, pmp)) in sel.iter().zip(res) {
        match a[1].as_str() {
            "write" => {
                write_f32(&dir.join(format!("{}.out.f32", c.name)), &out);
                write_f32(&dir.join(format!("{}.pmp.f32", c.name)), &pmp);
                let tail: Vec<f64> = pmp[pmp.len().saturating_sub(FS as usize)..].iter().map(|&v| v as f64).collect();
                println!("{:22} f0={:8.3} Hz  written", c.name, if c.linear() { 0.0 } else { f0_precise(&tail) });
            }
            "check" => {
                let go = read_f32(&dir.join(format!("{}.out.f32", c.name)));
                let gp = read_f32(&dir.join(format!("{}.pmp.f32", c.name)));
                if c.linear() {
                    let (om, or) = errs(&out, &go);
                    let (pm, pr) = errs(&pmp, &gp);
                    let ok = or < REL_TOL && pr < REL_TOL;
                    fail |= !ok;
                    println!(
                        "{:22} [waveform]  out: max={:.2e} rel={:.2e}  pmp: max={:.2e} rel={:.2e}  {}",
                        c.name,
                        om,
                        or,
                        pm,
                        pr,
                        if ok { "OK" } else { "FAIL" }
                    );
                } else {
                    let (pc, pr, ph) = compare_tone(&pmp, &gp);
                    let (oc, or, oh) = compare_tone(&out, &go);
                    let ok = pc.abs() < CENT_TOL && oc.abs() < CENT_TOL && pr < RMS_TOL && or < RMS_TOL && ph < HARM_DB_TOL && oh < HARM_DB_TOL;
                    fail |= !ok;
                    let gt: Vec<f64> = gp[gp.len() - FS as usize..].iter().map(|&v| v as f64).collect();
                    println!(
                        "{:22} [tone {:7.2} Hz]  pmp: Δf0={:+.4}¢ ΔRMS={:.1e} Δharm={:.3}dB  out: Δf0={:+.4}¢ ΔRMS={:.1e} Δharm={:.3}dB  {}",
                        c.name,
                        f0_precise(&gt),
                        pc,
                        pr,
                        ph,
                        oc,
                        or,
                        oh,
                        if ok { "OK" } else { "FAIL" }
                    );
                }
            }
            m => panic!("unknown mode {m}"),
        }
    }
    if fail {
        std::process::exit(1);
    }
}
