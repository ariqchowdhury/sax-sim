// Play / Explore modes and the auto player (keys-only playing).
//
// Play  = `auto_player` 1: press keys and set the volume; for the current mouthpiece setup the
//         player's controls (lips, tongue, jaw, glottis, air) are voiced per note. Grabbing a player
//         part takes it over (sets its `auto_player_mask` bit); "reset" hands it back. Mouthpiece and
//         reed always stay yours.
// Explore = everything is yours (as before).
//
// Engine (engine/src/player.rs, data `auto_player`, docs/ARCHITECTURE.md): params 27/28 and the
// player-controls telemetry block (AUTO_TEL) — the controls in effect, recognised fingering, match
// type and state drive the anatomy, the status line and "what the player is doing". Also here: the
// cork tuning hint and the note when the setup is outside the data's tuned ranges.
// Fallback for engines without the block: an estimate mirrored from the older player model's
// documented feed-forward (base controls + per-register offsets × assist + the data's altissimo
// voicing), status from the pitch.
import type { EngineClient } from '../engine/EngineClient';
import { AUTO_CONTROLS, AUTO_STATE, P, PARAMS, PARAM_COUNT, formatParam } from '../engine/params';
import type { SaxGeometry } from '../scene/geometry';
import type { AppState } from '../state';
import type { KeyboardPlayer } from './keyboard';

export type Mode = 'play' | 'explore';
export type AutoStatus = 'ready' | 'free' | 'adjusting' | 'locked' | 'struggling';

const MODE_KEY = 'saxsim.mode.v1';
const SRC = 'auto-player';
/** engine/src/player.rs feed-forward thresholds */
const LOW_HZ = 180, PALM_HZ = 690;
/** a note counts as locked within ±50 ¢ of its target for LOCK_S; struggling after STRUGGLE_S */
const LOCK_CENTS = 50, LOCK_S = 0.15, STRUGGLE_S = 1.5;

interface Note { keys: Set<string>; name: string; f: number; register: number; voicing: Partial<Record<number, number>> }

/** user-facing groups of the auto-player controls (chips: "you control the tongue · reset") */
export const CONTROL_GROUPS: { name: string; ids: number[] }[] = [
  { name: 'tongue', ids: [P.tongue_x, P.tongue_y, P.tongue_tip, P.tongue_length] },
  { name: 'lips', ids: [P.lip_force, P.lip_position, P.lip_damping] },
  { name: 'jaw', ids: [P.jaw_open] },
  { name: 'throat', ids: [P.glottis_open] },
  { name: 'air', ids: [P.lung_pressure] },
];

export class AutoPlayer {
  mode: Mode = 'explore';
  mask = 0;
  status: AutoStatus = 'ready';
  /** where the shown values come from: the engine's telemetry, or the UI estimate (fallback) */
  source: 'engine' | 'estimate' = 'estimate';
  /** values the anatomy shows (smoothed), NaN = the param itself */
  readonly shown = new Float32Array(PARAM_COUNT).fill(NaN);
  private target = new Float32Array(PARAM_COUNT).fill(NaN);
  private notes: Note[] = [];
  /** setup ranges the auto player was tuned for (data `auto_player.adaptation.validity`), by param id */
  private validity = new Map<number, [number, number]>();
  private current: Note | null = null;
  private savedAssist = NaN;
  private noteT = 0;
  private lockT = 0;
  private wasSounding = false;
  onChange: (() => void) | null = null;

