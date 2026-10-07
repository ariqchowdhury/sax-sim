#!/usr/bin/env python3
"""
Auto-player voicing table (data/alto_sax.json "auto_player", schema in docs/PHYSICS.md §12).

    SAX_RENDER=... python3 tools/auto_player.py table      # base table at the reference setup -> tools/auto_player.json
    SAX_RENDER=... python3 tools/auto_player.py adapt      # setup sensitivities / validity -> tools/auto_player.json
    SAX_RENDER=... python3 tools/auto_player.py validate [--table-only]   # all fingerings x dynamics x setups
    python3 tools/build_geometry.py                        # writes auto_player into data/alto_sax.json

Everything is pure physics (player_assist = 0). For every fingering (33 standard + alternates +
altissimo) and dynamic (pp/mf/ff) a grid of player controls is played from rest; the chosen voicing
must sound in the intended register, be in tune (±10 ¢ reg 1, ±15 ¢ reg 2, ±25 ¢ altissimo), hit the
dynamic's level target (pp −20 dB, ff +6 dB re the note's mf), and stay valid under perturbations
(lung ±10 %, lip force ±0.15 N, tongue_x ±0.015) and when slurred into from the neighbouring note.
"""
import os, re, sys, json, math, argparse, itertools, subprocess
from concurrent.futures import ThreadPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_geometry as BG

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDER = os.environ.get("SAX_RENDER", os.path.join(ROOT, "engine", "target", "release", "render"))
GEOM = os.path.join(ROOT, "data", "alto_sax.json")
OUT = os.path.join(ROOT, "tools", "auto_player.json")
NOTES = None
REDO = []
POOL = ThreadPoolExecutor(max_workers=os.cpu_count() or 8)

CONTROLS = ["lip_force", "lip_position", "lip_damping", "tongue_x", "tongue_y", "tongue_tip", "tongue_length",
            "jaw_open", "glottis_open", "lung_pressure", "reed_damping"]
BASE = dict(lip_force=1.0, lip_position=12.0, lip_damping=0.4, tongue_x=0.5, tongue_y=0.4, tongue_tip=0.3,
            tongue_length=0.0, jaw_open=0.3, glottis_open=0.8, lung_pressure=3.5, reed_damping=0.3)
SETUP_REF = dict(tip_opening=1.9, facing_length=22.0, baffle_height=0.3, chamber_size=0.5, throat_diameter=11.0,
                 mouthpiece_insertion=10.0, reed_strength=2.5, reed_model=0.0, temperature=22.0)
DYN_DB = {"pp": -20.0, "mf": 0.0, "ff": 6.0}
TOL = {1: 10.0, 2: 15.0, 3: 25.0}


def entries(doc):
    out = []
    for f in doc["fingerings"]:
        out.append(dict(note=f["note"], register=f["register"], keys=f["keys"], f_target=f["f_target"], alt=None))
    for a in doc.get("alternate_fingerings", []):
        reg = a.get("register", 1)
        ft = a.get("f_target") or next(f["f_target"] for f in doc["fingerings"] if f["note"] == a["note"])
        out.append(dict(note=a["note"] + (" (" + a["name"] + ")" if reg != 3 else ""), register=reg, keys=a["keys"],
                        f_target=ft, alt=a if reg == 3 else None))
    return out


def group(e):
    if e["register"] == 3:
        return "altissimo"
    if e["register"] == 2 and e["f_target"] > 690:
        return "palm"
    return "mid" if e["register"] == 2 else "low"


