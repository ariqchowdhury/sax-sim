# M9 — Tone Analysis & Coaching Mode: Design and Contracts

Goal: a player records (or uploads) a short test set of sustained notes on their alto. The app
measures each note, fits the simulator's player/mouthpiece controls so the simulated notes
show the same *patterns*, ranks the most likely causes of what it hears, suggests concrete
adjustments, and loads the fitted player into the simulator so the player can hear the
"before" and the "suggested after".

Binding for all agents working on M9. Change only by editing this file in the same change.

## Principles

1. **Patterns across notes, not absolute spectra.** Microphone, room and the player's horn all
   colour the recording. Features are compared *relative* (between notes, between dynamics,
   and to an optional reference take of the same player) wherever possible. Absolute pitch
   (cents vs A=440 or a user-set reference) is the exception: it is robust.
2. **Several candidate causes, ranked, with confidence.** Never a single verdict. Each
   suggestion carries the physical reason and what to listen for.
3. **One feature extractor for everything.** The same Rust code (`engine/src/analysis.rs`)
   analyses recordings and simulator output — in the browser (wasm), in the native renderer,
   and in the Python tools (via the renderer CLI). No re-implementations.
4. **Honest limits.** Advice that depends on known model gaps (see PLAN.md status: pp
   intonation, D7, 550–800 Hz overtone gap) is flagged or suppressed.

## Test-set protocol (v1)

Written pitches, alto only, A4 = 440 Hz unless the user sets a reference. Each note sustained
~3 s at mf with a tongued start, a short breath between notes:

| # | Note | Why |
|---|---|---|
| 1 | Bb3 | low register, subtone/stuffiness, cracking up |
| 2 | D4 | low-mid |
| 3 | G4 | reference mid note |
| 4 | C5 | top of register 1 |
| 5 | C#5 | open C#: notoriously unstable / sharp-thin |
| 6 | D5 | first octave-key note (vent switching) |
| 7 | G5 | register 2 |
| 8 | C6 | upper register 2 |
| 9 | F6 | palm keys: voicing-sensitive |
| 10 | G4 pp | dynamic behaviour |
| 11 | G4 ff | dynamic behaviour, brightening |
| 12 | D5 pp / D5 ff | (optional) register-2 dynamics |
| opt | G6 | altissimo (only if the player has it) |

The UI guides the player through the list (drone/tuner off; a visual metronome for length),
or accepts an uploaded file containing the same sequence (auto-segmented) or one file per note.

## Feature vector (per sustained note) — `analysis.rs` v1

Computed on the steady part (after the attack, before the release); attack features on the
start. All f32. Index layout is fixed (append only):

| idx | name | unit | notes |
|---|---|---|---|
| 0 | f0 | Hz | YIN/autocorrelation, median over steady part |
| 1 | cents | ¢ | vs target pitch (sounding = written − 9 semitones, at the reference A) |
| 2 | pitch_std | ¢ | std of f0 track after removing vibrato (stability) |
| 3 | vib_rate | Hz | 0 if none |
| 4 | vib_depth | ¢ | peak, 0 if none |
| 5 | level | dB | RMS, relative (dBFS for recordings; dB re 1 Pa @1 m for sim) |
| 6 | centroid_rel | × f0 | spectral centroid / f0 (harmonic region up to 8 kHz) |
| 7–16 | H1..H10 | dB | harmonic levels re H1 (H1 = 0) |
| 17 | odd_even | dB | mean odd (3,5,7,9) minus mean even (2,4,6,8,10) harmonics |
| 18 | tilt | dB/oct | least-squares slope of harmonic levels vs log2(k) |
| 19 | hnr | dB | harmonic-to-noise ratio (breathiness) |
| 20 | edge | dB | energy 2–5 kHz re total (buzz/edge) |
| 21 | attack | ms | 10→90 % of steady RMS |
| 22 | scoop | ¢ | mean pitch deviation in first 100 ms after onset vs steady f0 |
| 23 | subharm | dB | energy at f0/2 & multiphonic partials re H1 (−∞ → −120) |
| 24 | regime | – | partial number relative to the target fingering's expected register (1 = as intended; 0.5 = cracked down; 2 = cracked up …) |
| 25 | valid | 0/1 | 0 if no stable pitch was found |
| 26 | release_t60 | s | reverberation time from the release tail (Schroeder T20 fit, noise-subtracted, starting ½·T60_inst after the −6 dB point); −1 if not measurable **or not slower than 1.3 × the instrument's own ring-down** T60_inst ≈ 95 Hz·s / f0 |
| 27 | tail_ratio | dB | mean power 50–300 ms after the release re steady power (DRR proxy; includes the instrument ring-down) |
| 28 | noise_floor | dB | quietest 50 ms of the buffer re steady level |
| 29 | release_clean | 0/1 | 1 = abrupt (tongued/stopped) release: no > 6 dB fade over the last 300 ms and −3 → −6 dB within 40 ms |

