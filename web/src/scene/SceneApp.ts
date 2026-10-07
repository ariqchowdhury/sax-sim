// Three.js scene orchestration: renderer, camera presets, models, picking, per-frame update.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { P } from '../engine/params';
import type { EngineClient, Telemetry } from '../engine/EngineClient';
import { KEY_SRC, type AppState } from '../state';
import { Airflow } from './airflow';
import { BorePath } from './borePath';
import type { SaxGeometry } from './geometry';
import { Interaction } from './interaction';
import { Keywork } from './keywork';
import { Materials } from './materials';
import { MouthpieceModel } from './mouthpiece';
import { PlayerModel } from './player';
import { RenderPipeline } from './render/RenderPipeline';
import { SaxModel } from './sax';

/** telemetry: reed deflection samples appended after the scope (engine telemetry.rs REED_SHAPE_LEN) */
const REED_SHAPE_LEN = 32;

export type CameraPreset = 'full' | 'mouthpiece' | 'player' | 'keys';

export interface SceneOptions {
  xray: boolean;
  cutaway: boolean;
  airflow: boolean;
  wave: boolean;
  player: boolean;
  reedGain: number;
}

export class SceneApp {
  readonly renderer: THREE.WebGLRenderer;
  /** render pipeline (lights, IBL, shadows, post, quality tiers) — see render/quality.ts for the settings API */
  readonly render: RenderPipeline;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly interaction: Interaction;
  readonly path: BorePath;
  readonly keywork: Keywork;
  readonly sax: SaxModel;
  readonly mp: MouthpieceModel;
  readonly player: PlayerModel;
  readonly airflow: Airflow;
  readonly mats = new Materials();
  readonly predicted: Float32Array;
  readonly padTarget: Float32Array;
  readonly opts: SceneOptions = { xray: false, cutaway: true, airflow: true, wave: true, player: true, reedGain: 3 };
  private timer = new THREE.Timer();
  private tween: { t: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; q0: THREE.Vector3; q1: THREE.Vector3 } | null = null;
  peakPa = 500;
  fps = 60;
  private frameCb: ((dt: number) => void)[] = [];

  constructor(
    private container: HTMLElement,
    readonly geo: SaxGeometry,
    private state: AppState,
    private engine: EngineClient,
  ) {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    r.localClippingEnabled = true;
    container.appendChild(r.domElement);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.005, 20);
    this.render = new RenderPipeline(r, this.scene, this.camera);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.04;
    this.controls.maxDistance = 4;
    this.controls.zoomToCursor = true;

    this.path = new BorePath(geo);
    this.keywork = new Keywork(geo);
    if (this.keywork.warnings.length) console.warn('[keywork]', this.keywork.warnings);
    this.predicted = new Float32Array(this.keywork.holeCount);
    this.padTarget = new Float32Array(this.keywork.holeCount);
    this.keywork.evaluate(state.keyDown, this.predicted);

    this.sax = new SaxModel(geo, this.path, this.mats);
    this.scene.add(this.sax.group);
    this.mp = new MouthpieceModel(geo, this.path, this.mats, state);
    this.scene.add(this.mp.root, this.mp.corkMesh);
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(this.mp.root.quaternion);
    this.player = new PlayerModel(this.mp, state, axis);
    this.scene.add(this.player.torso);
    this.airflow = new Airflow(this.path);
    this.scene.add(this.airflow.points);

    this.interaction = new Interaction(r.domElement, this.camera, this.controls);
    this.registerKeys();
    this.mp.registerHandles(this.interaction);
    this.player.registerHandles(this.interaction);
    this.controls.addEventListener('change', () => this.interaction.invalidate());

