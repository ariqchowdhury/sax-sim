# Validation targets and reference results

Owner: acoustics. The engine (offline renderer `engine/src/bin/render.rs`) is checked against
(1) the literature values below and (2) the frequency-domain reference `tools/tmm.py`, which
uses the same constitutive models as `docs/PHYSICS.md`.

Tools
* `python3 tools/tmm.py --all [--temp T]` — impedance-peak tuning table (below).
* `python3 tools/tmm.py --fingering G4 [--plot]`, `--dump-impedance G4 z.csv` — impedance curves.
* Wave-3 tools: `tools/validation_report.py` (engine tables below), `tools/embouchure_table.py`
  (pitch vs lip/tract), `tools/hb_bifurcation.py` (harmonic-balance Hopf analysis),
  `tools/tract_tmm.py` (tract and bore+tract impedance), `tools/altissimo_search.py`
  (altissimo-friendly fingerings), `engine/examples/dyn.rs` (crescendo/decrescendo curves).
* `python3 tools/analyze_render.py out.wav --csv out.csv --note G4` — f0/cents, centroid,
  harmonics, attack, threshold pressure from an engine render.
* Geometry pipeline (all write `tools/hole_table.json`, then `tools/build_geometry.py` writes the JSON):
  `tools/design_harmonicity.py` (bore harmonicity: neck taper/entry, mouthpiece, bell flare) →
  `tools/tune.py` (TMM hole positions, first guess) → `tools/engine_loop.py tune` (**final**: hole
  positions and bell end tuned to the *engine's* self-oscillating playing frequency, averaged over
  3.0/3.5/4.0 kPa). Octave vents were chosen by engine scans (`tools/engine_loop.py`, see §3).
  `tools/design_octaves.py` / `design_mouthpiece.py` are earlier TMM-only design tools.
  **Whenever the reed/flow model changes, re-run `SAX_RENDER=... python3 tools/engine_loop.py tune`.**

(Use `tools/.venv/bin/python` if the system python lacks numpy/scipy.)

## 1. Literature targets

