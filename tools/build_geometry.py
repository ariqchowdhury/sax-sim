#!/usr/bin/env python3
"""
Build data/alto_sax.json from a compact set of design parameters.

    python3 tools/build_geometry.py            # write JSON with tuned hole table (tools/hole_table.json if present)
    python3 tools/build_geometry.py --initial  # ignore tuned table, use first-guess positions

The tuned tone-hole positions/radii live in tools/hole_table.json (written by tools/tune.py).
Everything else (bore, centreline, keys, linkages, fingerings) is defined here so there is
exactly one place to change the instrument design.

Coordinate conventions (also stored in meta.conventions):
  * x  = axial position along the bore centreline measured from the reed tip (m)
  * 3D = right-handed, +y up, sax standing vertically, bell opening toward +z, player (mouth) at -z.
         The whole centreline lies in the plane x=0 (neck, body, bow and bell are coplanar).
  * Tone-hole angle theta: local frame at centreline point: t = unit tangent (increasing x),
         X = (1,0,0) (normal to the instrument plane), n = t x X (in-plane normal).
         Outward hole direction  d(theta) = cos(theta)*n + sin(theta)*X.
         On the main (descending) body tube n = +z (toward bell tube), so
         theta=90 -> +x (pearl-key side), theta=270 -> -x (thumb side), theta=180 -> -z (back, toward player).
         On the mouthpiece, theta=180 points to the reed (table) side.
"""
import json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", "alto_sax.json")
HOLE_TABLE = os.path.join(HERE, "hole_table.json")

# ----------------------------------------------------------------------------------------
# Design parameters (metres)
# ----------------------------------------------------------------------------------------
P = dict(
    mp_len_air=0.075,       # reed tip -> neck tube end (air path) at default insertion 10 mm
    mp_len_physical=0.085,  # mouthpiece overall length
    neck_len=0.185,         # neck air path length (cork end -> body tenon)
    r_neck_in=0.0061,       # neck entry radius (ID 12.2 mm)
    r_body_in=0.01205,      # neck tenon / body entry radius (ID 24.1 mm)
    neck_power=1.0,         # neck taper shape (see r_neck)
    tan_cone=math.tan(math.radians(1.6)),   # main cone half-angle 1.6 deg
    body_len=0.770,         # body air path length incl. bow and bell (set by tuner for Bb3)
    bell_flare_len=0.20,    # length of flaring section before rim
    r_rim=0.0620,           # bell rim radius (rim ID ~124 mm)
    flare_power=3.2,
    reed_volume=1.08e-6,    # equivalent reed-compliance volume rho c^2 S_r^2 / k_r (m^3), see PHYSICS.md sec. 5
    reed_fr=2000.0,         # lipped reed resonance (Hz) used for the frequency dependence of the reed compliance
    mp_r_tip=0.0030, mp_r_baffle=0.0050, mp_r_chamber=0.0068, mp_r_throat=0.0055,
    # 3D layout
    neck_tail=0.050,        # straight vertical part of neck at the body end
    neck_bend_R=0.090, neck_bend_deg=60.0,
    mp_elev_deg=30.0,       # mouthpiece axis: from tip, pointing forward(+z) and down by 30 deg
    bow_R=0.040,            # bow centreline radius (tube axes 80 mm apart)
    bow_start_x=None,       # set from the tuned low-C pad position
    bell_visual_len=0.30,   # drawn (3D) length of the bell tube after the bow (acoustic length is shorter)
    bell_turn_R=0.160, bell_turn_deg=45.0,
    bell_straight=0.12,     # straight part of bell tube before it starts turning forward
)


def x_apex():
    """Apex of the main body cone (extrapolated)."""
    return x_body0() - P["r_body_in"] / P["tan_cone"]


def x_body0():
    return P["mp_len_air"] + P["neck_len"]


def x_end():
    return x_body0() + P["body_len"]


def r_cone(x):
    return (x - x_apex()) * P["tan_cone"]


def r_neck(x):
    """Neck bore: from r_neck_in at the cork end to r_body_in at the tenon, shape exponent neck_power
    (1 = straight cone; >1 = slower expansion near the mouthpiece, faster near the body)."""
    u = min(max((x - P["mp_len_air"]) / P["neck_len"], 0.0), 1.0)
    return P["r_neck_in"] + (P["r_body_in"] - P["r_neck_in"]) * u ** P["neck_power"]


def r_bore(x):
    """Equivalent-area radius of the full air column at axial x (= wall radius, except in the
    bell flare where the spherical-wavefront correction of r_wall_eq applies)."""
    rw = r_wall(x)
    if x <= x_end() - P["bell_flare_len"] or not P.get("spherical_bell", True):
        return rw
    h = 1e-4
    slope = (r_wall(min(x + h, x_end())) - r_wall(x - h)) / (min(x + h, x_end()) - (x - h))
    cth = 1.0 / math.sqrt(1.0 + slope * slope)
    # spherical cap through the wall circle, normal to the wall (Benade & Jansson 1974):
    # area 2 pi r^2/(1+cos th)  ->  equivalent radius r sqrt(2/(1+cos th))
    return rw * math.sqrt(2.0 / (1.0 + cth))


