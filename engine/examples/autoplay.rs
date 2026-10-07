// Auto-player validation: every standard fingering × pp/mf/ff → in register / in tune.
//   autoplay [name=value ...]        (params applied to every render; e.g. auto_player=1)
//   env NOTES=Bb3,C4 restricts the notes, DYNS=0.15,0.5,0.9, AP_SECONDS=1.5, VERBOSE=1
use sax_engine::analysis::{analyze, idx};
use sax_engine::engine::Engine;
use sax_engine::params::Param;

fn main() {
    let geom = std::fs::read_to_string("../data/alto_sax.json").unwrap();
    let sets: Vec<(Param, f32)> = std::env::args().skip(1).map(|kv| { let (k, v) = kv.split_once('=').unwrap(); (Param::by_name(k).unwrap_or_else(|| panic!("param {k}")), v.parse().unwrap()) }).collect();
    let sr = 48000.0f64;
    let secs: f64 = std::env::var("AP_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(1.5);
    let dyns: Vec<f32> = std::env::var("DYNS").ok().map(|s| s.split(',').map(|x| x.parse().unwrap()).collect()).unwrap_or(vec![0.15, 0.5, 0.9]);
    let probe = Engine::new(48000.0);
    let mut e0 = probe;
    e0.load_geometry_json(&geom).unwrap();
    let mut notes: Vec<(String, f64)> = e0.inst.json.fingerings.iter().map(|f| (f.note.clone(), f.f_target.unwrap())).collect();
    if let Ok(n) = std::env::var("NOTES") { let want: Vec<&str> = n.split(',').collect(); notes.retain(|x| want.contains(&x.0.as_str())); }
    let jobs: Vec<(String, f64, f32)> = notes.iter().flat_map(|(n, f)| dyns.iter().map(move |d| (n.clone(), *f, *d))).collect();
    let res = std::sync::Mutex::new(vec![]);
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..8 {
            s.spawn(|| loop {
                let j = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if j >= jobs.len() { break; }
                let (n, ft, d) = &jobs[j];
                let mut e = Engine::new(sr as f32);
                e.load_geometry_json(&geom).unwrap();
                let f = e.inst.json.fingerings.iter().find(|f| &f.note == n).unwrap().clone();
                for k in &f.keys { e.set_key_by_name(k, 1.0); }
                e.set_param(Param::BreathNoise as u32, 0.0);
                e.set_param(Param::Dynamic as u32, *d);
                e.set_param(Param::LungPressure as u32, 3.5);
                for (p, v) in &sets { e.set_param(*p as u32, *v); }
                e.snap_params(); e.snap_pads();
                if std::env::var("NORESET").is_err() { e.reset_offline(); }
                // the breath starts after the setup (lungs rise with their own dynamics, as played)
                if std::env::var("SNAP_AIR").is_err() { e.set_param(Param::LungPressure as u32, 0.0); e.snap_params(); e.reset_offline(); e.set_param(Param::LungPressure as u32, sets.iter().find(|s| s.0 == Param::LungPressure).map(|s| s.1).unwrap_or(3.5)); }
                let mut x = vec![];
                for _ in 0..(secs * sr / 128.0) as usize { x.extend_from_slice(e.process(128)); }
                let tail = &x[x.len() / 2..];
                let fv = analyze(tail, sr as f32, *ft as f32);
                let f0 = if fv[idx::VALID] > 0.0 { fv[idx::F0] as f64 } else { 0.0 };
                let c = if f0 > 0.0 { 1200.0 * (f0 / ft).log2() } else { f64::NAN };
                res.lock().unwrap().push((n.clone(), *d, c, fv[idx::LEVEL] as f64));
            });
        }
    });
    let mut r = res.into_inner().unwrap();
    let order: Vec<String> = notes.iter().map(|n| n.0.clone()).collect();
    r.sort_by(|a, b| (order.iter().position(|x| *x == a.0), (a.1 * 100.0) as i32).cmp(&(order.iter().position(|x| *x == b.0), (b.1 * 100.0) as i32)));
    let (mut inreg, mut intune, mut tot) = (0, 0, 0);
    let mut fails = vec![];
    let mut lv = std::collections::BTreeMap::<i32, Vec<f64>>::new();
    for (n, d, c, l) in &r {
        tot += 1;
        if c.abs() < 100.0 { inreg += 1; lv.entry((*d * 100.0) as i32).or_default().push(*l); } else { fails.push(format!("{n}@{d}:{}", if c.is_nan() { "silent".into() } else { format!("{c:+.0}c") })); }
        if c.abs() < 25.0 { intune += 1; }
        if std::env::var("VERBOSE").is_ok() { println!("{n:5} dyn {d:.2}  {c:+7.1} c  level {l:6.1} dB"); }
    }
    let mut cs: Vec<f64> = r.iter().filter(|x| x.2.abs() < 100.0).map(|x| x.2.abs()).collect();
    cs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("in register (±100 c): {inreg}/{tot} ({:.1} %)   in tune (±25 c): {intune}/{tot}   |cents| median {:.1} p90 {:.1}", 100.0 * inreg as f64 / tot as f64, cs.get(cs.len() / 2).unwrap_or(&0.0), cs.get(cs.len() * 9 / 10).unwrap_or(&0.0));
    for (d, v) in &lv { println!("  dyn {:.2}: mean level {:.1} dB", *d as f64 / 100.0, v.iter().sum::<f64>() / v.len() as f64); }
    if !fails.is_empty() { println!("  fails: {}", fails.join(" ")); }
}
