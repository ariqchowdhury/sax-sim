//! sax_engine — first-principles real-time alto saxophone + player model.
//!
//! C ABI (docs/ARCHITECTURE.md "WASM ABI"). Single engine instance.

pub mod air;
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
    let ratio = fmax / fmin;
    for i in 0..n {
        let f = fmin * ratio.powf(i as f64 / (n - 1) as f64);
        let w = 2.0 * core::f64::consts::PI * f * dt;
        let (s, c) = w.sin_cos();
        // rotating phasor e^{-jωt}
        let (mut pr, mut pi) = (1.0f64, 0.0f64);
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for (k, &v) in z.iter().enumerate() {
            re += v * pr;
            im += v * pi;
            let nr = pr * c + pi * s;
            let ni = pi * c - pr * s;
            pr = nr;
            pi = ni;
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
    out.as_ptr()
}
