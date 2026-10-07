// M9 robustness: analyse simulated notes dry and convolved with synthetic room IRs
// (direct impulse + exponentially decaying noise tail, RT60 0.3/0.5/0.8 s, DRR ≈ 0 dB),
// report the mean |Δ| per feature.
use sax_engine::analysis::{self, fft, FEATURE_LEN, FEATURE_NAMES};
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
    fft(&mut ar, &mut ai); // inverse via conj trick
    (0..x.len()).map(|i| (ar[i] / nf as f64) as f32).collect()
}

fn room_ir(sr: f64, rt60: f64, seed: u64) -> Vec<f64> {
    let n = (rt60 * 1.2 * sr) as usize;
    let mut h = vec![0.0; n];
    h[0] = 1.0;
    let mut r = seed | 1;
    let tau = rt60 / 6.91; // amplitude e-folding
    let mut e = 0.0;
    let pre = (0.005 * sr) as usize; // 5 ms initial gap
    for i in pre..n {
        r ^= r << 13; r ^= r >> 7; r ^= r << 17;
        let w = (r >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0;
        let v = w * (-(i as f64 / sr) / tau).exp();
        h[i] = v; e += v * v;
    }
    let g = (1.0 / e).sqrt(); // reverberant energy = direct energy (DRR 0 dB)
    for v in h.iter_mut().skip(pre) { *v *= g; }
    h
}

fn main() {
    let geom = std::fs::read_to_string("../data/alto_sax.json").unwrap();
    let notes = ["Bb3", "D4", "G4", "C5", "C#5", "D5", "G5", "C6", "F6"];
    let sr = 48000.0;
    let mut dry = Vec::new();
    for n in notes {
        let mut e = Engine::new(sr as f32);
        e.load_geometry_json(&geom).unwrap();
        let f = e.inst.json.fingerings.iter().find(|f| f.note == n).unwrap().clone();
        for k in &f.keys { e.set_key_by_name(k, 1.0); }
        e.set_seed(1);
        e.snap_params(); e.snap_pads();
        e.set_param(Param::LungPressure as u32, 3.5);
        let mut x = Vec::new();
        for _ in 0..(3.0 * sr / 128.0) as usize { x.extend_from_slice(e.process(128)); }
        // 0.5 s of silence after the note (release into the room)
        x.extend(std::iter::repeat(0.0).take((0.5 * sr) as usize));
        dry.push((n, f.f_target.unwrap(), x));
    }
    for rt in [0.3, 0.5, 0.8] {
        let h = room_ir(sr, rt, 42);
        let mut sum = [0.0f64; FEATURE_LEN];
        let mut worst = [0.0f64; FEATURE_LEN];
        for (_, t, x) in &dry {
            let a = analysis::analyze(x, sr as f32, *t as f32);
            let y = conv(x, &h);
            let b = analysis::analyze(&y, sr as f32, *t as f32);
            for i in 0..FEATURE_LEN { let d = (b[i] - a[i]).abs() as f64; sum[i] += d; worst[i] = worst[i].max(d); }
        }
        let mut v: Vec<(usize, f64)> = (0..FEATURE_LEN).map(|i| (i, sum[i] / dry.len() as f64)).collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        println!("RT60 {rt:.1} s — mean |Δ| (max) per feature, largest first:");
        println!("  {}", v.iter().map(|(i, m)| format!("{} {:.2} ({:.2})", FEATURE_NAMES[*i], m, worst[*i])).collect::<Vec<_>>().join(", "));
    }
}
