// Context card: when the user grabs a part (or picks its camera view), show only the detail that
// belongs to it — a few sliders for that part's params and the one visualizer that explains it.
//   tract (tongue / jaw / glottis) → impedance with the vocal-tract overlay
//   lips (embouchure)              → reed / mouthpiece-pressure scope
//   air (lungs)                    → scope (+ blow target)
//   mouthpiece (+ reed, insertion) → output spectrum (timbre)
//   keys                           → fingering chart + bore impedance
import { P, PARAMS, formatParam, type ParamGroup } from '../engine/params';
import type { Telemetry } from '../engine/EngineClient';
import type { AppState } from '../state';
import type { KeyboardPlayer } from './keyboard';
import { ImpedancePlot, Scope, Spectrum } from './visualizers';

export type PartKind = 'air' | 'lips' | 'tract' | 'mouthpiece' | 'keys';
type Viz = 'scope' | 'spectrum' | 'impTract' | 'impBore';

interface Def { title: string; blurb: string; ids: number[]; viz: Viz; blow?: boolean }

const DEFS: Record<PartKind, Def> = {
  air: {
    title: 'Air & lungs',
    blurb: 'Below the threshold pressure the reed does not start; more air = louder and brighter.',
    ids: [P.lung_pressure, P.dynamic, P.breath_noise],
    viz: 'scope',
    blow: true,
  },
  lips: {
    title: 'Lips & embouchure',
    blurb: 'Take-in and lip force set how freely the reed swings — the orange trace is the pressure in the mouthpiece, blue the reed tip.',
    ids: [P.lip_position, P.lip_force, P.lip_damping, P.jaw_open],
    viz: 'scope',
  },
  tract: {
    title: 'Tongue & throat',
    blurb: 'The reed works against bore + vocal tract in series. A high, front tongue moves the tract resonance (cyan) up toward the note — that is how altissimo and bends work.',
    ids: [P.tongue_x, P.tongue_y, P.tongue_tip, P.jaw_open, P.glottis_open],
    viz: 'impTract',
  },
  mouthpiece: {
    title: 'Mouthpiece & reed',
    blurb: 'Baffle, chamber and tip opening shape the brightness (the upper harmonics); sliding the mouthpiece on the cork tunes the whole horn.',
    ids: [P.tip_opening, P.facing_length, P.baffle_height, P.chamber_size, P.throat_diameter, P.mouthpiece_insertion, P.reed_strength],
    viz: 'spectrum',
  },
  keys: {
    title: 'Keys & fingering',
    blurb: 'Click keys to finger (Shift-click = momentary). The peaks are the resonances of this fingering; the orange line is the note you play.',
    ids: [],
    viz: 'impBore',
  },
};

const GROUP_KIND: Partial<Record<ParamGroup, PartKind>> = {
  Air: 'air', Embouchure: 'lips', 'Tongue & Tract': 'tract', Reed: 'mouthpiece', Mouthpiece: 'mouthpiece', Instrument: 'mouthpiece',
};

/** which context a set of params belongs to (first param's group) */
export function partKindOf(ids: readonly number[]): PartKind | null {
  for (const id of ids) {
    const k = GROUP_KIND[PARAMS[id]?.group];
    if (k) return k;
  }
  return null;
}

interface Row { input: HTMLInputElement; out: HTMLOutputElement }

export class ContextCard {
  kind: PartKind | null = null;
  readonly imp: ImpedancePlot;
  private scope: Scope;
  private spectrum: Spectrum;
  private canvases: Record<'scope' | 'spectrum' | 'imp', HTMLCanvasElement>;
  private rows = new Map<number, Row>();
  private blowRow: Row | null = null;
  private title: HTMLElement;
  private blurb: HTMLElement;
  private sliders: HTMLElement;
  private note: HTMLElement;
  /** Play mode: the value a slider should show for a control the auto player drives (NaN = param) */
  valueOf: ((id: number) => number) | null = null;
  /** called when the card opens / closes (layout, camera insets) */
  onChange: (() => void) | null = null;

