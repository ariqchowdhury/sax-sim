// Grab hints: small tags ("tongue", "lips", "lungs", …) next to the parts that can be grabbed, plus
// the breathing halo on drag handles (handles.ts `handleFx`). A part's tag disappears once the user
// has dragged it; the set of grabbed parts is remembered (localStorage). Toggle: Layers → Grab hints.
import * as THREE from 'three';
import { handleFx } from '../scene/handles';
import { isCollapsed, partMeta, type Interaction, type Pickable } from '../scene/interaction';

/**
 * part name (handles.ts meta) → tag text, in priority order (earlier tags win overlaps); detail
 * parts (`near`) only get a tag in close-up views (camera within NEAR_M of the part)
 */
const TAGS: [RegExp, string, boolean?][] = [
  [/^Lungs/, 'lungs · air'],
  [/^Tongue body/, 'tongue'],
  [/^Lower lip/, 'lips'],
  [/^Jaw/, 'jaw'],
  [/^Reed/, 'reed', true],
  [/^Tongue tip/, 'tongue tip', true],
  [/^Glottis/, 'glottis', true],
  [/^Tip opening/, 'tip opening', true],
  [/^Baffle/, 'baffle', true],
  [/^Chamber/, 'chamber', true],
  [/^Throat/, 'throat', true],
  [/^Facing/, 'facing', true],
  [/^Mouthpiece on cork/, 'tuning (cork)', true],
];
const LS = 'saxsim.grabbed.v1';
const NEAR_M = 0.55;
const TAG_H = 22;
const GAP = 12;

interface Tag { el: HTMLDivElement; anchor: THREE.Object3D; local: THREE.Vector3; label: string; p: Pickable | null; near: boolean; shown: boolean; w: number }
interface Box { x0: number; x1: number; y0: number; y1: number }
const _w = new THREE.Vector3();
const _v = new THREE.Vector3();

export class GrabHints {
  private tags: Tag[] = [];
  private grabbed = new Set<string>();
  private placed: Box[] = [];
  enabled = true;

  constructor(private root: HTMLElement, private camera: THREE.Camera, private dom: HTMLElement, private ix: Interaction, keysAnchor?: THREE.Object3D) {
    try { for (const s of JSON.parse(localStorage.getItem(LS) ?? '[]') as string[]) this.grabbed.add(s); } catch { /* ignore */ }
    for (const [re, label, near] of TAGS) {
      const p = ix.all.find((q) => re.test(partMeta(q)?.name ?? ''));
      if (!p) continue;
      // lungs: tag the lungs themselves (their gauge handle is only shown while hovered)
      const anchor = label.startsWith('lungs') ? p.objects.find((o) => !o.userData.isHandle) ?? p.objects[0] : p.objects[0];
      this.addTag(anchor, label, p, !!near);
      if (label === 'jaw' && keysAnchor) this.addTag(keysAnchor, 'keys', null, false);
    }
    this.syncHandles();
  }

  private addTag(anchor: THREE.Object3D, label: string, p: Pickable | null, near: boolean): void {
    const el = document.createElement('div');
    el.className = near ? 'grabtag minor' : 'grabtag';
    el.textContent = label;
    el.style.display = 'none';
    this.root.appendChild(el);
    // anchor at the mesh's visual centre (handles: their origin)
    const local = new THREE.Vector3();
    const g = (anchor as THREE.Mesh).geometry;
    if (g && !anchor.userData.isHandle) {
      g.computeBoundingBox();
      g.boundingBox!.getCenter(local);
    }
    this.tags.push({ el, anchor, local, label, p, near, shown: false, w: 0 });
  }

  /** a drag of `p` finished: retire its tag (and its handle's pulse) */
  markGrabbed(p: Pickable | 'keys'): void {
    const t = this.tags.find((x) => (p === 'keys' ? x.p === null : x.p === p));
    if (!t || this.grabbed.has(t.label)) return;
    this.grabbed.add(t.label);
    try { localStorage.setItem(LS, JSON.stringify([...this.grabbed])); } catch { /* ignore */ }
    this.syncHandles();
  }

  /** Layers → Grab hints (`reset`: show every tag again, also for parts already grabbed) */
  setEnabled(on: boolean, reset = false): void {
    this.enabled = on;
    handleFx.pulse = on;
    if (on && reset) {
      this.grabbed.clear();
      try { localStorage.removeItem(LS); } catch { /* ignore */ }
      this.syncHandles();
    }
  }

  private syncHandles(): void {
    for (const t of this.tags) {
      if (!t.p) continue;
      for (const o of t.p.objects) if (o.userData.isHandle) o.userData.grabbed = this.grabbed.has(t.label);
    }
  }

  /** per frame; `occupied`: screen boxes other tags already use (e.g. cluster tags) */
  update(occupied: Box[] = []): void {
    const r = this.dom.getBoundingClientRect();
    const hide = !this.enabled || this.ix.isDragging;
    this.placed.length = 0;
    this.placed.push(...occupied);
    for (const t of this.tags) {
      let vis = !hide && !this.grabbed.has(t.label) && isVisible(t.anchor) && !isCollapsed(t.anchor);
      let x = 0, y = 0, left = false;
      if (vis) {
        _v.copy(t.local);
        t.anchor.localToWorld(_v);
        if (t.near && _w.copy(_v).distanceTo(this.camera.position) > NEAR_M) vis = false;
        _v.project(this.camera);
        vis = vis && _v.z < 1 && Math.abs(_v.x) < 0.95 && Math.abs(_v.y) < 0.92;
        x = r.left + ((_v.x + 1) / 2) * r.width;
        y = r.top + ((1 - _v.y) / 2) * r.height;
        if (vis) {
          // try the right side of the anchor, then the left; skip the tag if both collide
          const w = t.w || 80;
          const right: Box = { x0: x + GAP, x1: x + GAP + w, y0: y - TAG_H / 2, y1: y + TAG_H / 2 };
          const lft: Box = { x0: x - GAP - w, x1: x - GAP, y0: right.y0, y1: right.y1 };
          const fits = (b: Box): boolean => b.x0 >= r.left + 4 && b.x1 <= r.right - 4 && !this.collides(b);
          const box = fits(right) ? right : fits(lft) ? lft : null;
          if (box) { this.placed.push(box); left = box === lft; } else vis = false;
        }
      }
      if (vis !== t.shown) {
        t.shown = vis;
        t.el.style.display = vis ? '' : 'none';
        if (vis && !t.w) t.w = t.el.offsetWidth;
      }
      if (!vis) continue;
      t.el.classList.toggle('left', left);
      const tx = left ? x - GAP - (t.w || 80) : x + GAP;
      t.el.style.transform = `translate(${Math.round(tx)}px, ${Math.round(y)}px) translateY(-50%)`;
    }
  }

  private collides(b: Box): boolean {
    for (const q of this.placed) if (b.x0 < q.x1 + 4 && b.x1 > q.x0 - 4 && b.y0 < q.y1 + 2 && b.y1 > q.y0 - 2) return true;
    return false;
  }
}

function isVisible(o: THREE.Object3D): boolean {
  let c: THREE.Object3D | null = o;
  while (c) {
    if (!c.visible) return false;
    c = c.parent;
  }
  return true;
}
