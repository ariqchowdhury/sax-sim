#!/usr/bin/env python3
"""
Vocal-tract input impedance seen from the reed (mouth end) with the engine's area function
(engine/src/tract.rs tract_area) and the series combination Z_bore + Z_tract that drives the reed
(Chen, Smith & Wolfe 2008/2011; Scavone et al. 2008).

    python3 tools/tract_tmm.py --tongue-x 0.1 --tongue-y 0.97 [--jaw 0.3] [--wall 3] [--keys OCT,LH1,...]
"""
import sys, os, math, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, tmm

L = 0.17


def tract_area(x, tx, ty, tip, jaw):
    """Mirror of engine/src/tract.rs::tract_area (m^2). Keep in sync."""
    base = 1.8 if x < 0.020 else 3.5 if x < 0.075 else 2.8 if x < 0.095 else (3.0 + 2.5 * jaw) if x < 0.150 else (2.0 + 2.0 * jaw)
    xc = 0.065 + 0.075 * (1.0 - tx)
    g = math.exp(-(x - xc) ** 2 / (2 * 0.020 ** 2))
    a = max(base * (1 - 0.97 * ty * g), 0.10)
    gt = math.exp(-(x - 0.158) ** 2 / (2 * 0.006 ** 2))
    a = max(a * (1 - 0.9 * tip * gt), 0.15)
    return a * 1e-4


def tract_impedance(freqs, tx=0.5, ty=0.4, tip=0.3, jaw=0.3, wall=3.0, s_sub=2.5e-4, T=37.0, a_glottis=None, u_mean=2e-4):
    A = tmm.air(T)
    A = dict(A, c=353.0, rho=1.11)
    w = 2 * np.pi * np.asarray(freqs, float)
    Z = np.full(w.shape, A["rho"] * A["c"] / s_sub, complex)   # anechoic subglottal load
    if a_glottis:
        # glottal slit: inertance rho*l/A (l = 3 mm + end corrections ~ 2*0.8*sqrt(A/pi)),
        # linearised Bernoulli resistance rho*U/A^2 and Poiseuille slit resistance
        l = 0.003 + 1.6 * math.sqrt(a_glottis / math.pi)
        d = a_glottis / 0.018
        Z = Z + 1j * w * A["rho"] * l / a_glottis + A["rho"] * u_mean / a_glottis ** 2 + 12 * A["eta"] * 0.003 / (a_glottis * d * d)
    n = 34
    dx = L / n
    for i in range(n):
        x = (i + 0.5) * dx
        S = tract_area(x, tx, ty, tip, jaw)
        r = math.sqrt(S / math.pi)
        k, zeta = tmm.lossy(w, r, A)
        k0 = w / A["c"]
        k = k0 + (k - k0) * wall          # soft-wall losses as a multiple of the boundary-layer losses
        Zc = A["rho"] * A["c"] / S
        tn = np.tan(k * dx)
        Z = Zc * (Z + 1j * Zc * tn) / (Zc + 1j * Z * tn)
    return Z


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tongue-x", type=float, default=0.5)
    ap.add_argument("--tongue-y", type=float, default=0.4)
    ap.add_argument("--tip", type=float, default=0.3)
    ap.add_argument("--jaw", type=float, default=0.3)
    ap.add_argument("--wall", type=float, default=3.0)
    ap.add_argument("--keys")
    ap.add_argument("--glottis", type=float, help="glottal area (cm^2); default: open (anechoic trachea)")
    a = ap.parse_args()
    fr = np.arange(100, 2500, 2.0)
    Zt = tract_impedance(fr, a.tongue_x, a.tongue_y, a.tip, a.jaw, a.wall, a_glottis=a.glottis * 1e-4 if a.glottis else None)
    print("tract peaks:", " ".join(f"{f:.0f}Hz/{m/1e6:.1f}" for f, m in tmm.find_peaks(fr, Zt) if m > 2e6))
    if a.keys:
        g = tmm.Geometry()
        Zb = tmm.input_impedance(g, fr, g.hole_openness(a.keys.split(",")), tmm.air(22))
        print("bore peaks: ", " ".join(f"{f:.0f}Hz/{m/1e6:.1f}" for f, m in tmm.find_peaks(fr, Zb) if m > 3e6))
        print("bore+tract: ", " ".join(f"{f:.0f}Hz/{m/1e6:.1f}" for f, m in tmm.find_peaks(fr, Zb + Zt) if m > 3e6))


if __name__ == "__main__":
    main()