def play(keys, ctrl, setup=None, switch_from=None, seconds=1.5, f_target=None):
    """Render from rest (or slurred from `switch_from` keys at 0.5 s); returns (in_register, cents, level dB)."""
    s = dict(SETUP_REF); s.update(setup or {})
    c = dict(ctrl)
    p = c.pop("lung_pressure")
    if switch_from is not None:
        cmd = [RENDER, "--keys", ",".join(switch_from), "--switch", "0.5:" + ",".join(keys)]
        seconds = seconds + 0.5
    else:
        cmd = [RENDER, "--keys", ",".join(keys)]
    cmd += ["--pressure", f"{p:.4f}", "--seconds", str(seconds), "--tongue-release", "0.05", "--geometry", GEOM,
            "--features", "--seed", "1", "--set", "player_assist=0"]
    for k, v in list(c.items()) + list(s.items()):
        cmd += ["--set", f"{k}={v}"]
    if switch_from is not None:
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tf:
            cmd = [x for x in cmd if x != "--features"] + ["--out", tf.name]
            subprocess.run(cmd, capture_output=True, text=True)
            out = subprocess.run([RENDER, "--analyze", tf.name, "--target", str(f_target)], capture_output=True, text=True).stdout
        try:
            notes = json.loads(out[out.index("{"):])["notes"]
            f = notes[-1]["features"]
            f0 = float(f["f0"]); ct = cents_vs(f0, f_target)
            return f["valid"] > 0.5 and abs(ct) < 100, ct, float(f["level"]), f0
        except Exception:
            return False, 9999.0, -120.0, 0.0
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        js = json.loads(out[out.index("{"):])
        f = js["features"]
        f0 = float(f["f0"]); ct = cents_vs(f0, f_target)
        return f["valid"] > 0.5 and abs(ct) < 100, ct, float(f["level"]), f0
    except Exception:
        return False, 9999.0, -120.0, 0.0


def cents_vs(f0, target):
    return 1200 * math.log2(f0 / target) if f0 > 0 else 9999.0


def grid_for(e, dyn):
    reg, g = e["register"], group(e)
    if e["alt"] is not None:
        v = dict(BASE); v.update(e["alt"].get("embouchure", {})); v.update(e["alt"].get("tract", {}))
        lf = v["lip_force"]
        if dyn == "mf":
            return [dict(v, lung_pressure=p, lip_force=lf + d) for p in (4.0, 4.5) for d in (-0.2, 0.0, 0.2)]
        if dyn == "pp":
            return [dict(v, lung_pressure=p, lip_force=lf + d) for p in (3.3, 3.6) for d in (0.0, 0.2, 0.4)]
        return [dict(v, lung_pressure=p, lip_force=lf + d) for p in (5.0, 5.5, 6.0) for d in (-0.2, 0.0)]
    if dyn == "mf":
        return [dict(BASE, lip_force=lf, lung_pressure=p) for lf in (0.6, 0.8, 1.0, 1.2, 1.4) for p in (3.0, 3.5, 4.0, 4.5)]
    if dyn == "pp":
        return [dict(BASE, lip_force=lf, lip_position=lp, lip_damping=ld, lung_pressure=p)
                for lf in (2.0, 2.5, 3.0) for lp in (14.0, 16.0, 18.0, 20.0) for ld in (0.6, 1.0)
                for p in (1.2, 1.4, 1.6, 1.8, 2.1, 2.4)]
    return [dict(BASE, lip_force=lf, lip_position=lp, lip_damping=0.15, jaw_open=0.5, lung_pressure=p)
            for lp in (8.0, 10.0, 12.0) for lf in (0.4, 0.6, 0.8, 1.0) for p in (6.0, 7.5, 9.0)]


