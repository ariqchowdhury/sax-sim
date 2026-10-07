# Architecture & Interface Contracts

All agents must respect these contracts. Change them only by editing this file in the same change.

## Repository layout

```
engine/            Rust crate `sax_engine` (cdylib + rlib). Builds to wasm32-unknown-unknown and natively.
  src/lib.rs       C-ABI exports (below) — thin wrapper over the physics
  src/params.rs    Param enum (mirrors web/src/engine/params.ts)
  src/...          physics modules (fdtd, reed, flow, toneholes, radiation, tract, ...)
  src/bin/render.rs  native offline renderer: writes WAV + CSV telemetry for validation
data/alto_sax.json Geometry + keywork + fingerings (schema below). Single source of truth, used by engine AND graphics.
tools/             Python reference/validation (TMM impedance, analysis of offline renders)
web/               Vite + TypeScript + Three.js app
  src/engine/      worklet, wasm loader, params.ts, EngineClient (main-thread API)
  src/scene/       three.js scene: sax, player, mouthpiece, interaction
  src/ui/          panels, visualizers
  public/engine.wasm  (copied by build script; baseline simd128 build)
  public/engine_relaxed.wasm  (relaxed-SIMD build; chosen at runtime by web/src/engine/wasmSelect.ts feature detection, falls back to engine.wasm)
docs/              PHYSICS.md (spec), ARCHITECTURE.md (this), VALIDATION.md
```

Build: `npm run build:engine` (cargo build --release --target wasm32-unknown-unknown, copy to web/public/engine.wasm), `npm run dev` (Vite, from repo root via web/). Vite dev server must send COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) so SharedArrayBuffer is available.

## WASM ABI (engine/src/lib.rs)

All functions `#[no_mangle] pub extern "C"`. Single engine instance per worklet. No wasm-bindgen.

| Export | Meaning |
|---|---|
| `sax_alloc(bytes: u32) -> *mut u8` / `sax_free(ptr, bytes)` | scratch memory for passing data in |
| `sax_init(sample_rate: f32) -> u32` | create engine; returns 0 ok |
| `sax_load_geometry(ptr: *const u8, len: u32) -> u32` | UTF-8 JSON of `data/alto_sax.json`; 0 ok |
| `sax_set_param(id: u32, value: f32)` | set a scalar param (ids below). Engine smooths internally. |
| `sax_set_key(key_index: u32, pressed: f32)` | player finger on key `keys[key_index]` 0..1. Engine resolves linkages → pad openness. |
| `sax_process(n: u32) -> *const f32` | advance n output samples (n ≤ 512); returns pointer to mono output buffer |
| `sax_telemetry_ptr() -> *const f32` / `sax_telemetry_len() -> u32` | telemetry block (layout below), updated every `sax_process` |
| `sax_pad_openness_ptr() -> *const f32` | one f32 per tone hole (0 closed … 1 fully open), for graphics |
| `sax_compute_impedance(n: u32, fmin: f32, fmax: f32) -> *const f32` | input impedance at the reed end (rigid reed) for the current fingering/geometry/params on the log grid `f_i = fmin·(fmax/fmin)^(i/(n−1))`; returns `2n` f32 = `[|Z_i| (Pa·s/m³) …, arg Z_i (rad) …]`, valid until the next call. **Not real-time safe** (allocates, ~0.1–0.3 s) and snaps params/pads to their targets — the web app calls it on a *separate* engine instance in a Web Worker (`web/src/engine/impedance.worker.ts`), never on the audio instance. |
| `sax_compute_tract_impedance(n: u32, fmin: f32, fmax: f32) -> *const f32` | vocal-tract input impedance **as seen from the reed** (mouth end) for the current tongue/jaw/glottis (incl. player-model offsets): the engine's tract tube (`tract.rs`) driven by a volume impulse at the mouth node, glottis end terminated by ρc/A_sub (A_sub = 2.5 cm²) + viscous glottal resistance. Same grid and `[|Z_i| …, arg Z_i …]` layout as `sax_compute_impedance`, so the two add (complex) to the series load Z_bore + Z_tract the reed works against. Not real-time safe (~20–50 ms); snaps params — impedance worker only. |

