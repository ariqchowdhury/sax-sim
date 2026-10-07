// Stylized mid-sagittal cutaway of the player: head (lips, teeth, jaw, palate, tongue, pharynx, larynx/glottis)
// plus an upright torso with lungs/diaphragm and a lung-pressure handle.
//
// Head space: origin = lower-lip contact point on the mouthpiece axis, +X forward (toward the sax),
// +Y up, +Z lateral (= mouthpiece-local Z). The head is a child of the mouthpiece root, rotated so the
// mouthpiece axis makes angle θm (its real world pitch) with head-forward → the head stays upright.
// The cutaway keeps the half at `far`·Z ≥ 0 (away from the default camera).
import * as THREE from 'three';
import { P } from '../engine/params';
import type { AppState } from '../state';
import { handleMesh, paramTooltip, planarDrag, setHandleHover } from './handles';
import type { Interaction } from './interaction';
import { HB, type MouthpieceModel } from './mouthpiece';
import { cutMaterial, tissue } from './render/tissue';
import { fineGrainNormal, papillaeNormal } from './render/textures';

type V2 = [number, number];
const TMJ: V2 = [-0.102, 0.03];
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

function smoothShape(pts: V2[], closed = true): THREE.Shape {
  const s = new THREE.Shape();
  const v = pts.map((p) => new THREE.Vector2(p[0], p[1]));
  s.moveTo(v[0].x, v[0].y);
  s.splineThru(v.slice(1).concat(closed ? [v[0]] : []));
  return s;
}

function rot(p: V2, c: V2, a: number): V2 {
  const ca = Math.cos(a), sa = Math.sin(a);
  const dx = p[0] - c[0], dy = p[1] - c[1];
  return [c[0] + dx * ca - dy * sa, c[1] + dx * sa + dy * ca];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

interface ShellMats { skin: THREE.Material; inner: THREE.Material; cutSkin: THREE.Material; cutFat: THREE.Material }

/**
 * Half of a head-like volume from a sagittal outline: the outline is "inflated" toward far·Z with a
 * superelliptic profile (rounded sides, fuller middle), giving a smooth sculpted skin. Returns the
 * outer skin, the inside of the shell (seen through the cut), a mirrored near half (shown when the
 * cutaway is off) and flat cut bands (skin, subcutaneous fat) along the exterior part of the outline.
 * `internal` lists outline segments (start indices) that are not skin (e.g. where the jaw joins).
 */
function shell(pts: V2[], c: V2, depth: (y: number) => number, far: number, m: ShellMats, internal: number[]):
  { group: THREE.Group; outer: THREE.Mesh; inner: THREE.Mesh; near: THREE.Mesh } {
  const N = 192, NR = 20, PW = 2.6;
  const B = smoothShape(pts).getSpacedPoints(N).slice(0, N);
  const nv = N * NR + 1;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let r = 0; r < NR; r++) {
    const a = (r / NR) * (Math.PI / 2);
    const sc = Math.pow(Math.cos(a), 2 / PW), zf = Math.pow(Math.sin(a), 2 / PW);
    for (let j = 0; j < N; j++) {
      const k = r * N + j;
      const px = c[0] + (B[j].x - c[0]) * sc, py = c[1] + (B[j].y - c[1]) * sc;
      pos[k * 3] = px; pos[k * 3 + 1] = py; pos[k * 3 + 2] = far * depth(py) * zf;
      uv[k * 2] = (j / N) * 10; uv[k * 2 + 1] = (r / NR) * 3;
    }
  }
  const ap = N * NR;
  pos[ap * 3] = c[0]; pos[ap * 3 + 1] = c[1]; pos[ap * 3 + 2] = far * depth(c[1]);
  uv[ap * 2] = 0; uv[ap * 2 + 1] = 3;
  const idx: number[] = [];
  for (let r = 0; r < NR - 1; r++)
    for (let j = 0; j < N; j++) {
      const a = r * N + j, b = r * N + ((j + 1) % N), cc = a + N, d = b + N;
      idx.push(a, cc, b, b, cc, d);
    }
  for (let j = 0; j < N; j++) idx.push((NR - 1) * N + j, ap, (NR - 1) * N + ((j + 1) % N));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if ((g.getAttribute('normal') as THREE.BufferAttribute).getZ(ap) * far < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  const outer = new THREE.Mesh(g, m.skin);
  const inner = new THREE.Mesh(g, m.inner);
  const near = new THREE.Mesh(g, m.skin);
  near.scale.z = -1;
  near.visible = false;
  outer.castShadow = true;
  outer.receiveShadow = inner.receiveShadow = true;
  const group = new THREE.Group();
  group.add(outer, inner, near);
  // which outline samples are exterior skin
  const n = pts.length;
  const ext: boolean[] = B.map((p) => {
    let best = Infinity, bi = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p.x - a[0]) * vx + (p.y - a[1]) * vy) / (vx * vx + vy * vy || 1)));
      const d = Math.hypot(a[0] + vx * t - p.x, a[1] + vy * t - p.y);
      if (d < best) { best = d; bi = i; }
    }
    return !internal.includes(bi);
  });
  const band = (t0: number, t1: number, mat: THREE.Material): THREE.Mesh => {
    const at = (j: number, t: number): [number, number] => {
      const dx = B[j].x - c[0], dy = B[j].y - c[1];
      const L = Math.hypot(dx, dy) || 1;
      const f = 1 - t / L;
      return [c[0] + dx * f, c[1] + dy * f];
    };
    const p: number[] = [];
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      if (!ext[j] || !ext[j1]) continue;
      const a0 = at(j, t0), a1 = at(j1, t0), b0 = at(j, t1), b1 = at(j1, t1);
      p.push(a0[0], a0[1], 0, b0[0], b0[1], 0, a1[0], a1[1], 0, a1[0], a1[1], 0, b0[0], b0[1], 0, b1[0], b1[1], 0);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    bg.computeVertexNormals();
    return new THREE.Mesh(bg, mat);
  };
  group.add(band(0, 0.0018, m.cutSkin), band(0.0018, 0.0058, m.cutFat));
  return { group, outer, inner, near };
}

