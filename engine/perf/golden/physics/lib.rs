//! sax_engine — first-principles real-time alto saxophone + player model.
//!
//! C ABI (docs/ARCHITECTURE.md "WASM ABI"). Single engine instance.

pub mod air;
pub mod analysis;
pub mod engine;
pub mod fdtd;
pub mod flow;
pub mod geometry;
pub mod keywork;
pub mod lungs;
pub mod params;
pub mod player;
pub mod radiation;
pub mod reed;
pub mod reed_beam;
pub mod resample;
pub mod smoothing;
pub mod telemetry;
pub mod toneholes;
pub mod tract;

use engine::Engine;

static mut ENGINE: Option<Engine> = None;
static EMPTY: [f32; telemetry::TELEMETRY_LEN] = [0.0; telemetry::TELEMETRY_LEN];

#[allow(static_mut_refs)]
fn engine() -> Option<&'static mut Engine> {
    // SAFETY: the engine is used from a single thread (the AudioWorklet).
    unsafe { ENGINE.as_mut() }
}

#[no_mangle]
pub extern "C" fn sax_alloc(bytes: u32) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(bytes.max(1) as usize);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `sax_alloc(bytes)`.
#[no_mangle]
pub unsafe extern "C" fn sax_free(ptr: *mut u8, bytes: u32) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, 0, bytes.max(1) as usize));
    }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn sax_init(sample_rate: f32) -> u32 {
    unsafe {
        ENGINE = Some(Engine::new(sample_rate));
    }
    0
}

/// # Safety
/// `ptr..ptr+len` must be readable memory holding UTF-8 JSON.
#[no_mangle]
pub unsafe extern "C" fn sax_load_geometry(ptr: *const u8, len: u32) -> u32 {
    let Some(e) = engine() else { return 1 };
    if ptr.is_null() {
        return 2;
    }
    let bytes = core::slice::from_raw_parts(ptr, len as usize);
    let Ok(s) = core::str::from_utf8(bytes) else { return 3 };
    match e.load_geometry_json(s) {
        Ok(()) => 0,
        Err(_) => 4,
    }
}

#[no_mangle]
pub extern "C" fn sax_set_param(id: u32, value: f32) {
    if let Some(e) = engine() {
        e.set_param(id, value);
    }
}

#[no_mangle]
pub extern "C" fn sax_set_key(key_index: u32, pressed: f32) {
    if let Some(e) = engine() {
        e.set_key(key_index, pressed);
    }
}

#[no_mangle]
pub extern "C" fn sax_process(n: u32) -> *const f32 {
    match engine() {
        Some(e) => e.process(n as usize).as_ptr(),
        None => EMPTY.as_ptr(),
    }
}

#[no_mangle]
pub extern "C" fn sax_telemetry_ptr() -> *const f32 {
    match engine() {
        Some(e) => e.telemetry.as_ptr(),
        None => EMPTY.as_ptr(),
    }
}

#[no_mangle]
pub extern "C" fn sax_telemetry_len() -> u32 {
    telemetry::TELEMETRY_LEN as u32
}

#[no_mangle]
pub extern "C" fn sax_pad_openness_ptr() -> *const f32 {
    match engine() {
        Some(e) => e.pad_openness.as_ptr(),
        None => EMPTY.as_ptr(),
    }
}

// ---------------------------------------------------------------------------------------------
// Input impedance (M5 observation; added by the web/graphics side — additive, no physics change)
// ---------------------------------------------------------------------------------------------

static mut IMPEDANCE: Vec<f32> = Vec::new();

/// Input impedance at the reed end for the current fingering / geometry / params, computed from
/// `Engine::impulse_response` (rigid reed) by a direct DFT on a log-frequency grid
/// `f_i = fmin·(fmax/fmin)^(i/(n−1))`, i = 0..n−1.
/// Returns a pointer to `2n` f32: `[|Z_0| … |Z_{n−1}|, arg Z_0 … arg Z_{n−1}]` (|Z| in Pa·s/m³,
/// phase in rad). Valid until the next call.
///
/// **Not real-time safe** (allocates, ~10–100 ms) and it snaps smoothed params and pads to their
/// targets first — call it on a separate engine instance (the web app uses a Web Worker), never
/// from the audio thread's instance.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn sax_compute_impedance(n: u32, fmin: f32, fmax: f32) -> *const f32 {
    let n = (n.clamp(2, 4096)) as usize;
    let out = unsafe { &mut IMPEDANCE };
    out.clear();
    out.resize(2 * n, 0.0);
    let Some(e) = engine() else { return out.as_ptr() };
    let fmin = (fmin as f64).max(1.0);
    let fmax = (fmax as f64).max(fmin * 1.0001);
    e.snap_params();
    e.snap_pads();
    let dt = e.dt;
    // long enough for ~40 periods of fmin, bounded for cost
    let dur = (40.0 / fmin).clamp(0.2, 0.5);
    let steps = (dur / dt) as usize;
    let mut z = e.impulse_response(steps);
    // half-cosine taper over the last 25 % to limit truncation ripple
    let t0 = (steps as f64 * 0.75) as usize;
    for (k, v) in z.iter_mut().enumerate().skip(t0) {
        let x = (k - t0) as f64 / (steps - t0).max(1) as f64;
        *v *= 0.5 * (1.0 + (core::f64::consts::PI * x).cos());
    }
    dft_log_grid(&z, dt, n, fmin, fmax, out);
    out.as_ptr()
}

