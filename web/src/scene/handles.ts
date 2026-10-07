// Draggable handle helpers that bind 3D drags to params.
import * as THREE from 'three';
import { PARAMS, formatParam } from '../engine/params';
import type { AppState } from '../state';
import { axisPlaneNormal, type DragSpec } from './interaction';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export function handleMesh(radius = 0.0025, color = 0x4aa8ff): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }),
  );
  m.renderOrder = 20;
  // never smaller than MIN_HANDLE_PX (radius) on screen: grows when the camera is far away
  m.userData.uiScale = 1;
  m.onBeforeRender = (r, _s, cam) => {
    const pc = cam as THREE.PerspectiveCamera;
    m.getWorldPosition(_p);
    const dist = _p.distanceTo(cam.position);
    const parentScale = m.parent ? m.parent.getWorldScale(_ws).x : 1;
    const h = r.domElement.clientHeight || 800;
    const px = pc.isPerspectiveCamera ? ((radius * parentScale) / (dist * Math.tan((pc.fov * Math.PI) / 360))) * (h / 2) : MIN_HANDLE_PX;
    const s = (m.userData.uiScale as number) * Math.min(4, Math.max(1, MIN_HANDLE_PX / Math.max(1e-6, px)));
    if (Math.abs(m.scale.x - s) > 1e-4) { m.scale.setScalar(s); m.updateMatrixWorld(true); }
  };
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(radius * 1.25, radius * 1.6, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false, side: THREE.DoubleSide }),
  );
  halo.renderOrder = 21;
  const haloMat = halo.material as THREE.MeshBasicMaterial;
  halo.onBeforeRender = (_r, _s, cam) => {
    // affordance hint: a slow "breathing" halo on parts the user has not grabbed yet
    const hint = handleFx.pulse && !m.userData.grabbed;
    const k = hint ? 0.5 + 0.5 * Math.sin(performance.now() * 0.004) : 0;
    halo.scale.setScalar(1 + 0.45 * k);
    haloMat.opacity = hint ? 0.35 + 0.45 * (1 - k) : 0.6;
    halo.quaternion.copy(cam.quaternion);
    if (halo.parent) {
      halo.parent.getWorldQuaternion(_q).invert();
      halo.quaternion.premultiply(_q);
    }
  };
  m.add(halo);
  m.userData.isHandle = true;
  halo.userData.isHandle = true;
  return m;
}
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _ws = new THREE.Vector3();
/** minimum on-screen radius of a drag handle (px) */
const MIN_HANDLE_PX = 6;

/**
 * Global affordance switches for drag handles (owned by the UI layer):
 * `pulse` — breathing halo on handles whose `userData.grabbed` is not set yet (grab hints).
 */
export const handleFx = { pulse: true };

/** Metadata the UI reads from a pickable's tooltip function (which params a part drives). */
export interface PartMeta {
  /** part name, e.g. "Tongue body" */
  name: string;
  /** gesture hint, e.g. "drag ↔ front/back, ↕ low/high" */
  hint: string;
  /** param ids the part drives */
  ids: number[];
}
export type TooltipFn = (() => string) & { meta?: PartMeta };

export function paramTooltip(state: AppState, ids: number[], title?: string): TooltipFn {
  const fn: TooltipFn = () => {
    const parts = ids.map((id) => `${PARAMS[id].label}: ${formatParam(id, state.get(id))}`);
    return (title ? title + ' — ' : '') + parts.join(' · ');
  };
  // "Tongue body (drag ↔ front/back, ↕ low/high)" → name + hint
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(title ?? '');
  fn.meta = { name: m ? m[1] : title ?? PARAMS[ids[0]]?.label ?? '', hint: m ? m[2] : 'drag', ids };
  return fn;
}

export function setHandleHover(mesh: THREE.Mesh, on: boolean): void {
  const m = mesh.material as THREE.MeshBasicMaterial;
  m.opacity = on ? 1 : 0.85;
  if (!mesh.userData.active) mesh.userData.uiScale = on ? 1.35 : 1;
}