  constructor(private state: AppState, private engine: EngineClient, geo: SaxGeometry, private kb: KeyboardPlayer, private keyIds: string[]) {
    // the note table of the engine's player model: standard fingerings + `register: 3` alternates
    for (const f of geo.fingerings) if (typeof f.f_target === 'number') this.notes.push({ keys: new Set(f.keys), name: f.note, f: f.f_target, register: (f.register as number | undefined) ?? (f.f_target > 340 ? 2 : 1), voicing: {} });
    for (const raw of geo.alternate_fingerings ?? []) {
      const a = raw as typeof raw & { register?: number; tract?: Record<string, number>; embouchure?: Record<string, number> };
      if (a.register !== 3 || typeof a.f_target !== 'number') continue;
      const keys = new Set(a.keys);
      if (this.notes.some((n) => n.keys.size === keys.size && [...keys].every((k) => n.keys.has(k)))) continue;
      const voicing: Note['voicing'] = {};
      for (const [k, v] of Object.entries({ ...(a.tract ?? {}), ...(a.embouchure ?? {}) })) {
        const id = (P as Record<string, number>)[k];
        if (id !== undefined && (AUTO_CONTROLS as readonly number[]).includes(id)) voicing[id] = v;
      }
      this.notes.push({ keys, name: a.note, f: a.f_target, register: 3, voicing });
    }
    const val = (geo as { auto_player?: { adaptation?: { validity?: Record<string, [number, number]> } } }).auto_player?.adaptation?.validity ?? {};
    for (const [k, r] of Object.entries(val)) {
      const id = (P as Record<string, number>)[k];
      if (id !== undefined && Array.isArray(r) && r.length === 2) this.validity.set(id, [r[0], r[1]]);
    }
    // the hint describes the CURRENT setup: a setup change starts a new sample set
    state.onParam((id) => { if (AutoPlayer.SETUP_IDS.includes(id)) this.resetTuning(); });
    state.onKeys(() => this.recognise());
    this.recognise();
    state.onParam((id, v, source) => {
      if (this.mode !== 'play' || source === SRC) return;
      // the Play mode owns player_assist: presets keep Play; anything else (Controls panel, coach
      // A/B, console) means the user wants to set the player up by hand → Explore
      if (id === P.player_assist) {
        if (source === 'preset') this.state.set(P.player_assist, 1, SRC);
        else this.setMode('explore');
        return;
      }
      // a hand-made change of a player control takes it over (drag, sliders)
      if ((source === 'drag' || source === 'panel' || source === 'context') && (AUTO_CONTROLS as readonly number[]).includes(id)) this.take([id], false);
      void v;
    });
  }

  /** first visit: Play (press keys, hear a sax); later the remembered choice */
  static initialMode(): Mode {
    try { const m = localStorage.getItem(MODE_KEY); if (m === 'play' || m === 'explore') return m; } catch { /* ignore */ }
    return 'play';
  }

