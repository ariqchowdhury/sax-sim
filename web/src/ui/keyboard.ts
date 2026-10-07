// Computer-keyboard play: blow envelope (space), tonguing (/), direct key mode and note (fingering) mode.
// Uses KeyboardEvent.code (physical keys) so it works on any layout. Documented in docs/UI.md.
import { P } from '../engine/params';
import type { Fingering, SaxGeometry } from '../scene/geometry';
import { KEY_SRC, type AppState } from '../state';

export type KeyboardMode = 'note' | 'keys';

/** Direct key mode: physical key → sax key id */
export const DIRECT_MAP: Record<string, string> = {
  KeyQ: 'OCT',
  KeyW: 'LH_palm_D', KeyE: 'LH_palm_Eb', KeyR: 'LH_palm_F', KeyT: 'LH_front_F',
  KeyA: 'LH1', KeyS: 'LH2', KeyD: 'LH3', KeyG: 'BIS',
  KeyZ: 'LH_Gs', KeyX: 'LH_Cs', KeyC: 'LH_B', KeyV: 'LH_Bb',
  KeyJ: 'RH1', KeyK: 'RH2', KeyL: 'RH3', Semicolon: 'RH_Eb', Quote: 'RH_C',
  KeyU: 'RH_side_E', KeyI: 'RH_side_C', KeyO: 'RH_side_Bb', KeyP: 'RH_high_Fs',
};

/** Note mode: tracker-style piano layout → semitone offset from written C4 (MIDI 60) */
export const NOTE_MAP: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28, BracketLeft: 29, Equal: 30,
};

export interface KeyboardOptions {
  mode: KeyboardMode;
  blowPressure: number; // kPa
  attackMs: number;
  releaseMs: number;
  autoBlow: boolean;
  octaveShift: number;
  /** MIDI velocity scales the blow target (0.7…1.3 ×) */
  velocitySensitive: boolean;
  /** lung pressure at full breath-controller value (CC2/CC11), kPa */
  breathMax: number;
}

export class KeyboardPlayer {
  readonly opts: KeyboardOptions = { mode: 'note', blowPressure: 3, attackMs: 35, releaseMs: 70, autoBlow: true, octaveShift: 0, velocitySensitive: true, breathMax: 6 };
  private keyIndex = new Map<string, number>();
  private byMidi = new Map<number, Fingering>();
  private notesDown: number[] = []; // midi stack (last = sounding)
  private codesDown = new Map<string, number>();
  private blowSpace = false;
  private blowing = false;
  private tongueHeld = false;
  private tongueRestore = 0;
  currentNote: Fingering | null = null;
  /** blow target for the current note (velocity-scaled), kPa */
  private noteBlow = -1;
  /** legato grace: air stays on this long after the last note is released (ms) */
  legatoGraceMs = 60;
  private releaseAt = 0;
  /** breath controller value 0..1, or -1 when no breath controller is in use */
  private breathValue = -1;
  private controlling = false;
  onModeChange: ((m: KeyboardMode) => void) | null = null;
  onCommand: ((cmd: string) => void) | null = null;

  constructor(private state: AppState, geo: SaxGeometry) {
    geo.keys.forEach((k, i) => this.keyIndex.set(k.id, i));
    for (const f of geo.fingerings) if (!this.byMidi.has(f.written_midi)) this.byMidi.set(f.written_midi, f);
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', () => this.releaseAll());
  }

  get isBlowing(): boolean {
    return this.blowing;
  }