def choose(e, dyn, L_mf=None, setup=None):
    """Grid search + lip-force pitch refinement + robustness check. Returns dict or None."""
    tol = TOL[e["register"]]
    cands = grid_for(e, dyn)
    res = list(POOL.map(lambda c: (c, play(e["keys"], c, setup, f_target=e["f_target"])), cands))
    def score(r):
        c, (ok, cents, lvl, f0) = r
        if not ok or abs(cents) > 150:
            return 1e9
        s = abs(cents) / tol
        if dyn != "mf" and L_mf is not None:
            s += abs(lvl - (L_mf + DYN_DB[dyn])) / 3.0
        if dyn == "mf":
            s += 0.2 * abs(c["lung_pressure"] - (4.5 if e["register"] == 3 else 3.5))
        return s
    res.sort(key=score)
    for c, (ok, cents, lvl, f0) in res[:8]:
        if score((c, (ok, cents, lvl, f0))) >= 1e9:
            break
        # pitch refinement with lip force (more lip -> sharper)
        best = (c, cents, lvl)
        for d in (-0.3, -0.15, 0.15, 0.3):
            c2 = dict(c, lip_force=float(np.clip(c["lip_force"] + d * (-np.sign(cents) or 1), 0.2, 3.0)))
            ok2, cents2, lvl2, _ = play(e["keys"], c2, setup, f_target=e["f_target"])
            if ok2 and abs(cents2) < abs(best[1]):
                best = (c2, cents2, lvl2)
        c, cents, lvl = best
        if abs(cents) > tol + 5:
            continue
        # robustness
        perts = [dict(c, lung_pressure=c["lung_pressure"] * f) for f in (0.9, 1.1)] + \
                [dict(c, lip_force=max(0.1, c["lip_force"] + d)) for d in (-0.15, 0.15)] + \
                [dict(c, tongue_x=min(1, max(0, c["tongue_x"] + d))) for d in (-0.015, 0.015)]
        rr = list(POOL.map(lambda pc: play(e["keys"], pc, setup, f_target=e["f_target"]), perts))
        robust = all(ok and abs(ct) < tol + 15 for ok, ct, _, _ in rr)
        if robust and dyn == "pp" and setup is None:
            # pp sits near threshold: it must also survive the setup adaptation rule (reed/tip changes)
            ss = [{"reed_strength": 2.0}, {"reed_strength": 3.5}, {"tip_opening": 1.6}, {"tip_opening": 2.5}]
            r2 = list(POOL.map(lambda st: play(e["keys"], adapt_voicing(c, st), st, f_target=e["f_target"]), ss))
            robust = all(ok and abs(ct) < tol + 20 for ok, ct, _, _ in r2)
        if not robust:
            continue
        return dict(voicing={k: round(float(c[k]), 3) for k in CONTROLS}, cents=round(cents, 1), level=round(lvl, 2))
    # fall back to the best non-robust candidate (flagged)
    c, (ok, cents, lvl, f0) = res[0]
    if score(res[0]) < 1e9:
        return dict(voicing={k: round(float(c[k]), 3) for k in CONTROLS}, cents=round(cents, 1), level=round(lvl, 2), robust=False)
    return None


def neighbour_ok(e, prev_keys, v):
    ok, cents, _, _ = play(e["keys"], v, None, switch_from=prev_keys, f_target=e["f_target"])
    return ok and abs(cents) < TOL[e["register"]] + 15


