//! Quasi-stationary orifice flow (Bernoulli, no pressure recovery) and the
//! implicit junction solve that couples it to the adjacent FDTD nodes.
//!
//! Each orifice joins an upstream node (pressure p_a, update gain K_a = ρc²Δt/V_a)
//! and a downstream node (p_b, K_b) — either may be an ideal source (K = 0).
//! With U = A·sgn(Δ)·√|Δ| + U_0 (A = α w h √(2/ρ), U_0 = reed-swept + noise flow)
//! and Δ = p_a^{n+1} − p_b^{n+1}, the node updates give
//!     Δ + K A sgn(Δ)√|Δ| = B − K U_0,      K = K_a + K_b,
//! where B is the pressure difference the nodes would reach with zero orifice
//! flow. The left side is strictly monotonic in Δ, so the root is unique and has
//! the sign of the right side; with s = √|Δ|:  s² + KA s − |rhs| = 0.
//! Closed form, unconditionally stable (backward-Euler in the flow term), and
//! well behaved for h → 0 and for instantaneous 0→10 kPa pressure steps.

/// Effective length of the reed-channel air plug for the flow inertia
/// ρ ℓ/(w h) dU/dt (Hirschberg et al. 1990; ℓ ≈ 3–5 mm). Implemented (implicit)
/// but OFF by default: engine-in-the-loop tables (tools/engine_loop.py, 3/3.5/4
/// kPa) gave 3 → 6 → 8 → 10 register failures for ℓ = 0, 2, 4, 6 mm.
pub const CHANNEL_INERTIA_LEN: f64 = 0.0;

/// Solve Δ + ka·sgn(Δ)·√|Δ| = rhs for Δ (ka ≥ 0).
#[inline]
pub fn solve_orifice(rhs: f64, ka: f64) -> f64 {
    let m = rhs.abs();
    if m == 0.0 {
        return 0.0;
    }
    // cancellation-free root of s² + ka s − m = 0
    let s = 2.0 * m / (ka + (ka * ka + 4.0 * m).sqrt());
    rhs.signum() * s * s
}

/// Orifice coefficient A = α·area·√(2/ρ) so that U = A·sgn(Δp)√|Δp|.
#[inline]
pub fn orifice_coef(alpha: f64, area: f64, rho: f64) -> f64 {
    alpha * area.max(0.0) * (2.0 / rho).sqrt()
}

#[inline]
pub fn orifice_flow(a: f64, dp: f64) -> f64 {
    a * dp.signum() * dp.abs().sqrt()
}

/// Channel with Bernoulli + viscous (Poiseuille-slit) losses (PHYSICS.md E6):
///     Δp = a·U|U| + b·U,   a = ρ/(2(α w h)²),  b = 12 η ℓ /(w h³)
/// coupled to nodes with total gain K:  Δp = rhs − K·U.
/// Returns U (closed form, cancellation-free; U → 0 smoothly as h → 0).
#[inline]
pub fn solve_channel(rhs: f64, k: f64, a: f64, b: f64) -> f64 {
    if !(a.is_finite() && b.is_finite()) {
        return 0.0;
    }
    let m = rhs.abs();
    let bk = b + k;
    let den = bk + (bk * bk + 4.0 * a * m).sqrt();
    if den <= 0.0 {
        return 0.0;
    }
    rhs.signum() * 2.0 * m / den
}

/// Coefficients (a, b) of `solve_channel` for a slit of width w, height h,
/// length ℓ with vena-contracta coefficient α. h ≤ 0 gives (∞, ∞) = closed.
#[inline]
pub fn channel_coefs(rho: f64, eta: f64, alpha: f64, w: f64, h: f64, len: f64) -> (f64, f64) {
    if h <= 1e-9 || w <= 0.0 {
        return (f64::INFINITY, f64::INFINITY);
    }
    let ah = alpha * w * h;
    (rho / (2.0 * ah * ah), 12.0 * eta * len / (w * h * h * h))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channel_root() {
        for &(a, b, k) in &[(1e9, 0.0, 0.0), (1e9, 1e6, 1e7), (1e12, 1e9, 0.0), (5e8, 0.0, 1e8)] {
            for &rhs in &[-8e3, -1.0, 0.0, 1.0, 3e3, 1e4] {
                let u = solve_channel(rhs, k, a, b);
                let res = a * u * u.abs() + (b + k) * u - rhs;
                assert!(res.abs() <= 1e-9 * (1.0 + rhs.abs()), "a={a} b={b} k={k} rhs={rhs} u={u} res={res}");
            }
        }
        assert_eq!(solve_channel(5e3, 1e7, f64::INFINITY, f64::INFINITY), 0.0);
    }

    #[test]
    fn orifice_root() {
        for &ka in &[0.0, 1e-3, 1.0, 100.0, 1e5] {
            for &rhs in &[-1e4, -3.0, 0.0, 1e-9, 2.5, 1e4] {
                let d = solve_orifice(rhs, ka);
                let lhs = d + ka * d.signum() * d.abs().sqrt();
                assert!((lhs - rhs).abs() <= 1e-9 * (1.0 + rhs.abs()), "ka={ka} rhs={rhs} d={d}");
            }
        }
    }
}
