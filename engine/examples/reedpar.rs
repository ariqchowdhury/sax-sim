// Print lumped reed parameters (tip + body modes) for an embouchure:
//   reedpar lip_force lip_position lip_damping reed_damping
use sax_engine::reed::*;
fn main() {
    let a: Vec<f64> = std::env::args().skip(1).map(|s| s.parse().unwrap()).collect();
    let c = ReedControls { lip_force: a[0], lip_position_mm: a[1], lip_damping: a[2], reed_damping: a[3], ..Default::default() };
    let p = derive_reed_params(&c);
    let rc2 = 1.42e5;
    let fr = (p.k / p.m).sqrt() / (2.0 * std::f64::consts::PI);
    let q = p.r / (p.k * p.m).sqrt();
    let fb = (p.k_b / p.m_b).sqrt() / (2.0 * std::f64::consts::PI);
    let qb = p.r_b / (p.k_b * p.m_b).sqrt();
    println!("V_tip={:.3e} f_r={:.0} q={:.3} V_body={:.3e} f_b={:.0} q_b={:.3} H0={:.3e} pM={:.0}",
        rc2 * p.s_r * p.s_r / p.k, fr, q, rc2 * p.s_b * p.s_b / p.k_b, fb, qb, p.tip_opening - p.y_eq, p.k * (p.tip_opening - p.y_eq) / p.s_r);
}