def build_table():
    doc = json.load(open(GEOM))
    ents = entries(doc)
    table = []
    std = [x for x in ents if x["alt"] is None and "(" not in x["note"]]
    only = set(NOTES.split(",")) if NOTES else None
    old_rows = {r["note"]: r for r in json.load(open(OUT)).get("entries", [])} if os.path.exists(OUT) else {}
    for i, e in enumerate(ents):
        if only and e["note"].split(" ")[0] not in only:
            continue
        row = dict(note=e["note"], register=e["register"], group=group(e), keys=e["keys"], f_target=e["f_target"], voicing={}, achieved={}, robust={})
        if REDO and old_rows.get(e["note"]):
            row = old_rows[e["note"]]
            vm = row["voicing"]["mf"]
            Lmf = play(e["keys"], vm, f_target=e["f_target"])[2]
            for dyn in REDO:
                r = choose(e, dyn, Lmf)
                if r is not None:
                    row["voicing"][dyn] = r["voicing"]; row["robust"][dyn] = r.get("robust", True)
                    row["achieved"][dyn] = dict(cents=r["cents"], db_re_mf=round(r["level"] - Lmf, 1),
                                                ok=abs(r["cents"]) <= TOL[e["register"]] + 5)
            table.append(row)
            a_ = row["achieved"]
            print(f"{e['note']:28s} " + "  ".join(f"{d}: {a_[d]['cents']}c {a_[d]['db_re_mf']}dB {'R' if row['robust'][d] else 'r'}" for d in ("pp", "mf", "ff")), flush=True)
            continue
        mf = choose(e, "mf")
        if mf is None:
            print(f"{e['note']}: mf FAILED", flush=True)
            continue
        Lmf = mf["level"]
        for dyn in ("pp", "mf", "ff"):
            r = mf if dyn == "mf" else choose(e, dyn, Lmf)
            if r is None:
                # keep mf voicing scaled as a fallback
                r = dict(mf, robust=False, level=Lmf)
                row["achieved"][dyn] = dict(cents=None, db_re_mf=None, ok=False)
            else:
                row["achieved"][dyn] = dict(cents=r["cents"], db_re_mf=round(r["level"] - Lmf, 1),
                                            ok=abs(r["cents"]) <= TOL[e["register"]] + 5)
            row["voicing"][dyn] = r["voicing"]
            row["robust"][dyn] = r.get("robust", True)
        # slur from the chromatic neighbour (standard fingerings / previous altissimo note)
        j = next((k for k, x in enumerate(std) if x["note"] == e["note"]), None)
        prev = std[j - 1]["keys"] if j else (std[-1]["keys"] if e["register"] == 3 else None)
        if prev is not None:
            row["robust"]["slur_mf"] = neighbour_ok(e, prev, row["voicing"]["mf"])
        table.append(row)
        a = row["achieved"]
        print(f"{e['note']:28s} " + "  ".join(f"{d}: {a[d]['cents']}c {a[d]['db_re_mf']}dB {'R' if row['robust'][d] else 'r'}" for d in ("pp", "mf", "ff"))
              + f"  slur {row['robust'].get('slur_mf')}", flush=True)
    data = json.load(open(OUT)) if os.path.exists(OUT) else {}
    old = {r["note"]: r for r in data.get("entries", [])}
    for r in table:
        old[r["note"]] = r
    order = [x["note"] for x in ents]
    data["entries"] = sorted(old.values(), key=lambda r: order.index(r["note"]) if r["note"] in order else 999)
    json.dump(data, open(OUT, "w"), indent=1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["table", "adapt", "refit", "validate"])
    ap.add_argument("--notes")
    ap.add_argument("--redo", help="table mode: recompute only these dynamics (e.g. pp) for existing entries")
    ap.add_argument("--engine", action="store_true", help="validate the engine's auto mode instead of the Python rule")
    a = ap.parse_args()
    NOTES = a.notes
    REDO = a.redo.split(",") if a.redo else []


# ---------------------------------------------------------------- adaptation to mouthpiece / reed
def p_M(ctrl, setup):
    """Python mirror of engine/src/reed.rs derive_reed_params: closing pressure p_M = K·H0/S_r (Pa)."""
    s = dict(SETUP_REF); s.update(setup or {})
    VAMP, K_DEF, LIP_SHARE, LIP_A, share = 35.0, 321.0, 0.85, 0.15, 0.5
    LIP_STATIC = 1.0905 * 0.55 * K_DEF * (1 - LIP_SHARE) * 0.5 / (K_DEF * 0.5)
    lp, lf = ctrl["lip_position"], ctrl["lip_force"]
    len_ratio = 20.0 / (lp + 8.0)
    strength = 0.55 + 0.18 * s["reed_strength"]
    s_r = 4.94e-5 * share * len_ratio ** -0.5
    lever = lambda a: 1.0 / (((3 * VAMP - a) / (2 * a)) ** 2)
    a = max(VAMP - lp, 1.0)
    lever_rel = lever(a) / lever(VAMP - 12.0)
    f_rel = (max(lf, 0) + LIP_A) / (1 + LIP_A)
    k_reed = K_DEF * (1 - LIP_SHARE) * share * strength * len_ratio ** 2
    k = k_reed + K_DEF * LIP_SHARE * share * f_rel * lever_rel
    beta = a * a * (3 * VAMP - a) / (2 * VAMP ** 3)
    y_sat = 0.95 * s["tip_opening"] * 1e-3
    y_eq = y_sat * math.tanh(LIP_STATIC * share * beta * lf / k_reed / y_sat)
    h0 = max(s["tip_opening"] * 1e-3 - y_eq, 0.05 * s["tip_opening"] * 1e-3)
    return k * h0 / s_r


