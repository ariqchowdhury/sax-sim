#!/usr/bin/env python3
"""
Transfer-matrix (TMM) input impedance of the alto saxophone air column in data/alto_sax.json.

    python3 tools/tmm.py --fingering Bb3          # peaks + predicted playing frequency for one fingering
    python3 tools/tmm.py --all                    # table for every standard fingering
    python3 tools/tmm.py --all --alternates       # include alternate fingerings
    python3 tools/tmm.py --keys LH1,LH2,LH3       # arbitrary key combination
    python3 tools/tmm.py --fingering G4 --plot    # |Z_in| plot (matplotlib)
    python3 tools/tmm.py --all --temp 30          # other air temperature
    python3 tools/tmm.py --dump-impedance G4 out.csv

Model (see docs/PHYSICS.md for the full description; this is the frequency-domain reference
for the time-domain engine):
  * Bore = piecewise-conical frusta (mouthpiece equivalent-area profile + neck + body + flare),
    each frustum propagated with exact spherical-wave cone transfer matrices using a complex
    visco-thermal wavenumber (Keefe 1984 large-r_v expansion, evaluated at the frustum mean radius).
  * Tone holes = symmetric T-networks (Keefe 1990; Dalmont et al. 2002 corrections):
      series  Za = j w rho t_a / (pi a^2)       (negative length correction, open/closed)
      shunt   Zs = chimney of height t (lossy) + inner/matching corrections, terminated by
              open : unflanged-hole radiation with pad-height dependent end correction
              closed: rigid pad (closed tube of height t).
  * Bell = Levine-Schwinger unflanged radiation via the Norris-Sheng / Silva et al. (2009) fit.
  * Reed = compliance (equivalent volume V_r) in parallel at the input (Nederveen 1998).
  * Predicted playing frequency = frequency of the |Z_in| maximum (with reed compliance) closest
    to the target; register-2 notes use the octave vent selected by the keywork rules.
numpy only.
"""
import argparse, json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_JSON = os.path.join(ROOT, "data", "alto_sax.json")


# --------------------------------------------------------------------------- air
def air(T_c=22.0):
    """Keefe (1984) air properties at temperature T (deg C), dry air, 1 atm."""
    dT = T_c - 26.85
    return dict(
        c=347.23 * (1 + 0.00166 * dT),
        rho=1.1769 * (1 - 0.00335 * dT),
        eta=1.846e-5 * (1 + 0.0025 * dT),
        gamma=1.4017 * (1 - 0.00002 * dT),
        nu=0.8410 * (1 - 0.0002 * dT),   # sqrt(Prandtl)
        T=T_c,
    )


def lossy(w, a, A):
    """Complex wavenumber k (so p ~ exp(-j k x)) and characteristic-impedance factor zeta
    (Zc = zeta * rho c / S) for a tube of radius a. Keefe (1984)."""
    rv = a * np.sqrt(A["rho"] * w / A["eta"])
    k0 = w / A["c"]
    k = k0 * ((1 + 1.045 / rv) - 1j * (1.045 / rv + 1.080 / rv ** 2 + 0.750 / rv ** 3))
    zeta = (1 + 0.369 / rv) - 1j * (0.369 / rv + 1.149 / rv ** 2 + 0.303 / rv ** 3)
    return k, zeta


