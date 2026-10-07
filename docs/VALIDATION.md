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

## 2. Engine-measured results (final, round 7: wall-loss factor 1.3, neck 0.170 m, airway/subglottal, final dynamics)

Native renderer, default embouchure, 50 ms pressure attack, f0 of the last 0.5 s of a 1.5 s note; ✗ = wrong
register or silent. Geometry tuned with `tools/engine_loop.py tune --set player_assist=0` (whole chain:
`bash tools/final_integration.sh`). Regenerate with `SAX_RENDER=... python3 tools/validation_report.py`.

#### player_assist = 0

| written | reg | target Hz | 3.0 kPa f0 (cents) | 3.5 kPa f0 (cents) | 4.0 kPa f0 (cents) |
|---|---|---|---|---|---|
| Bb3 | 1 | 138.59 | 138.8 (+2) | 138.7 (+1) | 138.4 (-3) |
| B3 | 1 | 146.83 | 147.4 (+7) | 146.4 (-5) | 146.7 (-1) |
| C4 | 1 | 155.56 | 156.2 (+6) | 155.1 (-5) | 155.4 (-2) |
| C#4 | 1 | 164.81 | 164.6 (-2) | 164.8 (+0) | 165.0 (+2) |
| D4 | 1 | 174.61 | 174.4 (-2) | 174.6 (+0) | 174.8 (+2) |
| Eb4 | 1 | 185.00 | 184.8 (-2) | 185.0 (+0) | 185.2 (+2) |
| E4 | 1 | 196.00 | 195.6 (-3) | 196.0 (+0) | 196.3 (+3) |
| F4 | 1 | 207.65 | 207.3 (-3) | 207.7 (+0) | 208.0 (+3) |
| F#4 | 1 | 220.00 | 219.7 (-3) | 220.0 (+0) | 220.3 (+3) |
| G4 | 1 | 233.08 | 233.0 (-1) | 233.1 (-0) | 233.2 (+1) |
| G#4 | 1 | 246.94 | 246.6 (-2) | 246.9 (-0) | 247.3 (+2) |
| A4 | 1 | 261.63 | 260.9 (-4) | 261.7 (+0) | 262.3 (+4) |
| Bb4 | 1 | 277.18 | 276.2 (-6) | 277.3 (+1) | 277.9 (+5) |
| B4 | 1 | 293.67 | 293.2 (-2) | 293.6 (-0) | 294.1 (+2) |
| C5 | 1 | 311.13 | 311.2 (+0) | 311.0 (-1) | 311.2 (+0) |
| C#5 | 1 | 329.63 | 329.4 (-1) | 329.5 (-1) | 330.0 (+2) |
| D5 | 2 | 349.23 | 353.0 (+19) | 352.9 (+18) | 352.9 (+18) |
| Eb5 | 2 | 369.99 | 372.5 (+12) | 372.3 (+11) | 372.3 (+11) |
| E5 | 2 | 392.00 | 391.2 (-4) | 391.6 (-2) | 391.7 (-2) |
| F5 | 2 | 415.31 | 412.9 (-10) | 413.4 (-8) | 413.7 (-7) |
| F#5 | 2 | 440.00 | **237 ✗** | 439.1 (-4) | 439.7 (-1) |
| G5 | 2 | 466.16 | **250 ✗** | **250 ✗** | 466.9 (+3) |
| G#5 | 2 | 493.88 | **251 ✗** | 498.2 (+15) | 497.6 (+13) |
| A5 | 2 | 523.25 | 532.4 (+30) | 530.4 (+24) | 529.8 (+22) |
| Bb5 | 2 | 554.37 | 559.8 (+17) | 559.3 (+16) | 559.9 (+17) |
| B5 | 2 | 587.33 | 584.9 (-7) | 586.8 (-2) | 588.9 (+5) |
| C6 | 2 | 622.25 | 617.0 (-15) | 617.6 (-13) | 620.2 (-6) |
| C#6 | 2 | 659.25 | 660.3 (+3) | 660.0 (+2) | 662.4 (+8) |
| D6 | 2 | 698.46 | 699.2 (+2) | 697.3 (-3) | 698.9 (+1) |
| Eb6 | 2 | 739.99 | 742.1 (+5) | 737.5 (-6) | 740.4 (+1) |
| E6 | 2 | 783.99 | 785.3 (+3) | 782.9 (-2) | 783.8 (-0) |
| F6 | 2 | 830.61 | 830.9 (+1) | 830.1 (-1) | 830.8 (+0) |
| F#6 | 2 | 880.00 | **437 ✗** | 877.0 (-6) | 878.0 (-4) |

