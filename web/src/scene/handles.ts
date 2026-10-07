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
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(radius * 1.25, radius * 1.6, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false, side: THREE.DoubleSide }),
  );
  halo.renderOrder = 21;
  halo.onBeforeRender = (_r, _s, cam) => {
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

export function paramTooltip(state: AppState, ids: number[], title?: string): () => string {
  return () => {
    const parts = ids.map((id) => `${PARAMS[id].label}: ${formatParam(id, state.get(id))}`);
    return (title ? title + ' — ' : '') + parts.join(' · ');
  };
}

export function setHandleHover(mesh: THREE.Mesh, on: boolean): void {
  const m = mesh.material as THREE.MeshBasicMaterial;
  m.opacity = on ? 1 : 0.85;
  mesh.scale.setScalar(on ? 1.35 : 1);
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
): DragSpec {
  let start: number[] = [];
  const ls = new THREE.Vector3();
  const lp = new THREE.Vector3();
  return {
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
}

/** 1-D drag along a local axis of `frame`; apply(delta along axis in local units, start values) */
export function axisDrag(
  frame: THREE.Object3D,
  localAxis: THREE.Vector3,
  state: AppState,
  ids: number[],
  apply: (delta: number, start: number[]) => void,
): DragSpec {
  let start: number[] = [];
  const s0 = new THREE.Vector3();
  const axisW = new THREE.Vector3();
  return {
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
}
