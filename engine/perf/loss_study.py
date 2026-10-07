#!/usr/bin/env python3
"""Loss-model trade-off study: engine reed-end input impedance (rigid reed) for every
fingering under several cheaper loss formulations, compared with the current engine
and with tools/tmm.py.

    tools/.venv/bin/python engine/perf/loss_study.py [--os 4]

For each variant: kernel cost (ns/node-step on the C#5 bore), and over all 33 fingerings
the worst |Δ| vs the current engine of the first four impedance peaks (80 Hz–2.5 kHz):
frequency (cents) and magnitude (dB); plus the mean |cents| of the playing peak vs TMM.
Adoption rule: every peak within ±1 cent and ±0.3 dB of the current engine (or closer to TMM).
"""
import argparse, json, math, os, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import tmm  # noqa: E402

EX = os.path.join(ROOT, "engine", "target", "release", "examples", "loss_study")
SECS = 1.0


def run(variant_args, out, os_):
    r = subprocess.run([EX, "bore", out, "--os", str(os_), "--seconds", str(SECS)] + variant_args,
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()


def peaks_from_ir(ir, fs, fmin=80.0, fmax=2500.0, npk=4):
    nfft = 1 << 22
    Z = np.fft.rfft(ir, nfft) / fs
    f = np.fft.rfftfreq(nfft, 1 / fs)
    sel = (f > fmin) & (f < fmax)
    m = np.log(np.abs(Z[sel]) + 1e-30)
    ff = f[sel]
    df = ff[1] - ff[0]
    out = []
    for i in range(1, len(m) - 1):
        if m[i] > m[i - 1] and m[i] >= m[i + 1]:
            y0, y1, y2 = m[i - 1], m[i], m[i + 1]
            den = y0 - 2 * y1 + y2
            d = 0.5 * (y0 - y2) / den if den else 0.0
            peak = y1 - 0.25 * (y0 - y2) * d
            out.append((ff[i] + d * df, 20 * peak / math.log(10)))
    # keep resonances: drop tiny ripples (< 3 dB prominence over neighbours' minima)
    strong = [p for p in out if p[1] > max(q[1] for q in out) - 30]
    return strong[:npk]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--os", type=int, default=4)
    args = ap.parse_args()
    subprocess.run(["cargo", "build", "--release", "-q", "--example", "loss_study"], cwd=os.path.join(ROOT, "engine"), check=True)
    g = tmm.Geometry(tmm.DEFAULT_JSON)
    fings = g.doc["fingerings"]
    A = tmm.air(22.0)
    tmm_f = [tmm.predict(g, f["keys"], f["f_target"], A)["f"] for f in fings]
    two = "32.931228,190.186543,0:634.58627,20898.948616,1"   # 2 sections fitted to the 3-section response, 120 Hz–2.5 kHz
    two_sqrt = "32.2951,263.472348,0:487.092504,32419.645312,1"  # 2 sections fitted to √s, 80 Hz–5 kHz
    variants = [
        ("current (3 poles, thermal r<12 mm)", []),
        ("2 poles (fit to 3-pole response)", ["--poles", two]),
        ("2 poles (fit to sqrt(s))", ["--poles", two_sqrt]),
        ("thermal region r<10 mm", ["--thermal-r", "0.010"]),
        ("thermal region r<8 mm", ["--thermal-r", "0.008"]),
        ("thermal region r<6 mm", ["--thermal-r", "0.006"]),
        ("no explicit thermal (all lumped)", ["--thermal-r", "0.0"]),
    ]
    fs = 48000.0 * args.os
    n = int(SECS * fs)
    res = []
    for name, va in variants:
        tmp = f"/tmp/loss_study_{len(res)}.bin"
        info = run(va, tmp, args.os)
        irs = np.fromfile(tmp, dtype="<f4").astype(float).reshape(len(fings), n)
        pk = [peaks_from_ir(irs[i], fs) for i in range(len(fings))]
        res.append((name, info, pk))
    base = res[0][2]
    print(f"os={args.os}; peaks 80 Hz–2.5 kHz (first 4 per fingering, all {len(fings)} fingerings)")
    print(f"{'variant':<38} {'kernel ns/node-step':>19} {'thermal nodes':>13} {'max|Δf| ¢':>10} {'max|ΔZ| dB':>11} {'play-peak vs TMM mean|¢|':>24}  verdict")
    for name, info, pk in res:
        dc, dz = 0.0, 0.0
        for a, b in zip(pk, base):
            for (fa, za) in a:
                fb, zb = min(b, key=lambda q: abs(math.log(q[0] / fa)))
                if abs(1200 * math.log2(fa / fb)) < 100:
                    dc = max(dc, abs(1200 * math.log2(fa / fb)))
                    dz = max(dz, abs(za - zb))
        tm = []
        for i, f in enumerate(fings):
            fp, _ = min(pk[i], key=lambda q: abs(math.log(q[0] / f["f_target"]))) if pk[i] else (float("nan"), 0)
            tm.append(abs(1200 * math.log2(fp / tmm_f[i])))
        kern = info.split("kernel=")[1].split()[0]
        thn = info.split("thermal_nodes=")[1].split()[0]
        ok = dc <= 1.0 and dz <= 0.3
        print(f"{name:<38} {kern:>19} {thn:>13} {dc:10.2f} {dz:11.2f} {np.mean(tm):24.2f}  {'OK' if ok else 'reject'}")


if __name__ == "__main__":
    main()