## Params (`id` = index; identical order in Rust `Param` enum and TS `PARAMS` array)

| id | name | unit | range | default | meaning |
|---|---|---|---|---|---|
| 0 | lung_pressure | kPa | 0–10 | 0 | target lung (blowing) pressure |
| 1 | breath_noise | 0–1 | 0–1 | 0.05 | turbulence noise level |
| 2 | lip_position | mm | 2–22 | 12 | where lower lip contacts reed, measured from reed tip |
| 3 | lip_force | N | 0–3 | 1.0 | lower-lip force pushing reed toward lay |
| 4 | lip_damping | 0–1 | 0–1 | 0.4 | lip tissue damping (soft ↔ firm) |
| 5 | tongue_x | 0–1 | 0–1 | 0.5 | tongue body front(0)…back(1) |
| 6 | tongue_y | 0–1 | 0–1 | 0.4 | tongue body low(0)…high(1) |
| 7 | tongue_tip | 0–1 | 0–1 | 0.3 | tongue tip height |
| 8 | tongue_reed_contact | 0–1 | 0–1 | 0 | tongue touching reed (tonguing/articulation) |
| 9 | jaw_open | 0–1 | 0–1 | 0.3 | jaw opening (oral cavity size) |
| 10 | glottis_open | 0–1 | 0–1 | 0.8 | glottal opening |
| 11 | reed_strength | – | 1.5–5 | 2.5 | commercial reed strength → stiffness |
| 12 | reed_damping | 0–1 | 0–1 | 0.3 | intrinsic reed damping |
| 13 | tip_opening | mm | 1.2–3.2 | 1.9 | mouthpiece tip opening |
| 14 | facing_length | mm | 15–30 | 22 | lay/facing length |
| 15 | baffle_height | 0–1 | 0–1 | 0.3 | low/rollover (0)…high/step baffle (1) |
| 16 | chamber_size | 0–1 | 0–1 | 0.5 | small (0)…large (1) chamber |
| 17 | throat_diameter | mm | 8–16 | 11 | throat diameter |
| 18 | mouthpiece_insertion | mm | 0–20 | 10 | how far mouthpiece is pushed onto neck cork (tuning) |
| 19 | temperature | °C | 0–40 | 22 | air temperature |
| 20 | master_gain | – | 0–4 | 1 | output gain |
| 21 | oversample | × | 1–8 | 4 | internal oversampling factor (integer) |
| 22 | reed_model | – | 0–1 | 0 | 0 = lumped reed (tip + body mode), 1 = distributed Euler–Bernoulli beam reed (M4); integer |
| 23 | player_assist | 0–1 | 0–1 | 0.5 | auto-embouchure: per-note lip/pressure/tract feed-forward + register locking (engine `player.rs`); 0 = pure physics |
| 24 | dynamic | 0–1 | 0–1 | 0.5 | musical dynamic pp (0) … mf (0.5) … ff (1); the player model scales lung pressure (pp ×0.5, ff ×2; low notes ×0.6/×1.25) and sets lip force/damping and jaw; soft notes start at the mf pressure and relax (0.3 s). No effect when player_assist = 0 |

## Telemetry block (f32 array, index → meaning)

| idx | value |
|---|---|
| 0 | lung pressure (Pa) |
| 1 | mouth pressure at reed (Pa, instantaneous) |
| 2 | mouthpiece pressure at reed (Pa) |
| 3 | reed displacement at tip (m, + toward lay/closing) |
| 4 | reed channel opening h (m) |
| 5 | volume flow through reed U (m³/s) |
| 6 | estimated playing frequency (Hz, 0 if silent) |
| 7 | output RMS |
| 8 | CPU: µs spent in last sax_process call (native only; 0 in wasm) |
| 9–15 | reserved |
| 16 | `N_PROFILE` = number of bore profile samples that follow (128) |
| 17 … 17+N-1 | instantaneous acoustic pressure sampled uniformly along the bore from reed to bell (Pa) |
| 17+N … 17+2N-1 | RMS pressure along bore (standing-wave envelope, Pa) |
| then 64 | latest 64 samples of mouthpiece pressure (decimated scope) |
| then 64 | latest 64 samples of reed tip displacement |
| then 32 | reed deflection along the reed, tip → ligature clamp (m, + toward lay; beam reed, M4 — engine `telemetry.rs` `REED_SHAPE_LEN`) |