  constructor(private root: HTMLElement, private state: AppState, private kb: KeyboardPlayer) {
    this.title = root.querySelector('.ctx-title')!;
    this.blurb = root.querySelector('.ctx-blurb')!;
    this.sliders = root.querySelector('.ctx-sliders')!;
    this.note = root.querySelector('.ctx-note')!;
    const mk = (cls: string): HTMLCanvasElement => root.querySelector<HTMLCanvasElement>(`canvas.${cls}`)!;
    this.canvases = { scope: mk('ctx-scope'), spectrum: mk('ctx-spectrum'), imp: mk('ctx-imp') };
    this.scope = new Scope(this.canvases.scope);
    this.spectrum = new Spectrum(this.canvases.spectrum);
    this.imp = new ImpedancePlot(this.canvases.imp);
    root.querySelector('.ctx-close')!.addEventListener('click', () => this.hide());
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hide(); });
    state.onParam((id, v, source) => {
      const r = this.rows.get(id);
      if (!r) return;
      if (source !== 'context') r.input.value = String(v);
      r.out.value = formatParam(id, v);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  show(kind: PartKind): void {
    const wasOpen = this.isOpen;
    if (kind !== this.kind) this.build(kind);
    this.root.hidden = false;
    if (!wasOpen || kind !== this.kind) this.onChange?.();
    this.kind = kind;
  }

  hide(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.onChange?.();
  }

  private build(kind: PartKind): void {
    const d = DEFS[kind];
    this.root.dataset.kind = kind;
    this.title.textContent = d.title;
    this.blurb.textContent = d.blurb;
    this.canvases.scope.hidden = d.viz !== 'scope';
    this.canvases.spectrum.hidden = d.viz !== 'spectrum';
    this.canvases.imp.hidden = d.viz !== 'impTract' && d.viz !== 'impBore';
    this.imp.setShowTract(d.viz === 'impTract');
    this.note.textContent = '';
    this.rows.clear();
    this.blowRow = null;
    this.sliders.textContent = '';
    for (const id of d.ids) {
      const p = PARAMS[id];
      this.rows.set(id, this.slider(p.label, p.description, p.min, p.max, p.step ?? (p.max - p.min) / 200, this.state.get(id), formatParam(id, this.state.get(id)), (v, out) => {
        this.state.set(id, v, 'context');
        out.value = formatParam(id, this.state.get(id));
      }));
    }
    if (d.blow) {
      this.blowRow = this.slider('Blow target', 'pressure the Blow button / Space / note keys blow at', 0, 10, 0.05, this.kb.opts.blowPressure, `${this.kb.opts.blowPressure.toFixed(2)} kPa`, (v, out) => {
        this.kb.opts.blowPressure = v;
        out.value = `${v.toFixed(2)} kPa`;
      });
    }
  }

  private slider(label: string, title: string, min: number, max: number, step: number, value: number, text: string, on: (v: number, out: HTMLOutputElement) => void): Row {
    const row = document.createElement('label');
    row.className = 'ps';
    row.title = title;
    const name = document.createElement('span');
    name.textContent = label;
    const out = document.createElement('output');
    out.value = text;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => on(Number(input.value), out));
    row.append(name, out, input);
    this.sliders.appendChild(row);
    return { input, out };
  }

  /** plain-words line under the visualizer (e.g. the tract resonance vs the note) */
  setNote(text: string, cls = ''): void {
    if (this.note.textContent !== text) this.note.textContent = text;
    if (this.note.className !== `ctx-note ${cls}`) this.note.className = `ctx-note ${cls}`;
  }

  /** per frame: draw only the visible visualizer; keep the blow-target slider in sync */
  draw(t: Telemetry, live: boolean, analyser: AnalyserNode | null, f0: number, sampleRate: number): void {
    if (!this.isOpen || !this.kind) return;
    const v = DEFS[this.kind].viz;
    if (v === 'scope') this.scope.draw(t, live);
    else if (v === 'spectrum') this.spectrum.draw(analyser, f0, sampleRate);
    else this.imp.draw(f0);
    if (this.valueOf) {
      for (const [id, r] of this.rows) {
        const v = this.valueOf(id);
        if (!Number.isFinite(v) || document.activeElement === r.input) continue;
        if (Math.abs(Number(r.input.value) - v) > 1e-4) { r.input.value = String(v); r.out.value = formatParam(id, v); }
        r.input.parentElement!.classList.toggle('auto', true);
      }
    }
    if (this.blowRow && document.activeElement !== this.blowRow.input) {
      const b = this.kb.opts.blowPressure;
      if (Number(this.blowRow.input.value) !== b) { this.blowRow.input.value = String(b); this.blowRow.out.value = `${b.toFixed(2)} kPa`; }
    }
  }
}
