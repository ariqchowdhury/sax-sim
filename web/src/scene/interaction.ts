// Raycast picking, hover highlight + tag, click and constrained drags that cooperate with OrbitControls.
//
// Manipulation UX (docs/UX_REVIEW.md):
//  • pointer-down is handled in the capture phase; when it lands on a part the event never reaches
//    OrbitControls (no orbit/drag fights). Empty space orbits as before.
//  • generous hit targets: when the ray misses, the nearest drag handle within 22 px (34 px touch)
//    on screen is picked.
//  • Shift while dragging = fine adjustment (¼ of the pointer motion).
//  • hover shows a short tag (part · gesture); while dragging, `readout` (supplied by the UI) renders
//    a large value/effect card next to the cursor.
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { setHandleActive, type PartMeta, type TooltipFn } from './handles';

export interface DragSpec {
  /** world-space plane normal for this drag, given the start point */
  planeNormal(start: THREE.Vector3, camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3;
  begin?(start: THREE.Vector3, e: PointerEvent): void;
  move(point: THREE.Vector3, start: THREE.Vector3, e: PointerEvent): void;
  end?(): void;
  /**
   * screen-space gain: world directions of the drag's value axes and the world length of each axis'
   * full value range (0 = no gain on that axis). Optional `lock`: lock to one axis after LOCK_PX.
   */
  gain?: { axes(): THREE.Vector3[]; ranges(): number[]; lock?: string[] };
}

export interface Pickable {
  objects: THREE.Object3D[];
  tooltip(): string;
  hover?(on: boolean): void;
  /** click without significant drag; return true if handled */
  click?(e: PointerEvent): void;
  /** pointer pressed / released on this pickable (momentary actions) */
  press?(e: PointerEvent): void;
  release?(e: PointerEvent): void;
  drag?: DragSpec;
  /** draggables get priority over plain meshes at equal distance */
  priority?: number;
  enabled?(): boolean;
}

/** part name / gesture hint / param ids of a pickable (from `paramTooltip`), if it has them */
export function partMeta(p: Pickable): PartMeta | undefined {
  return (p.tooltip as TooltipFn).meta;
}

const tmpN = new THREE.Vector3();
const tmpV = new THREE.Vector3();

/** Plane containing `axis` that faces the camera as much as possible (for 1-D axis drags). */
export function axisPlaneNormal(axis: THREE.Vector3, start: THREE.Vector3, camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
  const view = tmpV.copy(camera.position).sub(start).normalize();
  out.crossVectors(axis, view).cross(axis).normalize();
  if (out.lengthSq() < 1e-6) out.copy(view);
  return out;
}

/** screen-space pick radius for handles when the ray misses (px) */
const SNAP_PX = { mouse: 22, pen: 22, touch: 34 } as Record<string, number>;
/** fine-adjust factor while Shift is held during a drag */
const FINE = 0.25;
/** a part's full value range spans this many screen px at any zoom (when its natural size is outside) */
export const RANGE_PX = { min: 200, max: 250 };
/** pointer motion before an axis-locked drag commits to an axis (px) */
export const LOCK_PX = 6;

/** gain so that a range that is `px` long on screen behaves as if it were RANGE_PX long */
function rangeGain(px: number): number {
  if (!(px > 0)) return 1;
  if (px < RANGE_PX.min) return px / RANGE_PX.min;
  if (px > RANGE_PX.max) return px / RANGE_PX.max;
  return 1;
}

export class Interaction {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private pickables: Pickable[] = [];
  private objects: THREE.Object3D[] = [];
  /** top-level handle meshes (drawn on top, eligible for the screen-space fallback) */
  private handles: { o: THREE.Object3D; p: Pickable }[] = [];
  private hovered: Pickable | null = null;
  private active: Pickable | null = null;
  private dragPlane = new THREE.Plane();
  private dragStart = new THREE.Vector3();
  private dragPoint = new THREE.Vector3();
  private prevRaw = new THREE.Vector3();
  /** axis-lock state of the current drag: -1 = undecided / none; accumulated motion per axis */
  private lockAxis = -1;
  private lockAcc = [0, 0];
  private fineRaw = new THREE.Vector3();
  private downXY = new THREE.Vector2();
  private moved = false;
  private pointerInside = false;
  private pointerType = 'mouse';
  private needsPick = false;
  private tooltip: HTMLDivElement;
  private tipMode: 'tag' | 'readout' = 'tag';
  private mouse = new THREE.Vector2();
  enabled = true;
  /** UI hook: HTML for the large drag readout card (null → plain tag) */
  readout: ((p: Pickable) => string | null) | null = null;
  /** UI hooks: a part was grabbed (pointer down on it) / released (moved = it was a drag) */
  onGrab: ((p: Pickable) => void) | null = null;
  onRelease: ((p: Pickable, moved: boolean) => void) | null = null;
  onHoverChange: ((p: Pickable | null) => void) | null = null;