  setMode(m: KeyboardMode): void {
    this.releaseAll();
    this.opts.mode = m;
    this.onModeChange?.(m);
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private onDown = (e: KeyboardEvent): void => {
    if (this.isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const code = e.code;
    if (e.shiftKey) {
      const cmd: Record<string, string> = { Digit1: 'cam:full', Digit2: 'cam:mouthpiece', Digit3: 'cam:player', Digit4: 'cam:keys', KeyX: 'xray', KeyC: 'cutaway', KeyF: 'airflow', Slash: 'help' };
      if (cmd[code]) {
        e.preventDefault();
        if (!e.repeat) this.onCommand?.(cmd[code]);
        return;
      }
    }
    if (code === 'Space') {
      e.preventDefault();
      if (!e.repeat) { this.blowSpace = true; this.updateBlow(); }
      return;
    }
    if (code === 'Slash') {
      e.preventDefault();
      if (!e.repeat && !this.tongueHeld) {
        this.tongueHeld = true;
        this.tongueRestore = this.state.get(P.tongue_reed_contact);
        this.state.set(P.tongue_reed_contact, 1, 'keyboard');
      }
      return;
    }
    if (code === 'Backquote') {
      e.preventDefault();
      if (!e.repeat) this.setMode(this.opts.mode === 'note' ? 'keys' : 'note');
      return;
    }
    if (code === 'Escape') {
      this.state.clearKeys();
      this.releaseAll();
      return;
    }
    if (e.repeat) {
      if (code in DIRECT_MAP || code in NOTE_MAP) e.preventDefault();
      return;
    }
    if (this.opts.mode === 'keys') {
      const id = DIRECT_MAP[code];
      const idx = id !== undefined ? this.keyIndex.get(id) : undefined;
      if (idx !== undefined) {
        e.preventDefault();
        this.state.setKeySource(idx, KEY_SRC.keyboard, true);
      }
    } else {
      if (code === 'ArrowUp' || code === 'ArrowDown') {
        e.preventDefault();
        this.opts.octaveShift = Math.max(-1, Math.min(1, this.opts.octaveShift + (code === 'ArrowUp' ? 1 : -1)));
        this.onModeChange?.(this.opts.mode);
        return;
      }
      const semi = NOTE_MAP[code];
      if (semi !== undefined) {
        e.preventDefault();
        const midi = 60 + semi + 12 * this.opts.octaveShift;
        this.codesDown.set(code, midi);
        this.notesDown.push(midi);
        this.applyNote();
      }
    }
  };

  private onUp = (e: KeyboardEvent): void => {
    const code = e.code;
    if (code === 'Space') {
      this.blowSpace = false;
      this.updateBlow();
      return;
    }
    if (code === 'Slash') {
      if (this.tongueHeld) {
        this.tongueHeld = false;
        this.state.set(P.tongue_reed_contact, this.tongueRestore, 'keyboard');
      }
      return;
    }
    const id = DIRECT_MAP[code];
    const idx = id !== undefined ? this.keyIndex.get(id) : undefined;
    if (idx !== undefined) this.state.setKeySource(idx, KEY_SRC.keyboard, false);
    const midi = this.codesDown.get(code);
    if (midi !== undefined) {
      this.codesDown.delete(code);
      const i = this.notesDown.lastIndexOf(midi);
      if (i >= 0) this.notesDown.splice(i, 1);
      this.applyNote();
    }
  };

  private applyNote(): void {
    // last pressed note that has a fingering wins (legato: previous held notes resume)
    let f: Fingering | null = null;
    for (let i = this.notesDown.length - 1; i >= 0 && !f; i--) f = this.byMidi.get(this.notesDown[i]) ?? null;
    if (f) {
      // like a real player: fingers move to the new fingering, air stays on
      this.currentNote = f;
      const idx: number[] = [];
      for (const k of f.keys) { const i = this.keyIndex.get(k); if (i !== undefined) idx.push(i); }
      this.state.setSourceKeys(KEY_SRC.note, idx);
    } else if (this.notesDown.length === 0 && this.currentNote) {
      // note released: the air stops (after a short legato grace) but the fingers stay down,
      // so the release does not sound the open-C# fingering
      this.releaseAt = performance.now() + this.legatoGraceMs;
    }
    this.updateBlow();
  }

  private updateBlow(): void {
    const notes = this.opts.mode === 'note' && this.opts.autoBlow && this.notesDown.length > 0 && this.currentNote !== null;
    const grace = this.opts.mode === 'note' && this.opts.autoBlow && this.currentNote !== null && performance.now() < this.releaseAt;
    this.blowing = this.blowSpace || notes || grace;
  }

  // ---- external note input (MIDI) ----------------------------------------------------------------
  /** note-on for a *written* MIDI note; velocity 1..127 */
  noteOn(midi: number, velocity = 100): void {
    if (this.opts.mode !== 'note') this.setMode('note');
    this.notesDown.push(midi);
    if (this.opts.velocitySensitive) this.noteBlow = Math.min(10, this.opts.blowPressure * (0.7 + 0.6 * (velocity / 127)));
    else this.noteBlow = -1;
    this.applyNote();
  }

  noteOff(midi: number): void {
    const i = this.notesDown.lastIndexOf(midi);
    if (i >= 0) this.notesDown.splice(i, 1);
    this.applyNote();
  }

  /** breath controller 0..1 (CC2 / CC11); null disables breath control again */
  breath(v: number | null): void {
    this.breathValue = v === null ? -1 : Math.max(0, Math.min(1, v));
  }

  get breathActive(): boolean {
    return this.breathValue >= 0;
  }

  releaseAll(): void {
    this.notesDown.length = 0;
    this.codesDown.clear();
    this.currentNote = null;
    this.releaseAt = 0;
    this.state.setSourceKeys(KEY_SRC.note, []);
    this.state.setSourceKeys(KEY_SRC.keyboard, []);
    this.blowSpace = false;
    this.updateBlow();
    if (this.tongueHeld) {
      this.tongueHeld = false;
      this.state.set(P.tongue_reed_contact, this.tongueRestore, 'keyboard');
    }
  }

  /** control-rate blow envelope (exponential attack/release on lung_pressure) */
  update(dt: number): void {
    if (this.releaseAt && performance.now() >= this.releaseAt) {
      this.releaseAt = 0;
      this.updateBlow();
    }
    let target = 0;
    if (this.breathValue >= 0) target = this.breathValue * this.opts.breathMax;
    else if (this.blowing) target = this.noteBlow > 0 && this.notesDown.length ? this.noteBlow : this.opts.blowPressure;
    if (target <= 0 && !this.controlling) return;
    this.controlling = true;
    const cur = this.state.get(P.lung_pressure);
    const tau = (target > cur ? this.opts.attackMs : this.opts.releaseMs) / 1000;
    const a = 1 - Math.exp(-dt / Math.max(0.001, tau));
    let v = cur + (target - cur) * a;
    if (target <= 0 && v < 0.01) {
      v = 0;
      this.controlling = false;
    }
    this.state.set(P.lung_pressure, v, 'blow');
  }
}