PM_MODE = os.environ.get("AUTO_PM_MODE", "voicing")


def pm_ratio(setup):
    """Engine rule (player.rs tick_auto): p_M at the default embouchure, setup vs reference."""
    return p_M(BASE, setup) / p_M(BASE, {})


SETUP_GRID = dict(tip_opening=[1.4, 1.6, 2.2, 2.5, 2.8, 3.2], reed_strength=[1.5, 2.0, 3.0, 3.5, 4.0, 5.0],
                  facing_length=[16.0, 19.0, 26.0, 30.0], baffle_height=[0.0, 0.6, 1.0],
                  chamber_size=[0.0, 0.25, 0.75, 1.0], throat_diameter=[8.0, 14.0, 16.0],
                  mouthpiece_insertion=[0.0, 5.0, 15.0, 20.0], temperature=[10.0, 16.0, 28.0, 34.0], reed_model=[1.0])
REP = dict(low=["Bb3", "D4", "G4", "C5"], mid=["D5", "G5", "C#6"], palm=["D6", "F6"], altissimo=["G6", "A6", "C7"])
DLIP = [-0.6, -0.4, -0.25, -0.12, 0.0, 0.12, 0.25, 0.4, 0.6]


def adapt_voicing(v, setup, dlip=0.0, extra=None):
    """The engine-side rule: lip trim, then lung pressure rescaled by p_M(setup)/p_M(reference)."""
    v2 = dict(v); v2.update(extra or {})
    v2["lip_force"] = float(np.clip(v["lip_force"] + dlip, 0.0, 3.0))
    r = p_M(v, setup) / p_M(v, {}) if PM_MODE == "voicing" else pm_ratio(setup)
    v2["lung_pressure"] = float(np.clip(v["lung_pressure"] * r, 0.3, 10.0))
    return v2


def apply_rule(v, setup, rule, grp):
    d = 0.0
    for prm, val in setup.items():
        sl = rule["per_param"].get(prm, {}).get("lip_force", {}).get(grp)
        if sl is not None:
            lo, hi = rule.get("validity", {}).get(prm, [-1e9, 1e9])
            d += sl * (min(max(val, lo), hi) - SETUP_REF[prm])
    return adapt_voicing(v, setup, d)


def load_table():
    return {r["note"]: r for r in json.load(open(OUT))["entries"]}


# validity ranges: setup values where the adapted voicing (p_M-scaled pressure + lip trim) keeps >= 85 %
# of the representative notes x dynamics sounding in register and in tune (adapt log, docs/PHYSICS.md §12)
VALIDITY = dict(tip_opening=[1.6, 2.5], reed_strength=[1.5, 5.0], facing_length=[15.0, 30.0], baffle_height=[0.0, 0.6],
                chamber_size=[0.4, 0.6], throat_diameter=[10.0, 15.0], mouthpiece_insertion=[8.0, 12.0],
                temperature=[16.0, 26.0], reed_model=[0.0, 0.0])
FIT_WINDOW = dict(tip_opening=[1.4, 2.8], reed_strength=[1.5, 5.0], facing_length=[15.0, 30.0], baffle_height=[0.0, 1.0],
                  chamber_size=[0.25, 0.75], throat_diameter=[8.0, 16.0], mouthpiece_insertion=[5.0, 15.0],
                  temperature=[10.0, 34.0])


