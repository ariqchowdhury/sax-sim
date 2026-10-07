import sys, numpy as np, struct
def read(p):
    b = open(p, "rb").read(); i = 12; fs = 48000
    while i < len(b):
        cid = b[i:i+4]; n = struct.unpack("<I", b[i+4:i+8])[0]
        if cid == b"fmt ": fs = struct.unpack("<I", b[i+12:i+16])[0]
        if cid == b"data": return np.frombuffer(b[i+8:i+8+n], dtype=np.float32), fs
        i += 8 + n + (n & 1)
def lev(p, t0, t1):
    x, fs = read(p); s = x[int(t0*fs):int(t1*fs)]; return 20*np.log10(np.sqrt((s.astype(float)**2).mean()) + 1e-12)
if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(p.split("/")[-1], [round(lev(p, t, t+0.25), 1) for t in (0.2, 0.5, 1.0, 1.5, 2.5)])
