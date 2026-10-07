#!/usr/bin/env python3
"""
Altissimo load analysis: Z_bore (TMM), Z_tract (tract_tmm, glottal slit), reed admittance (two-mode
lumped reed: tip + body) and the load the reed flow sees, Z_load = 1/(1/(Z_bore+Z_tract) + Y_reed).
Prints the 'regimes' (Re Z_load where Im Z_load crosses zero from + to -) for each altissimo
fingering, with and without the tract.

    python3 tools/altissimo_load.py [--notes G6,A6] [--reed "Vtip,fr,q,Vbody,fb,qb"]
"""
import sys, os, math, json, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, tmm, tract_tmm

# altissimo embouchure reed (engine/examples/reedpar 1.8 11 0.2 0.1)
REED_ALT = (2.89e-7, 2446.0, 0.216, 2.89e-7, 3669.0, 0.60)


def reed_Y(fr, reed, rho, c):
    w = 2 * np.pi * fr
    Y = 0
    for V, f0, q in ((reed[0], reed[1], reed[2]), (reed[3], reed[4], reed[5])):
        r = fr / f0
        Y = Y + 1j * w * V / (rho * c * c) / (1 - r * r + 1j * q * r)
    return Y


def regimes(fr, Z, zmin=3e6):
    out = []
    for i in range(len(fr) - 1):
        if Z[i].imag > 0 and Z[i + 1].imag <= 0:
            if Z[i].real > zmin:
                out.append((fr[i], Z[i].real))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--notes")
    ap.add_argument("--reed")
    ap.add_argument("--fmin", type=float, default=300)
    ap.add_argument("--fmax", type=float, default=1600)
    a = ap.parse_args()
    reed = tuple(float(v) for v in a.reed.split(",")) if a.reed else REED_ALT
    g = tmm.Geometry(); A = tmm.air(22)
    fr = np.arange(a.fmin, a.fmax, 1.0)
    alts = [x for x in g.doc.get("alternate_fingerings", []) if x.get("register") == 3]
    if a.notes:
        alts = [x for x in alts if x["note"] in a.notes.split(",")]
    for alt in alts:
        tr = alt.get("tract", {})
        Zb = tmm.input_impedance(g, fr, g.hole_openness(alt["keys"]), A, include_reed=False)
        Zt = tract_tmm.tract_impedance(fr, tx=tr.get("tongue_x", 0.0), ty=tr.get("tongue_y", 1.0),
                                       jaw=tr.get("jaw_open", 0.15), a_glottis=0.05e-4 + 0.05 * 1.95e-4)
        Yr = reed_Y(fr, reed, A["rho"], A["c"])
        ft = alt["f_target"]
        pb = [(f, z) for f, z in tmm.find_peaks(fr, Zb) if z > 2e6]
        pt = [(f, z) for f, z in tmm.find_peaks(fr, Zt) if z > 2e6]
        print(f"{alt['note']} target {ft:.0f} Hz  keys {','.join(alt['keys'])}  tract {tr}")
        print("   bore peaks : " + " ".join(f"{f:.0f}/{z/1e6:.1f}" for f, z in pb))
        print("   tract peaks: " + " ".join(f"{f:.0f}/{z/1e6:.1f}" for f, z in pt))
        print("   regimes bore+reed      : " + " ".join(f"{f:.0f}/{z/1e6:.0f}" for f, z in regimes(fr, 1 / (1 / Zb + Yr))))
        print("   regimes bore+tract+reed: " + " ".join(f"{f:.0f}/{z/1e6:.0f}" for f, z in regimes(fr, 1 / (1 / (Zb + Zt) + Yr))))


if __name__ == "__main__":
    main()
