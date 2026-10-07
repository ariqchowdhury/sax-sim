# UI & Controls

Owner: graphics / interaction. Code: `web/src/` (scene in `scene/`, panels and visualizers in `ui/`,
audio bridge in `engine/`). Run with `npm run dev`; build with `npm run build`.

## Layout (progressive disclosure — see docs/UX_REVIEW.md)

The 3D view fills the window; everything else is one deliberate click away.

* **Top bar**: brand + status pill · **Play | Explore** mode switch · camera views (*Instrument · Mouthpiece · Player · Keys*) ·
  **Layers ▾** (Cutaway, X-ray, Air-flow particles, Grab hints, Airway readouts) · **Scopes** ·
  **Controls** · **Coach** · **⋯** (Record WAV, Quick tour, Help & shortcuts).
* **Now playing** (bottom centre): written note (large), cents meter, concert note + Hz, recognised
  fingering, register chip (1st / 2nd register, altissimo, squeak?, tract-supported), output level,
  a transient *what changed* line, and the primary action **Hold to blow** (mouse, touch, Enter or
  <kbd>Space</kbd>) with the docked **Air** slider (the blow target, kPa).
* **Context card** (left): opens when a part is grabbed or its camera view is chosen and shows only
  that part's detail — *Tongue & throat*: impedance with the tract overlay + the tract resonance in
  words; *Lips & embouchure*: scope; *Air & lungs*: scope + blow target; *Mouthpiece & reed*:
  spectrum; *Keys & fingering*: the fingering chart + bore impedance — plus that part's sliders.
  × closes it; it reopens on the next grab.
* **Drawers** (closed by default; open/closed state remembered in `localStorage` `saxsim.ui.v1`):
  **Controls** (right; <kbd>Shift</kbd>+<kbd>P</kbd>) holds the full parameter panel; **Scopes**
  (bottom; <kbd>Shift</kbd>+<kbd>S</kbd>) the four visualizers, the tract-overlay checkbox and the
  pressure / flow / gap / level numbers. Esc closes a focused drawer. On phones (≤ 700 px) both are
  bottom sheets and Coach moves into ⋯.

## Play / Explore (auto player)

**Play** (default on a first visit; the choice is remembered in `saxsim.mode.v1`): press keys and
set the **Volume** — the player voices every note for the current mouthpiece setup. **Explore**:
every control is yours, exactly as before.

* **Inputs**: keys in 3D, keyboard note mode, MIDI (velocity → `dynamic`, as before), Hold to blow /
  Space. The **Volume** slider (pp … ff) drives `dynamic` and replaces the Air slider in Play mode.
