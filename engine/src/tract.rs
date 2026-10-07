//! Player's vocal tract (PHYSICS.md §7): glottis → pharynx → oral cavity →
//! mouth cavity sealed by the lips around the mouthpiece. A 1-D Webster FDTD
//! tube (same solver as the bore) at the internal time step but on a coarser
//! grid (Δx ≈ 5 mm; λ < 1 is stable, dispersion < 2 cents below 2 kHz), with an
//! articulatory area function (neutral Story/Maeda-style tract + Gaussian
//! tongue-body and tongue-tip constrictions). Soft walls: boundary-layer losses
//! ×3 (was ×10): gives tract resonance bandwidths of the order of measured
//! formant bandwidths (~60–100 Hz near 1 kHz, Fant 1972) and tract input-impedance
//! peaks of 15–50 MPa·s/m³ for a high front tongue, as measured on saxophonists
//! (Chen, Smith & Wolfe 2008/2011; Scavone et al. 2008). Air at 37 °C, saturated.

use crate::air::Air;
use crate::fdtd::Tube;

pub const TRACT_LEN: f64 = 0.17;
pub const WALL_LOSS_MULT: f64 = 3.0;
/// target spatial step (m)
pub const TRACT_DX: f64 = 0.005;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TractControls {
    pub tongue_x: f64,
    pub tongue_y: f64,
    pub tongue_tip: f64,
    pub jaw_open: f64,
}

impl Default for TractControls {
    fn default() -> Self {
        TractControls { tongue_x: 0.5, tongue_y: 0.4, tongue_tip: 0.3, jaw_open: 0.3 }
    }
}

/// Cross-sectional area (m²) at distance x (m) from the glottis (PHYSICS.md §7).
pub fn tract_area(x: f64, c: &TractControls) -> f64 {
    let jaw = c.jaw_open.clamp(0.0, 1.0);
    // neutral tract (cm²)
    let base = if x < 0.020 {
        1.8
    } else if x < 0.075 {
        3.5
    } else if x < 0.095 {
        2.8
    } else if x < 0.150 {
        3.0 + 2.5 * jaw
    } else {
        2.0 + 2.0 * jaw
    };
    let mut a = base;
    // tongue body
    let xc = 0.065 + 0.075 * (1.0 - c.tongue_x.clamp(0.0, 1.0));
    let sig = 0.020;
    let g = (-(x - xc) * (x - xc) / (2.0 * sig * sig)).exp();
    a = (a * (1.0 - 0.97 * c.tongue_y.clamp(0.0, 1.0) * g)).max(0.10);
    // tongue tip
    let st = 0.006;
    let gt = (-(x - 0.158) * (x - 0.158) / (2.0 * st * st)).exp();
    a = (a * (1.0 - 0.9 * c.tongue_tip.clamp(0.0, 1.0) * gt)).max(0.15);
    a * 1e-4
}

pub struct Tract {
    pub tube: Tube,
    pub ctrl: TractControls,
}

impl Tract {
    pub fn new(cap: usize) -> Self {
        Tract { tube: Tube::with_capacity(cap), ctrl: TractControls::default() }
    }

    /// Number of nodes: Δx ≈ TRACT_DX but never below c_max·Δt (CFL).
    pub fn nodes_for(dt: f64) -> usize {
        let dx = TRACT_DX.max(Air::c_max() * dt);
        ((TRACT_LEN / dx).floor() as usize).max(4) + 1
    }

    pub fn build(&mut self, dt: f64) {
        let n = Self::nodes_for(dt);
        self.tube.resize(n);
    }

    pub fn update_coeffs(&mut self, dt: f64, air: &Air) {
        let n = self.tube.n;
        let dx = TRACT_LEN / (n - 1) as f64;
        for i in 0..n - 1 {
            self.tube.s_half[i] = tract_area((i as f64 + 0.5) * dx, &self.ctrl);
        }
        self.tube.set_coeffs(dx, dt, air, WALL_LOSS_MULT, None);
    }
}
