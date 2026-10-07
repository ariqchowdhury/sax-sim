// Procedural saxophone body built from the geometry JSON.
import * as THREE from 'three';
import type { BorePath } from './borePath';
import type { KeyDef, SaxGeometry, ToneHole } from './geometry';
import { ACTIVE, HIGHLIGHT, type Materials } from './materials';

const WALL = 0.0007;
const AROUND = 40;
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3(), _b = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

export const PROFILE_TEX = 256;

export function buildTube(path: BorePath, x0: number, x1: number, rings: number, offset: number, inward: boolean, around = AROUND): THREE.BufferGeometry {
  const nv = (rings + 1) * (around + 1);
  const pos = new Float32Array(nv * 3);
  const bu = new Float32Array(nv);
  const uv = new Float32Array(nv * 2);
  let k = 0;
  for (let i = 0; i <= rings; i++) {
    const x = x0 + ((x1 - x0) * i) / rings;
    path.frameAt(x, _p, _t, _n, _b);
    const r = path.radiusAt(x) + offset;
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      pos[k * 3] = _p.x + r * (c * _n.x + s * _b.x);
      pos[k * 3 + 1] = _p.y + r * (c * _n.y + s * _b.y);
      pos[k * 3 + 2] = _p.z + r * (c * _n.z + s * _b.z);
      bu[k] = x / path.xEnd;
      uv[k * 2] = j / around;
      uv[k * 2 + 1] = i / rings;
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
  g.setAttribute('bu', new THREE.BufferAttribute(bu, 1));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Shader: standing pressure wave on the inner bore surface. */
export function makeWaveMaterial(tex: THREE.DataTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex },
      uScale: { value: 1 / 2000 },
      uRmsScale: { value: 1 / 2000 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float bu;
      varying float vU;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vU = bu;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform float uScale;
      uniform float uRmsScale;
      uniform float uOpacity;
      varying float vU;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 s = texture2D(uTex, vec2(vU, 0.5));
        float p = clamp(s.r * uScale, -1.0, 1.0);
        float rms = clamp(s.g * uRmsScale, 0.0, 1.0);
        vec3 base = vec3(0.10, 0.07, 0.03);
        vec3 pos = vec3(1.0, 0.45, 0.08);
        vec3 neg = vec3(0.10, 0.65, 1.0);
        vec3 col = base + (p > 0.0 ? pos : neg) * abs(p) * 1.6 + vec3(0.9, 0.85, 0.6) * rms * 0.35;
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
        col += rim * 0.06;
        gl_FragColor = vec4(col, uOpacity);
      }`,
    side: THREE.BackSide,
    transparent: false,
  });
}

interface HoleView {
  def: ToneHole;
  pivot: THREE.Object3D;
  /** displayed openness 0..1 */
  open: number;
  lift: number;
  cupR: number;
  top: THREE.Vector3;
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

export class SaxModel {
  readonly group = new THREE.Group();
  readonly holes: HoleView[] = [];
  readonly holeIndex = new Map<string, number>();
  readonly keys: KeyView[] = [];
  readonly profileData = new Float32Array(PROFILE_TEX * 4);
  readonly profileTex: THREE.DataTexture;
  readonly waveMaterial: THREE.ShaderMaterial;
  readonly waveLine: THREE.Line;
  private waveBasePos: Float32Array;
  private waveNrm: Float32Array;
  /** metres of line displacement at full-scale pressure */
  waveAmp = 0.012;
  readonly innerMesh: THREE.Mesh;

  constructor(readonly geo: SaxGeometry, readonly path: BorePath, readonly mats: Materials) {
    this.profileTex = new THREE.DataTexture(this.profileData, PROFILE_TEX, 1, THREE.RGBAFormat, THREE.FloatType);
    this.profileTex.magFilter = THREE.LinearFilter;
    this.profileTex.minFilter = THREE.LinearFilter;
    this.profileTex.needsUpdate = true;
    this.waveMaterial = makeWaveMaterial(this.profileTex);

    const xN = path.xNeck, xB = path.xBody, xE = path.xEnd;
    const ringsFor = (len: number): number => Math.max(16, Math.round(len * 500));
    // neck + body outer brass
    const neck = new THREE.Mesh(buildTube(path, xN, xB, ringsFor(xB - xN), WALL, false), mats.brass);
    const body = new THREE.Mesh(buildTube(path, xB, xE, ringsFor(xE - xB), WALL, false), mats.brass);
    neck.name = 'neck';
    body.name = 'body';
    this.group.add(neck, body);
    // inner bore surface (whole air column incl. mouthpiece region) with wave shader
    // (starts at the neck: the mouthpiece interior is drawn by MouthpieceModel and must stay visible in the cutaway)
    this.innerMesh = new THREE.Mesh(buildTube(path, xN, xE, ringsFor(xE - xN), -0.0001, false, 28), this.waveMaterial);
    this.innerMesh.renderOrder = -1;
    this.group.add(this.innerMesh);

    // bell rim + neck tenon ring
    this.group.add(this.ring(xE, path.radiusAt(xE) + WALL, 0.0016, mats.brass));
    this.group.add(this.ring(xB - 0.006, path.radiusAt(xB) + WALL + 0.0014, 0.0022, mats.brass, 0.012));
    this.group.add(this.ring(xB + 0.004, path.radiusAt(xB) + WALL + 0.0016, 0.0018, mats.brass, 0.0));

    geo.tone_holes.forEach((h, i) => {
      this.holeIndex.set(h.id, i);
      this.holes.push(this.buildHole(h));
    });
    geo.keys.forEach((k, i) => this.keys.push(this.buildKey(k, i)));

    // standing-wave glow line along the centerline
    const n = PROFILE_TEX;
    this.waveBasePos = new Float32Array(n * 3);
    this.waveNrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = (xE * i) / (n - 1);
      path.frameAt(x, _p, _t, _n, _b);
      _p.toArray(this.waveBasePos, i * 3);
      _n.toArray(this.waveNrm, i * 3);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.waveBasePos.slice(), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.5), 3));
    this.waveLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false }));
    this.waveLine.renderOrder = 10;
    this.waveLine.frustumCulled = false;
    this.group.add(this.waveLine);
  }

  private ring(x: number, R: number, tube: number, mat: THREE.Material, len = 0): THREE.Mesh {
    path_frame(this.path, x);
    const g = len > 0 ? new THREE.CylinderGeometry(R, R, len, AROUND, 1, true) : new THREE.TorusGeometry(R, tube, 10, AROUND);
    const m = new THREE.Mesh(g, mat);
    m.position.copy(_p);
    m.quaternion.setFromUnitVectors(len > 0 ? Y : Z, _t);
    return m;
  }

  private holeDir(h: ToneHole, out: THREE.Vector3): THREE.Vector3 {
    path_frame(this.path, h.x);
    const a = (h.angle_deg * Math.PI) / 180;
    return out.copy(_n).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a)).normalize();
  }

  private buildHole(h: ToneHole): HoleView {
    const dir = this.holeDir(h, new THREE.Vector3());
    const center = _p.clone();
    const tan = _t.clone();
    const rb = this.path.radiusAt(h.x);
    const r = h.radius;
    const hgt = Math.max(0.0015, h.chimney);
    const base = rb * 0.55;
    const chim = new THREE.Mesh(new THREE.CylinderGeometry(r + WALL, r + WALL, rb + hgt - base, 28, 1, true), this.mats.brass);
    chim.position.copy(center).addScaledVector(dir, (base + rb + hgt) / 2);
    chim.quaternion.setFromUnitVectors(Y, dir);
    const inner = new THREE.Mesh(chim.geometry, this.mats.brassDark);
    inner.position.copy(chim.position);
    inner.quaternion.copy(chim.quaternion);
    inner.scale.set(0.97, 1, 0.97);
    const top = center.clone().addScaledVector(dir, rb + hgt);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r + WALL * 0.5, WALL * 0.9, 8, 28), this.mats.brass);
    rim.position.copy(top);
    rim.quaternion.setFromUnitVectors(Z, dir);
    this.group.add(chim, inner, rim);

    // pad cup on a hinge at the cup edge (hinge axis ⟂ bore tangent and hole axis)
    const cupR = r * 1.18 + 0.0012;
    const e = tan.clone().addScaledVector(dir, -tan.dot(dir)).normalize();
    const k = new THREE.Vector3().crossVectors(e, dir);
    const pivot = new THREE.Object3D();
    pivot.position.copy(top).addScaledVector(e, cupR);
    pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(e, dir, k));
    const cupGroup = new THREE.Group();
    cupGroup.position.set(-cupR, 0, 0);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(cupR * 0.97, cupR * 0.97, 0.0016, 28), this.mats.pad);
    pad.position.y = 0.0008;
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(cupR, cupR * 1.02, 0.0028, 32, 1, false), this.mats.keyBrass);
    cup.position.y = 0.0016 + 0.0014;
    const reso = new THREE.Mesh(new THREE.CylinderGeometry(cupR * 0.55, cupR * 0.55, 0.0003, 24), this.mats.resonator);
    reso.position.y = -0.0001;
    cupGroup.add(pad, cup, reso);
    pivot.add(cupGroup);
    this.group.add(pivot);
    return { def: h, pivot, open: h.pad_rest === 'open' ? 1 : 0, lift: h.pad_open_height, cupR, top };
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
    if (isPearl) g = new THREE.SphereGeometry(0.0062, 24, 12).scale(1, 0.42, 1);
    else if (kind.includes('palm')) g = roundedBox(0.019, 0.0035, 0.009);
    else if (kind.includes('side')) g = roundedBox(0.016, 0.0035, 0.0075);
    else if (kind.includes('octave') || kind.includes('thumb')) g = roundedBox(0.017, 0.003, 0.009);
    else if (kind.includes('table')) g = roundedBox(0.012, 0.004, 0.009);
    else if (kind.includes('spatula')) g = roundedBox(0.015, 0.004, 0.01);
    else g = new THREE.SphereGeometry(0.005, 16, 10).scale(1, 0.5, 1);
    const mesh = new THREE.Mesh(g, mat);
    const group = new THREE.Group();
    group.position.copy(p);
    // local Y = outward; long axis (local X) along the bore tangent
    this.path.frameAt(bx, _p, _t, _n, _b);
    const tx = _t.clone().addScaledVector(outward, -_t.dot(outward)).normalize();
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tx, outward, new THREE.Vector3().crossVectors(tx, outward)));
    group.add(mesh);
    if (isPearl) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.0072, 0.0068, 0.0022, 24, 1, true), this.mats.keyBrass);
      cup.position.y = -0.0006;
      group.add(cup);
    }
    this.group.add(group);

    // rod from touch piece to the (first) pad it drives — visual only
    const hid = k.actions?.[0]?.hole ?? (kind.includes('octave') ? this.geo.tone_holes.find((h) => h.octave_vent)?.id : undefined);
    const hi = hid !== undefined ? this.geo.tone_holes.findIndex((h) => h.id === hid) : -1;
    if (hi >= 0) {
      const hv = this.holes[hi];
      const a = p.clone().addScaledVector(outward, -0.003);
      const b = hv.top.clone().addScaledVector(this.holeDir(hv.def, new THREE.Vector3()), 0.004);
      const len = a.distanceTo(b);
      if (len > 0.004 && len < 0.05) {
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.0009, 0.0009, len, 6), this.mats.keyBrass);
        rod.position.copy(a).add(b).multiplyScalar(0.5);
        rod.quaternion.setFromUnitVectors(Y, b.clone().sub(a).normalize());
        this.group.add(rod);
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
  update(dt: number, padTarget: Float32Array, keysDown: Float32Array): void {
    const a = 1 - Math.exp(-dt / 0.018);
    for (let i = 0; i < this.holes.length; i++) {
      const h = this.holes[i];
      const tgt = padTarget[i] ?? 0;
      h.open += (tgt - h.open) * a;
      const lift = Math.max(0.002, h.lift) * 1.0 * h.open;
      h.pivot.rotation.z = -Math.atan2(lift, 2 * h.cupR);
    }
    const ka = 1 - Math.exp(-dt / 0.03);
    for (const k of this.keys) {
      const down = keysDown[k.index] ?? 0;
      k.press += (down - k.press) * ka;
      k.group.position.copy(k.rest).addScaledVector(k.outward, -0.0025 * k.press);
      const em = k.material.emissive;
      if (down > 0.5) em.copy(ACTIVE).multiplyScalar(0.55);
      else if (k.hover) em.copy(HIGHLIGHT).multiplyScalar(0.5);
      else em.setRGB(0, 0, 0);
    }
  }

  /** profile/rms: n samples reed→bell */
  setProfile(profile: Float32Array, rms: Float32Array, n: number, scalePa: number): void {
    const d = this.profileData;
    const line = this.waveLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.waveLine.geometry.getAttribute('color') as THREE.BufferAttribute;
    const lp = line.array as Float32Array, lc = col.array as Float32Array;
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
      lp[i * 3] = this.waveBasePos[i * 3] + this.waveNrm[i * 3] * off;
      lp[i * 3 + 1] = this.waveBasePos[i * 3 + 1] + this.waveNrm[i * 3 + 1] * off;
      lp[i * 3 + 2] = this.waveBasePos[i * 3 + 2] + this.waveNrm[i * 3 + 2] * off;
      const q = Math.max(-1, Math.min(1, p / scalePa));
      if (q >= 0) { lc[i * 3] = 1; lc[i * 3 + 1] = 0.55 + 0.1 * (1 - q); lc[i * 3 + 2] = 0.15 + 0.6 * (1 - q); }
      else { lc[i * 3] = 0.2 + 0.6 * (1 + q); lc[i * 3 + 1] = 0.7; lc[i * 3 + 2] = 1; }
    }
    line.needsUpdate = true;
    col.needsUpdate = true;
    this.profileTex.needsUpdate = true;
    this.waveMaterial.uniforms.uScale.value = 1 / scalePa;
    this.waveMaterial.uniforms.uRmsScale.value = 1 / scalePa;
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
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelSize: h * 0.3, bevelThickness: h * 0.3, bevelSegments: 2, curveSegments: 6 });
  g.rotateX(Math.PI / 2);
  g.translate(0, h / 2, 0);
  return g;
}