assist 0: worst in-register error reg1 7 c (B3), reg2 30 c (A5); wrong register / silent: 5 of 99 cells.

#### player_assist = 0.5

| written | reg | target Hz | 3.0 kPa f0 (cents) | 3.5 kPa f0 (cents) | 4.0 kPa f0 (cents) |
|---|---|---|---|---|---|
| Bb3 | 1 | 138.59 | 138.8 (+2) | 138.2 (-5) | 138.4 (-2) |
| B3 | 1 | 146.83 | 146.1 (-9) | 146.1 (-8) | 146.3 (-6) |
| C4 | 1 | 155.56 | 156.1 (+6) | 156.3 (+9) | 155.4 (-2) |
| C#4 | 1 | 164.81 | 164.6 (-2) | 164.7 (-2) | 164.8 (+0) |
| D4 | 1 | 174.61 | 174.3 (-3) | 174.6 (-0) | 174.8 (+2) |
| Eb4 | 1 | 185.00 | 184.8 (-2) | 185.0 (+0) | 184.8 (-2) |
| E4 | 1 | 196.00 | 195.6 (-3) | 196.0 (+0) | 196.2 (+2) |
| F4 | 1 | 207.65 | 207.3 (-3) | 207.7 (+0) | 208.0 (+3) |
| F#4 | 1 | 220.00 | 219.7 (-3) | 220.0 (+0) | 220.3 (+3) |
| G4 | 1 | 233.08 | 233.0 (-1) | 233.1 (-0) | 233.2 (+1) |
| G#4 | 1 | 246.94 | 246.6 (-2) | 246.4 (-4) | 247.3 (+2) |
| A4 | 1 | 261.63 | 260.9 (-4) | 261.7 (+0) | 262.3 (+4) |
| Bb4 | 1 | 277.18 | 276.2 (-6) | 277.1 (-0) | 276.8 (-3) |
| B4 | 1 | 293.67 | 293.2 (-2) | 293.6 (-0) | 294.1 (+2) |
| C5 | 1 | 311.13 | 311.2 (+0) | 311.0 (-1) | 311.2 (+0) |
| C#5 | 1 | 329.63 | 329.4 (-1) | 329.5 (-1) | 330.0 (+2) |
| D5 | 2 | 349.23 | 353.3 (+20) | 353.1 (+19) | 353.2 (+20) |
| Eb5 | 2 | 369.99 | 372.8 (+13) | 372.5 (+12) | 372.7 (+13) |
| E5 | 2 | 392.00 | 391.8 (-1) | 392.0 (+0) | 392.1 (+0) |
| F5 | 2 | 415.31 | 413.5 (-8) | 414.0 (-6) | 414.2 (-4) |
| F#5 | 2 | 440.00 | 439.4 (-2) | 439.8 (-1) | 440.3 (+1) |
| G5 | 2 | 466.16 | 470.4 (+16) | 467.4 (+5) | 467.5 (+5) |
| G#5 | 2 | 493.88 | 501.0 (+25) | 498.9 (+18) | 498.1 (+15) |
| A5 | 2 | 523.25 | 533.1 (+32) | 531.2 (+26) | 530.4 (+24) |
| Bb5 | 2 | 554.37 | 560.9 (+20) | 560.5 (+19) | 560.9 (+20) |
| B5 | 2 | 587.33 | 586.5 (-2) | 588.4 (+3) | 590.5 (+9) |
| C6 | 2 | 622.25 | 617.2 (-14) | 619.4 (-8) | 621.8 (-1) |
| C#6 | 2 | 659.25 | 660.5 (+3) | 661.4 (+6) | 664.1 (+13) |
| D6 | 2 | 698.46 | 697.6 (-2) | 698.8 (+1) | 701.4 (+7) |
| Eb6 | 2 | 739.99 | 740.2 (+0) | 738.9 (-3) | 741.1 (+3) |
| E6 | 2 | 783.99 | **454 ✗** | 777.6 (-14) | 780.8 (-7) |
| F6 | 2 | 830.61 | 833.4 (+6) | 829.9 (-2) | 831.6 (+2) |
| F#6 | 2 | 880.00 | 882.1 (+4) | 878.4 (-3) | 879.6 (-1) |

