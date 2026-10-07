// Maps bore coordinate x (metres from reed tip, = arc length) → 3D position + orthonormal frame.
// Uses the centerline / centerline_s arrays of mouthpiece, neck and body (data meta.conventions).
// Frame per data convention: t = tangent (increasing x), X = (1,0,0), n = t × X; a hole at angle θ
// points along d = cos θ·n + sin θ·X.  Here `nrm` = n and `bin` = X (re-orthogonalised).
import * as THREE from 'three';
import type { SaxGeometry, Vec2, Vec3 } from './geometry';

const WORLD_X = new THREE.Vector3(1, 0, 0);

export class BorePath {
  /** bore x at each sample */
  readonly xs: Float64Array;
  readonly pos: THREE.Vector3[] = [];
  readonly tan: THREE.Vector3[] = [];
  readonly nrm: THREE.Vector3[] = [];
  readonly bin: THREE.Vector3[] = [];
  readonly xStart: number;
  readonly xEnd: number;
  readonly xNeck: number;
  readonly xBody: number;
  private profile: Vec2[];

  constructor(g: SaxGeometry) {
    const neckP = g.neck.profile, bodyP = g.body.profile;
    this.xNeck = (g.neck.x_start as number | undefined) ?? neckP[0][0];
    this.xBody = (g.body.x_start as number | undefined) ?? bodyP[0][0];
    this.xStart = 0;
    this.xEnd = Math.max(bodyP[bodyP.length - 1][0], g.bell?.end_x ?? 0);
    this.profile = mergeProfiles([g.mouthpiece.profile, neckP, bodyP]);

    const xs: number[] = [];
    const pts: THREE.Vector3[] = [];
    const neck = g.neck.centerline.map(v3);
    const push = (cl: THREE.Vector3[], s: number[] | undefined, x0: number, x1: number): void => {
      const sx = s && s.length === cl.length ? s : arcParam(cl, x0, x1);
      for (let i = 0; i < cl.length; i++) {
        if (xs.length && sx[i] <= xs[xs.length - 1] + 1e-9) continue; // skip duplicate joints
        xs.push(sx[i]);
        pts.push(cl[i]);
      }
    };
    if (g.mouthpiece.centerline && g.mouthpiece.centerline.length >= 2) {
      push(g.mouthpiece.centerline.map(v3), g.mouthpiece.centerline_s, 0, this.xNeck);
    } else {
      const t0 = neck[1].clone().sub(neck[0]).normalize();
      push([neck[0].clone().addScaledVector(t0, -this.xNeck), neck[0].clone()], [0, this.xNeck], 0, this.xNeck);
    }
    push(neck, g.neck.centerline_s, this.xNeck, this.xBody);
    push(g.body.centerline.map(v3), g.body.centerline_s, this.xBody, this.xEnd);

    // resample uniformly in x for O(1) lookup
    const N = 800;
    this.xs = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const x = this.xStart + ((this.xEnd - this.xStart) * i) / (N - 1);
      while (j < xs.length - 2 && xs[j + 1] < x) j++;
      const a = xs[j], b = xs[j + 1];
      const t = b > a ? Math.min(1, Math.max(0, (x - a) / (b - a))) : 0;
      this.xs[i] = x;
      this.pos.push(pts[j].clone().lerp(pts[j + 1], t));
    }
    for (let i = 0; i < N; i++) {
      const a = this.pos[Math.max(0, i - 1)], b = this.pos[Math.min(N - 1, i + 1)];
      this.tan.push(b.clone().sub(a).normalize());
    }
    let prevN = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < N; i++) {
      const t = this.tan[i];
      let n = new THREE.Vector3().crossVectors(t, WORLD_X);
      if (n.lengthSq() < 1e-4) n = prevN.clone().addScaledVector(t, -prevN.dot(t));
      n.normalize();
      prevN = n;
      this.nrm.push(n);
      this.bin.push(new THREE.Vector3().crossVectors(n, t).normalize()); // = X when t ⟂ X
    }
  }

  private _i = 0;
  private _f = 0;
  private index(x: number): void {
    const N = this.xs.length;
    const f = ((x - this.xStart) / (this.xEnd - this.xStart)) * (N - 1);
    const i = Math.max(0, Math.min(N - 2, Math.floor(f)));
    this._i = i;
    this._f = Math.max(0, Math.min(1, f - i));
  }

  pointAt(x: number, out: THREE.Vector3): THREE.Vector3 {
    this.index(x);
    const i = this._i, t = this._f;
    return out.copy(this.pos[i]).lerp(this.pos[i + 1], t);
  }

  frameAt(x: number, pos: THREE.Vector3, tan: THREE.Vector3, nrm: THREE.Vector3, bin: THREE.Vector3): void {
    this.index(x);
    const i = this._i, t = this._f;
    pos.copy(this.pos[i]).lerp(this.pos[i + 1], t);
    tan.copy(this.tan[i]).lerp(this.tan[i + 1], t).normalize();
    nrm.copy(this.nrm[i]).lerp(this.nrm[i + 1], t);
    nrm.addScaledVector(tan, -nrm.dot(tan)).normalize();
    bin.crossVectors(nrm, tan).normalize();
  }

  radiusAt(x: number): number {
    return interp(this.profile, x);
  }

  /** nearest bore x to a world point (coarse) */
  nearestX(p: THREE.Vector3): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.pos.length; i++) {
      const d = this.pos[i].distanceToSquared(p);
      if (d < bd) { bd = d; best = i; }
    }
    return this.xs[best];
  }
}

function v3(a: Vec3): THREE.Vector3 {
  return new THREE.Vector3(a[0], a[1], a[2]);
}

function arcParam(cl: THREE.Vector3[], x0: number, x1: number): number[] {
  const s: number[] = [0];
  for (let i = 1; i < cl.length; i++) s.push(s[i - 1] + cl[i].distanceTo(cl[i - 1]));
  const L = s[s.length - 1] || 1;
  return s.map((v) => x0 + ((x1 - x0) * v) / L);
}

function mergeProfiles(parts: Vec2[][]): Vec2[] {
  const all: Vec2[] = [];
  for (const p of parts) for (const q of p) all.push([q[0], q[1]]);
  all.sort((a, b) => a[0] - b[0]);
  return all;
}

export function interp(prof: Vec2[], x: number): number {
  if (!prof.length) return 0.01;
  if (x <= prof[0][0]) return prof[0][1];
  const n = prof.length;
  if (x >= prof[n - 1][0]) return prof[n - 1][1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (prof[m][0] <= x) lo = m; else hi = m;
  }
  const a = prof[lo], b = prof[hi];
  const t = b[0] > a[0] ? (x - a[0]) / (b[0] - a[0]) : 0;
  return a[1] + (b[1] - a[1]) * t;
}
