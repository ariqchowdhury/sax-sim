// Declutter rule for drag-handle clusters: when the handles of a cluster (the mouthpiece cutaway's
// handles, the head's tongue / jaw / glottis handles) sit closer than COLLAPSE_PX on screen, they are
// collapsed — not drawn, not pickable — and a single "<cluster> ✋" tag at their centre flies the
// camera to the cluster's view on click. They expand again once their spacing is ≥ EXPAND_PX
// (hysteresis, no flicker). A cluster never collapses while its own camera view is the active preset
// (its handles are the point of that view). The parts' own meshes (lips, tongue, reed, jaw bone, lungs) stay grabbable.
import * as THREE from 'three';
import type { CameraPreset } from '../scene/SceneApp';

export const COLLAPSE_PX = 24;
const EXPAND_PX = 27;

interface Cluster { name: string; cam: CameraPreset; handles: THREE.Object3D[]; collapsed: boolean; el: HTMLButtonElement; shown: boolean }
const _v = new THREE.Vector3();

export class HandleClusters {
  private clusters: Cluster[] = [];
  private pts: { x: number; y: number }[] = [];
  /** the active camera preset (set by the camera buttons) */
  view: CameraPreset = 'full';

  constructor(private root: HTMLElement, private camera: THREE.Camera, private dom: HTMLElement, private go: (c: CameraPreset) => void) {}

  add(name: string, cam: CameraPreset, handles: THREE.Object3D[]): void {
    const el = document.createElement('button');
    el.className = 'grabtag cluster';
    el.textContent = name;
    el.title = `Several grab points here — click to zoom in (${cam} view)`;
    el.style.display = 'none';
    el.addEventListener('click', () => this.go(cam));
    this.root.appendChild(el);
    this.clusters.push({ name, cam, handles, collapsed: false, el, shown: false });
  }

  /** screen boxes of the cluster tags currently shown (other tags avoid them) */
  boxes(): { x0: number; x1: number; y0: number; y1: number }[] {
    return this.clusters.filter((c) => c.shown).map((c) => { const r = c.el.getBoundingClientRect(); return { x0: r.left, x1: r.right, y0: r.top, y1: r.bottom }; });
  }

  /** collapsed state of a cluster by name (tests / debugging) */
  isCollapsed(name: string): boolean {
    return !!this.clusters.find((c) => c.name === name)?.collapsed;
  }

  update(): void {
    const r = this.dom.getBoundingClientRect();
    for (const c of this.clusters) {
      // screen positions of the handles that the scene currently shows
      this.pts.length = 0;
      for (const h of c.handles) {
        if (!isVisible(h)) continue;
        h.getWorldPosition(_v).project(this.camera);
        if (_v.z > 1) continue;
        this.pts.push({ x: r.left + ((_v.x + 1) / 2) * r.width, y: r.top + ((1 - _v.y) / 2) * r.height });
      }
      let minD = Infinity;
      for (let i = 0; i < this.pts.length; i++) for (let j = i + 1; j < this.pts.length; j++) minD = Math.min(minD, Math.hypot(this.pts[i].x - this.pts[j].x, this.pts[i].y - this.pts[j].y));
      const want = c.cam !== this.view && this.pts.length > 1 && (c.collapsed ? minD < EXPAND_PX : minD < COLLAPSE_PX);
      if (want !== c.collapsed) {
        c.collapsed = want;
        for (const h of c.handles) setCollapsed(h, want);
      }
      const show = c.collapsed && this.pts.length > 0;
      if (show !== c.shown) { c.shown = show; c.el.style.display = show ? '' : 'none'; }
      if (show) {
        let x = 0, y = 0;
        for (const p of this.pts) { x += p.x; y += p.y; }
        x /= this.pts.length; y /= this.pts.length;
        c.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
      }
    }
  }
}

/** collapsed handles leave every layer: not rendered, not hit by the raycaster */
function setCollapsed(o: THREE.Object3D, on: boolean): void {
  o.userData.collapsed = on;
  o.traverse((c) => { if (on) c.layers.disableAll(); else c.layers.set(0); });
}

function isVisible(o: THREE.Object3D): boolean {
  let c: THREE.Object3D | null = o;
  while (c) {
    if (!c.visible) return false;
    c = c.parent;
  }
  return true;
}
