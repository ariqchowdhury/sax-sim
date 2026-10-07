"""Auto-player voicing search THROUGH the engine auto path (render --auto --dynamic; attack on the mf voicing,
eased to the dynamic): candidates for one entry x dynamic, robust over default/soft/hard reed/open tip.
    SAX_RENDER=... python3 tools/auto_player_path.py NOTE pp|mf|ff ["python list expr of candidate dicts using base"]
Used to refit Bb3/Eb4/E4/E6/F6/F#6 pp and C#7 (docs/PHYSICS.md section 12)."""
import sys, json, os, re, subprocess, tempfile, itertools
sys.path.insert(0, "/Users/ariq/code/sax_sim/tools"); sys.path.insert(0, os.path.dirname(__file__))
import auto_player as A, wavlev
GEOM = json.load(open("/Users/ariq/code/sax_sim/data/alto_sax.json"))
SETUPS = [{}, {"reed_strength": 2.0}, {"reed_strength": 3.5}, {"tip_opening": 2.5}]

def render(geom_path, keys, d, s):
    fd, p = tempfile.mkstemp(suffix=".wav"); os.close(fd)
    cmd = [A.RENDER, "--keys", ",".join(keys), "--pressure", "5", "--seconds", "2.5", "--geometry", geom_path,
           "--seed", "1", "--auto", "--dynamic", str(d), "--out", p]
    for k, v in s.items(): cmd += ["--set", f"{k}={v}"]
    o = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        f0 = float(re.search(r"f0=([0-9.]+)", o).group(1)); L = wavlev.lev(p, 1.9, 2.4)
    except Exception:
        f0, L = 0.0, -120.0
    os.unlink(p); return f0, L

def evaluate(note, dyn, v, dval, Lmf_by_setup):
    g = json.loads(json.dumps(GEOM)); e = next(x for x in g["auto_player"]["entries"] if x["note"] == note)
    e["voicing"][dyn] = v; e["achieved"][dyn]["ok"] = True
    fd, path = tempfile.mkstemp(suffix=".json"); os.close(fd); json.dump(g, open(path, "w"))
    res = []
    for s in SETUPS:
        f0, L = render(path, e["keys"], dval, s)
        res.append((A.cents_vs(f0, e["f_target"]), L - Lmf_by_setup[json.dumps(s)]))
    os.unlink(path); return res

def search(note, dyn, cands, dval):
    e = next(x for x in GEOM["auto_player"]["entries"] if x["note"] == note)
    tol = A.TOL[e["register"]]
    Lmf = {json.dumps(s): render("/Users/ariq/code/sax_sim/data/alto_sax.json", e["keys"], 0.5, s)[1] for s in SETUPS}
    out = list(A.POOL.map(lambda v: (v, evaluate(note, dyn, v, dval, Lmf)), cands))
    def score(r):
        v, res = r
        bad = sum(1 for c, _ in res if abs(c) > tol + 5)
        tgt = A.DYN_DB[dyn]
        return bad * 100 + abs(res[0][0]) / tol + abs(res[0][1] - tgt) / 3 + 0.2 * sum(abs(c) for c, _ in res[1:]) / tol
    out.sort(key=score)
    return out[:5]

def grid_pp(base, reg):
    lps = (14.0, 16.0, 18.0, 20.0)
    return [dict(base, lip_force=lf, lip_position=lp, lip_damping=ld, lung_pressure=p, tongue_y=ty, jaw_open=j)
            for lf in (1.6, 2.0, 2.4, 2.8) for lp in lps for ld in (0.6, 1.0) for p in (1.4, 1.8, 2.2, 2.6)
            for ty, j in ((base["tongue_y"], base["jaw_open"]),)]

if __name__ == "__main__":
    note, dyn = sys.argv[1], sys.argv[2]
    e = next(x for x in GEOM["auto_player"]["entries"] if x["note"] == note)
    base = e["voicing"]["mf"]
    if len(sys.argv) > 3:
        cands = eval(sys.argv[3], {"base": base, "itertools": itertools})
    else:
        cands = grid_pp(base, e["register"])
    dval = {"pp": 0.0, "mf": 0.5, "ff": 1.0}[dyn]
    best = search(note, dyn, cands, dval)
    for v, res in best:
        print(json.dumps({k: v[k] for k in ("lip_force", "lip_position", "lip_damping", "lung_pressure", "tongue_y", "jaw_open", "tongue_tip", "tongue_x", "glottis_open")}),
              [(round(c, 1), round(l, 1)) for c, l in res])
    json.dump([v for v, _ in best], open(os.path.join(os.path.dirname(__file__), f"best_{note}_{dyn}.json"), "w"))