## Engine ABI additions (DSP programmer; append-only in `engine/src/lib.rs`)

| Export | Meaning |
|---|---|
| `sax_analyze(ptr: *const f32, n: u32, sample_rate: f32, target_hz: f32) -> *const f32` | run `analysis.rs` on a mono buffer; returns the feature vector above (length `sax_analyze_len()`) |
| `sax_analyze_len() -> u32` | feature vector length |
| `sax_reset_state()` | silence all acoustic/reed/lung state (keep geometry, params, keys) for back-to-back offline renders |
| `sax_set_seed(seed: u32)` | breath-noise RNG seed (deterministic fits) |
| `sax_room(ptr: *const f32, n: u32, sample_rate: f32) -> *const f32` | blind room / recording-quality estimate of a multi-note recording: `[rt60, rt60_spread, drr, noise_floor, n_tails, confidence, verdict, clap_rt60, tail_ratio]` — robust medians over the clean release tails (notes ≥ 0.5 s), `rt60_spread` = 1.48·MAD, `drr` (dB) from the fitted tail extrapolated to the release, `noise_floor` = quietest 50 ms re the loudest, `verdict` 0 dry / 1 some room / 2 too reverberant / 3 uncertain, `clap_rt60` from an impulsive transient before the first note (−1 if none; primary for `rt60` when its decay spans ≥ 15 dB), `tail_ratio` = median per-note tail_ratio. Native: `render --room rec.wav` (JSON with the same names + `verdict_text`) |
| `sax_analysis_config(inst_t60_hz: f32)` | instrument ring-down constant T60_inst·f0 (Hz·s) for the release/room estimate (`release_t60`, `sax_room`): **95 = default** — the simulator's free decay since the bore wall-loss factor ×1.3 (round 7) and the recommended real-alto value (≈ 95 ± 20, Q ≈ 40–50); use 120 only for renders made before round 7 (smooth-wall losses). ≤ 0 restores the default. Global (affects subsequent `sax_analyze`/`sax_room` calls). Native: `render --analyze/--room … --inst-t60 95` |
| `sax_segment(ptr: *const f32, n: u32, sample_rate: f32) -> *const f32` | split a multi-note recording into notes: returns `[count, start0, end0, start1, end1, …]` (sample indices as f32; exact up to 2²⁴ samples ≈ 5.8 min at 48 kHz). Energy gate (−35 dB re the loudest 10 ms, ≥ 12 dB above the noise floor; a gap must stay below the gate > 80 ms, notes ≥ 150 ms). Inside a sounding region level changes never split a note (swells, messa di voce, slow attacks, quiet plateaus); splits only at (1) a dip ≥ 20 dB below the surrounding 200 ms lasting > 80 ms (re-articulation in reverb) or (2) a legato pitch change > 70 ¢ for ≥ 60 ms, confirmed on the spectrum: not a split when the old pitch keeps its level after the change (tracker octave/subharmonic error) or when the new pitch is the fundamental the tracker had skipped (already sounding before, ≥ −24 dB; partial-dominant attack); pitch changes in the first 250 ms of a note are its attack (e.g. speaking first in the wrong register). Finally neighbours with the same pitch (< 50 ¢) separated by < 100 ms are merged |

