#!/usr/bin/env python3
"""
Reference fitter + cause ranking + synthetic validation for the coaching mode (COACHING.md §Diagnosis).

    SAX_RENDER=... python3 tools/coach/fit.py validate [--n 40] [--seed 1]
    SAX_RENDER=... python3 tools/coach/fit.py fit rec.wav            # (auto-segmented protocol recording)

Objective (identical definition for the web fitter, see COACHING.md "Objective v1"):
    r = W · (robust(sim(u)) − robust(rec))   ⊕   λ · u
  robust() = common.robust_vector (relative/robust transform), W_i = 1/σ_i with σ_i the feature's RMS
  error under room/mic colouration (floored), u = (control − default)/step (the FIT_CONTROLS subset),
  λ = 0.5 (one control step ≈ 2σ of prior). Minimised with Levenberg–Marquardt, forward-difference
  Jacobian refreshed every iteration.
"""
import os, sys, json, math, argparse, random
from concurrent.futures import ThreadPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
import study as S

HERE = os.path.dirname(os.path.abspath(__file__))
POOL = ThreadPoolExecutor(max_workers=os.cpu_count() or 8)
LAMBDA = 0.5

# minimal identifiable set (identifiability study): tract per register is NOT identifiable from the
# protocol (posterior sd ≥ 0.9 steps) and stays at its default; one shared low-register jaw is kept.
FIT_CONTROLS = ["lip_force", "lip_position", "lip_damping", "mouthpiece_insertion", "baffle_height",
                "chamber_size", "tip_opening", "reed_strength", "lung_pressure", "jaw_open@low"]
CTRL = {c[0]: c for c in C.control_list()}


def sigma_vector(names):
    R = json.load(open(os.path.join(HERE, "out", "D5pp_D5ff_G4push_C6ff", "robustness.json")))
    rms = dict(zip(R["names"], R["rms"]))
    return np.maximum(np.array([rms.get(n, 3.0) for n in names]), S.floor_for(names))


def controls_from_u(u, base=None):
    c = dict(base or C.default_controls())
    for k, ui in zip(FIT_CONTROLS, u):
        _, _, lo, hi, d, step, _ = CTRL[k]
        c[k] = float(np.clip(d + ui * step, lo, hi))
    return c


def sim_robust_many(ctrls):
    """Robust vectors for several control sets; all (control set, note) renders in one flat batch."""
    labels = [t[0] for t in C.TEST_SET]
    jobs = [(i, l) for i in range(len(ctrls)) for l in labels]
    res = list(POOL.map(lambda j: (j, C.render_features(ctrls[j[0]], j[1], keep_audio=False)[1]), jobs))
    per = [dict() for _ in ctrls]
    for (i, l), v in res:
        per[i][l] = v
    return [C.robust_vector(p) for p in per]


def sim_robust(ctrl):
    return sim_robust_many([ctrl])[0]


def fit(y_names, y, iters=6, verbose=False):
    W = 1.0 / sigma_vector(y_names)
    n = len(FIT_CONTROLS)
    u = np.zeros(n)
    lam = 1.0
    def resid_from(names, f, u):
        assert names == y_names
        return np.concatenate([W * (f - y), LAMBDA * u])
    def resid(u):
        names, f = sim_robust(controls_from_u(u))
        return resid_from(names, f, u)
    r = resid(u)
    cost = r @ r
    for it in range(iters):
        # forward-difference Jacobian (parallel over controls)
        h = 0.5
        us = [u + h * np.eye(n)[j] for j in range(n)]
        sims = sim_robust_many([controls_from_u(x) for x in us])
        J = np.array([(resid_from(nm, f, x) - r) / h for (nm, f), x in zip(sims, us)]).T
        while True:
            A = J.T @ J + lam * np.diag(np.diag(J.T @ J) + 1e-6)
            du = -np.linalg.solve(A, J.T @ r)
            du = np.clip(du, -3, 3)
            r2 = resid(u + du)
            c2 = r2 @ r2
            if c2 < cost:
                u, r, cost = u + du, r2, c2
                lam = max(lam / 3, 1e-3)
                break
            lam *= 4
            if lam > 1e4:
                break
        if verbose:
            print(f"  iter {it}: cost {cost:.1f}")
        if lam > 1e4 or np.max(np.abs(du)) < 0.05:
            break
    # posterior sd from the last Jacobian
    cov = np.linalg.inv(J.T @ J + 1e-6 * np.eye(n))
    return u, np.sqrt(np.diag(cov)), cost


