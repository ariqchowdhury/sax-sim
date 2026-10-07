#!/usr/bin/env python3
"""
Engine-in-the-loop tuning: uses the Rust engine's native renderer (self-oscillating physics) as the
ground truth for playing frequency, and moves tone holes / the bell end until the standard fingerings
play in tune.

    python3 tools/engine_loop.py table  [--pressure 3.5] [--attack 0.05]   # engine table for data/alto_sax.json
    python3 tools/engine_loop.py tune   [--iters 5]                       # adjust tools/hole_table.json, rebuild JSON
    python3 tools/engine_loop.py robust                                   # table at several pressures / attacks

The renderer binary is taken from $SAX_RENDER, else engine/target/release/render (built with
`cargo build --release --bin render`). Each table call renders every fingering in parallel (~2 s).

Tuning rule (per register-1 note, and per palm-key note): the hole that 'vents' the note (field
`vents` in the JSON) is moved by dx = e * L_eff / 1731 (e = cents sharp, L_eff = c/(2 f)), i.e.
the cone length sensitivity d(cents)/dx = -1731/L_eff; Bb3 moves the bell end (body_len).
Pitch is averaged over the playing pressures in PRESSURES so the result is not tied to one dynamic.
"""
import argparse, json, math, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_geometry as BG

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDER = os.environ.get("SAX_RENDER", os.path.join(ROOT, "engine", "target", "release", "render"))
PRESSURES = [3.0, 3.5, 4.0]
SETS = []          # extra --set name=value for every render (e.g. player_assist=0), from --set
ATTACK = 0.05
C22 = 344.4


def engine_table(json_path, pressure=3.5, attack=ATTACK, seconds=1.5, sets=None):
    sets = SETS if sets is None else sets
    cmd = [RENDER, "--table", "--pressure", str(pressure), "--seconds", str(seconds), "--geometry", json_path]
    if attack > 0:
        cmd += ["--attack", str(attack)]
    for s in sets:
        cmd += ["--set", s]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=600).stdout
    res = {}
    for line in out.splitlines()[1:]:
        p = line.split()
        if len(p) >= 6:
            try:
                res[p[0]] = dict(target=float(p[1]), f0=float(p[2]), cents=float(p[3]), rms=float(p[4]), ratio=float(p[5]))
            except ValueError:
                pass
    return res


def in_register(r):
    return r["f0"] > 0 and abs(r["cents"]) < 300


def build_tmp(tbl):
    doc = BG.build(tbl, write=False)
    fd, path = tempfile.mkstemp(suffix=".json", prefix="sax_geom_")
    with os.fdopen(fd, "w") as f:
        json.dump(doc, f)
    return path, doc


def averaged(path, pressures=PRESSURES, attack=ATTACK):
    tabs = [engine_table(path, p, attack) for p in pressures]
    out = {}
    for n in tabs[0]:
        ok = [t[n] for t in tabs if n in t and in_register(t[n])]
        out[n] = dict(cents=sum(r["cents"] for r in ok) / len(ok) if ok else float("nan"),
                      n_ok=len(ok), n=len(tabs), all=[t[n]["cents"] for t in tabs if n in t])
    return out


def tune(iters, gain=0.8):
    with open(BG.HOLE_TABLE) as f:
        tbl = json.load(f)
    BG.P.update(tbl.get("params", {}))
    vent_of = {h[5]: h[0] for h in BG.HOLES0 if h[5]}
    vent_of.pop("C5", None)
    vent_of["C5"] = "B"   # side_C also vents C5 (alternate); the standard C5 uses the B pad
    for it in range(iters):
        path, doc = build_tmp(tbl)
        res = averaged(path)
        os.unlink(path)
        errs = {n: r["cents"] for n, r in res.items() if not math.isnan(r["cents"])}
        reg = {f["note"]: f["register"] for f in doc["fingerings"]}
        r1 = [abs(e) for n, e in errs.items() if reg.get(n) == 1]
        r2 = [abs(e) for n, e in errs.items() if reg.get(n) == 2]
        bad = [n for n, r in res.items() if r["n_ok"] < r["n"]]
        print(f"[{it}] worst reg1 {max(r1, default=0):.1f}  reg2 {max(r2, default=0):.1f}  wrong-register/silent: {bad}")
        print("     " + " ".join(f"{n}:{e:+.0f}" for n, e in errs.items()))
        # bell end <- Bb3
        if "Bb3" in errs:
            L = C22 / (2 * 138.59)
            tbl["params"]["body_len"] = tbl["params"]["body_len"] + gain * errs["Bb3"] * L / 1731
        for note, e in errs.items():
            hid = vent_of.get(note)
            if hid is None or reg.get(note) is None:
                continue
            if reg[note] == 2 and not hid.startswith(("palm", "side_E", "high")):
                continue
            f = next(q for q in doc["fingerings"] if q["note"] == note)
            L = C22 / (2 * f["f_target"] / (2 if reg[note] == 2 else 1))
            if reg[note] == 2:
                L = C22 / (2 * f["f_target"] / 2)
            h = tbl["holes"][hid]
            x_new = h["x"] + gain * e * L / 1731
            x_min = BG.x_body0() + 0.004          # tone holes must stay on the body (not on the neck)
            d = BG.DELTA.get(hid)
            if x_new < x_min:
                # cannot move further up: enlarge the hole instead (bigger hole = sharper)
                h["x"] = x_min
                h["radius"] = min(0.92 * BG.r_bore(x_min), h.get("radius", d * BG.r_bore(x_min)) * (1 + 0.15 * (x_min - x_new) / 0.01))
            else:
                h["x"] = x_new
                if d:
                    h["radius"] = min(BG.MAX_HOLE_RADIUS, d * BG.r_bore(h["x"]))
    with open(BG.HOLE_TABLE, "w") as f:
        json.dump(tbl, f, indent=1)
    BG.build(tbl, write=True)
    print("updated", BG.HOLE_TABLE, "and data/alto_sax.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["table", "tune", "robust"])
    ap.add_argument("--pressure", type=float, default=3.5)
    ap.add_argument("--attack", type=float, default=ATTACK)
    ap.add_argument("--iters", type=int, default=5)
    ap.add_argument("--json", default=os.path.join(ROOT, "data", "alto_sax.json"))
    ap.add_argument("--set", action="append", default=[], help="engine param name=value for every render")
    a = ap.parse_args()
    SETS.extend(a.set)
    if a.mode == "table":
        for n, r in engine_table(a.json, a.pressure, a.attack).items():
            print(f"{n:5s} {r['target']:8.2f} {r['f0']:8.2f} {r['cents']:+8.1f} {'' if in_register(r) else 'WRONG REGISTER/SILENT'}")
    elif a.mode == "robust":
        for p in (2.5, 3.0, 3.5, 4.0, 5.0):
            for at in (0.0, 0.05):
                t = engine_table(a.json, p, at)
                bad = [n for n, r in t.items() if not in_register(r)]
                print(f"p={p} attack={at}: wrong/silent {len(bad)} {bad}")
    else:
        tune(a.iters)


if __name__ == "__main__":
    main()