def fit_slopes(rows):
    per = {}
    for prm, (lo, hi) in FIT_WINDOW.items():
        per[prm] = {"lip_force": {}}
        for g in REP:
            xs = [(r["val"] - SETUP_REF[prm], r["best_dlip"]) for r in rows
                  if r["prm"] == prm and r["group"] == g and r["best_dlip"] is not None
                  and lo <= r["val"] <= hi and abs(r["best_dlip"]) < 0.55]
            if len(xs) >= 3:
                x = np.array([a for a, _ in xs]); y = np.array([b for _, b in xs])
                per[prm]["lip_force"][g] = round(float((x * y).sum() / max((x * x).sum(), 1e-12)), 4)
    return per


def refit():
    data = json.load(open(OUT))
    data["adaptation"]["per_param"] = fit_slopes(data["adapt_rows"])
    data["adaptation"]["validity"] = VALIDITY
    json.dump(data, open(OUT, "w"), indent=1)
    print(json.dumps(data["adaptation"]["per_param"]))


def adapt():
    tab = load_table()
    data = json.load(open(OUT))
    gcode = {}
    for g, notes in REP.items():
        for n in notes:
            gcode[n] = g
    # lip trim sensitivity (cents per N) per group, at mf
    trim = {}
    for g, notes in REP.items():
        vals = []
        for n in notes:
            r = tab.get(n)
            if not r:
                continue
            v = r["voicing"]["mf"]
            a = play(r["keys"], dict(v, lip_force=v["lip_force"] - 0.15), f_target=r["f_target"])
            b = play(r["keys"], dict(v, lip_force=v["lip_force"] + 0.15), f_target=r["f_target"])
            if a[0] and b[0]:
                vals.append((b[1] - a[1]) / 0.3)
        trim[g] = round(float(np.median(vals)), 1) if vals else None
    print("lip trim cents/N", trim, flush=True)
    jobs = []
    for prm, values in SETUP_GRID.items():
        for val in values:
            for n, g in gcode.items():
                r = tab.get(n)
                if not r:
                    continue
                for dyn in ("pp", "mf", "ff"):
                    jobs.append((prm, val, n, g, dyn))
    def run(job):
        prm, val, n, g, dyn = job
        r = tab[n]; v = r["voicing"][dyn]; setup = {prm: val}
        raw = play(r["keys"], v, setup, f_target=r["f_target"])
        res = []
        for d in DLIP:
            res.append((d,) + play(r["keys"], adapt_voicing(v, setup, d), setup, f_target=r["f_target"]))
        good = [x for x in res if x[1]]
        best = min(good, key=lambda x: abs(x[2])) if good else None
        return dict(prm=prm, val=val, note=n, group=g, dyn=dyn, raw_ok=bool(raw[0]), raw_cents=round(raw[1], 1),
                    scaled_ok=bool(res[4][1]), scaled_cents=round(res[4][2], 1),
                    best_dlip=None if best is None else best[0], best_cents=None if best is None else round(best[2], 1),
                    lung_ratio=round(pm_ratio(setup), 3))
    rows = list(POOL.map(run, jobs))
    # slopes of the optimal lip trim, per param x group (least squares through the origin, ok rows only)
    per = {}
    for prm in SETUP_GRID:
        if prm == "reed_model":
            continue
        per[prm] = {"lip_force": {}}
        for g in REP:
            xs = [(r["val"] - SETUP_REF[prm], r["best_dlip"]) for r in rows
                  if r["prm"] == prm and r["group"] == g and r["best_dlip"] is not None]
            if len(xs) >= 3:
                x = np.array([a for a, _ in xs]); y = np.array([b for _, b in xs])
                sl = float((x * y).sum() / max((x * x).sum(), 1e-12))
                per[prm]["lip_force"][g] = round(sl, 4)
    data["adapt_rows"] = rows
    data["adaptation"] = dict(trim=trim, per_param=fit_slopes(rows), validity=VALIDITY)
    json.dump(data, open(OUT, "w"), indent=1)
    # summary
    for prm in SETUP_GRID:
        for val in SETUP_GRID[prm]:
            rr = [r for r in rows if r["prm"] == prm and r["val"] == val]
            f = lambda k: sum(1 for r in rr if r[k]) / max(len(rr), 1)
            tb = sum(1 for r in rr if r["best_cents"] is not None and abs(r["best_cents"]) <= TOL[3 if r["group"] == "altissimo" else (1 if r["group"] == "low" else 2)]) / max(len(rr), 1)
            print(f"{prm:22s} {val:6.2f}  raw {f('raw_ok'):.2f}  pM-scaled {f('scaled_ok'):.2f}  +lip in tune {tb:.2f}", flush=True)
    print("slopes", json.dumps(per), flush=True)


