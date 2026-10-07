"""
Shared helpers for the M9 coaching study (docs/COACHING.md §Diagnosis & advice).

* Test set (protocol v1), control definitions and parameter ranges
* render(controls, note) -> mono float32 buffer (native renderer `render --out`)
* features(buffer, fs, target_hz) -> feature vector v1 via the ENGINE analyser
  (`render --analyze`, engine/src/analysis.rs — the single feature extractor of COACHING.md);
  render_features() uses `render ... --features --seed 1` (simulator level in dB re 1 Pa).
  (_py_features is the earlier Python prototype, kept only for reference.)
* colour(buffer, fs, room, mic) -> buffer: synthetic room impulse responses and mic/placement EQs
* robust(features_by_note) -> relative/robust feature vector (the robust_transform)
"""
import os, re, json, math, subprocess, tempfile, struct, wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RENDER = os.environ.get("SAX_RENDER", os.path.join(ROOT, "engine", "target", "release", "render"))
GEOM = os.path.join(ROOT, "data", "alto_sax.json")
FS = 48000

# ---------------------------------------------------------------- protocol v1
# (label, written note, dynamic 0..1, register group for tongue/jaw controls)
TEST_SET = [
    ("Bb3", "Bb3", 0.5, "low"), ("D4", "D4", 0.5, "low"), ("G4", "G4", 0.5, "low"),
    ("C5", "C5", 0.5, "low"), ("C#5", "C#5", 0.5, "low"), ("D5", "D5", 0.5, "mid"),
    ("G5", "G5", 0.5, "mid"), ("C6", "C6", 0.5, "mid"), ("F6", "F6", 0.5, "palm"),
    ("G4pp", "G4", 0.15, "low"), ("G4ff", "G4", 0.9, "low"),
]
# optional protocol extensions (identifiability study): label -> (written, dynamic, group, control offsets)
EXTRA = {
    "D5pp": ("D5", 0.15, "mid", {}), "D5ff": ("D5", 0.9, "mid", {}),
    "G4push": ("G4", 0.5, "low", {"mouthpiece_insertion": 5.0}),   # reference take: mouthpiece pushed in 5 mm
    "C6ff": ("C6", 0.9, "mid", {}),
}
for _lbl in [e for e in os.environ.get("COACH_EXTRA", "").split(",") if e]:
    _w, _d, _g, _o = EXTRA[_lbl]
    TEST_SET.append((_lbl, _w, _d, _g))
OFFSETS = {k: v[3] for k, v in EXTRA.items()}
NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]


def written_to_hz(note, a4=440.0):
    m = 12 * (int(note[-1]) + 1) + NOTE_NAMES.index(note[:-1]) - 9
    return a4 * 2 ** ((m - 69) / 12)


# ---------------------------------------------------------------- controls
# global controls (name, lo, hi, default, finite-difference step)
GLOBAL = [
    ("lip_force", 0.3, 2.5, 1.0, 0.2),
    ("lip_position", 6.0, 20.0, 12.0, 1.5),
    ("lip_damping", 0.0, 1.0, 0.4, 0.15),
    ("mouthpiece_insertion", 0.0, 20.0, 10.0, 3.0),
    ("baffle_height", 0.0, 1.0, 0.3, 0.2),
    ("chamber_size", 0.0, 1.0, 0.5, 0.2),
    ("tip_opening", 1.4, 2.6, 1.9, 0.2),
    ("reed_strength", 1.5, 4.5, 2.5, 0.5),
]
# per register group controls
GROUP = [("tongue_y", 0.0, 1.0, 0.4, 0.15), ("tongue_x", 0.0, 1.0, 0.5, 0.15), ("jaw_open", 0.0, 1.0, 0.3, 0.15)]
GROUPS = ["low", "mid", "palm"]
# per dynamic: lung pressure (kPa)
DYN = [("lung_pressure", 2.0, 7.0, 3.5, 0.4)]


def control_list():
    """Flat list of (key, param, lo, hi, default, step, scope) for all fitted controls."""
    out = []
    for n, lo, hi, d, s in GLOBAL:
        out.append((n, n, lo, hi, d, s, "global"))
    for g in GROUPS:
        for n, lo, hi, d, s in GROUP:
            out.append((f"{n}@{g}", n, lo, hi, d, s, g))
    out.append(("lung_pressure", "lung_pressure", 2.0, 7.0, 3.5, 0.4, "dyn"))
    return out


def default_controls():
    return {k: d for k, _, _, _, d, _, _ in control_list()}


