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
| `npm run test:e2e` | headless-Chrome smoke test: starts audio, plays a scale (pitch within ±50 ¢ of target), drags lung/tongue handles, checks the impedance plot recomputes. Uses a local Chrome/Chromium (`CHROME_PATH` to override); skipped if none is found |
| `npm run typecheck` | `tsc --noEmit` |
| `cargo test` (in `engine/`) | engine unit tests |

## Controls (summary)

* **Mouse**: click keys (Shift = momentary); drag the lower lip (take-in / force), upper lip,
  chin (jaw), tongue body & tip (drop it on the reed to tongue), glottis, lung handle (pressure);
  in the mouthpiece cutaway drag tip opening, facing, baffle, chamber, throat, insertion; drag the
  reed for strength. Orbit with left-drag on empty space.
* **Keyboard**: Space = blow · `/` = tongue · `` ` `` toggles note mode (piano layout `Z…M`,
  `Q…U`, `I…=` → written C4…F♯6) and direct-key mode (`Q` octave, `ASD` LH, `JKL` RH, …) · Esc
  releases all · Shift+1–4 cameras.
* **MIDI**: note-on → fingering + blow (velocity → pressure), CC2/CC11 breath controller → lung
  pressure, mod wheel → jaw vibrato depth (or tongue height); legato keeps the air on.
* **Panel**: every parameter, presets (incl. your own, saved locally and exportable as JSON),
  jaw vibrato, WAV recording and telemetry CSV capture.
* **Tour** button: a guided first-run walkthrough.

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

## Milestones

Plan, team roles and milestone status: **[PLAN.md](PLAN.md)**.
