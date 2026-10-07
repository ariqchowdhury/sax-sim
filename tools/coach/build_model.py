#!/usr/bin/env python3
"""
Assemble data/coach_model.json from the study outputs (tools/coach/out/*) and tools/coach/rules.json.

    python3 tools/coach/build_model.py

Schema: docs/COACHING.md §"coach_model.json schema".
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
import study as S
import fit as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = C.ROOT
OUTD = os.path.join(HERE, "out")


def survival(sens, rob):
    """Per raw feature: typical change for one control step (median over notes/controls of the largest
    |∂f/∂c|·step) vs RMS error under room/mic colouring. ratio > 1 → the feature 'survives'."""
    out = {}
    steps = {c[0]: c[5] for c in sens["controls"]}
    for i, n in enumerate(C.FEATURES):
        per_note = []
        for lbl in sens["base_raw"]:
            per_note.append(max(abs(sens["J_raw"][k][lbl][i]) * steps[k] for k in steps))
        typ = float(np.median(per_note))
        err = rob["raw_rms"].get(n, 0.0)
        out[n] = dict(signal_per_step=round(typ, 3), colour_rms=round(err, 3), ratio=round(typ / err, 2) if err > 1e-9 else None)
    return out


def robust_survival(sens, rob):
    steps = {c[0]: c[5] for c in sens["controls"]}
    sig = dict(zip(rob["names"], np.maximum(np.array(rob["rms"]), S.floor_for(rob["names"]))))
    out = {}
    for i, n in enumerate(sens["robust_names"]):
        typ = max(abs(sens["J_robust"][k][i]) * steps[k] for k in steps)
        out[n] = dict(signal_per_step=round(float(typ), 3), sigma=round(float(sig.get(n, 1.0)), 3),
                      ratio=round(float(typ / sig.get(n, 1.0)), 2))
    return out


PITCH_TYPES = ("cents", "pitch_std", "regime")


def annotate_rules_room(rules, sens, rob):
    """For control rules: share of the rule's evidence (Fisher information along its signature) carried by
    pitch features; ≥ 0.6 → usable in any room, else needs a dry or moderately reverberant recording."""
    names = sens["robust_names"]
    sig = dict(zip(rob["names"], np.maximum(np.array(rob["rms"]), S.floor_for(rob["names"]))))
    W = np.array([1 / sig.get(n, 3.0) for n in names])
    steps = {c[0]: c[5] for c in sens["controls"]}
    for r in rules:
        if r["kind"] != "control" or not r["signature"]:
            continue
        v = np.zeros(len(names))
        for k, w in r["signature"].items():
            v += w * np.array(sens["J_robust"][k]) * steps[k]
        v = (v * W) ** 2
        pitch = sum(v[i] for i, n in enumerate(names) if n.split("@")[0] in PITCH_TYPES or n.startswith("cents"))
        share = float(pitch / max(v.sum(), 1e-12))
        r["pitch_evidence_share"] = round(share, 2)
        r["room"] = "any" if share >= 0.6 else "dry_or_some"
        top = np.argsort(v)[::-1][:5]
        r["evidence_features"] = [names[i] for i in top]


def weights_by_room(rob):
    names = rob["names"]
    fl = S.floor_for(names)
    out = {}
    for room, rms in rob.get("rms_by_room", {}).items():
        sg = np.maximum(np.array(rms), fl)
        w = 1 / sg
        if room == "too_reverberant":
            w = np.array([wi if n.split("@")[0] in PITCH_TYPES else 0.0 for wi, n in zip(w, names)])
        out[room] = [round(float(x), 5) for x in w]
    sg = np.maximum(np.array(rob["rms"]), fl)
    out["uncertain"] = [round(float(1 / x), 5) for x in sg]
    return out


def load_templates(proto):
    f = os.path.join(OUTD, "templates.json" if proto == "v1" else f"templates_{proto}.json")
    if not os.path.exists(f):
        return None
    T = json.load(open(f))
    return dict(names=T["names"], default=[round(x, 4) for x in T["default"]],
                templates=[dict(id=t["id"], mag=t["mag"], robust=[round(x, 4) for x in t["robust"]]) for t in T["templates"]])


def nuisance_by_protocol():
    out = {}
    for proto in ("v1", "G4push"):
        T = load_templates(proto)
        if T:
            out[proto] = F.nuisance_sigma(T["names"])
    return out


def validation_summary(val):
    res = {}
    if val:
        res["fit_based"] = dict(n=val["n"], top1=val["top1"], top3=val["top3"], by_method=val.get("by_method"),
                                control_rmse_units=val["control_rmse_units"],
                                about="LM fit + projection ranking; synthetic players = 1 fault (1.5-3 steps) + ±0.4-step nuisance; v1 protocol")
    for proto, f in (("v1", "validation_fast.json"), ("G4push", "validation_fast_G4push.json")):
        pth = os.path.join(OUTD, f)
        if os.path.exists(pth):
            v = json.load(open(pth))
            res[f"template_{proto}"] = dict(n=v["n"], seed=v["seed"], **v["by_method"]["template"],
                                            about="independent players: fault 1.5-3 steps + 0-0.75 step of a second cause + nuisance; random room/mic/level")
    return res


def main():
    sens = json.load(open(os.path.join(OUTD, "v1", "sensitivity.json")))
    rob = json.load(open(os.path.join(OUTD, "D5pp_D5ff_G4push_C6ff", "robustness.json")))
    ident = {p: json.load(open(os.path.join(OUTD, p, "identifiability.json")))
             for p in ("v1", "G4push", "D5pp_D5ff_G4push_C6ff") if os.path.exists(os.path.join(OUTD, p, "identifiability.json"))}
    val = json.load(open(os.path.join(OUTD, "validation.json"))) if os.path.exists(os.path.join(OUTD, "validation.json")) else None
    rules = json.load(open(os.path.join(HERE, "rules.json")))
    annotate_rules_room(rules, sens, rob)
    names = rob["names"]
    sigma = np.maximum(np.array(rob["rms"]), S.floor_for(names))
    model = dict(
        version=1,
        generated_by="tools/coach/build_model.py (study: tools/coach/study.py, fit: tools/coach/fit.py)",
        feature_names=C.FEATURES,
        test_set=[dict(label=t[0], written=t[1], dynamic=t[2], register_group=t[3]) for t in C.TEST_SET],
        protocol_extensions=[dict(label="G4push", written="G4", dynamic=0.5, register_group="low",
                                  instruction="Push the mouthpiece 5 mm further onto the cork, play G4 mf, then put it back.",
                                  control_offsets={"mouthpiece_insertion": 5.0}, recommended=True),
                             dict(label="D5pp", written="D5", dynamic=0.15, register_group="mid", recommended=False),
                             dict(label="D5ff", written="D5", dynamic=0.9, register_group="mid", recommended=False),
                             dict(label="C6ff", written="C6", dynamic=0.9, register_group="mid", recommended=False)],
        controls=[dict(key=c[0], param=c[1], min=c[2], max=c[3], default=c[4], step=c[5], scope=c[6]) for c in C.control_list()],
        fit_controls=F.FIT_CONTROLS,
        sim_settings=dict(player_assist=0.5, oversample=2, seconds=2.0, tongue_release=0.05, seed=1,
                          dynamic_by_label={t[0]: t[2] for t in C.TEST_SET}),
        sensitivity=dict(about="d feature / d control (per control unit) at the default player, per test note; raw v1 features",
                         base_raw=sens["base_raw"], J_raw=sens["J_raw"],
                         robust_names=sens["robust_names"], J_robust=sens["J_robust"]),
        robust_transform=dict(
            about="See docs/COACHING.md 'Robust transform v1'. Implemented in tools/coach/common.py robust_vector().",
            features=names,
            definitions={
                "cents@L": "cents of note L (absolute, vs target × regime)",
                "regime@L": "regime of note L",
                "X_rel@L": "feature X of mf note L minus the mean of X over all mf notes (X = H2..H6, tilt, odd_even, edge, hnr): removes the recording's EQ/room colouring",
                "pitch_std@L": "pitch_std of mf note L", "scoop@L": "scoop of mf note L (low weight)",
                "X_mean": "mean over mf notes of X (tilt, odd_even, edge, hnr, centroid_rel) — absolute, colour-sensitive (low weight)",
                "X_ff-pp@G4 / X_mf-pp@G4": "dynamic deltas on G4 (level, centroid_rel, tilt, H2..H4, edge)",
                "X_ff-pp@D5, X_ff-mf@C6": "optional protocol extensions",
                "cents_push-ref@G4": "cents(G4 with mouthpiece +5 mm) − cents(G4) (protocol extension G4push)",
            }),
        weights=dict(names=names, sigma=[round(float(s), 4) for s in sigma], weight=[round(float(1 / s), 5) for s in sigma],
                     by_room=weights_by_room(rob),
                     room_verdict_map={"dry": "dry", "some": "some", "too-reverberant": "too_reverberant", "uncertain": "uncertain"},
                     room_notes={"too_reverberant": "The recording is too reverberant for tone-colour analysis: only pitch-based "
                                 "advice (tuning, stability, register) is given. Record closer to the bell or in a drier room.",
                                 "some": "Some room sound detected: harmonic-shape evidence is down-weighted.",
                                 "uncertain": "Room could not be estimated; using average robustness weights."},
                     about="w_i = 1/σ_i, σ_i = RMS error of the robust feature under 32 room×mic×level colourings (floored); "
                           "by_room: σ per room class of the blind room estimate (dry RT60 ≤ 0.25 s, some ≤ 0.7 s, too_reverberant: "
                           "non-pitch features weight 0)"),
        objective=dict(definition="r = W·(robust(sim(u)) − robust(rec)) ⊕ λ·u, u = (control − default)/step over fit_controls",
                       lambda_prior=F.LAMBDA),
        feature_survival=survival(sens, rob),
        robust_feature_survival=robust_survival(sens, rob),
        identifiability={k: dict(posterior_sd_steps=v["posterior_sd_steps"], confounds=v["confounds"]) for k, v in ident.items()},
        rules=rules,
        cause_ranking=dict(
            method="template",
            about="PRIMARY (no fit needed): for each control rule, χ² improvement over the default player of the best "
                  "magnitude template: score_r = χ²(y, default) − min_m χ²(y, T_r,m), χ² = Σ ((y_i − t_i)/σ_eff,i)², "
                  "σ_eff² = σ_room² + σ_nuisance². SECONDARY (after a fit): projection of the fitted control change "
                  "u/max(sd,0.3) on the rule signature. Observation rules fire from rule.trigger.",
            templates={k: load_templates(k) for k in ("v1", "G4push")},
            sigma_nuisance={k: [round(float(x), 4) for x in v] for k, v in nuisance_by_protocol().items()}),
        validation=validation_summary(val),
    )
    path = os.path.join(ROOT, "data", "coach_model.json")
    json.dump(model, open(path, "w"), indent=1)
    print("wrote", path, f"({os.path.getsize(path)/1024:.0f} kB)")
    rs = model["robust_feature_survival"]
    by_type = {}
    for n, v in rs.items():
        t = n.split("@")[0]
        by_type.setdefault(t, []).append(v["ratio"])
    print("robust features: median signal/sigma per type:")
    for t, r in sorted(by_type.items(), key=lambda kv: -np.median(kv[1])):
        print(f"  {t:22s} {np.median(r):6.2f}  (n={len(r)})")
    for n, v in model["feature_survival"].items():
        print(f"  {n:13s} signal/step {v['signal_per_step']:8.2f}  colour rms {v['colour_rms']:8.2f}  ratio {v['ratio']}")


if __name__ == "__main__":
    main()
