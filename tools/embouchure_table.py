#!/usr/bin/env python3
"""Measure playing-pitch sensitivity to embouchure / tract controls with the engine renderer.
    SAX_RENDER=engine/target/release/render python3 tools/embouchure_table.py [--notes A4,C#5,C#6]"""
import os, re, subprocess, sys, argparse
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDER = os.environ.get("SAX_RENDER", os.path.join(ROOT, "engine", "target", "release", "render"))
SWEEPS = [("lip_force", [0.6, 1.0, 1.4, 2.0]), ("lip_position", [8, 12, 16, 20]), ("jaw_open", [0.1, 0.3, 0.6, 0.9]),
          ("tongue_y", [0.2, 0.4, 0.7, 1.0]), ("tongue_x (tongue_y=1)", [0.5, 0.35, 0.25, 0.15, 0.05]),
          ("lip_damping", [0.1, 0.4, 0.8]), ("reed_strength", [2.0, 2.5, 3.5])]

def play(note, sets, p=3.5):
    cmd = [RENDER, "--fingering", note, "--pressure", str(p), "--seconds", "1.2", "--attack", "0.05",
           "--geometry", os.path.join(ROOT, "data", "alto_sax.json")]
    for k, v in sets.items():
        cmd += ["--set", f"{k}={v}"]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    m = re.search(r"f0=([\d.]+) Hz target=[\d.]+ \(([-+\d.]+) cents\)", out)
    return (float(m[1]), float(m[2])) if m else (0.0, float("nan"))

ap = argparse.ArgumentParser(); ap.add_argument("--notes", default="A4,C#5,C#6"); ap.add_argument("--assist", default="0")
a = ap.parse_args()
print("| control | values | " + " | ".join(a.notes.split(",")) + " |")
print("|---|---|" + "---|" * len(a.notes.split(",")))
for name, vals in SWEEPS:
    cells = []
    for n in a.notes.split(","):
        cs = []
        for v in vals:
            sets = {"player_assist": a.assist}
            if name.startswith("tongue_x"):
                sets.update(tongue_y=1.0, tongue_x=v)
            else:
                sets[name] = v
            f, c = play(n, sets)
            cs.append("—" if abs(c) > 300 or f == 0 else f"{c:+.0f}")
        cells.append(" / ".join(cs))
    print(f"| {name} | {' / '.join(str(v) for v in vals)} | " + " | ".join(cells) + " |", flush=True)
