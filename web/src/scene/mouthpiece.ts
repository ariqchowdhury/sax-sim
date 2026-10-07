// Parametric mouthpiece (outer shell, interior baffle/chamber/throat, cut faces), reed and ligature.
// Local frame (`root`): origin = tip on bore axis, +X = into instrument (u), +Y = away from reed (v), +Z lateral.
// The cutaway keeps the -Z half (same convention as the player cutaway).
import * as THREE from 'three';
import { P } from '../engine/params';
import type { AppState } from '../state';
import type { BorePath } from './borePath';
import { interp } from './borePath';
import type { SaxGeometry } from './geometry';
import { axisDrag, handleMesh, paramTooltip, setHandleHover } from './handles';
import type { DragSpec, Interaction } from './interaction';
import type { Materials } from './materials';

const ST = 72; // stations along the mouthpiece
const AR = 36; // points around a section
export const HB = 0.0045; // table plane offset below axis (reed top surface at v = -HB)
const _v = new THREE.Vector3();
const SHAPE_IDS = [P.tip_opening, P.facing_length, P.baffle_height, P.chamber_size, P.throat_diameter];

/** engine geometry.rs::smooth_bump on [a,b]: 0 at the edges, ramps over 20 %, 1 in between */
function bump(x: number, a: number, b: number): number {
  if (b <= a) return 0;
  const u = (x - a) / (b - a);
  const e = 0.2;
  if (u <= 0 || u >= 1) return 0;
  if (u < e) { const t = u / e; return t * t * (3 - 2 * t); }
  if (u > 1 - e) { const t = (1 - u) / e; return t * t * (3 - 2 * t); }
  return 1;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

interface Section { w: number; top: number; bot: number; flat: number }

export class MouthpieceModel {
  readonly root = new THREE.Object3D();
  readonly L: number;
  private outer: THREE.Mesh;
  private inner: THREE.Mesh;
  private cutTop: THREE.Mesh;
  private cutBot: THREE.Mesh;
  private reed: THREE.Mesh;
  private reedMat: THREE.MeshStandardMaterial;
  private ligature = new THREE.Group();
  private handles: { mesh: THREE.Mesh; place: () => void }[] = [];
  readonly clipPlane = new THREE.Plane();
  private basePos = new THREE.Vector3();
  private axisW = new THREE.Vector3();
  private last = new Float64Array(5).fill(NaN);
  private reedLen: number;
  private reedW: number;
  private reedTip: number;
  private reedHeel: number;
  private profile: [number, number][];
  cutaway = false;
  /** shape or position changed in the last update (shadow refresh) */
  moved = true;
  /** anchor below the reed tip for the flow readout */
  readonly reedAnchor = new THREE.Object3D();
  /** +1: the cutaway keeps local +Z (away from the default camera); -1: keeps -Z */
  readonly far: number;
  private uw: number;
  private windowHalf: number;
  private airLen: number;
  private landmarks: { baffle_end: number; chamber_start: number; chamber_end: number; throat_x: number };
  /** reed displacement visual gain */
  reedGain = 3;
  /** displayed reed tip displacement (m, + toward lay) */
  reedY = 0;
  private reedMean = 0;
  /** distributed reed shape from telemetry (tip → clamp, m, + toward lay), when the engine provides it */
  private shape = new Float32Array(64);
  private shapeMean = new Float32Array(64);
  private shapeN = 0;
  private shapeAt = -1e9;
  /** tip → ligature clamp length the shape samples span (m) */
  private clampLen = 0.04;

  constructor(geo: SaxGeometry, path: BorePath, mats: Materials, private state: AppState) {
    this.L = geo.mouthpiece.length || 0.085;
    const r = geo.mouthpiece.reed ?? { length: 0.068, width: 0.017, tip_thickness: 0.0001, heel_thickness: 0.0028 };
    const rr = r as Record<string, unknown>;
    this.clampLen = typeof rr.l_clamp === 'number' ? rr.l_clamp : typeof rr.clamp_length === 'number' ? rr.clamp_length : 0.04;
    this.reedLen = r.length; this.reedW = r.width; this.reedTip = r.tip_thickness; this.reedHeel = r.heel_thickness;
    this.profile = geo.mouthpiece.profile as [number, number][];
    this.uw = (geo.mouthpiece.nominal?.window_length ?? 0.03) + 0.006;
    this.windowHalf = (geo.mouthpiece.nominal?.window_width ?? 0.0135) / 2;
    this.airLen = geo.mouthpiece.air_length ?? this.profile[this.profile.length - 1][0];
    const m = geo.mouthpiece as Record<string, unknown>;
    const num = (k: string): number | undefined => (typeof m[k] === 'number' ? (m[k] as number) : undefined);
    // landmarks exactly as engine geometry.rs (throat = narrowest point in the rear 60 % of the air length)
    const mpLen = this.airLen;
    let throatX = num('throat_x') ?? -1;
    if (throatX < 0) {
      let best = Infinity;
      for (const q of this.profile) if (q[0] > 0.4 * mpLen && q[0] < 0.95 * mpLen && q[1] < best) { best = q[1]; throatX = q[0]; }
      if (throatX < 0) throatX = 0.7 * mpLen;
    }
    const baffleEnd = num('baffle_end') ?? 0.3 * Math.min(throatX, mpLen);
    this.landmarks = {
      baffle_end: baffleEnd,
      chamber_start: num('chamber_start') ?? baffleEnd,
      chamber_end: num('chamber_end') ?? throatX - 0.1 * mpLen,
      throat_x: throatX,
    };

    // frame from bore path at x=0
    const p = new THREE.Vector3(), t = new THREE.Vector3(), n = new THREE.Vector3(), b = new THREE.Vector3();
    path.frameAt(0.001, p, t, n, b);
    path.pointAt(0, p);
    // reed side direction per data convention: d = cos θ·n + sin θ·X (θ = nominal.reed_side_angle_deg, default 180)
    const th = (((geo.mouthpiece.nominal?.reed_side_angle_deg as number | undefined) ?? 180) * Math.PI) / 180;
    const d = n.clone().multiplyScalar(Math.cos(th)).addScaledVector(b, Math.sin(th)).normalize();
    const yAx = d.clone().negate();
    const zAx = new THREE.Vector3().crossVectors(t, yAx).normalize();
    // keep the half of the cutaway that faces away from the default camera (+X world side)
    this.far = zAx.x < 0 ? 1 : -1;
    this.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, yAx, zAx));
    this.basePos.copy(p);
    this.axisW.copy(t);
    this.root.position.copy(p);

    const mkGrid = (stations: number, around: number, closed: boolean): THREE.BufferGeometry => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(stations * around * 3), 3));
      const idx: number[] = [];
      const ar = closed ? around : around - 1;
      for (let i = 0; i < stations - 1; i++)
        for (let j = 0; j < ar; j++) {
          const a = i * around + j, b2 = i * around + ((j + 1) % around), c = a + around, e = b2 + around;
          idx.push(a, c, b2, b2, c, e);
        }
      g.setIndex(idx);
      return g;
    };
    this.outer = new THREE.Mesh(mkGrid(ST, AR, true), mats.rubber.clone());
    mats.addXray(this.outer.material as THREE.Material);
    // stable UVs for the micro-grain normal map: u along, v around
    {
      const uv = new Float32Array(ST * AR * 2);
      for (let i = 0; i < ST; i++) for (let j = 0; j < AR; j++) { uv[(i * AR + j) * 2] = (i / (ST - 1)) * 3; uv[(i * AR + j) * 2 + 1] = j / AR; }
      this.outer.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    this.inner = new THREE.Mesh(mkGrid(ST, AR, true), mats.mpInterior.clone());
    this.cutTop = new THREE.Mesh(mkGrid(ST, 2, false), mats.cutFace.clone());
    this.cutBot = new THREE.Mesh(mkGrid(ST, 2, false), mats.cutFace.clone());
    this.reedMat = mats.reed.clone();
    this.reed = new THREE.Mesh(mkGrid(40, 8, true), this.reedMat);
    {
      // reed UVs: u = tip → heel (fibres run along u), v across
      const uv = new Float32Array(40 * 8 * 2);
      for (let i = 0; i < 40; i++) for (let j = 0; j < 8; j++) { uv[(i * 8 + j) * 2] = i / 39; uv[(i * 8 + j) * 2 + 1] = j / 8; }
      this.reed.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    for (const m of [this.outer, this.inner, this.cutTop, this.cutBot]) {
      (m.material as THREE.Material).clippingPlanes = [this.clipPlane];
      m.frustumCulled = false;
      m.userData.noAO = true; // clipped: the AO G-buffer would see the removed half
      m.receiveShadow = true;
    }
    this.outer.castShadow = true;
    this.reed.userData.noAO = true;
    this.reed.frustumCulled = false;
    this.root.add(this.outer, this.inner, this.cutTop, this.cutBot, this.reed, this.ligature, this.reedAnchor);
    this.reedAnchor.position.set(0.004, -0.03, 0);

    // ligature: two metal bands with rolled edges, a screw bar under the reed with knurled thumb screws
    for (const u of [0.05, 0.066]) {
      const R = 0.0143;
      const bandG = new THREE.CylinderGeometry(R, R, 0.0038, 48, 1, true).rotateZ(Math.PI / 2);
      const band = new THREE.Mesh(bandG, mats.ligature);
      band.position.x = u;
      band.userData.u = u;
      this.ligature.add(band);
      for (const dx of [-0.0019, 0.0019]) {
        const edge = new THREE.Mesh(new THREE.TorusGeometry(R, 0.00045, 6, 48).rotateY(Math.PI / 2), mats.ligature);
        edge.position.x = u + dx;
        this.ligature.add(edge);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.0011, 0.0011, 0.036, 12).rotateX(Math.PI / 2), mats.ligature);
      bar.position.set(u, -HB - 0.0062, 0);
      this.ligature.add(bar);
      for (const s of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.BoxGeometry(0.0034, 0.005, 0.0022), mats.ligature);
        ear.position.set(u, -HB - 0.0042, s * 0.0128);
        const head = new THREE.Mesh(new THREE.CylinderGeometry(0.0027, 0.0027, 0.0034, 20).rotateX(Math.PI / 2), mats.ligature);
        head.position.set(u, -HB - 0.0062, s * 0.0185);
        this.ligature.add(ear, head);
      }
    }
    this.ligature.traverse((o) => { o.castShadow = true; });
    // neck cork
    const cork = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32, 1, true), mats.cork);
    const xN = path.xNeck;
    const rc = path.radiusAt(xN) + 0.0022;
    cork.scale.set(rc, 0.028, rc);
    cork.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), t);
    cork.position.copy(p).addScaledVector(t, xN + 0.011);
    this.corkMesh = cork; // added to the world by the scene (does not move with insertion)
    this.update(0, null);
  }

  readonly corkMesh: THREE.Mesh;

  setCutaway(on: boolean): void {
    this.cutaway = on;
    for (const h of this.handles) h.mesh.visible = on;
    this.cutTop.visible = on;
    this.cutBot.visible = on;
  }

  // ---- section model -------------------------------------------------------------------------
  private get zNear(): number { return -this.far * 0.0012; }
  private tipOpening(): number { return this.state.get(P.tip_opening) / 1000; }
  private facing(): number { return this.state.get(P.facing_length) / 1000; }

  /** mouthpiece side-rail (lay) height at u: reed rests at -HB, rail curves up toward the tip */
  rail(u: number): number {
    const F = this.facing();
    return u < F ? -HB + this.tipOpening() * ((F - u) / F) ** 2 : -HB;
  }

  /**
   * Equivalent-area radius at u, perturbed by params 15–17 exactly as docs/PHYSICS.md §9
   * (engine geometry.rs::mp_radius): baffle bump on [0, baffle_end), chamber bump on
   * [chamber_start, chamber_end], throat cosine window ±0.2·L around throat_x.
   */
  mpRadius(u: number): number {
    const s = this.state;
    const lm = this.landmarks;
    const base = interp(this.profile, Math.min(Math.max(u, 0), this.airLen));
    const b = s.get(P.baffle_height), c = s.get(P.chamber_size), d = s.get(P.throat_diameter);
    let area = 1;
    area *= 1 + bump(u, 0, lm.baffle_end) * ((1 - 0.45 * b) / (1 - 0.45 * 0.3) - 1);
    area *= 1 + bump(u, lm.chamber_start, lm.chamber_end) * ((0.6 + 0.8 * c) / (0.6 + 0.8 * 0.5) - 1);
    let r = base * Math.sqrt(Math.max(0.05, area));
    const half = 0.2 * this.airLen;
    const dx = u - lm.throat_x;
    const wt = Math.abs(dx) < half ? 0.5 * (1 + Math.cos((Math.PI * dx) / half)) : 0;
    r *= 1 + wt * (d / 11 - 1);
    return r;
  }

  /** visual interior section with the same cross-section area as π·mpRadius² */
  private interior(u: number, out: Section): Section {
    const r = this.mpRadius(u);
    const win = 1 - smooth(this.uw - 0.006, this.uw + 0.004, u); // 1 inside the window (reed side open)
    const wWin = Math.min(this.windowHalf, r * 1.35);
    const w = wWin + (r - wWin) * (1 - win);
    const hh = (r * r) / Math.max(1e-4, w); // semi-axis so that π·w·hh = π·r²
    const botWin = -HB, topWin = -HB + 2 * hh;
    out.w = w;
    out.bot = botWin * win + -hh * (1 - win);
    out.top = topWin * win + hh * (1 - win);
    out.flat = win;
    return out;
  }

  private outerSec(u: number, out: Section): Section {
    const beak = smooth(-0.002, 0.04, u);
    const shank = smooth(0.05, 0.065, u);
    out.w = 0.0098 + (0.0138 - 0.0098) * smooth(0, 0.03, u);
    out.top = this.rail(0) + 0.0028 + (0.0138 - this.rail(0) - 0.0028) * beak;
    const table = this.rail(u);
    out.bot = table + (-0.0138 - table) * shank;
    out.flat = 1 - shank;
    return out;
  }

  private lastIns = NaN;
  private sec = { w: 0, top: 0, bot: 0, flat: 0 };
  private sec2 = { w: 0, top: 0, bot: 0, flat: 0 };
  /** outer beak top height (local v) at u — used to seat the upper teeth/lip */
  outerTop(u: number): number { return this.outerSec(u, this.sec2).top; }
  outerHalfWidth(u: number): number { return this.outerSec(u, this.sec2).w; }

  private fillSection(arr: Float32Array, i: number, u: number, s: Section): void {
    const mid = (s.top + s.bot) / 2;
    for (let j = 0; j < AR; j++) {
      const th = (j / AR) * Math.PI * 2;
      const c = Math.cos(th), sn = Math.sin(th);
      let v: number;
      if (sn >= 0) v = mid + (s.top - mid) * sn;
      else {
        const e = 1 - 0.75 * s.flat; // flatter bottom for the table
        v = mid - (mid - s.bot) * Math.pow(-sn, e);
      }
      const k = (i * AR + j) * 3;
      arr[k] = u;
      arr[k + 1] = v;
      arr[k + 2] = s.w * c;
    }
  }

  private rebuild(): void {
    const op = this.outer.geometry.getAttribute('position') as THREE.BufferAttribute;
    const ip = this.inner.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tp = this.cutTop.geometry.getAttribute('position') as THREE.BufferAttribute;
    const bp = this.cutBot.geometry.getAttribute('position') as THREE.BufferAttribute;
    const oa = op.array as Float32Array, ia = ip.array as Float32Array, ta = tp.array as Float32Array, ba = bp.array as Float32Array;
    const s = this.sec;
    for (let i = 0; i < ST; i++) {
      const u = (this.L * i) / (ST - 1);
      this.outerSec(u, s);
      const oTop = s.top, oBot = s.bot;
      this.fillSection(oa, i, u, s);
      this.interior(u, s);
      this.fillSection(ia, i, u, s);
      // cut faces in the z=0 plane
      let k = i * 2 * 3;
      ta[k] = u; ta[k + 1] = oTop; ta[k + 2] = 0;
      ta[k + 3] = u; ta[k + 4] = s.top; ta[k + 5] = 0;
      const bOn = 1 - s.flat; // only behind the window
      ba[k] = u; ba[k + 1] = s.bot; ba[k + 2] = 0;
      ba[k + 3] = u; ba[k + 4] = s.bot + (oBot - s.bot) * bOn; ba[k + 5] = 0;
      k += 6;
    }
    for (const a of [op, ip, tp, bp]) a.needsUpdate = true;
    for (const m of [this.outer, this.inner, this.cutTop, this.cutBot]) m.geometry.computeVertexNormals();
  }

  private reedThickness(u: number): number {
    const strength = this.state.get(P.reed_strength);
    const k = 0.75 + 0.12 * (strength - 1.5);
    const vamp = smooth(0, this.reedLen * 0.55, u) ** 0.8;
    return (this.reedTip + (this.reedHeel - this.reedTip) * vamp) * k;
  }

  /** feed the beam-reed deflection profile (n samples tip → clamp) from telemetry; allocation-free */
  setReedShape(src: Float32Array, start: number, n: number): void {
    const m = Math.min(n, this.shape.length);
    const fresh = this.shapeN !== m;
    for (let i = 0; i < m; i++) {
      const v = src[start + i];
      this.shape[i] = v;
      this.shapeMean[i] = fresh ? v : this.shapeMean[i] + (v - this.shapeMean[i]) * 0.04;
    }
    this.shapeN = m;
    this.shapeAt = performance.now();
  }

  /** displayed deflection at u (exaggerated AC part), or NaN if no fresh shape telemetry */
  private shapeDeflection(u: number): number {
    if (this.shapeN < 2 || performance.now() - this.shapeAt > 300) return NaN;
    if (u >= this.clampLen) return 0;
    const f = (u / this.clampLen) * (this.shapeN - 1);
    const i = Math.min(this.shapeN - 2, Math.floor(f)), t = f - i;
    const y = this.shape[i] + (this.shape[i + 1] - this.shape[i]) * t;
    const ym = this.shapeMean[i] + (this.shapeMean[i + 1] - this.shapeMean[i]) * t;
    return ym + (y - ym) * this.reedGain;
  }

  private updateReed(): void {
    const pa = this.reed.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pa.array as Float32Array;
    const lip = this.state.shown.get(P.lip_position) / 1000; // effective value in Play mode
    const F = this.facing();
    const Lv = Math.max(F, lip + 0.004);
    const yTip = this.reedY;
    const W = this.reedW / 2;
    const n = 40;
    for (let i = 0; i < n; i++) {
      const u = (this.reedLen * i) / (n - 1);
      const shape = u < Lv ? ((Lv - u) / Lv) ** 2 : 0;
      const sd = this.shapeDeflection(u);
      let top = -HB + (Number.isNaN(sd) ? yTip * shape : sd);
      top = Math.min(top, this.rail(u)); // beating against the lay
      const th = this.reedThickness(u);
      const w = u < 0.004 ? W * (0.82 + 0.18 * Math.sqrt(u / 0.004)) : W;
      // rectangle-ish section, 8 points: (z, v)
      const k0 = i * 8 * 3;
      const put = (j: number, z: number, v: number): void => {
        const k = k0 + j * 3;
        a[k] = u; a[k + 1] = v; a[k + 2] = z;
      };
      put(0, w, top); put(1, 0, top + 0.0001); put(2, -w, top); put(3, -w, top - th * 0.5);
      put(4, -w, top - th); put(5, 0, top - th); put(6, w, top - th); put(7, w, top - th * 0.5);
    }
    pa.needsUpdate = true;
    this.reed.geometry.computeVertexNormals();
    const s = this.state.get(P.reed_strength);
    const t = (s - 1.5) / 3.5;
    // tint over the cane texture: softer reeds paler, harder reeds deeper/amber
    this.reedMat.color.setRGB(1.0 - 0.12 * t, 0.97 - 0.22 * t, 0.9 - 0.35 * t);
  }

  /** dt seconds; reedDisp telemetry (m) or null when no engine */
  update(_dt: number, reedDisp: number | null): void {
    const s = this.state;
    // static estimate when no engine telemetry
    const y = reedDisp ?? (this.tipOpening() * Math.min(0.85, 0.28 * s.shown.get(P.lip_force)));
    // exaggerate only the oscillating part around the running mean (the static lip bend stays true to scale)
    this.reedMean += (y - this.reedMean) * (reedDisp === null ? 1 : 0.04);
    this.reedY = this.reedMean + (y - this.reedMean) * (reedDisp === null ? 1 : this.reedGain);
    let dirty = false;
    for (let i = 0; i < SHAPE_IDS.length; i++) {
      const v = s.get(SHAPE_IDS[i]);
      if (v !== this.last[i]) { this.last[i] = v; dirty = true; }
    }
    if (dirty) this.rebuild();
    this.moved = dirty;
    this.updateReed();
    // insertion: push the mouthpiece (and the player) along the axis
    const ins = (s.get(P.mouthpiece_insertion) - 10) / 1000;
    if (ins !== this.lastIns) { this.lastIns = ins; this.moved = true; }
    this.root.position.copy(this.basePos).addScaledVector(this.axisW, ins);
    this.root.updateMatrixWorld();
    // clip plane: keep -Z half when cutaway
    if (this.cutaway) {
      const nrm = _v.set(0, 0, this.far).transformDirection(this.root.matrixWorld);
      this.clipPlane.setFromNormalAndCoplanarPoint(nrm, this.root.position);
      this.clipPlane.constant += 0.00001;
    } else {
      this.clipPlane.set(_v.set(0, 0, -1), 1e3);
    }
    for (const h of this.handles) h.place();
  }

  // ---- interaction -----------------------------------------------------------------------------
  /** the cutaway's drag handles — for the UI's declutter rule */
  get handleMeshes(): THREE.Object3D[] {
    return this.handles.map((h) => h.mesh);
  }

  registerHandles(ix: Interaction): void {
    const st = this.state;
    const X = new THREE.Vector3(1, 0, 0), Yv = new THREE.Vector3(0, 1, 0);
    const add = (ids: number[], title: string, place: (m: THREE.Mesh) => void, drag: DragSpec, color = 0x4aa8ff): void => {
      const mesh = handleMesh(0.0016, color);
      this.root.add(mesh);
      const entry = { mesh, place: () => place(mesh) };
      this.handles.push(entry);
      mesh.visible = false;
      ix.add({
        objects: [mesh], priority: 2, tooltip: paramTooltip(st, ids, title), drag,
        hover: (on) => setHandleHover(mesh, on),
      });
    };
    add([P.tip_opening], 'Tip opening (drag ↕)', (m) => m.position.set(0.0005, this.rail(0) + 0.0004, this.zNear),
      axisDrag(this.root, Yv, st, [P.tip_opening], (d, s0) => st.set(P.tip_opening, s0[0] + d * 1000 * 0.5, 'drag'), 0.004), 0xffc04a);
    add([P.facing_length], 'Facing length (drag ↔)', (m) => m.position.set(this.facing(), -HB + 0.0003, this.zNear),
      axisDrag(this.root, X, st, [P.facing_length], (d, s0) => st.set(P.facing_length, s0[0] + d * 1000, 'drag'), 0.015), 0xffc04a);
    add([P.baffle_height], 'Baffle (drag ↕)', (m) => { const u = this.landmarks.baffle_end * 0.5; this.interior(u, this.sec); m.position.set(u, this.sec.top, this.zNear); },
      axisDrag(this.root, Yv, st, [P.baffle_height], (d, s0) => st.set(P.baffle_height, s0[0] - d / 0.006, 'drag'), 0.006));
    add([P.chamber_size], 'Chamber (drag ↕)', (m) => { const u = 0.5 * (this.landmarks.chamber_start + this.landmarks.chamber_end); this.interior(u, this.sec); m.position.set(u, this.sec.top, this.zNear); },
      axisDrag(this.root, Yv, st, [P.chamber_size], (d, s0) => st.set(P.chamber_size, s0[0] + d / 0.0035, 'drag'), 0.0035));
    add([P.throat_diameter], 'Throat (drag ↕)', (m) => { this.interior(this.landmarks.throat_x, this.sec); m.position.set(this.landmarks.throat_x, this.sec.top, this.zNear); },
      axisDrag(this.root, Yv, st, [P.throat_diameter], (d, s0) => st.set(P.throat_diameter, s0[0] + d * 1000 * 1.5, 'drag'), 0.008 / 1.5));
    add([P.mouthpiece_insertion], 'Mouthpiece on cork (drag ↔)', (m) => m.position.set(this.L - 0.004, 0.0142, this.zNear),
      axisDrag(this.root, X, st, [P.mouthpiece_insertion], (d, s0) => st.set(P.mouthpiece_insertion, s0[0] + d * 1000, 'drag'), 0.02), 0x9be15d);
    // reed: hover shows strength; drag ↕ at the reed changes strength (stiffer = up)
    ix.add({
      objects: [this.reed],
      tooltip: paramTooltip(st, [P.reed_strength, P.reed_damping], 'Reed (drag ↕ = strength)'),
      drag: axisDrag(this.root, Yv, st, [P.reed_strength], (d, s0) => st.set(P.reed_strength, s0[0] + d * 300, 'drag'), 3.5 / 300),
      hover: (on) => this.reedMat.emissive.setHex(on ? 0x332200 : 0),
    });
  }
}
