// DOM labels anchored to 3D objects (pressure / flow readouts in the vocal tract).
import * as THREE from 'three';

interface Label {
  el: HTMLDivElement;
  value: HTMLSpanElement;
  anchor: THREE.Object3D;
  visible: boolean;
  dx: number;
  dy: number;
  x: number;
  y: number;
}

const _v = new THREE.Vector3();

export class Labels {
  private items: Label[] = [];
  enabled = true;
  constructor(private root: HTMLElement, private camera: THREE.Camera, private dom: HTMLElement) {}

  /** maximum camera distance (m) at which labels are shown */
  maxDistance = 1.9;

  add(anchor: THREE.Object3D, title: string, color: string, dx = 0, dy = 0): HTMLSpanElement {
    const el = document.createElement('div');
    el.className = 'label3d';
    el.style.borderColor = color;
    const t = document.createElement('small');
    t.textContent = title;
    const value = document.createElement('span');
    value.textContent = '—';
    el.append(t, value);
    this.root.appendChild(el);
    this.items.push({ el, value, anchor, visible: true, dx, dy, x: -1, y: -1 });
    return value;
  }

  /** per frame: project anchors; only touches the DOM when a label moved ≥ 0.5 px */
  update(): void {
    const r = this.dom.getBoundingClientRect();
    for (const it of this.items) {
      let vis = this.enabled && isVisible(it.anchor);
      if (vis) {
        it.anchor.getWorldPosition(_v);
        vis = _v.distanceTo(this.camera.position) < this.maxDistance;
        _v.project(this.camera);
        vis = vis && _v.z < 1 && Math.abs(_v.x) < 1.05 && Math.abs(_v.y) < 1.05;
      }
      if (vis !== it.visible) {
        it.visible = vis;
        it.el.style.display = vis ? '' : 'none';
      }
      if (!vis) continue;
      const x = Math.round(r.left + ((_v.x + 1) / 2) * r.width + it.dx);
      const y = Math.round(r.top + ((1 - _v.y) / 2) * r.height + it.dy);
      if (x !== it.x || y !== it.y) {
        it.x = x;
        it.y = y;
        it.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      }
    }
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