`sax_analyze` and `sax_segment` do not need `sax_init` (they don't touch the engine instance).
Two offline renders separated by `sax_reset_state()` with the same `sax_set_seed` are
bit-identical (also across fresh instances).

**Implementation conventions of the v1 features** (`engine/src/analysis.rs`):
* conditioning: 40 Hz 2nd-order high-pass + 50 Hz and 60 Hz notches (Q 8);
* segmentation: 5 ms RMS envelope; steady RMS = median of frames above half the peak;
  onset = 10 % crossing; `attack` = 10 → 90 % of steady RMS; steady part = from the 90 %
  crossing + 80 ms to (last frame ≥ 70 % of steady) − 80 ms (short notes: middle half);
* pitch: YIN (CMNDF, threshold 0.2) on a 12 kHz copy, 20 ms hop, refined at full rate
  (parabolic); search f ∈ [target/2.4, 3.5·target] (no target: 50–2000 Hz); frames ≥ 100 ¢
  from the median are excluded from `pitch_std`/vibrato; `valid` = 0 if < 50 % of steady
  frames are periodic;
* `cents`: vs `target × regime` (so a cracked note still reports its intonation on the
  partial it plays); 0 with no target;
* `regime`: 1 within ±300 ¢ of the target, else f0/target rounded to the nearest ½ (≥ 0.4);
* vibrato: best 3–9 Hz least-squares sinusoid of the detrended cents track; reported if
  amplitude ≥ 4 ¢ and it explains ≥ 30 % of the variance (else 0, 0); removed before
  `pitch_std` (RMS of the residual, ¢);
* spectrum: Hann FFT of ≤ 0.75 s at the centre of the steady part; harmonic k energy =
  power within ±min(max(1.5 % k f0, 2 bins), f0/4) of the local peak near k·f0;
  absent harmonics (and those above 8 kHz / Nyquist) = −120 dB;
* `centroid_rel` = Σ k·|A_k| / Σ |A_k| over harmonics ≤ 8 kHz (amplitude-weighted harmonic number);
* `tilt`: LS slope of H_k (dB) vs log2 k over k ≤ 10 with H_k > −90 dB;
* `hnr` = harmonic energy / (energy 50 Hz–8 kHz − harmonic energy);
  `edge` = energy 2–5 kHz / energy 50 Hz–Nyquist; `subharm` = energy at (k+½)·f0, k = 0…4, re H1;
* `level`: dBFS RMS of the steady part for recordings; `render --features` converts the
  simulator output to dB re 1 Pa at the 1 m listener.

**Room estimate: validity and thresholds** (`engine/examples/roomval.rs`: 4 simulated notes,
tongued vs faded releases, synthetic rooms RT60 0.2–1.0 s × DRR −5…+10 dB × noise −70/−45 dB):
* The air column keeps ringing after a tongued stop (T60_inst ≈ 95/f0 s, Q ≈ 40–50, simulator with
  wall losses ×1.3 and real altos alike; Bb3 ≈ 0.7 s, G4 ≈ 0.4 s, C6 ≈ 0.13 s; amplitude time
  constant τ = Q/(πf) ≈ 50–120 ms; override with `sax_analysis_config`). Release tails that decay no slower than 1.3·T60_inst are
  attributed to the instrument, so **rooms with RT60 ≲ 0.4–0.5 s are not distinguishable from a
  dry recording** (verdict 0); the dry simulation itself gives verdict 0, confidence 0.8.
* RT60 ≥ 0.6 s is detected with tongued releases: estimates 0.5–1.1 s for true 0.6–1.0 s, verdict 2
  in all 0.8/1.0 s cases. Faded releases give fewer usable tails (0–2) and often verdict 3.
* `drr` is **not reliable** (errors up to ±15 dB): the instrument ring-down and the room tail
  overlap. `tail_ratio` tracks the DRR for long rooms (≈ −13 dB at DRR −5, −20 dB at DRR +10,
  RT60 1 s) but sits at ≈ −23 dB for dry/short rooms (ring-down).
* A clap before the first note gives a direct estimate and is the **primary** one (no instrument
  ring-down to separate): the first impulsive event is found even when its reverberation merges
  with the first note into one segment; its decay is fitted (Schroeder, −5 … −25 dB, noise floor =
  5th percentile of the file's envelope) up to the next note's onset, with the energy missing after
  that truncation added back assuming the fitted exponential (3 iterations). When the clap decay
  covers ≥ 15 dB, `rt60` = `clap_rt60`; note tails only confirm (agreeing within 30 % → confidence
  ≥ 0.9, else ×0.85), and a single tail's DRR is not used for the verdict. Clap 0.4 s before a note:
  RT60 0.3 → 0.31 s, 0.6 → 0.62 s, 1.0 → 1.04 s (verdicts 1, 2, 2).
* Verdict thresholds: 2 if rt60 ≥ 0.6 s or drr ≤ −2 dB; 0 if rt60 < 0.25 s or drr ≥ +6 dB, or
  if ≥ 2 clean releases show no decay beyond the ring-down; 1 otherwise; 3 if confidence < 0.3
  or no clean release.
* Feature damage in the same rooms (mean over notes, tongued): `attack` error 20–130 ms whenever
  DRR ≤ +5 dB (only ≤ 6 ms at DRR +10); individual H2–H6 2–14 dB whenever DRR ≤ +5 dB (1.6–2 dB at
  +10); `tilt` 0.2–2.2 dB/oct. Harmonic colouring depends on the DRR (early reflections), not on
  the RT60, and short rooms are invisible to the release analysis — so **verdict 0 does not
  certify absolute H_k or attack**: weight them low always; with verdict 2 drop attack/scoop and
  per-harmonic levels entirely, keep tilt/centroid/between-note differences and pitch features.

Native CLI (JSON on stdout):
* `render --analyze rec.wav --note G4 [--ref 442 | --target Hz]` →
  `{"note", "target_hz", "features": {f0, cents, pitch_std, vib_rate, vib_depth, level,
  centroid_rel, H1…H10, odd_even, tilt, hnr, edge, attack, scoop, subharm, regime, valid},
  "vector": [26 floats]}`;
* `render --analyze rec.wav --notes Bb3,D4,…` → `{"file", "sample_rate", "notes": [ … same
  objects + "segment": [start, end] … ]}` (auto-segmented; notes assigned in order);
* `render --fingering G4 --pressure 3.5 --seconds 3 [--tongue-release 0.2] --features
  [--seed N]` → the object for the rendered note (simulator level in dB re 1 Pa).

Native: `render --analyze <wav> --note G4` prints the vector as JSON; `render ... --features`
prints it for the rendered note. Python tools call these.

## Fitting (performance engineer)

* **Fitted controls** (v1): global — `lip_force`, `lip_position`, `lip_damping`,
  `mouthpiece_insertion`, `baffle_height`, `chamber_size`, `tip_opening`, `reed_strength`;
  per register (low/mid/palm) — `tongue_y`, `tongue_x`, `jaw_open`; per dynamic —
  `lung_pressure`. Bounded to their param ranges; priors centred on defaults.
* **Objective:** weighted distance between recorded and simulated features, using
  *relative* features (between-note differences, dynamic deltas, harmonic shape after removing
  a per-recording spectral tilt/EQ estimate) plus absolute cents. Weights and the room/mic
  robustness transform come from the physics lead's study (`data/coach_model.json`).
* **Search:** sensitivity-informed initialisation (Jacobian table) then a derivative-free
  optimiser (CMA-ES or Nelder–Mead) over offline renders, parallel across Web Workers, each
  with its own wasm engine instance (oversample 2 for the search, 4 to confirm). Target: a fit
  in ≤ 60 s on a laptop; progress reported to the UI.
* **Output:** fitted control values + uncertainty (from the local Hessian or the CMA covariance),
  per-note residuals, and the simulated feature vectors.

**Web fitter as implemented (`web/src/coach/fit/`, M9 round 1)** — follows `data/coach_model.json`:
* **Render protocol** (model `sim_settings`): each take rendered from silence with
  `sax_reset_state` (+ a forced grid rebuild — back-to-back renders at the same oversampling were
  not bit-identical with the reset alone), tongued attack released at `tongue_release`,
  `player_assist` on and the engine `dynamic` param per take (`dynamic_by_label`; pp 0.15,
  mf 0.5, ff 0.9) — the player model realises pp/ff through the embouchure (p_M scaling), so a
  single `lung_pressure` control serves all dynamics; `seconds` = 2.0 (1.5 s gives the same
  features within ~0.1 dB median; 1.2 s degrades harmonic levels by up to 2–3 dB at the 90th
  percentile); breath noise 0.05 with `sax_set_seed`.
* **Fitted controls:** the model's `fit_controls` (10: the 8 globals, `lung_pressure`,
  `jaw_open@low`; per-register tract is not identifiable from the protocol) in coordinates
  u = (control − default)/step, clipped to the model's min/max; others fixed at their defaults.
* **Objective v1:** exactly the physics lead's `r = W·(robust(sim(u)) − robust(rec)) ⊕ λ·u`,
  loss ½|r|², with `robust()` = tools/coach/common.py `robust_vector` (same names; entries whose
  takes are missing are omitted, features compared by name, W from `weights` or
  `weights.by_room[verdict]`). Fitter addition: a `sounding@L` residual (weight 10) for every take
  that sounds in the recording but is silent in the simulation; a fit whose confirmation render
  leaves such a take silent returns `status: 'failed'` with the reason in `problems`.
* **Search:** first Levenberg–Marquardt step from the model's `sensitivity.J_robust` (no renders),
  then LM with a forward-difference Jacobian (h = ½ step) refreshed every iteration and five damping
  levels evaluated in parallel; CMA-ES polish (covariance from the Gauss–Newton posterior) with the
  remaining budget; oversample 2, confirmation at 4 with up to two LM steps there (os 2 biases
  pitch by ~1 ¢ median, harmonic levels by ~0.1 dB).
* **Uncertainty:** local Gauss–Newton covariance at the optimum (× reduced χ² when > 1), floored
  by the model's `identifiability.*.posterior_sd_steps` (colouration effects the clean local
  estimate cannot see). Reported per control with `identifiability` = sd / prior sd.
