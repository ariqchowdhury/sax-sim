// Voicing close-up (Play mode): a picture-in-picture view of the mid-sagittal cutaway of the mouth and
// throat, rendered with a second camera into a rectangle of the main canvas after the main frame
// (RenderPipeline.renderInset — no post-processing; frustum culling keeps it cheap). Overlaid: a
// ghost of the previous note's tongue / tip / jaw / glottis positions with arrows to the current
// ones, the 2–3 biggest control changes since the previous note, and the tract resonance in words.
import * as THREE from 'three';
import { P, PARAMS, formatParam } from '../engine/params';
import type { SceneApp } from '../scene/SceneApp';
import { getRenderQuality } from '../scene/render/quality';
import type { AutoPlayer } from './autoPlayer';

/** controls compared note to note, with short labels */
const WATCH: [number, string][] = [
  [P.tongue_y, 'tongue height'], [P.tongue_x, 'tongue front→back'], [P.tongue_tip, 'tongue tip'],
  [P.jaw_open, 'jaw'], [P.glottis_open, 'glottis'], [P.lip_force, 'lip force'], [P.lip_position, 'take-in'],
];
/** head-local centre of the close-up (between palate, tongue and glottis) and its height (m) */
const FOCUS = new THREE.Vector3(-0.045, -0.025, 0);
const SPAN = 0.17;
const VIEW_DIR = new THREE.Vector3(1, 0.08, 0.05).normalize(); // same side as the Player preset (cutaway)

interface Snap { note: string; values: number[]; pts: THREE.Vector3[] }
const _v = new THREE.Vector3();

