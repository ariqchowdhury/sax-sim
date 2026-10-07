#!/usr/bin/env python3
"""
M9 coaching study: sensitivity, room/mic robustness, identifiability.

    SAX_RENDER=... python3 tools/coach/study.py sensitivity   # -> tools/coach/out/sensitivity.json
    SAX_RENDER=... python3 tools/coach/study.py robustness    # -> tools/coach/out/robustness.json
    python3 tools/coach/study.py identifiability              # uses the two files above
"""
import os, sys, json, math, itertools
from concurrent.futures import ThreadPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", os.environ.get("COACH_EXTRA", "").replace(",", "_") or "v1")
os.makedirs(OUT, exist_ok=True)
POOL = ThreadPoolExecutor(max_workers=os.cpu_count() or 8)


def all_features(ctrl, colourings=None):
    """dict label -> raw feature vector for the whole test set (optionally coloured)."""
    labels = [t[0] for t in C.TEST_SET]
    def one(lbl):
        written = next(t for t in C.TEST_SET if t[0] == lbl)[1]
        x, v = C.render_features(ctrl, lbl, keep_audio=colourings is not None)
        return lbl, x, written, v
    res = list(POOL.map(one, labels))
    if colourings is None:
        return {lbl: v for lbl, x, w, v in res}
    jobs = [(ci, lbl, x, w) for ci in range(len(colourings)) for lbl, x, w, v in res]
    def an(j):
        ci, lbl, x, w = j
        rt, mic, seed, gain = colourings[ci]
        return ci, lbl, C.features(C.colour(x, rt, mic, seed, gain), C.FS, C.written_to_hz(w))
    out = [dict() for _ in colourings]
    for ci, lbl, v in POOL.map(an, jobs):
        out[ci][lbl] = v
    # the uncoloured reference analysed with the same analyser path (level in dBFS)
    out.insert(0, {lbl: C.features(x, C.FS, C.written_to_hz(w)) for lbl, x, w, v in res})
    return out


def sensitivity():
    base = C.default_controls()
    ctrls = C.control_list()
    f0 = all_features(base)
    names, r0 = C.robust_vector(f0)
    J_raw, J_rob = {}, {}
    for key, param, lo, hi, d, step, scope in ctrls:
        up = dict(base); dn = dict(base)
        up[key] = min(hi, d + step); dn[key] = max(lo, d - step)
        fu, fd = all_features(up), all_features(dn)
        h = up[key] - dn[key]
        J_raw[key] = {lbl: ((fu[lbl] - fd[lbl]) / h).tolist() for lbl in fu}
        J_rob[key] = ((C.robust_vector(fu)[1] - C.robust_vector(fd)[1]) / h).tolist()
        print(f"{key:24s} done", flush=True)
    json.dump(dict(features=C.FEATURES, robust_names=names, base_raw={k: v.tolist() for k, v in f0.items()},
                   base_robust=r0.tolist(), controls=[c[:7] for c in ctrls], J_raw=J_raw, J_robust=J_rob),
              open(os.path.join(OUT, "sensitivity.json"), "w"))


def robustness():
    base = C.default_controls()
    cols = [(rt, mic, seed, g) for (_, rt) in C.ROOMS for mic in C.MICS for seed in (1, 2) for g in (0.0, -12.0)]
    allf = all_features(base, cols)
    clean, coloured = allf[0], allf[1:]
    names, r_clean = C.robust_vector(clean)
    R = np.array([C.robust_vector(f)[1] for f in coloured])
    raw = np.array([[f[l] for l in [t[0] for t in C.TEST_SET]] for f in coloured])   # (ncol, nnote, nfeat)
    raw_clean = np.array([clean[t[0]] for t in C.TEST_SET])
    # error statistics of each robust feature under colouration
    err = R - r_clean
    rob = dict(names=names, clean=r_clean.tolist(), bias=err.mean(0).tolist(), std=err.std(0).tolist(),
               rms=np.sqrt((err ** 2).mean(0)).tolist())
    # per room class (blind room estimate verdicts of analysis.rs): dry RT60 ≤ 0.25 s,
    # some 0.25-0.7 s, too reverberant > 0.7 s
    rts = np.array([c[0] for c in cols])
    classes = {"dry": rts <= 0.25, "some": (rts > 0.25) & (rts <= 0.7), "too_reverberant": rts > 0.7}
    rob["rms_by_room"] = {k: np.sqrt((err[m] ** 2).mean(0)).tolist() for k, m in classes.items()}
    # raw features: rms error per feature averaged over notes
    rerr = raw - raw_clean
    rob["raw_rms"] = {n: float(np.sqrt(np.mean(rerr[:, :, i] ** 2))) for i, n in enumerate(C.FEATURES)}
    rob["colourings"] = cols
    json.dump(rob, open(os.path.join(OUT, "robustness.json"), "w"))
    order = np.argsort(rob["rms"])
    print("raw feature rms error under colouring:", {k: round(v, 2) for k, v in rob["raw_rms"].items()})