* **Note ids:** the UI's ids ("G4 pp") map to model labels by removing spaces ("G4pp").
* **Template cause ranking in the browser** (`fit/rank.ts` `rankCauses(recorded, model, room?)`):
  identical to tools/coach/fit.py `rank_causes_template` (verified on saved cases,
  `web/tests/rank.test.ts`, fixtures from `web/tests/fixtures/make_rank_cases.py`); protocol
  `G4push` templates when that take is present. Room: features whose `by_room[verdict]` weight is 0
  are left out (the Python reference is room-independent). **Confidence** = softmax(score/τ),
  τ = √(2n) with n the number of robust features used (the spread of χ² itself; softmax(score/2)
  gives ~100 % even on wrong top-1s because σ_eff omits model error) — *physics lead: please
  confirm or supply a calibrated temperature*.
* **G4push** is an optional take (`TEST_SET` id "G4push", model `protocol_extensions`):
  mouthpiece_insertion +5 mm on top of the fitted value; it joins the mf set of the robust
  transform exactly as common.py does.
* **Multi-start:** default, the sensitivity-table step, the template ranking's top-4 causes at their
  best magnitude (tools/coach `rule_controls` offsets), each rule direction at its linear-model
  magnitude and a non-negative combination of rule directions; the best 3 distinct starts run
  Levenberg–Marquardt in parallel, then CMA-ES polish. `maxEvaluations` schedules the stages by
  evaluations instead of wall time (reproducible; tests use 400).