assist 0.5: worst in-register error reg1 9 c (B3), reg2 32 c (A5); wrong register / silent: 1 of 99 cells.

#### Onset thresholds (assist 0, constant pressure from rest)

| note | onset kPa | extinction kPa (slow decrescendo) |
|---|---|---|
| Bb3 | — | — |
| D4 | 2.479 | 1.519 |
| G4 | 2.380 | 1.619 |
| C#5 | 2.399 | 1.899 |
| D5 | 2.462 | 2.293 |
| G5 | 2.435 | 2.303 |
| D6 | 2.433 | 2.325 |

**Summary vs exit criteria (round 7)**

| criterion | target | assist 0 (pure physics) | assist 0.5 (default) |
|---|---|---|---|
| right register, 33 fingerings × 3.0/3.5/4.0 kPa | 99/99 | 94/99 (F#5, G5, G#5, F#6 at 3 kPa; E6) | 98/99 |
| register-1 pitch (in register) | ±10 c | ±7 c ✔ | ±9 c ✔ |
| register-2 pitch (in register) | ±20 c | ±20 c except **A5 +22…+30 c** ✘; F#6 now −6…+4 c ✔ (was −63) | A5 +24…+32 c ✘ |
| onset threshold | 2–3 kPa | 2.38–2.48 kPa ✔ (+0.04 from the wall losses) | — |
| D4 at ≥ 4.5 kPa | — | jumps to the 3rd partial (516 Hz) with open or narrowed glottis — a low-register over-blowing limit, not tuning (fine at 3–4 kPa) | |

A5 trade-off: a smaller/higher neck vent brings A5 to +14…+20 c but costs register-2 locking of E6–F#6
(engine scan, §8); the vent was set to x = 0.080 m, r = 1.2 mm.

## 3. Dynamics — fixed embouchure: hard onset, 6–13 dB (physics); with the player's embouchure scaling: 20–23 dB, see §6

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
| lip_force | 0.6 / 1.0 / 1.4 / 2.0 | -12 / +0 / +11 / — | -18 / -1 / +14 / +23 | -22 / +2 / +28 / +46 |
| lip_position | 8 / 12 / 16 / 20 | — / +0 / — / — | — / -1 / -8 / -61 | — / +2 / -9 / -26 |
| jaw_open | 0.1 / 0.3 / 0.6 / 0.9 | -1 / +0 / +2 / +4 | -1 / -1 / +0 / +1 | -0 / +2 / +5 / +6 |
| tongue_y | 0.2 / 0.4 / 0.7 / 1.0 | +2 / +0 / -4 / -12 | -1 / -1 / -4 / +5 | +3 / +2 / -6 / +20 |
| tongue_x (tongue_y=1) | 0.5 / 0.35 / 0.25 / 0.15 / 0.05 | -12 / -27 / -30 / -27 / -11 | +5 / -2 / -131 / -66 / -33 | +20 / — / — / -205 / -147 |
| lip_damping | 0.1 / 0.4 / 0.8 | +3 / +0 / -4 | +0 / -1 / -4 | +3 / +2 / -3 |
| reed_strength | 2.0 / 2.5 / 3.5 | +2 / +0 / -2 | -0 / -1 / +1 | +5 / +2 / -0 |

Literature: jaw vibrato ±10–20 c; "lipping" a few tens of cents in the low register, more in the
upper register; bends of a semitone or more in the 2nd register and above need vocal-tract tuning
(Chen, Smith & Wolfe 2009, 2011; Scavone et al. 2008). With the final lip-tissue model (DSP programmer, round 4: lip provides ~85 % of
the tip stiffness, strain-stiffening with lip force): lip force 0.6 → 1.4 N moves A4 −12…+6 c, C#5
−16…+14 c, C#6 −32…+18 c (jaw-vibrato range ✔); lip position 12 → 20 mm −15…−66 c; tract bends C#6 by
−145…−248 c and C#5 by −52 c ✔. Low-register lipping (A4) is still on the small side.

## 5. Altissimo (round 7 final; earlier rounds below)

Pure physics, voicings from `tools/altissimo_tune.py --emb-grid --strict35` on the final tree (wall loss
1.3, subglottal system on):

| note | fingering | tract peak | glottis | lip N | 3.5 / 4.0 / 4.5 / 5.0 kPa (cents) |
|---|---|---|---|---|---|
| G6 | OCT, LH1, LH_Gs | 66 | 0.05 | 2.0 | -22 / -20 / -8 / +2 |
| G#6 | OCT, LH1, BIS, RH_side_C, LH_Gs | 50 | 0.05 | 2.0 | +6 / +10 / +17 / +21 |
| A6 | OCT, LH2, RH_side_C, RH1 | 32 | 0.8 | 1.8 | +11 / +15 / +18 / +20 |
| Bb6 | OCT, LH_Gs | 26 | 0.8 | 1.8 | +14 / +19 / +22 / +24 |
| B6 | OCT, LH_palm_D, RH_side_C, RH3 | 21 | 0.8 | 2.0 | -18 / -13 / -12 / -11 |
| C7 | OCT, LH1, LH2, LH_palm_D, RH1, RH3 | 14 | 0.8 | 1.8 | +12 / +17 / +19 / +20 |
| C#7 | OCT, LH1, LH_palm_D, LH_palm_Eb, RH1 | 18 | 0.4 | 2.3 | -40 / -38 / -37 / -36 |

G6–C7 within ±24 c from 3.5 to 5 kPa; **C#7 −36…−40 c** (outside ±25, inside ±50); **D7 not found**
(best worst-case 154 c). `tongue_length` (new tract param) shifts altissimo pitch by tens of cents
(e.g. A6 +5 → −13 → −25 c at 0 / 0.5 / 1) but did not improve accuracy or robustness; voicings keep it
at 0 (the player model does not read it from `tract` yet).



### Round 6 (for reference)

Voicings from `tools/altissimo_tune.py --emb-grid --strict35` (engine in the loop): candidates = chart
patterns + bore-anchored fingerings; tract grid tongue_y 0.6–1.0 × tongue_x 0–0.15 × tongue_tip 0.3–0.95
(jaw 0.15); embouchure grid lip force 1.8/2.0 (2.3 for C7–D7) × glottis_open 0.05/0.4/0.8. All of
3.5/4/4.5/5 kPa must be within ±25 c, tongue_x ± 0.015 must stay in the regime, and among such voicings the
**weakest tract peak** is chosen (measured players: tens of MPa·s/m³). Pure physics (assist 0):

| note | fingering | tract peak (MPa·s/m³) | glottis_open | lip force (N) | 3.5 kPa | 4.0 | 4.5 | 5.0 | neutral tract @4.5 |
|---|---|---|---|---|---|---|---|---|---|
| G6 | OCT, LH1, LH3, LH_Gs | 45 | 0.05 | 2.0 | -0 | +2 | +8 | +12 | ✗ 312 Hz |
| G#6 | OCT, LH1, RH_side_C, RH1 | 50 | 0.05 | 2.0 | -15 | -10 | -3 | +2 | ✗ 624 Hz |
| A6 | OCT, LH1, LH2, LH3, RH_side_C | 35 | 0.05 | 2.0 | -15 | -10 | -9 | -8 | ✗ 317 Hz |
| Bb6 | OCT, LH_Gs | 35 | 0.8 | 1.8 | +4 | +9 | +11 | +12 | ✗ 676 Hz |
| B6 | OCT, LH_palm_D, RH3 | 33 | 0.4 | 1.8 | +12 | +17 | +20 | +21 | ✗ 716 Hz |
| C7 | OCT, LH1, LH2, LH_palm_D, RH1, RH3 | 16 | 0.8 | 1.8 | +4 | +5 | +7 | +7 | ✗ 2279 Hz |
| C#7 | OCT, LH1, LH2, LH_palm_D, LH_palm_Eb, RH3 | 17 | 0.8 | 2.0 | -4 | -2 | -1 | -1 | ✗ 2337 Hz |

* **Pitch**: all seven notes within ±21 c from 3.5 to 5 kPa ✔ (target ±25); drift 3.5→5 kPa ≤ 17 c.
* **Onset at 3.5 kPa** ✔ for all, including G6, A6, B6 (round 5: needed 4 kPa) — the lever was the
  embouchure (lip force 2.0 N for G6/G#6/A6) together with the tract retune; attack shape (ramp, step,
  tongued) made no difference.
* **Tract strength in the measured range** ✔: 33–50 MPa·s/m³ for G6–B6, 16–17 for C7/C#7; Bb6, C7, C#7
  play with an open glottis (0.8), B6 with 0.4.
* **C#7** now sounds (−4…−1 c); **D7** not (best worst-case 119 c): the tract model already reaches
  1.39–1.43 kHz resonances (tongue body lower, tip raised; `tools/tract_tmm.py`), so the limit is the
  bore (resonances near 1.4 kHz ≤ 8 MPa·s/m³ for any fingering) rather than the articulatory model.
* **Neutral tract** (same embouchure): low regime or reed squeal (2.3 kHz) for every fingering ✔.

**Attack history** (`engine/examples/history.rs`: previous note, release, gap, re-attack; random
previous notes/durations/gaps 0.05–0.4 s, os 2/4, finger-by-finger key changes, step/ramp attacks):
* assist 0.5 with the new "voice, then attack" gate (player.rs altissimo section): 115/120 cases end in
  tune; the 5 slow cases (Bb6/B6 at 3.5 kPa with a step attack) are in tune at the end but take > 0.6 s
  to settle; 120/120 and 60/60 (assist 1.0) with the round-5 voicings. Slurs from F#6 and from G4 lock.
* pure physics (voicing set at the release): gap 0.05 s → 6/21, 0.1 s → 14/21, 0.2 s → 21/21. A stopped
  reed does not help at 0.05 s. Mechanism: the previous note's bore oscillation (resonance Q ≈ 52–66 in TMM and engine → amplitude time constant τ = Q/(πf) ≈ 60–150 ms, T60 ≈ 120/f0 s; corrected in M9) at
  300–700 Hz) and the still-high mouth pressure (lung release τ = 120 ms) seed the low regime; with the
  weaker, more realistic tracts the seed must decay further.
