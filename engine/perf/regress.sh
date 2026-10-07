#!/usr/bin/env bash
# Performance regression harness (result-preserving optimisation check).
#
#   bash engine/perf/regress.sh golden   # render the golden set with the perf-owned sources
#                                        # (OWN below) taken from git $BASE_REF (default HEAD)
#                                        # and every other file as in the working tree
#   bash engine/perf/regress.sh check    # render with the current tree, compare to golden
#   bash engine/perf/regress.sh check cs5   # only scenarios whose name contains "cs5"
#
# Tolerances (examples/regress.rs): RMS rel. error < 1e-4 on output and mouthpiece
# pressure, pitch within 0.1 cent. Breath noise is off, so renders are deterministic.
# The golden records hashes of all other files; `check` warns when they changed since
# (others' edits change the physics: re-run `golden` then).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENG="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$ENG/.." && pwd)"
GOLD="$HERE/golden"
# files whose optimisations the harness guards (perf engineer); everything else is "physics"
OWN=(src/fdtd.rs src/resample.rs)
BASE_REF="${BASE_REF:-HEAD}"
PHYS=()
for f in "$ENG"/src/*.rs; do
  r="src/$(basename "$f")"; [[ " ${OWN[*]} " == *" $r "* ]] || PHYS+=("$r")
done
phys_hash() { (cd "$ENG" && cat "${PHYS[@]}" "$ROOT/data/alto_sax.json") | shasum | cut -d' ' -f1; }
mode="${1:-check}"; filt="${2:-}"
case "$mode" in
  golden)
    B="$ENG/target/regress_base"
    mkdir -p "$B"
    rsync -a --delete --exclude target --exclude perf "$ENG/" "$B/crate/"
    for f in "${OWN[@]}"; do git -C "$ROOT" show "$BASE_REF:engine/$f" > "$B/crate/$f"; done
    echo "golden: ${OWN[*]} from $BASE_REF ($(git -C "$ROOT" rev-parse --short "$BASE_REF")), rest from the working tree"
    (cd "$B/crate" && CARGO_TARGET_DIR="$B/target" cargo build --release --example regress -q)
    # the copied crate resolves data/ relative to its manifest: link it
    ln -sfn "$ROOT/data" "$B/data"
    rm -rf "$GOLD"; mkdir -p "$GOLD"
    "$B/target/release/examples/regress" write "$GOLD" $filt
    phys_hash > "$GOLD/physics.sha"
    # snapshot of the physics inputs the golden was made with (for diffing later)
    mkdir -p "$GOLD/physics"; (cd "$ENG" && cp "${PHYS[@]}" "$GOLD/physics/"); cp "$ROOT/data/alto_sax.json" "$GOLD/physics/"
    ;;
  check)
    (cd "$ENG" && cargo build --release --example regress -q)
    if [[ -f "$GOLD/physics.sha" && "$(phys_hash)" != "$(cat "$GOLD/physics.sha")" ]]; then
      echo "WARNING: physics files / geometry changed since the golden was written — re-run: $0 golden" >&2
      for f in "${PHYS[@]}"; do cmp -s "$ENG/$f" "$GOLD/physics/$(basename "$f")" || echo "  changed: $f" >&2; done
      cmp -s "$ROOT/data/alto_sax.json" "$GOLD/physics/alto_sax.json" || echo "  changed: data/alto_sax.json" >&2
    fi
    "$ENG/target/release/examples/regress" check "$GOLD" $filt
    ;;
  *) echo "usage: $0 golden|check [filter]"; exit 2;;
esac
