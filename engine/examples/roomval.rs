// Validation of the blind room estimate (analysis::room) and of feature robustness:
// synthetic rooms (direct + exponential noise tail, RT60, DRR), additive noise,
// tongued vs faded releases.
use sax_engine::analysis::{self, fft, idx};
use sax_engine::engine::Engine;
use sax_engine::params::Param;

fn conv(x: &[f32], h: &[f64]) -> Vec<f32> {
    let n = x.len() + h.len();
    let mut nf = 1;
    while nf < n { nf <<= 1; }
    let (mut ar, mut ai) = (vec![0.0; nf], vec![0.0; nf]);
    let (mut br, mut bi) = (vec![0.0; nf], vec![0.0; nf]);
    for (i, v) in x.iter().enumerate() { ar[i] = *v as f64; }
    br[..h.len()].copy_from_slice(h);
    fft(&mut ar, &mut ai); fft(&mut br, &mut bi);
    for k in 0..nf { let (r, i) = (ar[k] * br[k] - ai[k] * bi[k], ar[k] * bi[k] + ai[k] * br[k]); ar[k] = r; ai[k] = -i; }
    fft(&mut ar, &mut ai);
    (0..x.len()).map(|i| (ar[i] / nf as f64) as f32).collect()
}
fn rng(r: &mut u64) -> f64 { *r ^= *r << 13; *r ^= *r >> 7; *r ^= *r << 17; (*r >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0 }
fn room_ir(sr: f64, rt60: f64, drr_db: f64, seed: u64) -> Vec<f64> {
    let n = (rt60 * 1.3 * sr) as usize + 10;
    let mut h = vec![0.0; n];
    h[0] = 1.0;
    let mut r = seed | 1;
    let tau = rt60 / 6.91;
    let pre = (0.004 * sr) as usize;
    let mut e = 0.0;
    for i in pre..n { let v = rng(&mut r) * (-(i as f64 / sr) / tau).exp(); h[i] = v; e += v * v; }
    let g = (10f64.powf(-drr_db / 10.0) / e).sqrt();
    for v in h.iter_mut().skip(pre) { *v *= g; }
    h
}

fn main() {
    let geom = std::fs::read_to_string("../data/alto_sax.json").unwrap();
    let sr = 48000.0;
    let notes = ["D4", "G4", "C5", "G5"];
    // one test "recording" per release style: notes of 2 s + 1.2 s silence
    let mut recs = vec![];
    let mut dry_feats = vec![];
    for tongued in [true, false] {
        let mut rec: Vec<f32> = vec![0.0; (0.5 * sr) as usize];
        let mut feats = vec![];
        for n in notes {
            let mut e = Engine::new(sr as f32);
            e.load_geometry_json(&geom).unwrap();
            let f = e.inst.json.fingerings.iter().find(|f| f.note == n).unwrap().clone();
            for k in &f.keys { e.set_key_by_name(k, 1.0); }
            e.snap_params(); e.snap_pads();
            e.set_param(Param::LungPressure as u32, 3.5);
            let mut x: Vec<f32> = vec![];
            let blocks = (3.2 * sr / 128.0) as usize;
            for b in 0..blocks {
                let t = b as f64 * 128.0 / sr;
                if t >= 2.0 {
                    if tongued { e.set_param(Param::TongueReedContact as u32, 1.0); e.set_param(Param::LungPressure as u32, 0.0); }
                    else { e.set_param(Param::LungPressure as u32, (3.5 * (1.0 - (t - 2.0) / 0.6)).max(0.0) as f32); }
                }
                x.extend_from_slice(e.process(128));
            }
            feats.push((f.f_target.unwrap(), analysis::analyze(&x, sr as f32, f.f_target.unwrap() as f32)));
            rec.extend_from_slice(&x);
        }
        recs.push(rec);
        dry_feats.push(feats);
    }
    // clap at the start (5 ms noise burst) in rooms of known RT60
    for &rt in &[0.3, 0.6, 1.0] {
        let mut rec = recs[0].clone();
        let mut r = 99u64;
        for i in 0..(0.005 * sr) as usize { rec[(0.1 * sr) as usize + i] += (0.8 * rng(&mut r)) as f32; }
        let y = conv(&rec, &room_ir(sr, rt, 0.0, 5));
        let rm = analysis::room(&y, sr as f32);
        println!("clap test: true RT60 {rt:.1} → clap_rt60 {:.2}, rt60 {:.2}, drr {:.1}, n {}, conf {:.2}, verdict {}", rm.clap_rt60, rm.rt60, rm.drr, rm.n_tails, rm.confidence, rm.verdict);
    }
    let dry_room = analysis::room(&recs[0], sr as f32);
    println!("dry tongued recording: rt60 {:.2} spread {:.2} drr {:.1} nf {:.1} n {} conf {:.2} verdict {}", dry_room.rt60, dry_room.rt60_spread, dry_room.drr, dry_room.noise_floor, dry_room.n_tails, dry_room.confidence, dry_room.verdict);
    println!("rt60 drr  noise rel | est_rt60 est_drr n conf verdict | attackΔms harmΔdB tiltΔ  (tongued)  || faded: est_rt60 n verdict");
    let mut seed = 11;
    for &rt in &[0.2, 0.4, 0.6, 0.8, 1.0] {
        for &drr in &[-5.0, 0.0, 5.0, 10.0] {
            for &nf in &[-70.0, -45.0] {
                if std::env::var("QUICK").is_ok() { continue; }
                seed += 1;
                let h = room_ir(sr, rt, drr, seed);
                let mut out = vec![];
                for (ri, rec) in recs.iter().enumerate() {
                    let mut y = conv(rec, &h);
                    // noise re the steady note level (≈ −20 dBFS here)
                    let lvl = 10f64.powf((-20.0 + nf) / 20.0);
                    let mut r = seed * 7 + ri as u64;
                    for v in y.iter_mut() { *v += (lvl * 1.7 * rng(&mut r)) as f32; }
                    let room = analysis::room(&y, sr as f32);
                    // feature errors per note (segments → notes)
                    let segs = analysis::segment(&y, sr as f32);
                    let (mut da, mut dh, mut dt, mut cnt) = (0.0, 0.0, 0.0, 0.0);
                    for (k, (t, fd)) in dry_feats[ri].iter().enumerate() {
                        if k >= segs.len() { break; }
                        let b = segs.get(k + 1).map(|s| s.0).unwrap_or(y.len());
                        let fw = analysis::analyze(&y[segs[k].0..b], sr as f32, *t as f32);
                        da += (fw[idx::ATTACK] - fd[idx::ATTACK]).abs() as f64;
                        dh += (2..=6).map(|j| (fw[idx::H1 + j - 1] - fd[idx::H1 + j - 1]).abs() as f64).sum::<f64>() / 5.0;
                        dt += (fw[idx::TILT] - fd[idx::TILT]).abs() as f64;
                        cnt += 1.0;
                    }
                    out.push((room, da / cnt, dh / cnt, dt / cnt));
                }
                let (r0, a0, h0, t0) = out[0];
                let (r1, ..) = out[1];
                println!("{rt:.1} {drr:+4.0} {nf:5.0} | {:5.2} {:6.1} tail {:6.1} {} {:.2} {} | {:6.1} {:5.2} {:5.2} || {:5.2} {} {}",
                    r0.rt60, r0.drr, r0.tail_ratio, r0.n_tails, r0.confidence, r0.verdict, a0, h0, t0, r1.rt60, r1.n_tails, r1.verdict);
            }
        }
    }
}