# ------------------------------------------------------------------ causes
def load_rules():
    return json.load(open(os.path.join(HERE, "rules.json")))


def rank_causes(u, sd, rules):
    """Score each rule by the projection of the fitted control change (in posterior-sd units) on the
    rule's control signature; returns [(score, rule id)] sorted."""
    z = u / np.maximum(sd, 0.3)
    out = []
    for r in rules:
        sig = np.array([r["signature"].get(k, 0.0) for k in FIT_CONTROLS])
        if not sig.any():
            continue
        s = float(z @ sig / np.linalg.norm(sig))
        out.append((s, r["id"]))
    out.sort(reverse=True)
    return out


def rank_causes_linear(names, y, rules, base=None):
    """Evidence ranking straight from the sensitivity table (no fit): for each rule with control
    signature s, the best magnitude a ≥ 0 along J·s explains the observed robust deviation
    y − robust(default); score = residual reduction in σ units (χ² drop). Fast and independent of the
    fitter's local minima; combined with the fit-based score in rank_causes_combined()."""
    sens = json.load(open(os.path.join(HERE, "out", "v1", "sensitivity.json")))
    rn = sens["robust_names"]
    idx = [rn.index(n) for n in names if n in rn]
    keep = [i for i, n in enumerate(names) if n in rn]
    W = 1.0 / sigma_vector([names[i] for i in keep])
    d = (y[keep] - np.array(sens["base_robust"])[idx]) * W
    steps = {c[0]: c[5] for c in sens["controls"]}
    out = []
    for r in rules:
        sg = r["signature"]
        if not sg:
            continue
        v = np.zeros(len(idx))
        for k, w in sg.items():
            v += w * np.array(sens["J_robust"][k])[idx] * steps[k]
        v *= W
        vv = v @ v
        if vv <= 0:
            continue
        a = max(0.0, (d @ v) / vv)
        out.append((float(a * a * vv), r["id"]))
    out.sort(reverse=True)
    return out


def rank_causes_combined(u, sd, names, y, rules):
    a = dict((k, s) for s, k in rank_causes(u, sd, rules))
    b = dict((k, s) for s, k in rank_causes_linear(names, y, rules))
    # normalise each score to [0, 1] by its max, then average
    ma = max([v for v in a.values()] + [1e-9]); mb = max([v for v in b.values()] + [1e-9])
    keys = set(a) | set(b)
    comb = [(0.5 * max(a.get(k, 0), 0) / ma + 0.5 * b.get(k, 0) / mb, k) for k in keys]
    comb.sort(reverse=True)
    return comb


# ------------------------------------------------------------------ validation
def synthetic_player(rule, rng):
    """Hidden controls: the rule's fault (magnitude 1.5-3 control steps along its signature) plus
    small nuisance variation (±0.4 step) on the other fitted controls; the per-register tract varies
    freely (±1 step) because a real player's voicing is unknown."""
    base = C.default_controls()
    sig = rule["signature"]
    mag = rng.uniform(1.5, 3.0)
    norm = math.sqrt(sum(v * v for v in sig.values()))
    for k, (_, _, lo, hi, d, step, _) in CTRL.items():
        if k in sig:
            base[k] = float(np.clip(d + mag * sig[k] / norm * step * math.sqrt(len(sig)), lo, hi))
        elif k in FIT_CONTROLS:
            base[k] = float(np.clip(d + rng.uniform(-0.4, 0.4) * step, lo, hi))
        elif k.startswith(("tongue", "jaw")):
            base[k] = float(np.clip(d + rng.uniform(-1, 1) * step, lo, hi))
    return base


def record(ctrl, rng):
    rt = rng.choice([0.2, 0.35, 0.6, 1.0]); mic = rng.choice(C.MICS); seed = rng.randint(1, 999)
    gain = rng.uniform(-18, 0)
    labels = [t[0] for t in C.TEST_SET]
    def one(l):
        written = next(t for t in C.TEST_SET if t[0] == l)[1]
        x, _ = C.render_features(ctrl, l)
        return l, C.features(C.colour(x, rt, mic, seed, gain), C.FS, C.written_to_hz(written))
    feats = dict(map(one, labels))
    return C.robust_vector(feats), (rt, mic)


