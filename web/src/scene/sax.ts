// Procedural saxophone body built from the geometry JSON.
//
// Everything is placed from data/alto_sax.json: bore + wall profile and the 3D centreline give the
// tube (analytic normals through the bow and bell flare), tone holes give chimneys with soldered
// collars, pad cups (domed leather pads + resonators) on hinge barrels with rods and posts, key guards
// over the low pads; key touch positions give pearls/spatulas and the thumb rests / strap ring
// are placed relative to them. Static parts are merged per material (few draw calls); only pad cups
// and key touches are separate objects because they move.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { BorePath } from './borePath';
import type { KeyDef, SaxGeometry, ToneHole } from './geometry';
import { ACTIVE, HIGHLIGHT, type Materials } from './materials';

const WALL = 0.0007;
const AROUND = 64;
/** texture tiles per metre along the tube / repeats around it */
const UV_ALONG = 1 / 0.05;
const UV_AROUND = 6;
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3(), _b = new THREE.Vector3();
const _q = new THREE.Vector3(), _r = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

export const PROFILE_TEX = 256;

/**
 * Swept tube along the bore path. `radius(x)` defaults to the acoustic radius + offset. Normals are
 * analytic (radial direction tilted by the wall slope), so the bow and bell flare shade smoothly and
 * the seam is invisible.
 */
