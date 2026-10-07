#!/usr/bin/env python3
"""Reference cases for web/src/coach/fit/rank.ts (template cause ranking), computed with the
physics lead's Python implementation (tools/coach/common.py robust_vector + tools/coach/fit.py
rank_causes_template) on synthetic raw feature vectors (linear model from the sensitivity table:
default player + a cause along its rule signature + nuisance + noise). Run from the repo root:
    tools/.venv/bin/python web/tests/fixtures/make_rank_cases.py
writes web/tests/fixtures/rank_cases.json."""
import json, os, random, sys
import numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(ROOT, "tools", "coach"))
import common as C  # noqa: E402
import fit as FT  # noqa: E402

M = json.load(open(os.path.join(ROOT, "data", "coach_model.json")))
S = M["sensitivity"]
steps = {c["key"]: c["step"] for c in M["controls"]}
rules = [r for r in M["rules"] if r["kind"] == "control" and r["signature"]]
rng = random.Random(7)
cases = []
for i in range(8):
    push = i % 2 == 1
    rule = rules[rng.randrange(len(rules))]
    mag = rng.uniform(1.5, 3.0)
    off = {k: rng.uniform(-0.4, 0.4) for k in M["fit_controls"]}   # nuisance (steps)
    for k, v in FT.rule_controls(rule, mag).items():
        d = next(c for c in M["controls"] if c["key"] == k)["default"]
        off[k] = off.get(k, 0.0) + (v - d) / steps[k]
    feats = {}
    labels = [t["label"] for t in M["test_set"]] + (["G4push"] if push else [])
    for lbl in labels:
        src = "G4" if lbl == "G4push" else lbl
        f = np.array(S["base_raw"][src], dtype=float)
        o = dict(off)
        if lbl == "G4push":
            o["mouthpiece_insertion"] = o.get("mouthpiece_insertion", 0.0) + 5.0 / steps["mouthpiece_insertion"]
        for k, u in o.items():
            if k in S["J_raw"]:
                f = f + np.array(S["J_raw"][k][src]) * u * steps[k]
        f = f + np.array([rng.gauss(0, 0.3) for _ in f])
        f[24], f[25] = S["base_raw"][src][24], S["base_raw"][src][25]   # regime, valid unchanged
        feats[lbl] = f
    # robust vector with the Python reference (protocol order incl. G4push when present)
    saved = list(C.TEST_SET)
    if push:
        C.TEST_SET.append(("G4push", "G4", 0.5, "low"))
    names, y = C.robust_vector(feats)
    C.TEST_SET[:] = saved
    T = M["cause_ranking"]["templates"]["G4push" if push else "v1"]
    T = dict(names=T["names"], default=T["default"], templates=T["templates"])
    ranked = FT.rank_causes_template(names, np.array(y), T)
    cases.append(dict(true=rule["id"], magnitude=mag, protocol="G4push" if push else "v1",
                      features={k: v.tolist() for k, v in feats.items()},
                      expected=[dict(id=k, score=s) for s, k in ranked]))
json.dump(dict(about=__doc__.splitlines()[0], cases=cases), open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "rank_cases.json"), "w"))
print("wrote", len(cases), "cases; true-in-top3:", sum(c["true"] in [e["id"] for e in c["expected"][:3]] for c in cases))