/** rounded block centred in XY, extruded from z = 0 toward far·Z (caps = group 0, sides = group 1) */
function roundedSlab(w: number, h: number, d: number, r: number, far: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x0 = -w / 2, y0 = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0);
  s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r);
  s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h);
  s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelSize: r * 0.5, bevelThickness: r * 0.5, bevelSegments: 3, curveSegments: 8 });
  if (far < 0) g.scale(1, 1, -1);
  return g;
}

/** Deformable half-"pillow" between an upper and lower contour (used for the tongue). */
class Pillow {
  readonly mesh: THREE.Mesh;
  readonly cap: THREE.Mesh;
  private K: number;
  private M = 10;
  constructor(K: number, mat: THREE.Material, capMat: THREE.Material, private far: number) {
    this.K = K;
    const M = this.M;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(K * (M + 1) * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < K - 1; i++)
      for (let j = 0; j < M; j++) {
        const a = i * (M + 1) + j, b = a + 1, c = a + M + 1, d = c + 1;
        if (far > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
      }
    g.setIndex(idx);
    const uv = new Float32Array(K * (M + 1) * 2);
    for (let i = 0; i < K; i++) for (let j = 0; j <= M; j++) { uv[(i * (M + 1) + j) * 2] = (i / (K - 1)) * 3; uv[(i * (M + 1) + j) * 2 + 1] = j / M; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.castShadow = true;
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(K * 2 * 3), 3));
    const ci: number[] = [];
    for (let i = 0; i < K - 1; i++) ci.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    cg.setIndex(ci);
    this.cap = new THREE.Mesh(cg, capMat);
    this.mesh.frustumCulled = false;
    this.cap.frustumCulled = false;
  }
  update(up: Float32Array, lo: Float32Array, width: (t: number) => number): void {
    const K = this.K, M = this.M;
    const pa = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const ca = this.cap.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pa.array as Float32Array, c = ca.array as Float32Array;
    for (let i = 0; i < K; i++) {
      const ux = up[i * 2], uy = up[i * 2 + 1], lx = lo[i * 2], ly = lo[i * 2 + 1];
      const cx = (ux + lx) / 2, cy = (uy + ly) / 2;
      const hx = (ux - lx) / 2, hy = (uy - ly) / 2;
      const w = width(i / (K - 1));
      for (let j = 0; j <= M; j++) {
        const ph = (j / M) * Math.PI; // 0 = upper contour, π = lower contour, bulging toward far·Z
        const k = (i * (M + 1) + j) * 3;
        a[k] = cx + hx * Math.cos(ph);
        a[k + 1] = cy + hy * Math.cos(ph);
        a[k + 2] = this.far * w * Math.sin(ph);
      }
      c[i * 6] = ux; c[i * 6 + 1] = uy; c[i * 6 + 2] = 0;
      c[i * 6 + 3] = lx; c[i * 6 + 4] = ly; c[i * 6 + 5] = 0;
    }
    pa.needsUpdate = true;
    ca.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.cap.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}

/** Translucent tube along a moving 2-D midline with per-station radius (airway). */
class Airway {
  readonly mesh: THREE.Mesh;
  constructor(private S: number, private R: number, mat: THREE.Material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S * (R + 1) * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < S - 1; i++)
      for (let j = 0; j < R; j++) {
        const a = i * (R + 1) + j, b = a + 1, c = a + R + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
  }
  update(mid: Float32Array, rad: Float32Array): void {
    const S = this.S, R = this.R;
    const a = (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < S; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(S - 1, i + 1);
      let tx = mid[i1 * 2] - mid[i0 * 2], ty = mid[i1 * 2 + 1] - mid[i0 * 2 + 1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const nx = -ty, ny = tx; // in-plane normal
      for (let j = 0; j <= R; j++) {
        const ph = (j / R) * Math.PI * 2;
        const k = (i * (R + 1) + j) * 3;
        const r = rad[i];
        a[k] = mid[i * 2] + nx * r * Math.cos(ph);
        a[k + 1] = mid[i * 2 + 1] + ny * r * Math.cos(ph);
        a[k + 2] = r * Math.sin(ph) * 0.9;
      }
    }
    (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }
}

const K_TONGUE = 30;
// params that change the head geometry (rebuild only when one of these changes)
const GEOM_IDS = [P.lip_position, P.jaw_open, P.lip_force, P.lip_damping, P.tongue_x, P.tongue_y, P.tongue_tip, P.tongue_reed_contact, P.glottis_open, P.tip_opening, P.facing_length, P.mouthpiece_insertion];
const S_AIR = 44;

export class PlayerModel {
  /** head root: child of the mouthpiece root */
  readonly head = new THREE.Group();
  /** torso root: in world space, upright */
  readonly torso = new THREE.Group();
  readonly far: number;
  private thetaM: number;
  private jaw = new THREE.Group();
  private upperTeeth = new THREE.Group();
  private lowerLip: THREE.Mesh;
  private upperLip: THREE.Mesh;
  private tongue: Pillow;
  private airway: Airway;
  private airMat: THREE.MeshStandardMaterial;
  private foldL: THREE.Mesh;
  private foldR: THREE.Mesh;
  private lungL: THREE.Mesh;
  private lungR: THREE.Mesh;
  private diaphragm: THREE.Mesh;
  private gaugeFill: THREE.Mesh;
  /** near (camera-side) halves of the skin shells, shown only when the cutaway is off */
  private nearHalves: THREE.Object3D[] = [];
  private tongueMat: THREE.MeshStandardMaterial;
  private mandible: THREE.Mesh;

  // handles
  private hTongueBody = handleMesh(0.0028, 0xff6f91);
  private hTongueTip = handleMesh(0.0024, 0xff9a3c);
  private hJaw = handleMesh(0.003, 0x9be15d);
  private hGlottis = handleMesh(0.0026, 0xb48cff);
  private hLung = handleMesh(0.008, 0x4aa8ff);

  // tongue contour scratch
  private up = new Float32Array(K_TONGUE * 2);
  private lo = new Float32Array(K_TONGUE * 2);
  private airMid = new Float32Array(S_AIR * 2);
  private airRad = new Float32Array(S_AIR);
  private airUp = new Float32Array(S_AIR * 2);
  private airLo = new Float32Array(S_AIR * 2);
  private upperWall: V2[] = [];
  private lowerWall: V2[] = [];
  private curveU = new THREE.CatmullRomCurve3([], false, 'centripetal');
  private curveL = new THREE.CatmullRomCurve3([], false, 'centripetal');
  private cpU: THREE.Vector3[] = [];
  private cpL: THREE.Vector3[] = [];
  /** world-space airflow path (lungs → glottis → tract → lips); refreshed each frame */
  readonly airPath: THREE.Vector3[] = [];
  /** tongue tip (head space) and reed-contact point (head space) */
  readonly tipPt = new THREE.Vector2();
  readonly contactPt = new THREE.Vector2();
  readonly glottisPt = new THREE.Vector2(-0.082, -0.09);
  breath = 0;
  readonly anchors = { mouth: new THREE.Object3D(), glottis: new THREE.Object3D(), lungs: new THREE.Object3D(), tract: new THREE.Object3D() };
  /** tract-resonance cue: 0 none, 1 near the note, 2 aligned */
  tractCue = 0;
  private lastGeom = new Float64Array(GEOM_IDS.length).fill(NaN);
  mouthPressure = 0;
  /** head geometry changed in the last update (shadow refresh) */
  moved = true;

  constructor(private mp: MouthpieceModel, private state: AppState, worldAxis: THREE.Vector3) {
    this.far = mp.far;
    const f = this.far;
    // mouthpiece pitch in world → head rotation keeps the head upright
    this.thetaM = Math.max(-1.0, Math.min(-0.15, Math.asin(Math.max(-1, Math.min(1, worldAxis.y)))));
    this.head.rotation.z = -this.thetaM;
    mp.root.add(this.head);

    // ---- materials: soft tissue (subsurface-ish), bone, enamel, cartilage; flat cut-section colours --
    const grain = fineGrainNormal();
    const skin = tissue({ color: 0xe0a084, scatter: 0xd0483a, sss: 0.55, roughness: 0.52, sheen: 0.45, normalMap: grain, normalScale: 0.12 });
    const shellInner = new THREE.MeshStandardMaterial({ color: 0xc7aca4, roughness: 0.9, side: THREE.BackSide });
    const cutSkin = cutMaterial(0xf2bca6, 0.55);
    const cutFat = cutMaterial(0xf8e4bd, 0.55);
    const bone = new THREE.MeshPhysicalMaterial({ color: 0xede2c8, roughness: 0.55, sheen: 0.25, sheenColor: new THREE.Color(0xfff4e0), normalMap: grain, normalScale: new THREE.Vector2(0.2, 0.2) });
    const cutBone = cutMaterial(0xf4ead0, 0.5);
    const tooth = new THREE.MeshPhysicalMaterial({ color: 0xfbf8ef, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08 });
    const cutTooth = cutMaterial(0xefe0bb, 0.5);
    const flesh = tissue({ color: 0xc65a5f, scatter: 0xb02a2a, sss: 0.5, roughness: 0.45, wet: 0.5 });
    const cutFlesh = cutMaterial(0xa53a45);
    const lipMat = tissue({ color: 0xc4616a, scatter: 0xc0303a, sss: 0.6, roughness: 0.4, wet: 0.6 });
    const cart = tissue({ color: 0xb9d2de, scatter: 0x7fa6c8, sss: 0.35, roughness: 0.4, wet: 0.35 });
    const cutCart = cutMaterial(0x9cbccc);
    this.tongueMat = tissue({ color: 0xd86876, scatter: 0xc03040, sss: 0.55, roughness: 0.42, wet: 0.85, normalMap: papillaeNormal(), normalScale: 0.35 });
    const cutMat = cutMaterial(0xa8394a);

    // extruded half-section (cut face at z = 0 gets the flat section colour, the rounded rest the tissue)
    const slab = (pts: V2[], depth: number, mat: THREE.Material, bevel = 0.0015, cut: THREE.Material = cutFlesh): THREE.Mesh => {
      const g = new THREE.ExtrudeGeometry(smoothShape(pts), { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 4, curveSegments: 16 });
      if (f < 0) g.scale(1, 1, -1);
      const m = new THREE.Mesh(g, [cut, mat]);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };

    // --- skin: inflated half-head shell (far half), its inside, and the cut rim (skin + fat bands) ---
    const headPts: V2[] = [
      [-0.005, 0.15], [0.01, 0.1], [0.012, 0.082], [0.006, 0.068], [0.022, 0.05], [0.034, 0.034], [0.018, 0.026],
      [0.014, 0.016], [0.006, 0.004], [-0.03, -0.01], [-0.066, -0.07], [-0.062, -0.12], [-0.064, -0.17],
      [-0.15, -0.17], [-0.15, -0.1], [-0.185, -0.03], [-0.19, 0.05], [-0.16, 0.14], [-0.085, 0.18],
    ];
    const headDepth = (y: number): number => 0.074 - 0.022 * smoothstep(-0.05, -0.12, y);
    const headShell = shell(headPts, [-0.085, 0.02], headDepth, f, { skin, inner: shellInner, cutSkin, cutFat }, [8, 9]);
    this.nearHalves.push(headShell.near);
    this.head.add(headShell.group);

    // --- jaw (rotates about the TMJ): chin skin, mandible, lower incisors ----------------------
    this.jaw.position.set(TMJ[0], TMJ[1], 0);
    this.head.add(this.jaw);
    const toJaw = (p: V2): V2 => [p[0] - TMJ[0], p[1] - TMJ[1]];
    const jawPts: V2[] = ([[0.006, 0.0], [0.012, -0.014], [0.0, -0.028], [0.008, -0.048], [-0.01, -0.066], [-0.045, -0.072], [-0.066, -0.07], [-0.03, -0.01]] as V2[]).map(toJaw);
    const jawShell = shell(jawPts, toJaw([-0.018, -0.042]), () => 0.058, f, { skin, inner: shellInner, cutSkin, cutFat }, [6, 7]);
    this.nearHalves.push(jawShell.near);
    this.jaw.add(jawShell.group);
    // midline section of the mandible = the symphysis (chin bone); the rami are lateral
    const mandPts: V2[] = ([[-0.007, -0.02], [0.0, -0.034], [0.002, -0.05], [-0.008, -0.062], [-0.022, -0.062], [-0.028, -0.048], [-0.02, -0.028]] as V2[]).map(toJaw);
    this.mandible = slab(mandPts, 0.012, bone, 0.0012, cutBone);
    this.jaw.add(this.mandible);
    const floor = slab(([[-0.026, -0.05], [-0.045, -0.058], [-0.06, -0.066], [-0.062, -0.07], [-0.044, -0.064], [-0.026, -0.058]] as V2[]).map(toJaw), 0.02, flesh, 0.001);
    this.jaw.add(floor);
    const lowerTooth = slab(([[-0.006, -0.006], [-0.002, -0.006], [-0.003, -0.02], [-0.009, -0.022], [-0.01, -0.012]] as V2[]).map(toJaw), 0.016, tooth, 0.0009, cutTooth);
    this.jaw.add(lowerTooth);

    // --- upper jaw: incisors + hard palate, soft palate, spine, pharynx, larynx --------------
    const upTooth = slab([[0.0, 0.0], [-0.0035, 0.0], [-0.0075, 0.013], [-0.002, 0.015], [0.002, 0.008]], 0.016, tooth, 0.0009, cutTooth);
    this.upperTeeth.add(upTooth);
    this.head.add(this.upperTeeth);
    const palate = slab([[-0.006, 0.026], [-0.012, 0.022], [-0.03, 0.031], [-0.055, 0.034], [-0.072, 0.03], [-0.072, 0.038], [-0.05, 0.044], [-0.02, 0.042], [0.0, 0.034]], 0.018, bone, 0.0012, cutBone);
    const velum = slab([[-0.072, 0.03], [-0.08, 0.022], [-0.088, 0.008], [-0.084, 0.006], [-0.076, 0.018], [-0.068, 0.034]], 0.014, flesh, 0.0012);
    const pharWall = slab([[-0.094, 0.04], [-0.098, -0.02], [-0.092, -0.085], [-0.1, -0.09], [-0.108, -0.02], [-0.104, 0.04]], 0.03, flesh, 0.0012);
    this.head.add(palate, velum, pharWall);
    // cervical spine: rounded vertebral bodies with intervertebral discs
    const vbG = roundedSlab(0.018, 0.011, 0.014, 0.003, f);
    const discG = roundedSlab(0.017, 0.0032, 0.012, 0.0012, f);
    for (let i = 0; i < 6; i++) {
      const vb = new THREE.Mesh(vbG, [cutBone, bone]);
      vb.position.set(-0.118, 0.02 - i * 0.02, 0);
      vb.castShadow = true;
      const disc = new THREE.Mesh(discG, [cutCart, cart]);
      disc.position.set(-0.118, 0.02 - i * 0.02 - 0.0098, 0);
      this.head.add(vb, disc);
    }
    const epiglottis = slab([[-0.074, -0.05], [-0.078, -0.07], [-0.074, -0.075], [-0.07, -0.056]], 0.012, cart, 0.0008, cutCart);
    const thyroid = slab([[-0.062, -0.075], [-0.07, -0.1], [-0.085, -0.104], [-0.09, -0.096], [-0.078, -0.09], [-0.068, -0.072]], 0.018, cart, 0.001, cutCart);
    const hyoid = new THREE.Mesh(new THREE.CapsuleGeometry(0.0025, 0.008, 6, 12).rotateZ(Math.PI / 2), bone);
    hyoid.position.set(-0.066, -0.068, f * 0.004);
    this.head.add(epiglottis, thyroid, hyoid);
    // vocal folds (open laterally with glottis_open)
    const foldG = new THREE.CapsuleGeometry(0.0018, 0.013, 6, 12).rotateZ(Math.PI / 2);
    this.foldL = new THREE.Mesh(foldG, flesh);
    this.foldR = new THREE.Mesh(foldG, flesh);
    this.head.add(this.foldL, this.foldR);

    // --- lips: soft rolls wrapping the mouthpiece (lateral axis), moist ------------------------
    const lipG = new THREE.CapsuleGeometry(0.0058, 0.026, 10, 24).rotateX(Math.PI / 2).translate(0, 0, f * 0.013);
    this.lowerLip = new THREE.Mesh(lipG, lipMat.clone());
    this.upperLip = new THREE.Mesh(lipG, lipMat.clone());
    for (const l of [this.lowerLip, this.upperLip]) {
      // the clone drops the subsurface hook: re-create it with the same look
      l.material = tissue({ color: 0xc4616a, scatter: 0xc0303a, sss: 0.6, roughness: 0.4, wet: 0.6 });
      l.castShadow = true;
    }
    this.head.add(this.lowerLip, this.upperLip);

    // --- tongue + airway ------------------------------------------------------------------------
    this.tongue = new Pillow(K_TONGUE, this.tongueMat, cutMat, f);
    this.head.add(this.tongue.mesh, this.tongue.cap);
    for (let i = 0; i < 6; i++) this.cpU.push(new THREE.Vector3());
    for (let i = 0; i < 5; i++) this.cpL.push(new THREE.Vector3());
    this.curveU.points = this.cpU;
    this.curveL.points = this.cpL;
    this.airMat = new THREE.MeshStandardMaterial({ color: 0x5ec8ff, transparent: true, opacity: 0.22, depthWrite: false, roughness: 0.2, emissive: 0x0b3350, side: THREE.DoubleSide });
    this.airway = new Airway(S_AIR, 14, this.airMat);
    this.airway.mesh.renderOrder = 6;
    this.head.add(this.airway.mesh);

    // --- torso (world, upright) ---------------------------------------------------------------
    const lungMat = tissue({ color: 0xf0909f, scatter: 0xe04050, sss: 0.7, roughness: 0.55, sheen: 1, transparent: true, opacity: 0.6 });
    const lungG = new THREE.SphereGeometry(1, 40, 28);
    this.lungL = new THREE.Mesh(lungG, lungMat);
    this.lungR = new THREE.Mesh(lungG, lungMat);
    this.lungL.position.set(-0.01, -0.2, -0.065);
    this.lungR.position.set(-0.01, -0.2, 0.065);
    const tracheaG = new THREE.CylinderGeometry(0.009, 0.009, 0.14, 24, 1, true).translate(0, -0.07, 0);
    const trachea = new THREE.Mesh(tracheaG, cart);
    // cartilage rings along the trachea
    const ringG = new THREE.TorusGeometry(0.0094, 0.0013, 8, 28).rotateX(Math.PI / 2);
    for (let i = 0; i < 9; i++) {
      const rg = new THREE.Mesh(ringG, cart);
      rg.position.y = -0.012 - i * 0.0145;
      trachea.add(rg);
    }
    const bronL = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 16), cart);
    bronL.position.set(-0.005, -0.16, -0.025); bronL.rotation.x = -0.75;
    const bronR = bronL.clone(); bronR.position.z = 0.025; bronR.rotation.x = 0.75;
    this.diaphragm = new THREE.Mesh(new THREE.SphereGeometry(0.12, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2.6),
      tissue({ color: 0xb9505d, scatter: 0xa02030, sss: 0.4, roughness: 0.6, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
    this.diaphragm.scale.set(0.85, 0.55, 1.1);
    const ribs = new THREE.Group();
    const ribMat = new THREE.MeshPhysicalMaterial({ color: 0xece3cf, roughness: 0.5, sheen: 0.3, transparent: true, opacity: 0.55, depthWrite: false });
    for (let i = 0; i < 7; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.11 - Math.abs(i - 3) * 0.006, 0.0032, 12, 64), ribMat);
      rib.castShadow = false;
      rib.rotation.x = Math.PI / 2;
      rib.rotation.z = 0.25;
      rib.scale.set(0.8, 1.15, 1);
      rib.position.set(-0.01, -0.09 - i * 0.032, 0);
      ribs.add(rib);
    }
    // pressure gauge column in front of the chest
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.26, 16), new THREE.MeshPhysicalMaterial({ color: 0x8090a8, roughness: 0.15, transparent: true, opacity: 0.35, clearcoat: 1 }));
    rail.position.set(0.14, -0.2, 0);
    this.gaugeFill = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 16).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.6 }));
    this.gaugeFill.position.set(0.14, -0.33, 0);
    this.torso.add(this.lungL, this.lungR, trachea, bronL, bronR, this.diaphragm, ribs, rail, this.gaugeFill, this.hLung);

    this.head.add(this.hTongueBody, this.hTongueTip, this.hJaw, this.hGlottis);
    // anchors for 3D readout labels
    this.anchors.mouth.position.set(-0.045, 0.045, 0);
    this.anchors.glottis.position.set(-0.13, -0.09, 0);
    this.anchors.tract.position.set(-0.075, 0.075, 0);
    this.head.add(this.anchors.mouth, this.anchors.glottis, this.anchors.tract);
    this.anchors.lungs.position.set(0, -0.06, 0.1);
    this.torso.add(this.anchors.lungs);
    for (let i = 0; i < 64; i++) this.airPath.push(new THREE.Vector3());
  }

  // ---- geometry helpers (head space) ----------------------------------------------------------
  /** mouthpiece-local (u, v) → head space; lp = lip position (m) */
  private mpToHead(u: number, v: number, lp: number, out: THREE.Vector2): THREE.Vector2 {
    const c = Math.cos(this.thetaM), s = Math.sin(this.thetaM);
    const du = u - lp;
    return out.set(du * c - v * s, du * s + v * c);
  }

  private jawPt(p: V2, jawA: number): V2 {
    return rot(p, TMJ, jawA);
  }

  private tmp2 = new THREE.Vector2();
  private tmp2b = new THREE.Vector2();

  update(dt: number, mouthPressure: number, flowNorm: number, time: number): void {
    const s = this.state;
    const f = this.far;
    const lp = s.get(P.lip_position) / 1000;
    const jaw = s.get(P.jaw_open);
    const jawA = -0.04 - jaw * 0.22;
    let dirty = false;
    for (let i = 0; i < GEOM_IDS.length; i++) {
      const v = s.get(GEOM_IDS[i]);
      if (v !== this.lastGeom[i]) { this.lastGeom[i] = v; dirty = true; }
    }
    this.moved = dirty;
    if (dirty) {
      this.head.position.set(lp, 0, 0);
      this.jaw.rotation.z = jawA;

      // lips: lower lip under the reed, pushed up with lip force; upper lip on the beak
      const force = s.get(P.lip_force);
      const lipV = -HB - 0.0012 - 0.0056 + force * 0.0005;
      this.mpToHead(lp - 0.0005, lipV, lp, this.tmp2);
      this.lowerLip.position.set(this.tmp2.x, this.tmp2.y, 0);
      this.lowerLip.rotation.z = this.thetaM;
      const squash = 1 - Math.min(0.35, force * 0.1);
      this.lowerLip.scale.set(1.15 - 0.15 * squash, squash, 1);
      (this.lowerLip.material as THREE.MeshStandardMaterial).color.setRGB(0.78 + force * 0.04, 0.39 - force * 0.05, 0.42 - force * 0.05);
      const damp = s.get(P.lip_damping);
      const topU = lp + 0.0005;
      this.mpToHead(topU, this.mp.outerTop(topU) + 0.0052, lp, this.tmp2);
      this.upperLip.position.set(this.tmp2.x, this.tmp2.y, 0);
      this.upperLip.rotation.z = this.thetaM;
      this.upperLip.scale.set(1, 0.85 + 0.25 * (1 - damp), 1);

      // upper teeth rest on the beak ~4 mm inside the lips
      const tu = Math.max(0.002, lp - 0.004);
      this.mpToHead(tu, this.mp.outerTop(tu), lp, this.tmp2);
      this.upperTeeth.position.set(this.tmp2.x + 0.002, this.tmp2.y, 0);

      // vocal folds
      const g = s.get(P.glottis_open);
      const gap = 0.0005 + g * 0.0045;
      this.foldL.position.set(this.glottisPt.x, this.glottisPt.y, -gap / 2 - 0.002);
      this.foldR.position.set(this.glottisPt.x, this.glottisPt.y, gap / 2 + 0.002);

      // ---- tongue ---------------------------------------------------------------------------------
      const tx = s.get(P.tongue_x), ty = s.get(P.tongue_y), tt = s.get(P.tongue_tip), tc = s.get(P.tongue_reed_contact);
      this.mpToHead(0.0015, -HB - 0.0018, lp, this.tmp2b); // just under the reed tip
      this.contactPt.copy(this.tmp2b);
      const restTip = this.jawPt([-0.014, lerp(-0.017, 0.014, tt)], jawA * 0.6);
      const tip: V2 = [lerp(restTip[0], this.contactPt.x, tc), lerp(restTip[1], this.contactPt.y, tc)];
      this.tipPt.set(tip[0], tip[1]);
      const bodyY = lerp(-0.014, 0.024, ty) - jaw * 0.012;
      const body: V2 = [lerp(-0.03, -0.062, tx), bodyY];
      const blade: V2 = [lerp(tip[0], body[0], 0.45), Math.max(tip[1], bodyY) - 0.002 - 0.004 * (1 - ty)];
      const dorsum: V2 = [lerp(-0.068, -0.085, tx), lerp(-0.012, 0.012, ty * 0.6 + tx * 0.4) - jaw * 0.006];
      const root: V2 = [-0.078, -0.05];
      const rootLow: V2 = [-0.07, -0.062];
      const ctrlU: V2[] = [tip, blade, body, [lerp(body[0], dorsum[0], 0.55), lerp(bodyY, dorsum[1], 0.5) + 0.006], dorsum, root];
      const floorF = this.jawPt([-0.014, -0.03], jawA);
      const floorM = this.jawPt([-0.04, -0.046], jawA);
      const ctrlL: V2[] = [[tip[0] - 0.003, tip[1] - 0.004], floorF, floorM, [-0.062, -0.058], rootLow];
      ctrlU.forEach((p, i) => this.cpU[i].set(p[0], p[1], 0));
      ctrlL.forEach((p, i) => this.cpL[i].set(p[0], p[1], 0));
      for (let i = 0; i < K_TONGUE; i++) {
        const t = i / (K_TONGUE - 1);
        this.curveU.getPoint(t, _v);
        this.up[i * 2] = _v.x; this.up[i * 2 + 1] = _v.y;
        this.curveL.getPoint(t, _v);
        this.lo[i * 2] = _v.x; this.lo[i * 2 + 1] = _v.y;
      }
      this.tongue.update(this.up, this.lo, (t) => 0.004 + 0.02 * Math.sin(Math.min(1, t * 1.6 + 0.12) * Math.PI * 0.5));
      this.tongueMat.emissive.setRGB(tc * 0.25, tc * 0.08, 0);

      // ---- airway (upper wall: lips → palate → velum → pharynx → glottis; lower: tongue → larynx) ----
      this.mpToHead(0.004, 0.0, lp, this.tmp2);
      const lipIn: V2 = [this.tmp2.x, this.tmp2.y];
      const uw = this.upperWall; uw.length = 0;
      uw.push([lipIn[0], lipIn[1] + 0.004], [-0.016, 0.022], [-0.035, 0.03], [-0.058, 0.032], [-0.075, 0.024], [-0.088, 0.008], [-0.093, -0.02], [-0.092, -0.06], [this.glottisPt.x - 0.006, this.glottisPt.y]);
      const lw = this.lowerWall; lw.length = 0;
      lw.push([lipIn[0], lipIn[1] - 0.004]);
      for (let i = 0; i < K_TONGUE; i += 3) lw.push([this.up[i * 2], this.up[i * 2 + 1]]);
      lw.push([this.up[(K_TONGUE - 1) * 2], this.up[(K_TONGUE - 1) * 2 + 1]], [-0.074, -0.072], [this.glottisPt.x + 0.006, this.glottisPt.y]);
      sampleByArc(uw, S_AIR, this.airUp);
      sampleByArc(lw, S_AIR, this.airLo);
      for (let i = 0; i < S_AIR; i++) {
        const ux = this.airUp[i * 2], uy = this.airUp[i * 2 + 1], lx = this.airLo[i * 2], ly = this.airLo[i * 2 + 1];
        this.airMid[i * 2] = (ux + lx) / 2;
        this.airMid[i * 2 + 1] = (uy + ly) / 2;
        this.airRad[i] = Math.max(0.0015, Math.min(0.016, Math.hypot(ux - lx, uy - ly) / 2));
      }
      this.airway.update(this.airMid, this.airRad);
      // handles
      this.hTongueBody.position.set(body[0], body[1] + 0.002, -f * 0.003);
      this.hTongueTip.position.set(tip[0], tip[1], -f * 0.003);
      const chin = this.jawPt([0.002, -0.05], jawA);
      this.hJaw.position.set(chin[0] + 0.006, chin[1], -f * 0.003);
      this.hGlottis.position.set(this.glottisPt.x, this.glottisPt.y + 0.004, -f * 0.003);

    }
    this.mouthPressure = mouthPressure;
    const mpk = Math.max(-1, Math.min(1, mouthPressure / 4000));
    if (this.tractCue === 2) { this.airMat.color.setRGB(0.35, 1.0, 0.5); this.airMat.emissive.setRGB(0.05, 0.35, 0.12); this.airMat.opacity = 0.38; }
    else if (this.tractCue === 1) { this.airMat.color.setRGB(1.0, 0.8, 0.3); this.airMat.emissive.setRGB(0.25, 0.15, 0.02); this.airMat.opacity = 0.3; }
    else {
      this.airMat.color.setRGB(0.37 + 0.6 * Math.max(0, mpk), 0.78 - 0.3 * Math.abs(mpk), 1 - 0.7 * Math.max(0, mpk));
      this.airMat.emissive.setHex(0x0b3350);
      this.airMat.opacity = 0.22;
    }

    // ---- torso ----------------------------------------------------------------------------------
    this.head.updateWorldMatrix(true, false);
    _v.set(-0.098, -0.16, 0);
    this.head.localToWorld(_v);
    this.torso.position.copy(_v);
    // lateral axis = head Z in world, flattened to horizontal; forward = up × lateral... keep upright
    _w.set(0, 0, 1).transformDirection(this.head.matrixWorld);
    _w.y = 0;
    _w.normalize();
    const fwd = _v.set(0, 1, 0).cross(_w).normalize();
    this.torso.quaternion.setFromRotationMatrix(_m.makeBasis(fwd, Y_UP, _w));
    const lung = s.get(P.lung_pressure);
    this.breath += dt * (lung > 0.05 ? -0.06 * (0.3 + lung / 10) * (0.5 + flowNorm) : 0.5);
    this.breath = Math.max(0, Math.min(1, this.breath));
    const vol = 0.82 + 0.18 * this.breath + 0.01 * Math.sin(time * 1.3);
    const squeeze = 1 - 0.04 * (lung / 10);
    this.lungL.scale.set(0.05 * vol * squeeze, 0.11 * vol, 0.055 * vol * squeeze);
    this.lungR.scale.copy(this.lungL.scale);
    this.diaphragm.position.set(-0.01, -0.33 + 0.05 * (1 - this.breath) + 0.01 * (lung / 10), 0);
    const gh = Math.max(0.001, 0.24 * (lung / 10));
    this.gaugeFill.scale.set(1, gh, 1);
    (this.gaugeFill.material as THREE.MeshBasicMaterial).color.setRGB(0.3 + 0.7 * (lung / 10), 0.66 - 0.3 * (lung / 10), 1 - 0.7 * (lung / 10));
    this.hLung.position.set(0.14, -0.33 + 0.24 * (lung / 10), 0);

    this.buildAirPath();
  }

  /** world-space path: lungs → trachea → glottis → tract midline → mouthpiece tip */
  private buildAirPath(): void {
    const P0 = this.airPath;
    let k = 0;
    this.torso.updateWorldMatrix(true, false);
    for (const p of TORSO_PTS) this.torso.localToWorld(P0[k++].set(p[0], p[1], p[2]));
    // airway midline from glottis (end) back to lips (start)
    for (let i = S_AIR - 1; i >= 0; i -= 2) {
      if (k >= P0.length - 1) break;
      this.head.localToWorld(P0[k++].set(this.airMid[i * 2], this.airMid[i * 2 + 1], 0));
    }
    this.pathLen = k;
  }
  pathLen = 0;

  setCutaway(on: boolean): void {
    for (const n of this.nearHalves) n.visible = !on;
  }

  /** drag handles of the head (tongue, tip, jaw, glottis) — for the UI's declutter rule */
  get headHandles(): THREE.Object3D[] {
    return [this.hTongueBody, this.hTongueTip, this.hJaw, this.hGlottis];
  }

  registerHandles(ix: Interaction): void {
    const st = this.state;
    const frame = this.head;
    const add = (mesh: THREE.Mesh, ids: number[], title: string, drag: ReturnType<typeof planarDrag>, objects: THREE.Object3D[] = [mesh], priority = 3): void => {
      ix.add({ objects, priority, tooltip: paramTooltip(st, ids, title), drag, hover: (on) => setHandleHover(mesh, on) });
    };
    add(this.hTongueBody, [P.tongue_x, P.tongue_y], 'Tongue body (drag ↔ front/back, ↕ low/high)',
      // relative to the value at the grab (no jump); 2-D on purpose: front/back × low/high is the
      // vowel-space gesture players think in. Screen-space gain: full range ≈ 200–250 px at any zoom.
      planarDrag(frame, st, [P.tongue_x, P.tongue_y], (l, l0, s0) => {
        st.set(P.tongue_x, s0[0] + (l.x - l0.x) / (-0.062 - -0.03), 'drag');
        st.set(P.tongue_y, s0[1] + (l.y - l0.y) / 0.038, 'drag');
      }, { ranges: [0.032, 0.038] }));
    add(this.hTongueTip, [P.tongue_tip, P.tongue_reed_contact], 'Tongue tip (↕ height; drag onto the reed to tongue)',
      planarDrag(frame, st, [P.tongue_tip, P.tongue_reed_contact], (l) => {
        const d = Math.hypot(l.x - this.contactPt.x, l.y - this.contactPt.y);
        const c = Math.max(0, Math.min(1, 1 - (d - 0.002) / 0.007));
        st.set(P.tongue_reed_contact, c, 'drag');
        // tip height from vertical position (relative to the rest arc)
        if (c < 0.999) st.set(P.tongue_tip, (l.y - -0.017) / 0.031, 'drag');
      }, { ranges: [0.031, 0.031] }));
    add(this.hJaw, [P.jaw_open], 'Jaw (drag ↕)',
      planarDrag(frame, st, [P.jaw_open], (l, l0, s0) => st.set(P.jaw_open, s0[0] - (l.y - l0.y) / 0.02, 'drag'), { ranges: [0, 0.02] }),
      [this.hJaw, this.mandible], 1);
    add(this.hGlottis, [P.glottis_open], 'Glottis (drag ↕: up = open)',
      planarDrag(frame, st, [P.glottis_open], (l, l0, s0) => st.set(P.glottis_open, s0[0] + (l.y - l0.y) / 0.01, 'drag'), { ranges: [0, 0.01] }));
    // lung pressure: vertical drag in torso plane
    ix.add({
      objects: [this.hLung, this.lungL, this.lungR, this.gaugeFill], priority: 2,
      tooltip: paramTooltip(st, [P.lung_pressure], 'Lungs (drag ↕ = blowing pressure)'),
      drag: planarDrag(this.torso, st, [P.lung_pressure], (l, l0, s0) => st.set(P.lung_pressure, s0[0] + ((l.y - l0.y) / 0.24) * 10, 'drag'), { ranges: [0, 0.24] }),
      hover: (on) => setHandleHover(this.hLung, on),
    });
    // lips: ↔ along the mouthpiece = lip position (take-in), ↕ = lip force (lower) / damping (upper)
    const mpRoot = this.mp.root;
    ix.add({
      objects: [this.lowerLip], priority: 2,
      tooltip: paramTooltip(st, [P.lip_position, P.lip_force], 'Lower lip (drag along mouthpiece = take-in, toward reed = force)'),
      drag: planarDrag(mpRoot, st, [P.lip_position, P.lip_force], (l, l0, s0) => {
        st.set(P.lip_position, s0[0] + (l.x - l0.x) * 1000, 'drag');
        st.set(P.lip_force, s0[1] + (l.y - l0.y) / 0.004, 'drag');
      }, { ranges: [0.02, 0.012], lock: ['take-in (lip position)', 'lip force'] }),
      hover: (on) => (this.lowerLip.material as THREE.MeshStandardMaterial).emissive.setHex(on ? 0x331111 : 0),
    });
    ix.add({
      objects: [this.upperLip], priority: 2,
      tooltip: paramTooltip(st, [P.lip_position, P.lip_damping], 'Upper lip (drag along mouthpiece = take-in, ↕ = firmness)'),
      drag: planarDrag(mpRoot, st, [P.lip_position, P.lip_damping], (l, l0, s0) => {
        st.set(P.lip_position, s0[0] + (l.x - l0.x) * 1000, 'drag');
        st.set(P.lip_damping, s0[1] - (l.y - l0.y) / 0.006, 'drag');
      }, { ranges: [0.02, 0.006], lock: ['take-in (lip position)', 'firmness (lip damping)'] }),
      hover: (on) => (this.upperLip.material as THREE.MeshStandardMaterial).emissive.setHex(on ? 0x331111 : 0),
    });
    ix.add({
      objects: [this.tongue.mesh, this.tongue.cap], priority: 1,
      tooltip: paramTooltip(st, [P.tongue_x, P.tongue_y, P.tongue_tip], 'Tongue'),
      drag: planarDrag(frame, st, [P.tongue_x, P.tongue_y], (l, l0, s0) => {
        st.set(P.tongue_x, s0[0] + (l.x - l0.x) / (-0.032), 'drag');
        st.set(P.tongue_y, s0[1] + (l.y - l0.y) / 0.038, 'drag');
      }, { ranges: [0.032, 0.038] }),
      hover: (on) => this.tongueMat.emissive.setHex(on ? 0x331018 : 0),
    });
  }
}

const Y_UP = new THREE.Vector3(0, 1, 0);
const TORSO_PTS: [number, number, number][] = [[-0.01, -0.26, -0.06], [-0.01, -0.2, -0.04], [-0.005, -0.15, 0], [0, -0.08, 0], [0, -0.02, 0]];
const _m = new THREE.Matrix4();

/** Resample polyline `pts` uniformly by arc length into `out` (S xy pairs). Allocation-free. */
function sampleByArc(pts: V2[], S: number, out: Float32Array): void {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let seg = 0, acc = 0;
  for (let k = 0; k < S; k++) {
    const target = (L * k) / (S - 1);
    while (seg < pts.length - 2) {
      const l = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
      if (acc + l >= target) break;
      acc += l;
      seg++;
    }
    const l = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]) || 1;
    const t = Math.min(1, Math.max(0, (target - acc) / l));
    out[k * 2] = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t;
    out[k * 2 + 1] = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t;
  }
}
