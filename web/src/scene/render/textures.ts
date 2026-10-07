// Procedural textures generated at load (no downloaded assets). All tileable, small (≤ 512²), built
// once and cached. Data textures (no canvas) so generation is a tight typed-array loop (~5–20 ms each).
import * as THREE from 'three';

// ---- tileable value noise ------------------------------------------------------------------------
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** periodic value noise, period px × py lattice cells */
function vnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px;
  const y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** tileable fbm on [0,1)² → ~[0,1] */
function fbm(u: number, v: number, fx: number, fy: number, oct: number, seed: number): number {
  let s = 0, a = 0.5, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise(u * fx, v * fy, fx, fy, seed + o * 17);
    n += a;
    a *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return s / n;
}

/** tileable cellular (Worley F1) noise, `cells` per side */
function worley(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells, y = v * cells;
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells;
      const px = cx + hash(wx, wy, seed), py = cy + hash(wx, wy, seed + 7);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < best) best = d;
    }
  return Math.sqrt(best);
}

// ---- helpers -------------------------------------------------------------------------------------
function dataTex(data: Uint8Array, w: number, h: number, srgb: boolean, repeat = true): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** height field (Float32, w×h, tileable) → tangent-space normal map */
function heightToNormal(hgt: Float32Array, w: number, h: number, strength: number): THREE.DataTexture {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w, xr = (x + 1) % w, yu = (y - 1 + h) % h, yd = (y + 1) % h;
      const dx = (hgt[y * w + xr] - hgt[y * w + xl]) * strength;
      const dy = (hgt[yd * w + x] - hgt[yu * w + x]) * strength;
      const l = Math.hypot(dx, dy, 1);
      const k = (y * w + x) * 4;
      out[k] = ((-dx / l) * 0.5 + 0.5) * 255;
      out[k + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      out[k + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      out[k + 3] = 255;
    }
  return dataTex(out, w, h, false);
}

const cache = new Map<string, THREE.Texture>();
function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  let t = cache.get(key) as T | undefined;
  if (!t) {
    t = make();
    t.name = key;
    cache.set(key, t);
  }
  return t;
}

// ---- textures ------------------------------------------------------------------------------------
/** Fine polish / hairline scratches (anisotropic along texture U) + faint buffing swirls. */
export function brushedNormal(): THREE.DataTexture {
  return cached('brushedNormal', () => {
    const S = 512;
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        // hairlines: high frequency across (v), very low along (u)
        const lines = fbm(u, v, 3, 256, 2, 1) * 0.7 + fbm(u, v, 8, 128, 2, 5) * 0.3;
        const swirl = fbm(u, v, 16, 16, 3, 9);
        h[y * S + x] = lines * 0.8 + swirl * 0.35;
      }
    return heightToNormal(h, S, S, 6);
  });
}

/** Slow roughness variation (polish wear, handling): G channel, ~0.75…1.25 around 0.5-grey → multiplies roughness. */
export function brassRoughness(): THREE.DataTexture {
  return cached('brassRoughness', () => {
    const S = 256;
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const n = fbm(u, v, 4, 4, 4, 21);
        const fine = fbm(u, v, 3, 64, 2, 23);
        const r = 0.62 + 0.55 * n + 0.18 * fine;
        const k = (y * S + x) * 4;
        d[k] = 255;
        d[k + 1] = Math.min(255, r * 160);
        d[k + 2] = 255;
        d[k + 3] = 255;
      }
    return dataTex(d, S, S, false);
  });
}

/** Mother-of-pearl: layered nacre bands (colour) — subtle; the material's iridescence does the rest. */
export function nacre(): { map: THREE.DataTexture; thickness: THREE.DataTexture } {
  const map = cached('nacreMap', () => {
    const S = 256;
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const w = fbm(u, v, 3, 3, 4, 31);
        const band = 0.5 + 0.5 * Math.sin((w * 9 + u * 2) * Math.PI * 2);
        const k = (y * S + x) * 4;
        d[k] = 236 + band * 14;
        d[k + 1] = 230 + band * 12 + (1 - band) * 6;
        d[k + 2] = 222 + (1 - band) * 22;
        d[k + 3] = 255;
      }
    return dataTex(d, S, S, true);
  });
  const thickness = cached('nacreThickness', () => {
    const S = 128;
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const w = fbm(u, v, 3, 3, 4, 37);
        const g = 0.5 + 0.5 * Math.sin(w * 14);
        const k = (y * S + x) * 4;
        d[k] = d[k + 1] = d[k + 2] = g * 255;
        d[k + 3] = 255;
      }
    return dataTex(d, S, S, false);
  });
  return { map, thickness };
}

/** Kid-leather pad: soft grain (cellular) colour + normal. */
export function leather(): { map: THREE.DataTexture; normal: THREE.DataTexture } {
  const S = 256;
  const make = (): { map: THREE.DataTexture; normal: THREE.DataTexture } => {
    const h = new Float32Array(S * S);
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const c = worley(u, v, 24, 41);
        const f = fbm(u, v, 6, 6, 3, 43);
        h[y * S + x] = Math.min(1, c * 1.3) * 0.7 + f * 0.3;
        const k = (y * S + x) * 4;
        const t = 0.82 + 0.25 * f - 0.18 * (1 - Math.min(1, c * 1.6));
        d[k] = 176 * t; d[k + 1] = 130 * t; d[k + 2] = 92 * t; d[k + 3] = 255;
      }
    return { map: dataTex(d, S, S, true), normal: heightToNormal(h, S, S, 2.5) };
  };
  const m = cached('leatherMap', () => { const r = make(); cache.set('leatherNormal', r.normal); return r.map; });
  return { map: m, normal: cache.get('leatherNormal') as THREE.DataTexture };
}