* **Now-playing bar**: the note plus the auto-player status — *adjusting…*, *locked* (within ±50 ¢ of
  the fingering's target), *struggling — this setup makes the note hard* (not locked after 1.5 s),
  *not a standard fingering* — and **what the player is doing** in plain words ("tongue high and
  forward, firm lip, narrowed throat"), from the effective values.
* **Anatomy**: tongue, lips, jaw, glottis and lungs animate to the effective values the player uses
  (`AppState.shown`; the context-card sliders of those controls follow them and are marked *auto*).
* **Grab to take over**: dragging a player part (or moving its slider in the context card / Controls)
  sets that control's bit in `auto_player_mask`; a chip "you control the tongue · reset" appears in
  the bar, and *reset* hands it back. Mouthpiece and reed handles stay yours in Play mode — change
  the setup, hear the tone, the player adapts. Presets keep Play; changing *Player assist* by hand,
  or loading a player from the coach, switches to Explore.
* **Volume** expectations (engine measurements): pp ≈ −12 dB and ff ≈ +5 dB re mf; palm-key
  notes go down to about −8 dB; altissimo has essentially no pp; C♯7 runs ≈ −28 ¢.
* **Match type**: when the keys are not an exact fingering, the line adds *· nearest fingering*
  (voiced as the closest one) or *· default voicing*.
* **Setup outside the tuned range**: the ranges the auto player was tuned for are read at run time
  from `data/alto_sax.json` → `auto_player.adaptation.validity` (tip opening, reed strength, facing,
  baffle, chamber, throat, insertion, temperature; beam reed unsupported). Outside them, a gentle
  note names the offending settings: "This setup is outside what the auto player was tuned for — …
  Notes may be out of tune."
* **Tuning hint**: the lip can only trim a few cents, so a setup that detunes the whole instrument
  (temperature, cork position, extreme baffle / chamber) leaves every note off. Each note is sampled
  once it has sounded in its register for 0.3 s; when the mean of the last 3–6 notes is beyond
  ±10 ¢, a button says e.g. "Instrument runs 24 ¢ sharp — pull the mouthpiece out ~8 mm · apply";
  one click moves the mouthpiece on the cork (≈ 3 ¢ per mm, the top of the measured 2–3 ¢/mm, so it
  does not overshoot).
* **Breath gate**: in Play mode the player blows at its own pressure whenever `lung_pressure` > 0;
  Hold to blow / Space / note keys / MIDI note-on drive that gate as before, and Volume drives
  `dynamic`. Taking over the lungs (mask bit 9) makes your pressure literal.
* **Altissimo list** (*Altissimo ▴* in the now-playing bar, Play mode): every register-3 entry of
  the auto-player table (`data/alto_sax.json` → `auto_player.entries`, read at run time — currently
  G6 … C♯7) with a fingering diagram (octave, palm and side keys included), the note-mode key that
  plays it (e.g. `]`, `⌫`, `\`, or *↑ then 7*) and its MIDI number (written pitch), the data's caveats
  (`achieved` cents beyond ±15 — C♯7 "runs about −28 ¢"; `ok: false` dynamics; `robust.slur_mf: false`
  → "tongue it — slurring in may fail"), and a ▶ button that fingers and blows it for 1.8 s at the
  current Volume (a second click stops it) and lights its keys on the 3D sax.
* **Voicing close-up** (Play mode; Layers → *Voicing close-up*; on by default on screens ≥ 1024 px,
  off on phones; remembered): a picture-in-picture view of the mid-sagittal mouth and throat (tongue,
  palate, jaw, lips on the mouthpiece, glottis), rendered with a second camera into the main canvas
  after the main frame (`RenderPipeline.renderInset`: no post-processing or shadow refresh; frustum
  culling keeps it cheap; smaller on the *low* render tier). When a new note locks, the previous
  note's settled voicing becomes a dashed ghost for the tongue, tip, jaw and glottis, with arrows to
  where they are now. Below it: the 2–3 biggest control changes ("tongue height 0.40 → 0.88 +0.48"),
  and the tract resonance in the same words as the tongue card ("+182¢ · supporting the note").
  Drag it by its title; – collapses it.
* **Engine contract** (engine `player.rs`, docs/ARCHITECTURE.md): param 27 `auto_player` (0/1);
  param 28 `auto_player_mask` (bits 0–9 = `AUTO_CONTROLS` lip_force, lip_position, lip_damping,
  tongue_x, tongue_y, tongue_tip, tongue_length, jaw_open, glottis_open, lung_pressure; bit 10
  reed_damping, not exposed in the UI). The telemetry block at `IDX_PLAYER` (`AUTO_TEL`, decoded by
  `Telemetry.auto`) has the 10 controls in effect (valid in every mode; lung in kPa), the
  recognised fingering, the match type (0 exact · 1 nearest · 2 default) and the state
  (`AUTO_STATE` 0 idle · 1 settling · 2 locked · 3 struggling), which drive the anatomy, the
  status and the "what the player is doing" line. Play mode also sets `player_assist` = 1 (restored
  in Explore).
* **Fallback** for an engine without the block (older builds): the anatomy shows an estimate
  ("Player (est.)") mirrored from the older player model's documented feed-forward, and the status
  comes from the pitch (`ui/autoPlayer.ts`).

## Start-up

* A **Start audio** button (an AudioContext needs a user gesture) loads `web/public/engine.wasm`
  into an AudioWorklet. **Explore without sound** dismisses the overlay; the 3D model and all
  controls still work (pads/keys follow the local keywork evaluation).
* The status pill (top bar, next to the name) shows `audio off` / `engine running` / `engine not built`
  (run `npm run build:engine`) / `engine error`. Click it to suspend or resume audio.
* Geometry comes from `data/alto_sax.json` (imported through the `@data` alias); the same JSON
  text is handed to the engine with `sax_load_geometry`.

## 3D view

Orbit: left-drag on empty space · pan: right-drag · zoom: wheel / pinch (zooms toward the cursor).

Manipulation (`scene/interaction.ts`, `scene/handles.ts`, `ui/grabHints.ts`):
* **Affordances**: drag handles breathe softly until that part has been dragged once, and ✋ tags
  name the grabbable parts (tongue, lips, jaw, lungs, keys; the detail tags — reed, tongue tip,
  glottis, mouthpiece handles — only in close-ups). A tag retires after its part has been dragged
  (remembered in `saxsim.grabbed.v1`); *Layers → Grab hints* turns hints off, or on again for all
  parts. Handles never shrink below ~6 px radius on screen.
* **Hover** shows a short tag (*part · gesture*) and a `grab` cursor; **while dragging** a large
  readout beside the cursor shows the part, the params it is changing (start → now), the written
  note, its cents and the pitch change since the grab; the handle grows (active state).
* **Hit targets**: drag handles are drawn on top (no depth test) and always win the pick; when the
  ray misses, the nearest handle within 22 px (34 px for touch) is taken.
* **No orbit fights**: a pointer-down that lands on a part is consumed in the capture phase and
  never reaches the orbit controls.
* **Consistent drag gain**: pointer motion is scaled per value axis so a part's full range spans
  200–250 px on screen at any zoom. Ranges are declared with the handle (`planarDrag(…, { ranges })`,
  `axisDrag(…, range)`). Handles are grabbed at their centre; values move relative to the grab.
* <kbd>Shift</kbd> while dragging = fine adjustment (¼ of the pointer motion).
* **Axis lock (lips)**: after 6 px the lip drag commits to *take-in* (along the mouthpiece) or
  *lip force* / *firmness* (toward the reed). The drag card shows the active axis; grab again to
  switch. The tongue body (front/back × low/high) and tongue tip stay 2-D.
* **Declutter**: when a handle cluster is packed closer than 24 px on screen (e.g. the mouthpiece
  handles in the Instrument view), its handles are hidden and not pickable. One tag —
  **mouthpiece ✋** or **tongue & throat ✋** — flies the camera to that view on click. A cluster is
  never collapsed in its own view; the parts' meshes stay grabbable (`ui/clusters.ts`).

Camera presets (top bar, or <kbd>Shift</kbd>+<kbd>1</kbd>…<kbd>4</kbd>):
**Instrument**, **Mouthpiece** (cutaway close-up), **Player** (mid-sagittal cutaway incl. lungs),
**Keys**. Choosing Mouthpiece / Player / Keys also opens that context card. With
`prefers-reduced-motion` the presets jump instead of flying. The projection centre follows the open
UI (`SceneApp.setViewInsets`) so the model stays centred in the free area.

Layers (*Layers ▾*): **Cutaway** (<kbd>Shift</kbd>+<kbd>C</kbd>, mouthpiece and head cut in the mid-sagittal
plane, shows the mouthpiece handles), **X-ray** (<kbd>Shift</kbd>+<kbd>X</kbd>, translucent brass: shows the
inner bore coloured by the standing wave), **Air-flow particles** (<kbd>Shift</kbd>+<kbd>F</kbd>), **Grab
hints**, **Airway readouts** (the 3D pressure/flow labels, off by default). Standing-wave line and
player visibility: Controls → View.

### Mouse → param mapping

| Object (handle colour) | Gesture | Param(s) |
|---|---|---|
| Key touch pieces (pearls, spatulas, palm/side keys, octave thumb key, pinky tables) | click = latch / release · <kbd>Shift</kbd>+click = momentary (held while the button is down) | `sax_set_key(index, 0/1)` |
| Pad cup | click toggles the key that directly acts on that pad; hover shows hole, `vents`, openness | key |
| Lower lip | drag along the mouthpiece axis | `lip_position` (take-in; 1 mm per mm) |
|  | drag toward / away from the reed | `lip_force` (≈ 1 N per 4 mm) |
| Upper lip | drag along axis / ↕ | `lip_position` / `lip_damping` |
| Jaw (green handle at chin, or the chin bone) | drag ↕ | `jaw_open` (down = open) |
| Tongue body (pink handle, or the tongue itself) | drag in the sagittal plane | `tongue_x` (front 0 … back 1), `tongue_y` (low 0 … high 1) |
| Tongue tip (orange handle) | drag ↕ | `tongue_tip` |
|  | drop onto the underside of the reed tip (within ~2 mm, ramps over 7 mm) | `tongue_reed_contact` → 1 |
| Glottis (violet handle) | drag ↕ (up = open) | `glottis_open` |
| Lungs (the lungs themselves; the pressure gauge beside the chest appears while they are hovered / dragged) | drag ↕ (full rail = 10 kPa); while blowing (Space, note, Blow button) the drag sets the blow target instead | `lung_pressure` |
| Mouthpiece tip rail (amber, cutaway) | drag ↕ | `tip_opening` (0.5 mm per mm of drag) |
| Facing break point (amber, on the table) | drag along the axis | `facing_length` |
| Baffle (blue, roof behind the tip) | drag ↕ (down = higher baffle) | `baffle_height` |
| Chamber (blue, roof of chamber) | drag ↕ (up = larger) | `chamber_size` |
| Throat (blue) | drag ↕ | `throat_diameter` |
| Shank (green, on the ligature end) | drag along the axis | `mouthpiece_insertion` (mouthpiece and player slide on the cork) |
| Reed | drag ↕ | `reed_strength` (colour darkens / reed thickens with strength) |

(The "per mm" figures are the natural mapping in the part's own frame; the screen-space drag gain then rescales pointer motion so each full range spans 200–250 px.)

All of these are synchronised both ways with the Controls panel and the context card (dragging moves the sliders; moving
a slider moves the 3D geometry). The mouthpiece interior is drawn with the same equivalent-area
radius the engine uses (PHYSICS.md §9: baffle / chamber bumps, throat window), so dragging the
handles reshapes exactly what the engine simulates.

## Keyboard

Physical keys (`KeyboardEvent.code`), so the layout works on non-QWERTY keyboards too.

| Key | Action |
|---|---|
| <kbd>Space</kbd> (hold) | blow: `lung_pressure` → *Blow target* with exponential attack, back to 0 with release (Air folder: target kPa, attack ms, release ms) |
| <kbd>/</kbd> (hold) | tongue on reed (`tongue_reed_contact` = 1 while held — articulation) |
| <kbd>`</kbd> | toggle **Note mode** ↔ **Direct-key mode** |
| <kbd>Esc</kbd> | release all keys (latched, keyboard and note) |
| <kbd>Shift</kbd>+<kbd>1</kbd>–<kbd>4</kbd> | camera presets |
| <kbd>Shift</kbd>+<kbd>X</kbd> / <kbd>C</kbd> / <kbd>F</kbd> | X-ray / cutaway / air-flow particles |
| <kbd>Shift</kbd>+<kbd>S</kbd> / <kbd>P</kbd> | Scopes drawer / Controls drawer |
| <kbd>?</kbd> | help & shortcuts |

Only text fields stop keyboard play; a focused checkbox, slider or button does not.

(Tip: the blow envelope runs at control rate (8 ms timer), independent of the frame rate.)

**Note mode** (default): tracker-style piano layout over the *written* pitches; each note applies
the first matching entry of `fingerings` in the JSON. With *Auto-blow on note* (default on) a note
key also blows, so you can play legato melodies; the most recently pressed held note sounds.
Transitions behave like a real player: changing notes moves the fingers while the air stays on
(and a 60 ms legato grace bridges a release followed quickly by the next note); releasing the last
note stops the air but **leaves the fingers down**, so the release doesn't flash through the open
C♯5 fingering. <kbd>Esc</kbd> lifts the fingers.

| Row | Keys | Written notes |
|---|---|---|
| lower | <kbd>Z S X D C V G B H N J M</kbd> (+ <kbd>, L . ;</kbd>) | C4 C♯4 D4 E♭4 E4 F4 F♯4 G4 G♯4 A4 B♭4 B4 (+ C5 C♯5 D5 E♭5) |
| upper | <kbd>Q 2 W 3 E R 5 T 6 Y 7 U</kbd> | C5 … B5 |
| top | <kbd>I 9 O 0 P [ = ] ⌫ \</kbd> | C6 C♯6 D6 E♭6 E6 F6 F♯6 G6 G♯6 A6 (altissimo from G6) |
| | <kbd>↑</kbd> / <kbd>↓</kbd> | octave shift (−1 … +1); at −1, <kbd>J</kbd>/<kbd>M</kbd> give B♭3/B3 |

**Direct-key mode** (hold to press the key on the instrument):

| Keys | Sax keys |
|---|---|
| <kbd>Q</kbd> | octave key (LH thumb, `OCT`) |
| <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> | LH1 (B), LH2 (A), LH3 (G) |
| <kbd>G</kbd> | bis B♭ |
| <kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd> | palm D, palm E♭, palm F |
| <kbd>T</kbd> | front F |
| <kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd> | LH pinky table: G♯, low C♯, low B, low B♭ |
| <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> | RH1 (F), RH2 (E), RH3 (D) |
| <kbd>;</kbd> <kbd>'</kbd> | RH pinky: low E♭, low C |
| <kbd>U</kbd> <kbd>I</kbd> <kbd>O</kbd> | RH side keys: high E, side C, side B♭ |
| <kbd>P</kbd> | high F♯ |

Sources combine: a key is down if it is latched by a click, held by the mouse, held on the
keyboard or part of the current note-mode fingering.

## Altissimo & the vocal tract

* **Altissimo notes**: every `alternate_fingerings` entry with `register: 3` in the data (currently
  G6, G♯6, A6) becomes playable in note mode (top row `] ⌫ \`, or octave shift ↑ and `T 6 Y`) and
  over MIDI; the fingering chart recognises them. With *Player assist* > 0 the engine's player
  model voices the note; with assist = 0 the UI applies the entry's `tract` settings plus its
  `embouchure` (or the *Altissimo* preset's) and blows at ≥ the preset's pressure, and restores your
  previous settings when you play a normal note again.
* **Why it works — series impedance**: the reed sees Z_bore + Z_tract. The impedance plot's
  *tract overlay* (checkbox in the Scopes header; always on in the tongue context card) adds Z_tract seen from the reed (cyan,
  `sax_compute_tract_impedance` on the worker's engine instance, recomputed ~100 ms after a tongue /
  jaw / glottis change so it follows live drags) and |Z_bore + Z_tract| (white), with a marker at the
  dominant tract resonance.
* **3D cue**: the *vocal-tract resonance* label in the head shows the resonance, its strength and
  its distance in cents from the note (playing pitch, else the fingering's target); label and airway
  turn **green** when a strong (≥ 10 MPa·s/m³) tract resonance lies from just at to 400 ¢ above the
  note (−30…+400 ¢; the series peak of Z_bore + Z_tract falls between them — the altissimo /
  upper-register voicing), amber when it sits on a lower bore resonance (±50 ¢: may pull the note
  down) or within −500…+900 ¢. The tongue card says it in words — "tuned just above the note —
  supporting it", "may pull the note down", "near harmonic 2 — colours the tone", "little effect" —
  and calls a weak (< 10 MPa·s/m³) resonance "neutral tongue" only when the tongue is actually low.
  In Play mode the overlay is computed from the controls the auto player is using. A *tract-supported* chip appears in the now-playing bar when it is; the tongue context card says it in words.

## Tone coach (M9, docs/COACHING.md)

**Coach** in the top bar (⋯ → Coach on phones) opens the coach (loaded on demand). Privacy: audio is analysed in the
browser only (Web Audio + a Web Worker) and never uploaded; sessions store features, not audio.

1. **Setup** — the protocol v1 test set (Bb3 D4 G4 C5 C♯5 D5 G5 C6 F6, G4 pp/ff), the recommended
   ★ **G4push** reference take (G4 with the mouthpiece pushed 5 mm further onto the cork — it pins the
   pitch-vs-length slope and separates reed strength / lip cushion / support; on by default), optional
   D5 pp/ff and G6, reference A (default 440 Hz), mic tips (close-mic 30–50 cm or a dry room).
   * **Record with the microphone**: `getUserMedia` mono, 48 kHz, echo cancellation / noise
     suppression / auto-gain **off**; level meter and clip warning; per-note prompt with the
     written note, dynamic, target pitch and the fingering diagram; 3-2-1 count-in, 3.4 s take,
     automatic analysis, re-take by clicking the note in the list.
   * **Upload**: one long file (auto-segmented with the engine's `sax_segment`; the detected notes
     are aligned to the protocol by pitch, so a missing or extra note doesn't shift the rest) or
     one file per note (note guessed from the file name, e.g. `03_G4_pp.wav`); any format the
     browser decodes, resampled to 48 kHz; the assignment is editable before analysing.
   * **Try with a simulated player** renders the test set with the engine (planted: mouthpiece
     pulled out) — for exploring without a saxophone.
2. **Analysis** — `sax_analyze` (engine `analysis.rs`, the same extractor the fitter uses) per
   note: table of the main features with stability / scoop / breathiness / vibrato / register chips,
   a tuner-style cents chart, harmonic spectrum (H1–H10, recorded vs fitted simulator) and
   brightness pp → mf → ff. Room-sensitive features (attack, scoop, individual harmonics) are marked.
3. **Fit & advice** — the fitter (`web/src/coach/fit/`, worker pool) with a progress bar; fitted
   controls ± uncertainty; ranked suggestions (cause, what to try, why, what to listen for,
   confidence, ⚑ model-gap / room flags) from `data/coach_model.json` rules — until that file's
   rules land, a provisional rule set implementing the contract's example causes is used and
   labelled as such. **A/B**: pick a note, *A · Load fitted player*, *B · Load suggested change*,
   *▶ Play* (plays the note in the simulator), *Restore my previous settings*.
   * **Recording quality**: the wizard asks for clean tongue stops (not fades) and offers an
     optional **👏 room check** clap; the engine's blind room estimate (`sax_room`: RT60, DRR,
     verdict dry / some room / too reverberant / uncertain) is shown as a badge with advice
     ("move the mic closer to the bell or use a smaller, furnished room"). Room-sensitive
     measurements (attack, scoop, single harmonics, tilt) are caveated for *some room* and greyed out
     for *too reverberant*; room-sensitive suggestions are down-weighted or greyed accordingly.
     Until `sax_room` is in the engine build the badge says the estimate is unavailable.
   * **Advice** (`data/coach_model.json` rules, §Diagnosis): *Most likely causes* = the template
     ranking (`fit/rankCauses`, instant, no fit needed; top 3 with softmax confidence); *Also
     noticed* = observation rules whose machine-readable `trigger`s fire (port of
     `tools/coach/triggers.py`); *From the fit* = the fit-based projection (secondary). Each control
     cause lists its **look-alikes** (confounded controls from `identifiability`), the fitted
     controls show whether the recording determines them. Rules whose `room` requirement the
     verdict doesn't meet are hidden (listed as "not checked"), and the verdict's `room_notes` text
     is shown. A failed fit (`status: failed`, e.g. a take silent in the simulation) lists its
     `problems`; the template advice stays. *Load fitted player* uses the fitter's per-take engine
     params (incl. `dynamic`, `player_assist`); *Load suggested change* moves the cause's controls
     two steps back along its signature on top of that.
   * Recordings are analysed with `sax_analysis_config(95)` (real-instrument ring-down) on a
     dedicated analysis instance; simulated takes keep the engine default (120).
4. **Sessions** — save to this browser, export/import JSON, list with date, takes and mean |¢| to
   track progress.

## MIDI, vibrato

Controls → **MIDI & vibrato** → *Connect MIDI input* (Web MIDI; Chrome/Edge).
* Note-on/off → fingering of that note (MIDI numbers are *written* pitch by default; switch to
  *concert* to add 9 semitones) and blow; *Velocity → blow*: with Player assist > 0, velocity sets the **Dynamic (pp–ff)** control (the player model moves pressure, lip and jaw together); with assist = 0 (pure physics) it scales the blow target 0.7…1.3×.
* CC2 (breath) / CC11 (expression) → lung pressure directly (0…*Breath max* kPa) — once a breath
  controller sends, it owns the air until *Release breath controller*. Notes then only finger.
* CC1 (mod wheel) → jaw-vibrato depth (or tongue height), CC120/123 → release all.
* **Jaw vibrato**: periodic jaw motion at *rate* Hz (default 5.5) that lowers the lip force on the
  reed (−0.7 N × depth) and opens the jaw (±0.08 × depth), around your own settings; by default
  only while blowing. (Note: with the current engine calibration the lip-force → pitch sensitivity
  is small, so the vibrato is mostly a loudness/timbre wobble with a few cents of pitch.)

## Recording & export

* **⋯ → ● Record WAV** (a red *REC m:ss* pill in the top bar shows it is running; click it to stop) or Controls → *Record WAV*: records the engine output (16-bit mono WAV at the
  audio sample rate) via a tap processor in the engine's worklet module; stop to download.
* *Capture telemetry CSV*: one row per telemetry block (~60 Hz; time, lung/mouth/mouthpiece
  pressure, reed displacement & opening, flow, f0, RMS, recognised fingering, all params).
* Presets: *Save current as user preset…* (★, kept in localStorage), *Delete selected ★ preset*,
  *Export current setup / ★ user presets* (JSON), *Import presets* (a preset or an array).
  A `presets` array in `data/alto_sax.json` (`{name, description?, params: {param_name: value},
  blow?}`) overrides built-ins of the same name; an entry named like *altissimo* replaces the
  built-in "Altissimo setup" (hook for the acoustics lead's tract tuning).

## Fingering chart & tour

* The chart (in the *Keys & fingering* context card — click a key or choose the Keys view) is a schematic of the key layout from the data's key ids: pressed keys
  are brass, latched keys have an orange ring, the recognised fingering (incl. alternates) is
  named on top; click a key to latch it.
* **Quick tour** (⋯ menu; also shown once on first run, `saxsim.tour.v1`): four steps — *Blow*,
  *Grab the tongue*, *Lips & mouthpiece*, *Keys — and everything else* — each moving the camera to
  the relevant view. Altissimo and the series-impedance explanation are in Help.

## Tests

* `npm run test:unit` — `web/tests/keywork.test.ts`: `keywork.ts` vs the wasm engine's pad
  openness for all fingerings, alternates and 60 random fractional key states.
* `npm run test:e2e` also runs the coach end to end: a synthetic player (engine renders of the
  test set with the mouthpiece pulled out, a Schroeder room and a mic EQ) is written to a WAV and
  uploaded → segmentation (11/11 notes) → analysis → fit → ranked suggestions → A/B params. The
  planted cause in the top 3 is asserted once `data/coach_model.json` rules exist (reported
  meanwhile); fit quality is reported, not asserted.
* `npm run test:e2e` — `web/tests/e2e.mjs` (puppeteer-core + local Chrome, Vite dev server
  started programmatically): audio starts, a C4–G5 scale in note mode lands within ±50 ¢ of each
  fingering's `f_target`, lung/tongue drags change their params, the UI checks (drawers closed by
  default and toggling with `aria-expanded`, drag readout, tongue → tract context card, Hold to
  blow), the impedance plot recomputes on a fingering change, no page errors. Skips (exit 0) without Chrome unless `E2E_REQUIRE=1`.

## Controls drawer (right)

lil-gui, grouped exactly like the param table: **Air** (+ blow target/attack/release),
**Embouchure**, **Tongue & Tract**, **Reed** (+ visual reed-motion gain), **Mouthpiece**,
**Instrument**, **Environment**, **Engine**; then **View** (camera, layers, standing-wave line,
player, **Render quality** Auto / High / Medium / Low with the current tier and fps —
`scene/render/quality.ts`) and **Keyboard play**.
**Preset** dropdown: Default, Jazz bright, Subtone, Altissimo setup, Classical dark
(`web/src/ui/presets.ts`; presets set every non-Engine/Environment param and the blow target).

## Readouts & visualizers

* Now-playing bar: written note for E♭ alto (+9 semitones, large), cents, concert note + estimated
  playing frequency (telemetry 6), the current fingering name (matched against `fingerings` and
  `alternate_fingerings`), register chip, output level. Scopes header: lung / mouth / mouthpiece
  pressure, reed-channel flow U (L/s), reed gap h, output dBFS, beating / non-beating chip, frame
  rate, engine µs/block (native builds only) and the telemetry transport.
* Oscilloscope: the 64-sample mouthpiece pressure and reed-tip displacement traces from telemetry
  (auto-scaled).
* Spectrum: `AnalyserNode` on the output (log frequency, harmonic markers at k·f0).
* Standing wave: instantaneous pressure and ±√2·RMS envelope along the bore (reed → bell).
* On the 3D model: a glowing line along the centreline displaced by the instantaneous pressure
  profile (visible whenever the engine is running) and the inner bore surface coloured by
  pressure (orange +, blue −; RMS glow) — see it through the bell or with X-ray.
* Pads animate from engine pad-openness telemetry; for 90 ms after a key change (and whenever
  the engine is not running) they follow the local `keywork.ts` prediction for instant feedback.
* Reed: drawn at the telemetry tip displacement; the oscillating part is exaggerated by
  *Reed motion ×* (the static bend stays to scale) and it never passes the lay.
* Air-flow particles from the lungs through the trachea, glottis, vocal tract, reed channel and
  bore out of the bell; speed and brightness ∝ |U| (telemetry 5); the airway is tinted by mouth
  pressure.

## Observation tools (M5)

* **Input impedance** (4th visualizer): |Z_in| at the reed end (rigid reed) for the current
  fingering, mouthpiece shape, insertion and temperature, on a log axis 60 Hz–3 kHz, with the
  resonance peaks numbered and labelled in Hz, the playing frequency (orange) and its harmonics
  (dashed). It is computed by `sax_compute_impedance` on a second engine instance in a Web Worker
  (`web/src/engine/impedance.worker.ts`, ~0.2 s per curve), recomputed 120 ms after a key change /
  250 ms after an acoustic param change, so the audio thread is never touched. Works without
  starting audio.
* **Register / regime chips** (now-playing bar; beating reed in the Scopes header): which impedance peak the note sits on
  (1st register, 2nd register, altissimo = peak ≥ 3, or off-resonance → squeak/multiphonic?),
  beating vs non-beating reed (reed scope reaches the tip opening), silent / tongue on reed.
* **What changed**: while you drag, the drag readout shows `param old → new` and the pitch Δ¢ since
  the grab; after a drag or a slider / preset change, a line above the now-playing bar shows the
  param that moved most in the gesture (a gesture ends after 1.5 s without changes).
* **Vocal-tract readouts** (Layers → Airway readouts, off by default): labels anchored in 3D (lungs: p_lung; glottis: opening and
  transglottal Δp; mouth: p_mouth; reed channel: U, h, p_mp), shown when the camera is within
  ~1.9 m (Player / Mouthpiece views).
* **Beam reed**: when the engine appends the 32-sample reed deflection profile (tip → ligature
  clamp) to telemetry, the cutaway reed is drawn from it (oscillating part × *Reed motion*),
  otherwise from the tip displacement with a cantilever shape. *Reed model* (0 lumped / 1 beam)
  and *Player assist* appear in the Reed / Embouchure folders; params the UI does not know a
  folder for land in **Advanced**.

## Implementation notes

* Worklet bundling: `import url from './worklet.ts?worker&url'` + `audioWorklet.addModule(url)`
  (a plain `new URL('./worklet.ts', import.meta.url)` would be copied untranspiled in production);
  the production build emits `dist/assets/worklet-*.js`.
* `web/src/scene/keywork.ts` mirrors `engine/src/keywork.rs` (incl. clamping of press amounts and
  dropping unknown key names); verified identical on all fingerings, alternates and random
  fractional key states.
* Telemetry transport: a `SharedArrayBuffer` seqlock written by the worklet every 2 render quanta
  and read once per animation frame (`EngineClient.poll`) when `crossOriginIsolated`; otherwise
  `postMessage`. The Scopes header shows which transport is active.
* Per-frame paths allocate nothing: telemetry is decoded into preallocated arrays, the head
  geometry is rebuilt in place only when one of its params changes, particle and wave buffers are
  updated in place.
* Debug handle: `window.__sax` (`state`, `scene`, `engine`, `kb`, `geo`) in the browser console.
