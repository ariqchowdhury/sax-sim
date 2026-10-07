#!/usr/bin/env python3
"""
Design the nominal mouthpiece equivalent-area profile so that mouthpiece + reed compliance
replaces the missing cone apex over the playing range (Benade's criterion extended to frequency):
the resonance frequencies f1..f3 of [mouthpiece + truncated cone cut at length L] are fitted to those
of the complete cone of the same length, for L spanning C#5..Bb3 fingerings (no tone holes).
Throat (11 mm), tip radius and shank radius are fixed; the baffle/chamber radii are free.

    python3 tools/design_mouthpiece.py      # prints the optimal profile (paste into build_geometry.mouthpiece_profile)
"""
import sys, os, math, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import build_geometry as BG
import tmm

A = tmm.air(22.0)
XS = [0.004, 0.010, 0.018, 0.026, 0.034, 0.042, 0.048, 0.053]
CUTS = [0.33, 0.40, 0.48, 0.58, 0.70, 0.85, 1.0]


def doc_for(mp_pts, cut, full_cone=False):
    xa = BG.x_apex()
    if full_cone:
        prof = [[0.0, 1e-4], [cut - xa, BG.r_cone(cut)]]
    else:
        prof = [list(p) for p in mp_pts] + [[cut, BG.r_cone(cut)]]
    return {"mouthpiece": {"profile": prof}, "neck": {"profile": []}, "body": {"profile": []},
            "tone_holes": [], "keys": [], "linkages": [],
            "meta": {"reed_equivalent_volume": 0.0 if full_cone else BG.P["reed_volume"]}}


def peaks(doc, fmax):
    g = tmm.Geometry(doc=doc)
    fr = np.arange(80, fmax, 1.0)
    pk = tmm.find_peaks(fr, tmm.input_impedance(g, fr, {}, A))
    return [p[0] for p in pk[:3]]


REF = {}
for c in CUTS:
    REF[c] = peaks(doc_for(None, c, True), 2600)


def make_pts(v):
    rn = BG.P["r_neck_in"]
    pts = [(0.0, 0.0030)] + [(x, r * 1e-3) for x, r in zip(XS, v)] + [(0.057, 0.0055), (0.062, 0.0055), (0.068, 0.0058), (BG.P["mp_len_air"], rn)]
    return pts


TARGET_R2 = -8.0   # desired 1200*log2(f2/(2 f1)) without octave vent (the vent then adds a few cents)


def cost(v, verbose=False):
    v = np.asarray(v)
    # physical constraints: radii 3..10 mm, chamber/baffle region never narrower than the throat (5.5 mm)
    if np.any(v < 3.0) or np.any(v > 10.0) or np.any(v[3:] < 5.5):
        return 1e6
    pts = make_pts(v)
    err = []
    for c in CUTS:
        p = peaks(doc_for(pts, c), 2600)
        if len(p) < 3:
            return 1e6
        r2 = 1200 * math.log2(p[1] / (2 * p[0])) - TARGET_R2
        r3 = 1200 * math.log2(p[2] / (3 * p[0])) - 1200 * math.log2(REF[c][2] / (3 * REF[c][0]))
        err.append((r2, r3))
        if verbose:
            print(f"cut {c:.2f}: f1 {p[0]:7.1f} (cone {REF[c][0]:7.1f})  f2/2f1 {r2+TARGET_R2:+6.1f}c  f3/3f1 rel. cone {r3:+6.1f}c")
    err = np.array(err)
    w = np.array([1.0, 0.25])
    sm = np.sum(np.diff(v, 2) ** 2) * 0.3
    return float(np.sqrt(np.mean((err * w) ** 2)) + 0.5 * np.max(np.abs(err[:, 0]))) + sm


if __name__ == "__main__":
    from scipy.optimize import minimize
    v0 = [4.0, 4.9, 6.0, 7.0, 7.6, 7.7, 7.1, 6.2] if len(sys.argv) < 2 else [float(a) for a in sys.argv[1].split(',')]
    print("initial"); cost(v0, True)
    res = minimize(cost, v0, method="Nelder-Mead", options=dict(maxfev=900, xatol=1e-3, fatol=1e-3))
    print("final cost", res.fun)
    cost(res.x, True)
    pts = make_pts(res.x)
    print("profile:", [(round(x, 4), round(r, 5)) for x, r in pts])
    print("volume cm3:", BG.profile_volume(pts) * 1e6, "missing cone cm3:", BG.missing_cone_volume() * 1e6)