  constructor(
    private dom: HTMLElement,
    private camera: THREE.Camera,
    private controls: OrbitControls,
  ) {
    this.raycaster.params.Line = { threshold: 0.003 };
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    this.tooltip.setAttribute('role', 'status');
    document.body.appendChild(this.tooltip);
    dom.addEventListener('pointermove', this.onMove);
    // capture phase: runs before OrbitControls' own pointerdown on the same element
    dom.addEventListener('pointerdown', this.onDown, { capture: true });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      if (!this.active) this.setHover(null);
    });
  }

  add(p: Pickable): void {
    this.pickables.push(p);
    for (const o of p.objects) {
      o.traverse((c) => {
        c.userData.pickable = p;
      });
      this.objects.push(o);
      if (o.userData.isHandle) this.handles.push({ o, p });
    }
  }

  /** all registered pickables (read-only use: grab hints, docs) */
  get all(): readonly Pickable[] {
    return this.pickables;
  }

  get isDragging(): boolean {
    return this.active !== null && this.active.drag !== undefined;
  }

  /** the part under the pointer or being dragged */
  get current(): Pickable | null {
    return this.active ?? this.hovered;
  }

  get activePickable(): Pickable | null {
    return this.active;
  }

  /** label of the axis the current drag is locked to (axis-locked parts), else null */
  get lockLabel(): string | null {
    const l = this.active?.drag?.gain?.lock;
    return l && this.lockAxis >= 0 ? l[this.lockAxis] : null;
  }

  /** world size of one screen pixel at `p` */
  private worldPerPx(p: THREE.Vector3): number {
    const c = this.camera as THREE.PerspectiveCamera;
    const h = this.dom.clientHeight || 800;
    if (!c.isPerspectiveCamera) return 1 / h;
    return (2 * p.distanceTo(c.position) * Math.tan((c.fov * Math.PI) / 360)) / (c.zoom || 1) / h;
  }

  private setNdc(e: PointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.mouse.set(e.clientX, e.clientY);
    this.pointerType = e.pointerType || 'mouse';
  }

  private pick(): { p: Pickable; point: THREE.Vector3 } | null {
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.objects, true);
    let best: { p: Pickable; point: THREE.Vector3; score: number } | null = null;
    for (const h of hits) {
      if (!isVisible(h.object)) continue;
      const p = h.object.userData.pickable as Pickable | undefined;
      if (!p || (p.enabled && !p.enabled())) continue;
      if (h.object.userData.isHandle && isCollapsed(h.object)) continue;
      // drag handles are drawn on top (no depth test) so they always win; otherwise nearest hit,
      // with `priority` as a small tie-breaker (mm scale)
      const score = h.distance - (h.object.userData.isHandle ? 100 : 0) - (p.priority ?? 0) * 0.002;
      if (!best || score < best.score) {
        // a handle is grabbed at its centre (no jump for parts mapped from the handle position)
        let o: THREE.Object3D = h.object;
        while (o.parent?.userData.isHandle) o = o.parent;
        best = { p, point: o.userData.isHandle ? o.getWorldPosition(new THREE.Vector3()) : h.point.clone(), score };
      }
    }
    if (best) return best;
    return this.snapToHandle();
  }

  /** nearest visible handle within SNAP_PX of the pointer (screen space), for small/far handles */
  private snapToHandle(): { p: Pickable; point: THREE.Vector3 } | null {
    const r = this.dom.getBoundingClientRect();
    const lim = SNAP_PX[this.pointerType] ?? 22;
    let best: { p: Pickable; o: THREE.Object3D; d: number } | null = null;
    for (const h of this.handles) {
      if (!isVisible(h.o) || isCollapsed(h.o) || (h.p.enabled && !h.p.enabled())) continue;
      h.o.getWorldPosition(tmpV).project(this.camera);
      if (tmpV.z > 1) continue;
      const x = r.left + ((tmpV.x + 1) / 2) * r.width, y = r.top + ((1 - tmpV.y) / 2) * r.height;
      const d = Math.hypot(x - this.mouse.x, y - this.mouse.y);
      if (d < lim && (!best || d < best.d)) best = { p: h.p, o: h.o, d };
    }
    return best ? { p: best.p, point: best.o.getWorldPosition(new THREE.Vector3()) } : null;
  }

  private onMove = (e: PointerEvent): void => {
    this.pointerInside = true;
    this.setNdc(e);
    if (this.active?.drag) {
      if (this.downXY.distanceTo(this.mouse) > 3) this.moved = true;
      this.raycaster.setFromCamera(this.ndc, this.camera);
      if (this.raycaster.ray.intersectPlane(this.dragPlane, this.fineRaw)) {
        // incremental: the effective point follows the pointer's motion on the drag plane, scaled
        // by FINE while Shift is held (continuous when Shift toggles; no jump for snapped handles)
        const d = tmpV.copy(this.fineRaw).sub(this.prevRaw);
        this.prevRaw.copy(this.fineRaw);
        if (!this.applyGain(this.active.drag, d, e.shiftKey ? FINE : 1)) return;
        this.active.drag.move(this.dragPoint, this.dragStart, e);
      }
    } else if (this.active) {
      if (this.downXY.distanceTo(this.mouse) > 3) this.moved = true;
    } else {
      this.needsPick = true;
    }
    this.placeTooltip();
  };

  /**
   * Move the effective drag point by the raw on-plane motion `d`, scaled per value axis so that the
   * part's full range spans RANGE_PX on screen, and (axis-locked parts) restricted to one axis once
   * the pointer has moved LOCK_PX. Returns false while an axis-locked drag is still undecided.
   */
  private applyGain(drag: DragSpec, d: THREE.Vector3, fine: number): boolean {
    const g = drag.gain;
    if (!g) { this.dragPoint.addScaledVector(d, fine); return true; }
    const axes = g.axes(), ranges = g.ranges();
    const wpp = this.worldPerPx(this.dragPoint);
    const k = (i: number): number => (ranges[i] > 0 ? rangeGain(ranges[i] / wpp) : 1) * fine;
    if (g.lock && axes.length > 1) {
      if (this.lockAxis < 0) {
        for (let i = 0; i < 2; i++) this.lockAcc[i] += d.dot(axes[i]);
        const a0 = Math.abs(this.lockAcc[0]), a1 = Math.abs(this.lockAcc[1]);
        if (Math.max(a0, a1) / wpp < LOCK_PX) return false;
        this.lockAxis = a0 >= a1 ? 0 : 1;
        this.dragPoint.addScaledVector(axes[this.lockAxis], this.lockAcc[this.lockAxis] * k(this.lockAxis));
        return true;
      }
      this.dragPoint.addScaledVector(axes[this.lockAxis], d.dot(axes[this.lockAxis]) * k(this.lockAxis));
      return true;
    }
    for (let i = 0; i < axes.length; i++) this.dragPoint.addScaledVector(axes[i], d.dot(axes[i]) * k(i));
    return true;
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0 || this.active) return;
    this.setNdc(e);
    const hit = this.pick();
    if (!hit) return;
    // a part was hit: this gesture is ours, not the camera's
    e.stopImmediatePropagation();
    e.preventDefault();
    this.active = hit.p;
    this.moved = false;
    this.downXY.copy(this.mouse);
    this.controls.enabled = false;
    this.dom.setPointerCapture?.(e.pointerId);
    // before begin(): the UI may set the part's values first (Play mode take-over)
    this.onGrab?.(hit.p);
    hit.p.press?.(e);
    if (hit.p.drag) {
      this.dragStart.copy(hit.point);
      this.dragPoint.copy(hit.point);
      hit.p.drag.planeNormal(hit.point, this.camera, tmpN);
      this.dragPlane.setFromNormalAndCoplanarPoint(tmpN, hit.point);
      // start from where the pointer meets the drag plane (a snapped handle may be a few px away)
      this.raycaster.setFromCamera(this.ndc, this.camera);
      if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.prevRaw)) this.prevRaw.copy(hit.point);
      hit.p.drag.begin?.(hit.point, e);
      this.lockAxis = -1;
      this.lockAcc[0] = this.lockAcc[1] = 0;
      for (const o of hit.p.objects) if (o.userData.isHandle) setHandleActive(o, true);
    }
    this.setHover(hit.p);
    this.dom.classList.add('grabbing');
  };

  private onUp = (e: PointerEvent): void => {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.controls.enabled = true;
    a.release?.(e);
    if (a.drag) {
      a.drag.end?.();
      for (const o of a.objects) if (o.userData.isHandle) { setHandleActive(o, false); if (this.moved) o.userData.grabbed = true; }
      a.hover?.(this.hovered === a);
    }
    if (!this.moved) a.click?.(e);
    this.onRelease?.(a, this.moved);
    this.dom.classList.remove('grabbing');
    this.needsPick = true;
    // touch has no hover: drop the highlight once the finger lifts
    if (e.pointerType === 'touch') this.setHover(null);
  };

  private setHover(p: Pickable | null): void {
    if (p === this.hovered) return;
    this.hovered?.hover?.(false);
    this.hovered = p;
    p?.hover?.(true);
    this.dom.style.cursor = p ? (p.drag ? 'grab' : 'pointer') : '';
    this.onHoverChange?.(p);
  }

  private placeTooltip(): void {
    const t = this.tooltip;
    let x = this.mouse.x + 18, y = this.mouse.y + 18;
    if (this.tipMode === 'readout') {
      // keep the big readout beside (not over) the part being dragged, inside the window
      const w = t.offsetWidth || 240, h = t.offsetHeight || 120;
      x = this.mouse.x + 28;
      y = this.mouse.y - h - 18;
      if (x + w > window.innerWidth - 8) x = this.mouse.x - w - 28;
      if (y < 8) y = this.mouse.y + 28;
      if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    } else if (x + 260 > window.innerWidth) x = this.mouse.x - 260;
    t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /** short hover tag: "Tongue body · drag ↔ front/back, ↕ low/high"; keys keep their own text */
  private tagText(p: Pickable): string {
    const m = partMeta(p);
    return m ? `${m.name} · ${m.hint}` : p.tooltip();
  }

  /** call once per frame */
  update(): void {
    if (this.needsPick && !this.active && this.pointerInside && this.enabled) {
      this.needsPick = false;
      const hit = this.pick();
      this.setHover(hit ? hit.p : null);
    }
    const p = this.active ?? this.hovered;
    const t = this.tooltip;
    if (p && (this.pointerInside || this.active)) {
      const html = this.active?.drag && this.readout ? this.readout(this.active) : null;
      if (html !== null) {
        if (this.tipMode !== 'readout') { this.tipMode = 'readout'; t.className = 'tooltip readout'; }
        if (t.innerHTML !== html) t.innerHTML = html;
      } else {
        if (this.tipMode !== 'tag') { this.tipMode = 'tag'; t.className = 'tooltip'; }
        const text = this.tagText(p);
        if (t.textContent !== text) t.textContent = text;
      }
      this.placeTooltip();
      t.style.opacity = '1';
      if (this.active?.drag) this.dom.style.cursor = 'grabbing';
    } else {
      t.style.opacity = '0';
    }
  }

  /** force re-pick next frame (e.g. after camera move) */
  invalidate(): void {
    this.needsPick = true;
  }
}

/** a handle hidden by the declutter rule (ui/clusters.ts) */
export function isCollapsed(o: THREE.Object3D): boolean {
  return !!o.userData.collapsed;
}

function isVisible(o: THREE.Object3D): boolean {
  let c: THREE.Object3D | null = o;
  while (c) {
    if (!c.visible) return false;
    c = c.parent;
  }
  return true;
}
