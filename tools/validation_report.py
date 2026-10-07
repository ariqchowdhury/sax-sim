#!/usr/bin/env python3
"""Generate the engine-measured markdown tables for docs/VALIDATION.md.
    SAX_RENDER=... python3 tools/validation_report.py > /tmp/report.md"""
import os, re, subprocess, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine_loop as EL
ROOT = EL.ROOT
J = os.path.join(ROOT, "data", "alto_sax.json")
d = json.load(open(J))
P = (3.0, 3.5, 4.0)
for assist in ("0", "0.5"):
    tabs = {p: EL.engine_table(J, p, 0.05, sets=[f"player_assist={assist}"]) for p in P}
    print(f"\n#### player_assist = {assist}\n")
    print("| written | reg | target Hz | " + " | ".join(f"{p} kPa f0 (cents)" for p in P) + " |")
    print("|---|---|---|" + "---|" * len(P))
    w = {1: 0, 2: 0}; bad = 0; worst_note = {}
    for f in d["fingerings"]:
        cells = []
        for p in P:
            r = tabs[p][f["note"]]
            if EL.in_register(r):
                cells.append(f"{r['f0']:.1f} ({r['cents']:+.0f})")
                if abs(r["cents"]) > w[f["register"]]:
                    w[f["register"]] = abs(r["cents"]); worst_note[f["register"]] = f["note"]
            else:
                cells.append(f"**{r['f0']:.0f} ✗**"); bad += 1
        print(f"| {f['note']} | {f['register']} | {f['f_target']:.2f} | " + " | ".join(cells) + " |")
    print(f"\nassist {assist}: worst in-register error reg1 {w[1]:.0f} c ({worst_note.get(1)}), reg2 {w[2]:.0f} c ({worst_note.get(2)}); "
          f"wrong register / silent: {bad} of {len(P)*len(d['fingerings'])} cells.")
print("\n#### Onset thresholds (assist 0, constant pressure from rest)\n")
print("| note | onset kPa | extinction kPa (slow decrescendo) |\n|---|---|---|")
for n in ("Bb3", "D4", "G4", "C#5", "D5", "G5", "D6"):
    out = subprocess.run([EL.RENDER, "--threshold", "--fingering", n, "--geometry", J, "--set", "player_assist=0"], capture_output=True, text=True).stdout
    on = re.search(r"onset threshold.*?([\d.]+) kPa", out); ex = re.search(r"extinction.*?([\d.]+) kPa", out)
    print(f"| {n} | {on[1] if on else '—'} | {ex[1] if ex else '—'} |")