def validate(n, seed):
    rng = random.Random(seed)
    rules = [r for r in load_rules() if r.get("validate", True) and r["kind"] == "control"]
    rows = []
    errs = {k: [] for k in FIT_CONTROLS}
    tally = {m: [0, 0] for m in ("fit", "linear", "combined")}
    for i in range(n):
        rule = rules[i % len(rules)]
        hidden = synthetic_player(rule, rng)
        (names, y), (rt, mic) = record(hidden, rng)
        u, sd, cost = fit(names, y)
        fitted = controls_from_u(u)
        for k in FIT_CONTROLS:
            errs[k].append((fitted[k] - hidden[k]) / CTRL[k][5])
        rl = load_rules()
        rk = {"fit": [r for _, r in rank_causes(u, sd, rl)], "linear": [r for _, r in rank_causes_linear(names, y, rl)],
              "combined": [r for _, r in rank_causes_combined(u, sd, names, y, rl)]}
        for m, ids in rk.items():
            tally[m][0] += ids[:1] == [rule["id"]]; tally[m][1] += rule["id"] in ids[:3]
        ids = rk["combined"]
        rows.append(dict(true=rule["id"], top3={m: v[:3] for m, v in rk.items()}, room=rt, mic=mic, cost=round(cost, 1),
                         y=y.tolist(), names=names, hidden=hidden, fitted=fitted))
        print(f"{i:3d} true {rule['id']:26s} comb {ids[:3]}  {'OK' if rule['id'] in ids[:3] else '--'}  "
              f"fit {'ok' if rule['id'] in rk['fit'][:3] else '--'} lin {'ok' if rule['id'] in rk['linear'][:3] else '--'}  ({rt}s, {mic})", flush=True)
    top1, top3 = tally["combined"]
    rep = dict(n=n, top1=top1 / n, top3=top3 / n, by_method={m: dict(top1=v[0] / n, top3=v[1] / n) for m, v in tally.items()},
               control_rmse_steps={k: float(np.sqrt(np.mean(np.square(v)))) for k, v in errs.items()},
               control_rmse_units={k: float(np.sqrt(np.mean(np.square(v))) * CTRL[k][5]) for k, v in errs.items()},
               rows=rows)
    json.dump(rep, open(os.path.join(HERE, "out", "validation.json"), "w"), indent=1)
    for m, v in tally.items():
        print(f"{m:9s} top-1 {v[0]}/{n} = {v[0]/n:.0%}, top-3 {v[1]}/{n} = {v[1]/n:.0%}")
    print("recovery RMSE (control units):", {k: round(v, 3) for k, v in rep["control_rmse_units"].items()})
    return rep


# ------------------------------------------------------------------ template ranking
TEMPLATE_MAGS = (1.0, 1.75, 2.5, 3.25)


def rule_controls(rule, mag):
    """Controls of a player with only this cause, `mag` control steps along its signature."""
    c = C.default_controls()
    sig = rule["signature"]
    norm = math.sqrt(sum(v * v for v in sig.values()))
    for k, w in sig.items():
        _, _, lo, hi, d, step, _ = CTRL[k]
        c[k] = float(np.clip(d + mag * w / norm * step * math.sqrt(len(sig)), lo, hi))
    return c


TEMPLATES = os.path.join(HERE, "out", "templates" + ("_" + os.environ["COACH_EXTRA"].replace(",", "_") if os.environ.get("COACH_EXTRA") else "") + ".json")


def build_templates(path=TEMPLATES):
    rules = [r for r in load_rules() if r["kind"] == "control" and r["signature"]]
    sets = [(r["id"], m, rule_controls(r, m)) for r in rules for m in TEMPLATE_MAGS]
    sims = sim_robust_many([c for _, _, c in sets] + [C.default_controls()])
    names = sims[0][0]
    out = dict(names=names, default=sims[-1][1].tolist(),
               templates=[dict(id=i, mag=m, robust=s[1].tolist()) for (i, m, _), s in zip(sets, sims[:-1])])
    json.dump(out, open(path, "w"))
    return out


