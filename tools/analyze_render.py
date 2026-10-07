#!/usr/bin/env python3
"""
Analyse an offline render of the engine (engine/src/bin/render.rs).

    python3 tools/analyze_render.py out.wav [--csv out.csv] [--note Bb3 | --target 138.59] [--plot]

Reports
  * f0 of the steady part (autocorrelation + parabolic refinement), cents vs target
    (target from --target Hz, or --note looked up in data/alto_sax.json fingerings)
  * spectral centroid (Hz) and the first 10 harmonic levels (dB re fundamental)
  * attack time: 10 % -> 90 % of the steady RMS envelope (ms), and onset time
  * from the CSV (columns t,out,p_lung,p_mouth,p_mouthpiece,reed_y,flow,f0_est):
      threshold pressure = lung (or mouth) pressure at which the mouthpiece AC pressure first
      exceeds 10 % of its final value (meaningful for a slow pressure ramp render),
      mean blowing pressure, mean flow, AC mouthpiece pressure, reed beating fraction.
numpy only (wav read with the stdlib `wave` module; 16/24/32-bit PCM or 32-bit float).
"""
import argparse, json, math, os, struct, sys, wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_wav(path):
    try:
        with wave.open(path, "rb") as w:
            n, sw, ch, fs = w.getnframes(), w.getsampwidth(), w.getnchannels(), w.getframerate()
            raw = w.readframes(n)
        if sw == 2:
            x = np.frombuffer(raw, dtype="<i2").astype(float) / 32768.0
        elif sw == 3:
            b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
            v = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
            v[v >= 1 << 23] -= 1 << 24
            x = v / float(1 << 23)
        elif sw == 4:
            x = np.frombuffer(raw, dtype="<i4").astype(float) / 2 ** 31
        else:
            raise ValueError(f"unsupported sample width {sw}")
        return x.reshape(-1, ch)[:, 0], fs
    except wave.Error:
        return read_wav_float(path)


