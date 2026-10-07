import * as THREE from 'three';

export const HIGHLIGHT = new THREE.Color(0x3fa9ff);
export const ACTIVE = new THREE.Color(0xff9a3c);

export class Materials {
  readonly brass = new THREE.MeshPhysicalMaterial({
    color: 0xd9a84e,
    metalness: 1,
    roughness: 0.26,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.1,
    side: THREE.FrontSide,
  });
  readonly brassDark = new THREE.MeshPhysicalMaterial({ color: 0x8a6528, metalness: 1, roughness: 0.4, side: THREE.BackSide });
  readonly keyBrass = new THREE.MeshPhysicalMaterial({ color: 0xe3b75e, metalness: 1, roughness: 0.2, clearcoat: 0.6 });
  readonly pad = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.85, metalness: 0 });
  readonly resonator = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.25, metalness: 1 });
  readonly pearl = new THREE.MeshPhysicalMaterial({
    color: 0xf3eee4, roughness: 0.18, metalness: 0, clearcoat: 1, iridescence: 0.7, iridescenceIOR: 1.6, sheen: 0.4,
  });
  readonly rubber = new THREE.MeshPhysicalMaterial({ color: 0x111215, roughness: 0.32, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2, side: THREE.DoubleSide });
  readonly mpInterior = new THREE.MeshStandardMaterial({ color: 0x2bd4c5, roughness: 0.5, metalness: 0, emissive: 0x0b4a46, side: THREE.DoubleSide });
  readonly cutFace = new THREE.MeshStandardMaterial({ color: 0x3a3d48, roughness: 0.7, side: THREE.DoubleSide });
  readonly reed = new THREE.MeshStandardMaterial({ color: 0xe8cf86, roughness: 0.6, side: THREE.DoubleSide });
  readonly ligature = new THREE.MeshStandardMaterial({ color: 0xbfc4ca, roughness: 0.2, metalness: 1 });
  readonly cork = new THREE.MeshStandardMaterial({ color: 0x9c7a52, roughness: 0.95 });
  readonly handle = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x2a6fd6, emissiveIntensity: 0.8, roughness: 0.3, transparent: true, opacity: 0.9, depthTest: false });

  private xray = false;

  setXray(on: boolean): void {
    this.xray = on;
    for (const m of [this.brass, this.rubber]) {
      m.transparent = on;
      m.opacity = on ? 0.16 : 1;
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
    this.brassDark.visible = !on;
  }

  get isXray(): boolean {
    return this.xray;
  }
}

/** Make a per-object material clone that supports hover/press emissive highlighting. */
export function highlightable<T extends THREE.MeshStandardMaterial>(m: T): T {
  const c = m.clone() as T;
  c.emissive = new THREE.Color(0x000000);
  return c;
}
