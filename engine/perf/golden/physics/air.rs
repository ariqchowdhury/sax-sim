//! Thermodynamic properties of air (docs/PHYSICS.md E0, Keefe 1984).

#[derive(Clone, Copy, Debug)]
pub struct Air {
    /// speed of sound (m/s)
    pub c: f64,
    /// density (kg/m³)
    pub rho: f64,
    /// dynamic viscosity (Pa·s)
    pub eta: f64,
    /// ratio of specific heats
    pub gamma: f64,
    /// ν = √Prandtl
    pub nu: f64,
}

/// Highest temperature allowed by the param range; used to size grids (CFL).
pub const T_MAX_C: f64 = 40.0;

impl Air {
    /// Dry air at 1 atm, temperature in °C (Keefe 1984, ΔT = T − 26.85 °C).
    pub fn at(temp_c: f64) -> Air {
        let dt = temp_c - 26.85;
        Air {
            c: 347.23 * (1.0 + 0.00166 * dt),
            rho: 1.1769 * (1.0 - 0.00335 * dt),
            eta: 1.846e-5 * (1.0 + 0.0025 * dt),
            gamma: 1.4017 * (1.0 - 0.00002 * dt),
            nu: 0.8410 * (1.0 - 0.0002 * dt),
        }
    }
    /// Air in the player's vocal tract: 37 °C, saturated (PHYSICS.md §0).
    pub fn breath() -> Air {
        let mut a = Air::at(37.0);
        a.c = 353.0;
        a.rho = 1.11;
        a
    }
    pub fn c_max() -> f64 {
        Air::at(T_MAX_C).c.max(Air::breath().c)
    }
    /// Combined visco-thermal boundary-layer loss factor (PHYSICS.md E2):
    /// series impedance per unit length Z_extra(s) = k_vt · √s / (S r),
    /// k_vt = 2 √(ρη) (1 + (γ−1)/ν) — thermal loss lumped into the series branch.
    pub fn k_vt(&self) -> f64 {
        2.0 * (self.rho * self.eta).sqrt() * (1.0 + (self.gamma - 1.0) / self.nu)
    }
}