| quantity | target | source / comment |
|---|---|---|
| range (sounding) | Db3 138.59 Hz … A5 880 Hz (written Bb3 … F#6), ET A4 = 440 Hz, transposition −9 semitones | |
| oscillation threshold (blowing pressure) | 1.5–3 kPa low/middle register, rising with pitch (3–4 kPa near D6) | Fuks & Sundberg 1999 (blowing pressures in reed woodwinds, alto sax pp ≈ 1.5–2.5 kPa); lossless theory: p_th ≈ p_M/3 |
| normal playing pressure | 2.5–6 kPa (pp → ff); altissimo up to ~7 kPa | Fuks & Sundberg 1999; Scavone et al. 2008 |
| reed closing pressure p_M | 6–9 kPa (lipped, classical setup) | scaled from Dalmont et al. 2003 (clarinet 5–10 kPa) |
| lipped reed resonance | 1.5–2.5 kHz | Chen et al. 2009, Scavone 2008 |
| reed equivalent volume | ≈ 1 cm³ (lowers low notes ~5–10 cents vs. rigid reed) | Nederveen 1998 |
| mean flow, mf | 0.1–0.3 L/s | |
| input impedance peaks (bore, at reed) | 1st-register peaks ≈ 20–60 MPa·s/m³ below 500 Hz, decreasing with frequency; strong peaks up to the tone-hole-lattice cutoff ≈ 1–1.6 kHz, weak above | Chen, Smith & Wolfe 2009 (UNSW compendium); TMM below gives 50–100 MPa·s/m³ (no wall-roughness losses: real instruments ~20–40 % lower) |
| harmonicity f2/f1 (low notes, no vent) | 1.95–2.0 | conical bore with matched mouthpiece |
| vocal-tract impedance peaks | 5–30 MPa·s/m³, 300–1500 Hz depending on tongue | Scavone et al. 2008; Chen et al. 2008, 2011 |
| pitch bend by tract (2nd register) | down by up to ~1 semitone with tract tuning | Chen et al. 2011 |
| temperature coefficient | ≈ +3 cents/°C (c ∝ √T) | |
| attack (tongued, mf) | 20–60 ms (10 → 90 % RMS) | |
| spectral centroid (radiated, mf, low register) | ≈ 0.6–1.5 kHz; classical setups darker than jazz (high baffle) | |
| sound level 1 m, mf | ~80–90 dB SPL | |

Engine acceptance (M1/M2): f0 per fingering within ±10 cents of the TMM prediction
(±25 cents at M1 for Bb3), threshold within 1.5–3.5 kPa, no self-oscillation failures across the
standard fingerings at 4 kPa with default embouchure.

## 2. Engine-measured results (final, engine as of 2026-10-06 ~18:30)

Native renderer, default embouchure (lip_position 12 mm, lip_force 1 N, reed_strength 2.5,
tract on, lumped reed), 50 ms pressure attack, f0 of the last 0.5 s of a 1.5 s note; ✗ = wrong
register or silent. Geometry tuned with `tools/engine_loop.py tune --set player_assist=0`.
Regenerate with `SAX_RENDER=... python3 tools/validation_report.py`.

#### player_assist = 0

| written | reg | target Hz | 3.0 kPa f0 (cents) | 3.5 kPa f0 (cents) | 4.0 kPa f0 (cents) |
|---|---|---|---|---|---|
| Bb3 | 1 | 138.59 | 138.7 (+2) | 138.3 (-4) | 138.5 (-1) |
| B3 | 1 | 146.83 | 147.2 (+4) | 146.9 (+0) | 146.3 (-6) |
| C4 | 1 | 155.56 | 155.7 (+2) | **311 ✗** | 155.2 (-4) |
| C#4 | 1 | 164.81 | 165.0 (+2) | **493 ✗** | **491 ✗** |
| D4 | 1 | 174.61 | 175.3 (+7) | 174.6 (+0) | 174.5 (-2) |
| Eb4 | 1 | 185.00 | 184.8 (-2) | 185.0 (+0) | 185.2 (+2) |
| E4 | 1 | 196.00 | 195.7 (-2) | 196.0 (-0) | 196.2 (+2) |
| F4 | 1 | 207.65 | 207.5 (-2) | 207.7 (+0) | 207.9 (+2) |
| F#4 | 1 | 220.00 | 219.7 (-3) | 220.0 (-0) | 220.3 (+2) |
| G4 | 1 | 233.08 | 233.1 (+0) | 233.1 (+0) | 233.1 (-0) |
| G#4 | 1 | 246.94 | 247.1 (+1) | 246.9 (+0) | 246.8 (-1) |
| A4 | 1 | 261.63 | 261.6 (+0) | 261.6 (-0) | 261.6 (+0) |
| Bb4 | 1 | 277.18 | 277.1 (-1) | 277.1 (-0) | 277.3 (+0) |
| B4 | 1 | 293.67 | 293.6 (-0) | 293.5 (-1) | 293.8 (+1) |
| C5 | 1 | 311.13 | 310.6 (-3) | 311.1 (-0) | 311.8 (+3) |
| C#5 | 1 | 329.63 | 329.2 (-2) | 329.6 (-0) | 330.1 (+2) |
| D5 | 2 | 349.23 | 350.4 (+6) | 351.6 (+12) | 352.5 (+16) |
| Eb5 | 2 | 369.99 | 374.8 (+22) | 374.3 (+20) | 373.6 (+17) |
| E5 | 2 | 392.00 | 396.0 (+18) | 395.6 (+16) | 395.1 (+13) |
| F5 | 2 | 415.31 | 418.5 (+13) | 418.1 (+12) | 417.2 (+8) |
| F#5 | 2 | 440.00 | 440.3 (+1) | 440.6 (+2) | 440.9 (+4) |
| G5 | 2 | 466.16 | **251 ✗** | 466.1 (-0) | 466.2 (+0) |
| G#5 | 2 | 493.88 | **269 ✗** | 494.2 (+1) | 494.2 (+1) |
| A5 | 2 | 523.25 | 529.5 (+21) | 529.1 (+19) | 529.2 (+20) |
| Bb5 | 2 | 554.37 | 555.0 (+2) | 556.2 (+6) | 557.1 (+8) |
| B5 | 2 | 587.33 | 585.3 (-6) | 586.0 (-4) | 587.4 (+0) |
| C6 | 2 | 622.25 | 616.2 (-17) | 617.5 (-13) | 619.5 (-8) |
| C#6 | 2 | 659.25 | 657.9 (-4) | 657.6 (-4) | 659.6 (+1) |
| D6 | 2 | 698.46 | 698.9 (+1) | 697.1 (-3) | 699.2 (+2) |
| Eb6 | 2 | 739.99 | 741.0 (+2) | 738.2 (-4) | 740.6 (+1) |
| E6 | 2 | 783.99 | 785.4 (+3) | 782.0 (-4) | 784.7 (+2) |
| F6 | 2 | 830.61 | 831.1 (+1) | 828.7 (-4) | 829.8 (-2) |
| F#6 | 2 | 880.00 | **423 ✗** | 848.0 (-64) | 849.2 (-62) |

assist 0: worst in-register error reg1 7 c (D4), reg2 64 c (F#6); wrong register / silent: 6 of 99 cells.

#### player_assist = 0.5

| written | reg | target Hz | 3.0 kPa f0 (cents) | 3.5 kPa f0 (cents) | 4.0 kPa f0 (cents) |
|---|---|---|---|---|---|
| Bb3 | 1 | 138.59 | 138.6 (-0) | 138.7 (+1) | **277 ✗** |
| B3 | 1 | 146.83 | 147.2 (+4) | 147.1 (+3) | 146.3 (-7) |
| C4 | 1 | 155.56 | 155.5 (-1) | 155.2 (-4) | 155.4 (-2) |
| C#4 | 1 | 164.81 | 164.8 (-0) | 164.9 (+1) | 164.9 (+1) |
| D4 | 1 | 174.61 | 174.9 (+2) | 175.4 (+8) | 175.7 (+11) |
| Eb4 | 1 | 185.00 | 184.8 (-2) | 184.9 (-1) | 185.0 (-0) |
| E4 | 1 | 196.00 | 195.5 (-4) | 195.7 (-3) | 195.7 (-3) |
| F4 | 1 | 207.65 | 207.4 (-2) | 207.7 (+0) | 207.9 (+2) |
| F#4 | 1 | 220.00 | 219.2 (-6) | 219.6 (-3) | 220.0 (+0) |
| G4 | 1 | 233.08 | 233.0 (-0) | 233.1 (+0) | 233.2 (+1) |
| G#4 | 1 | 246.94 | 247.3 (+2) | 247.2 (+2) | 247.2 (+2) |
| A4 | 1 | 261.63 | 261.8 (+1) | 261.5 (-1) | 261.4 (-1) |
| Bb4 | 1 | 277.18 | 277.1 (-0) | 276.9 (-2) | 276.9 (-2) |
| B4 | 1 | 293.67 | 293.5 (-1) | 293.4 (-2) | 293.5 (-1) |
| C5 | 1 | 311.13 | 310.2 (-5) | 311.0 (-1) | 311.8 (+3) |
| C#5 | 1 | 329.63 | 328.9 (-4) | 329.3 (-2) | 330.1 (+2) |
| D5 | 2 | 349.23 | 352.0 (+14) | 352.4 (+16) | 353.0 (+19) |
| Eb5 | 2 | 369.99 | 374.8 (+22) | 373.9 (+18) | 373.5 (+16) |
| E5 | 2 | 392.00 | 396.1 (+18) | 395.4 (+15) | 394.9 (+13) |
| F5 | 2 | 415.31 | 418.5 (+13) | 417.8 (+10) | 417.0 (+7) |
| F#5 | 2 | 440.00 | 440.5 (+2) | 441.0 (+4) | 441.3 (+5) |
| G5 | 2 | 466.16 | 466.4 (+1) | 466.7 (+2) | 466.5 (+1) |
| G#5 | 2 | 493.88 | 494.8 (+3) | 495.0 (+4) | 494.7 (+3) |
| A5 | 2 | 523.25 | 529.5 (+21) | 529.9 (+22) | 529.7 (+21) |
| Bb5 | 2 | 554.37 | 556.3 (+6) | 557.2 (+9) | 557.9 (+11) |
| B5 | 2 | 587.33 | 586.4 (-3) | 587.0 (-1) | 588.4 (+3) |
| C6 | 2 | 622.25 | 617.3 (-14) | 618.7 (-10) | 620.7 (-4) |
| C#6 | 2 | 659.25 | 656.2 (-8) | 658.7 (-1) | 661.0 (+4) |
| D6 | 2 | 698.46 | 694.9 (-9) | 699.1 (+2) | 701.1 (+7) |
| Eb6 | 2 | 739.99 | 738.3 (-4) | 739.8 (-0) | 742.1 (+5) |
| E6 | 2 | 783.99 | 781.6 (-5) | 784.6 (+1) | 786.6 (+6) |
| F6 | 2 | 830.61 | 828.2 (-5) | 830.2 (-1) | 831.8 (+3) |
| F#6 | 2 | 880.00 | 847.4 (-65) | 849.4 (-61) | 850.9 (-58) |

assist 0.5: worst in-register error reg1 11 c (D4), reg2 65 c (F#6); wrong register / silent: 1 of 99 cells.

#### Onset thresholds (assist 0, constant pressure from rest)

| note | onset kPa | extinction kPa (slow decrescendo) |
|---|---|---|
| Bb3 | 2.450 | 1.175 |
| D4 | 2.409 | 1.538 |
| G4 | 2.355 | 1.533 |
| C#5 | 2.346 | 1.818 |
| D5 | 2.397 | 2.270 |
| G5 | 2.401 | 2.302 |
| D6 | 2.394 | 2.291 |


**Summary vs exit criteria**

| criterion | target | assist 0 (pure physics) | assist 0.5 (default) |
|---|---|---|---|
| right register, all 33 fingerings × 3.0/3.5/4.0 kPa | 99/99 | 93/99 ✘ (C4@3.5, C#4@3.5/4, G5@3, G#5@3, F#6@3) | 98/99 (Bb3 overblows @4 kPa) |
| register-1 pitch (in register) | ±10 c | ±7 c ✔ | ±11 c (D4 +11 @4 kPa) |
| register-2 pitch (in register) | ±20 c | D5–F6 within ±20 ✔; **F#6 −64 c ✘** | same; F#6 −65 c ✘ |
| onset threshold | 2–3 kPa (ideally 2–2.5) | 2.35–2.45 kPa ✔ | — |

F#6 remains a geometry limit (palm/side holes at the top of the body, enlarged to 0.92 of the bore).

## 3. Dynamics (pp, crescendo, brightening) — NOT met

Slow crescendo 0→6 kPa then decrescendo (`engine/examples/dyn.rs`), assist 0:

| note | onset (up) | AC p_mp at onset | 4 kPa | 6 kPa | lowest stable (down) | mean flow (playing) | centroid 3 → 6 kPa |
|---|---|---|---|---|---|---|---|
| G4 | 2.6–3.0 kPa | 2.6 kPa (0.9 p_lung) | 5.0 kPa | 6.3 kPa | 1.5 kPa, 2.2 kPa AC (−6 dB) | 0.15–0.23 L/s ✔ | 1.77 → 1.44 kHz (darker, ✘) |
| C5 | 2.6–3.0 kPa | 3.7 kPa | 4.7 kPa | 6.3 kPa | 1.5 kPa, 0.7 kPa AC (−13 dB) | 0.16–0.18 L/s ✔ | 1.71 → 1.64 kHz (✘) |

Level span over the playable range is only ~6–13 dB (real alto: ~25–35 dB pp→ff), the onset is
abrupt with hysteresis, and the spectrum does not brighten. Mean flow is realistic.

**First-principles diagnosis** (`tools/hb_bifurcation.py`: harmonic balance of the elementary
model — quasi-static reed, Bernoulli flow — on the TMM impedance including reed compliance):

* Notes with Z1 > Z2 (G#4 and above): the Hopf bifurcation is **inverse** in the model itself.
  γ = p_mouth/p_M at A1 = 0.003…0.2 p_M for C5: 0.356, 0.356, 0.348, 0.326, 0.302, 0.280, 0.280 (falls
  → subcritical). Removing the impedance at 2ω makes it **direct** (0.356 → 0.416); mirroring
  Z(2ω) to the other side of the 2nd peak (2nd resonance sharp of 2f1) makes it nearly direct. So the
  hard onset is the classic conical-bore mechanism: the quadratic term of the flow characteristic ×
  the strong, nearly harmonic 2nd resonance (Grand, Gilbert & Laloë 1997; Dalmont, Gilbert &
  Kergomard 2000; Ollivier et al. 2004/2005). Artificial-mouth experiments on saxophones do show
  hysteresis; players obtain pp by changing the embouchure (smaller ζ and p_M), not by p_mouth alone.
* Notes with Z2 ≥ Z1 (Bb3…G4 — TMM incl. reed: Bb3 42/63, G4 85/90 MPa·s/m³): the 2nd resonance has the
  lower linear threshold, so the small-amplitude regime is the **octave** (G4 starts at 461 Hz, 450 Pa,
  then jumps to the fundamental at large amplitude). This is also the low-note "cracking" musicians
  know; the truncated-cone factor (kx₀)²/(1+(kx₀)²) makes the first peak of low notes weaker than the next.
* Candidate physics changes tested (engine, `dyn.rs`; HB): vena contracta 0.35–0.7 (ζ ↓); lip force
  0.6–2.2 N; tip opening 1.4 mm; bore losses ×2; channel inertia ℓ = 4 mm; tract off; lip damping 1.0;
  h-dependent vena contracta α(1 ± b·x) (b = −0.5…1.5); viscous cut-off at small h; chamber size 0–0.5
  (2nd-peak inharmonicity) — **none** produced a direct bifurcation of the fundamental. A firmer lip
  (2.2 N) does give lower levels (−10 dB) but on the octave for G4. No change was shipped for
  dynamics: every candidate either broke register locking or was not physically better founded than the
  current model.
* Most promising next steps (PHYSICS.md §6/§5): (1) a dynamic embouchure in the player model —
  pp = firmer/closer lip (lower p_M and ζ) with more lip damping, ff = open — which is how players control
  dynamics; it needs a fingering-dependent safeguard for Z2 ≥ Z1 notes; (2) a reed–lip contact model
  with distributed lip mass (Chatziioannou & van Walstijn) whose damping grows with amplitude; (3) a
  flow model with partial pressure recovery calibrated on quasi-static measurements
  (Dalmont, Gilbert & Ollivier 2003) for a saxophone mouthpiece.

## 4. Embouchure / tract pitch sensitivity (assist 0, 3.5 kPa; cents re ET; — = wrong register)

| control | values | A4 | C#5 | C#6 |
|---|---|---|---|---|
| lip_force | 0.6 / 1.0 / 1.4 / 2.0 | -5 / -2 / +1 / — | -14 / -5 / +4 / +13 | -23 / -9 / +8 / +28 |
| lip_position | 8 / 12 / 16 / 20 | — / -2 / -14 / -23 | — / -5 / -17 / -30 | — / -9 / -26 / -50 |
| jaw_open | 0.1 / 0.3 / 0.6 / 0.9 | -3 / -2 / -1 / -0 | -5 / -5 / -4 / -4 | -12 / -9 / -6 / -4 |
| tongue_y | 0.2 / 0.4 / 0.7 / 1.0 | -2 / -2 / -4 / -7 | -4 / -5 / -9 / -6 | -8 / -9 / -10 / +7 |
| tongue_x (tongue_y=1) | 0.5 / 0.35 / 0.25 / 0.15 / 0.05 | -7 / -21 / -29 / -26 / -11 | -6 / -11 / -54 / -55 / -38 | +7 / — / — / -250 / -148 |
| lip_damping | 0.1 / 0.4 / 0.8 | +0 / -2 / -6 | -4 / -5 / -9 | -8 / -9 / -15 |
| reed_strength | 2.0 / 2.5 / 3.5 | -5 / -2 / +4 | -6 / -5 / -0 | -8 / -9 / +2 |


Literature: jaw vibrato ±10–20 c; "lipping" a few tens of cents in the low register, more in the
upper register; bends of a semitone or more in the 2nd register and above need vocal-tract tuning
(Chen, Smith & Wolfe 2009, 2011; Scavone et al. 2008). **Met**: tract bends C#6 by −150…−250 c and
C#5 by −55 c; lip force gives ±14–28 c for C#5/C#6. **Not met**: low/middle register (A4) responds only
±5 c to lip force and −23 c to lip position; in the model this comes almost entirely through the reed
equivalent volume (V_r ≈ 1.1 cm³ ≈ 15 cents at G4), which the lip changes by only ~20 %.

## 5. Altissimo — NOT met

* Tract: soft-wall loss multiplier reduced 10 → 3 (formant-bandwidth-like resonances); a high front
  tongue now gives tract peaks of 15–55 MPa·s/m³ tunable from ~0.45 to 1.25 kHz with tongue_x
  (`tools/tract_tmm.py`, `engine/examples/tractz.rs`).
* Fingerings: `tools/altissimo_search.py` searched 1091 distinct pad configurations: the best bore
  peaks at written G6 (932 Hz) / A6 (1047 Hz) are only 0.2–0.3 × the largest lower bore peak
  (e.g. G6: OCT+LH1+BIS+G# — 22 MPa·s/m³ at 902 Hz vs 80 at 573 Hz). Even with Z_tract added in series
  the lower regime has the larger |Z_b + Z_t| (e.g. 53 vs 86 MPa·s/m³).
* Engine: with tongue_y 0.95–1.0, tongue_x 0–0.25, lip force 1–2.2 N, lip position 12–22 mm, low
  lip/reed damping, 5 kPa: **no regime above 800 Hz** on those fingerings (they play 550–625 Hz).
  Tract tuning does bend high 2nd-register notes by ≥100 cents (C#6 −150…−250 c, D6 −126 c), but
  register-1 high notes only by ≤55 c (target ≥100 ✘).
* Probable missing ingredients: stronger suppression of the lower resonances in real cross/vented
  altissimo fingerings (our octave vents and holes are linear and nearly lossless), and reed-resonance
  assistance (an altissimo embouchure raises and sharpens the reed resonance toward ~2 kHz).

## 6. Geometry design history (wave 2)

* **Harmonicity** (Benade criterion; `design_harmonicity.py`): f2/(2f1) of the register-1
  fingerings went from −40…+20 cents to −14…+15 cents (neck taper exponent 0.66, neck entry ID
  10.4 mm, mouthpiece baffle r 6.6 mm / chamber r 9.3 mm (11.3 cm³), bell flare 0.285 m long,
  exponent 5.6).
* **Spherical-wave bell**: in the flare the equivalent-area radius is the spherical cap through the
  wall circle normal to the wall, r·√(2/(1+cos θ)) (Benade & Jansson 1974); both TMM and engine use it
  through `profile`. `body.wall_profile` holds the physical wall radius for drawing.
* **Octave vents** (engine scans): neck vent x = 0.090 m, r = 1.4 mm (closer to the mouthpiece:
  this is what made the palm notes D6–F6 lock into register 2; r = 1.4 instead of 1.5–1.8 keeps
  A5 within +22 cents); body vent x = 0.266 m (top of the body), r = 1.8 mm. Larger vents / longer
  chimneys made things worse (vented first peak *grows* with vent size because the truncated-cone
  peaks rise with frequency).
* **Engine-in-the-loop tuning** of every tone hole and the bell end (`engine_loop.py tune`).
* **3D**: the drawn bell tube is now 0.30 m long (rim centre 0.36 m above the bow, realistic alto
  proportions) while `centerline_s` keeps the acoustic coordinate; map x → 3D through
  `centerline_s`, not 3D arc length.

### TMM vs engine (same geometry)

TMM |Z| peak − ET for the engine-tuned geometry (positive = TMM predicts sharper than the engine plays):

| written | sounding | reg | target Hz | TMM Hz | cents | mode | |Z| peak (MPa·s/m³) | keys |
|---|---|---|---|---|---|---|---|---|
| Bb3 | C#3 | 1 | 138.59 | 137.91 | -8.5 | 1 | 41.7 | LH1 LH2 LH3 RH1 RH2 RH3 LH_Bb |
| B3 | D3 | 1 | 146.83 | 147.39 | +6.6 | 1 | 47.2 | LH1 LH2 LH3 RH1 RH2 RH3 LH_B |
| C4 | Eb3 | 1 | 155.56 | 155.07 | -5.5 | 1 | 51.0 | LH1 LH2 LH3 RH1 RH2 RH3 RH_C |
| C#4 | E3 | 1 | 164.81 | 164.00 | -8.6 | 1 | 55.0 | LH1 LH2 LH3 RH1 RH2 RH3 LH_Cs |
| D4 | F3 | 1 | 174.61 | 175.99 | +13.6 | 1 | 59.8 | LH1 LH2 LH3 RH1 RH2 RH3 |
| Eb4 | F#3 | 1 | 185.00 | 184.45 | -5.1 | 1 | 64.1 | LH1 LH2 LH3 RH1 RH2 RH3 RH_Eb |
| E4 | G3 | 1 | 196.00 | 195.64 | -3.2 | 1 | 68.5 | LH1 LH2 LH3 RH1 RH2 |
| F4 | G#3 | 1 | 207.65 | 206.62 | -8.6 | 1 | 73.8 | LH1 LH2 LH3 RH1 |
| F#4 | A3 | 1 | 220.00 | 219.82 | -1.4 | 1 | 79.2 | LH1 LH2 LH3 RH2 |
| G4 | Bb3 | 1 | 233.08 | 231.79 | -9.6 | 1 | 85.2 | LH1 LH2 LH3 |
| G#4 | B3 | 1 | 246.94 | 246.12 | -5.8 | 1 | 91.3 | LH1 LH2 LH3 LH_Gs |
| A4 | C4 | 1 | 261.63 | 262.35 | +4.8 | 1 | 97.0 | LH1 LH2 |
| Bb4 | C#4 | 1 | 277.18 | 278.53 | +8.4 | 1 | 103.7 | LH1 BIS |
| B4 | D4 | 1 | 293.67 | 296.31 | +15.5 | 1 | 110.1 | LH1 |
| C5 | Eb4 | 1 | 311.13 | 313.46 | +12.9 | 1 | 114.2 | LH2 |
| C#5 | E4 | 1 | 329.63 | 329.92 | +1.5 | 1 | 120.1 |  |
| D5 | F4 | 2 | 349.23 | 358.29 | +44.3 | 2 | 88.2 | OCT LH1 LH2 LH3 RH1 RH2 RH3 |
| Eb5 | F#4 | 2 | 369.99 | 374.18 | +19.5 | 2 | 91.3 | OCT LH1 LH2 LH3 RH1 RH2 RH3 RH_Eb |
| E5 | G4 | 2 | 392.00 | 394.85 | +12.6 | 2 | 87.4 | OCT LH1 LH2 LH3 RH1 RH2 |
| F5 | G#4 | 2 | 415.31 | 417.52 | +9.2 | 2 | 86.2 | OCT LH1 LH2 LH3 RH1 |
| F#5 | A4 | 2 | 440.00 | 444.47 | +17.5 | 2 | 79.0 | OCT LH1 LH2 LH3 RH2 |
| G5 | Bb4 | 2 | 466.16 | 472.12 | +22.0 | 2 | 77.4 | OCT LH1 LH2 LH3 |
| G#5 | B4 | 2 | 493.88 | 504.40 | +36.5 | 2 | 72.0 | OCT LH1 LH2 LH3 LH_Gs |
| A5 | C5 | 2 | 523.25 | 547.03 | +77.0 | 2 | 80.4 | OCT LH1 LH2 |
| Bb5 | C#5 | 2 | 554.37 | 571.90 | +53.9 | 2 | 79.9 | OCT LH1 BIS |
| B5 | D5 | 2 | 587.33 | 599.54 | +35.6 | 2 | 76.7 | OCT LH1 |
| C6 | Eb5 | 2 | 622.25 | 628.17 | +16.4 | 2 | 67.8 | OCT LH2 |
| C#6 | E5 | 2 | 659.25 | 667.60 | +21.8 | 2 | 64.5 | OCT |
| D6 | F5 | 2 | 698.46 | 707.84 | +23.1 | 2 | 56.8 | OCT LH_palm_D |
| Eb6 | F#5 | 2 | 739.99 | 749.07 | +21.1 | 2 | 49.9 | OCT LH_palm_D LH_palm_Eb |
| E6 | G5 | 2 | 783.99 | 793.74 | +21.4 | 2 | 43.5 | OCT LH_palm_D LH_palm_Eb RH_side_E |
| F6 | G#5 | 2 | 830.61 | 841.05 | +21.6 | 2 | 37.6 | OCT LH_palm_D LH_palm_Eb RH_side_E LH_palm_F |
| F#6 | A5 | 2 | 880.00 | 861.42 | -37.0 | 2 | 35.9 | OCT LH_palm_D LH_palm_Eb RH_side_E LH_palm_F RH_high_Fs |

Register 1: TMM ≈ engine ± 12 cents (sign varies: this is the nonlinear playing-frequency shift
vs the impedance peak — inharmonic upper peaks pull the playing frequency). Register 2: the engine
plays 15–78 cents below the vented TMM peak (largest for A5/Bb5 on the neck vent): the nonlinear
jet loss in the narrow vent and the reed's compliance near its resonance flatten the overblown
notes. TMM alone is therefore not sufficient for register-2 tuning — always close the loop with the
engine.