## Geometry JSON schema (`data/alto_sax.json`)

All lengths in **metres**, positions measured along the **bore centreline from the reed tip**
(the mouthpiece tip = 0) unless noted. Engine and graphics both read this file.

```jsonc
{
  "meta": { "name": "...", "sources": ["..."], "notes": "..." },
  "mouthpiece": {              // nominal shape; engine perturbs it with params 13-17
    "length": 0.085,
    "profile": [[x, radius], ...],     // equivalent-area radius along mouthpiece (tip → shank end)
    "reed": { "length": 0.068, "width": 0.017, "tip_thickness": 0.0001, "heel_thickness": 0.0028 }
  },
  "neck":  { "profile": [[x, radius], ...], "centerline": [[x,y,z], ...] },
  "body":  { "profile": [[x, radius], ...], "centerline": [[x,y,z], ...] },   // incl. bow and bell
  "bell":  { "end_x": ..., "end_radius": ... },
  "tone_holes": [
    { "id": "Bb_low", "x": 0.95, "radius": 0.0185, "chimney": 0.006,
      "pad_rest": "closed" | "open",        // state with no fingers down
      "pad_open_height": 0.008,              // max pad lift (m)
      "angle_deg": 0,                        // around bore axis, for graphics placement
      "octave_vent": false }
  ],
  "keys": [   // what the player touches
    { "id": "LH1", "label": "B", "hand": "L", "finger": 1, "kind": "pearl|spatula|side|palm|octave|table",
      "position": [x,y,z],                 // touch location for graphics
      "actions": [ {"hole": "B", "set": "closed"} ] }   // direct effect when pressed
  ],
  "linkages": [  // conditional mechanism, evaluated by engine & graphics identically
    { "if_pressed": ["RH1"], "hole": "F#_trill"... , "set": "closed" }  // (exact form defined by acoustics expert, documented in PHYSICS.md)
  ],
  "octave_logic": "...",                     // documented auto-switching neck/body octave vents
  "fingerings": [ { "note": "Bb3", "written_midi": 58, "keys": ["LH1","LH2", ...] } ]
}
```

The key-mechanism evaluation (keys pressed → each hole's target state) must be implemented
identically in Rust (`engine/src/keywork.rs`) and TS (`web/src/scene/keywork.ts`); both are
driven purely by the `keys` / `linkages` / `octave_logic` data so they cannot drift.

## Threading

* Main thread: Three.js scene, UI, `EngineClient` posts `{type:'param', id, value}`,
  `{type:'key', index, value}`, `{type:'geometry', json}` messages to the worklet port.
* Worklet: owns the wasm instance, drains messages at the start of each `process()` call,
  calls `sax_process(128)`; every ~16 ms posts `{type:'telemetry', data: Float32Array, pads: Float32Array}`
  (M7: replaced by SharedArrayBuffer ring).
* Wasm bytes are fetched on the main thread and sent to the worklet via `processorOptions`.
* **Telemetry transport (M7, implemented)**: when `crossOriginIsolated`, the main thread allocates a
  `SharedArrayBuffer` and passes it in `processorOptions.shared`. Layout: `Int32Array` header of 8
  (`[0]` seqlock counter, `[1]` telemetry length, `[2]` pad count, `[3]` frames processed), then a
  `Float32Array` of 4096 telemetry floats followed by 256 pad floats. The worklet writes every
  second render quantum as a seqlock (counter → odd, copy, counter → even, `Atomics.store`); the
  main thread copies it once per animation frame into preallocated arrays and retries/skips if
  the counter is odd or changed during the copy. No allocation on either side. Without cross-origin
  isolation the worklet falls back to the `postMessage` telemetry above.
* **Impedance worker**: `web/src/engine/impedance.worker.ts` owns a second engine instance (same
  wasm, same geometry, mirrored params/keys) and calls `sax_compute_impedance` / `sax_compute_tract_impedance` on demand
  (debounced: bore after key/geometry-relevant param changes, tract ~100 ms after tongue/jaw/glottis changes), so the audio thread never stalls.