def r_wall(x):
    """Physical (wall) inner radius at axial x."""
    if x <= P["mp_len_air"]:
        prof = mouthpiece_profile()
        xs, rs = zip(*prof)
        return float(np.interp(x, xs, rs))
    if x <= x_body0():
        return r_neck(x)
    xe = x_end(); xf = xe - P["bell_flare_len"]
    r = r_cone(x)
    if x > xf:
        u = (x - xf) / P["bell_flare_len"]
        r_c_end = r_cone(xe)
        r += (P["r_rim"] - r_c_end) * u ** P["flare_power"]
    return r


def mouthpiece_profile():
    """Nominal classical alto mouthpiece, equivalent-area radius from the tip to the neck tube end.
    Smooth (cosine-blended) curve through control points: tip window, baffle, chamber, throat, shank.
    Chamber/baffle radii are design outputs of tools/design_octaves.py (octave-tuning criterion);
    the engine perturbs this nominal profile with params 13-17 (docs/PHYSICS.md section 7)."""
    L = P["mp_len_air"]
    rb, rc, rt = P["mp_r_baffle"], P["mp_r_chamber"], P["mp_r_throat"]
    ctrl = [(0.0, P["mp_r_tip"]), (0.012, rb), (0.026, 0.5 * (rb + rc)), (0.038, rc),
            (0.050, 0.5 * (rc + rt)), (0.056, rt), (0.063, rt), (L, P["r_neck_in"])]
    xs = sorted(set([round(v, 4) for v in np.arange(0.0, L, 0.003)] + [c[0] for c in ctrl]))
    out = []
    for x in xs:
        for (x0, r0), (x1, r1) in zip(ctrl[:-1], ctrl[1:]):
            if x0 <= x <= x1:
                u = (x - x0) / (x1 - x0)
                w = 0.5 - 0.5 * math.cos(math.pi * u)
                out.append((x, r0 + (r1 - r0) * w))
                break
    return out


def missing_cone_volume():
    """Volume of the cone that would continue the neck entry to an apex with the main-cone angle."""
    L = P["r_neck_in"] / P["tan_cone"]
    return math.pi * P["r_neck_in"] ** 2 * L / 3.0


def profile_volume(pts):
    v = 0.0
    for (x1, r1), (x2, r2) in zip(pts[:-1], pts[1:]):
        v += math.pi * (x2 - x1) * (r1 * r1 + r1 * r2 + r2 * r2) / 3.0
    return v


# ----------------------------------------------------------------------------------------
# 3D centreline (turtle in the y-z plane)
# ----------------------------------------------------------------------------------------
def build_centerline(ds=0.004):
    """Return list of (s, y, z, phi) samples from reed tip to bell rim. Direction d=(sin phi, cos phi) in (y,z)."""
    segs = []  # (length, turn_deg)  turn positive = toward +phi
    segs.append((P["mp_len_air"], 0.0))
    neck_arc = math.radians(P["neck_bend_deg"]) * P["neck_bend_R"]
    neck_straight = P["neck_len"] - neck_arc - P["neck_tail"]
    assert neck_straight > 0
    segs.append((neck_straight, 0.0))
    segs.append((neck_arc, -P["neck_bend_deg"]))
    segs.append((P["neck_tail"], 0.0))
    bow_len = math.pi * P["bow_R"]
    stretch = 1.0
    if P.get("bow_start_x"):
        # place the bow just below the low-C pad; the rest of the tube after the bow is the bell tube.
        # The acoustic bell tube is short (~0.17-0.2 m: the flare length is set acoustically), but a real
        # alto's bell section is ~0.30 m tall: draw it with a 3D length bell_visual_len while keeping the
        # acoustic coordinate (centerline_s) unchanged -> 3D arc length != x only on the bell tube.
        body_straight = P["bow_start_x"] - x_body0()
        rest = P["body_len"] - body_straight - bow_len
        stretch = max(1.0, P["bell_visual_len"] / rest)
        P["bell_straight"] = 0.55 * rest
        P["bell_turn_R"] = 0.45 * rest / math.radians(P["bell_turn_deg"])
    bell_arc = math.radians(P["bell_turn_deg"]) * P["bell_turn_R"]
    body_straight = P["body_len"] - bow_len - P["bell_straight"] - bell_arc
    assert body_straight > 0.2, body_straight
    segs = [(L, turn, 1.0) for (L, turn) in segs]
    segs.append((body_straight, 0.0, 1.0))
    segs.append((bow_len, 180.0, 1.0))
    segs.append((P["bell_straight"], 0.0, stretch))
    segs.append((bell_arc, -P["bell_turn_deg"], stretch))
    phi = math.radians(-P["mp_elev_deg"])
    y = z = s = 0.0
    out = [(0.0, 0.0, 0.0, phi)]
    for L, turn, st in segs:
        n = max(1, int(math.ceil(L * st / ds)))
        h = L / n
        h3 = h * st
        dphi = math.radians(turn) / n
        for _ in range(n):
            if dphi == 0.0:
                y += h3 * math.sin(phi); z += h3 * math.cos(phi)
            else:  # exact arc step
                R = h3 / dphi
                # exact chord of the arc, taken along the midpoint direction
                c = 2 * R * math.sin(dphi / 2)
                pm = phi + dphi / 2
                y += c * math.sin(pm); z += c * math.cos(pm)
                phi += dphi
            s += h
            out.append((s, y, z, phi))
    # translate: main body tube at z=0, lowest centreline point at y=0.035
    zb = out[[i for i, o in enumerate(out) if o[0] >= x_body0() + 0.05][0]][2]
    ymin = min(o[1] for o in out)
    return [(s, y - ymin + 0.035, z - zb, ph) for (s, y, z, ph) in out]


