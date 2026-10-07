// Raycast picking, hover highlight + tooltip, click and constrained drags that cooperate with OrbitControls.
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface DragSpec {
  /** world-space plane normal for this drag, given the start point */
  planeNormal(start: THREE.Vector3, camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3;
  begin?(start: THREE.Vector3, e: PointerEvent): void;
  move(point: THREE.Vector3, start: THREE.Vector3, e: PointerEvent): void;
  end?(): void;
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

const tmpN = new THREE.Vector3();
const tmpV = new THREE.Vector3();

/** Plane containing `axis` that faces the camera as much as possible (for 1-D axis drags). */
export function axisPlaneNormal(axis: THREE.Vector3, start: THREE.Vector3, camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
  const view = tmpV.copy(camera.position).sub(start).normalize();
  out.crossVectors(axis, view).cross(axis).normalize();
  if (out.lengthSq() < 1e-6) out.copy(view);
  return out;
}

export class Interaction {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private pickables: Pickable[] = [];
  private objects: THREE.Object3D[] = [];
  private hovered: Pickable | null = null;
  private active: Pickable | null = null;
  private dragPlane = new THREE.Plane();
  private dragStart = new THREE.Vector3();
  private dragPoint = new THREE.Vector3();
  private downXY = new THREE.Vector2();
  private moved = false;
  private pointerInside = false;
  private needsPick = false;
  private tooltip: HTMLDivElement;
  private mouse = new THREE.Vector2();
  enabled = true;

  constructor(
    private dom: HTMLElement,
    private camera: THREE.Camera,
    private controls: OrbitControls,
  ) {
    this.raycaster.params.Line = { threshold: 0.003 };
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    document.body.appendChild(this.tooltip);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
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
    }
  }

  get isDragging(): boolean {
    return this.active !== null && this.active.drag !== undefined;
  }

  private setNdc(e: PointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.mouse.set(e.clientX, e.clientY);
  }

  private pick(): { p: Pickable; point: THREE.Vector3 } | null {
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.objects, true);
    let best: { p: Pickable; point: THREE.Vector3; score: number } | null = null;
    for (const h of hits) {
      if (!isVisible(h.object)) continue;
      const p = h.object.userData.pickable as Pickable | undefined;
      if (!p || (p.enabled && !p.enabled())) continue;
      // drag handles are drawn on top (no depth test) so they always win; otherwise nearest hit,
      // with `priority` as a small tie-breaker (mm scale)
      const score = h.distance - (h.object.userData.isHandle ? 100 : 0) - (p.priority ?? 0) * 0.002;
      if (!best || score < best.score) best = { p, point: h.point.clone(), score };
    }
    return best;
  }

  private onMove = (e: PointerEvent): void => {
    this.pointerInside = true;
    this.setNdc(e);
    if (this.active?.drag) {
      if (this.downXY.distanceTo(this.mouse) > 3) this.moved = true;
      this.raycaster.setFromCamera(this.ndc, this.camera);
      if (this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)) {
        this.active.drag.move(this.dragPoint, this.dragStart, e);
      }
    } else if (this.active) {
      if (this.downXY.distanceTo(this.mouse) > 3) this.moved = true;
    } else {
      this.needsPick = true;
    }
    this.placeTooltip();
  };

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0) return;
    this.setNdc(e);
    const hit = this.pick();
    if (!hit) return;
    this.active = hit.p;
    this.moved = false;
    this.downXY.copy(this.mouse);
    this.controls.enabled = false;
    this.dom.setPointerCapture?.(e.pointerId);
    hit.p.press?.(e);
    if (hit.p.drag) {
      this.dragStart.copy(hit.point);
      hit.p.drag.planeNormal(hit.point, this.camera, tmpN);
      this.dragPlane.setFromNormalAndCoplanarPoint(tmpN, hit.point);
      hit.p.drag.begin?.(hit.point, e);
    }
    this.setHover(hit.p);
  };

  private onUp = (e: PointerEvent): void => {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.controls.enabled = true;
    a.release?.(e);
    if (a.drag) a.drag.end?.();
    if (!this.moved) a.click?.(e);
    this.needsPick = true;
  };

  private setHover(p: Pickable | null): void {
    if (p === this.hovered) return;
    this.hovered?.hover?.(false);
    this.hovered = p;
    p?.hover?.(true);
    this.dom.style.cursor = p ? (p.drag ? 'grab' : 'pointer') : '';
  }

  private placeTooltip(): void {
    const t = this.tooltip;
    t.style.transform = `translate(${this.mouse.x + 14}px, ${this.mouse.y + 16}px)`;
  }

  /** call once per frame */
  update(): void {
    if (this.needsPick && !this.active && this.pointerInside && this.enabled) {
      this.needsPick = false;
      const hit = this.pick();
      this.setHover(hit ? hit.p : null);
    }
    const p = this.active ?? this.hovered;
    if (p && this.pointerInside) {
      const text = p.tooltip();
      if (this.tooltip.textContent !== text) this.tooltip.textContent = text;
      this.tooltip.style.opacity = '1';
      if (this.active?.drag) this.dom.style.cursor = 'grabbing';
    } else {
      this.tooltip.style.opacity = '0';
    }
  }

  /** force re-pick next frame (e.g. after camera move) */
  invalidate(): void {
    this.needsPick = true;
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
