// Central app state: params (two-way synced between panel, 3D handles, keyboard) and keys.
import { PARAMS, PARAM_COUNT, clampParam, defaultValues } from './engine/params';
import type { EngineClient } from './engine/EngineClient';

export type ParamListener = (id: number, value: number, source: string) => void;
export type KeyListener = () => void;

/** Sources of a key press; a key is down if any source holds it. */
export const KEY_SRC = { latch: 1, mouse: 2, keyboard: 4, note: 8 } as const;

export class AppState {
  readonly values: Float32Array = defaultValues();
  /** per key bitmask of KEY_SRC */
  keyMask: Uint8Array;
  readonly keyDown: Float32Array;
  keyChangedAt = 0;
  private pListeners: ParamListener[] = [];
  private kListeners: KeyListener[] = [];
  private engine: EngineClient | null = null;

  constructor(keyCount: number) {
    this.keyMask = new Uint8Array(keyCount);
    this.keyDown = new Float32Array(keyCount);
  }

  attachEngine(e: EngineClient): void {
    this.engine = e;
    for (let i = 0; i < PARAM_COUNT; i++) e.setParam(i, this.values[i]);
    for (let i = 0; i < this.keyDown.length; i++) e.setKey(i, this.keyDown[i]);
  }

  get(id: number): number {
    return this.values[id];
  }

  /** normalized 0..1 */
  getN(id: number): number {
    const d = PARAMS[id];
    return (this.values[id] - d.min) / (d.max - d.min);
  }

  set(id: number, value: number, source = 'code'): void {
    const v = clampParam(id, value);
    if (!Number.isFinite(v) || this.values[id] === v) return;
    this.values[id] = v;
    this.engine?.setParam(id, v);
    for (const l of this.pListeners) l(id, v, source);
  }

  setN(id: number, n: number, source = 'code'): void {
    const d = PARAMS[id];
    this.set(id, d.min + (d.max - d.min) * Math.min(1, Math.max(0, n)), source);
  }

  onParam(l: ParamListener): void {
    this.pListeners.push(l);
  }

  onKeys(l: KeyListener): void {
    this.kListeners.push(l);
  }

  setKeySource(index: number, src: number, on: boolean): void {
    if (index < 0 || index >= this.keyMask.length) return;
    const m = on ? this.keyMask[index] | src : this.keyMask[index] & ~src;
    if (m === this.keyMask[index]) return;
    this.keyMask[index] = m;
    this.refreshKey(index);
    this.emitKeys();
  }

  toggleLatch(index: number): void {
    this.setKeySource(index, KEY_SRC.latch, !(this.keyMask[index] & KEY_SRC.latch));
  }

  /** Replace the set of keys held by a given source (e.g. note-mode fingering). */
  setSourceKeys(src: number, indices: Iterable<number>): void {
    const want = new Set(indices);
    let changed = false;
    for (let i = 0; i < this.keyMask.length; i++) {
      const on = want.has(i);
      const m = on ? this.keyMask[i] | src : this.keyMask[i] & ~src;
      if (m !== this.keyMask[i]) {
        this.keyMask[i] = m;
        this.refreshKey(i);
        changed = true;
      }
    }
    if (changed) this.emitKeys();
  }

  clearKeys(): void {
    this.keyMask.fill(0);
    for (let i = 0; i < this.keyMask.length; i++) this.refreshKey(i);
    this.emitKeys();
  }

  private refreshKey(i: number): void {
    const v = this.keyMask[i] ? 1 : 0;
    this.keyDown[i] = v;
    this.engine?.setKey(i, v);
  }

  private emitKeys(): void {
    this.keyChangedAt = performance.now();
    for (const l of this.kListeners) l();
  }
}