_CL = None


def cl_at(s):
    global _CL
    if _CL is None:
        _CL = build_centerline(0.001)
    S = np.array([c[0] for c in _CL])
    i = int(np.clip(np.searchsorted(S, s) - 1, 0, len(S) - 2))
    a = (s - S[i]) / (S[i + 1] - S[i])
    y = _CL[i][1] * (1 - a) + _CL[i + 1][1] * a
    z = _CL[i][2] * (1 - a) + _CL[i + 1][2] * a
    ph = _CL[i][3] * (1 - a) + _CL[i + 1][3] * a
    return np.array([0.0, y, z]), ph


def frame_at(s):
    p, ph = cl_at(s)
    t = np.array([0.0, math.sin(ph), math.cos(ph)])
    X = np.array([1.0, 0.0, 0.0])
    n = np.cross(t, X)
    return p, t, n, X


def surface_point(s, theta_deg, offset):
    p, t, n, X = frame_at(s)
    th = math.radians(theta_deg)
    d = math.cos(th) * n + math.sin(th) * X
    return p + d * (r_bore(s) + offset)


# ----------------------------------------------------------------------------------------
# Tone holes. vents = written note sounded (1st register) when this is the uppermost open hole.
# ----------------------------------------------------------------------------------------
# id, rest, radius, chimney, angle, vents(written), octave_vent, first-guess x
HOLES0 = [
    ("oct_neck",  "closed", 0.00140, 0.0040, 0,   None,  True,  0.150),
    ("oct_body",  "closed", 0.00150, 0.0035, 180, None,  True,  0.330),
    ("palm_F",    "closed", 0.00420, 0.0040, 130, "F6",  False, 0.330),
    ("high_Fs",   "closed", 0.00450, 0.0040, 40,  "F#6", False, 0.335),
    ("side_E",    "closed", 0.00480, 0.0040, 30,  "E6",  False, 0.345),
    ("palm_Eb",   "closed", 0.00480, 0.0040, 150, "Eb6", False, 0.355),
    ("palm_D",    "closed", 0.00500, 0.0040, 175, "D6",  False, 0.370),
    ("C",         "open",   0.00560, 0.0040, 110, "C#5", False, 0.390),
    ("side_C",    "closed", 0.00550, 0.0040, 15,  "C5",  False, 0.405),
    ("B",         "open",   0.00680, 0.0042, 90,  "C5",  False, 0.420),
    ("Bb_bis",    "open",   0.00450, 0.0040, 105, "B4",  False, 0.445),
    ("A",         "open",   0.00750, 0.0042, 90,  "Bb4", False, 0.470),
    ("G",         "open",   0.00800, 0.0045, 90,  "A4",  False, 0.500),
    ("Gs",        "closed", 0.00750, 0.0045, 140, "G#4", False, 0.530),
    ("Fs",        "open",   0.00850, 0.0045, 60,  "G4",  False, 0.560),
    ("F",         "open",   0.00950, 0.0050, 90,  "F#4", False, 0.590),
    ("E",         "open",   0.01050, 0.0050, 90,  "F4",  False, 0.625),
    ("D",         "open",   0.01150, 0.0055, 90,  "E4",  False, 0.665),
    ("low_Eb",    "closed", 0.01200, 0.0055, 40,  "Eb4", False, 0.710),
    ("low_C",     "open",   0.01350, 0.0060, 75,  "D4",  False, 0.750),
    ("low_Cs",    "closed", 0.01300, 0.0060, 120, "C#4", False, 0.800),
    ("low_B",     "open",   0.01500, 0.0065, 60,  "C4",  False, 0.860),
    ("low_Bb",    "open",   0.01600, 0.0065, 120, "B3",  False, 0.920),
]
# hole radius / local bore radius used by tools/tune.py (sax tone holes are nearly bore-sized)
DELTA = dict(oct_neck=None, oct_body=None, palm_F=0.70, high_Fs=0.70, side_E=0.62, palm_Eb=0.62, palm_D=0.62,
             C=0.50, side_C=0.48, B=0.72, Bb_bis=0.40, A=0.74, G=0.76, Gs=0.68, Fs=0.72, F=0.76, E=0.78,
             D=0.78, low_Eb=0.70, low_C=0.78, low_Cs=0.72, low_B=0.76, low_Bb=0.74)
MAX_HOLE_RADIUS = 0.0185


def pad_lift(radius, octave):
    if octave:
        return 0.0015
    # typical alto pad lift: ~ 0.3 x hole diameter + 1 mm (keeps h/b >~ 0.6 for small holes)
    return round(min(0.30 * 2 * radius + 0.001, 0.009), 4)