* **Trade-offs** (`FitResult.tradeOffs`): groups linked by the model's `identifiability.v1.confounds`
  (|ρ| ≥ 0.6) or |ρ| ≥ 0.6 in the fit's own covariance; for each, the flat direction (principal
  axis of the group's correlation matrix, in control units per 1 σ) and a message "A +x together
  with B +y (or the opposite) explain the recording about equally well".

## Diagnosis & advice (physics lead)

Generated by `tools/coach/` (`study.py` → sensitivity / robustness / identifiability, `fit.py` →
reference fitter, cause templates and validation, `rules.json` → knowledge base, `triggers.py` →
reference trigger evaluator, `build_model.py` → `data/coach_model.json`). All simulator features come
from the engine analyser (`render --features`, recordings and coloured renders `render --analyze`).

### What the study found (M9 round 1)

**Sensitivity** (`sensitivity.J_raw`, `J_robust`: central differences ± one control step at the
default player, protocol v1, `sim_settings`). Per control step the robust features move by: cents
21 ¢ (median over notes/controls of the largest effect), harmonic levels 2–5 dB, tilt 1.3 dB/oct,
hnr 5 dB, edge 1.7 dB, level 1.1 dB.

**Robustness to room and microphone** (32 colourings: RT60 0.2/0.35/0.6/1.0 s with early
reflections × mic {1 m flat, bell-close presence, off-axis −4 dB/oct, phone band-limit} × 2 seeds ×
0/−12 dB level). Signal (per control step) / colouring error, raw features: cents 3.8 ✔, pitch_std
1.6 ✔, scoop 1.6 (dry only), subharm 0.7, hnr 0.7, H_k 0.24–0.59 ✘, tilt 0.54, odd_even 0.55, edge
0.33, centroid_rel 0.43, level 0.12 ✘, attack 0.15 ✘. After the robust transform (median per type):
cents 10.0, dynamic deltas on G4 (H2–H4, centroid, edge) 1.1–2.8, hnr_rel 1.5, edge_rel 1.4,
pitch_std 1.2, H5_rel 1.0; still weak: tilt/level deltas 0.6–0.8, per-note H2–H4/odd_even_rel
0.26–0.5, absolute means 0.3–0.6, scoop 0.2. The analyser team's room study agrees: harmonic
colouring is driven by the direct-to-reverberant ratio, not RT60 — hence always low weight on absolute
H_k and attack, and per-room weights (`weights.by_room`).

