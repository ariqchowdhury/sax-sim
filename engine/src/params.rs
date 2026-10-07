//! Parameter table. Mirrors docs/ARCHITECTURE.md and web/src/engine/params.ts.
//! The index IS the param id on the WASM ABI — never reorder.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Param {
    LungPressure = 0,
    BreathNoise = 1,
    LipPosition = 2,
    LipForce = 3,
    LipDamping = 4,
    TongueX = 5,
    TongueY = 6,
    TongueTip = 7,
    TongueReedContact = 8,
    JawOpen = 9,
    GlottisOpen = 10,
    ReedStrength = 11,
    ReedDamping = 12,
    TipOpening = 13,
    FacingLength = 14,
    BaffleHeight = 15,
    ChamberSize = 16,
    ThroatDiameter = 17,
    MouthpieceInsertion = 18,
    Temperature = 19,
    MasterGain = 20,
    Oversample = 21,
    /// 0 = lumped single-DOF reed, 1 = distributed beam reed (M4)
    ReedModel = 22,
    /// 0 = pure physics … 1 = full automatic embouchure assistance (player.rs)
    PlayerAssist = 23,
}

pub const NUM_PARAMS: usize = 24;

pub struct ParamDef {
    pub name: &'static str,
    pub min: f32,
    pub max: f32,
    pub default: f32,
}

macro_rules! p {
    ($n:expr, $min:expr, $max:expr, $def:expr) => {
        ParamDef { name: $n, min: $min, max: $max, default: $def }
    };
}

pub const PARAM_DEFS: [ParamDef; NUM_PARAMS] = [
    p!("lung_pressure", 0.0, 10.0, 0.0),
    p!("breath_noise", 0.0, 1.0, 0.05),
    p!("lip_position", 2.0, 22.0, 12.0),
    p!("lip_force", 0.0, 3.0, 1.0),
    p!("lip_damping", 0.0, 1.0, 0.4),
    p!("tongue_x", 0.0, 1.0, 0.5),
    p!("tongue_y", 0.0, 1.0, 0.4),
    p!("tongue_tip", 0.0, 1.0, 0.3),
    p!("tongue_reed_contact", 0.0, 1.0, 0.0),
    p!("jaw_open", 0.0, 1.0, 0.3),
    p!("glottis_open", 0.0, 1.0, 0.8),
    p!("reed_strength", 1.5, 5.0, 2.5),
    p!("reed_damping", 0.0, 1.0, 0.3),
    p!("tip_opening", 1.2, 3.2, 1.9),
    p!("facing_length", 15.0, 30.0, 22.0),
    p!("baffle_height", 0.0, 1.0, 0.3),
    p!("chamber_size", 0.0, 1.0, 0.5),
    p!("throat_diameter", 8.0, 16.0, 11.0),
    p!("mouthpiece_insertion", 0.0, 20.0, 10.0),
    p!("temperature", 0.0, 40.0, 22.0),
    p!("master_gain", 0.0, 4.0, 1.0),
    p!("oversample", 1.0, 8.0, 4.0),
    p!("reed_model", 0.0, 1.0, 0.0),
    p!("player_assist", 0.0, 1.0, 0.5),
];

impl Param {
    pub fn from_id(id: u32) -> Option<Param> {
        if (id as usize) < NUM_PARAMS {
            // SAFETY: repr(u32), contiguous discriminants 0..NUM_PARAMS
            Some(unsafe { core::mem::transmute::<u32, Param>(id) })
        } else {
            None
        }
    }
    pub fn by_name(name: &str) -> Option<Param> {
        PARAM_DEFS
            .iter()
            .position(|d| d.name == name)
            .and_then(|i| Param::from_id(i as u32))
    }
}

/// Clamp a raw value to the param's legal range (NaN → default).
pub fn clamp_param(id: usize, v: f32) -> f32 {
    let d = &PARAM_DEFS[id];
    if !v.is_finite() {
        return d.default;
    }
    let mut x = v.max(d.min).min(d.max);
    if id == Param::Oversample as usize || id == Param::ReedModel as usize {
        x = x.round();
    }
    x
}

pub fn default_values() -> [f32; NUM_PARAMS] {
    let mut a = [0.0; NUM_PARAMS];
    for (i, d) in PARAM_DEFS.iter().enumerate() {
        a[i] = d.default;
    }
    a
}