def load_hole_table():
    if "--initial" in sys.argv or not os.path.exists(HOLE_TABLE):
        return {}
    with open(HOLE_TABLE) as f:
        return json.load(f)


# ----------------------------------------------------------------------------------------
# Keys, linkages, fingerings
# ----------------------------------------------------------------------------------------
# id, label, hand, finger, kind, anchor hole (for 3D placement), theta, offset, d_s, actions
KEYS0 = [
    ("OCT",        "Octave key",          "L", 0, "octave",  "B",      270, 0.020, -0.02, []),
    ("LH_palm_F",  "Palm F",              "L", 0, "palm",    "palm_F", 135, 0.030, 0.00, [("palm_F", "open")]),
    ("LH_palm_Eb", "Palm Eb",             "L", 0, "palm",    "palm_Eb",135, 0.030, 0.00, [("palm_Eb", "open")]),
    ("LH_palm_D",  "Palm D",              "L", 0, "palm",    "palm_D", 135, 0.030, 0.00, [("palm_D", "open")]),
    ("LH_front_F", "Front F",             "L", 1, "spatula", "B",      90,  0.022, -0.030, [("palm_F", "open")]),
    ("LH1",        "B (LH1)",             "L", 1, "pearl",   "B",      90,  0.018, 0.00, [("B", "closed")]),
    ("BIS",        "Bis Bb",              "L", 1, "pearl",   "Bb_bis", 90,  0.016, 0.00, [("Bb_bis", "closed")]),
    ("LH2",        "A (LH2)",             "L", 2, "pearl",   "A",      90,  0.018, 0.00, [("A", "closed")]),
    ("LH3",        "G (LH3)",             "L", 3, "pearl",   "G",      90,  0.018, 0.00, [("G", "closed")]),
    ("LH_Gs",      "G# (LH pinky)",       "L", 4, "table",   "Gs",     125, 0.028, 0.03, [("Gs", "open")]),
    ("LH_Cs",      "Low C# (LH pinky)",   "L", 4, "table",   "Gs",     125, 0.030, 0.06, [("low_Cs", "open")]),
    ("LH_B",       "Low B (LH pinky)",    "L", 4, "table",   "Gs",     110, 0.030, 0.075, [("low_B", "closed")]),
    ("LH_Bb",      "Low Bb (LH pinky)",   "L", 4, "table",   "Gs",     140, 0.030, 0.075, [("low_Bb", "closed")]),
    ("RH_side_E",  "High E side",         "R", 0, "side",    "F",      35,  0.024, -0.03, [("side_E", "open")]),
    ("RH_side_C",  "Side C",              "R", 0, "side",    "F",      35,  0.024, -0.005, [("side_C", "open")]),
    ("RH_side_Bb", "Side Bb",             "R", 0, "side",    "F",      35,  0.024, 0.02, [("Bb_bis", "closed")]),
    ("RH_high_Fs", "High F#",             "R", 1, "spatula", "F",      60,  0.024, -0.035, [("high_Fs", "open")]),
    ("RH1",        "F (RH1)",             "R", 1, "pearl",   "F",      90,  0.018, 0.00, [("F", "closed")]),
    ("RH2",        "E (RH2)",             "R", 2, "pearl",   "E",      90,  0.018, 0.00, [("E", "closed")]),
    ("RH3",        "D (RH3)",             "R", 3, "pearl",   "D",      90,  0.018, 0.00, [("D", "closed")]),
    ("RH_Eb",      "Low Eb (RH pinky)",   "R", 4, "spatula", "low_Eb", 75,  0.028, -0.01, [("low_Eb", "open")]),
    ("RH_C",       "Low C (RH pinky)",    "R", 4, "spatula", "low_Eb", 95,  0.028, 0.01, [("low_C", "closed")]),
]

LINKAGES = [
    # --- upper stack
    dict(id="C_by_LH1_LH2", when_any=["LH1", "LH2"], hole="C", set="closed",
         note="High C# vent pad is closed by the B (LH1) and A (LH2) keys; open C#5 needs all LH keys up."),
    dict(id="bis_by_A", when_any=["LH2"], hole="Bb_bis", set="closed",
         note="Small Bb (bis) pad closes with the A key (A4 and below)."),
    dict(id="bis_by_RH_1and1", when_any=["RH1", "RH2"], hole="Bb_bis", set="closed",
         note="'1 and 1' Bb: F or E key bar closes the Bb pad (with LH1 gives Bb4)."),
    # --- F# pad (vents G4): closed by any RH stack key
    dict(id="Fs_by_RH", when_any=["RH1", "RH2", "RH3"], hole="Fs", set="closed",
         note="F# pad closed by RH1/RH2/RH3 bar (enables F#4 with RH2 or RH3)."),
    # --- articulated G#: RH stack keys or low C#/B/Bb force the G# pad shut even if G# key held
    dict(id="Gs_artic", when_any=["RH1", "RH2", "RH3", "LH_Cs", "LH_B", "LH_Bb"], hole="Gs", set="closed",
         note="Articulated G# (Selmer type): G# pad closes when any RH stack key or low C#/B/Bb is pressed."),
    # --- bell keys
    dict(id="lowC_by_bell", when_any=["LH_Cs", "LH_B", "LH_Bb"], hole="low_C", set="closed",
         note="Low C# / B / Bb keys also close the low-C pad."),
    dict(id="lowB_by_Bb", when_any=["LH_Bb"], hole="low_B", set="closed",
         note="Low Bb key also closes the low-B pad."),
    dict(id="lowCs_by_BBb", when_any=["LH_B", "LH_Bb"], hole="low_Cs", set="closed",
         note="Low B/Bb keep the C# pad closed (C#-B-Bb connection) even if the C# spatula is also pressed."),
    # --- automatic octave mechanism
    dict(id="oct_neck_open", when_all=["OCT"], unless_any=["LH3"], hole="oct_neck", set="open",
         note="Octave key with G key (LH3) up opens the neck vent (A5 and above)."),
    dict(id="oct_body_open", when_all=["OCT", "LH3"], hole="oct_body", set="open",
         note="Octave key with G key (LH3) down opens the body vent and the G-ring holds the neck pad shut (D5-G#5)."),
]