def identifiability(verbose=True):
    S = json.load(open(os.path.join(OUT, "sensitivity.json")))
    rp = os.path.join(OUT, "robustness.json")
    if not os.path.exists(rp):
        rp = os.path.join(os.path.dirname(OUT), "D5pp_D5ff_G4push_C6ff", "robustness.json")
    R = json.load(open(rp))
    names = S["robust_names"]
    rms_by = dict(zip(R["names"], R["rms"]))
    R = dict(R, rms=[rms_by.get(n, 1.0) for n in names])
    keys = [c[0] for c in S["controls"]]
    steps = np.array([c[5] for c in S["controls"]])
    J = np.array([S["J_robust"][k] for k in keys]).T          # (nfeat, nctrl), per unit of control
    sigma = np.maximum(np.array(R["rms"]), floor_for(names))
    W = 1.0 / sigma
    Js = (J * steps[None, :]) * W[:, None]                     # per control step, in sigma units
    # prior: one control step = 1 sigma of prior (soft regularisation)
    F = Js.T @ Js
    post = np.linalg.inv(F + np.eye(len(keys)) * 0.25)
    sd = np.sqrt(np.diag(post))                                # in control steps
    corr = post / np.outer(sd, sd)
    info = {k: float(np.sqrt(F[i, i])) for i, k in enumerate(keys)}
    res = dict(keys=keys, posterior_sd_steps=dict(zip(keys, sd.tolist())), fisher_diag_sqrt=info, confounds=[])
    for i, j in itertools.combinations(range(len(keys)), 2):
        if abs(corr[i, j]) > 0.6:
            res["confounds"].append((keys[i], keys[j], float(corr[i, j])))
    res["confounds"].sort(key=lambda t: -abs(t[2]))
    if verbose:
        print("posterior sd (in control steps; < 1 = identifiable):")
        for k in sorted(keys, key=lambda k: res["posterior_sd_steps"][k]):
            print(f"  {k:24s} {res['posterior_sd_steps'][k]:.2f}   sqrt(Fisher) {info[k]:.1f}")
        print("confounds |corr| > 0.6:")
        for a, b, c in res["confounds"]:
            print(f"  {a} ~ {b}: {c:+.2f}")
    json.dump(res, open(os.path.join(OUT, "identifiability.json"), "w"), indent=1)
    return res


def floor_for(names):
    """Minimum noise floor per robust feature (measurement noise even without colouring)."""
    out = []
    for n in names:
        if n.startswith("cents"):
            out.append(2.0)
        elif n.startswith("regime"):
            out.append(0.1)
        elif n.startswith(("H", "tilt", "odd", "edge", "hnr", "level", "centroid")):
            out.append(1.0 if not n.startswith(("tilt", "centroid")) else 0.3)
        elif n.startswith("pitch_std"):
            out.append(1.0)
        elif n.startswith("scoop"):
            out.append(30.0)
        else:
            out.append(1.0)
    return np.array(out)


if __name__ == "__main__":
    {"sensitivity": sensitivity, "robustness": robustness, "identifiability": identifiability}[sys.argv[1]]()