* The web report ("first attack after a held G4 locks low, the second works") could not be reproduced
  natively (assist 0.5: 80/80 before the gate change); the gate removes the dependence on previous state
  anyway (tongue on the reed until the voicing ramp is complete and ≥ 0.1 s has passed; trims reset at
  each attack).

**Glottis — engine vs tract_tmm reconciled.** Both models give the same tract impedance (engine
`tractz` / `sax_compute_tract_impedance` and `tools/tract_tmm.py` agree within ~20 %): narrowing the
glottis from 1.61 to 0.15 cm² roughly doubles the high-front-tongue peak (e.g. 38→70, 24→53, 15→41
MPa·s/m³). The round-4 statement "opening the glottis kills altissimo" was true only for the old,
tract-dominated voicings. With bore-anchored voicings the engine plays altissimo with an open glottis too
(Bb6, C7, C#7 are voiced with glottis_open 0.8). The subglottal end is modelled as an anechoic trachea
(ρc/A, A = 2.5 cm²) — a standard broadband approximation; real subglottal resonances (~0.6, 1.4 kHz) are
not represented.

**Overtone gap 550–800 Hz** (coordinator's sweeps): within anatomical limits (constriction ≥ 0.05 cm²,
longer constriction σ = 3 cm, glottis 0.15–1.6 cm², jaw 0.15–0.6) the tract model gives at most
13–23 MPa·s/m³ at 550–650 Hz and ≤ 10 at 700–800 Hz for mid/back tongue positions (the front cavity is
large and Z ∝ 1/volume), versus 30–90 MPa·s/m³ at 0.9–1.4 kHz. No articulatory extension was adopted, so
partial 5 of the low notes (and the 550–800 Hz band) was not re-tested; real players may use the second
tract resonance or lip/reed control there.

### What altissimo physics turned out to matter (for docs/ALTISSIMO.md; updated round 6)

The reed is driven by p_mouth − p_mp, so the flow sees tract and bore in series and the reed's own
compliance/damping in parallel: Z_load = 1/(1/(Z_bore + Z_tract) + Y_reed).
1. **Embouchure.** A firm, strain-stiffened lip (1.8–2.0 N) roughly halves the reed's equivalent volume, so
   the reed no longer shunts the ~1 kHz load; it also moved the onset of G6/A6/B6 down to 3.5 kPa.
2. **Fingering sets the pitch.** Use fingerings whose own bore resonance lies just above the note; the note
   then sits 0–20 cents below that resonance and stays within ±21 cents from 3.5 to 5 kPa.
3. **Tract tuned just above the note, at measured strength.** 33–50 MPa·s/m³ (G6–B6), 16–17 (C7, C#7) is
   enough; higher notes need the tongue body lower and the tip raised (smaller front cavity), reaching
   ~1.4 kHz. A narrowed glottis roughly doubles the tract peak and helps, but is not required (several
   notes are voiced with an open glottis).
4. **Voice, then attack.** The previous note's oscillation and mouth pressure must have decayed before the
   altissimo attack (≥ 0.2 s without tonguing in pure physics), and the voicing must be in place before the
   reed is released — otherwise the low regime is seeded and wins.
Bore-side nonlinear hole losses (§7) matter for normal upper-register locking, not for altissimo. D7 is out
of reach because no fingering gives a usable bore resonance near 1.4 kHz.

### Overtones on low fingerings (round 7, `tools/overtone_sweep.py`, pure physics, 960 voicing/embouchure/pressure settings per note)

| note | partials sounding (count) | settings sounding in 550–800 Hz |
|---|---|---|
| Bb3 | 1:252, 2:86, 3:417, 4:32, 5:1, 6:7, 7:4, 8:18, 9:7, 10:1, 14:22, 15:6, 16:29, 17:20 | 1 |
| B3 | 1:299, 2:24, 3:451, 4:24, 5:2, 6:4, 7:1, 8:20, 13:26, 14:4, 15:30, 16:21 | 26 |
| C4 | 1:358, 2:22, 3:429, 4:18, 5:4, 6:8, 7:12, 8:2, 12:11, 13:3, 14:24, 15:25 | 21 |
| C#4 | 1:329, 2:20, 3:466, 5:10, 6:4, 7:26, 12:25, 13:17, 14:28, 15:6 | 2 |

Partials 1–3 dominate; partial 4 appears on Bb3–C4 (18–32 settings), partial 5 is rare (1–10) and the
550–800 Hz band is reached by 1–26 settings per note. Bore cause (TMM): the low-note resonances above
~600 Hz lose their harmonic alignment — C4's 5th resonance is at 734 Hz, −98 c of 5·f1, only 3 MPa·s/m³;
C#4's 5th sits +104 c sharp at 870 Hz. Scaling the four lowest tone holes by ±20 % moves them by only
±20–100 c and does not restore a harmonic 5th resonance, so it is not a hole-size error; it is the
open-hole lattice/bell region of this bore (plus the wall losses, which lower high peaks by ~20 %).
Partials 12–17 (≈2–2.6 kHz) are reed-resonance squeals.

## 6. Dynamics table (player model, round 6) — `cargo run --release --example dyntable`

Dynamics come from the embouchure (assist > 0, perf engineer's player-model dynamics): pp = firm lip on
more mouthpiece (lip_position 16 mm, lip force ≈ 2.8–3 N → H0 ≈ 0.23 mm, p_M ≈ 2.1 kPa, γ ≈ 0.3–0.42,
non-beating), ff = loose undamped lip at 6–8 kPa. Columns: pp … ff (level dB at 1 m, spectral centroid,
reed-closed fraction, cents).

```
note  reg |            pp            |            p             |            mf            |            f             |            ff            | range
Bb3     1 |  82.9dB  417Hz b0.00    -0 |  92.4dB  444Hz b0.13    +1 |  99.3dB  563Hz b0.17    +0 |  99.7dB  891Hz b0.34    -7 | 101.0dB 1349Hz b0.59   -16 |  18.1
B3      1 |  79.9dB  340Hz b0.00    +8 |  89.6dB  360Hz b0.14    +7 |  96.6dB  831Hz b0.22    -8 | 100.5dB 1057Hz b0.28    -4 | 102.7dB 1362Hz b0.36    +2 |  22.8
C4      1 |  77.7dB  394Hz b0.01    +2 |  87.9dB  360Hz b0.15    +1 |  94.9dB  512Hz b0.18    -0 |  98.3dB 1156Hz b0.22    +2 | 100.4dB 2050Hz b0.41    -4 |  22.7
C#4     1 |  76.6dB  408Hz b0.01    +8 |  86.6dB  399Hz b0.16    +7 |  93.7dB  572Hz b0.19    +7 |  96.9dB  877Hz b0.24    +9 | 100.6dB 2412Hz b0.38    +1 |  23.9
D4      1 |  77.9dB  331Hz b0.00   +10 |  87.2dB  357Hz b0.17    +9 |  93.8dB  460Hz b0.21    +6 |  97.9dB  837Hz b0.33    -7 | 100.4dB 1074Hz b0.43    +1 |  22.5
Eb4     1 |  78.9dB  533Hz b0.00    -2 |  87.7dB  462Hz b0.17    +2 |  94.5dB  640Hz b0.21    -0 |  97.7dB  783Hz b0.27    +2 |  97.5dB 1292Hz b0.52   -10 |  18.6
E4      1 |  80.3dB  423Hz b0.04    -2 |  89.0dB  512Hz b0.15    -1 |  95.7dB  655Hz b0.21    -3 |  98.5dB 1436Hz b0.26    +0 |  97.4dB 1573Hz b0.54   -17 |  17.1
F4      1 |  79.6dB  488Hz b0.09    +2 |  88.4dB  534Hz b0.18    +3 |  95.0dB  696Hz b0.22    +0 |  97.7dB 1002Hz b0.28    +2 |  98.1dB 1514Hz b0.51   -12 |  18.5
F#4     1 |  80.1dB  434Hz b0.05    +3 |  89.0dB  524Hz b0.17    +3 |  95.9dB  784Hz b0.21    -2 |  98.1dB 1089Hz b0.28    +2 |  99.9dB 1545Hz b0.36    +6 |  19.9
G4      1 |  77.7dB  380Hz b0.04    -4 |  86.3dB  516Hz b0.18    +1 |  93.2dB  795Hz b0.22    +0 |  95.9dB 1131Hz b0.29    -2 |  97.3dB 1853Hz b0.45   -10 |  19.6
G#4     1 |  77.2dB  438Hz b0.00    -6 |  87.0dB  688Hz b0.02    +3 |  94.3dB 1811Hz b0.19   -13 |  97.1dB 2528Hz b0.31   -13 |  99.1dB 3008Hz b0.47   -21 |  21.9
A4      1 |  78.3dB  592Hz b0.00    -1 |  87.2dB  751Hz b0.14    +2 |  94.4dB 1032Hz b0.22    -3 |  96.9dB 2016Hz b0.31    -6 |  98.9dB 2247Hz b0.40    -3 |  20.6
Bb4     1 |  77.4dB  448Hz b0.00    -0 |  85.2dB  532Hz b0.11    +2 |  91.8dB  868Hz b0.21    -7 |  95.7dB 1646Hz b0.31    -7 |  97.7dB 1995Hz b0.42    +9 |  20.3
B4      1 |  77.2dB  528Hz b0.00    -1 |  85.4dB  754Hz b0.01    +3 |  92.1dB 1057Hz b0.20   -16 |  96.6dB 2824Hz b0.31   -17 | 100.0dB 3427Hz b0.43   -19 |  22.8
C5      1 |  79.9dB  644Hz b0.08    +8 |  89.3dB  744Hz b0.18    +7 |  96.8dB  966Hz b0.23    +0 |  99.1dB 1589Hz b0.29    +4 | 101.5dB 2218Hz b0.38    +9 |  21.6
C#5     1 |  78.2dB  552Hz b0.00   +10 |  86.1dB  679Hz b0.17   +11 |  92.3dB 1009Hz b0.23    -0 |  95.4dB 1154Hz b0.32    +4 |  98.0dB 2108Hz b0.42   +16 |  19.8
D5      2 |  75.4dB  359Hz b0.00   +31 |  83.4dB  414Hz b0.00   +26 |  90.0dB  585Hz b0.08    +8 |  93.4dB  705Hz b0.36   +11 |  97.6dB 1238Hz b0.48   +15 |  22.2
Eb5     2 |  76.6dB  416Hz b0.00   +18 |  85.2dB  521Hz b0.00   +21 |  92.5dB  661Hz b0.15   +21 |  94.1dB  753Hz b0.36    +9 |  97.8dB 1766Hz b0.50    +5 |  21.1
E5      2 |  78.3dB  462Hz b0.00   +12 |  87.9dB  598Hz b0.01   +17 |  96.1dB  807Hz b0.18   +18 |  96.9dB  827Hz b0.36    +8 |  99.0dB 2216Hz b0.50    +2 |  20.7
F5      2 |  78.2dB  500Hz b0.00   +11 |  87.8dB  638Hz b0.01   +15 |  96.1dB  856Hz b0.16   +15 |  95.8dB  931Hz b0.35    -5 |  97.7dB 1590Hz b0.51    +4 |  19.5
F#5     2 |  77.8dB  471Hz b0.00   +19 |  85.9dB  560Hz b0.00   +18 |  92.6dB  868Hz b0.03    +7 |  95.4dB 1065Hz b0.36    -2 |  97.5dB 1519Hz b0.51   +13 |  19.7
G5      2 |  76.6dB  481Hz b0.00   +21 |  84.1dB  540Hz b0.00   +16 |  90.1dB  948Hz b0.02    +3 |  93.6dB 1413Hz b0.35   -11 |  97.1dB 1922Hz b0.54    +6 |  20.5
G#5     2 |  75.8dB  506Hz b0.00   +32 |  83.7dB  589Hz b0.00   +23 |  89.7dB  787Hz b0.02    +4 |  93.2dB 1395Hz b0.36   -12 |  97.1dB 1372Hz b0.54    +3 |  21.3
A5      2 |  67.8dB  566Hz b0.00 ! +63 |  82.4dB  837Hz b0.00   +47 |  89.8dB  885Hz b0.03   +23 |  93.4dB 1084Hz b0.35    +5 |  97.7dB 1507Hz b0.54    +9 |  29.9  (out of register)
Bb5     2 |  72.5dB  582Hz b0.00   +43 |  82.0dB  673Hz b0.00   +34 |  89.4dB 1063Hz b0.03   +11 |  94.0dB 1170Hz b0.36    -1 |  98.4dB 2021Hz b0.53    +8 |  25.9
B5      2 |  75.2dB  635Hz b0.00   +30 |  84.3dB  772Hz b0.00   +23 |  91.1dB 1490Hz b0.04    -1 |  94.5dB 1258Hz b0.35    -6 |  99.0dB 2553Hz b0.52    +5 |  23.9
C6      2 |  76.8dB  636Hz b0.00   +15 |  85.3dB  685Hz b0.00   +11 |  91.8dB  938Hz b0.04   -11 |  95.3dB  819Hz b0.36    -9 | 100.6dB 1260Hz b0.51    -5 |  23.8
C#6     2 |  77.3dB  685Hz b0.00   +22 |  85.8dB  801Hz b0.00   +19 |  92.2dB 1234Hz b0.05    -3 |  95.7dB 1505Hz b0.36    +7 | 100.8dB 2357Hz b0.51    +8 |  23.5
D6      2 |  78.4dB  713Hz b0.00   +23 |  87.3dB  806Hz b0.01   +21 |  93.2dB  937Hz b0.05    +4 |  96.9dB 1073Hz b0.38   +15 | 101.7dB 1853Hz b0.51   +14 |  23.3
Eb6     2 |  78.5dB  753Hz b0.00   +20 |  88.0dB  804Hz b0.03   +17 |  94.0dB 1223Hz b0.05    +4 |  98.3dB 1238Hz b0.39   +12 | 102.5dB 2309Hz b0.50    +7 |  24.0
E6      2 |  77.1dB  794Hz b0.00   +23 |  88.3dB  845Hz b0.02   +15 |  94.4dB 1043Hz b0.05    +4 |  98.8dB 1149Hz b0.39    +8 | 103.1dB 2386Hz b0.50    -1 |  26.1
F6      2 |  82.6dB  848Hz b0.00   +18 |  88.8dB  891Hz b0.00   +14 |  95.2dB 1031Hz b0.05    +1 |  99.5dB  953Hz b0.40    -1 | 104.5dB 2013Hz b0.48   -17 |  21.9
F#6     2 |  82.5dB  852Hz b0.00   -42 |  88.6dB  867Hz b0.00   -46 |  95.1dB 1016Hz b0.05 ! -57 |  99.3dB  965Hz b0.39 ! -62 | 104.4dB 2989Hz b0.48 ! -72 |  21.9  (out of register)

register | n | pp dB | mf dB | ff dB | range dB (min..max) | centroid pp→ff Hz | all 5 dynamics in register
       1 | 16 |  78.7 |  94.7 |  99.4 |  20.7 (17.1..23.9) |  459 → 1939 | 16/16
       2 | 17 |  76.9 |  92.5 |  99.8 |  22.9 (19.5..29.9) |  603 → 1934 | 15/17
```

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
