#!/usr/bin/env python3
"""
Altissimo voicing search with the engine in the loop.

For each altissimo note, candidate fingerings (common alto-chart patterns plus fingerings whose BORE
resonance lies 0..+90 cents above the target, from tools/altissimo_search.py --lo 0 --hi 90) are played
over a grid of vocal-tract settings (tongue_y, tongue_x, tongue_tip; jaw 0.15) with the altissimo
embouchure at 3.5 / 4 / 4.5 / 5 kPa. Score = worst |cents| over 4-5 kPa (+ penalty if it does not
speak at 3.5 kPa); a candidate is accepted only if the neighbouring tongue positions (tongue_x +- 0.015)
give the same regime within 40 cents (no hysteretic edge). The neutral-tract contrast is reported.

    SAX_RENDER=engine/target/release/render python3 tools/altissimo_tune.py [--notes G6,A6] [--write]

--write stores the chosen fingering + tract per note in tools/hole_table.json["altissimo"]; then
tools/build_geometry.py emits alternate_fingerings entries
    {note, name, keys, register: 3, f_target, tract: {tongue_y, tongue_x, tongue_tip, jaw_open},
     embouchure: {lip_force, lip_position, lip_damping, reed_damping, glottis_open}}
and the "Altissimo" preset.
"""
import os, re, sys, json, math, subprocess, argparse, itertools
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_geometry as BG
import numpy as np
import tmm, tract_tmm
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDER = os.environ.get("SAX_RENDER", os.path.join(ROOT, "engine", "target", "release", "render"))
JSON = os.path.join(ROOT, "data", "alto_sax.json")
EMB = dict(lip_force=1.8, lip_position=11, lip_damping=0.2, reed_damping=0.1, glottis_open=0.05)

# candidate fingerings per note: chart-style first, then bore-anchored ones from altissimo_search
CANDIDATES = {
    "G6": [["OCT", "LH_front_F", "LH1", "LH3"], ["OCT", "LH1", "LH3", "LH_Gs"], ["OCT", "LH1"], ["OCT", "LH1", "LH_Gs"],
           ["OCT", "LH1", "LH2", "RH_side_C", "RH1"]],
    "G#6": [["OCT", "LH_front_F", "LH1", "LH3", "LH_Gs"], ["OCT", "LH1", "RH_side_C", "RH1", "RH3"],
            ["OCT", "LH1", "RH_side_C", "RH1", "RH2"], ["OCT", "LH1", "RH_side_C", "RH1"], ["OCT", "LH1", "BIS", "RH_side_C", "LH_Gs"]],
    "A6": [["OCT", "LH2", "RH1"], ["OCT", "LH2", "RH_side_C", "RH1"], ["OCT", "LH1", "LH2", "LH3", "RH_side_C"],
           ["OCT", "LH1", "LH2", "LH3", "LH_Gs"]],
    "Bb6": [["OCT", "RH_side_C", "RH3"], ["OCT", "RH_side_C", "LH_Gs"], ["OCT", "RH_side_C", "RH1", "RH3"], ["OCT", "LH_Gs"]],
    "B6": [["OCT", "LH_palm_D", "RH3"], ["OCT", "LH_palm_D", "RH_side_C", "RH3"], ["OCT", "LH_palm_D", "RH_side_C", "LH_Gs"]],
    "C7": [["OCT", "LH1", "LH2", "LH_palm_D", "RH1", "RH3"], ["OCT", "LH_palm_Eb", "RH_side_C", "RH3"], ["OCT", "LH_palm_Eb", "RH_side_C"]],
    "C#7": [["OCT", "LH1", "LH2", "LH_palm_D", "LH_palm_Eb", "RH3"], ["OCT", "LH1", "BIS", "LH_palm_Eb", "RH3"],
            ["OCT", "LH1", "BIS", "LH_palm_D", "LH_palm_Eb", "RH3"], ["OCT", "LH1", "LH_palm_D", "LH_palm_Eb", "RH1"],
            ["OCT", "LH_palm_Eb", "RH_side_C"]],
    "D7": [["OCT", "LH_palm_D", "LH_palm_Eb", "RH_side_E", "RH_side_C"], ["OCT", "LH_palm_D", "LH_palm_Eb", "RH_side_E"],
           ["OCT", "LH1", "BIS", "LH_palm_Eb", "RH_side_E", "RH3"], ["OCT", "LH_palm_D", "LH_palm_Eb", "RH_side_E", "RH_side_C", "RH3"]],
}
TY = [0.8, 0.85, 0.9, 0.93, 0.96, 1.0]
TX = [0.0, 0.03, 0.06, 0.09, 0.12, 0.15]
TIP = [0.3, 0.8]
# above ~1.2 kHz the tract resonance needs a lower tongue body with the tip raised (smaller front cavity)
HIGH = dict(TY=[0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9], TX=[0.0, 0.03, 0.06], TIP=[0.8, 0.95, 1.0])
HIGH_NOTES = ("C7", "C#7", "D7")
MAX_ACCEPT = 60.0   # worst |cents| over 4-5 kPa to accept a voicing
ACCURATE = 25.0     # voicings within this are ranked by tract strength (weakest first)
P_SCORE = (4.0, 4.5, 5.0)


