# Alto Saxophone Physical Simulation — Plan

Goal: a real-time, interactive 3D simulation of an alto saxophone **and its player**
(lungs → vocal tract/tongue → lips → reed → mouthpiece → bore/tone holes → bell → listener),
computed from first-principles acoustics, where every functional part can be grabbed and
changed in the 3D view while the sound responds live.

## Technology choices

| Layer | Choice | Why |
|---|---|---|
| Physics / audio core | **Rust → WebAssembly** (`wasm32-unknown-unknown`, raw C ABI, no wasm-bindgen) running inside an **AudioWorklet** | Deterministic, allocation-free, SIMD-capable hot loop at audio rate; same crate also builds natively for offline tests & validation |
| 3D / UI | **TypeScript + Three.js + Vite** | Mature WebGL/WebGPU scene graph, raycasting for click/drag, zero-install for users |
| Validation / reference | **Python (numpy)** transfer-matrix (TMM) impedance code | Independent frequency-domain reference to check the time-domain engine |

Runs in any modern browser: `npm run dev`.

## Physics architecture (one coupled time-domain system)

```
 lungs ──► glottis ──► vocal tract (1D FDTD, area fn from tongue/jaw) ──► mouth cavity
                                                                         │ p_mouth (acoustic, not constant!)
                                                         reed channel ◄──┘  Bernoulli flow U(Δp, h)
   lip (position, force, damping) ──► reed (mass-spring → FD beam w/ lay contact) ──► h(t)
                                                                         │ U + S_r·dy/dt
 mouthpiece (parametric area fn: tip, baffle, chamber, throat) ──► neck ──► conical bore (1D FDTD)
       tone holes = side-branch tubes with pads (continuous open-ness 0..1)
       open ends (bell + open holes) = passive radiation impedance  ──► radiated pressure ──► audio
```

* **Air columns** (vocal tract, mouthpiece, neck, body, tone-hole chimneys): 1D **Webster
  horn equation** on a staggered grid (pressure/volume-velocity), finite-difference time-domain,
  oversampled (default 4× = 192 kHz internal) and decimated with a polyphase filter.
  Visco-thermal boundary-layer losses via passive approximations (Bilbao & Harrison 2016).
* **Tone holes**: each hole is a short side-branch tube joined to the main bore through a
  volume-velocity-conserving junction; pad height → time-varying end impedance (closed = rigid
  cap; open = radiation load). Pressing keys therefore changes the *geometry*, not a lookup table.
* **Radiation**: Levine–Schwinger approximated by a passive RLC network (Silva et al. 2009) at
  the bell and each open hole; the listener signal is the sum of monopole contributions
  (∝ d/dt of radiated volume velocity) with propagation delays.
* **Reed**: stage 1 single-DOF oscillator with nonlinear beating contact; stage 2 a distributed
  Euler–Bernoulli beam (Avanzini & van Walstijn 2004) with lay-curve and lip contact. Lip
  position/force/damping set the boundary conditions — sliding the mouth forward/back changes
  the free vibrating length.
* **Flow**: quasi-stationary Bernoulli through the reed channel with vena-contracta coefficient,
  plus reed-swept flow; mouth pressure comes from the vocal-tract model so tongue position
  genuinely changes pitch-bending/altissimo behaviour (Chen, Smith & Wolfe 2008).
* **Air source**: lung pressure with first-order respiratory dynamics + turbulent breath noise.
* **Environment**: temperature/humidity set c, ρ, viscosity → tuning drift.

## Team (agents)

| Role | Responsibility |
|---|---|
| Acoustics / physics expert | Physics spec, alto sax geometry data (bore, 20+ tone holes, key mechanism, fingerings), Python TMM reference, validation & review of engine |
| DSP / physics programmer | Rust engine: FDTD solver, reed, flow, tone holes, radiation, vocal tract |
| Graphics programmer | Three.js saxophone, player head cutaway (lips, tongue, vocal tract, lungs), mouthpiece cutaway, picking & drag gizmos |
| Interaction / UX designer | Control mapping, HUD, visualizers (scope, spectrum, impedance, standing wave), discoverability |
| Performance engineer | Worklet/wasm bridge, SharedArrayBuffer telemetry, SIMD, profiling, CPU budget |
| QA / validation engineer | Offline renders, regression tests (pitch per fingering, thresholds), cross-browser checks |

## Milestones