# --------------------------------------------------------------------------- geometry
class Geometry:
    def __init__(self, path=DEFAULT_JSON, doc=None):
        if doc is None:
            with open(path) as f:
                doc = json.load(f)
        self.doc = doc
        prof = [tuple(p) for p in doc["mouthpiece"]["profile"]]
        for part in ("neck", "body"):
            for p in doc[part]["profile"]:
                if p[0] > prof[-1][0] + 1e-9:
                    prof.append(tuple(p))
        self.profile = np.array(prof)
        self.holes = doc["tone_holes"]
        self.hole_index = {h["id"]: i for i, h in enumerate(self.holes)}
        self.keys = doc["keys"]
        self.key_ids = [k["id"] for k in self.keys]
        self.linkages = doc["linkages"]
        self.reed_volume = doc["meta"].get("reed_equivalent_volume", 1.0e-6)
        self.reed_fr = doc["meta"].get("reed_resonance_hz", 0.0)
        self.end_x = self.profile[-1, 0]

    def radius(self, x):
        return float(np.interp(x, self.profile[:, 0], self.profile[:, 1]))

    # ------------------------------------------------------------------ keywork (reference impl.)
    def hole_openness(self, pressed):
        """pressed: dict key_id -> amount in [0,1] (or iterable of pressed ids).
        Returns dict hole_id -> openness in [0,1]. Exactly the algorithm in docs/PHYSICS.md 'Keywork'."""
        if not isinstance(pressed, dict):
            pressed = {k: 1.0 for k in pressed}
        for k in pressed:
            if k not in self.key_ids:
                raise KeyError(f"unknown key {k}")
        p = lambda k: float(pressed.get(k, 0.0))
        state = {h["id"]: (1.0 if h["pad_rest"] == "open" else 0.0) for h in self.holes}
        rules = []
        for key in self.keys:
            for a in key["actions"]:
                rules.append(dict(when_all=[key["id"]], hole=a["hole"], set=a["set"]))
        rules += self.linkages
        for r in rules:
            wa, wy, un = r.get("when_all", []), r.get("when_any", []), r.get("unless_any", [])
            a = 1.0
            if wa:
                a = min(a, min(p(k) for k in wa))
            if wy:
                a = min(a, max(p(k) for k in wy))
            if un:
                a *= 1.0 - max(p(k) for k in un)
            # both lists empty -> a stays 1 (always-active rule), as in keywork.rs / keywork.ts
            tgt = 1.0 if r["set"] == "open" else 0.0
            state[r["hole"]] = state[r["hole"]] * (1 - a) + tgt * a
        return state


# --------------------------------------------------------------------------- elements
def cone_matrix(w, x1, r1, x2, r2, A):
    """Transfer matrix [[a,b],[c,d]] with [p1,U1] = M [p2,U2] for a lossy frustum."""
    L = x2 - x1
    rm = 0.5 * (r1 + r2)
    k, zeta = lossy(w, rm, A)
    rho, c = A["rho"], A["c"]
    if abs(r2 - r1) < 1e-7 * L or abs(r2 - r1) < 1e-9:
        S = math.pi * rm * rm
        Zc = zeta * rho * c / S
        ch, sh = np.cos(k * L), np.sin(k * L)
        return ch, 1j * Zc * sh, 1j * sh / Zc, ch
    # distance from apex (signed): r(x) = (x - xa), radius = tan*r
    tan = (r2 - r1) / L
    d1 = r1 / tan
    d2 = d1 + L
    S1, S2 = math.pi * r1 * r1, math.pi * r2 * r2
    # series impedance per unit length Z' = j k Zc  (lossy); U = -(1/Z') dp/dx
    Zp1 = 1j * k * zeta * rho * c / S1
    Zp2 = 1j * k * zeta * rho * c / S2
    # basis p± (d) = exp(∓ j k (d-d1)) / d
    def basis(d, Zp):
        e_m = np.exp(-1j * k * (d - d1)); e_p = np.exp(1j * k * (d - d1))
        pm, pp = e_m / d, e_p / d
        dpm = pm * (-1j * k - 1.0 / d)
        dpp = pp * (1j * k - 1.0 / d)
        return pm, pp, -dpm / Zp, -dpp / Zp
    a1, b1, c1, d1_ = basis(d1, Zp1)
    a2, b2, c2, d2_ = basis(d2, Zp2)
    # M1 = [[a1,b1],[c1,d1]] ; M2 likewise ; T = M1 M2^-1
    det2 = a2 * d2_ - b2 * c2
    i11, i12, i21, i22 = d2_ / det2, -b2 / det2, -c2 / det2, a2 / det2
    return (a1 * i11 + b1 * i21, a1 * i12 + b1 * i22,
            c1 * i11 + d1_ * i21, c1 * i12 + d1_ * i22)


def rad_unflanged(w, a, A):
    """Radiation impedance of an unflanged pipe end (Norris & Sheng 1989 fit as used by Silva et al. 2009)."""
    k = w / A["c"]
    ka = k * a
    Rmag = (1 + 0.2 * ka - 0.084 * ka ** 2) / (1 + 0.2 * ka + (0.5 - 0.084) * ka ** 2)
    l = a * 0.6133 * (1 + 0.044 * ka ** 2) / (1 + 0.19 * ka ** 2) - a * 0.02 * np.sin(2 * ka) ** 2
    R = -Rmag * np.exp(-2j * k * l)
    Zc = A["rho"] * A["c"] / (math.pi * a * a)
    return Zc * (1 + R) / (1 - R)


