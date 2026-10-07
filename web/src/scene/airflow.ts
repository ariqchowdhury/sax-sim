// Air-flow particles along lungs → trachea → vocal tract → reed channel → bore → bell.
// Speed ∝ volume-flow telemetry. Allocation-free per frame.
import * as THREE from 'three';
import type { BorePath } from './borePath';
import { softDot } from './render/textures';

const MAX_PTS = 160;

export class Airflow {
  readonly points: THREE.Points;
  private n: number;
  private s: Float32Array; // arclength position along composite path
  private off: Float32Array; // random unit offsets
  private pos: Float32Array;
  private col: Float32Array;
  private path = new Float32Array(MAX_PTS * 3);
  private rad = new Float32Array(MAX_PTS);
  private cum = new Float32Array(MAX_PTS);
  private np = 0;
  private boreStart = 0;
  private bore: Float32Array;
  private boreRad: Float32Array;
  private nBore: number;
  private mat: THREE.PointsMaterial;
  enabled = true;

  constructor(path: BorePath, count = 900) {
    this.n = count;
    this.s = new Float32Array(count);
    this.off = new Float32Array(count * 3);
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.s[i] = Math.random();
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random());
      const z = Math.random() * 2 - 1;
      this.off[i * 3] = r * Math.cos(a);
      this.off[i * 3 + 1] = r * Math.sin(a);
      this.off[i * 3 + 2] = z * r;
    }
    // bore samples (static): tip → bell, then a few points out of the bell
    this.nBore = 60;
    this.bore = new Float32Array((this.nBore + 4) * 3);
    this.boreRad = new Float32Array(this.nBore + 4);
    const p = new THREE.Vector3(), t = new THREE.Vector3(), nn = new THREE.Vector3(), b = new THREE.Vector3();
    for (let i = 0; i < this.nBore; i++) {
      const x = (path.xEnd * i) / (this.nBore - 1);
      path.frameAt(x, p, t, nn, b);
      p.toArray(this.bore, i * 3);
      this.boreRad[i] = path.radiusAt(x) * 0.6;
    }
    for (let k = 1; k <= 4; k++) {
      const i = this.nBore - 1 + k;
      p.addScaledVector(t, 0.03);
      p.toArray(this.bore, i * 3);
      this.boreRad[i] = path.radiusAt(path.xEnd) * (0.6 + 0.25 * k);
    }
    this.nBore += 4;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    // soft round sprites, additive, slightly HDR so they catch a touch of bloom
    this.mat = new THREE.PointsMaterial({
      size: 0.0042, map: softDot(), vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true, color: new THREE.Color(1.6, 1.6, 1.6),
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    this.points.userData.noAO = true;
  }

  /** playerPath: world points lungs→lips (count = playerLen) */
  private rebuild(playerPath: THREE.Vector3[], playerLen: number): void {
    let k = 0;
    const P = this.path;
    for (let i = 0; i < playerLen && k < MAX_PTS; i++, k++) {
      const v = playerPath[i];
      P[k * 3] = v.x; P[k * 3 + 1] = v.y; P[k * 3 + 2] = v.z;
      this.rad[k] = i < 4 ? 0.01 : 0.004;
    }
    this.boreStart = k;
    for (let i = 0; i < this.nBore && k < MAX_PTS; i++, k++) {
      P[k * 3] = this.bore[i * 3]; P[k * 3 + 1] = this.bore[i * 3 + 1]; P[k * 3 + 2] = this.bore[i * 3 + 2];
      this.rad[k] = this.boreRad[i];
    }
    this.np = k;
    this.cum[0] = 0;
    for (let i = 1; i < k; i++) {
      const dx = P[i * 3] - P[i * 3 - 3], dy = P[i * 3 + 1] - P[i * 3 - 2], dz = P[i * 3 + 2] - P[i * 3 - 1];
      this.cum[i] = this.cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }

  update(dt: number, flowNorm: number, playerPath: THREE.Vector3[], playerLen: number): void {
    this.points.visible = this.enabled && flowNorm > 0.01;
    if (!this.points.visible) return;
    this.rebuild(playerPath, playerLen);
    const np = this.np;
    if (np < 2) return;
    const L = this.cum[np - 1];
    const fn = Math.min(2, flowNorm);
    const speed = 0.08 + 0.9 * fn; // m/s along the path (visual)
    this.mat.opacity = Math.min(0.9, 0.25 + fn * 0.8);
    let seg = 0;
    for (let i = 0; i < this.n; i++) {
      let s = this.s[i] + (speed * dt) / L * (1 + 0.3 * this.off[i * 3 + 2]);
      if (s >= 1) s -= 1;
      this.s[i] = s;
      const d = s * L;
      // binary search segment
      let lo = 0, hi = np - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (this.cum[m] <= d) lo = m; else hi = m;
      }
      seg = lo;
      const l = this.cum[seg + 1] - this.cum[seg] || 1;
      const t = (d - this.cum[seg]) / l;
      const P = this.path;
      const r = this.rad[seg] + (this.rad[seg + 1] - this.rad[seg]) * t;
      this.pos[i * 3] = P[seg * 3] + (P[seg * 3 + 3] - P[seg * 3]) * t + this.off[i * 3] * r * 0.7;
      this.pos[i * 3 + 1] = P[seg * 3 + 1] + (P[seg * 3 + 4] - P[seg * 3 + 1]) * t + this.off[i * 3 + 1] * r * 0.7;
      this.pos[i * 3 + 2] = P[seg * 3 + 2] + (P[seg * 3 + 5] - P[seg * 3 + 2]) * t + this.off[i * 3 + 2] * r * 0.7;
      const inBore = seg >= this.boreStart ? 1 : 0;
      const w = 0.4 + 0.6 * Math.min(1, fn);
      this.col[i * 3] = (0.35 + 0.5 * inBore) * w;
      this.col[i * 3 + 1] = (0.75 + 0.1 * inBore) * w;
      this.col[i * 3 + 2] = (1.0 - 0.5 * inBore) * w;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}
