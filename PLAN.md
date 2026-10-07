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

Status of each milestone is tracked at the bottom of this file.

## Status (2026-10-06)
- M0 done: scaffold, contracts, geometry, PHYSICS.md, TMM reference.
- M1 done: self-oscillation from lung pressure; onset 2.35–2.45 kPa.
- M2 done: 23 tone holes, data-driven keywork (Rust + TS, 97/97 match); 33 fingerings. Engine pitch: register 1 ±7 cents, register 2 ±20 (F#6 −64, geometry limit). Right register 93/99 (pure physics), 98/99 (player_assist 0.5).
- M3 mostly done: vocal tract, glottis, lungs, tonguing attacks, player_assist controller, 3D drags. Open: embouchure pitch bend too small in register 1.
- M4 done: parametric mouthpiece; beam reed (reed_model=1) available, lumped reed default (beam locks registers worse, plays high notes sharp).
- M5 done: scope, spectrum, standing wave on bore, impedance plot (worker), reed shape, readouts.
- M6 partial: engine-in-the-loop tuning, VALIDATION.md tables. Open research: soft dynamics (onset is subcritical in this model), altissimo (see docs/ALTISSIMO.md).
- M7 partial: SAB telemetry, fused SIMD FDTD; native 14× / wasm 11.6× real time at 4× worst case (targets 25× / 15× need physics trade-offs); regression harness engine/perf/regress.sh.
- M8 done: MIDI + breath controller, jaw vibrato, legato, WAV/CSV recording, presets, tour, fingering chart, README, npm test (unit + e2e).

## Next (proposed)
1. Nonlinear (turbulent) vent/tone-hole losses + lip stiffness growing with force → altissimo, low-register bends.
2. Dynamics via embouchure in the player model; reed–lip contact with distributed lip mass.
3. Performance: fewer loss poles / smaller thermal region; relaxed-SIMD wasm build selection.