/** Natural cork: speckled granules. */
export function cork(): { map: THREE.DataTexture; normal: THREE.DataTexture } {
  const S = 256;
  const m = cached('corkMap', () => {
    const h = new Float32Array(S * S);
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const c = worley(u, v, 40, 51);
        const f = fbm(u, v, 12, 12, 3, 53);
        const pit = c < 0.18 ? 0.55 : 1;
        h[y * S + x] = Math.min(1, c * 1.5) * 0.6 + f * 0.4;
        const t = (0.75 + 0.45 * f) * pit;
        const k = (y * S + x) * 4;
        d[k] = Math.min(255, 168 * t); d[k + 1] = Math.min(255, 124 * t); d[k + 2] = Math.min(255, 80 * t); d[k + 3] = 255;
      }
    cache.set('corkNormal', heightToNormal(h, S, S, 3));
    return dataTex(d, S, S, true);
  });
  return { map: m, normal: cache.get('corkNormal') as THREE.DataTexture };
}

/**
 * Cane reed (U = along the reed tip→heel, V = across): parallel fibres, the thin translucent vamp
 * lighter, the bark at the heel darker/greener.
 */
export function reed(): { map: THREE.DataTexture; normal: THREE.DataTexture } {
  const W = 256, H = 64;
  const m = cached('reedMap', () => {
    const h = new Float32Array(W * H);
    const d = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const fib = fbm(u, v, 2, 48, 3, 61) * 0.7 + fbm(u, v, 1, 160, 1, 63) * 0.3;
        h[y * W + x] = fib;
        const vamp = 1 - Math.min(1, Math.max(0, (u - 0.5) / 0.15)); // 1 on the vamp (tip side)
        const bark = Math.min(1, Math.max(0, (u - 0.88) / 0.05));
        let r = 226 + 18 * vamp + (fib - 0.5) * 50, g = 196 + 22 * vamp + (fib - 0.5) * 44, b = 120 + 35 * vamp + (fib - 0.5) * 30;
        r = r * (1 - bark) + 168 * bark; g = g * (1 - bark) + 140 * bark; b = b * (1 - bark) + 62 * bark;
        const k = (y * W + x) * 4;
        d[k] = Math.max(0, Math.min(255, r)); d[k + 1] = Math.max(0, Math.min(255, g)); d[k + 2] = Math.max(0, Math.min(255, b)); d[k + 3] = 255;
      }
    cache.set('reedNormal', heightToNormal(h, W, H, 2));
    return dataTex(d, W, H, true, false);
  });
  return { map: m, normal: cache.get('reedNormal') as THREE.DataTexture };
}

/** Very fine isotropic grain (ebonite / felt / tissue micro detail). */
export function fineGrainNormal(): THREE.DataTexture {
  return cached('fineGrain', () => {
    const S = 256;
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) h[y * S + x] = fbm(x / S, y / S, 32, 32, 3, 71);
    return heightToNormal(h, S, S, 2);
  });
}

/** Tongue papillae / moist tissue bumps. */
export function papillaeNormal(): THREE.DataTexture {
  return cached('papillae', () => {
    const S = 256;
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const c = worley(u, v, 28, 81);
        h[y * S + x] = Math.max(0, 1 - c * 2.2) * 0.8 + fbm(u, v, 8, 8, 2, 83) * 0.2;
      }
    return heightToNormal(h, S, S, 2.2);
  });
}

/** Soft round sprite for particles (premultiplied-style falloff). */
export function softDot(): THREE.DataTexture {
  return cached('softDot', () => {
    const S = 64;
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const r = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2) / (S / 2);
        const a = Math.max(0, 1 - r);
        const k = (y * S + x) * 4;
        d[k] = d[k + 1] = d[k + 2] = 255;
        d[k + 3] = Math.min(255, 255 * a * a * (1.4 - 0.4 * a));
      }
    const t = dataTex(d, S, S, false, false);
    return t;
  });
}

/** Screen backdrop: soft vignette gradient, dithered against banding. */
export function backdrop(top: THREE.ColorRepresentation, centre: THREE.ColorRepresentation, edge: THREE.ColorRepresentation): THREE.DataTexture {
  const W = 256, H = 256;
  const ct = new THREE.Color(top), cc = new THREE.Color(centre), ce = new THREE.Color(edge);
  // interpolate in sRGB (texture is tagged sRGB)
  const st = ct.clone().convertLinearToSRGB(), sc = cc.clone().convertLinearToSRGB(), se = ce.clone().convertLinearToSRGB();
  const d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1), v = 1 - y / (H - 1); // v=1 top
      const r = Math.min(1, Math.hypot((u - 0.52) * 1.25, (v - 0.5) * 1.1) / 0.85);
      const e = r * r * (3 - 2 * r);
      const vt = Math.max(0, v - 0.55) / 0.45;
      const k = (y * W + x) * 4;
      const dither = (hash(x, y, 91) - 0.5) * 1.6;
      for (let c = 0; c < 3; c++) {
        const cs = c === 0 ? 'r' : c === 1 ? 'g' : 'b';
        let val = sc[cs] + (se[cs] - sc[cs]) * e;
        val = val + (st[cs] - val) * vt * 0.35;
        d[k + c] = Math.max(0, Math.min(255, val * 255 + dither));
      }
      d[k + 3] = 255;
    }
  const t = dataTex(d, W, H, true, false);
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}
