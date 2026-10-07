// Computer-keyboard play: blow envelope (space), tonguing (/), direct key mode and note (fingering) mode.
// Uses KeyboardEvent.code (physical keys) so it works on any layout. Documented in docs/UI.md.
import { P } from '../engine/params';
import type { Fingering, SaxGeometry } from '../scene/geometry';
import { KEY_SRC, type AppState } from '../state';
import { PARAMS, type ParamName } from '../engine/params';
import { PRESETS } from './presets';

/** written MIDI number from a note name like "G#6", "Bb3", "C♯5" */
export function noteNameToMidi(name: string): number | null {
  const m = /^([A-Ga-g])([#♯b♭]?)(-?\d)/.exec(name.trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + base + acc;
}

/** a playable fingering: the standard chart plus altissimo (`register: 3`) alternates */
export interface PlayFingering extends Fingering {
  register?: number;
  /** altissimo voicing from the data (applied by the UI only when player_assist = 0) */
  tract?: Record<string, number>;
  embouchure?: Record<string, number>;
}

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
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28, BracketLeft: 29, Equal: 30, BracketRight: 31, Backspace: 32, Backslash: 33,
};

/** note-mode key that plays a written MIDI note: unshifted if possible, else with octave shift ±1 */
export function noteKeyFor(midi: number): { code: string; shift: number } | null {
  for (const shift of [0, 1, -1]) {
    for (const [code, semi] of Object.entries(NOTE_MAP)) if (60 + semi + 12 * shift === midi) return { code, shift };
  }
  return null;
}

/** short label of a KeyboardEvent.code for display ("KeyT" → "T", "Backspace" → "⌫") */
export function keyLabel(code: string): string {
  const named: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backspace: '⌫', Equal: '=', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Slash: '/' };
  return named[code] ?? code.replace(/^Key|^Digit/, '');
}

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
  /** with player_assist = 0, apply the data's altissimo tract/embouchure on register-3 notes */
  autoVoicing: boolean;
}

export class KeyboardPlayer {
  readonly opts: KeyboardOptions = { mode: 'note', blowPressure: 3, attackMs: 35, releaseMs: 70, autoBlow: true, octaveShift: 0, velocitySensitive: true, breathMax: 6, autoVoicing: true };
  private keyIndex = new Map<string, number>();
  private byMidi = new Map<number, PlayFingering>();
  /** param values saved before an altissimo voicing was applied (restored afterwards) */
  private voicingSaved: Map<number, number> | null = null;
  private notesDown: number[] = []; // midi stack (last = sounding)
  private codesDown = new Map<string, number>();
  private blowSpace = false;
  private blowing = false;
  private tongueHeld = false;
  private tongueRestore = 0;
  currentNote: PlayFingering | null = null;
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
    // altissimo: `register: 3` alternates for notes the standard chart doesn't cover (G6, G#6, A6, …)
    for (const a of geo.alternate_fingerings ?? []) {
      if ((a as PlayFingering).register !== 3) continue;
      const midi = typeof a.written_midi === 'number' ? a.written_midi : noteNameToMidi(a.note);
      if (midi === null || this.byMidi.has(midi)) continue;
      this.byMidi.set(midi, { ...(a as PlayFingering), written_midi: midi });
    }
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', () => this.releaseAll());
  }

  get isBlowing(): boolean {
    return this.blowing;
  }

  /** on-screen "Hold to blow" button: same as holding Space */
  blow(on: boolean): void {
    if (this.blowSpace === on) return;
    this.blowSpace = on;
    this.updateBlow();
  }

  /** a lung-pressure drag while blowing moves the blow target (instead of fighting the envelope) */
  setBlowTarget(kPa: number): void {
    this.opts.blowPressure = kPa;
    if (this.noteBlow > 0) this.noteBlow = kPa;
  }

  setMode(m: KeyboardMode): void {
    this.releaseAll();
    this.opts.mode = m;
    this.onModeChange?.(m);
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    // only text entry blocks play; a focused checkbox, slider or button must not swallow note keys
    if (t.tagName === 'INPUT') return !/^(checkbox|radio|range|button|submit|reset|color|file)$/.test((t as HTMLInputElement).type);
    return t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
  }

  private onDown = (e: KeyboardEvent): void => {
    if (this.isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const code = e.code;
    if (e.shiftKey) {
      const cmd: Record<string, string> = { Digit1: 'cam:full', Digit2: 'cam:mouthpiece', Digit3: 'cam:player', Digit4: 'cam:keys', KeyX: 'xray', KeyC: 'cutaway', KeyF: 'airflow', Slash: 'help', KeyS: 'scopes', KeyP: 'controls' };
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
    let f: PlayFingering | null = null;
    for (let i = this.notesDown.length - 1; i >= 0 && !f; i--) f = this.byMidi.get(this.notesDown[i]) ?? null;
    if (f && f !== this.currentNote) this.applyVoicing(f);
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

  /** written MIDI numbers that have a playable fingering (incl. altissimo) */
  get playableNotes(): number[] {
    return [...this.byMidi.keys()].sort((a, b) => a - b);
  }

  /**
   * Altissimo voicing. With player_assist > 0 the engine's player model voices the note. With
   * assist = 0 (pure physics) the UI applies the fingering's `tract` + embouchure (entry
   * `embouchure`, else the Altissimo preset's) itself, and restores the previous values when a
   * non-altissimo note follows.
   */
  private applyVoicing(f: PlayFingering): void {
    const isAlt = f.register === 3;
    if (isAlt && this.opts.autoVoicing && this.state.get(P.player_assist) === 0) {
      const preset = PRESETS.find((p) => /altissimo/i.test(p.name));
      const set: Record<string, number> = { ...(f.embouchure ?? preset?.params ?? {}), ...(f.tract ?? {}) };
      if (!this.voicingSaved) this.voicingSaved = new Map();
      for (const [name, v] of Object.entries(set)) {
        const d = PARAMS.find((q) => q.name === (name as ParamName));
        if (!d || typeof v !== 'number') continue;
        if (!this.voicingSaved.has(d.id)) this.voicingSaved.set(d.id, this.state.get(d.id));
        this.state.set(d.id, v, 'altissimo');
      }
      this.altBlow = Math.max(this.opts.blowPressure, preset?.blow ?? 4.5);
    }
    if (isAlt && this.state.get(P.lung_pressure) < 0.3) {
      // set the embouchure/tongue *before* the air (as a player does): the attack decides which
      // regime the reed locks into, and the engine smooths the voicing params over a few ms
      this.voiceUntil = performance.now() + 250;
    }
    if (!isAlt) {
      this.restoreVoicing();
    }
  }

  private altBlow = 0;
  private voiceUntil = 0;

  restoreVoicing(): void {
    this.altBlow = 0;
    if (!this.voicingSaved) return;
    for (const [id, v] of this.voicingSaved) this.state.set(id, v, 'altissimo');
    this.voicingSaved = null;
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
    this.restoreVoicing();
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
    else if (this.blowing) {
      target = this.noteBlow > 0 && this.notesDown.length ? this.noteBlow : this.opts.blowPressure;
      if (this.altBlow > 0 && this.currentNote?.register === 3) target = Math.max(target, this.altBlow);
      if (performance.now() < this.voiceUntil) target = 0; // pre-voicing before the attack
    }
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