    this.setXray(false);
    this.setCutaway(true);
    this.mp.update(0, null);
    this.player.update(0, 0, 0, 0);
    this.goto('full', true);
    this.render.frame([this.sax.group], [this.sax.group]);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    state.onKeys(() => this.keywork.evaluate(state.keyDown, this.predicted));
    r.setAnimationLoop(() => this.frame());
  }

  private afterRenderCb: (() => void)[] = [];
  /** UI hook: runs after the main frame is rendered (picture-in-picture insets) */
  onAfterRender(cb: () => void): void {
    this.afterRenderCb.push(cb);
  }

  onFrame(cb: (dt: number) => void): void {
    this.frameCb.push(cb);
  }

  private registerKeys(): void {
    const st = this.state;
    for (const k of this.sax.keys) {
      const i = k.index;
      this.interaction.add({
        objects: [k.group],
        priority: 1,
        tooltip: () => {
          const m = st.keyMask[i];
          const how = m & KEY_SRC.latch ? 'held (click to release)' : m ? 'pressed (click to release)' : 'click = hold · shift-click = momentary';
          return `${k.def.label ?? k.def.id} [${k.def.id}] — ${how}`;
        },
        hover: (on) => this.sax.setKeyHover(i, on),
        press: (e) => { if (e.shiftKey) st.setKeySource(i, KEY_SRC.mouse, true); },
        release: () => st.setKeySource(i, KEY_SRC.mouse, false),
        click: (e) => { if (!e.shiftKey) st.toggleKey(i); },
      });
    }
    // pad cups: tooltip with live openness; clicking a cup toggles the key that directly acts on it
    this.sax.holes.forEach((h) => {
      const ki = this.geo.keys.findIndex((k) => (k.actions ?? []).some((a) => a.hole === h.def.id));
      this.interaction.add({
        objects: [h.pivot],
        tooltip: () => `Tone hole ${h.def.id}${h.def.vents ? ` (vents ${h.def.vents})` : ''} — ${Math.round(h.open * 100)}% open, rest ${h.def.pad_rest}` +
          (ki >= 0 ? ` · click: ${this.geo.keys[ki].id}` : ''),
        click: (e) => { if (ki >= 0 && !e.shiftKey) st.toggleKey(ki); },
        press: (e) => { if (ki >= 0 && e.shiftKey) st.setKeySource(ki, KEY_SRC.mouse, true); },
        release: () => { if (ki >= 0) st.setKeySource(ki, KEY_SRC.mouse, false); },
      });
    });
  }

  setXray(on: boolean): void {
    this.opts.xray = on;
    this.mats.setXray(on);
  }

  setCutaway(on: boolean): void {
    this.opts.cutaway = on;
    this.mp.setCutaway(on);
    this.player.setCutaway(on);
  }

  setPlayerVisible(on: boolean): void {
    this.opts.player = on;
    this.player.head.visible = on;
    this.player.torso.visible = on;
  }

  resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.render.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    // shift the projection centre into the part of the window not covered by open UI (drawers,
    // now-playing bar); see setViewInsets
    const v = this.insets;
    const ox = (v.right - v.left) / 2, oy = (v.bottom - v.top) / 2;
    if (ox || oy) this.camera.setViewOffset(w, h, ox, oy, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  // ---- camera / controls (UI-owned) --------------------------------------------------------------
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };
  /** respect prefers-reduced-motion: camera presets jump instead of flying */
  reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** px of the window covered by UI on each side; the model is centred in the remaining area */
  setViewInsets(i: Partial<{ left: number; right: number; top: number; bottom: number }>): void {
    const n = { ...this.insets, ...i };
    if (n.left === this.insets.left && n.right === this.insets.right && n.top === this.insets.top && n.bottom === this.insets.bottom) return;
    this.insets = n;
    this.resize();
  }

  /** camera presets (computed from the actual model placement) */
  goto(preset: CameraPreset, instant = false): void {
    instant ||= this.reducedMotion;
    const tgt = new THREE.Vector3(), cam = new THREE.Vector3();
    this.mp.root.updateWorldMatrix(true, true);
    switch (preset) {
      case 'full': {
        const box = new THREE.Box3().setFromObject(this.sax.group);
        if (this.opts.player) box.expandByObject(this.player.head).expandByObject(this.player.torso);
        box.getCenter(tgt);
        const sz = box.getSize(new THREE.Vector3());
        const dist = (Math.max(sz.y, sz.z / Math.max(0.5, this.camera.aspect)) / 2 / Math.tan(fovRad(this.camera) / 2)) * 1.2;
        cam.copy(tgt).add(new THREE.Vector3(0.92, 0.12, 0.36).normalize().multiplyScalar(dist));
        break;
      }
      case 'mouthpiece': {
        this.mp.root.localToWorld(tgt.set(0.03, 0, 0));
        cam.copy(tgt).add(new THREE.Vector3(0.2, 0.035, 0.01));
        break;
      }
      case 'player': {
        const box = new THREE.Box3().setFromObject(this.player.head).expandByObject(this.player.torso);
        box.getCenter(tgt);
        const sz = box.getSize(new THREE.Vector3());
        const dist = (Math.max(sz.y, sz.z / Math.max(0.5, this.camera.aspect)) / 2 / Math.tan(fovRad(this.camera) / 2)) * 1.5;
        cam.copy(tgt).add(new THREE.Vector3(1, 0.08, 0.05).normalize().multiplyScalar(dist));
        break;
      }
      case 'keys': {
        const box = new THREE.Box3();
        for (const k of this.sax.keys) box.expandByObject(k.group);
        box.getCenter(tgt);
        const sz = box.getSize(new THREE.Vector3());
        const dist = (Math.max(sz.y, sz.z / Math.max(0.5, this.camera.aspect)) / 2 / Math.tan(fovRad(this.camera) / 2)) * 1.75;
        // from the player's right-front, so the torso/lungs sit behind the body tube rather than beside it
        cam.copy(tgt).add(new THREE.Vector3(1, 0.12, -0.2).normalize().multiplyScalar(dist));
        break;
      }
    }
    if (instant) {
      this.camera.position.copy(cam);
      this.controls.target.copy(tgt);
      this.controls.update();
      return;
    }
    this.tween = { t: 0, dur: 0.7, p0: this.camera.position.clone(), p1: cam, q0: this.controls.target.clone(), q1: tgt };
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(0.05, this.timer.getDelta());
    const time = this.timer.getElapsed();
    this.fps += (1 / Math.max(1e-3, dt) - this.fps) * 0.05;
    this.engine.poll();
    for (const cb of this.frameCb) cb(dt);

    if (this.tween) {
      const tw = this.tween;
      tw.t += dt / tw.dur;
      const e = tw.t >= 1 ? 1 : 1 - Math.pow(1 - tw.t, 3);
      this.camera.position.lerpVectors(tw.p0, tw.p1, e);
      this.controls.target.lerpVectors(tw.q0, tw.q1, e);
      if (tw.t >= 1) this.tween = null;
    }
    this.controls.update();

    const tel: Telemetry = this.engine.telemetry;
    const now = performance.now();
    const live = this.engine.running && tel.valid && now - tel.time < 250;
    // pad targets: engine pad openness when live (local prediction right after key changes for snappy feedback)
    const usePred = !live || now - this.state.keyChangedAt < 90 || tel.pads.length !== this.predicted.length;
    this.padTarget.set(usePred ? this.predicted : tel.pads);
    if (this.sax.update(dt, this.padTarget, this.state.keyDown)) this.render.invalidateShadows();

    // reed + mouthpiece
    this.mp.reedGain = this.opts.reedGain;
    // distributed (beam) reed shape appended after the documented telemetry (32 samples tip → clamp)
    if (live && tel.rawLen >= tel.tailStart + REED_SHAPE_LEN) this.mp.setReedShape(tel.raw, tel.tailStart, REED_SHAPE_LEN);
    this.mp.update(dt, live ? tel.reedDisplacement : null);

    // flow
    const lung = this.state.get(P.lung_pressure);
    const flowNorm = live ? Math.abs(tel.flow) / 2.5e-4 : lung > 0.2 ? Math.sqrt(lung / 4) * 0.6 : 0;
    if (this.opts.player) this.player.update(dt, live ? tel.mouthPressure : lung * 1000, flowNorm, time);
    this.airflow.enabled = this.opts.airflow;
    this.airflow.update(dt, flowNorm, this.player.airPath, this.opts.player ? this.player.pathLen : 0);

    // standing wave
    this.sax.waveLine.visible = this.opts.wave && live;
    if (live && tel.nProfile > 1) {
      let peak = 0;
      for (let i = 0; i < tel.nProfile; i++) peak = Math.max(peak, Math.abs(tel.profileRms[i]) * 1.41, Math.abs(tel.profile[i]));
      this.peakPa += (Math.max(200, peak) - this.peakPa) * (peak > this.peakPa ? 0.3 : 0.01);
      this.sax.setProfile(tel.profile, tel.profileRms, tel.nProfile, this.peakPa);
    } else {
      this.sax.setProfile(tel.profile, tel.profileRms, 0, this.peakPa);
    }

    this.interaction.update();
    if (this.mp.moved || (this.opts.player && this.player.moved)) this.render.invalidateShadows();
    this.render.render();
    for (const cb of this.afterRenderCb) cb();
  }
}

function fovRad(c: THREE.PerspectiveCamera): number {
  return (c.fov * Math.PI) / 180;
}
