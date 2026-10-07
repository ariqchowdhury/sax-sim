#!/usr/bin/env python3
"""
Optimise the octave (register-2) behaviour of the design: neck taper shape, neck entry radius,
mouthpiece chamber scale and the two octave vents (position, radius).
Objective = 'octave error' of each D4..C#5 fingering:  cents( f_reg2(with vent) / (2 f_reg1) ),
which is insensitive to the tone-hole positions (those are re-tuned afterwards by tune.py).

    python3 tools/design_octaves.py        # updates tools/hole_table.json params/vents
"""
import sys, os, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import build_geometry as BG
import tmm

A = tmm.air(22.0)
LOW = ["D4", "Eb4", "E4", "F4", "F#4", "G4", "G#4", "A4", "Bb4", "B4", "C5", "C#5"]


def load():
    with open(BG.HOLE_TABLE) as f:
        return json.load(f)


def octave_errors(tbl, verbose=False):
    g = tmm.Geometry(doc=BG.build(tbl, write=False))
    errs = []
    for n in LOW:
        f1 = next(f for f in g.doc["fingerings"] if f["note"] == n)
        m2 = f1["written_midi"] + 12
        f2 = next(f for f in g.doc["fingerings"] if f["written_midi"] == m2 and f["register"] == 2)
        r1 = tmm.predict(g, f1["keys"], f1["f_target"], A, 1)
        r2 = tmm.predict(g, f2["keys"], 2 * r1["f"], A, 2, span_cents=300)
        errs.append(1200 * math.log2(r2["f"] / (2 * r1["f"])))
    errs = np.array(errs)
    if verbose:
        print("  octave errors:", " ".join(f"{n}:{e:+.0f}" for n, e in zip(LOW, errs)))
    return errs


def apply(tbl, v):
    p = tbl.setdefault("params", {})
    p["neck_power"], p["r_neck_in"] = v[0], v[1] * 1e-3
    p["mp_r_chamber"] = v[2] * 1e-3
    tbl["holes"]["oct_neck"].update(x=v[3], radius=v[4] * 1e-3)
    tbl["holes"]["oct_body"].update(x=v[5], radius=v[6] * 1e-3)
    p["mp_r_baffle"] = v[7] * 1e-3


def cost(v, tbl):
    lo = [0.6, 5.4, 5.5, 0.09, 0.8, BG.x_body0() + 0.012, 0.8, 3.8]
    hi = [2.5, 7.0, 9.0, 0.26, 2.2, tbl["holes"]["C"]["x"] - 0.004, 2.2, 6.5]
    if v[7] > v[2]:
        return 1e6
    if any(a < l or a > h for a, l, h in zip(v, lo, hi)):
        return 1e6
    apply(tbl, v)
    e = octave_errors(tbl)
    if not np.all(np.isfinite(e)):
        return 1e6
    return float(np.sqrt(np.mean(e ** 2)) + 0.7 * np.max(np.abs(e)))


if __name__ == "__main__":
    from scipy.optimize import minimize
    tbl = load()
    p = tbl.get("params", {})
    v0 = [p.get("neck_power", 1.0), p.get("r_neck_in", 0.0061) * 1e3, p.get("mp_r_chamber", 0.0068) * 1e3,
          tbl["holes"]["oct_neck"]["x"], tbl["holes"]["oct_neck"].get("radius", 0.0014) * 1e3,
          min(max(tbl["holes"]["oct_body"]["x"], BG.x_body0() + 0.015), tbl["holes"]["C"]["x"] - 0.005), tbl["holes"]["oct_body"].get("radius", 0.0015) * 1e3,
          p.get("mp_r_baffle", 0.005) * 1e3]
    print("start", v0, cost(v0, tbl)); octave_errors(tbl, True)
    step = [0.3, 0.4, 0.6, 0.03, 0.3, 0.006, 0.3, 0.4]
    sim = [v0] + [[v0[j] + (step[j] if j == i else 0) for j in range(8)] for i in range(8)]
    res = minimize(cost, v0, args=(tbl,), method="Nelder-Mead",
                   options=dict(maxfev=int(sys.argv[1]) if len(sys.argv) > 1 else 250, initial_simplex=np.array(sim), xatol=1e-4, fatol=0.02))
    apply(tbl, res.x)
    print("best", [round(a, 4) for a in res.x], res.fun)
    octave_errors(tbl, True)
    with open(BG.HOLE_TABLE, "w") as f:
        json.dump(tbl, f, indent=1)
