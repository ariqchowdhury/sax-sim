// Render quality tiers + the small public API the settings UI wires up.
//
//   import { setRenderQuality, getRenderQuality, onRenderQualityChange } from './scene/render/quality';
//   setRenderQuality('auto' | 'high' | 'medium' | 'low');   // persisted in localStorage
//   getRenderQuality() → { mode: 'auto'|'high'|'medium'|'low', level: 'high'|'medium'|'low', fps: number }
//   const off = onRenderQualityChange((info) => …);          // fires on manual or automatic changes
//
// 'auto' (default) starts at high, measures the frame time for ~2 s and steps down one tier at a time
// while the median frame time is above ~19 ms (< ~52 fps). It never steps back up on its own.

export type RenderQuality = 'high' | 'medium' | 'low';
export type RenderQualityMode = RenderQuality | 'auto';

export interface RenderQualityInfo {
  mode: RenderQualityMode;
  level: RenderQuality;
  /** smoothed frames per second measured by the pipeline */
  fps: number;
}

export interface TierSettings {
  /** cap on devicePixelRatio */
  maxDpr: number;
  /** MSAA samples of the HDR post-processing target (0 = no post chain, direct render) */
  msaa: number;
  /** screen-space ambient occlusion (GTAO, half resolution) */
  ao: boolean;
  bloom: boolean;
  /** key-light shadow map size (0 = no shadow map) */
  shadow: number;
  /** contact shadow under the instrument (baked once, cheap) */
  contact: boolean;
}

export const TIERS: Record<RenderQuality, TierSettings> = {
  high: { maxDpr: 1.5, msaa: 4, ao: true, bloom: true, shadow: 2048, contact: true },
  medium: { maxDpr: 1.25, msaa: 4, ao: false, bloom: true, shadow: 1024, contact: true },
  low: { maxDpr: 1, msaa: 0, ao: false, bloom: false, shadow: 0, contact: true },
};

export const ORDER: RenderQuality[] = ['high', 'medium', 'low'];
const STORE_KEY = 'saxsim.render.quality';

export interface QualityTarget {
  applyQuality(level: RenderQuality): void;
  readonly fps: number;
}

let target: QualityTarget | null = null;
let mode: RenderQualityMode = loadMode();
let level: RenderQuality = mode === 'auto' ? 'high' : mode;
const listeners = new Set<(i: RenderQualityInfo) => void>();

function loadMode(): RenderQualityMode {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === 'auto' || v === 'high' || v === 'medium' || v === 'low') return v;
  } catch { /* storage blocked */ }
  return 'auto';
}

function emit(): void {
  const info = getRenderQuality();
  for (const cb of listeners) cb(info);
}

/** Manual override ('high' | 'medium' | 'low') or back to automatic selection ('auto'). Persisted. */
export function setRenderQuality(m: RenderQualityMode): void {
  mode = m;
  try { localStorage.setItem(STORE_KEY, m); } catch { /* ignore */ }
  const next: RenderQuality = m === 'auto' ? 'high' : m;
  level = next;
  target?.applyQuality(next);
  autoState.reset();
  emit();
}

export function getRenderQuality(): RenderQualityInfo {
  return { mode, level, fps: target?.fps ?? 0 };
}

export function onRenderQualityChange(cb: (i: RenderQualityInfo) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** @internal the pipeline registers itself; returns the level to start with */
export function registerQualityTarget(t: QualityTarget): RenderQuality {
  target = t;
  autoState.reset();
  return level;
}

/** @internal automatic tier selection from frame times (called by the pipeline every frame). */
export const autoState = {
  samples: new Float32Array(240),
  n: 0,
  warm: 0,
  warmFrames: 0,
  slowRun: 0,
  done: false,
  reset(): void {
    this.n = 0;
    this.warm = 0;
    this.warmFrames = 0;
    this.slowRun = 0;
    this.done = mode !== 'auto';
  },
  /** dtMs: wall time between frames */
  push(dtMs: number): void {
    if (this.done || mode !== 'auto') return;
    if (typeof document !== 'undefined' && document.hidden) { this.n = 0; this.slowRun = 0; return; }
    // skip the first frames after a (re)configuration: shader compiles, texture uploads
    if (this.warm < 0.75 || this.warmFrames < 4) { this.warm += dtMs / 1000; this.warmFrames++; return; }
    if (dtMs > 3000) return; // tab switch / debugger pause: not representative
    this.samples[this.n++] = dtMs;
    this.slowRun = dtMs > 50 ? this.slowRun + 1 : 0;
    let total = 0;
    for (let i = 0; i < this.n; i++) total += this.samples[i];
    // decide after ~2 s of frames, or right away when the device is clearly far too slow
    if (total < 2000 && this.n < this.samples.length && this.slowRun < 6) return;
    const sorted = Array.from(this.samples.subarray(0, this.n)).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.n = 0;
    this.warm = 0;
    this.warmFrames = 0;
    this.slowRun = 0;
    const i = ORDER.indexOf(level);
    if (median > 19 && i < ORDER.length - 1) {
      // far too slow (software GL, very weak GPU): go straight to the lowest tier
      level = median > 45 ? 'low' : ORDER[i + 1];
      console.info(`[render] median frame ${median.toFixed(1)} ms → quality ${level}`);
      target?.applyQuality(level);
      emit();
      if (level === 'low') this.done = true;
    } else {
      this.done = true;
    }
  },
};
