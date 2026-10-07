#!/usr/bin/env bash
# Physics-lead integration chain (round 7). Re-run after any engine physics change
# (reed, flow, tract, lungs, player dynamics) — order matters:
#   1. normal-range retune (pure physics) and validation tables
#   2. altissimo voicings (engine in the loop, weakest robust tract)
#   3. overtone sweep (low Bb–C#, 550–800 Hz gap check)
#   4. coach model (sensitivity, robustness, templates, validation) -> data/coach_model.json
#   5. perf golden + regress check, cargo test (dev + release), wasm
# Usage: bash tools/final_integration.sh            (≈ 60–90 min on 10 cores)
set -euo pipefail
cd "$(dirname "$0")/.."
PY=tools/.venv/bin/python
TGT=${CARGO_TARGET_DIR_INTEGRATION:-/tmp/sax_integration_target}
(cd engine && cargo build --release --bin render --target-dir "$TGT")
export SAX_RENDER="$TGT/release/render"

echo "== 1. normal range"
$PY tools/engine_loop.py tune --iters 4 --set player_assist=0
$PY tools/validation_report.py > tools/validation_report.md
$PY tools/embouchure_table.py > tools/embouchure_table.md

echo "== 2. altissimo"
$PY tools/altissimo_tune.py --emb-grid --strict35 --write | tee tools/altissimo_tune.log

echo "== 3. overtones"
$PY tools/overtone_sweep.py | tee tools/overtone_sweep.log

echo "== 4. coach model"
$PY tools/coach/study.py sensitivity
$PY tools/coach/study.py robustness
$PY tools/coach/study.py identifiability
COACH_EXTRA=G4push $PY tools/coach/study.py sensitivity
COACH_EXTRA=D5pp,D5ff,G4push,C6ff $PY tools/coach/study.py sensitivity
COACH_EXTRA=D5pp,D5ff,G4push,C6ff $PY tools/coach/study.py robustness
for ex in G4push D5pp,D5ff,G4push,C6ff; do COACH_EXTRA=$ex $PY tools/coach/study.py identifiability; done
$PY tools/coach/fit.py templates
COACH_EXTRA=G4push $PY tools/coach/fit.py templates
$PY tools/coach/fit.py validate_fast --n 60 --seed 77
COACH_EXTRA=G4push $PY tools/coach/fit.py validate_fast --n 60 --seed 77
$PY tools/coach/build_model.py

echo "== 5. golden, tests, wasm"
(cd engine && bash perf/regress.sh golden && bash perf/regress.sh check && cargo test && cargo test --release)
bash engine/build_wasm.sh