OCTAVE_LOGIC = ("Encoded entirely in `linkages` (rules oct_neck_open / oct_body_open): "
                "OCT pressed AND LH3 pressed -> oct_body open, oct_neck closed; "
                "OCT pressed AND LH3 up -> oct_neck open, oct_body closed; OCT up -> both closed (pad_rest). "
                "With fractional key values the same activation formula applies: a_neck = OCT*(1-LH3), a_body = min(OCT,LH3).")

FIRST = {  # written note -> keys (first register)
    "Bb3": ["LH1", "LH2", "LH3", "RH1", "RH2", "RH3", "LH_Bb"],
    "B3":  ["LH1", "LH2", "LH3", "RH1", "RH2", "RH3", "LH_B"],
    "C4":  ["LH1", "LH2", "LH3", "RH1", "RH2", "RH3", "RH_C"],
    "C#4": ["LH1", "LH2", "LH3", "RH1", "RH2", "RH3", "LH_Cs"],
    "D4":  ["LH1", "LH2", "LH3", "RH1", "RH2", "RH3"],
    "Eb4": ["LH1", "LH2", "LH3", "RH1", "RH2", "RH3", "RH_Eb"],
    "E4":  ["LH1", "LH2", "LH3", "RH1", "RH2"],
    "F4":  ["LH1", "LH2", "LH3", "RH1"],
    "F#4": ["LH1", "LH2", "LH3", "RH2"],
    "G4":  ["LH1", "LH2", "LH3"],
    "G#4": ["LH1", "LH2", "LH3", "LH_Gs"],
    "A4":  ["LH1", "LH2"],
    "Bb4": ["LH1", "BIS"],
    "B4":  ["LH1"],
    "C5":  ["LH2"],
    "C#5": [],
}
NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]


def note_midi(name):
    pc = name[:-1]; octv = int(name[-1])
    return 12 * (octv + 1) + NOTE_NAMES.index(pc)


def midi_name(m):
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def fingerings():
    out = []
    for n, k in FIRST.items():
        out.append((n, list(k), 1))
    for n, k in FIRST.items():
        m = note_midi(n) + 12
        if m < note_midi("D5"):
            continue
        out.append((midi_name(m), ["OCT"] + list(k), 2))
    palm = [("D6", ["LH_palm_D"]),
            ("Eb6", ["LH_palm_D", "LH_palm_Eb"]),
            ("E6", ["LH_palm_D", "LH_palm_Eb", "RH_side_E"]),
            ("F6", ["LH_palm_D", "LH_palm_Eb", "RH_side_E", "LH_palm_F"]),
            ("F#6", ["LH_palm_D", "LH_palm_Eb", "RH_side_E", "LH_palm_F", "RH_high_Fs"])]
    for n, k in palm:
        out.append((n, ["OCT"] + k, 2))
    res = []
    for n, k, reg in out:
        wm = note_midi(n)
        sm = wm - 9
        res.append(dict(note=n, written_midi=wm, sounding_midi=sm, sounding_note=midi_name(sm),
                        f_target=round(440.0 * 2 ** ((sm - 69) / 12), 3), register=reg, keys=k))
    return res