RAD_DELTA_HOLE = 0.70     # outer end correction / b of a hole in the tube wall (unflanged 0.61 .. flanged 0.82)
RAD_KAPPA_HOLE = 1.0 / 3  # Re{Z_rad} = Zc (kb)^2 * kappa  (unflanged 1/4 .. flanged 1/2)
PAD_COEF = 0.12           # pad (curtain) end correction = PAD_COEF * b^2 / h  (=0.3 b at h = 0.4 b; Nederveen 1998)


def pad_end_correction(b, h):
    """Outer end correction of an open tone hole of radius b with a pad hovering at height h
    (identical to engine/src/toneholes.rs): 0.70 b + 0.12 b^2/h."""
    h = max(h, 0.02 * b)
    return b * RAD_DELTA_HOLE + PAD_COEF * b * b / h


def hole_corrections(a, b, t):
    d = b / a
    ti = b * (0.82 - 0.193 * d - 1.09 * d ** 2 + 1.27 * d ** 3 - 0.71 * d ** 4)   # Dalmont et al. 2002
    tm = b * d * (1 + 0.207 * d ** 3) / 8.0                                       # matching volume
    den_o = np.tanh(1.84 * t / b) + 0.62 * d ** 2 + 0.64 * d
    den_c = 1.0 / np.tanh(1.84 * t / b) + 0.62 * d ** 2 + 0.64 * d
    ta_o = -0.47 * b * d ** 4 / den_o                                             # Keefe 1990 / Dalmont 2002
    ta_c = -0.47 * b * d ** 4 / den_c
    return ti, tm, ta_o, ta_c


def hole_matrix(w, hole, a, openness, A):
    """Symmetric T-network of a tone hole on a main bore of radius a. openness 0 = closed, >0 open
    with pad height openness*pad_open_height."""
    b, t = hole["radius"], hole["chimney"]
    rho, c = A["rho"], A["c"]
    Sb = math.pi * b * b
    k, zeta = lossy(w, b, A)
    Zch = zeta * rho * c / Sb
    ti, tm, ta_o, ta_c = hole_corrections(a, b, t)
    if openness > 1e-3:
        h = openness * hole["pad_open_height"]
        dl = pad_end_correction(b, h)
        k0 = w / c
        Zr = (rho * c / Sb) * (RAD_KAPPA_HOLE * (k0 * b) ** 2 + 1j * k0 * dl)
        tn = np.tan(k * t)
        Zs = Zch * (Zr + 1j * Zch * tn) / (Zch + 1j * Zr * tn)
        ta = ta_o
    else:
        Zs = -1j * Zch / np.tan(k * t)
        ta = ta_c
    Zs = Zs + 1j * w * rho * (ti + tm) / Sb
    Za = 1j * w * rho * ta / (math.pi * a * a)
    # T-network: [[1+Za/2Zs, Za(1+Za/4Zs)],[1/Zs, 1+Za/2Zs]]
    q = Za / (2 * Zs)
    return 1 + q, Za * (1 + Za / (4 * Zs)), 1 / Zs, 1 + q


# --------------------------------------------------------------------------- input impedance
def input_impedance(g, freqs, openness, A=None, max_seg=0.005, include_reed=True, x_from=0.0):
    """Z_in at the reed tip (x=0) for hole openness dict; returns complex array."""
    if A is None:
        A = air()
    w = 2 * np.pi * np.asarray(freqs, dtype=float)
    prof = g.profile
    # element list from bell to input
    events = []  # (x, kind, payload)
    for h in g.holes:
        events.append((h["x"], "hole", h))
    # breakpoints: profile nodes + hole positions
    xs = set(prof[:, 0].tolist())
    for h in g.holes:
        xs.add(h["x"])
    xs = np.array(sorted(x for x in xs if x >= x_from - 1e-12))
    # refine
    fine = [xs[0]]
    for x0, x1 in zip(xs[:-1], xs[1:]):
        n = max(1, int(math.ceil((x1 - x0) / max_seg)))
        for i in range(1, n + 1):
            fine.append(x0 + (x1 - x0) * i / n)
    fine = np.array(fine)
    r_end = g.radius(fine[-1])
    Z = rad_unflanged(w, r_end, A)
    holes_at = {}
    for h in g.holes:
        holes_at.setdefault(round(h["x"], 9), []).append(h)
    for i in range(len(fine) - 1, 0, -1):
        x2, x1 = fine[i], fine[i - 1]
        # hole located at x2 (applied before propagating upstream)
        for h in holes_at.get(round(x2, 9), []):
            a = g.radius(x2)
            m = hole_matrix(w, h, a, openness.get(h["id"], 0.0), A)
            Z = (m[0] * Z + m[1]) / (m[2] * Z + m[3])
        if x2 - x1 < 1e-9:
            continue
        m = cone_matrix(w, x1, g.radius(x1), x2, g.radius(x2), A)
        Z = (m[0] * Z + m[1]) / (m[2] * Z + m[3])
    if include_reed and g.reed_volume > 0:
        # reed as a driven oscillator: U_r = S_r dy/dt, y = -S_r p / (k D(w)), D = 1 - (w/wr)^2 + j q w/wr
        D = 1.0
        if getattr(g, "reed_fr", 0.0):
            wr = 2 * np.pi * g.reed_fr
            D = 1 - (w / wr) ** 2 + 1j * 0.4 * w / wr
        Y = 1 / Z + 1j * w * g.reed_volume / (A["rho"] * A["c"] ** 2) / D
        Z = 1 / Y
    return Z