| # | Milestone | Deliverable / exit criteria |
|---|---|---|
| **M0** | Scaffold & contracts | Vite+TS+Three app, Rust wasm engine loaded in AudioWorklet, param protocol, geometry JSON, physics spec, Python TMM tool. A tone plays from the worklet. |
| **M1** | First physical note | Lumped reed + Bernoulli + mouthpiece + conical FDTD bore + bell radiation. Self-oscillates from lung pressure alone; oscillation threshold & pitch of low Bb within ~25 cents of TMM prediction. |
| **M2** | Tone holes & keywork | All tone holes as side branches, full key mechanism (linkages, octave-key vent switching), clickable 3D keys + computer-keyboard fingering. Full written range Bb3–F#6 plays; pitch per fingering checked against TMM. |
| **M3** | The player | Vocal-tract FDTD with articulatory tongue (body x/y, tip), jaw, lips (position on mouthpiece, force, damping), lungs; tonguing (tongue touches reed). Draggable tongue/lips/air in 3D. Pitch-bend with tongue demonstrable. |
| **M4** | Mouthpiece & reed detail | Parametric mouthpiece interior (tip opening, facing length, baffle, chamber, throat) editable in 3D cutaway; distributed reed beam with lay & lip contact; reed strength (2–4). |
| **M5** | Observation tools | Live waveform/spectrum, standing pressure wave drawn on the bore, input-impedance plot for current fingering, reed motion, flow — all synchronized with sound. |
| **M6** | Accuracy pass | Visco-thermal losses refined, calibration vs. published measurements (impedance peaks, playing freqs, thresholds, spectra); documented error table. |
| **M7** | Performance | SAB telemetry, SIMD inner loops, adaptive oversampling, < 30% of one core at 4×; no glitches under interaction. |
| **M8** | Polish | Presets (classical / jazz / altissimo), MIDI + keyboard play, recording/export, help overlay. |
| **M9** | Tone analysis & coaching | Player records a test set (8–12 sustained notes across the range, some at two dynamics). Extract per-note features (cents error, harmonic balance, breath noise, attack, pitch stability, soft→loud brightening), fit the simulator's player/mouthpiece controls by analysis-by-synthesis (offline renders + optimizer), and rank likely causes from cross-note patterns (uniform offset → cork position; register-dependent → chamber/biting; palm keys only → voicing; edgy → lip cushion/mouthpiece; breathy → seal/support). Show suggestions, load the fitted player into the sim for A/B listening. Compare relative patterns (ideally vs the player's own reference take) because mic, room and horn differ from the model; report several candidate causes, not one. Depends on M6 dynamics work for loudness-related advice. |

Status of each milestone is tracked at the bottom of this file.

## Status (2026-10-07, round 7)
- M0–M2 done. Real-instrument wall losses (×1.3; Q 41–52, T60 ≈ 95/f0). Shorter neck (0.170 m) fixed F#6 (−63 → −6…+4 ¢). Register 1 ±7 ¢, register 2 ±20 ¢ except A5 +22…+30 ¢ (neck-vent trade-off with palm locking). Right register 94/99 pure physics, 98/99 assist 0.5.
- M3 done: subglottal system (trachea + bronchi; Sg1–3 ≈ 535/1405/2275 Hz), tongue_length articulator, tissue lip, player assist, `dynamic` pp–ff (≈20/21 dB reg 1/2; all 33 notes in tune ±25 ¢ at pp/p/f/ff, A5/Bb5 sharp at mf). Palm-key pp limited to ~10–14 dB.
- M4–M5 done.
- M6 done: altissimo G6–C7 within ±24 ¢ (3.5–5 kPa, pure physics), C#7 −36…−40 ¢, D7 unreachable (bore resonance near 1.4 kHz ~6 MPa·s/m³, tract ceiling ~1.43 kHz). Overtones: partials 4–5 limited by the bore's weak, mistuned upper resonances.
- M7 mostly done (subglottal adds ~7.5 % CPU).
- M8 done.
- M9 done (v1): coach regenerated on round-7 physics (template top-3 80 % v1 / 83 % with G4push); recording guard (silent/cracked/wrong-note takes left out and reported); swell-proof segmentation; clap-primary room estimate. Not yet validated on real recordings.
- UX/graphics pass: 3D view full-screen with progressive disclosure (drawers, context cards, grab hints, zoom-independent drag gain, axis-locked lips, handle-cluster collapse), studio render pipeline with PBR materials and auto quality tiers. Review: docs/UX_REVIEW.md.
- Play mode (keys-only Auto player): engine `auto_player` sets all 10 player controls from a per-fingering × dynamic voicing table (44 entries incl. altissimo) adapted to the mouthpiece/reed setup (p_M pressure scaling + per-param corrections), with pitch/register feedback; grab-to-take-over mask; 132/132 in tune at default setup, ~99 % in register across setups; UI Play/Explore switch, volume, animated anatomy, status, cork tuning hint, out-of-range note.
- Player docs: docs/ALTISSIMO.md, docs/OVERTONES.md.

## Next (proposed)
1. Validate the coach on real recordings (calibrate confidence, room thresholds, ring-down).
2. Physics: palm-key fragility (F6 drops register near default controls at assist 0.5; palm pp only 10–14 dB); A5 sharp at mf vs palm locking (neck vent); C#7 flat; G4 pp needs embouchure change (pure physics 2.2 kPa below threshold).
3. UX: auto close-up when grabbing head handles on phones; usability test with 3–5 first-time users.
4. Coach: report alternative solutions from parallel fitter starts; player-facing docs/TONE.md.