**Identifiability** (posterior sd in control steps from the weighted Jacobian + a one-step prior;
`identifiability`): lip_position 0.10, chamber_size 0.13, tip_opening 0.18, lip_force 0.22,
mouthpiece_insertion 0.22, reed_strength 0.26, lung_pressure 0.31, lip_damping 0.32, jaw_open@low
0.52, baffle_height 0.56; per-register tract 0.87–1.88 (not identifiable). Confounds |corr| > 0.6:
baffle ~ chamber (+0.65), reed_strength ~ lung_pressure (+0.63), lip_damping ~ reed_strength (+0.62),
jaw_open@low ~ lung_pressure (+0.70), tongue_x ~ jaw (mid, −0.71). Mic tilt is absorbed by the
per-recording mean-shape removal (it shows up only in the low-weight `*_mean` features).
**Minimal identifiable set = `fit_controls`** (8 globals + lung_pressure + jaw_open@low); tract per
register stays at its default. **Protocol change (recommended, cheap): a reference take "G4push"**
— the same G4 with the mouthpiece pushed 5 mm further onto the cork. It pins the instrument's
pitch-vs-length slope and breaks the reed/lip-damping/support confounds (posterior sd lip_damping
0.32 → 0.19, reed_strength 0.26 → 0.17, lung_pressure 0.31 → 0.19) and raises cause accuracy from
75 % to 80 % top-3. D5 pp/ff and C6 ff add little (baffle ~ chamber stays at 0.65–0.73).

**Cause ranking** (`cause_ranking`). Two methods, validated on synthetic players (hidden fault of
1.5–3 control steps along the rule signature, ±0.4-step nuisance on all fit controls, ±1 step tract,
random room/mic/level):
* *Template* (primary, no fit needed, instant in the UI): per control rule, precomputed robust vectors
  at 4 magnitudes (`cause_ranking.templates`); score = χ² improvement over the default player of the
  best-matching magnitude, with σ_eff² = σ_room² + σ_nuisance². **Top-3: 84 % (top-1 60 %) on the
  45 single-fault players; on an independent, harder set (60 players, plus up to 0.75 step of a
  second cause): 75 % with protocol v1, 80 % with the G4push take (top-1 45 % / 52 %).** Regenerated on
  the round-7 physics (wall losses, shorter neck, subglottal system, final dynamics): **80 % (v1) and
  83 % (G4push) top-3, top-1 53 % / 62 %** (`validation.template_*` in the model).
* *Fit-based* (secondary, after the fitter): projection of the fitted control change (in posterior
  sd) on the signature: top-3 60–62 %. The LM fit's control recovery RMSE (control units):
  chamber 0.08, lip_force 0.12, baffle 0.12, tip_opening 0.13 mm, jaw 0.21, lip_damping 0.22,
  lung_pressure 0.38 kPa, reed_strength 0.47, lip_position 1.25 mm, mouthpiece_insertion 1.75 mm
  (the prior pulls large cork offsets back; the cause ranking still finds them).
