// Jaw vibrato: saxophone vibrato is produced by a periodic jaw motion that modulates the lower-lip
// force on the reed (pitch and loudness wobble). We oscillate lip_force (main effect) and jaw_open
// (visible + tract) around the player's own settings.
import { P } from '../engine/params';
import type { AppState } from '../state';

export interface VibratoOptions {
  enabled: boolean;
  rateHz: number;
  /** 0..1 — 1 ≈ −0.7/+0.2 N lip force, ±0.08 jaw opening */
  depth: number;
  /** only while blowing */
  onlyWhileBlowing: boolean;
}

export class Vibrato {
  readonly opts: VibratoOptions = { enabled: false, rateHz: 5.5, depth: 0.35, onlyWhileBlowing: true };
  private baseLip: number;
  private baseJaw: number;
  private phase = 0;
  private active = false;

  constructor(private state: AppState, private isBlowing: () => boolean) {
    this.baseLip = state.get(P.lip_force);
    this.baseJaw = state.get(P.jaw_open);
    state.onParam((id, v, source) => {
      if (source === 'vibrato') return;
      if (id === P.lip_force) this.baseLip = v;
      if (id === P.jaw_open) this.baseJaw = v;
    });
  }

  update(dt: number): void {
    const on = this.opts.enabled && this.opts.depth > 0 && (!this.opts.onlyWhileBlowing || this.isBlowing());
    if (!on) {
      if (this.active) {
        this.active = false;
        this.phase = 0;
        this.state.set(P.lip_force, this.baseLip, 'vibrato');
        this.state.set(P.jaw_open, this.baseJaw, 'vibrato');
      }
      return;
    }
    this.active = true;
    this.phase = (this.phase + dt * this.opts.rateHz) % 1;
    const s = Math.sin(this.phase * Math.PI * 2) * this.opts.depth;
    // jaw drops (opens) ↔ less lip force → pitch goes flat; classic "below the note" vibrato
    this.state.set(P.lip_force, Math.max(0, this.baseLip - 0.7 * Math.max(0, s) - 0.2 * Math.min(0, s)), 'vibrato');
    this.state.set(P.jaw_open, this.baseJaw + 0.08 * s, 'vibrato');
  }
}
