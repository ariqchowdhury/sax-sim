#!/usr/bin/env python3
"""
Overtone (partial) availability sweep on low fingerings (Rascher-style overtone exercises), pure physics.

    SAX_RENDER=... python3 tools/overtone_sweep.py [--notes Bb3,B3,C4,C#4]

For each fingering, renders a grid of voicings (tongue_y × tongue_x × jaw × glottis) × embouchures
(lip force, lip damping) × blowing pressures and records which partial n = round(f0 / f1) sounds.
Reports the partials reached and the 550-800 Hz band coverage (OVERTONES.md gap check).
"""
import os, re, sys, math, json, itertools, argparse, subprocess
from concurrent.futures import ThreadPoolExecutor
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDER = os.environ.get("SAX_RENDER", os.path.join(ROOT, "engine", "target", "release", "render"))
GEOM = os.path.join(ROOT, "data", "alto_sax.json")
NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]


def f_target(note):
    m = 12 * (int(note[-1]) + 1) + NAMES.index(note[:-1]) - 9
    return 440 * 2 ** ((m - 69) / 12)


def play(note, sets, p):
    cmd = [RENDER, "--fingering", note, "--pressure", str(p), "--seconds", "1.2", "--attack", "0.05", "--geometry", GEOM,
           "--set", "player_assist=0", "--set", "oversample=2"]
    for k, v in sets.items():
        cmd += ["--set", f"{k}={v}"]
    m = re.search(r"f0=([\d.]+)", subprocess.run(cmd, capture_output=True, text=True).stdout)
    return float(m[1]) if m else 0.0


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--notes", default="Bb3,B3,C4,C#4"); a = ap.parse_args()
    grid = list(itertools.product([0.2, 0.6, 0.9, 1.0], [0.0, 0.2, 0.4, 0.6, 0.8], [0.15, 0.5], [0.05, 0.8],
                                  [0.6, 1.4, 2.2], [0.2, 0.6], [3.0, 4.5]))
    pool = ThreadPoolExecutor(os.cpu_count() or 8)
    out = {}
    for note in a.notes.split(","):
        f1 = f_target(note)
        jobs = [(dict(tongue_y=ty, tongue_x=tx, jaw_open=j, glottis_open=g, lip_force=lf, lip_damping=ld), p)
                for ty, tx, j, g, lf, ld, p in grid]
        fs = list(pool.map(lambda jb: play(note, jb[0], jb[1]), jobs))
        parts = {}
        band = 0
        for f in fs:
            if f <= 0:
                continue
            n = f / f1
            k = round(n)
            if abs(1200 * math.log2(n / k)) < 80 if k > 0 else False:
                parts[k] = parts.get(k, 0) + 1
                if 550 <= f <= 800:
                    band += 1
        out[note] = dict(settings=len(jobs), partials={str(k): v for k, v in sorted(parts.items())}, band_550_800=band)
        print(f"{note} ({f1:.1f} Hz): {len(jobs)} settings; partial: count = " +
              ", ".join(f"{k}:{v}" for k, v in sorted(parts.items())) + f"; sounding in 550-800 Hz: {band}", flush=True)
    json.dump(out, open(os.path.join(ROOT, "tools", "overtone_sweep.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