def read_wav_float(path):
    """Minimal RIFF reader for IEEE float (format 3) files that `wave` rejects."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a WAV file")
    pos, fmt, ch, fs, bits = 12, None, 1, 48000, 32
    samples = None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt, ch, fs = struct.unpack("<HHI", body[:8]); bits = struct.unpack("<H", body[14:16])[0]
        elif cid == b"data":
            dt = "<f4" if bits == 32 else "<f8"
            samples = np.frombuffer(body, dtype=dt).astype(float)
        pos += 8 + size + (size & 1)
    if samples is None:
        raise ValueError("no data chunk")
    return samples.reshape(-1, ch)[:, 0], fs


def f0_autocorr(x, fs, fmin=100.0, fmax=1500.0):
    x = x - np.mean(x)
    n = len(x)
    if n < 64 or np.max(np.abs(x)) < 1e-9:
        return 0.0
    X = np.fft.rfft(x * np.hanning(n), 2 * n)
    r = np.fft.irfft(np.abs(X) ** 2)[:n]
    r /= r[0]
    lo, hi = int(fs / fmax), min(int(fs / fmin), n - 2)
    seg = r[lo:hi]
    if len(seg) < 3:
        return 0.0
    # first peak above 0.85*global max in range (avoids octave errors)
    gmax = seg.max()
    i = None
    for j in range(1, len(seg) - 1):
        if seg[j] >= 0.85 * gmax and seg[j] >= seg[j - 1] and seg[j] >= seg[j + 1]:
            i = j; break
    if i is None:
        i = int(np.argmax(seg))
    k = lo + i
    y0, y1, y2 = r[k - 1], r[k], r[k + 1]
    d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) if (y0 - 2 * y1 + y2) != 0 else 0.0
    return fs / (k + d)


def harmonics(x, fs, f0, nh=10):
    n = len(x)
    w = np.hanning(n)
    X = np.abs(np.fft.rfft((x - x.mean()) * w))
    fr = np.fft.rfftfreq(n, 1 / fs)
    lv = []
    for h in range(1, nh + 1):
        band = (fr > (h - 0.3) * f0) & (fr < (h + 0.3) * f0)
        lv.append(X[band].max() if band.any() else 0.0)
    lv = np.array(lv)
    ref = lv[0] if lv[0] > 0 else 1.0
    centroid = float(np.sum(fr * X) / np.sum(X)) if np.sum(X) > 0 else 0.0
    return 20 * np.log10(np.maximum(lv, 1e-12) / ref), centroid


def envelope(x, fs, win_ms=10.0):
    w = max(1, int(fs * win_ms / 1000))
    e = np.sqrt(np.convolve(x * x, np.ones(w) / w, mode="same"))
    return e


def target_for(note):
    with open(os.path.join(ROOT, "data", "alto_sax.json")) as f:
        d = json.load(f)
    for q in d["fingerings"]:
        if q["note"] == note:
            return q["f_target"]
    raise SystemExit(f"note {note} not in fingerings")


def load_csv(path):
    with open(path) as f:
        hdr = f.readline().strip().split(",")
    arr = np.loadtxt(path, delimiter=",", skiprows=1, ndmin=2)
    return {h: arr[:, i] for i, h in enumerate(hdr)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wav")
    ap.add_argument("--csv")
    ap.add_argument("--note")
    ap.add_argument("--target", type=float)
    ap.add_argument("--steady", type=float, default=0.5, help="analyse the last N seconds as steady state")
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--json", action="store_true", help="print results as JSON")
    a = ap.parse_args()

    x, fs = read_wav(a.wav)
    target = a.target or (target_for(a.note) if a.note else None)
    res = dict(file=a.wav, fs=fs, duration_s=len(x) / fs)
    ns = int(min(a.steady, len(x) / fs * 0.5) * fs)
    tail = x[-ns:]
    f0 = f0_autocorr(tail, fs)
    res["f0_hz"] = round(f0, 3)
    if target and f0 > 0:
        res["target_hz"] = target
        res["cents"] = round(1200 * math.log2(f0 / target), 2)
    if f0 > 0:
        h, cen = harmonics(tail, fs, f0)
        res["spectral_centroid_hz"] = round(cen, 1)
        res["harmonics_db"] = [round(float(v), 1) for v in h]
    env = envelope(x, fs)
    steady = float(np.median(env[-ns:])) if ns > 0 else 0.0
    res["steady_rms"] = steady
    if steady > 0:
        i10 = np.argmax(env >= 0.1 * steady); i90 = np.argmax(env >= 0.9 * steady)
        res["onset_ms"] = round(1000 * i10 / fs, 2)
        res["attack_10_90_ms"] = round(1000 * (i90 - i10) / fs, 2)

    if a.csv:
        c = load_csv(a.csv)
        t = c.get("t")
        pm = c.get("p_mouthpiece")
        if t is not None and pm is not None and len(t) > 10:
            fsc = 1.0 / np.median(np.diff(t))
            # AC envelope of mouthpiece pressure: remove running mean (~20 ms)
            w = max(1, int(0.02 * fsc))
            mean = np.convolve(pm, np.ones(w) / w, mode="same")
            ac = envelope(pm - mean, fsc, 20.0)
            final = float(np.median(ac[-max(1, int(0.2 * fsc)):]))
            res["p_mouthpiece_ac_rms_pa"] = round(final, 1)
            if final > 0:
                k = int(np.argmax(ac > 0.1 * final))
                for src in ("p_lung", "p_mouth"):
                    if src in c:
                        res[f"threshold_{src}_pa"] = round(float(c[src][k]), 1)
                res["threshold_time_s"] = round(float(t[k]), 4)
            tail_c = slice(-max(1, int(a.steady * fsc)), None)
            for src in ("p_lung", "p_mouth", "flow"):
                if src in c:
                    res[f"mean_{src}"] = float(np.mean(c[src][tail_c]))
            if "reed_y" in c:
                y = c["reed_y"][tail_c]
                res["reed_y_min_max_m"] = [float(y.min()), float(y.max())]
    if a.json:
        print(json.dumps(res, indent=1))
    else:
        for k, v in res.items():
            print(f"{k:28s} {v}")
    if a.plot:
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(2, 1, figsize=(10, 6))
        tt = np.arange(len(x)) / fs
        ax[0].plot(tt, x, lw=0.5); ax[0].plot(tt, env, "r"); ax[0].set_xlabel("t (s)")
        X = np.abs(np.fft.rfft(tail * np.hanning(len(tail))))
        ax[1].semilogy(np.fft.rfftfreq(len(tail), 1 / fs), X); ax[1].set_xlim(0, 6000); ax[1].set_xlabel("Hz")
        plt.tight_layout(); plt.show()


if __name__ == "__main__":
    main()