def ftarget(note):
    return 440 * 2 ** ((BG.note_midi(note) - 9 - 69) / 12)


def play(keys, sets, p):
    cmd = [RENDER, "--keys", ",".join(keys), "--pressure", str(p), "--seconds", "1.2", "--attack", "0.05", "--geometry", JSON,
           "--set", "player_assist=0"]
    for k, v in sets.items():
        cmd += ["--set", f"{k}={v}"]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    f = re.search(r"f0=([\d.]+)", out)
    return float(f[1]) if f else 0.0


def tract_peak(tr, glottis_open, f0):
    """|Z_tract| maximum (MPa s/m^3) within +-25 % of f0 for this tongue setting and glottal area."""
    fr = np.arange(0.75 * f0, 1.4 * f0, 2.0)
    a_g = (0.05 + glottis_open * 1.95) * 1e-4
    z = tract_tmm.tract_impedance(fr, tx=tr[1], ty=tr[0], tip=tr[2], jaw=0.15, a_glottis=a_g)
    return float(np.max(np.abs(z))) / 1e6


def cents(f, t):
    return 1200 * math.log2(f / t) if f > 0 else 9999.0


EMB_GRID = None   # set by --emb-grid: list of embouchure dicts to try per note
STRICT_35 = False  # --strict35: 3.5 kPa counts in the worst-case error