* Hardest causes (most misses): reed too soft/hard ↔ support ↔ tip opening, too little lip cushion,
  too little mouthpiece — physically close in the simulator; their advice therefore names the
  alternatives ("if softer reed does not help, check air support").
The UI should show the top 3 with confidence = softmax of the template scores, and hide rules whose
`room` requirement the room verdict does not meet.

### Rules (knowledge base)

22 rules in `rules` (`tools/coach/rules.json`): 16 *control* rules (signature in control space;
ranked by templates/fit) and 6 *observation* rules (fire from feature `trigger`s): mouthpiece too far
out / in, biting, loose embouchure, too much / too little mouthpiece, heavy / thin lip cushion, reed
too hard / soft, wide tip opening, bright baffle, large chamber, weak support, over-blowing, closed
low voicing; cracking low notes, unstable open C#, late voicing (scoop), breathy, small dynamic
range, pinching at pp (G4 pp > 15 ¢ sharp of mf). Each carries player-facing `advice`, `why`
(physics), `listen_for`, model `gaps`, `room` requirement and `evidence_features`. Physics behind
them: cork position moves every note (+1.4 ¢/mm on Bb3 … +3.3 ¢/mm on C#5); lip force stiffens the
lip tissue and closes the reed → sharp upper register, thinner tone; mouthpiece volume sets the
octave stretch (large chamber → narrow octaves); dynamics come from the embouchure (p_M scaling),
pressure alone spans 6–12 dB; voicing must be set before the attack (tract in series with the bore).
Advice depending on known model gaps is flagged in `gaps` (pp intonation in register 2, lip-toward-tip
direction, D7, 550–800 Hz overtone gap).

### `data/coach_model.json` schema (v1, authoritative)

| key | type | meaning |
|---|---|---|
| `version` | int | 1 |
| `feature_names` | string[26] | raw feature order of the analyser vector (§ Feature vector) |
| `test_set` | {label, written, dynamic, register_group}[] | protocol v1 takes; `label` is the id used everywhere ("G4pp") |
| `protocol_extensions` | {label, written, dynamic, register_group, instruction?, control_offsets?, recommended}[] | optional takes; `G4push` (recommended): `control_offsets.mouthpiece_insertion = +5` applied on top of the fitted value when simulating it |
| `controls` | {key, param, min, max, default, step, scope}[] | all controls; `key` = param name, or `param@group` for per-register tract controls; `scope` ∈ global/low/mid/palm/dyn |
| `fit_controls` | string[] | the identifiable subset to fit (keys of `controls`) |
| `sim_settings` | {player_assist, oversample, seconds, tongue_release, seed, dynamic_by_label} | how takes are simulated |
| `sensitivity` | {about, base_raw: {label: float[26]}, J_raw: {key: {label: float[26]}}, robust_names: string[], J_robust: {key: float[]}} | ∂feature/∂control (per control unit) at the default player |
| `robust_transform` | {about, features: string[], definitions: {pattern: text}} | names/definitions of the robust features; reference implementation `tools/coach/common.py robust_vector` |
| `weights` | {names, sigma, weight, by_room: {dry, some, too_reverberant, uncertain: float[]}, room_verdict_map, room_notes, about} | per robust feature (aligned with `weights.names`): σ and w = 1/σ; `by_room[verdict]` replaces `weight` when the room verdict is known (too_reverberant: non-pitch features 0); `room_notes[verdict]` = user-facing note |
| `objective` | {definition, lambda_prior} | r = W·(robust(sim(u)) − robust(rec)) ⊕ λ·u |
| `feature_survival`, `robust_feature_survival` | {name: {signal_per_step, colour_rms or sigma, ratio}} | study results (informative) |
| `identifiability` | {protocol: {posterior_sd_steps: {key: float}, confounds: [keyA, keyB, corr][]}} | protocol ∈ v1, G4push, D5pp_D5ff_G4push_C6ff |
| `rules` | rule[] | see below |
| `cause_ranking` | {method: "template", about, templates: {v1 \| G4push: {names, default, templates: {id, mag, robust}[]}}, sigma_nuisance: {v1 \| G4push: float[]}} | template ranking data (aligned with `templates.<proto>.names`) |
| `validation` | {fit_based, template_v1, template_G4push} | summary numbers above |

**Rule** object: `id`, `kind` ("control" \| "observation"), `cause` (title), `signature` ({control key:
direction}; empty for observation rules), `evidence` (prose), `advice`, `why`, `listen_for`, `gaps`
(string[]), `room` ("any" \| "dry_or_some" \| "dry" — minimum recording quality for the evidence),
`evidence_features` (robust-feature names or feature types the rule relies on),
`pitch_evidence_share` (control rules: share of the rule's evidence carried by pitch features),
`validate` (false = excluded from the synthetic validation), and for observation rules `trigger`.

**Trigger conditions** (`trigger` = {"any": cond[]} or {"all": cond[]}; reference evaluator
`tools/coach/triggers.py`). Feature references are `name@label` with raw analyser feature names
(`cents@C#5`, `level@G4ff`); a take that is missing or has `valid` = 0 makes its condition false.
* `{"type": "value", "x": ref, "op", "value"}`
* `{"type": "diff", "a": ref, "b": ref, "op", "value"}` — a − b
* `{"type": "any_note", "feature", "notes": label[], "op", "value"}` — true if any listed take satisfies it
* `{"type": "mean", "feature", "notes": label[] \| "mf", "op", "value"}` — mean over the takes ("mf" = all mf takes of the test set)
* `{"type": "max_abs", "feature", "notes", "op", "value"}` — max |value| over the takes
* `op` ∈ `>`, `<`, `>=`, `<=`, `==`, `!=`. A rule fires only if the room verdict satisfies `room`
  (any: all verdicts; dry_or_some: dry, some, uncertain; dry: dry only).

### Instrument ring-down (answer to the analyser team)

**Round 7 update: done.** The physics lead added the bore wall-loss factor ×1.3; the simulator now decays
with T60 ≈ 95/f0 s and `INST_T60_HZ` defaults to 95 for simulator output and real recordings alike
(`sax_analysis_config` still overrides it; 120 reproduces pre-round-7 renders). Original note:

The simulator's free decay after a tongued stop, T60 ≈ 120/f0 s (Q ≈ 52–66), matched the TMM
visco-thermal + radiation Q of the same bore (Bb3 66, G4 57, C#5 52, C6 52), so engine and theory
agree. Measured woodwind impedance peaks are typically 10–30 % lower/broader than smooth-wall theory
(wall roughness, tone-hole edges and pad cups, pad leaks; Nederveen 1998, Dalmont et al., Chaigne &
Kergomard), i.e. a real alto most likely rings with Q ≈ 40–50, T60 ≈ 85–105/f0 s. Recommendation:
use INST_T60_HZ ≈ 95 (± 20) in `analysis.rs` for real recordings (keep 120 for simulator output), and
in a later accuracy milestone add a roughness loss factor (bore_loss_mult ≈ 1.2–1.4, calibrated on a
measured alto impedance curve) with a full retune. (My round-6 note quoting τ ≈ 15–30 ms was wrong;
τ = Q/(πf) ≈ 60–150 ms — corrected in PHYSICS/VALIDATION; the comment on `ALT_SETTLE` in player.rs
should be updated by its owner.)

## UI (web agent)

`web/src/coach/`: a Coach panel/mode — protocol wizard with live mic capture (getUserMedia,
48 kHz mono, level meter, per-note prompts) or file upload (WAV/MP3/M4A via decodeAudioData),
auto-segmentation into notes, per-note feature table with simple plots (cents per note, harmonic
spectrum vs simulated, brightness pp→ff), fit progress, ranked suggestions (cause, what to try,
why, what to listen for, confidence), and "Load fitted player" / "Load suggested change" buttons
that set the simulator params (A/B). Optional: save the session (JSON) and re-run later to track
progress. Privacy: audio never leaves the browser.

## Ownership (M9)

| Agent | Owns |
|---|---|
| DSP programmer | `engine/src/analysis.rs`, the ABI additions above, `render --analyze/--features`, deterministic offline-render helpers |
| Physics lead | `tools/coach/`, `data/coach_model.json`, the rules and their validation, `docs/COACHING.md` §Diagnosis (science write-up), player-facing `docs/TONE.md` later |
| Performance engineer | `web/src/coach/fit/` (worker pool, optimiser, objective), fit speed |
| Web agent | `web/src/coach/` UI (everything except `fit/`), integration into the app, e2e tests |