def find_peaks(freqs, Z):
    m = np.abs(Z)
    lm = np.log(m)
    out = []
    for i in range(1, len(m) - 1):
        if m[i] > m[i - 1] and m[i] >= m[i + 1]:
            y0, y1, y2 = lm[i - 1], lm[i], lm[i + 1]
            den = y0 - 2 * y1 + y2
            dlt = 0.5 * (y0 - y2) / den if den != 0 else 0.0
            df = freqs[i + 1] - freqs[i]
            out.append((freqs[i] + dlt * df, float(np.exp(y1 - 0.25 * (y0 - y2) * dlt))))
    return out


def cents(f, f0):
    return 1200.0 * math.log2(f / f0)


def predict(g, keys, f_target, A=None, register=1, span_cents=500.0, coarse=None):
    """Predicted playing frequency = |Z| peak nearest the target (searching +-span), refined.
    Returns dict with f, cents, peak magnitude, mode index (1-based among strong peaks below f)."""
    if A is None:
        A = air()
    op = g.hole_openness(keys)
    lo, hi = f_target * 2 ** (-span_cents / 1200), f_target * 2 ** (span_cents / 1200)
    fr = np.exp(np.linspace(np.log(lo), np.log(hi), 240))
    Z = input_impedance(g, fr, op, A)
    pk = find_peaks(fr, Z)
    if not pk:
        return dict(f=float("nan"), cents=float("nan"), mag=0.0, mode=0, below_max=0.0)
    f, mag = min(pk, key=lambda q: abs(math.log(q[0] / f_target)))
    # refine on fine grid
    fr2 = np.linspace(f * 0.995, f * 1.005, 81)
    pk2 = find_peaks(fr2, input_impedance(g, fr2, op, A))
    if pk2:
        f, mag = max(pk2, key=lambda q: q[1])
    # mode index: count peaks of full spectrum below f
    if coarse is not None:
        frc = np.linspace(40, f * 1.02, 600)
        pkc = find_peaks(frc, input_impedance(g, frc, op, A))
        mode = 1 + sum(1 for q in pkc if q[0] < f * 0.97)
        strongest_below = max([q[1] for q in pkc if q[0] < f * 0.97], default=0.0)
    else:
        mode, strongest_below = None, None
    return dict(f=f, cents=cents(f, f_target), mag=mag, mode=mode, below_max=strongest_below)


