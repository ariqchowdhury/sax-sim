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

## 2. Engine-measured results (final, round 4: lip model final, Strouhal jet loss, glottal tract section)

Native renderer, default embouchure (lip_position 12 mm, lip_force 1 N, reed_strength 2.5,
tract on, lumped reed), 50 ms pressure attack, f0 of the last 0.5 s of a 1.5 s note; ✗ = wrong
register or silent. Geometry tuned with `tools/engine_loop.py tune --set player_assist=0`.
Regenerate with `SAX_RENDER=... python3 tools/validation_report.py`.

#### player_assist = 0

| written | reg | target Hz | 3.0 kPa f0 (cents) | 3.5 kPa f0 (cents) | 4.0 kPa f0 (cents) |
|---|---|---|---|---|---|
| Bb3 | 1 | 138.59 | 138.7 (+2) | **277 ✗** | 138.4 (-2) |
| B3 | 1 | 146.83 | 147.5 (+8) | 146.7 (-1) | 146.2 (-8) |
| C4 | 1 | 155.56 | 155.5 (-0) | **310 ✗** | **311 ✗** |
| C#4 | 1 | 164.81 | 165.0 (+2) | 164.6 (-2) | 164.8 (-1) |
| D4 | 1 | 174.61 | 175.4 (+8) | 174.1 (-6) | 174.5 (-2) |
| Eb4 | 1 | 185.00 | 184.8 (-1) | 185.0 (+0) | 185.2 (+2) |
| E4 | 1 | 196.00 | 195.8 (-2) | 196.1 (+0) | 196.3 (+3) |
| F4 | 1 | 207.65 | 207.4 (-2) | 207.7 (-0) | 207.9 (+2) |
| F#4 | 1 | 220.00 | 219.7 (-2) | 220.1 (+0) | 220.4 (+3) |
| G4 | 1 | 233.08 | 233.1 (+0) | 233.1 (+0) | 233.1 (+0) |
| G#4 | 1 | 246.94 | 247.1 (+1) | 246.9 (-0) | 246.8 (-1) |
| A4 | 1 | 261.63 | 261.6 (-0) | 261.6 (-0) | 261.6 (-0) |
| Bb4 | 1 | 277.18 | 277.1 (-0) | 277.2 (-0) | 277.3 (+1) |
| B4 | 1 | 293.67 | 293.7 (+0) | 293.6 (-1) | 293.8 (+1) |
| C5 | 1 | 311.13 | 310.3 (-4) | 310.9 (-1) | 311.6 (+2) |
| C#5 | 1 | 329.63 | 329.2 (-2) | 329.5 (-1) | 330.1 (+2) |
| D5 | 2 | 349.23 | 350.3 (+5) | 351.5 (+11) | 352.4 (+16) |
| Eb5 | 2 | 369.99 | 374.9 (+23) | 374.3 (+20) | 373.6 (+17) |
| E5 | 2 | 392.00 | 396.3 (+19) | 395.9 (+17) | 395.3 (+14) |
| F5 | 2 | 415.31 | 418.7 (+14) | 418.3 (+12) | 417.3 (+8) |
| F#5 | 2 | 440.00 | 440.6 (+2) | 441.0 (+4) | 441.2 (+5) |
| G5 | 2 | 466.16 | **251 ✗** | 466.2 (+0) | 466.2 (+0) |
| G#5 | 2 | 493.88 | **269 ✗** | 494.0 (+0) | 493.9 (+0) |
| A5 | 2 | 523.25 | 528.9 (+19) | 528.7 (+18) | 528.7 (+18) |
| Bb5 | 2 | 554.37 | 554.8 (+1) | 556.2 (+6) | 557.0 (+8) |
| B5 | 2 | 587.33 | 583.8 (-10) | 585.3 (-6) | 586.6 (-2) |
| C6 | 2 | 622.25 | 614.3 (-22) | 616.2 (-17) | 618.2 (-11) |
| C#6 | 2 | 659.25 | 656.9 (-6) | 657.0 (-6) | 659.1 (-0) |
| D6 | 2 | 698.46 | 698.7 (+1) | 697.2 (-3) | 699.3 (+2) |
| Eb6 | 2 | 739.99 | 740.9 (+2) | 738.4 (-4) | 740.7 (+2) |
| E6 | 2 | 783.99 | 785.1 (+2) | 781.9 (-5) | 784.6 (+1) |
| F6 | 2 | 830.61 | 831.6 (+2) | 829.1 (-3) | 830.3 (-1) |
| F#6 | 2 | 880.00 | 850.6 (-59) | 848.4 (-63) | 849.6 (-61) |