def evaluate(note, keys, tr, emb=None):
    ft = ftarget(note)
    sets = dict(emb or EMB, jaw_open=0.15, tongue_y=tr[0], tongue_x=tr[1], tongue_tip=tr[2])
    fs = [play(keys, sets, p) for p in (3.5,) + P_SCORE]
    cs = [cents(f, ft) for f in fs]
    worst = max(abs(c) for c in (cs if STRICT_35 else cs[1:]))
    score = worst + (0 if abs(cs[0]) < 100 else 15)
    return score, cs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--notes")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--emb-grid", action="store_true", help="also search lip force 1.6-2.0 N, lip position 10-12 mm, glottis 0.02-0.08")
    ap.add_argument("--strict35", action="store_true")
    a = ap.parse_args()
    global EMB_GRID, STRICT_35
    STRICT_35 = a.strict35
    if a.emb_grid:
        EMB_GRID = [dict(EMB, lip_force=lf, lip_position=11, glottis_open=g)
                    for lf in (1.8, 2.0) for g in (0.05, 0.4, 0.8)]
    notes = a.notes.split(",") if a.notes else list(CANDIDATES)
    with open(BG.HOLE_TABLE) as fh:
        tbl = json.load(fh)
    alt = tbl.setdefault("altissimo", {})
    alt["embouchure"] = dict(EMB)
    alt.setdefault("notes", {})
    pool = ThreadPoolExecutor(max_workers=os.cpu_count() or 8)
    for note in notes:
        ft = ftarget(note)
        trials = []
        jobs = []
        grid = HIGH if note in HIGH_NOTES else dict(TY=TY, TX=TX, TIP=TIP)
        embs = EMB_GRID or [EMB]
        if EMB_GRID and note in HIGH_NOTES:
            embs = embs + [dict(e, lip_force=2.3) for e in embs if e["lip_force"] == 2.0]
        for keys in CANDIDATES[note]:
            for tr in itertools.product(grid["TY"], grid["TX"], grid["TIP"]):
                for ei in range(len(embs)):
                    jobs.append((keys, tr, ei))
        res = list(pool.map(lambda j: ((j[0], j[1], j[2]), evaluate(note, j[0], j[1], embs[j[2]])), jobs))
        # accurate voicings first; among those within ACCURATE cents prefer the WEAKEST tract
        # (closest to measured players, Chen, Smith & Wolfe: tens of MPa s/m^3), then accuracy
        def key(r):
            (keys, tr, ei), (score, cs) = r
            if score <= ACCURATE:
                return (0, tract_peak(tr, embs[ei]["glottis_open"], ft), score)
            return (1, 0.0, score)
        res.sort(key=key)
        chosen = None
        for (keys, tr, ei), (score, cs) in res[:25]:
            emb = embs[ei]
            if score > MAX_ACCEPT + 15:
                break
            # robustness: neighbours in tongue_x must stay in the same regime (not a hysteretic edge)
            ok = True
            for dx in (-0.015, 0.015):
                tx = min(max(tr[1] + dx, 0.0), 1.0)
                f = play(keys, dict(emb, jaw_open=0.15, tongue_y=tr[0], tongue_x=tx, tongue_tip=tr[2]), 4.5)
                if abs(cents(f, ft) - cs[2]) > 40:
                    ok = False
                    break
            if ok:
                chosen = ((keys, tr, emb), (score, cs))
                break
        if chosen is None:
            print(f"{note} ({ft:.0f} Hz): no robust altissimo voicing found (best score {res[0][1][0]:.0f})")
            alt["notes"].pop(note, None)
            continue
        (keys, tr, emb), (score, cs) = chosen
        neutral = [cents(play(keys, dict(emb), p), ft) for p in (3.5, 4.5, 5.0)]
        neutral_def = [play(keys, {}, p) for p in (3.5, 4.5)]
        print(f"{note} ({ft:.1f} Hz) keys {','.join(keys)}  tongue_y={tr[0]} tongue_x={tr[1]} tongue_tip={tr[2]}  emb {emb}"
              f"  tract peak {tract_peak(tr, emb['glottis_open'], ft):.0f} MPa s/m^3")
        print("   tuned  : " + "  ".join(f"{p} kPa {c:+.0f} c" for p, c in zip((3.5,) + P_SCORE, cs)))
        print("   neutral tract, altissimo embouchure: " + "  ".join(f"{p} kPa {c:+.0f} c" for p, c in zip((3.5, 4.5, 5.0), neutral))
              + f"   default embouchure: {neutral_def[0]:.0f} / {neutral_def[1]:.0f} Hz")
        alt["notes"][note] = dict(keys=keys, tract=dict(tongue_y=tr[0], tongue_x=tr[1], tongue_tip=tr[2], jaw_open=0.15),
                                  embouchure=dict(emb), tract_peak_mpa=round(tract_peak(tr, emb["glottis_open"], ft), 1),
                                  cents=[round(c, 1) for c in cs], pressures=[3.5, 4.0, 4.5, 5.0])
        sys.stdout.flush()
    if a.write:
        with open(BG.HOLE_TABLE, "w") as fh:
            json.dump(tbl, fh, indent=1)
        BG.build(tbl, write=True)
        print("written to tools/hole_table.json and data/alto_sax.json")


if __name__ == "__main__":
    main()
