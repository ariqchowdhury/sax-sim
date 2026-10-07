# Alto Sax — a first-principles physical simulation

A real-time, interactive 3D simulation of an **alto saxophone and its player**, computed from
first-principles acoustics in the browser:

```
lungs → glottis → vocal tract (tongue, jaw) → lips → reed → mouthpiece → bore & tone holes → bell → you
```

Every functional part can be grabbed in the 3D view — lungs, tongue, lips, jaw, keys, the
mouthpiece interior — and the sound responds live. Observation tools show what the physics is
doing: the standing wave on the bore, reed motion, the input impedance of the current fingering,
pressures and flow in the airway.

## Physics in one paragraph

The air columns (vocal tract, mouthpiece, neck, conical body, every tone-hole chimney) are 1-D
Webster-horn FDTD grids with visco-thermal losses, oversampled (default 4× = 192 kHz) and
decimated. Tone holes are side branches whose pads open continuously through the real key
mechanism (keys → linkages → pads, data-driven). The bell and open holes radiate through passive
Levine–Schwinger approximations. The reed is a lumped oscillator or a distributed Euler–Bernoulli
beam with lay and lip contact, driven by quasi-stationary Bernoulli flow; the mouth pressure comes
from the acoustic vocal tract, so tongue position really bends pitch and enables altissimo.
Temperature sets c, ρ and viscosity. Details and references: **[docs/PHYSICS.md](docs/PHYSICS.md)**.

## Build & run

Prerequisites
* **Node ≥ 22** (developed with Node 26) and npm
* **Rust** (stable) with the wasm target: `rustup target add wasm32-unknown-unknown`
* Python 3 + numpy/scipy only for the validation tools in `tools/`

```bash
npm install
npm run build:engine   # cargo build → web/public/engine.wasm (checks the ABI exports)
npm run dev            # Vite dev server (COOP/COEP headers set) → open the printed URL
```

Click **Start audio** (browsers need a gesture), then hold **Space** or play notes on the keyboard.
Without `engine.wasm` the 3D model still loads and reports "engine not built".

Other scripts

| script | |
|---|---|
| `npm run build` | type-check + production build to `dist/` (serve with `npm run preview`; the server must send COOP/COEP for SharedArrayBuffer) |
| `npm test` | `test:unit` (keywork.ts ≡ engine keywork on all fingerings) + `test:e2e` |
| `npm run test:e2e` | headless-Chrome smoke test: starts audio, plays a scale (pitch within ±50 ¢ of target), drags the lungs / tongue, checks the drawers, drag readout, context card and Blow button, checks the impedance plot recomputes, runs the coach end to end. Uses a local Chrome/Chromium (`CHROME_PATH` to override); skipped if none is found |
| `npm run typecheck` | `tsc --noEmit` |
| `cargo test` (in `engine/`) | engine unit tests |

## Controls (summary)

The 3D view is the instrument: everything you can grab glows softly and carries a ✋ tag, and
while you drag, a readout next to the cursor shows the value and what it does to the pitch.
Everything else is one click away and closed by default (state remembered).

* **Mouse / touch**: drag the lungs (pressure), tongue body & tip (drop the tip on the reed to
  tongue), lower lip (take-in / force), upper lip, jaw, glottis; in the mouthpiece cutaway the tip
  opening, facing, baffle, chamber, throat and cork position; the reed (strength). Click keys
  (Shift = momentary). Shift while dragging = fine adjust. Empty space: orbit / pan / zoom.
* **Bottom bar**: the note you play (written), cents, register, and **Hold to blow** with the
  **Air** (blow pressure) slider.
* **Context card**: grabbing a part (or picking its camera view) shows just that part's sliders and
  the one plot that explains it (tongue → tract impedance, mouthpiece → spectrum, keys → fingering
  chart + impedance, …).
* **Top bar**: camera views · **Layers** (cutaway, X-ray, air flow, grab hints, airway readouts) ·
  **Scopes** drawer (scope, spectrum, standing wave, impedance + tract overlay) · **Controls**
  drawer (every parameter, presets, MIDI & vibrato, recording / export, render quality) · **Coach** ·
  **⋯** (record WAV, quick tour, help).
* **Keyboard**: Space = blow · `/` = tongue · `` ` `` toggles note mode (piano layout `Z…M`,
  `Q…U`, `I…=` → written C4…F♯6) and direct-key mode (`Q` octave, `ASD` LH, `JKL` RH, …) · Esc
  releases all · Shift+1–4 cameras · Shift+S scopes · Shift+P controls · `?` help.
* **MIDI**: note-on → fingering + blow (velocity → pp–ff dynamic, or pressure in pure-physics mode), CC2/CC11 breath controller → lung
  pressure, mod wheel → jaw vibrato depth (or tongue height); legato keeps the air on.
* **Controls drawer**: every parameter, presets (incl. your own, saved locally and exportable as
  JSON), jaw vibrato, WAV recording and telemetry CSV capture.
* **Altissimo** (G6 and up): played with the data's `register: 3` fingerings and a tuned vocal
  tract; the impedance plot's *tract overlay* shows Z_tract and Z_bore + Z_tract (the series load
  the reed works against), and the 3D tract label turns green when the tract is tuned to the note.
* **Coach**: record (or upload) a short test set on your own alto; the app measures every note,
  fits the simulated player to it, ranks likely causes with concrete things to try, and lets you
  A/B the fitted and suggested settings in the simulator. Audio never leaves the browser
  ([docs/COACHING.md](docs/COACHING.md)).
* **Quick tour** (⋯ menu): a 4-step first-run walkthrough. UX rationale: [docs/UX_REVIEW.md](docs/UX_REVIEW.md).

Full reference: **[docs/UI.md](docs/UI.md)**.

## Project layout

```
engine/            Rust crate (cdylib → wasm32, rlib → native): FDTD bore, reed, flow, tone holes,
                   radiation, vocal tract, lungs, keywork; src/lib.rs = C ABI; src/bin/render.rs
                   offline renderer; examples/ calibration & benchmarks; build_wasm.sh
data/alto_sax.json geometry + keys + linkages + fingerings — single source of truth (engine & 3D)
web/               Vite + TypeScript + Three.js app
  src/engine/      AudioWorklet host, EngineClient (SharedArrayBuffer telemetry), impedance worker,
                   params table, WAV/CSV recording
  src/scene/       procedural saxophone, mouthpiece cutaway, player cutaway, keywork, picking/drags
  src/ui/          panel, visualizers, keyboard/MIDI/vibrato, presets, fingering chart, tour
  tests/           keywork unit test, headless e2e test
tools/             Python reference: transfer-matrix impedance (tmm.py), tuning, render analysis
docs/              PHYSICS.md (spec), ARCHITECTURE.md (contracts: ABI, params, telemetry),
                   UI.md (controls), VALIDATION.md (targets & results)
```

## Validation

The engine is checked against literature values and an independent frequency-domain
transfer-matrix model (`tools/tmm.py`): impedance peaks, playing frequencies per fingering,
oscillation thresholds, spectra. See **[docs/VALIDATION.md](docs/VALIDATION.md)**.

## For players

* [docs/ALTISSIMO.md](docs/ALTISSIMO.md) — how altissimo works (vocal-tract tuning, embouchure, fingerings) and a practice route, from the literature and the simulator.
* [docs/OVERTONES.md](docs/OVERTONES.md) — what controls overtones on a low fingering (Rascher-style), and how to practise them.

## Milestones

Plan, team roles and milestone status: **[PLAN.md](PLAN.md)**.