def fingering_table(g, A=None, alternates=False, with_mode=False):
    rows = []
    fings = list(g.doc["fingerings"])
    if alternates:
        for a in g.doc.get("alternate_fingerings", []):
            base = next(f for f in g.doc["fingerings"] if f["note"] == a["note"])
            fings.append(dict(base, keys=a["keys"], note=a["note"] + f" ({a['name']})", register=a["register"]))
    for f in fings:
        r = predict(g, f["keys"], f["f_target"], A, f["register"], coarse=True if with_mode else None)
        rows.append((f, r))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", default=DEFAULT_JSON)
    ap.add_argument("--fingering")
    ap.add_argument("--keys", help="comma-separated key ids")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--alternates", action="store_true")
    ap.add_argument("--temp", type=float, default=22.0)
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--fmax", type=float, default=3000.0)
    ap.add_argument("--no-reed", action="store_true")
    ap.add_argument("--markdown", action="store_true", help="print --all table as markdown")
    ap.add_argument("--dump-impedance", nargs=2, metavar=("NOTE", "CSV"))
    args = ap.parse_args()
    g = Geometry(args.json)
    if args.no_reed:
        g.reed_volume = 0.0
    A = air(args.temp)
    print(f"# air T={A['T']:.1f} C  c={A['c']:.2f} m/s  rho={A['rho']:.4f}  bore end x={g.end_x:.4f} m  reed V={g.reed_volume*1e6:.2f} cm^3")

    if args.all:
        rows = fingering_table(g, A, args.alternates, with_mode=True)
        worst = {1: 0.0, 2: 0.0}
        if args.markdown:
            print("| written | sounding | reg | target Hz | TMM Hz | cents | mode | |Z| peak (MPa·s/m³) | keys |")
            print("|---|---|---|---|---|---|---|---|---|")
        else:
            print(f"{'written':<22}{'sound':<6}{'reg':>3} {'target':>9} {'tmm':>9} {'cents':>7} {'mode':>4} {'|Z|MOhm':>8} {'Zbelow':>7}  keys")
        for f, r in rows:
            reg = f["register"]
            if "(" not in f["note"]:
                worst[reg] = max(worst[reg], abs(r["cents"]))
            if args.markdown:
                print(f"| {f['note']} | {f['sounding_note']} | {reg} | {f['f_target']:.2f} | {r['f']:.2f} | {r['cents']:+.1f} | {r['mode']} | {r['mag']/1e6:.1f} | {' '.join(f['keys'])} |")
            else:
                print(f"{f['note']:<22}{f['sounding_note']:<6}{reg:>3} {f['f_target']:9.2f} {r['f']:9.2f} {r['cents']:+7.1f} {r['mode']:>4} {r['mag']/1e6:8.1f} {r['below_max']/1e6:7.1f}  {' '.join(f['keys'])}")
        print(f"# worst |cents|: register 1 = {worst[1]:.1f}, register 2 = {worst[2]:.1f}")
        return

    keys, target, reg, label = None, None, 1, ""
    if args.fingering:
        f = next((q for q in g.doc["fingerings"] if q["note"] == args.fingering), None)
        if f is None:
            sys.exit(f"unknown fingering {args.fingering}")
        keys, target, reg, label = f["keys"], f["f_target"], f["register"], f["note"]
    elif args.keys is not None:
        keys = [k for k in args.keys.split(",") if k]
        label = "custom"
    elif args.dump_impedance:
        f = next(q for q in g.doc["fingerings"] if q["note"] == args.dump_impedance[0])
        keys = f["keys"]
    else:
        ap.print_help(); return
    op = g.hole_openness(keys)
    fr = np.arange(20.0, args.fmax, 0.5)
    Z = input_impedance(g, fr, op, A)
    if args.dump_impedance:
        np.savetxt(args.dump_impedance[1], np.c_[fr, Z.real, Z.imag, np.abs(Z)], delimiter=",",
                   header="freq_hz,re_Z,im_Z,abs_Z (Pa s / m^3)", comments="")
        print("wrote", args.dump_impedance[1]); return
    print(f"# {label} keys: {' '.join(keys)}")
    print("# open holes: " + " ".join(h for h, v in op.items() if v > 0.5))
    pk = find_peaks(fr, Z)
    print(f"{'peak':>4} {'f (Hz)':>9} {'|Z| MPa s/m^3':>14} {'f/f1':>6}")
    for i, (f, m) in enumerate(pk[:12]):
        print(f"{i+1:>4} {f:9.2f} {m/1e6:14.2f} {f/pk[0][0]:6.3f}")
    if target:
        r = predict(g, keys, target, A, reg, coarse=True)
        print(f"# target {target:.2f} Hz; predicted {r['f']:.2f} Hz ({r['cents']:+.1f} cents), mode {r['mode']}")
    if args.plot:
        import matplotlib.pyplot as plt
        plt.semilogy(fr, np.abs(Z))
        plt.xlabel("f (Hz)"); plt.ylabel("|Z_in| (Pa s/m^3)"); plt.title(label)
        if target:
            for m in (1, 2, 3, 4):
                plt.axvline(target * m, color="r", alpha=0.3)
        plt.show()


if __name__ == "__main__":
    main()