// ---------------------------------------------------------------------------------------------
// Vocal-tract input impedance seen from the reed (web observation; additive, no physics change)
// ---------------------------------------------------------------------------------------------

static mut TRACT_IMPEDANCE: Vec<f32> = Vec::new();

/// Direct DFT of an impulse response `z` (sample step `dt`) onto the log grid; writes
/// `[|Z_i| …, arg Z_i …]` into `out` (len 2n). Same convention as `sax_compute_impedance`.
fn dft_log_grid(z_full: &[f64], dt_full: f64, n: usize, fmin: f64, fmax: f64, out: &mut [f32]) {
    // boxcar-decimate to ≥ 16 samples per period of fmax (droop < 1 % at fmax) to cut the DFT cost
    let d = ((1.0 / (dt_full * fmax * 16.0)).floor() as usize).max(1);
    let z: Vec<f64> = z_full.chunks(d).map(|c| c.iter().sum::<f64>() / d as f64).collect();
    let dt = dt_full * d as f64;
    let ratio = fmax / fmin;
    for i in 0..n {
        let f = fmin * ratio.powf(i as f64 / (n - 1) as f64);
        let (s, c) = (2.0 * core::f64::consts::PI * f * dt).sin_cos();
        let (mut pr, mut pi, mut re, mut im) = (1.0f64, 0.0f64, 0.0f64, 0.0f64);
        for (k, &v) in z.iter().enumerate() {
            re += v * pr;
            im += v * pi;
            let nr = pr * c + pi * s;
            pi = pi * c - pr * s;
            pr = nr;
            if k & 1023 == 1023 {
                let m = 1.0 / (pr * pr + pi * pi).sqrt();
                pr *= m;
                pi *= m;
            }
        }
        re *= dt;
        im *= dt;
        out[i] = (re * re + im * im).sqrt() as f32;
        out[n + i] = im.atan2(re) as f32;
    }
}

/// Input impedance of the player's vocal tract **as seen from the reed** (mouth end), for the
/// current tongue / jaw / glottis (incl. any player-model offsets): the engine's own tract tube
/// (area function, wall losses, glottal section — `tract.rs`) driven by a volume impulse at the
/// mouth node, coupled through the glottis (linearised about a typical playing flow
/// `TRACT_Z_MEAN_FLOW` = 0.15 L/s: Bernoulli ρŪ/A_g² + viscous duct) to the subglottal airways
/// (trachea + bronchial tree, `tract::Subglottal`; Sg1–Sg3 ≈ 540/1420/2300 Hz show through
/// when the glottis is open). The reed sees this in
/// series with the bore impedance (`sax_compute_impedance`): Z_bore + Z_tract.
/// Returns `2n` f32 `[|Z_i| (Pa·s/m³) …, arg Z_i (rad) …]` on `f_i = fmin·(fmax/fmin)^(i/(n−1))`.
/// **Not real-time safe** and snaps params to their targets — call on a separate engine
/// instance (the web app's impedance worker), never on the audio instance.
const TRACT_Z_MEAN_FLOW: f64 = 1.5e-4;

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn sax_compute_tract_impedance(n: u32, fmin: f32, fmax: f32) -> *const f32 {
    let n = (n.clamp(2, 4096)) as usize;
    let out = unsafe { &mut TRACT_IMPEDANCE };
    out.clear();
    out.resize(2 * n, 0.0);
    let Some(e) = engine() else { return out.as_ptr() };
    let fmin = (fmin as f64).max(1.0);
    let fmax = (fmax as f64).max(fmin * 1.0001);
    e.snap_params();
    let dt = e.dt;
    // tract resonances are well damped (≈ 60–100 Hz bandwidth): 0.1 s of response is plenty
    let steps = ((0.1f64).max(20.0 / fmin) / dt) as usize;
    let mut z = e.tract.mouth_impulse_response(dt, TRACT_Z_MEAN_FLOW, steps);
    let t0 = (steps as f64 * 0.75) as usize;
    for (k, v) in z.iter_mut().enumerate().skip(t0) {
        let x = (k - t0) as f64 / (steps - t0).max(1) as f64;
        *v *= 0.5 * (1.0 + (core::f64::consts::PI * x).cos());
    }
    dft_log_grid(&z, dt, n, fmin, fmax, out);
    out.as_ptr()
}