TEST_SETUPS = {"default": {}, "bright (baffle 0.9)": {"baffle_height": 0.9}, "open tip 2.5": {"tip_opening": 2.5},
               "hard reed 3.5": {"reed_strength": 3.5}, "soft reed 2.0": {"reed_strength": 2.0},
               "cork pushed (ins 16)": {"mouthpiece_insertion": 16.0}, "cork pulled (ins 4)": {"mouthpiece_insertion": 4.0}}


def validate(engine_auto=False):
    """All entries x 3 dynamics x TEST_SETUPS; the rule is applied in Python (engine_auto=False) or the
    engine's auto mode is used (engine_auto=True: keys + dynamic + setup only)."""
    tab = json.load(open(OUT))["entries"]
    rule = json.load(open(OUT))["adaptation"]
    rule = dict(per_param=rule["per_param"], validity=rule.get("validity", {}))
    jobs = [(name, s, r, dyn) for name, s in TEST_SETUPS.items() for r in tab for dyn in ("pp", "mf", "ff")]
    def run(job):
        name, s, r, dyn = job
        e = dict(register=r["register"], f_target=r["f_target"])
        g = "altissimo" if r["register"] == 3 else ("palm" if r["register"] == 2 and r["f_target"] > 690 else ("mid" if r["register"] == 2 else "low"))
        if engine_auto:
            v = {"auto_player": 1, "dynamic": {"pp": 0.0, "mf": 0.5, "ff": 1.0}[dyn], "lung_pressure": 5.0}
            ok, ct, lvl, _ = play(r["keys"], v, s, f_target=r["f_target"])
        else:
            v = apply_rule(r["voicing"][dyn], s, rule, g)
            ok, ct, lvl, _ = play(r["keys"], v, s, f_target=r["f_target"])
        return name, r["note"], dyn, ok, ct, lvl, ok and abs(ct) <= TOL[r["register"]] + (0 if s == {} else 5)
    res = list(POOL.map(run, jobs))
    out = {}
    for name in TEST_SETUPS:
        rr = [x for x in res if x[0] == name]
        off = float(np.median([x[4] for x in rr if x[3]])) if any(x[3] for x in rr) else 0.0
        tolr = {r["note"]: TOL[r["register"]] + 5 for r in tab}
        rel = sum(1 for x in rr if x[3] and abs(x[4] - off) <= tolr[x[1]]) / len(rr)
        out[name] = dict(sounds_in_register=sum(x[3] for x in rr) / len(rr), in_tune=sum(x[6] for x in rr) / len(rr),
                         tuning_offset_cents=round(off, 1), in_tune_re_offset=rel,
                         fails=[f"{x[1]} {x[2]} {'silent/wrong' if not x[3] else f'{x[4]:+.0f}c'}" for x in rr if not x[6]])
        print(f"{name:24s} in register {out[name]['sounds_in_register']:.3f}  in tune {out[name]['in_tune']:.3f}  "
              f"offset {off:+.1f}c  in tune re offset {rel:.3f}  "
              f"fails: {', '.join(out[name]['fails'][:14])}", flush=True)
    data = json.load(open(OUT)); data["validation" + ("_engine" if engine_auto else "_" + PM_MODE)] = out
    json.dump(data, open(OUT, "w"), indent=1)


if __name__ == "__main__" and a.mode == "adapt":
    adapt()
if __name__ == "__main__" and a.mode == "refit":
    refit()
if __name__ == "__main__" and a.mode == "validate":
    validate(engine_auto=a.engine)
if __name__ == "__main__" and a.mode == "table":
    build_table()