def note_params(controls, label):
    """Engine params for one test note from the control dict."""
    _, written, dyn, group = next(t for t in TEST_SET if t[0] == label)
    p = {}
    for n, *_ in GLOBAL:
        p[n] = controls[n]
    for n, *_ in GROUP:
        p[n] = controls[f"{n}@{group}"]
    for k, dv in OFFSETS.get(label, {}).items():
        p[k] = p[k] + dv
    p["dynamic"] = dyn
    p["player_assist"] = 0.5
    p["oversample"] = int(os.environ.get("COACH_OS", "2"))
    return written, p, controls["lung_pressure"]


# ---------------------------------------------------------------- rendering
def render_features(controls, label, seconds=2.0, keep_audio=True):
    """Render one test note; returns (audio, feature vector from `render --features`)."""
    written, p, kpa = note_params(controls, label)
    fd, path = tempfile.mkstemp(suffix=".wav", prefix="coach_")
    os.close(fd)
    cmd = [RENDER, "--fingering", written, "--pressure", f"{kpa:.4f}", "--seconds", str(seconds),
           "--tongue-release", "0.05", "--geometry", GEOM, "--out", path, "--features", "--seed", "1"]
    for k, v in p.items():
        cmd += ["--set", f"{k}={v}"]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    js = json.loads(out[out.index("{"):])
    x = read_wav(path) if keep_audio else None
    os.unlink(path)
    return x, np.array(js["vector"], dtype=float)


def render(controls, label, seconds=2.0):
    return render_features(controls, label, seconds)[0]


def write_wav(path, x, fs=FS):
    x = np.asarray(x, dtype="<f4")
    with open(path, "wb") as f:
        n = len(x) * 4
        f.write(b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 3, 1, fs, fs * 4, 4, 32))
        f.write(b"data" + struct.pack("<I", n) + x.tobytes())


def features(x, fs, target_hz):
    """Engine analyser (`render --analyze`) on a buffer."""
    fd, path = tempfile.mkstemp(suffix=".wav", prefix="coach_an_")
    os.close(fd)
    write_wav(path, x, fs)
    out = subprocess.run([RENDER, "--analyze", path, "--target", f"{target_hz:.4f}"], capture_output=True, text=True, check=True).stdout
    os.unlink(path)
    js = json.loads(out[out.index("{"):])
    if "notes" in js:   # auto-segmented form: take the longest segment
        if not js["notes"]:
            v = np.zeros(len(FEATURES)); v[FEATURES.index("subharm")] = -120.0
            return v
        js = max(js["notes"], key=lambda n: n.get("segment", [0, 0])[1] - n.get("segment", [0, 0])[0])
    return np.array(js["vector"], dtype=float)


def read_wav(path):
    with open(path, "rb") as f:
        data = f.read()
    pos, ch, bits = 12, 1, 32
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            ch = struct.unpack("<H", body[2:4])[0]; bits = struct.unpack("<H", body[14:16])[0]
        elif cid == b"data":
            return np.frombuffer(body, dtype="<f4" if bits == 32 else "<i2").astype(float).reshape(-1, ch)[:, 0]
        pos += 8 + size + (size & 1)
    raise ValueError("no data")


# ---------------------------------------------------------------- features v1 (prototype)
FEATURES = ["f0", "cents", "pitch_std", "vib_rate", "vib_depth", "level", "centroid_rel"] + \
           [f"H{k}" for k in range(1, 11)] + ["odd_even", "tilt", "hnr", "edge", "attack", "scoop", "subharm", "regime", "valid"]


def _py_f0_track(x, fs, fmin=100, fmax=1600, hop=0.01, win=0.04):
    n = int(win * fs); h = int(hop * fs)
    out = []
    for i in range(0, len(x) - n, h):
        seg = x[i:i + n] - np.mean(x[i:i + n])
        if np.max(np.abs(seg)) < 1e-6:
            out.append(0.0); continue
        r = np.fft.irfft(np.abs(np.fft.rfft(seg * np.hanning(n), 2 * n)) ** 2)[:n]
        r /= r[0]
        lo, hi = int(fs / fmax), int(fs / fmin)
        seg_r = r[lo:hi]
        if len(seg_r) < 3 or seg_r.max() < 0.3:
            out.append(0.0); continue
        g = seg_r.max(); k = None
        for j in range(1, len(seg_r) - 1):
            if seg_r[j] >= 0.85 * g and seg_r[j] >= seg_r[j - 1] and seg_r[j] >= seg_r[j + 1]:
                k = j; break
        k = lo + (k if k is not None else int(np.argmax(seg_r)))
        y0, y1, y2 = r[k - 1], r[k], r[k + 1]
        den = y0 - 2 * y1 + y2
        d = 0.5 * (y0 - y2) / den if den != 0 else 0.0
        out.append(fs / (k + d))
    return np.array(out)