/** "active" look while a handle is being dragged (larger, fully opaque) */
export function setHandleActive(mesh: THREE.Object3D, on: boolean): void {
  mesh.userData.active = on;
  mesh.userData.uiScale = on ? 1.7 : 1;
  const mat = (mesh as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
  if (mat) mat.opacity = on ? 1 : 0.85;
}

/** Options for screen-space drag gain and axis locking (consumed by `Interaction`). */
export interface DragOpts {
  /**
   * length (in the frame's local units) of the FULL value range along the frame's local x and y
   * axes; the interaction scales pointer motion so that range spans ~200–250 px on screen at any
   * zoom. Omit an axis (or the option) for no gain on it.
   */
  ranges?: [number, number?];
  /** lock to one axis after the first few px of motion; labels shown in the drag card ([x, y]) */
  lock?: [string, string];
}

/**
 * A drag in a local 2-D frame of `frame` (an Object3D): the drag plane is the frame's local XY plane
 * (normal = local Z). `apply(localPoint, localStart, startValues)` maps to params.
 */
export function planarDrag(
  frame: THREE.Object3D,
  state: AppState,
  ids: number[],
  apply: (local: THREE.Vector3, localStart: THREE.Vector3, start: number[]) => void,
  opts: DragOpts = {},
): DragSpec {
  let start: number[] = [];
  const ls = new THREE.Vector3();
  const lp = new THREE.Vector3();
  const ax = [new THREE.Vector3(), new THREE.Vector3()];
  const spec: DragSpec = {
    planeNormal(_s, _cam, out) {
      return out.set(0, 0, 1).transformDirection(frame.matrixWorld);
    },
    begin(s) {
      start = ids.map((id) => state.get(id));
      ls.copy(s);
      frame.worldToLocal(ls);
    },
    move(p) {
      lp.copy(p);
      frame.worldToLocal(lp);
      apply(lp, ls, start);
    },
  };
  if (opts.ranges) {
    const r = opts.ranges;
    spec.gain = {
      axes: () => [ax[0].set(1, 0, 0).transformDirection(frame.matrixWorld), ax[1].set(0, 1, 0).transformDirection(frame.matrixWorld)],
      ranges: () => { const sc = frame.getWorldScale(_b).x || 1; return [r[0] * sc, r[1] !== undefined ? r[1] * sc : 0]; },
      lock: opts.lock,
    };
  }
  return spec;
}

/**
 * 1-D drag along a local axis of `frame`; apply(delta along axis in local units, start values).
 * `range`: local length of the full value range (screen-space drag gain, see DragOpts.ranges).
 */
export function axisDrag(
  frame: THREE.Object3D,
  localAxis: THREE.Vector3,
  state: AppState,
  ids: number[],
  apply: (delta: number, start: number[]) => void,
  range?: number,
): DragSpec {
  let start: number[] = [];
  const s0 = new THREE.Vector3();
  const axisW = new THREE.Vector3();
  const spec: DragSpec = {
    planeNormal(s, cam, out) {
      axisW.copy(localAxis).transformDirection(frame.matrixWorld);
      return axisPlaneNormal(axisW, s, cam, out);
    },
    begin(s) {
      start = ids.map((id) => state.get(id));
      s0.copy(s);
    },
    move(p) {
      _a.copy(p).sub(s0);
      // world delta → local units along axis
      const scale = frame.getWorldScale(_b).x || 1;
      apply(_a.dot(axisW) / scale, start);
    },
  };
  if (range !== undefined) {
    const aw = new THREE.Vector3();
    spec.gain = {
      axes: () => [aw.copy(localAxis).transformDirection(frame.matrixWorld)],
      ranges: () => [range * (frame.getWorldScale(_c).x || 1)],
    };
  }
  return spec;
}
const _c = new THREE.Vector3();