def nuisance_sigma(names, amp=0.4):
    """Feature spread caused by the unknown 'other' controls (±amp steps on the fit controls, ±1 step tract)."""
    sens = json.load(open(os.path.join(HERE, "out", "v1", "sensitivity.json")))
    rn = sens["robust_names"]; steps = {c[0]: c[5] for c in sens["controls"]}
    var = np.zeros(len(rn))
    for k in steps:
        a = 1.0 if k.startswith(("tongue", "jaw")) and k not in FIT_CONTROLS else amp
        var += (np.array(sens["J_robust"][k]) * steps[k] * a) ** 2 / 3.0
    d = dict(zip(rn, np.sqrt(var)))
    return np.array([d.get(n, 0.0) for n in names])


def rank_causes_template(names, y, templates=None, room="uncertain"):
    T = templates or json.load(open(TEMPLATES))
    idx = [T["names"].index(n) for n in names if n in T["names"]]
    keep = [i for i, n in enumerate(names) if n in T["names"]]
    nm = [names[i] for i in keep]
    sg = np.sqrt(sigma_vector(nm) ** 2 + nuisance_sigma(nm) ** 2)
    yy = y[keep]
    d0 = float(np.sum(((yy - np.array(T["default"])[idx]) / sg) ** 2))
    best = {}
    for t in T["templates"]:
        chi = float(np.sum(((yy - np.array(t["robust"])[idx]) / sg) ** 2))
        if t["id"] not in best or chi < best[t["id"]]:
            best[t["id"]] = chi
    # score = χ² improvement over "no fault"
    out = sorted(((d0 - v, k) for k, v in best.items()), reverse=True)
    return out


def validate_fast(n, seed, nuisance=0.4, mix=0.25):
    """Independent validation of the (fit-free) template and linear rankings: fresh synthetic players
    (different seed), fault magnitude 1.5-3 steps, nuisance ±`nuisance` steps on all fit controls,
    plus a random `mix` fraction of a second cause (realistic players rarely have a single fault)."""
    rng = random.Random(seed)
    rules = [r for r in load_rules() if r.get("validate", True) and r["kind"] == "control"]
    allc = [r for r in load_rules() if r["kind"] == "control" and r["signature"]]
    T = json.load(open(TEMPLATES))
    tally = {"template": [0, 0], "linear": [0, 0]}
    rows = []
    for i in range(n):
        rule = rules[i % len(rules)]
        hidden = synthetic_player(rule, rng)
        other = rng.choice([r for r in allc if r["id"] != rule["id"]])
        oc = rule_controls(other, rng.uniform(0, 3.0) * mix)
        for k in other["signature"]:
            hidden[k] += oc[k] - C.default_controls()[k]
        for k in FIT_CONTROLS:
            _, _, lo, hi, d, step, _ = CTRL[k]
            hidden[k] = float(np.clip(hidden[k] + rng.uniform(-nuisance, nuisance) * step * 0.5, lo, hi))
        (names, y), (rt, mic) = record(hidden, rng)
        rk = {"template": [k for _, k in rank_causes_template(names, y, T)],
              "linear": [k for _, k in rank_causes_linear(names, y, load_rules())]}
        for m, ids in rk.items():
            tally[m][0] += ids[:1] == [rule["id"]]; tally[m][1] += rule["id"] in ids[:3]
        rows.append(dict(true=rule["id"], top3=rk["template"][:3], room=rt, mic=mic))
        print(f"{i:3d} true {rule['id']:26s} tmpl {rk['template'][:3]} {'OK' if rule['id'] in rk['template'][:3] else '--'}  ({rt}s, {mic})", flush=True)
    rep = dict(n=n, seed=seed, by_method={m: dict(top1=v[0] / n, top3=v[1] / n) for m, v in tally.items()}, rows=rows)
    json.dump(rep, open(TEMPLATES.replace("templates", "validation_fast"), "w"), indent=1)
    for m, v in tally.items():
        print(f"{m:9s} top-1 {v[0]}/{n} = {v[0]/n:.0%}, top-3 {v[1]}/{n} = {v[1]/n:.0%}")
    return rep


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["validate", "validate_fast", "templates", "fit"])
    ap.add_argument("wav", nargs="?")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    if a.mode == "validate":
        validate(a.n, a.seed)
    elif a.mode == "validate_fast":
        validate_fast(a.n, a.seed)
    elif a.mode == "templates":
        build_templates()