def _py_features(x, fs, target_hz):
    v = np.zeros(len(FEATURES))
    v[FEATURES.index("subharm")] = -120.0
    env = np.sqrt(np.convolve(x * x, np.ones(int(0.01 * fs)) / int(0.01 * fs), mode="same"))
    if env.max() <= 1e-9:
        return v
    steady_lvl = np.median(env[int(0.6 * len(x)):])
    on = np.argmax(env > 0.1 * steady_lvl) if steady_lvl > 0 else 0
    t90 = np.argmax(env > 0.9 * steady_lvl) if steady_lvl > 0 else 0
    s0 = max(on + int(0.25 * fs), int(0.4 * len(x)))
    st = x[s0:]
    tr = _py_f0_track(st, fs)
    good = tr[tr > 0]
    if len(good) < 5:
        return v
    f0 = float(np.median(good))
    v[0] = f0
    v[1] = 1200 * math.log2(f0 / target_hz)
    v[2] = float(np.std(1200 * np.log2(good / f0)))
    v[5] = 20 * math.log10(np.sqrt(np.mean(st ** 2)) + 1e-12)
    # harmonic analysis on a Hann-windowed steady block
    n = len(st)
    X = np.abs(np.fft.rfft(st * np.hanning(n)))
    fr = np.fft.rfftfreq(n, 1 / fs)
    H = []
    for k in range(1, 11):
        band = (fr > (k - 0.25) * f0) & (fr < (k + 0.25) * f0)
        H.append(X[band].max() if band.any() and k * f0 < fs / 2 else 1e-12)
    H = np.array(H)
    HdB = 20 * np.log10(np.maximum(H, 1e-12) / H[0])
    v[7:17] = HdB
    v[17] = float(np.mean(HdB[[2, 4, 6, 8]]) - np.mean(HdB[[1, 3, 5, 7, 9]]))
    v[18] = float(np.polyfit(np.log2(np.arange(1, 11)), HdB, 1)[0])
    P = X ** 2
    m8 = fr < 8000
    v[6] = float(np.sum(fr[m8] * P[m8]) / np.sum(P[m8]) / f0)
    harm = np.zeros_like(fr, dtype=bool)
    for k in range(1, int(8000 / f0) + 1):
        harm |= np.abs(fr - k * f0) < 0.03 * f0 * 1.0 + 3
    v[19] = float(10 * np.log10(np.sum(P[m8 & harm]) / max(np.sum(P[m8 & ~harm]), 1e-30)))
    v[20] = float(10 * np.log10(np.sum(P[(fr > 2000) & (fr < 5000)]) / np.sum(P) + 1e-30))
    v[21] = 1000 * (t90 - on) / fs
    # scoop: first 100 ms after onset vs steady f0
    a0 = x[on:on + int(0.14 * fs)]
    tra = _py_f0_track(a0, fs, hop=0.01, win=0.03)
    tra = tra[tra > 0]
    v[22] = float(np.mean(1200 * np.log2(tra / f0))) if len(tra) else 0.0
    sub = (fr > 0.45 * f0) & (fr < 0.55 * f0)
    v[23] = float(20 * np.log10(X[sub].max() / H[0])) if sub.any() else -120.0
    ratio = f0 / target_hz
    v[24] = float(2 ** round(math.log2(ratio) * 2) / 2) if ratio > 0 else 0.0
    v[24] = round(ratio * 2) / 2 if 0.4 < ratio < 3.2 else ratio
    v[25] = 1.0
    return v


def note_features(controls, label):
    return render_features(controls, label)


# ---------------------------------------------------------------- room / mic colouration
def room_ir(rt60, fs=FS, early=6, seed=0, direct=1.0):
    """Synthetic RIR: direct path + `early` discrete reflections (2-25 ms) + exponentially decaying
    noise tail (RT60), tail starts at 10 ms."""
    rng = np.random.default_rng(seed)
    n = int(min(1.5 * rt60, 1.6) * fs)
    h = np.zeros(n)
    h[0] = direct
    for _ in range(early):
        d = int(rng.uniform(0.002, 0.025) * fs)
        h[d] += rng.uniform(-0.6, 0.6)
    t = np.arange(n) / fs
    tail = rng.standard_normal(n) * np.exp(-6.91 * t / rt60) * (t > 0.01)
    # diffuse/direct ratio grows with RT60 (typical 1 m distance)
    tail *= 0.12 * math.sqrt(rt60 / 0.5)
    return h + tail


