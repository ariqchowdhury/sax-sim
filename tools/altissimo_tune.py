#!/usr/bin/env python3
"""
Find, with the engine in the loop, the vocal-tract setting (tongue_y, tongue_x, jaw) that makes each
altissimo fingering sound its written note, and verify the real-world contrast: the same fingering
with a neutral tract does NOT sound the altissimo note.

    SAX_RENDER=engine/target/release/render python3 tools/altissimo_tune.py [--write]

--write stores the per-note tract settings in tools/hole_table.json ("altissimo") so that
tools/build_geometry.py emits them (alternate_fingerings[*].tract and the "Altissimo" preset).
"""
import os, re, sys, json, math, subprocess, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_geometry as BG
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDER = os.environ.get("SAX_RENDER", os.path.join(ROOT, "engine", "target", "release", "render"))
JSON = os.path.join(ROOT, "data", "alto_sax.json")
EMB = dict(player_assist=0, lip_force=1.8, lip_position=11, lip_damping=0.2, reed_damping=0.1, glottis_open=0.05)


def play(keys, sets, p):
    cmd = [RENDER, "--keys", ",".join(keys), "--pressure", str(p), "--seconds", "1.2", "--attack", "0.05", "--geometry", JSON]
    for k, v in sets.items():
        cmd += ["--set", f"{k}={v}"]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    f = re.search(r"f0=([\d.]+)", out); r = re.search(r"mp_rms=([\d.]+)", out)
    return (float(f[1]) if f else 0.0), (float(r[1]) if r else 0.0)


def cents(f, t):
    return 1200 * math.log2(f / t) if f > 0 else float("nan")


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--write", action="store_true"); a = ap.parse_args()
    results = {}
    for alt in BG.ALTISSIMO:
        note, keys = alt["note"], alt["keys"]
        ft = 440 * 2 ** ((BG.note_midi(note) - 9 - 69) / 12)
        best = None
        for ty in [1.0, 0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.93]:
            for tx in (0.0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06):
                for jaw in (0.15,):
                    sets = dict(EMB, tongue_y=ty, tongue_x=tx, jaw_open=jaw)
                    f, rms = play(keys, sets, 4.5)
                    c = cents(f, ft)
                    if not math.isnan(c) and (best is None or abs(c) < abs(best[0])):
                        best = (c, ty, tx, jaw, f, rms)
        c, ty, tx, jaw, f, rms = best
        tr = dict(tongue_y=ty, tongue_x=tx, jaw_open=jaw)
        chk = {p: play(keys, dict(EMB, **tr), p) for p in (3.0, 3.5, 4.0, 5.0)}
        neutral = {p: play(keys, dict(EMB), p) for p in (3.5, 5.0)}
        neutral_def = {p: play(keys, dict(player_assist=0), p) for p in (3.5, 5.0)}
        print(f"{note} ({ft:.1f} Hz) keys {','.join(keys)}: tract tongue_y={ty} tongue_x={tx} jaw={jaw}")
        print("   tuned  : " + "  ".join(f"{p} kPa {fv:.0f} Hz ({cents(fv, ft):+.0f} c, {r:.0f} Pa)" for p, (fv, r) in chk.items()))
        print("   neutral tract, altissimo embouchure: " + "  ".join(f"{p} kPa {fv:.0f} Hz" for p, (fv, r) in neutral.items()))
        print("   neutral tract, default embouchure  : " + "  ".join(f"{p} kPa {fv:.0f} Hz" for p, (fv, r) in neutral_def.items()))
        results[note] = dict(tract=tr, cents_4p5=round(c, 1))
    if a.write:
        with open(BG.HOLE_TABLE) as fh:
            tbl = json.load(fh)
        tbl["altissimo"] = dict(embouchure={k: v for k, v in EMB.items() if k != "player_assist"}, notes=results)
        with open(BG.HOLE_TABLE, "w") as fh:
            json.dump(tbl, fh, indent=1)
        BG.build(tbl, write=True)
        print("written to tools/hole_table.json and data/alto_sax.json")


if __name__ == "__main__":
    main()