assist 0: worst in-register error reg1 8 c (B3), reg2 63 c (F#6); wrong register / silent: 5 of 99 cells.

#### player_assist = 0.5

| written | reg | target Hz | 3.0 kPa f0 (cents) | 3.5 kPa f0 (cents) | 4.0 kPa f0 (cents) |
|---|---|---|---|---|---|
| Bb3 | 1 | 138.59 | 138.5 (-1) | 138.1 (-6) | **275 ✗** |
| B3 | 1 | 146.83 | 147.1 (+4) | 146.0 (-9) | 146.2 (-7) |
| C4 | 1 | 155.56 | 155.3 (-3) | 155.2 (-4) | 155.6 (+1) |
| C#4 | 1 | 164.81 | 164.7 (-1) | 164.8 (-0) | 164.7 (-1) |
| D4 | 1 | 174.61 | 174.9 (+3) | 175.5 (+8) | 175.6 (+9) |
| Eb4 | 1 | 185.00 | 184.8 (-1) | 184.9 (-1) | 184.8 (-2) |
| E4 | 1 | 196.00 | 195.5 (-5) | 195.8 (-2) | 195.8 (-2) |
| F4 | 1 | 207.65 | 207.4 (-2) | 207.7 (-0) | 207.9 (+2) |
| F#4 | 1 | 220.00 | 219.1 (-7) | 219.6 (-3) | 220.0 (+0) |
| G4 | 1 | 233.08 | 232.7 (-3) | 232.8 (-2) | 232.5 (-5) |
| G#4 | 1 | 246.94 | 246.6 (-2) | 245.5 (-10) | 246.5 (-3) |
| A4 | 1 | 261.63 | 261.0 (-4) | 260.6 (-7) | 260.7 (-6) |
| Bb4 | 1 | 277.18 | 276.7 (-3) | 276.1 (-7) | 276.1 (-7) |
| B4 | 1 | 293.67 | 292.9 (-4) | 293.4 (-2) | 293.4 (-2) |
| C5 | 1 | 311.13 | 309.8 (-8) | 310.8 (-2) | 311.6 (+2) |
| C#5 | 1 | 329.63 | 328.5 (-6) | 329.0 (-3) | 330.1 (+2) |
| D5 | 2 | 349.23 | 352.4 (+16) | 352.8 (+18) | 353.1 (+19) |
| Eb5 | 2 | 369.99 | 375.2 (+24) | 374.5 (+21) | 373.9 (+18) |
| E5 | 2 | 392.00 | 396.6 (+20) | 396.1 (+18) | 395.4 (+15) |
| F5 | 2 | 415.31 | 419.1 (+16) | 418.5 (+13) | 417.4 (+9) |
| F#5 | 2 | 440.00 | 441.4 (+6) | 441.6 (+6) | 441.9 (+7) |
| G5 | 2 | 466.16 | 467.3 (+4) | 467.1 (+3) | 467.0 (+3) |
| G#5 | 2 | 493.88 | 495.6 (+6) | 495.4 (+5) | 495.7 (+6) |
| A5 | 2 | 523.25 | 529.1 (+19) | 529.8 (+22) | 529.7 (+21) |
| Bb5 | 2 | 554.37 | 556.4 (+6) | 557.6 (+10) | 558.3 (+12) |
| B5 | 2 | 587.33 | 586.0 (-4) | 586.9 (-1) | 588.1 (+2) |
| C6 | 2 | 622.25 | 616.3 (-17) | 618.0 (-12) | 619.8 (-7) |
| C#6 | 2 | 659.25 | 656.8 (-6) | 658.6 (-2) | 660.6 (+4) |
| D6 | 2 | 698.46 | 697.1 (-3) | 699.8 (+3) | 701.5 (+8) |
| Eb6 | 2 | 739.99 | 740.1 (+0) | 740.9 (+2) | 742.5 (+6) |
| E6 | 2 | 783.99 | 785.2 (+3) | 785.5 (+3) | 787.7 (+8) |
| F6 | 2 | 830.61 | 831.3 (+1) | 832.3 (+4) | 833.4 (+6) |
| F#6 | 2 | 880.00 | 850.5 (-59) | 851.6 (-57) | 853.1 (-54) |

assist 0.5: worst in-register error reg1 10 c (G#4), reg2 59 c (F#6); wrong register / silent: 1 of 99 cells.

#### Onset thresholds (assist 0, constant pressure from rest)

| note | onset kPa | extinction kPa (slow decrescendo) |
|---|---|---|
| Bb3 | 2.450 | 1.175 |
| D4 | 2.409 | 1.513 |
| G4 | 2.353 | 1.529 |
| C#5 | 2.343 | 1.790 |
| D5 | 2.392 | 2.263 |
| G5 | 2.397 | 2.295 |
| D6 | 2.389 | 2.284 |


**Summary vs exit criteria**

| criterion | target | assist 0 (pure physics) | assist 0.5 (default) |
|---|---|---|---|
| right register, 33 fingerings × 3.0/3.5/4.0 kPa | 99/99 | 94/99 ✘ (Bb3, C4, G5, G#5 at single pressures) | 98/99 (Bb3 overblows @4 kPa) |
| register-1 pitch (in register) | ±10 c | ±8 c ✔ | ±10 c ✔ |
| register-2 pitch (in register) | ±20 c | D5–F6 within ±20 ✔; **F#6 −60…−63 c ✘** | same |
| onset threshold | 2–3 kPa | 2.34–2.45 kPa ✔ | — |

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
| lip_force | 0.6 / 1.0 / 1.4 / 2.0 | -12 / -0 / +6 / — | -16 / -1 / +14 / +25 | -32 / -6 / +18 / +39 |
| lip_position | 8 / 12 / 16 / 20 | — / -0 / — / -15 | — / -1 / -9 / -66 | — / -6 / -20 / -40 |
| jaw_open | 0.1 / 0.3 / 0.6 / 0.9 | -2 / -0 / +1 / +2 | -1 / -1 / -0 / +0 | -9 / -6 / -3 / -2 |
| tongue_y | 0.2 / 0.4 / 0.7 / 1.0 | +0 / -0 / -3 / -4 | -0 / -1 / -5 / -1 | -5 / -6 / -6 / +10 |
| tongue_x (tongue_y=1) | 0.5 / 0.35 / 0.25 / 0.15 / 0.05 | -4 / -20 / -29 / -26 / -10 | -1 / -6 / -49 / -52 / -34 | +10 / +8 / — / -248 / -145 |
| lip_damping | 0.1 / 0.4 / 0.8 | +2 / -0 / -4 | +0 / -1 / -4 | -6 / -6 / -11 |
| reed_strength | 2.0 / 2.5 / 3.5 | -2 / -0 / +2 | -0 / -1 / -0 | -3 / -6 / -10 |

Literature: jaw vibrato ±10–20 c; "lipping" a few tens of cents in the low register, more in the
upper register; bends of a semitone or more in the 2nd register and above need vocal-tract tuning
(Chen, Smith & Wolfe 2009, 2011; Scavone et al. 2008). With the final lip-tissue model (DSP programmer, round 4: lip provides ~85 % of
the tip stiffness, strain-stiffening with lip force): lip force 0.6 → 1.4 N moves A4 −12…+6 c, C#5
−16…+14 c, C#6 −32…+18 c (jaw-vibrato range ✔); lip position 12 → 20 mm −15…−66 c; tract bends C#6 by
−145…−248 c and C#5 by −52 c ✔. Low-register lipping (A4) is still on the small side.

## 5. Altissimo — G6, G#6, A6 sound with a tuned tract (round 4)

Fingerings (common published alto charts, in `alternate_fingerings` with `register: 3` and the per-note
`tract` setting): G6 = 8va + front F + LH1 + LH3; G#6 = same + G#; A6 = 8va + LH2 + RH1.
Altissimo embouchure: lip_force 1.8 N, lip_position 11 mm, lip_damping 0.2, reed_damping 0.1,
glottis_open 0.05 (A_g ≈ 0.15 cm²), jaw 0.15, high front tongue. Tract settings found by
`tools/altissimo_tune.py` (engine in the loop):

```
G6 (932.3 Hz) keys OCT,LH_front_F,LH1,LH3: tract tongue_y=0.96 tongue_x=0.06 jaw=0.15
   tuned  : 3.0 kPa 384 Hz (-1534 c, 3078 Pa)  3.5 kPa 386 Hz (-1527 c, 3641 Pa)  4.0 kPa 893 Hz (-74 c, 847 Pa)  5.0 kPa 962 Hz (+54 c, 437 Pa)
   neutral tract, altissimo embouchure: 3.5 kPa 2179 Hz  5.0 kPa 388 Hz
   neutral tract, default embouchure  : 3.5 kPa 382 Hz  5.0 kPa 383 Hz
G#6 (987.8 Hz) keys OCT,LH_front_F,LH1,LH3,LH_Gs: tract tongue_y=0.96 tongue_x=0.02 jaw=0.15
   tuned  : 3.0 kPa 386 Hz (-1625 c, 3061 Pa)  3.5 kPa 949 Hz (-69 c, 525 Pa)  4.0 kPa 953 Hz (-63 c, 742 Pa)  5.0 kPa 1027 Hz (+68 c, 367 Pa)
   neutral tract, altissimo embouchure: 3.5 kPa 2184 Hz  5.0 kPa 388 Hz
   neutral tract, default embouchure  : 3.5 kPa 383 Hz  5.0 kPa 384 Hz
A6 (1046.5 Hz) keys OCT,LH2,RH1: tract tongue_y=0.93 tongue_x=0.03 jaw=0.15
   tuned  : 3.0 kPa 374 Hz (-1784 c, 1328 Pa)  3.5 kPa 378 Hz (-1763 c, 766 Pa)  4.0 kPa 1063 Hz (+27 c, 288 Pa)  5.0 kPa 1075 Hz (+47 c, 319 Pa)
   neutral tract, altissimo embouchure: 3.5 kPa 2160 Hz  5.0 kPa 629 Hz
   neutral tract, default embouchure  : 3.5 kPa 612 Hz  5.0 kPa 617 Hz
```

* **Met**: G6, G#6 and A6 sound in the altissimo regime at 4–5 kPa with the tuned tract, and do **not**
  sound with a neutral tract (same fingering plays its low bore regime, 383–630 Hz) — the real-world
  contrast. A6 also sounds at 4 kPa (+27 c).
* **Not met**: they do not sound at 3–3.5 kPa (low regime or reed squeal at 2.2 kHz with the low-damping
  embouchure); intonation is pressure-dependent (≈ ±60 c between 4 and 5 kPa; +40…+55 c at 4.5 kPa with the
  best tongue setting on a 0.01 grid). The regime is tract-dominated: its pitch follows the tongue more
  than the fingering (fingering changes move it by < 50 c).
* "Altissimo" preset added to `presets` (tract set for G#6).

### What altissimo physics turned out to matter (for docs/ALTISSIMO.md)

The reed is driven by Δp = p_mouth − p_mp, so the flow sees the vocal tract and the bore **in series**,
and the reed's own compliance and damping **in parallel** with that sum:
Z_load = 1 / (1/(Z_bore + Z_tract) + Y_reed), Y_reed = jωC_r/(1 − ω²/ω_r² + jqω/ω_r), C_r = V_r/ρc².
Three things had to be right before a tract resonance could select a ~1 kHz regime against the bore's
strong 380–640 Hz resonances:
1. **Reed compliance and damping at 1 kHz.** With V_r ≈ 1.1 cm³ the reed shunt is ~21 MPa·s/m³ at 1 kHz and
   its damping adds a parallel loss of ~60 MPa·s/m³ — enough to cut a 90 MPa·s/m³ series peak to ~40. The
   altissimo embouchure (firm lip → the strain-stiffened lip raises K, halving V_r; a little less
   mouthpiece; low lip/reed damping) restores the high-frequency load. This was the decisive factor.
2. **A reflective glottal end.** An open glottis loaded by the trachea is nearly anechoic (R ≈ ρc/S ≈ Z_c of
   the larynx) and caps tract peaks at ~35–55 MPa·s/m³; modelling the glottis as the first tract section
   (A_g, ~4–5 mm long, i.e. with its inertance) and narrowing it to ~0.15 cm² raises the high-front-tongue
   peak near 1 kHz to ~85 MPa·s/m³ (engine/examples/tractz.rs), consistent with the "tens of MPa·s/m³" that
   Chen, Smith & Wolfe measured on expert players.
3. **Tract tuning range.** A high front tongue (tongue_y 0.93–0.97, constriction ≈ 0.1 cm² near the hard
   palate, small jaw opening) places the resonance between ~0.9 and 1.2 kHz; tongue_x fine-tunes it.
   Soft-wall losses at ×3 the boundary-layer value (round 3) keep formant-like bandwidths.
Bore-side changes mattered little: the nonlinear (jet) losses at open holes and vents (§7) damp the
low regime by < 1 dB and do not change which regime starts; fingerings mainly need to keep the low bore
resonances from being far stronger than ~60 MPa·s/m³.

## 7. Nonlinear (jet) losses at open holes and octave vents (round 4)

Model (radiation.rs/toneholes.rs, PHYSICS.md §3): quasi-steady jet-separation resistance
R_nl = K ρ |U| / (2 S_e²), K = 1, S_e = min(hole area, pad curtain), multiplied by a Strouhal factor
1/(1 + (St/St_c)²), St = ω r / v̂, St_c = 1 (Ingard & Ising 1967; Disselhorst & van Wijngaarden 1980;
Atig, Dalmont & Gilbert 2004; Dalmont et al. 2002). ω and v̂ come from running mean squares of the branch
flow and its derivative (τ = 5 ms, refreshed every 64 steps). R_nl ≥ 0 is frozen within a step → the
joint node/branch update stays passive and unconditionally stable (fast path and joint solver identical).

| variant (assist 0, 3.0/3.5/4.0 kPa) | wrong-register cells | register-2 notes failing |
|---|---|---|
| no jet loss (K = 0) | 22/99 | F#5, G5, G#5, E6, F6, F#6 at all pressures; B4, C4, C#4, B5 |
| quasi-steady (K = 1, round 3) | 5/99 | G5, G#5, F#6 @3 kPa; C4 @3.5/4 |
| Strouhal-limited (K = 1, St_c = 1, shipped) | 6/99 → 5/99 after the final retune | G5, G#5 @3 kPa; C4, Bb3 |

The jet loss is essential for register-2 locking (it damps the vented low resonance at large amplitude).
The Strouhal limit mostly switches it off at the large tone holes (St ≫ 1: particle displacement ≪ radius)
and keeps it at the octave vents and small palm holes (r ≈ 1.4–9 mm); F#6 at 3 kPa now locks. Altissimo
fingerings, neutral tract, 5 kPa: low-regime mouthpiece AC 4.13 kPa (no loss) → 3.72 (quasi-steady) →
3.97 kPa (Strouhal): ≤ 1 dB, regime unchanged.

## 8. Geometry design history (wave 2)

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
