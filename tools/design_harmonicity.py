#!/usr/bin/env python3
"""
Optimise bore harmonicity of the register-1 fingerings (Benade's criterion): the 2nd (and 3rd)
input-impedance peaks of every first-register fingering should lie at 2x (3x) the 1st peak.
Inharmonic peaks destabilise the fundamental regime (low notes jump to the octave) and
mistune the overblown register. Free parameters: neck taper exponent and entry radius,
mouthpiece baffle/chamber radii, bell-flare length and shape exponent.

    python3 tools/design_harmonicity.py [maxfev]      # updates tools/hole_table.json params

The objective target for f2/(2 f1) is TARGET2 cents (slightly flat: the octave vent then raises
the 2nd peak by 0..+30 cents, and the self-oscillating engine plays register 2 ~10-40 cents below
the vented peak, see docs/VALIDATION.md).
"""
import sys, os, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import build_geometry as BG
import tmm

A = tmm.air(22.0)
NOTES = ["Bb3", "B3", "C4", "C#4", "D4", "Eb4", "E4", "F4", "F#4", "G4", "G#4", "A4", "Bb4", "B4", "C5", "C#5"]
TARGET2 = float(os.environ.get("HARM_TARGET2", "0"))
NAMES = ["neck_power", "r_neck_in", "mp_r_chamber", "mp_r_baffle", "bell_flare_len", "flare_power"]
SCALE = [1, 1e-3, 1e-3, 1e-3, 1, 1]
LO = [0.5, 5.2, 6.0, 4.0, 0.10, 1.5]
HI = [2.5, 7.0, 10.0, 7.5, 0.40, 6.0]


def harm(tbl, verbose=False):
    g = tmm.Geometry(doc=BG.build(tbl, write=False))
    e2, e3 = [], []
    for n in NOTES:
        f = next(q for q in g.doc["fingerings"] if q["note"] == n)
        op = g.hole_openness(f["keys"])
        r1 = tmm.predict(g, f["keys"], f["f_target"], A, 1, span_cents=250)
        f1 = r1["f"]
        out = []
        for m in (2, 3):
            fr = np.exp(np.linspace(np.log(m * f1 * 0.85), np.log(m * f1 * 1.15), 160))
            pk = tmm.find_peaks(fr, tmm.input_impedance(g, fr, op, A))
            out.append(1200 * math.log2(min(pk, key=lambda q: abs(q[0] - m * f1))[0] / (m * f1)) if pk else 300.0)
        e2.append(out[0]); e3.append(out[1])
    e2, e3 = np.array(e2), np.array(e3)
    if verbose:
        print("  f2/2f1:", " ".join(f"{n}:{e:+.0f}" for n, e in zip(NOTES, e2)))
        print("  f3/3f1:", " ".join(f"{n}:{e:+.0f}" for n, e in zip(NOTES, e3)))
    return e2, e3


def apply(tbl, v):
    p = tbl.setdefault("params", {})
    for n, s, x in zip(NAMES, SCALE, v):
        p[n] = x * s


def cost(v, tbl):
    if any(a < l or a > h for a, l, h in zip(v, LO, HI)) or v[3] > v[2]:
        return 1e6
    apply(tbl, v)
    try:
        e2, e3 = harm(tbl)
    except Exception:
        return 1e6
    d = e2 - TARGET2
    return float(np.sqrt(np.mean(d ** 2)) + 0.5 * np.max(np.abs(d)) + 0.3 * np.sqrt(np.mean(e3 ** 2)))


if __name__ == "__main__":
    from scipy.optimize import minimize
    with open(BG.HOLE_TABLE) as f:
        tbl = json.load(f)
    BG.P.update(tbl.get("params", {}))
    v0 = [BG.P[n] / s for n, s in zip(NAMES, SCALE)]
    print("start", [round(x, 4) for x in v0], cost(v0, tbl)); harm(tbl, True)
    step = [0.3, 0.4, 0.8, 0.5, 0.05, 0.8]
    sim = [v0] + [[v0[j] + (step[j] if j == i else 0) for j in range(len(v0))] for i in range(len(v0))]
    res = minimize(cost, v0, args=(tbl,), method="Nelder-Mead",
                   options=dict(maxfev=int(sys.argv[1]) if len(sys.argv) > 1 else 200, initial_simplex=np.array(sim), xatol=1e-4, fatol=0.05))
    apply(tbl, res.x)
    print("best", dict(zip(NAMES, [round(a, 4) for a in res.x])), round(res.fun, 2))
    harm(tbl, True)
    with open(BG.HOLE_TABLE, "w") as f:
        json.dump(tbl, f, indent=1)
