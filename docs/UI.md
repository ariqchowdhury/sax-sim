# UI & Controls

Owner: graphics / interaction. Code: `web/src/` (scene in `scene/`, panels and visualizers in `ui/`,
audio bridge in `engine/`). Run with `npm run dev`; build with `npm run build`.

## Start-up

* A **Start audio** button (an AudioContext needs a user gesture) loads `web/public/engine.wasm`
  into an AudioWorklet. **Explore without sound** dismisses the overlay; the 3D model and all
  controls still work (pads/keys follow the local keywork evaluation).
* The status pill (top bar) shows `audio off` / `engine running` / `engine not built`
  (run `npm run build:engine`) / `engine error`. Click it to suspend or resume audio.
* Geometry comes from `data/alto_sax.json` (imported through the `@data` alias); the same JSON
  text is handed to the engine with `sax_load_geometry`.

## 3D view

Orbit: left-drag on empty space · pan: right-drag · zoom: wheel (zooms toward the cursor).
Hovering anything interactive shows a tooltip with the param name and live value.
Drag handles are drawn on top of everything (no depth test) and always win the pick.

Camera presets (top bar, or <kbd>Shift</kbd>+<kbd>1</kbd>…<kbd>4</kbd>):
**Instrument**, **Mouthpiece** (cutaway close-up), **Player** (mid-sagittal cutaway incl. lungs),
**Keys**.

Toggles: **X-ray** (<kbd>Shift</kbd>+<kbd>X</kbd>, translucent brass: shows the inner bore coloured by the
standing wave), **Cutaway** (<kbd>Shift</kbd>+<kbd>C</kbd>, mouthpiece and head cut in the mid-sagittal plane,
shows the mouthpiece handles), air-flow particles (<kbd>Shift</kbd>+<kbd>F</kbd>), standing-wave line, player.

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
| Lungs / pressure gauge (blue handle in front of the chest) | drag ↕ (full rail = 10 kPa) | `lung_pressure` |
| Mouthpiece tip rail (amber, cutaway) | drag ↕ | `tip_opening` (0.5 mm per mm of drag) |
| Facing break point (amber, on the table) | drag along the axis | `facing_length` |
| Baffle (blue, roof behind the tip) | drag ↕ (down = higher baffle) | `baffle_height` |
| Chamber (blue, roof of chamber) | drag ↕ (up = larger) | `chamber_size` |
| Throat (blue) | drag ↕ | `throat_diameter` |
| Shank (green, on the ligature end) | drag along the axis | `mouthpiece_insertion` (mouthpiece and player slide on the cork) |
| Reed | drag ↕ | `reed_strength` (colour darkens / reed thickens with strength) |

All of these are synchronised both ways with the side panel (dragging moves the sliders; moving
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
| <kbd>?</kbd> | help overlay |

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
  *tract overlay* (checkbox in the Observation header) adds Z_tract seen from the reed (cyan,
  `sax_compute_tract_impedance` on the worker's engine instance, recomputed ~100 ms after a tongue /
  jaw / glottis change so it follows live drags) and |Z_bore + Z_tract| (white), with a marker at the
  dominant tract resonance.
* **3D cue**: the *vocal-tract resonance* label in the head shows the resonance, its strength and
  its distance in cents from the note (playing pitch, else the fingering's target); label and airway
  turn **green** when a strong (≥ 10 MPa·s/m³) tract resonance lies between 150 ¢ below and 450 ¢
  above the note (the series peak of Z_bore + Z_tract falls between them), amber within −500…+900 ¢. A *tract-supported* chip appears in the pitch card when it is.

## MIDI, vibrato

Panel → **MIDI & vibrato** → *Connect MIDI input* (Web MIDI; Chrome/Edge).
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

* **● Rec** (top bar) or panel → *Record WAV*: records the engine output (16-bit mono WAV at the
  audio sample rate) via a tap processor in the engine's worklet module; stop to download.
* *Capture telemetry CSV*: one row per telemetry block (~60 Hz; time, lung/mouth/mouthpiece
  pressure, reed displacement & opening, flow, f0, RMS, recognised fingering, all params).
* Presets: *Save current as user preset…* (★, kept in localStorage), *Delete selected ★ preset*,
  *Export current setup / ★ user presets* (JSON), *Import presets* (a preset or an array).
  A `presets` array in `data/alto_sax.json` (`{name, description?, params: {param_name: value},
  blow?}`) overrides built-ins of the same name; an entry named like *altissimo* replaces the
  built-in "Altissimo setup" (hook for the acoustics lead's tract tuning).

## Fingering chart & tour

* The small chart (left) is a schematic of the key layout from the data's key ids: pressed keys
  are brass, latched keys have an orange ring, the recognised fingering (incl. alternates) is
  named on top; click a key to latch it.
* **Tour** (top bar; also shown once on first run): six steps — blow, fingers, lips & jaw, tongue &
  throat, mouthpiece, what to watch — each moving the camera to the relevant view.

## Tests

* `npm run test:unit` — `web/tests/keywork.test.ts`: `keywork.ts` vs the wasm engine's pad
  openness for all fingerings, alternates and 60 random fractional key states.
* `npm run test:e2e` — `web/tests/e2e.mjs` (puppeteer-core + local Chrome, Vite dev server
  started programmatically): audio starts, a C4–G5 scale in note mode lands within ±50 ¢ of each
  fingering's `f_target`, lung/tongue drags change their params, the impedance plot recomputes on
  a fingering change, no page errors. Skips (exit 0) without Chrome unless `E2E_REQUIRE=1`.

## Panel (right)

lil-gui, grouped exactly like the param table: **Air** (+ blow target/attack/release),
**Embouchure**, **Tongue & Tract**, **Reed** (+ visual reed-motion gain), **Mouthpiece**,
**Instrument**, **Environment**, **Engine**; then **View** and **Keyboard play**.
**Preset** dropdown: Default, Jazz bright, Subtone, Altissimo setup, Classical dark
(`web/src/ui/presets.ts`; presets set every non-Engine/Environment param and the blow target).

## Readouts & visualizers

* Pitch card: estimated playing frequency (telemetry 6), concert note name + cents, written
  note for E♭ alto (+9 semitones); lung / mouth / mouthpiece pressure, reed-channel flow U
  (L/s), reed gap h, output level; the current fingering name (matched against `fingerings` and
  `alternate_fingerings`); frame rate and engine µs/block (native builds only).
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
* **Register / regime chips** (pitch card): which impedance peak the note sits on
  (1st register, 2nd register, altissimo = peak ≥ 3, or off-resonance → squeak/multiphonic?),
  beating vs non-beating reed (reed scope reaches the tip opening), silent / tongue on reed.
* **What changed**: while you drag or move a slider, the card shows `param old → new · pitch Δ¢`
  measured from the start of the gesture (a gesture ends after 1.5 s without changes).
* **Vocal-tract readouts**: labels anchored in 3D (lungs: p_lung; glottis: opening and
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
  `postMessage`. The pitch card shows which transport is active.
* Per-frame paths allocate nothing: telemetry is decoded into preallocated arrays, the head
  geometry is rebuilt in place only when one of its params changes, particle and wave buffers are
  updated in place.
* Debug handle: `window.__sax` (`state`, `scene`, `engine`, `kb`, `geo`) in the browser console.