// ------------------------------------------------------------------ M9 analysis (docs/COACHING.md)

static mut FEATURES: [f32; analysis::FEATURE_LEN] = [0.0; analysis::FEATURE_LEN];
static mut SEGMENTS: Vec<f32> = Vec::new();

/// Analyse a mono single-note buffer (`analysis.rs`); returns the feature vector
/// (`sax_analyze_len()` f32, layout in COACHING.md). `target_hz` = expected sounding
/// pitch (≤ 0: unknown). Independent of the engine instance (no `sax_init` needed).
/// # Safety
/// `ptr..ptr+n` must be readable f32s.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn sax_analyze(ptr: *const f32, n: u32, sample_rate: f32, target_hz: f32) -> *const f32 {
    let out = &mut FEATURES;
    if ptr.is_null() {
        *out = [0.0; analysis::FEATURE_LEN];
        return out.as_ptr();
    }
    let x = core::slice::from_raw_parts(ptr, n as usize);
    *out = analysis::analyze_with(x, sample_rate, target_hz, &analysis_cfg());
    out.as_ptr()
}

#[no_mangle]
pub extern "C" fn sax_analyze_len() -> u32 {
    analysis::FEATURE_LEN as u32
}

/// Split a multi-note recording into notes; returns `[count, start0, end0, start1, …]`
/// (sample indices as f32).
/// # Safety
/// `ptr..ptr+n` must be readable f32s.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn sax_segment(ptr: *const f32, n: u32, sample_rate: f32) -> *const f32 {
    let out = &mut SEGMENTS;
    out.clear();
    if ptr.is_null() {
        out.push(0.0);
        return out.as_ptr();
    }
    let x = core::slice::from_raw_parts(ptr, n as usize);
    let segs = analysis::segment(x, sample_rate);
    out.push(segs.len() as f32);
    for (a, b) in segs {
        out.push(a as f32);
        out.push(b as f32);
    }
    out.as_ptr()
}

/// Silence all acoustic / reed / lung / player run-time state (keep geometry,
/// params and keys) for back-to-back deterministic offline renders.
#[no_mangle]
pub extern "C" fn sax_reset_state() {
    if let Some(e) = engine() {
        e.reset_offline();
    }
}

/// Breath-noise RNG seed (deterministic fits); takes effect immediately and on every reset.
#[no_mangle]
pub extern "C" fn sax_set_seed(seed: u32) {
    if let Some(e) = engine() {
        e.set_seed(seed);
    }
}

static mut ROOM: [f32; analysis::ROOM_LEN] = [0.0; analysis::ROOM_LEN];

/// Blind room / recording-quality estimate of a (multi-note) recording from its
/// release tails (and an optional clap before the first note). Returns
/// `[rt60, rt60_spread, drr, noise_floor, n_tails, confidence, verdict, clap_rt60,
/// tail_ratio]` (COACHING.md). No `sax_init` needed.
/// # Safety
/// `ptr..ptr+n` must be readable f32s.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn sax_room(ptr: *const f32, n: u32, sample_rate: f32) -> *const f32 {
    let out = &mut ROOM;
    if ptr.is_null() {
        *out = analysis::RoomSummary { rt60: -1.0, rt60_spread: -1.0, drr: -120.0, noise_floor: -120.0, verdict: 3, clap_rt60: -1.0, tail_ratio: -120.0, ..Default::default() }.to_array();
        return out.as_ptr();
    }
    let x = core::slice::from_raw_parts(ptr, n as usize);
    *out = analysis::room_with(x, sample_rate, &analysis_cfg()).to_array();
    out.as_ptr()
}

/// Analysis configuration: instrument ring-down constant T60_inst·f0 (Hz·s) used
/// by the release/room estimate — 95 (default: simulator with wall losses and real
/// altos; COACHING.md). Values ≤ 0 restore the default.
#[no_mangle]
pub extern "C" fn sax_analysis_config(inst_t60_hz: f32) {
    ANALYSIS_T60.store((analysis::AnalysisConfig::with_inst_t60(inst_t60_hz as f64).inst_t60_hz).to_bits(), core::sync::atomic::Ordering::Relaxed);
}

/// ABI-level analysis configuration (`sax_analysis_config`); the analysis code
/// itself takes it as a parameter.
static ANALYSIS_T60: core::sync::atomic::AtomicU64 = core::sync::atomic::AtomicU64::new(0);

fn analysis_cfg() -> analysis::AnalysisConfig {
    let bits = ANALYSIS_T60.load(core::sync::atomic::Ordering::Relaxed);
    if bits == 0 {
        analysis::AnalysisConfig::default()
    } else {
        analysis::AnalysisConfig::with_inst_t60(f64::from_bits(bits))
    }
}