  setMode(m: Mode, persist = true): void {
    if (persist) { try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } }
    if (m === this.mode) { this.onChange?.(); return; }
    this.mode = m;
    if (m === 'play') {
      this.savedAssist = this.state.get(P.player_assist);
      this.state.set(P.player_assist, 1, SRC);
      this.state.set(P.auto_player, 1, SRC);
      this.setMask(0);
      this.state.shownOverride = this.shown;
      this.noteT = this.lockT = 0;
    } else {
      this.state.set(P.auto_player, 0, SRC);
      this.setMask(0);
      this.state.set(P.player_assist, Number.isFinite(this.savedAssist) ? this.savedAssist : PARAMS[P.player_assist].default, SRC);
      this.state.shownOverride = null;
      this.shown.fill(NaN);
    }
    this.onChange?.();
  }

  private setMask(m: number): void {
    this.mask = m;
    this.state.set(P.auto_player_mask, m, SRC);
    this.onChange?.();
  }

  owns(id: number): boolean {
    const i = (AUTO_CONTROLS as readonly number[]).indexOf(id);
    return i >= 0 && (this.mask & (1 << i)) !== 0;
  }

  /**
   * The user takes over these controls (grab / slider in Play mode). With the engine's auto player
   * the control starts from the value the player was using (no jump).
   */
  take(ids: readonly number[], fromShown = true): void {
    if (this.mode !== 'play') return;
    let m = this.mask;
    for (const id of ids) {
      const i = (AUTO_CONTROLS as readonly number[]).indexOf(id);
      if (i < 0 || m & (1 << i)) continue;
      m |= 1 << i;
      // only exact with the engine (it honours the mask); the fallback adds its offsets on top
      if (fromShown && this.source === 'engine' && id !== P.lung_pressure && Number.isFinite(this.shown[id])) this.state.set(id, this.shown[id], SRC);
    }
    if (m !== this.mask) this.setMask(m);
  }

  /** hand controls back to the auto player */
  release(ids: readonly number[]): void {
    let m = this.mask;
    for (const id of ids) {
      const i = (AUTO_CONTROLS as readonly number[]).indexOf(id);
      if (i >= 0) m &= ~(1 << i);
    }
    if (m !== this.mask) this.setMask(m);
  }

  /** names of the control groups the user owns */
  ownedGroups(): string[] {
    return CONTROL_GROUPS.filter((g) => g.ids.some((id) => this.owns(id))).map((g) => g.name);
  }

  get currentNote(): { name: string; f: number; register: number } | null {
    return this.current;
  }

  private recognise(): void {
    const down = new Set<string>();
    this.keyIds.forEach((k, i) => { if (this.state.keyDown[i] > 0.5) down.add(k); });
    const n = this.notes.find((x) => x.keys.size === down.size && [...x.keys].every((k) => down.has(k))) ?? null;
    if (n !== this.current) { this.current = n; this.noteT = 0; this.lockT = 0; this.tuneT = 0; this.sampled = false; }
  }

  /** estimate of the engine player model's effective value for `id` (base + feed-forward × assist) */
  private estimate(id: number, a: number): number {
    const base = this.state.get(id);
    if (this.owns(id)) return base;
    const n = this.current;
    if (!n) return base;
    let v = base;
    if (n.register === 1 && n.f < LOW_HZ) {
      if (id === P.jaw_open) v += 0.15 * a;
      if (id === P.tongue_y) v -= 0.1 * a;
    } else if (n.register >= 2 && n.f > PALM_HZ) {
      if (id === P.lip_force) v += 0.2 * a;
      if (id === P.tongue_y) v += 0.3 * a;
      if (id === P.tongue_x) v -= 0.3 * a;
    } else if (n.register >= 2) {
      if (id === P.lip_force) v += 0.1 * a;
    }
    const t = n.voicing[id];
    if (t !== undefined) v = t; // altissimo voicing: absolute target
    const d = PARAMS[id];
    return Math.min(d.max, Math.max(d.min, v));
  }

  /** per frame: targets → smoothed shown values; status */
  update(dt: number, live: boolean, freq: number): void {
    if (this.mode !== 'play') return;
    const tel = this.engine.telemetry;
    // the engine reports the controls in effect in every mode: authoritative whenever present
    const auto = live && tel.auto.valid ? tel.auto : null;
    this.match = auto ? auto.match : 0;
    this.source = auto ? 'engine' : 'estimate';
    const a = this.state.get(P.player_assist);
    for (let i = 0; i < AUTO_CONTROLS.length; i++) {
      const id = AUTO_CONTROLS[i];
      if (id === P.lung_pressure) this.target[id] = live ? tel.lungPressure / 1000 : this.state.get(id);
      else this.target[id] = auto ? auto.values[i] : this.estimate(id, a);
    }
    // ease the anatomy toward the targets (~0.12 s), so the voicing change is visible
    const k = 1 - Math.exp(-dt / 0.12);
    for (const id of AUTO_CONTROLS) {
      const t = this.target[id];
      this.shown[id] = Number.isFinite(this.shown[id]) ? this.shown[id] + (t - this.shown[id]) * k : t;
    }
    // status
    const blowing = this.kb.isBlowing || this.state.get(P.lung_pressure) > 0.3;
    if (!blowing) { this.status = 'ready'; this.noteT = this.lockT = this.tuneT = 0; this.sampled = false; this.wasSounding = false; return; }
    if (!this.wasSounding) { this.wasSounding = true; this.noteT = this.lockT = 0; }
    this.noteT += dt;
    if (auto) {
      this.status = auto.state === AUTO_STATE.locked ? 'locked' : auto.state === AUTO_STATE.struggling ? 'struggling' : auto.fingering < 0 ? 'free' : 'adjusting';
      this.trackTuning(dt, freq);
      return;
    }
    const n = this.current;
    if (!n) { this.status = 'free'; return; }
    this.trackTuning(dt, freq);
    const inTune = freq > 20 && Math.abs(1200 * Math.log2(freq / n.f)) < LOCK_CENTS;
    this.lockT = inTune ? this.lockT + dt : 0;
    this.status = this.lockT >= LOCK_S ? 'locked' : this.noteT > STRUGGLE_S ? 'struggling' : 'adjusting';
  }

  /** engine voicing match of the current note: 0 exact · 1 nearest fingering · 2 default voicing */
  match = 0;

  // ---- tuning hint: the auto player's lip can trim only so much; a setup that detunes the whole
  // instrument (temperature, cork position, extreme baffle / chamber) leaves every note off.
  // One sample per note (its cents from equal temperament once it has sounded in its register —
  // within ±100 ¢ of the fingering's target — for 0.3 s; a detuned setup is exactly when locking
  // struggles); the mean of the last notes drives the hint; the fix is the cork (≈ +2.5 ¢ per mm of
  // insertion, measured 2–3).
  private tuneSamples: number[] = [];
  /** per-note sampling log since the last setup change (diagnostics; last 8 notes) */
  private tuneLog: { note: string; inRegMs: number; sampled: boolean; cents: number | null }[] = [];
  /** params that define the instrument setup: changing one makes old tuning samples meaningless */
  private static readonly SETUP_IDS: readonly number[] = [P.tip_opening, P.facing_length, P.baffle_height, P.chamber_size, P.throat_diameter, P.mouthpiece_insertion, P.reed_strength, P.reed_model, P.temperature];
  private tuneT = 0;
  private sampled = false;
  /** insertion sensitivity (measured +2–3 ¢/mm; ~3.4 at a far-in cork): the top keeps the hint from overshooting */
  static readonly CENTS_PER_MM = 3;

  private trackTuning(dt: number, freq: number): void {
    const n = this.current;
    if (this.sampled || !n || !(freq > 20)) return;
    // wall clock (not frame dt, which is capped per frame): independent of the frame rate
    const now = performance.now();
    let log = this.tuneLog[this.tuneLog.length - 1];
    if (!log || log.note !== n.name || log.sampled) {
      log = { note: n.name, inRegMs: 0, sampled: false, cents: null };
      this.tuneLog.push(log);
      if (this.tuneLog.length > 8) this.tuneLog.shift();
    }
    if (Math.abs(1200 * Math.log2(freq / n.f)) > 100) { this.tuneT = 0; return; }
    if (!this.tuneT) this.tuneT = now;
    log.inRegMs = Math.round(now - this.tuneT);
    if (now - this.tuneT < 300) return;
    void dt;
    const m = 69 + 12 * Math.log2(freq / 440);
    const cents = 100 * (m - Math.round(m));
    this.tuneSamples.push(cents);
    if (this.tuneSamples.length > 6) this.tuneSamples.shift();
    this.sampled = true;
    log.sampled = true;
    log.cents = +cents.toFixed(1);
  }

  /** mean cents of the recent notes when it warrants a hint (≥ 3 notes, |mean| > 10 ¢), else null */
  tuningHint(): { cents: number; mm: number; text: string } | null {
    if (this.mode !== 'play' || this.tuneSamples.length < 3) return null;
    const c = this.tuneSamples.reduce((a, b) => a + b, 0) / this.tuneSamples.length;
    if (Math.abs(c) <= 10) return null;
    const mm = Math.round((c / AutoPlayer.CENTS_PER_MM) * 2) / 2; // sharp → pull out (less insertion)
    const text = `Instrument runs ${Math.abs(c).toFixed(0)} ¢ ${c > 0 ? 'sharp' : 'flat'} — ${c > 0 ? 'pull the mouthpiece out' : 'push the mouthpiece in'} ~${Math.abs(mm).toFixed(1)} mm`;
    return { cents: c, mm, text };
  }

  /**
   * apply the tuning hint: move the mouthpiece on the cork by `mm` (the correction the user saw on
   * the button; default: the current hint) and forget the old samples
   */
  applyTuning(mm?: number): void {
    const d = mm ?? this.tuningHint()?.mm;
    if (d === undefined || !Number.isFinite(d) || d === 0) return;
    this.state.set(P.mouthpiece_insertion, this.state.get(P.mouthpiece_insertion) - d, 'tuning');
    this.resetTuning();
  }

  private resetTuning(): void {
    this.tuneSamples.length = 0;
    this.tuneLog.length = 0;
  }

  /** number of notes sampled since the last setup change */
  get tuningSamples(): number {
    return this.tuneSamples.length;
  }

  /** diagnostics of the tuning hint: per-note log, mean, threshold */
  tuningDebug(): { log: { note: string; inRegMs: number; sampled: boolean; cents: number | null }[]; mean: number | null; threshold: number; minNotes: number } {
    const n = this.tuneSamples.length;
    return { log: this.tuneLog.map((x) => ({ ...x })), mean: n ? +(this.tuneSamples.reduce((a, b) => a + b, 0) / n).toFixed(1) : null, threshold: 10, minNotes: 3 };
  }

  /**
   * Play mode: a gentle note when the setup is outside the ranges the auto player was tuned for
   * (read from the data at runtime), naming up to two of the offending params; null when inside.
   */
  setupNote(): string | null {
    if (this.mode !== 'play' || !this.validity.size) return null;
    const out: string[] = [];
    for (const [id, [lo, hi]] of this.validity) {
      const v = this.state.get(id), d = PARAMS[id];
      if (v >= lo - 1e-6 && v <= hi + 1e-6) continue;
      if (d.name === 'reed_model') out.push('beam reed');
      else out.push(`${d.label.toLowerCase()} ${formatParam(id, v)}, tuned ${formatParam(id, lo).replace(/ .*/, '')}–${formatParam(id, hi)}`);
    }
    if (!out.length) return null;
    return `This setup is outside what the auto player was tuned for (${out.slice(0, 2).join('; ')}${out.length > 2 ? `; +${out.length - 2} more` : ''}) — notes may be out of tune.`;
  }

  /** current shown value of a control (effective in Play mode) */
  value(id: number): number {
    return this.state.shown.get(id);
  }

  /** "tongue high and forward, firm lip, narrowed throat" — notable departures from neutral */
  describe(): string {
    const v = (id: number): number => this.value(id);
    const parts: string[] = [];
    const ty = v(P.tongue_y), tx = v(P.tongue_x);
    const tH = ty > 0.62 ? 'high' : ty < 0.28 ? 'low' : '';
    const tF = tx < 0.35 ? 'forward' : tx > 0.68 ? 'back' : '';
    if (tH || tF) parts.push(`tongue ${[tH, tF].filter(Boolean).join(' and ')}`);
    const lf = v(P.lip_force), lp = v(P.lip_position), ld = v(P.lip_damping);
    if (lf > 1.25) parts.push(lf > 1.8 ? 'very firm lip' : 'firm lip');
    else if (lf < 0.7) parts.push('loose lip');
    if (lp > 14.5) parts.push('more mouthpiece');
    else if (lp < 9) parts.push('less mouthpiece');
    if (ld > 0.65) parts.push('cushioned lip');
    const jaw = v(P.jaw_open);
    if (jaw > 0.42) parts.push('jaw dropped');
    else if (jaw < 0.15) parts.push('jaw closed');
    if (v(P.glottis_open) < 0.62) parts.push('narrowed throat');
    const lung = v(P.lung_pressure);
    if (lung > 4.5) parts.push('strong air');
    else if (lung > 0.3 && lung < 2) parts.push('gentle air');
    return parts.length ? parts.join(', ') : 'relaxed, neutral voicing';
  }

  statusText(): string {
    switch (this.status) {
      case 'ready': return 'ready';
      case 'free': return 'not a standard fingering';
      case 'adjusting': return 'adjusting…';
      case 'locked': return 'locked';
      case 'struggling': return 'struggling — this setup makes the note hard';
    }
  }
}
