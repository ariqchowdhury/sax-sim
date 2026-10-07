#!/usr/bin/env python3
"""
Tune the alto geometry with the TMM model so that the standard fingerings play in equal temperament.

    python3 tools/tune.py          # tune, write tools/hole_table.json and data/alto_sax.json

Procedure (bottom-up, repeated):
  1. body length (bell end) -> Bb3
  2. each tone hole x (from the bell upward) -> the first-register note it vents
  3. palm/side holes x -> D6, Eb6, E6, F6, F#6 ; side C hole -> C5 (side C)
Hole radius = DELTA[hole] * local bore radius (build_geometry.DELTA); chimneys fixed.
Octave behaviour (neck taper, mouthpiece shape, vents) is designed separately by
tools/design_octaves.py; typical loop: tune.py -> design_octaves.py -> tune.py.
Options: --fresh (ignore tools/hole_table.json), --quick (one pass instead of three).
"""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import build_geometry as BG
import tmm

A = tmm.air(22.0)
FIRST_ORDER = ["low_Bb", "low_B", "low_Cs", "low_C", "low_Eb", "D", "E", "F", "Fs", "Gs", "G", "A", "Bb_bis", "B", "C"]
PALM = [("palm_D", "D6"), ("palm_Eb", "Eb6"), ("side_E", "E6"), ("palm_F", "F6"), ("high_Fs", "F#6")]


def make(tbl):
    doc = BG.build(tbl, write=False)
    return tmm.Geometry(doc=doc)


def fing(g, note):
    return next(f for f in g.doc["fingerings"] if f["note"] == note)


def note_err(tbl, note, keys=None):
    g = make(tbl)
    f = fing(g, note)
    r = tmm.predict(g, keys or f["keys"], f["f_target"], A, f["register"])
    return r["cents"]


def secant(fun, x0, x1, tol=0.3, maxit=14, lo=None, hi=None):
    """Secant root find; x increases -> pitch decreases (cents monotone decreasing) is assumed for fallback."""
    f0, f1 = fun(x0), fun(x1)
    for _ in range(maxit):
        if math.isfinite(f1) and abs(f1) < tol:
            break
        if not (math.isfinite(f0) and math.isfinite(f1)) or f1 == f0:
            x2 = x1 + 0.003
        else:
            x2 = x1 - f1 * (x1 - x0) / (f1 - f0)
            x2 = min(max(x2, x1 - 0.03), x1 + 0.03)
        if lo is not None:
            x2 = max(lo, x2)
        if hi is not None:
            x2 = min(hi, x2)
        x0, f0, x1 = x1, f1, x2
        f1 = fun(x1)
    return x1, f1


def main():
    tbl = {"params": {}, "holes": {}}
    if os.path.exists(BG.HOLE_TABLE) and "--fresh" not in sys.argv:
        with open(BG.HOLE_TABLE) as f:
            tbl = json.load(f)
        tbl.pop("predicted", None)
    for hid, rest, rad, chim, ang, vents, octv, x0 in BG.HOLES0:
        tbl["holes"].setdefault(hid, {"x": x0})
    vent_note = {h[0]: h[5] for h in BG.HOLES0}

    def set_param(name, v):
        tbl["params"][name] = v

    def set_x(hid, v):
        tbl["holes"][hid]["x"] = v
        d = BG.DELTA.get(hid)
        if d:
            tbl["holes"][hid]["radius"] = min(BG.MAX_HOLE_RADIUS, d * BG.r_bore(v))

    n_outer = 3 if "--quick" not in sys.argv else 1
    for it in range(n_outer):
        # 1. bell end
        L0 = tbl["params"].get("body_len", BG.P["body_len"])
        def fb(L):
            set_param("body_len", L); return note_err(tbl, "Bb3")
        L, e = secant(fb, L0, L0 + 0.01)
        set_param("body_len", L)
        print(f"[{it}] body_len={L:.4f} Bb3 {e:+.2f}c")
        # 2. holes bottom-up
        prev_x = BG.x_end() - 0.02
        for hid in FIRST_ORDER:
            note = vent_note[hid]
            x0 = tbl["holes"][hid]["x"]
            def fh(x, hid=hid, note=note):
                set_x(hid, x); return note_err(tbl, note)
            x, e = secant(fh, x0, x0 + 0.004, lo=0.30, hi=prev_x)
            set_x(hid, x)
            prev_x = x - 0.002
            print(f"[{it}] {hid:7s} -> {note:4s} x={x:.4f} {e:+.2f}c")
        # 3. palm keys & side C
        for hid, note in PALM:
            x0 = tbl["holes"][hid]["x"]
            def fp(x, hid=hid, note=note):
                set_x(hid, x); return note_err(tbl, note)
            x, e = secant(fp, x0, x0 + 0.004, lo=BG.x_body0() + 0.004, hi=tbl["holes"]["C"]["x"] - 0.004)
            set_x(hid, x)
            print(f"[{it}] {hid:7s} -> {note:4s} x={x:.4f} {e:+.2f}c")
        def fsc(x):
            set_x("side_C", x); return note_err(tbl, "C5", ["LH1", "RH_side_C"])
        x, e = secant(fsc, tbl["holes"]["side_C"]["x"], tbl["holes"]["side_C"]["x"] + 0.003, lo=0.31, hi=0.65)
        set_x("side_C", x)
        print(f"[{it}] side_C  -> C5   x={x:.4f} {e:+.2f}c")

    # final table
    g = make(tbl)
    rows = tmm.fingering_table(g, A)
    tbl["predicted"] = {f["note"]: {"f": round(r["f"], 3), "cents": round(r["cents"], 2)} for f, r in rows}
    with open(BG.HOLE_TABLE, "w") as f:
        json.dump(tbl, f, indent=1)
    BG.build(tbl, write=True)
    worst = {1: 0, 2: 0}
    for f, r in rows:
        worst[f["register"]] = max(worst[f["register"]], abs(r["cents"]))
        print(f"{f['note']:5s} reg{f['register']} {f['f_target']:8.2f} {r['f']:8.2f} {r['cents']:+6.1f}")
    print("worst", worst)


if __name__ == "__main__":
    main()