def mic_eq(x, kind, fs=FS):
    """Mic/placement colouration (frequency-domain gains, smooth):
    bell_close: +6 dB 2-6 kHz presence, -3 dB below 200 Hz; m1: flat; off_axis: tilt -4 dB/oct above 1 kHz;
    phone: band-limited 150 Hz - 7 kHz with a 3 dB bump at 3 kHz."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / fs) + 1e-9
    if kind == "m1":
        g = np.ones_like(f)
    elif kind == "bell_close":
        g_db = 6 * np.exp(-0.5 * (np.log2(f / 3500) / 0.8) ** 2) - 3 / (1 + (f / 200) ** 2)
        g = 10 ** (g_db / 20)
    elif kind == "off_axis":
        g_db = -4 * np.maximum(np.log2(f / 1000), 0)
        g = 10 ** (g_db / 20)
    elif kind == "phone":
        g_db = 3 * np.exp(-0.5 * (np.log2(f / 3000) / 0.5) ** 2)
        g = 10 ** (g_db / 20) / np.sqrt(1 + (150 / f) ** 4) / np.sqrt(1 + (f / 7000) ** 8)
    else:
        raise ValueError(kind)
    return np.fft.irfft(X * g, len(x))


ROOMS = [("dry", 0.2), ("studio", 0.35), ("room", 0.6), ("hall", 1.0)]
MICS = ["m1", "bell_close", "off_axis", "phone"]


def colour(x, room_rt60, mic, seed=0, gain_db=0.0):
    y = np.convolve(x, room_ir(room_rt60, seed=seed))[: len(x)] if room_rt60 > 0 else x
    y = mic_eq(y, mic)
    return y * 10 ** (gain_db / 20)


# ---------------------------------------------------------------- robust transform
def robust_vector(feats):
    """feats: dict label -> raw feature vector. Returns (names, values) of the relative / robust
    features (docs/COACHING.md robust_transform):
      - cents (absolute) for every note
      - harmonic shape after removing the per-recording average harmonic spectrum (EQ estimate):
        H2..H6 per note minus the mean over the mf notes of the same register band, and tilt likewise
      - odd_even and edge as deviations from the recording mean
      - pp/ff deltas of G4: level, centroid_rel, tilt, H2..H4
      - pitch_std, hnr deviation from recording mean, regime, scoop
    """
    names, vals = [], []
    mf = [t[0] for t in TEST_SET if t[2] == 0.5]
    idx = {n: i for i, n in enumerate(FEATURES)}
    def g(lbl, n):
        return feats[lbl][idx[n]]
    for lbl, *_ in TEST_SET:
        names.append(f"cents@{lbl}"); vals.append(g(lbl, "cents"))
        names.append(f"regime@{lbl}"); vals.append(g(lbl, "regime"))
    mean_shape = {n: np.mean([g(l, n) for l in mf]) for n in ["H2", "H3", "H4", "H5", "H6", "tilt", "odd_even", "edge", "hnr", "centroid_rel"]}
    for lbl in mf:
        for n in ["H2", "H3", "H4", "H5", "H6", "tilt", "odd_even", "edge", "hnr"]:
            names.append(f"{n}_rel@{lbl}"); vals.append(g(lbl, n) - mean_shape[n])
        names.append(f"pitch_std@{lbl}"); vals.append(g(lbl, "pitch_std"))
        names.append(f"scoop@{lbl}"); vals.append(g(lbl, "scoop"))
    for n in ["tilt", "odd_even", "edge", "hnr", "centroid_rel"]:
        names.append(f"{n}_mean"); vals.append(mean_shape[n])
    for n in ["level", "centroid_rel", "tilt", "H2", "H3", "H4", "edge"]:
        names.append(f"{n}_ff-pp@G4"); vals.append(g("G4ff", n) - g("G4pp", n))
        names.append(f"{n}_mf-pp@G4"); vals.append(g("G4", n) - g("G4pp", n))
        if "D5pp" in feats and "D5ff" in feats:
            names.append(f"{n}_ff-pp@D5"); vals.append(g("D5ff", n) - g("D5pp", n))
        if "C6ff" in feats:
            names.append(f"{n}_ff-mf@C6"); vals.append(g("C6ff", n) - g("C6", n))
    if "G4push" in feats:
        names.append("cents_push-ref@G4"); vals.append(g("G4push", "cents") - g("G4", "cents"))
        names.append("cents_push@C6vsG4"); vals.append(g("C6", "cents") - g("G4", "cents"))
    return names, np.array(vals)