export function buildTube(
  path: BorePath, x0: number, x1: number, rings: number, offset: number, inward: boolean, around = AROUND,
  radius?: (x: number) => number,
): THREE.BufferGeometry {
  const R = radius ?? ((x: number) => path.radiusAt(x) + offset);
  const nv = (rings + 1) * (around + 1);
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const bu = new Float32Array(nv);
  const uv = new Float32Array(nv * 2);
  const h = Math.max(1e-4, (x1 - x0) / rings / 2);
  let k = 0;
  let s = 0;
  const prev = new THREE.Vector3();
  for (let i = 0; i <= rings; i++) {
    const x = x0 + ((x1 - x0) * i) / rings;
    path.frameAt(x, _p, _t, _n, _b);
    if (i > 0) s += _p.distanceTo(prev);
    prev.copy(_p);
    const r = R(x);
    // wall slope dR/ds (s = 3D arc length; the bell drawing is stretched relative to acoustic x)
    const xa = Math.max(path.xStart, x - h), xb = Math.min(path.xEnd, x + h);
    path.pointAt(xa, _q);
    path.pointAt(xb, _r);
    const ds = Math.max(1e-6, _q.distanceTo(_r));
    const slope = (R(xb) - R(xa)) / ds;
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const dx = c * _n.x + sn * _b.x, dy = c * _n.y + sn * _b.y, dz = c * _n.z + sn * _b.z;
      pos[k * 3] = _p.x + r * dx;
      pos[k * 3 + 1] = _p.y + r * dy;
      pos[k * 3 + 2] = _p.z + r * dz;
      let nx = dx - slope * _t.x, ny = dy - slope * _t.y, nz = dz - slope * _t.z;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      nrm[k * 3] = nx; nrm[k * 3 + 1] = ny; nrm[k * 3 + 2] = nz;
      bu[k] = x / path.xEnd;
      uv[k * 2] = (j / around) * UV_AROUND;
      uv[k * 2 + 1] = s * UV_ALONG;
      k++;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j, b = a + around + 1;
      if (inward) idx.push(a, a + 1, b, b, a + 1, b + 1);
      else idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('bu', new THREE.BufferAttribute(bu, 1));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Inner bore surface: lacquered brass seen from inside, with the standing pressure wave added as
 * emission (orange +, blue −, warm RMS glow) — read through the bell or with X-ray.
 */
export function makeWaveMaterial(tex: THREE.DataTexture): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xb98a3e, metalness: 1, roughness: 0.38, side: THREE.BackSide });
  const uniforms = {
    uTex: { value: tex },
    uScale: { value: 1 / 2000 },
    uRmsScale: { value: 1 / 2000 },
    uXray: { value: 0 },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float bu;\nvarying float vU;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvU = bu;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uTex;\nuniform float uScale;\nuniform float uRmsScale;\nuniform float uXray;\nvarying float vU;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0 - 0.8 * uXray;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec4 wv = texture2D(uTex, vec2(vU, 0.5));
        float wp = clamp(wv.r * uScale, -1.0, 1.0);
        float wr = clamp(wv.g * uRmsScale, 0.0, 1.0);
        vec3 wpos = vec3(1.0, 0.42, 0.06);
        vec3 wneg = vec3(0.08, 0.6, 1.0);
        totalEmissiveRadiance += (wp > 0.0 ? wpos : wneg) * abs(wp) * 2.2 + vec3(1.0, 0.85, 0.55) * wr * 0.45
          + vec3(0.06, 0.045, 0.02) * uXray;`,
      );
  };
  m.customProgramCacheKey = () => 'boreWave';
  return m;
}

interface HoleView {
  def: ToneHole;
  pivot: THREE.Object3D;
  /** child of the pivot that carries the hinge rotation (pivot = static hinge frame) */
  swing: THREE.Object3D;
  /** displayed openness 0..1 */
  open: number;
  lift: number;
  cupR: number;
  top: THREE.Vector3;
  /** hinge: 'lat' = rod along the bore beside the cup (rotate about local X), 'tan' = hinge at the cup edge (local Z) */
  hinge: 'lat' | 'tan';
  side: number;
  arm: number;
}

export interface KeyView {
  def: KeyDef;
  index: number;
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshPhysicalMaterial;
  outward: THREE.Vector3;
  rest: THREE.Vector3;
  press: number;
  hover: boolean;
}

/** collects static geometry per material, merged into one mesh each */
class Merger {
  private parts: THREE.BufferGeometry[] = [];
  add(g: THREE.BufferGeometry, m?: THREE.Matrix4, cavity = 0): void {
    let q = g;
    if (!q.index) {
      const n = q.getAttribute('position').count;
      q.setIndex(Array.from({ length: n }, (_v, i) => i));
    }
    if (m) q = q.applyMatrix4(m);
    for (const k of Object.keys(q.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') q.deleteAttribute(k);
    const n = q.getAttribute('position').count;
    if (!q.getAttribute('normal')) q.computeVertexNormals();
    if (!q.getAttribute('uv')) q.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    q.setAttribute('cavity', new THREE.BufferAttribute(new Float32Array(n).fill(cavity), 1));
    q.clearGroups();
    this.parts.push(q);
  }
  build(mat: THREE.Material, name: string): THREE.Mesh | null {
    if (!this.parts.length) return null;
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    if (!g) return null;
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    return mesh;
  }
}

/** a soft dark "cavity" spot that tarnish collects in (applied to the tube vertices) */
interface CavitySrc { p: THREE.Vector3; r: number; fall: number; w: number; x: number }

// unit lathe profiles (radius in units of cup radius, height in metres; solid on the left of the walk)
const CUP_PROFILE: [number, number][] = [[0, 0.003], [0.955, 0.003], [0.955, 0.0007], [1.0, 0.0005], [1.025, 0.0011], [1.03, 0.0027], [1.0, 0.0038], [0.93, 0.0045], [0.7, 0.0051], [0.35, 0.0055], [0, 0.0056]];
const PAD_PROFILE: [number, number][] = [[0, -0.00045], [0.5, -0.00032], [0.8, -0.0001], [0.93, 0.0002], [0.955, 0.0009], [0.955, 0.003], [0, 0.003]];
const RESO_PROFILE: [number, number][] = [[0, -0.0014], [0.06, -0.0014], [0.085, -0.0011], [0.11, -0.0009], [0.3, -0.00075], [0.46, -0.0006], [0.5, -0.00035], [0.5, -0.0002], [0, -0.0002]];

function lathe(profile: [number, number][], seg: number): THREE.LatheGeometry {
  return new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(p[0], p[1])), seg);
}

export class SaxModel {
  readonly group = new THREE.Group();
  readonly holes: HoleView[] = [];
  readonly holeIndex = new Map<string, number>();
  readonly keys: KeyView[] = [];
  readonly profileData = new Float32Array(PROFILE_TEX * 4);
  readonly profileTex: THREE.DataTexture;
  readonly waveMaterial: THREE.MeshPhysicalMaterial;
  readonly waveLine: Line2;
  private waveBasePos: Float32Array;
  private waveNrm: Float32Array;
  private wavePosArr: Float32Array;
  private waveColArr: Float32Array;
  private wavePosBuf: THREE.InterleavedBuffer;
  private waveColBuf: THREE.InterleavedBuffer;
  /** metres of line displacement at full-scale pressure */
  waveAmp = 0.012;
  readonly innerMesh: THREE.Mesh;
  /** true when something moved during the last update (pads/keys) — used to refresh shadows */
  moved = true;

  private brassM = new Merger();
  private keyBrassM = new Merger();
  private nickelM = new Merger();
  private darkM = new Merger();
  private plasticM = new Merger();
  private cavities: CavitySrc[] = [];
  private unitCup = lathe(CUP_PROFILE, 48);
  private unitPad = lathe(PAD_PROFILE, 40);
  private unitReso = lathe(RESO_PROFILE, 32);
  private plastic = new THREE.MeshPhysicalMaterial({ color: 0x141416, roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.3 });

  constructor(readonly geo: SaxGeometry, readonly path: BorePath, readonly mats: Materials) {
    this.profileTex = new THREE.DataTexture(this.profileData, PROFILE_TEX, 1, THREE.RGBAFormat, THREE.FloatType);
    this.profileTex.magFilter = THREE.LinearFilter;
    this.profileTex.minFilter = THREE.LinearFilter;
    this.profileTex.needsUpdate = true;
    this.waveMaterial = makeWaveMaterial(this.profileTex);
    mats.onXray((on) => { (this.waveMaterial.userData.uniforms as { uXray: { value: number } }).uXray.value = on ? 1 : 0; });

    const xN = path.xNeck, xB = path.xBody, xE = path.xEnd;
    const outerR = (x: number): number => path.wallRadiusAt(x) + WALL;
    const ringsFor = (len: number): number => Math.max(24, Math.round(len * 650));

    // ---- tone holes (pass 1: placement; pass 2: build with hinge sides that avoid neighbours) -----
    const placed = geo.tone_holes.map((h) => this.placeHole(h));
    geo.tone_holes.forEach((h, i) => {
      this.holeIndex.set(h.id, i);
      this.holes.push(this.buildHole(h, placed[i], placed));
    });
    geo.keys.forEach((k, i) => this.keys.push(this.buildKey(k, i)));

    // ---- fittings -------------------------------------------------------------------------------
    this.buildFittings(outerR);

    // ---- neck + body outer brass (cavity mask from the fittings collected above) -----------------
    const neckG = buildTube(path, xN, xB, ringsFor(xB - xN), 0, false, AROUND, outerR);
    const bodyG = buildTube(path, xB, xE, ringsFor(xE - xB), 0, false, AROUND, outerR);
    this.applyCavity(neckG, false);
    this.applyCavity(bodyG, true);
    const neck = new THREE.Mesh(neckG, mats.brass);
    const body = new THREE.Mesh(bodyG, mats.brass);
    neck.name = 'neck';
    body.name = 'body';
    this.group.add(neck, body);
    // inner bore surface (whole air column from the neck) with the wave emission
    // (starts at the neck: the mouthpiece interior is drawn by MouthpieceModel and must stay visible in the cutaway)
    this.innerMesh = new THREE.Mesh(
      buildTube(path, xN, xE, ringsFor(xE - xN), 0, false, 40, (x) => Math.min(path.radiusAt(x), path.wallRadiusAt(x)) - 0.0002),
      this.waveMaterial,
    );
    this.innerMesh.renderOrder = -1;
    this.group.add(this.innerMesh);

    // merged static parts
    const add = (m: THREE.Mesh | null, cast = true): void => {
      if (!m) return;
      m.castShadow = cast;
      m.receiveShadow = true;
      this.group.add(m);
    };
    add(this.brassM.build(mats.brass, 'fittings'));
    add(this.keyBrassM.build(mats.keyBrass, 'keywork'));
    add(this.nickelM.build(mats.nickel, 'rods'));
    add(this.darkM.build(mats.brassDark, 'chimneyInner'), false);
    add(this.plasticM.build(this.plastic, 'thumbrests'));
    for (const m of [neck, body]) { m.castShadow = true; m.receiveShadow = true; }

    // ---- standing-wave glow line along the centreline (fat line, drawn on top) -------------------
    const n = PROFILE_TEX;
    this.waveBasePos = new Float32Array(n * 3);
    this.waveNrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = (xE * i) / (n - 1);
      path.frameAt(x, _p, _t, _n, _b);
      _p.toArray(this.waveBasePos, i * 3);
      _n.toArray(this.waveNrm, i * 3);
    }
    const lg = new LineGeometry();
    lg.setPositions(this.waveBasePos);
    lg.setColors(new Float32Array(n * 3).fill(0.5));
    const lm = new LineMaterial({ vertexColors: true, linewidth: 2.6, worldUnits: false, transparent: true, opacity: 0.95, depthTest: true, depthWrite: false });
    this.waveLine = new Line2(lg, lm);
    // opaque body: depth-tested (only seen through the bell / cutaway); X-ray: drawn on top
    mats.onXray((on) => { lm.depthTest = !on; lm.needsUpdate = true; });
    this.waveLine.renderOrder = 10;
    this.waveLine.frustumCulled = false;
    this.waveLine.userData.noAO = true;
    this.wavePosBuf = (lg.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute).data;
    this.waveColBuf = (lg.getAttribute('instanceColorStart') as THREE.InterleavedBufferAttribute).data;
    this.wavePosArr = this.wavePosBuf.array as Float32Array;
    this.waveColArr = this.waveColBuf.array as Float32Array;
    this.group.add(this.waveLine);
  }

  // ---- geometry helpers ----------------------------------------------------------------------------
  private holeDir(h: ToneHole, out: THREE.Vector3): THREE.Vector3 {
    path_frame(this.path, h.x);
    const a = (h.angle_deg * Math.PI) / 180;
    return out.copy(_n).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a)).normalize();
  }

  /** point on the outer wall at bore x, angle θ (data convention) */
  private surfaceAt(x: number, deg: number, out: THREE.Vector3, dir?: THREE.Vector3): THREE.Vector3 {
    path_frame(this.path, x);
    const a = (deg * Math.PI) / 180;
    const d = _q.copy(_n).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a)).normalize();
    if (dir) dir.copy(d);
    return out.copy(_p).addScaledVector(d, this.path.wallRadiusAt(x) + WALL);
  }

  /** project a world point radially onto the outer wall; returns the foot, `dir` = outward normal there */
  private foot(p: THREE.Vector3, out: THREE.Vector3, dir: THREE.Vector3): number {
    const x = this.refineX(p);
    path_frame(this.path, x);
    dir.copy(p).sub(_p);
    dir.addScaledVector(_t, -dir.dot(_t));
    if (dir.lengthSq() < 1e-10) dir.copy(_n);
    dir.normalize();
    out.copy(_p).addScaledVector(dir, this.path.wallRadiusAt(x) + WALL * 0.5);
    return x;
  }

  /** nearest bore x (coarse search + local refinement) */
  private refineX(p: THREE.Vector3): number {
    let x = this.path.nearestX(p);
    const step = (this.path.xEnd - this.path.xStart) / 800;
    let best = Infinity, bx = x;
    for (let i = -8; i <= 8; i++) {
      const xi = Math.min(this.path.xEnd, Math.max(this.path.xStart, x + (i * step) / 4));
      this.path.pointAt(xi, _r);
      const d = _r.distanceToSquared(p);
      if (d < best) { best = d; bx = xi; }
    }
    x = bx;
    return x;
  }

  /** cylinder between two points */
  private rodGeo(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 10): { g: THREE.BufferGeometry; m: THREE.Matrix4 } {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
    const q = new THREE.Quaternion().setFromUnitVectors(Y, _r.copy(b).sub(a).normalize());
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    return { g, m };
  }

  /** post: foot plate on the wall, pillar, ball head at `head` */
  private post(head: THREE.Vector3, r = 0.0018): void {
    const f = new THREE.Vector3(), d = new THREE.Vector3();
    const x = this.foot(head, f, d);
    const len = f.distanceTo(head);
    if (len > 0.03) return;
    const rod = this.rodGeo(f, head, r, 12);
    this.keyBrassM.add(rod.g, rod.m);
    this.keyBrassM.add(new THREE.SphereGeometry(r * 1.35, 14, 10), new THREE.Matrix4().makeTranslation(head.x, head.y, head.z));
    // soldered foot plate (brass), slightly sunk into the wall
    const plate = new THREE.CylinderGeometry(r * 2.4, r * 2.8, 0.0012, 16);
    const q = new THREE.Quaternion().setFromUnitVectors(Y, d);
    this.brassM.add(plate, new THREE.Matrix4().compose(f.clone().addScaledVector(d, 0.0002), q, new THREE.Vector3(1, 1, 1)), 0.3);
    this.cavities.push({ p: f.clone(), r: r * 2.8, fall: 0.003, w: 0.6, x });
  }

  private placeHole(h: ToneHole): { top: THREE.Vector3; dir: THREE.Vector3; e: THREE.Vector3; k: THREE.Vector3; center: THREE.Vector3; cupR: number; rb: number } {
    const dir = this.holeDir(h, new THREE.Vector3());
    const center = _p.clone();
    const tan = _t.clone();
    const rb = this.path.wallRadiusAt(h.x) + WALL;
    const hgt = Math.max(0.0015, h.chimney);
    const top = center.clone().addScaledVector(dir, rb + hgt);
    const e = tan.addScaledVector(dir, -tan.dot(dir)).normalize();
    const k = new THREE.Vector3().crossVectors(e, dir);
    const cupR = h.radius * 1.18 + 0.0012;
    return { top, dir, e, k, center, cupR, rb };
  }

  private buildHole(h: ToneHole, pl: ReturnType<SaxModel['placeHole']>, all: ReturnType<SaxModel['placeHole']>[]): HoleView {
    const { top, dir, e, k, center, cupR, rb } = pl;
    const r = h.radius;
    const a = r + WALL;
    // chimney from the lowest point of the saddle (so the sides never show a gap) to the rim
    const base = Math.sqrt(Math.max(0, rb * rb - a * a)) - 0.0008;
    const hgt = rb + Math.max(0.0015, h.chimney) - base;
    const qDir = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(e, dir, k));
    const chimM = new THREE.Matrix4().compose(center.clone().addScaledVector(dir, base + hgt / 2), qDir, new THREE.Vector3(1, 1, 1));
    this.brassM.add(new THREE.CylinderGeometry(a, a, hgt, 40, 1, true), chimM);
    this.darkM.add(new THREE.CylinderGeometry(a * 0.97, a * 0.97, hgt, 32, 1, true), chimM);
    // rolled rim
    const rimM = new THREE.Matrix4().compose(top, new THREE.Quaternion().setFromUnitVectors(Z, dir), new THREE.Vector3(1, 1, 1));
    this.brassM.add(new THREE.TorusGeometry(r + WALL * 0.5, WALL * 0.9, 8, 40), rimM);
    // solder collar following the saddle where the chimney meets the tube
    const pts: THREE.Vector3[] = [];
    const ac = a + 0.0005;
    for (let i = 0; i < 48; i++) {
      const ph = (i / 48) * Math.PI * 2;
      const w = ac * Math.sin(ph);
      const hh = Math.sqrt(Math.max(0, rb * rb - w * w));
      pts.push(center.clone().addScaledVector(e, ac * Math.cos(ph)).addScaledVector(k, w).addScaledVector(dir, hh));
    }
    this.brassM.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 64, 0.0008, 6, true), undefined, 0.5);
    this.cavities.push({ p: center.clone().addScaledVector(dir, rb), r: a, fall: 0.0035, w: 1, x: h.x });

    // ---- pad cup on a hinge ---------------------------------------------------------------------
    const small = cupR < 0.0045;
    const hinge: 'lat' | 'tan' = small ? 'tan' : 'lat';
    const gap = 0.0042;
    const off = cupR + gap;
    let side = 1;
    const lift = Math.max(0.002, h.pad_open_height);
    if (hinge === 'lat') {
      // pick the side (±k) with the most clearance from other cups and from the rest of the tube
      const clearance = (s: number): number => {
        let best = Infinity;
        const c0 = top.clone().addScaledVector(dir, 0.0025).addScaledVector(k, s * off);
        const L = cupR + 0.004;
        for (const c of [c0, c0.clone().addScaledVector(e, L), c0.clone().addScaledVector(e, -L)]) {
          for (const o of all) {
            if (o === pl) continue;
            best = Math.min(best, c.distanceTo(o.top) - o.cupR);
          }
          for (let i = 0; i < 120; i++) {
            const xi = this.path.xStart + ((this.path.xEnd - this.path.xStart) * i) / 119;
            if (Math.abs(xi - h.x) < 0.07) continue;
            this.path.pointAt(xi, _r);
            best = Math.min(best, c.distanceTo(_r) - this.path.wallRadiusAt(xi) - 0.002);
          }
        }
        return best;
      };
      side = clearance(1) >= clearance(-1) ? 1 : -1;
    }
    const pivot = new THREE.Object3D();
    pivot.quaternion.copy(qDir);
    const swing = new THREE.Object3D();
    pivot.add(swing);
    const cupGroup = new THREE.Group();
    const hingeH = 0.0026;
    if (hinge === 'lat') {
      pivot.position.copy(top).addScaledVector(dir, hingeH).addScaledVector(k, side * off);
      cupGroup.position.set(0, -hingeH, -side * off);
    } else {
      pivot.position.copy(top).addScaledVector(e, cupR);
      cupGroup.position.set(-cupR, 0, 0);
    }
    const pad = new THREE.Mesh(this.unitPad, this.mats.pad);
    const cup = new THREE.Mesh(this.unitCup, this.mats.keyBrass);
    const reso = new THREE.Mesh(this.unitReso, this.mats.resonator);
    for (const m of [pad, cup, reso]) {
      m.scale.set(cupR, 1, cupR);
      m.castShadow = true;
      m.receiveShadow = true;
    }
    cupGroup.add(pad, cup, reso);
    swing.add(cupGroup);
    if (hinge === 'lat') {
      // arm from the cup to the hinge barrel (moves with the cup) + barrel on the rod
      const armG = new THREE.BoxGeometry(0.0034, 0.0016, off - cupR * 0.8);
      const arm = new THREE.Mesh(armG, this.mats.keyBrass);
      arm.position.set(0, -hingeH + 0.0046, -side * (off + cupR * 0.8) / 2);
      arm.rotation.x = side * 0.18;
      const barrelL = Math.min(0.03, 2 * cupR * 0.8);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0021, 0.0021, barrelL, 16).rotateZ(Math.PI / 2), this.mats.keyBrass);
      for (const m of [arm, barrel]) { m.castShadow = true; m.receiveShadow = true; }
      swing.add(arm, barrel);
      // static rod through the barrel, posts at both ends
      const L = cupR + 0.006;
      const r0 = pivot.position.clone().addScaledVector(e, -L), r1 = pivot.position.clone().addScaledVector(e, L);
      const rod = this.rodGeo(r0, r1, 0.0015, 12);
      this.keyBrassM.add(rod.g, rod.m);
      this.post(r0);
      this.post(r1);
      // low pads: wire guard around the open side of the cup, on three legs
      if (h.radius >= 0.017 && h.x >= 0.69) this.guard(top, dir, e, k, side, cupR, lift);
    } else {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0013, 0.0013, Math.max(0.004, cupR * 1.4), 12).rotateX(Math.PI / 2), this.mats.keyBrass);
      swing.add(barrel);
    }
    this.group.add(pivot);
    return { def: h, pivot, swing, open: h.pad_rest === 'open' ? 1 : 0, lift, cupR, top, hinge, side, arm: hinge === 'lat' ? off : cupR };
  }

  private guard(top: THREE.Vector3, dir: THREE.Vector3, e: THREE.Vector3, k: THREE.Vector3, side: number, cupR: number, lift: number): void {
    const a = k.clone().multiplyScalar(-side); // away from the hinge
    const R = cupR + 0.0045;
    const H = lift + 0.0062;
    const pts: THREE.Vector3[] = [];
    const span = (80 * Math.PI) / 180;
    for (let i = 0; i <= 16; i++) {
      const ph = -span + (2 * span * i) / 16;
      pts.push(top.clone().addScaledVector(dir, H).addScaledVector(a, R * Math.cos(ph)).addScaledVector(e, R * Math.sin(ph)));
    }
    this.keyBrassM.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.0017, 10, false));
    for (const i of [0, 8, 16]) {
      const p = pts[i];
      const f = new THREE.Vector3(), d = new THREE.Vector3();
      const x = this.foot(p, f, d);
      const rod = this.rodGeo(f, p, 0.0016, 10);
      this.keyBrassM.add(rod.g, rod.m);
      this.keyBrassM.add(new THREE.SphereGeometry(0.0013, 8, 6), new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
      const plate = new THREE.CylinderGeometry(0.0028, 0.0034, 0.001, 12);
      this.brassM.add(plate, new THREE.Matrix4().compose(f, new THREE.Quaternion().setFromUnitVectors(Y, d), new THREE.Vector3(1, 1, 1)), 0.3);
      this.cavities.push({ p: f.clone(), r: 0.0034, fall: 0.003, w: 0.5, x });
    }
  }

  /** bell rim bead, neck receiver + screw, bow ferrules, bell-to-body brace, thumb rests, strap ring */
  private buildFittings(outerR: (x: number) => number): void {
    const path = this.path, g = this.geo;
    const xB = path.xBody, xE = path.xEnd;
    const ring = (x: number, R: number, tube: number, merger: Merger, seg = 96): void => {
      path_frame(path, x);
      merger.add(new THREE.TorusGeometry(R, tube, 12, seg), new THREE.Matrix4().compose(_p.clone(), new THREE.Quaternion().setFromUnitVectors(Z, _t), new THREE.Vector3(1, 1, 1)));
    };
    const band = (x: number, R: number, len: number, merger: Merger): void => {
      path_frame(path, x);
      merger.add(new THREE.CylinderGeometry(R, R, len, 72, 1, true), new THREE.Matrix4().compose(_p.clone(), new THREE.Quaternion().setFromUnitVectors(Y, _t), new THREE.Vector3(1, 1, 1)));
      ring(x - len / 2, R, 0.0007, merger, 72);
      ring(x + len / 2, R, 0.0007, merger, 72);
    };
    // bell: rolled rim bead
    ring(xE, outerR(xE) + 0.0008, 0.0024, this.brassM, 160);
    // neck tenon receiver on the body + neck ring, tightening screw on the thumb side
    band(xB + 0.006, outerR(xB + 0.006) + 0.0016, 0.014, this.brassM);
    ring(xB - 0.004, outerR(xB - 0.004) + 0.0009, 0.0012, this.brassM, 72);
    {
      const s = new THREE.Vector3(), d = new THREE.Vector3();
      this.surfaceAt(xB + 0.006, 270, s, d);
      s.addScaledVector(d, 0.0016);
      const tip = s.clone().addScaledVector(d, 0.009);
      const rod = this.rodGeo(s, tip, 0.0016, 12);
      this.nickelM.add(rod.g, rod.m);
      const knob = this.rodGeo(tip, tip.clone().addScaledVector(d, 0.0035), 0.0042, 20);
      this.nickelM.add(knob.g, knob.m);
    }
    // bow socket ferrules
    const bow = g.body.bow as { x_start?: number; x_end?: number } | undefined;
    if (bow?.x_start && bow.x_end) {
      for (const x of [bow.x_start, bow.x_end]) band(x, outerR(x) + 0.0009, 0.009, this.brassM);
      // bell-to-body brace: from the body tube above the bow to the bell tube at the same height
      const xb = bow.x_start - 0.09;
      const pb = path.pointAt(xb, new THREE.Vector3());
      let bx = bow.x_end, bd = Infinity;
      for (let x = bow.x_end + 0.01; x < xE - 0.05; x += 0.002) {
        path.pointAt(x, _r);
        const d = Math.abs(_r.y - pb.y);
        if (d < bd) { bd = d; bx = x; }
      }
      const pc = path.pointAt(bx, new THREE.Vector3());
      const dirBC = pc.clone().sub(pb).normalize();
      const s0 = pb.clone().addScaledVector(dirBC, outerR(xb));
      const s1 = pc.clone().addScaledVector(dirBC, -outerR(bx));
      if (s0.distanceTo(s1) > 0.005 && s0.distanceTo(s1) < 0.08) {
        const rod = this.rodGeo(s0, s1, 0.0032, 16);
        this.brassM.add(rod.g, rod.m);
        for (const [p, n, x] of [[s0, dirBC, xb], [s1, dirBC.clone().negate(), bx]] as [THREE.Vector3, THREE.Vector3, number][]) {
          const plate = new THREE.CylinderGeometry(0.0055, 0.0065, 0.0016, 20);
          this.brassM.add(plate, new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromUnitVectors(Y, n), new THREE.Vector3(1, 1.6, 1)));
          this.cavities.push({ p: p.clone(), r: 0.0065, fall: 0.004, w: 0.7, x });
        }
      }
    }
    // thumb rests from the key touch positions (left: below the octave thumb key; right: below RH3)
    const oct = g.keys.find((k) => (k.kind ?? '').includes('octave') && k.position);
    const rh = g.keys.filter((k) => k.hand === 'R' && (k.kind ?? '') === 'pearl' && k.position);
    const atY = (y: number): number => this.refineX(new THREE.Vector3(0, y, 0));
    if (oct?.position) {
      const x = atY(oct.position[1] - 0.022);
      const s = new THREE.Vector3(), d = new THREE.Vector3();
      this.surfaceAt(x, 270, s, d);
      const q = new THREE.Quaternion().setFromUnitVectors(Y, d);
      this.brassM.add(new THREE.CylinderGeometry(0.0062, 0.0066, 0.0035, 24), new THREE.Matrix4().compose(s.clone().addScaledVector(d, 0.0015), q, new THREE.Vector3(1, 1, 1)), 0.3);
      this.plasticM.add(new THREE.SphereGeometry(0.0085, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.32, 1), new THREE.Matrix4().compose(s.clone().addScaledVector(d, 0.0032), q, new THREE.Vector3(1, 1, 1)));
      this.cavities.push({ p: s.clone(), r: 0.0066, fall: 0.003, w: 0.6, x });
    }
    if (rh.length) {
      const yMin = Math.min(...rh.map((k) => k.position![1]));
      const yMean = rh.reduce((a, k) => a + k.position![1], 0) / rh.length;
      const x = atY(yMean - 0.01);
      const s = new THREE.Vector3(), d = new THREE.Vector3();
      this.surfaceAt(x, 270, s, d);
      path_frame(path, x);
      const tdown = _t.clone(); // +x along the bore = downward on the body
      const lat = new THREE.Vector3().crossVectors(d, tdown).normalize();
      const basis = new THREE.Matrix4().makeBasis(tdown, d, lat);
      const q = new THREE.Quaternion().setFromRotationMatrix(basis);
      // base plate on the wall + hook curling downward (the thumb pushes up under it)
      this.brassM.add(new THREE.BoxGeometry(0.026, 0.0024, 0.013), new THREE.Matrix4().compose(s.clone().addScaledVector(d, 0.0008), q, new THREE.Vector3(1, 1, 1)), 0.3);
      const hook: THREE.Vector3[] = [[-0.008, 0.0], [-0.006, 0.006], [0.0, 0.011], [0.008, 0.012], [0.013, 0.009]].map(([u, v]) =>
        s.clone().addScaledVector(tdown, u).addScaledVector(d, v + 0.001));
      const hg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hook), 24, 0.0019, 10, false);
      // flatten the hook into a strap: scale across (lat) about its own centre line
      const cen = s.clone();
      const toL = new THREE.Matrix4().makeBasis(tdown, d, lat).setPosition(cen);
      const fromL = toL.clone().invert();
      hg.applyMatrix4(fromL).scale(1, 1, 3.4).applyMatrix4(toL);
      this.plasticM.add(hg);
      this.cavities.push({ p: s.clone(), r: 0.012, fall: 0.003, w: 0.5, x });
      void yMin;
      // strap ring on the back, between the thumbs
      if (oct?.position) {
        const xs = atY((oct.position[1] + yMean) / 2 + 0.02);
        const ss = new THREE.Vector3(), ds = new THREE.Vector3();
        this.surfaceAt(xs, 200, ss, ds);
        path_frame(path, xs);
        const tt = _t.clone();
        this.brassM.add(new THREE.CylinderGeometry(0.0035, 0.0042, 0.006, 16), new THREE.Matrix4().compose(ss.clone().addScaledVector(ds, 0.002), new THREE.Quaternion().setFromUnitVectors(Y, ds), new THREE.Vector3(1, 1, 1)), 0.3);
        const ringC = ss.clone().addScaledVector(ds, 0.0095);
        const ringBasis = new THREE.Matrix4().makeBasis(ds, tt, new THREE.Vector3().crossVectors(ds, tt));
        const tq = new THREE.Quaternion().setFromRotationMatrix(ringBasis);
        this.nickelM.add(new THREE.TorusGeometry(0.0055, 0.0011, 10, 32).rotateY(Math.PI / 2), new THREE.Matrix4().compose(ringC, tq, new THREE.Vector3(1, 1, 1)));
        this.cavities.push({ p: ss.clone(), r: 0.0042, fall: 0.003, w: 0.6, x: xs });
      }
    }
  }

  /** per-vertex tarnish mask on the tube: halos around collars/posts + the inside of the bow */
  private applyCavity(g: THREE.BufferGeometry, bowCrease: boolean): void {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const bu = g.getAttribute('bu') as THREE.BufferAttribute;
    const n = pos.count;
    const cav = new Float32Array(n);
    const v = new THREE.Vector3();
    const xEnd = this.path.xEnd;
    const bow = this.geo.body.bow as { x_start?: number; x_end?: number } | undefined;
    const kappa = new THREE.Vector3(), c = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      const x = bu.getX(i) * xEnd;
      let s = 0;
      for (const src of this.cavities) {
        if (Math.abs(src.x - x) > 0.05) continue;
        const d = v.distanceTo(src.p) - src.r;
        if (d < src.fall * 2.5) s = Math.max(s, src.w * Math.exp(-Math.max(0, d) / src.fall));
      }
      if (bowCrease && bow?.x_start && bow.x_end && x > bow.x_start - 0.01 && x < bow.x_end + 0.01) {
        // inner side of the bend (toward the centre of curvature)
        const hh = 0.01;
        this.path.pointAt(x - hh, a);
        this.path.pointAt(x, c);
        this.path.pointAt(x + hh, b);
        kappa.copy(a).add(b).addScaledVector(c, -2);
        if (kappa.lengthSq() > 1e-12) {
          kappa.normalize();
          const rad = v.clone().sub(c).normalize();
          const w = Math.max(0, rad.dot(kappa));
          s = Math.max(s, 0.45 * w ** 3);
        }
      }
      cav[i] = s;
    }
    g.setAttribute('cavity', new THREE.BufferAttribute(cav, 1));
  }

  private buildKey(k: KeyDef, index: number): KeyView {
    const p = k.position ? new THREE.Vector3(k.position[0], k.position[1], k.position[2]) : this.defaultKeyPos(k, index);
    const bx = this.path.nearestX(p);
    this.path.pointAt(bx, _p);
    const outward = p.clone().sub(_p);
    if (outward.lengthSq() < 1e-8) outward.copy(Z);
    outward.normalize();
    const kind = (k.kind ?? 'pearl').toLowerCase();
    const isPearl = kind.includes('pearl');
    const mat = (isPearl ? this.mats.pearl : this.mats.keyBrass).clone();
    mat.emissive = new THREE.Color(0);
    let g: THREE.BufferGeometry;
    if (isPearl) g = lathe([[0, 0], [0.0060, 0], [0.0062, 0.0005], [0.0057, 0.0014], [0.0042, 0.0022], [0.002, 0.0026], [0, 0.0027]], 40);
    else if (kind.includes('palm')) g = roundedBox(0.019, 0.0035, 0.009);
    else if (kind.includes('side')) g = roundedBox(0.016, 0.0035, 0.0075);
    else if (kind.includes('octave') || kind.includes('thumb')) g = roundedBox(0.017, 0.003, 0.009);
    else if (kind.includes('table')) g = roundedBox(0.012, 0.004, 0.009);
    else if (kind.includes('spatula')) g = roundedBox(0.015, 0.004, 0.01);
    else g = new THREE.SphereGeometry(0.005, 16, 10).scale(1, 0.5, 1);
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.position.copy(p);
    // local Y = outward; long axis (local X) along the bore tangent
    this.path.frameAt(bx, _p, _t, _n, _b);
    const tx = _t.clone().addScaledVector(outward, -_t.dot(outward)).normalize();
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tx, outward, new THREE.Vector3().crossVectors(tx, outward)));
    group.add(mesh);
    if (isPearl) {
      // brass bezel holding the pearl
      const bezel = new THREE.Mesh(lathe([[0.0056, -0.0018], [0.0076, -0.0018], [0.0079, -0.0006], [0.0075, 0.0007], [0.0064, 0.0008], [0.0059, -0.0002], [0.0056, -0.0018]], 40), this.mats.keyBrass);
      bezel.castShadow = true;
      group.add(bezel);
    }
    this.group.add(group);

    // arm from touch piece to the (first) pad it drives — visual only
    const hid = k.actions?.[0]?.hole ?? (kind.includes('octave') ? this.geo.tone_holes.find((h) => h.octave_vent)?.id : undefined);
    const hi = hid !== undefined ? this.geo.tone_holes.findIndex((h) => h.id === hid) : -1;
    if (hi >= 0) {
      const hv = this.holes[hi];
      const a = p.clone().addScaledVector(outward, -0.0028);
      const b = hv.top.clone().addScaledVector(this.holeDir(hv.def, new THREE.Vector3()), 0.0048);
      const len = a.distanceTo(b);
      if (len > 0.004 && len < 0.05) {
        const rod = this.rodGeo(a, b, 0.0012, 10);
        this.keyBrassM.add(rod.g, rod.m);
      }
    }
    return { def: k, index, group, mesh, material: mat, outward, rest: p.clone(), press: 0, hover: false };
  }

  private defaultKeyPos(_k: KeyDef, index: number): THREE.Vector3 {
    const x = this.path.xBody + 0.05 + index * 0.012;
    path_frame(this.path, x);
    return _p.clone().addScaledVector(_n, this.path.radiusAt(x) + 0.02);
  }

  setKeyHover(i: number, on: boolean): void {
    this.keys[i].hover = on;
  }

  /** pads: target openness per hole; keysDown: 0/1 per key */
  update(dt: number, padTarget: Float32Array, keysDown: Float32Array): boolean {
    let moved = false;
    const a = 1 - Math.exp(-dt / 0.018);
    for (let i = 0; i < this.holes.length; i++) {
      const h = this.holes[i];
      const tgt = padTarget[i] ?? 0;
      const d = (tgt - h.open) * a;
      if (Math.abs(d) > 1e-4) moved = true;
      h.open += d;
      const ang = Math.atan2(h.lift * h.open, h.arm);
      if (h.hinge === 'lat') h.swing.rotation.x = h.side * ang;
      else h.swing.rotation.z = -ang;
    }
    const ka = 1 - Math.exp(-dt / 0.03);
    for (const k of this.keys) {
      const down = keysDown[k.index] ?? 0;
      const d = (down - k.press) * ka;
      if (Math.abs(d) > 1e-4) moved = true;
      k.press += d;
      k.group.position.copy(k.rest).addScaledVector(k.outward, -0.0025 * k.press);
      const em = k.material.emissive;
      if (down > 0.5) em.copy(ACTIVE).multiplyScalar(0.55);
      else if (k.hover) em.copy(HIGHLIGHT).multiplyScalar(0.5);
      else em.setRGB(0, 0, 0);
    }
    this.moved = moved;
    return moved;
  }

  /** profile/rms: n samples reed→bell */
  setProfile(profile: Float32Array, rms: Float32Array, n: number, scalePa: number): void {
    const d = this.profileData;
    const lp = this.wavePosArr, lc = this.waveColArr;
    const N = PROFILE_TEX;
    for (let i = 0; i < N; i++) {
      let p = 0, r = 0;
      if (n > 1) {
        const f = (i / (N - 1)) * (n - 1);
        const j = Math.min(n - 2, Math.floor(f)), t = f - j;
        p = profile[j] + (profile[j + 1] - profile[j]) * t;
        r = rms[j] + (rms[j + 1] - rms[j]) * t;
      }
      d[i * 4] = p;
      d[i * 4 + 1] = r;
      const off = Math.max(-1.5, Math.min(1.5, p / scalePa)) * this.waveAmp;
      const px = this.waveBasePos[i * 3] + this.waveNrm[i * 3] * off;
      const py = this.waveBasePos[i * 3 + 1] + this.waveNrm[i * 3 + 1] * off;
      const pz = this.waveBasePos[i * 3 + 2] + this.waveNrm[i * 3 + 2] * off;
      const q = Math.max(-1, Math.min(1, p / scalePa));
      // HDR colours (> 1) so the glow line catches a little bloom
      let cr: number, cg: number, cb: number;
      if (q >= 0) { cr = 1; cg = 0.55 + 0.1 * (1 - q); cb = 0.15 + 0.6 * (1 - q); }
      else { cr = 0.2 + 0.6 * (1 + q); cg = 0.7; cb = 1; }
      const gain = 1.4 + 0.8 * Math.abs(q);
      cr *= gain; cg *= gain; cb *= gain;
      // segment i starts at point i; segment i-1 ends at point i
      if (i < N - 1) {
        lp[i * 6] = px; lp[i * 6 + 1] = py; lp[i * 6 + 2] = pz;
        lc[i * 6] = cr; lc[i * 6 + 1] = cg; lc[i * 6 + 2] = cb;
      }
      if (i > 0) {
        const k = (i - 1) * 6 + 3;
        lp[k] = px; lp[k + 1] = py; lp[k + 2] = pz;
        lc[k] = cr; lc[k + 1] = cg; lc[k + 2] = cb;
      }
    }
    this.wavePosBuf.needsUpdate = true;
    this.waveColBuf.needsUpdate = true;
    this.profileTex.needsUpdate = true;
    const u = this.waveMaterial.userData.uniforms as { uScale: { value: number }; uRmsScale: { value: number } };
    u.uScale.value = 1 / scalePa;
    u.uRmsScale.value = 1 / scalePa;
  }
}

function path_frame(path: BorePath, x: number): void {
  path.frameAt(x, _p, _t, _n, _b);
}

function roundedBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const r = Math.min(w, d) * 0.45;
  const x0 = -w / 2, z0 = -d / 2;
  s.moveTo(x0 + r, z0);
  s.lineTo(x0 + w - r, z0);
  s.quadraticCurveTo(x0 + w, z0, x0 + w, z0 + r);
  s.lineTo(x0 + w, z0 + d - r);
  s.quadraticCurveTo(x0 + w, z0 + d, x0 + w - r, z0 + d);
  s.lineTo(x0 + r, z0 + d);
  s.quadraticCurveTo(x0, z0 + d, x0, z0 + d - r);
  s.lineTo(x0, z0 + r);
  s.quadraticCurveTo(x0, z0, x0 + r, z0);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelSize: h * 0.35, bevelThickness: h * 0.35, bevelSegments: 4, curveSegments: 10 });
  g.rotateX(Math.PI / 2);
  g.translate(0, h / 2, 0);
  g.computeVertexNormals();
  return g;
}