# Player presets read by the web app (`presets`: {name, description, params, blow}); measured with the
# engine (docs/VALIDATION.md). Altissimo is NOT included: no altissimo fingering sounds yet (VALIDATION.md).
PRESETS = [
    dict(name="Subtone", blow=2.8,
         description="Breathy, dark low-register sound: more mouthpiece in the mouth, loose and heavily damping lower lip, "
                     "open jaw and low tongue (large, lossy oral cavity), extra breath noise. Plays ~20 cents flat as on a real alto.",
         params=dict(lip_position=16, lip_force=0.6, lip_damping=0.8, jaw_open=0.6, tongue_y=0.3, tongue_x=0.6,
                     breath_noise=0.25, mouthpiece_insertion=16)),
    dict(name="Bright jazz", blow=5.0,
         description="Jazz set-up: wide tip opening (2.4 mm), high baffle, small chamber, light lip with little damping, "
                     "more air. Mouthpiece pulled out to compensate the set-up's sharpness.",
         params=dict(tip_opening=2.4, baffle_height=0.85, chamber_size=0.25, lip_force=0.8, lip_damping=0.25,
                     mouthpiece_insertion=0)),
    dict(name="High-register voicing (tract tuned)", blow=4.0,
         description="High, front tongue (tongue_y 1, tongue_x 0.1): a vocal-tract resonance of ~30-50 MPa s/m^3 near "
                     "0.9-1.1 kHz in series with the bore. Bends C#6/D6 down by 100+ cents and C#5 by ~50 cents; "
                     "does not yet unlock altissimo notes (see VALIDATION.md).",
         params=dict(tongue_y=1.0, tongue_x=0.1, jaw_open=0.25, lip_force=1.2)),
]

# Altissimo fingerings (common published alto charts: e.g. G6 = 8va + front F + B + G keys,
# A6 = 8va + A key + RH F key). The per-note vocal-tract setting that makes each one sound is found
# by tools/altissimo_tune.py (engine in the loop) and stored in hole_table.json["altissimo"].
ALTISSIMO = [
    dict(note="G6", name="altissimo G (8va, front F, LH1, LH3)", keys=["OCT", "LH_front_F", "LH1", "LH3"], register=3),
    dict(note="G#6", name="altissimo G# (8va, front F, LH1, LH3, G#)", keys=["OCT", "LH_front_F", "LH1", "LH3", "LH_Gs"], register=3),
    dict(note="A6", name="altissimo A (8va, LH2, RH1)", keys=["OCT", "LH2", "RH1"], register=3),
]

ALTERNATES = [
    dict(note="Bb4", name="side Bb", keys=["LH1", "RH_side_Bb"], register=1),
    dict(note="Bb4", name="1 and 1", keys=["LH1", "RH1"], register=1),
    dict(note="C5", name="side C", keys=["LH1", "RH_side_C"], register=1),
    dict(note="F#4", name="alt F# (RH3)", keys=["LH1", "LH2", "LH3", "RH3"], register=1),
]


# ----------------------------------------------------------------------------------------
def altissimo_entries(tbl):
    out = []
    info = (tbl or {}).get("altissimo", {})
    for a in ALTISSIMO:
        e = dict(a)
        m = note_midi(a["note"]) - 9
        e["f_target"] = round(440.0 * 2 ** ((m - 69) / 12), 3)
        n = info.get("notes", {}).get(a["note"])
        if n:
            e["tract"] = n["tract"]
            e["embouchure"] = info.get("embouchure")
        out.append(e)
    return out


def presets(tbl):
    out = list(PRESETS)
    info = (tbl or {}).get("altissimo")
    if info and "G#6" in info.get("notes", {}):
        params = dict(info["embouchure"])
        params.update(info["notes"]["G#6"]["tract"])
        out.append(dict(name="Altissimo", blow=4.5,
                        description=("Altissimo voicing: firm lip (1.8 N), a little less mouthpiece, low lip/reed damping, "
                                     "nearly closed glottis and a high front tongue that puts a strong vocal-tract resonance "
                                     "(~60-90 MPa s/m^3) near the note. Tract set for G#6; the per-note tongue settings for G6/G#6/A6 "
                                     "are in alternate_fingerings[].tract. Sounds from ~4 kPa; with a neutral tract the same "
                                     "fingerings play their low (bore) regime."),
                        params=params))
    return out


