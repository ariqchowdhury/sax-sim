// Choice between the two engine builds (engine/build_wasm.sh):
//   engine.wasm          wasm SIMD128 — runs everywhere the app runs
//   engine_relaxed.wasm  + relaxed SIMD (fused multiply-add in the bore kernel, ~8 % faster)
// Relaxed SIMD is detected by validating a tiny module that uses f32x4.relaxed_madd; any failure
// (no support, file missing, invalid bytes) falls back to the baseline build.

/** (func (result v128) v128.const 0 ×3  f32x4.relaxed_madd) */
const RELAXED_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, // type: () -> v128
  0x03, 0x02, 0x01, 0x00, // func 0 : type 0
  0x0a, 0x3d, 0x01, 0x3b, 0x00, // code: 1 body, 59 bytes, no locals
  0xfd, 0x0c, ...new Array(16).fill(0),
  0xfd, 0x0c, ...new Array(16).fill(0),
  0xfd, 0x0c, ...new Array(16).fill(0),
  0xfd, 0x85, 0x02, // f32x4.relaxed_madd (0xfd 0x105)
  0x0b, // end
]);

let relaxed: boolean | null = null;

export function relaxedSimdSupported(): boolean {
  if (relaxed === null) {
    try {
      relaxed = typeof WebAssembly === 'object' && WebAssembly.validate(RELAXED_PROBE);
    } catch {
      relaxed = false;
    }
  }
  return relaxed;
}

/** URL of the relaxed-SIMD sibling of an engine.wasm URL (null if the URL isn't engine.wasm). */
export function relaxedUrl(url: string): string | null {
  return /engine\.wasm(\?.*)?$/.test(url) ? url.replace(/engine\.wasm(\?.*)?$/, 'engine_relaxed.wasm$1') : null;
}

function isWasm(buf: ArrayBuffer): boolean {
  const h = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  // (Vite's SPA fallback can answer 200 with index.html)
  return h.length === 4 && h[0] === 0x00 && h[1] === 0x61 && h[2] === 0x73 && h[3] === 0x6d;
}

async function fetchOne(url: string, init?: RequestInit): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return isWasm(buf) && WebAssembly.validate(buf) ? buf : null;
  } catch {
    return null;
  }
}

export interface EngineBytes {
  bytes: ArrayBuffer;
  url: string;
  relaxed: boolean;
}

/** Fetch the fastest engine build this runtime can run; null if no build is available. */
export async function fetchEngineWasm(url: string, init?: RequestInit): Promise<EngineBytes | null> {
  const r = relaxedSimdSupported() ? relaxedUrl(url) : null;
  if (r) {
    const b = await fetchOne(r, init);
    if (b) return { bytes: b, url: r, relaxed: true };
  }
  const b = await fetchOne(url, init);
  return b ? { bytes: b, url, relaxed: false } : null;
}
