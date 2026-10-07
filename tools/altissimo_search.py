#!/usr/bin/env python3
"""
Search key combinations (with the octave key) whose bore input impedance has a usable resonance
at an altissimo target and weak resonances below it -- i.e. fingerings on which a tuned vocal-tract
resonance (Chen, Smith & Wolfe 2008/2011) can select the altissimo regime.

    python3 tools/altissimo_search.py G6 A6 [--top 8]

Score = |Z| of the bore peak nearest the target (within +-60 cents) divided by the largest bore
peak below 0.85 x target. Real altissimo fingerings are cross/vented fingerings that do exactly this.
"""
import sys, os, itertools, math, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, tmm

KEYS = ["LH_front_F", "LH1", "BIS", "LH2", "LH3", "LH_palm_D", "LH_palm_Eb", "LH_palm_F", "RH_side_E",
        "RH_side_C", "RH_side_Bb", "RH_high_Fs", "RH1", "RH2", "RH3", "LH_Gs"]
NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]


def sounding_freq(note):
    m = 12 * (int(note[-1]) + 1) + NAMES.index(note[:-1]) - 9
    return 440 * 2 ** ((m - 69) / 12)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("notes", nargs="+")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--maxkeys", type=int, default=5)
    ap.add_argument("--tract", action="store_true", help="score |Z_bore + Z_tract| with a tract tuned near the target")
    a = ap.parse_args()
    g = tmm.Geometry(); A = tmm.air(22)
    for note in a.notes:
        ft = sounding_freq(note)
        fr = np.exp(np.linspace(np.log(150), np.log(ft * 1.1), 260))
        Zt = 0.0
        if a.tract:
            import tract_tmm
            best = None
            for tx in np.linspace(0.0, 0.4, 41):
                z = tract_tmm.tract_impedance(fr, tx=tx, ty=1.0, glottis_kw=None) if False else tract_tmm.tract_impedance(fr, tx=tx, ty=1.0, a_glottis=0.3e-4)
                pk = tmm.find_peaks(fr, z)
                if pk:
                    fpk = max(pk, key=lambda q: q[1])[0]
                    d = abs(1200 * math.log2(fpk / (ft * 1.02)))
                    if best is None or d < best[0]:
                        best = (d, tx, z)
            Zt = best[2]
            print(f"  tract tuned: tongue_x={best[1]:.2f}, tongue_y=1, glottis 0.3 cm^2")
        res = []
        seen = set()
        for n in range(0, a.maxkeys + 1):
            for combo in itertools.combinations(KEYS, n):
                keys = ["OCT"] + list(combo)
                op = g.hole_openness(keys)
                sig = tuple(round(v, 2) for v in op.values())
                if sig in seen:
                    continue
                seen.add(sig)
                Z = tmm.input_impedance(g, fr, op, A) + Zt
                pk = tmm.find_peaks(fr, Z)
                near = [p for p in pk if abs(1200 * math.log2(p[0] / ft)) < 60]
                if not near:
                    continue
                zt = max(near, key=lambda p: p[1])
                low = max([p[1] for p in pk if p[0] < 0.85 * ft], default=1e5)
                res.append((zt[1] / low, zt[0], zt[1], low, keys))
        res.sort(key=lambda r: -r[0])
        print(f"{note} (sounding {ft:.1f} Hz): best of {len(seen)} distinct pad configurations")
        for r in res[:a.top]:
            print(f"  score {r[0]:5.2f}  peak {r[1]:7.1f} Hz ({1200*math.log2(r[1]/ft):+4.0f} c) |Z| {r[2]/1e6:5.1f}  max low {r[3]/1e6:5.1f}  keys {','.join(r[4])}")


if __name__ == "__main__":
    main()