def build(tbl=None, write=True):
    if tbl is None:
        tbl = load_hole_table()
    if "params" in tbl:
        P.update(tbl["params"])
    global _CL
    _CL = None
    lowc = tbl.get("holes", {}).get("low_C", {}).get("x")
    P["bow_start_x"] = (lowc + 0.018) if lowc else None
    mp = mouthpiece_profile()
    xb0, xe = x_body0(), x_end()
    neck_x = np.linspace(P["mp_len_air"], xb0, 10)
    body_x = list(np.arange(xb0, xe - P["bell_flare_len"], 0.025)) + list(np.linspace(xe - P["bell_flare_len"], xe, 21))
    body_x = sorted(set(round(v, 5) for v in body_x))
    neck_prof = [[round(x, 5), round(r_bore(x), 6)] for x in neck_x]
    body_prof = [[round(x, 5), round(r_bore(x), 6)] for x in body_x]
    body_wall = [[round(x, 5), round(r_wall(x), 6)] for x in body_x]

    cl = build_centerline(0.004)
    def cl_slice(a, b):
        pts = [c for c in cl if a - 1e-9 <= c[0] <= b + 1e-9]
        return [[0.0, round(c[1], 5), round(c[2], 5)] for c in pts], [round(c[0], 5) for c in pts]
    mp_cl, mp_s = cl_slice(0.0, P["mp_len_air"])
    neck_cl, neck_s = cl_slice(P["mp_len_air"], xb0)
    body_cl, body_s = cl_slice(xb0, xe)

    holes = []
    for hid, rest, rad, chim, ang, vents, octv, x0 in HOLES0:
        t = tbl.get("holes", {}).get(hid, {})
        x = t.get("x", x0); rad = t.get("radius", rad); chim = t.get("chimney", chim)
        rb = r_bore(x)
        h = dict(id=hid, x=round(x, 5), radius=round(rad, 5), chimney=round(chim, 5),
                 pad_rest=rest, pad_open_height=pad_lift(rad, octv), angle_deg=ang,
                 octave_vent=octv, vents=vents, bore_radius=round(rb, 5),
                 position=[round(v, 5) for v in surface_point(x, ang, 0.0)])
        holes.append(h)
    hole_ids = {h["id"] for h in holes}
    hole_x = {h["id"]: h["x"] for h in holes}

    keys = []
    for kid, label, hand, finger, kind, anchor, th, off, ds, actions in KEYS0:
        s = hole_x[anchor] + ds
        pos = surface_point(s, th, off)
        for a in actions:
            assert a[0] in hole_ids, a
        keys.append(dict(id=kid, label=label, hand=hand, finger=finger, kind=kind,
                         position=[round(v, 4) for v in pos],
                         actions=[dict(hole=a[0], set=a[1]) for a in actions]))
    for L in LINKAGES:
        assert L["hole"] in hole_ids
    key_ids = [k["id"] for k in keys]
    for L in LINKAGES:
        for k in L.get("when_any", []) + L.get("when_all", []) + L.get("unless_any", []):
            assert k in key_ids, k

    fing = fingerings()
    for f in fing + ALTERNATES:
        for k in f["keys"]:
            assert k in key_ids, k
    if "predicted" in tbl:
        for f in fing:
            p = tbl["predicted"].get(f["note"])
            if p:
                f["f_tmm"] = p["f"]; f["cents_tmm"] = p["cents"]

    vmp = profile_volume(mp)
    doc = dict(
        meta=dict(
            name="Generic modern alto saxophone in Eb (Selmer Mark VI / Series II-like layout) + classical mouthpiece",
            version=2,
            generated_by="tools/build_geometry.py (hole positions tuned with tools/tune.py / tools/tmm.py)",
            units="SI (metres, radians unless *_deg)",
            transposition_semitones=-9,
            a4_hz=440.0,
            sources=[
                "Nederveen, C.J. (1998) Acoustical Aspects of Woodwind Instruments, 2nd ed. (cone/mouthpiece equivalence, tone-hole corrections, pad effect)",
                "Keefe, D.H. (1982, 1990) Theory of the single woodwind tone hole; Woodwind air column models, JASA 71, 88",
                "Dalmont, Nederveen, Dubos, Ollivier, Meserette, te Sligte (2002) Experimental determination of the equivalent circuit of an open side hole, JSV 251",
                "Lefebvre, A. & Scavone, G.P. (2012) Characterization of woodwind instrument toneholes with the finite element method, JASA 131",
                "Chen, J.-M., Smith, J., Wolfe, J. (2009) Saxophone acoustics: introducing a compendium of impedance and sound spectra, Acoustics Australia 37 (UNSW alto sax impedance data)",
                "Benade, A.H. (1976) Fundamentals of Musical Acoustics (cone apex/mouthpiece volume matching)",
                "Silva, Guillemain, Kergomard, Mallaroni, Norris (2009) Approximation formulae for the acoustic radiation impedance of a cylindrical pipe, JSV 322",
                "Norris & Sheng (1989) Acoustic radiation from a circular pipe with an infinite flange, JSV 135",
            ],
            notes=(
                "Dimensions are first-principles DESIGN estimates, not a measurement of a specific instrument. "
                f"Body: straight cone, half-angle {math.degrees(math.atan(P['tan_cone'])):.2f} deg (literature range for alto ~1.5-1.8 deg), "
                f"from r={P['r_body_in']*1e3:.2f} mm at the neck tenon to the start of the bell flare, flare to rim radius {P['r_rim']*1e3:.0f} mm. "
                f"Neck: {P['neck_len']*1e3:.0f} mm air path, r {P['r_neck_in']*1e3:.2f} -> {P['r_body_in']*1e3:.2f} mm, taper exponent {P['neck_power']:.2f}. "
                f"Mouthpiece: baffle r {P['mp_r_baffle']*1e3:.2f} mm, chamber r {P['mp_r_chamber']*1e3:.2f} mm, throat 11 mm; interior volume {vmp*1e6:.2f} cm^3 "
                f"(+ reed equivalent volume {P['reed_volume']*1e6:.2f} cm^3). "
                "Neck taper, neck entry radius, mouthpiece baffle/chamber radii and bell flare were chosen by "
                "tools/design_harmonicity.py (harmonic resonances of every register-1 fingering, Benade criterion); octave vents by "
                "engine scans; tone-hole radii follow bore-relative ratios typical of saxophones (uncertain ~+-15%); hole axial "
                "positions and the bell end were TUNED with the engine in the loop (tools/engine_loop.py: self-oscillating playing "
                "frequency at 3-4 kPa, equal temperament, 22 C), so they are model-consistent rather than measured. "
                "In the bell flare 'profile' is the spherical-wavefront equivalent radius; 'wall_profile' is the wall. Acoustic effects of bends (neck, bow) are ignored (x = arc length). The 3D bow is placed just below the "
                "low-C pad; low C# and low B pads sit on the bow, low Bb on the bell tube."
            ),
            conventions=dict(
                x="axial position (arc length) along bore centreline from reed tip, m",
                frame="right-handed; +y up; sax vertical; bell opens toward +z; player/mouth toward -z; centreline lies in plane x=0",
                angle_deg=("hole outward direction d = cos(th)*n + sin(th)*X, with t = unit tangent (increasing x), X=(1,0,0), n = t x X. "
                           "On the descending body tube n=+z: 90 = +x (pearl side), 180 = -z (back), 270 = -x (thumb side)."),
                centerline=("3D points [x,y,z] (m); the matching ACOUSTIC axial coordinate of each point is in the sibling array "
                            "centerline_s. Map acoustic x -> 3D by interpolating in centerline_s (not by 3D arc length): on the bell "
                            "tube after the bow the drawing is stretched (bell_visual_len) for a realistic shape."),
                hole_position="hole centre on the bore wall (3D), = centreline point + d*bore_radius",
                key_position="3D touch point for the finger",
                profile="[axial x, equivalent-area radius] pairs; linear interpolation of radius between samples",
            ),
            temperature_c=22.0,
            reed_equivalent_volume=P["reed_volume"],
            reed_resonance_hz=P["reed_fr"],
        ),
        mouthpiece=dict(
            length=P["mp_len_physical"], air_length=P["mp_len_air"],
            default_insertion=0.010,
            baffle_end=0.026, chamber_start=0.020, chamber_end=0.053, throat_x=0.0595,
            profile=[[round(x, 5), round(r, 6)] for x, r in mp],
            volume=round(vmp, 9),
            nominal=dict(tip_opening=0.0019, facing_length=0.022, baffle_height=0.3, chamber_size=0.5,
                         throat_diameter=0.011, window_length=0.030, window_width=0.0135,
                         table_to_tip=0.0, reed_side_angle_deg=180),
            reed=dict(length=0.068, width=0.017, vibrating_width=0.0135, tip_thickness=0.0001, heel_thickness=0.0028,
                      vamp_length=0.035, youngs_modulus=1.0e10, density=500.0),
            centerline=mp_cl, centerline_s=mp_s,
        ),
        neck=dict(x_start=P["mp_len_air"], x_end=round(xb0, 5), profile=neck_prof,
                  centerline=neck_cl, centerline_s=neck_s),
        body=dict(x_start=round(xb0, 5), x_end=round(xe, 5), profile=body_prof, wall_profile=body_wall,
                  centerline=body_cl, centerline_s=body_s,
                  bow=dict(x_start=round(xb0 + P["body_len"] - P["bell_straight"] - math.radians(P["bell_turn_deg"]) * P["bell_turn_R"] - math.pi * P["bow_R"], 5),
                           x_end=round(xb0 + P["body_len"] - P["bell_straight"] - math.radians(P["bell_turn_deg"]) * P["bell_turn_R"], 5),
                           centerline_radius=P["bow_R"]),
                  cone_half_angle_deg=round(math.degrees(math.atan(P["tan_cone"])), 3),
                  cone_apex_x=round(x_apex(), 5)),
        bell=dict(end_x=round(xe, 5), end_radius=P["r_rim"], flare_start_x=round(xe - P["bell_flare_len"], 5),
                  rim_center=[round(v, 4) for v in cl_at(xe)[0]],
                  rim_normal=[0.0, round(math.sin(cl_at(xe)[1]), 4), round(math.cos(cl_at(xe)[1]), 4)]),
        tone_holes=holes,
        keys=keys,
        linkages=LINKAGES,
        keywork_semantics=(
            "rules = [each key's actions, in key-array order, as {when_all:[key], hole, set}] ++ linkages (in order). "
            "state[h] = pad_rest(h) (open=1, closed=0). For each rule: a = min(min_{k in when_all} p_k, max_{k in when_any} p_k) "
            "(an empty list contributes 1 to that factor), a *= (1 - max_{k in unless_any} p_k) (empty -> 0); "
            "state[h] = state[h]*(1-a) + target*a, target = 1 for 'open', 0 for 'closed'. p_k in [0,1] is key press amount. "
            "Final state = pad openness target in [0,1]; pad height = openness * pad_open_height. See docs/PHYSICS.md section 'Keywork'."
        ),
        octave_logic=OCTAVE_LOGIC,
        fingerings=fing,
        alternate_fingerings=ALTERNATES + altissimo_entries(tbl),
        presets=presets(tbl),
    )
    if write:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w") as f:
            json.dump(doc, f, indent=1)
    return doc


if __name__ == "__main__":
    d = build()
    print(f"wrote {OUT}: {len(d['tone_holes'])} holes, {len(d['keys'])} keys, {len(d['fingerings'])} fingerings; "
          f"end x={d['bell']['end_x']:.4f}; mp vol {d['mouthpiece']['volume']*1e6:.2f} cm3, missing cone {missing_cone_volume()*1e6:.2f} cm3")