export class VoicingInset {
  readonly camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.01, 3);
  enabled = false;
  private body: HTMLElement;
  private overlay: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private labels: HTMLElement;
  private title: HTMLElement;
  private prev: Snap | null = null;
  private cur: Snap | null = null;
  private lastLocked = '';
  /** test hook: request a pixel probe of the next inset render */
  probeRequested = false;
  lastProbe: { distinct: number; nonBlack: number } | null = null;
  /** smoothed CPU time of the inset render call (ms) */
  costMs = 0;
  /** tract wording for the overlay (main.ts supplies the shared rules) */
  tractText: () => string = () => '';

  constructor(private root: HTMLElement, private scene: SceneApp, private ap: AutoPlayer, private handles: THREE.Object3D[]) {
    this.body = root.querySelector('.inset-body')!;
    this.overlay = root.querySelector('canvas.inset-overlay')!;
    this.g = this.overlay.getContext('2d')!;
    this.labels = root.querySelector('.inset-labels')!;
    this.title = root.querySelector('.inset-title')!;
    root.querySelector('.inset-min')!.addEventListener('click', () => this.root.classList.toggle('collapsed'));
    this.dragByHeader(root.querySelector('.inset-head')!);
    scene.onAfterRender(() => this.render());
  }

  /** notes whose settled voicing is held (diagnostics / tests): previous and current */
  get history(): { prev: string | null; cur: string | null } {
    return { prev: this.prev?.note ?? null, cur: this.cur?.note ?? null };
  }

  get visible(): boolean {
    return this.enabled && this.ap.mode === 'play' && !this.root.classList.contains('collapsed');
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.hidden = !(on && this.ap.mode === 'play');
  }

  /** per frame: frame the camera on the head (it moves with the take-in) and track note changes */
  update(): void {
    this.root.hidden = !(this.enabled && this.ap.mode === 'play');
    this.root.classList.toggle('lowq', getRenderQuality().level === 'low');
    if (!this.visible) return;
    const head = this.scene.player.head;
    head.updateWorldMatrix(true, false);
    const target = head.localToWorld(_v.copy(FOCUS));
    const r = this.body.getBoundingClientRect();
    this.camera.aspect = Math.max(0.5, r.width / Math.max(1, r.height));
    const dist = SPAN / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
    this.camera.position.copy(target).addScaledVector(VIEW_DIR, dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    // a new note has settled → the previous settled voicing becomes the ghost
    const n = this.ap.currentNote;
    if (n && this.ap.status === 'locked') {
      if (n.name !== this.lastLocked) {
        this.prev = this.cur;
        this.cur = this.snap(n.name);
        this.lastLocked = n.name;
      } else if (this.cur) {
        // keep the settled voicing of the current note up to date (it eases in after the lock), so
        // the next note compares against where this one ended up
        WATCH.forEach(([id], i) => { this.cur!.values[i] = this.ap.value(id); });
        this.handles.forEach((h, i) => h.getWorldPosition(this.cur!.pts[i]));
      }
    }
  }

  private snap(note: string): Snap {
    return { note, values: WATCH.map(([id]) => this.ap.value(id)), pts: this.handles.map((h) => h.getWorldPosition(new THREE.Vector3())) };
  }

  /** 15 Hz: labels (biggest changes since the previous note) and the tract line */
  refreshLabels(): void {
    if (!this.visible) return;
    const live = WATCH.map(([id]) => this.ap.value(id));
    const n = this.ap.currentNote;
    let html = '';
    if (this.prev && this.cur && n && n.name === this.cur.note) {
      const d = WATCH.map(([id, label], i) => ({ id, label, from: this.prev!.values[i], to: live[i], w: Math.abs(live[i] - this.prev!.values[i]) / (PARAMS[id].max - PARAMS[id].min) }))
        .filter((x) => x.w > 0.02).sort((a, b) => b.w - a.w).slice(0, 3);
      this.title.textContent = `Voicing ${this.prev.note} → ${n.name}`;
      html = d.length
        ? d.map((x) => `<div class="iv"><span>${x.label}</span><b>${formatParam(x.id, x.from)} → ${formatParam(x.id, x.to)}</b><i class="${x.to > x.from ? 'up' : 'down'}">${x.to > x.from ? '+' : '−'}${formatParam(x.id, Math.abs(x.to - x.from)).replace(/ .*/, '')}</i></div>`).join('')
        : '<div class="iv"><span>same voicing as the previous note</span></div>';
    } else {
      this.title.textContent = n ? `Voicing ${n.name}` : 'Voicing close-up';
      html = `<div class="iv"><span>play two notes to compare their voicing</span></div>`;
    }
    html += `<div class="iv tract">${this.tractText()}</div>`;
    if (this.labels.innerHTML !== html) this.labels.innerHTML = html;
  }

  /** after the main frame: render the inset, then the ghost/arrow overlay */
  private render(): void {
    if (!this.visible) return;
    const c = this.scene.renderer.domElement.getBoundingClientRect();
    const b = this.body.getBoundingClientRect();
    const x = Math.round(b.left - c.left), y = Math.round(b.top - c.top), w = Math.round(b.width), h = Math.round(b.height);
    if (w < 20 || h < 20) return;
    const t0 = performance.now();
    this.scene.render.renderInset(this.camera, x, y, w, h);
    this.costMs += (performance.now() - t0 - this.costMs) * 0.05;
    if (this.probeRequested) this.probe(x, y, w, h);
    this.drawOverlay(w, h);
  }

  /** ghost dots at the previous note's handle positions, arrows to the current ones */
  private drawOverlay(w: number, h: number): void {
    const cv = this.overlay, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!this.prev) return;
    const toPx = (p: THREE.Vector3): [number, number] => { _v.copy(p).project(this.camera); return [((_v.x + 1) / 2) * w, ((1 - _v.y) / 2) * h]; };
    g.lineWidth = 1.5;
    this.handles.forEach((hd, i) => {
      const [x0, y0] = toPx(this.prev!.pts[i]);
      const [x1, y1] = toPx(hd.getWorldPosition(new THREE.Vector3()));
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.setLineDash([2, 2]);
      g.beginPath(); g.arc(x0, y0, 5, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 4) return;
      g.strokeStyle = 'rgba(255,210,122,0.9)';
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      const a = Math.atan2(y1 - y0, x1 - x0);
      g.beginPath();
      g.moveTo(x1, y1); g.lineTo(x1 - 7 * Math.cos(a - 0.45), y1 - 7 * Math.sin(a - 0.45));
      g.moveTo(x1, y1); g.lineTo(x1 - 7 * Math.cos(a + 0.45), y1 - 7 * Math.sin(a + 0.45));
      g.stroke();
    });
  }

  /** test hook: sample the inset's pixels right after rendering it (same frame) */
  private probe(x: number, y: number, w: number, h: number): void {
    this.probeRequested = false;
    const r = this.scene.renderer, gl = r.getContext();
    const pr = r.getPixelRatio();
    const cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
    const px = new Uint8Array(4);
    const seen = new Set<string>();
    let nonBlack = 0;
    for (let i = 1; i < 8; i++) for (let j = 1; j < 6; j++) {
      const sx = Math.min(cw - 1, Math.round((x + (w * i) / 8) * pr));
      const sy = Math.min(ch - 1, Math.round(ch - (y + (h * j) / 6) * pr));
      gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      seen.add(`${px[0] >> 3},${px[1] >> 3},${px[2] >> 3}`);
      if (px[0] + px[1] + px[2] > 30) nonBlack++;
    }
    this.lastProbe = { distinct: seen.size, nonBlack };
  }

  private dragByHeader(head: HTMLElement): void {
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = this.root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!on) return;
      const nx = Math.min(window.innerWidth - 80, Math.max(0, ox + e.clientX - sx)), ny = Math.min(window.innerHeight - 40, Math.max(0, oy + e.clientY - sy));
      Object.assign(this.root.style, { left: `${nx}px`, top: `${ny}px`, right: 'auto', bottom: 'auto' });
    });
    head.addEventListener('pointerup', () => { on = false; });
  }
}
