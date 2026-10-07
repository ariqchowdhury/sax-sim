// Compact on-screen fingering chart: schematic of the alto key layout, highlights pressed keys,
// shows the recognised note; clicking a key toggles it (latch). Built from data key ids.
import type { SaxGeometry } from '../scene/geometry';
import { KEY_SRC, type AppState } from '../state';

type Shape = 'pearl' | 'small' | 'pill' | 'pillv';
/** schematic positions (viewBox 0 0 120 210) by key id */
const LAYOUT: Record<string, [number, number, Shape]> = {
  OCT: [16, 48, 'pillv'],
  LH_palm_D: [36, 14, 'pill'], LH_palm_Eb: [36, 24, 'pill'], LH_palm_F: [36, 34, 'pill'],
  LH_front_F: [76, 26, 'small'],
  LH1: [60, 40, 'pearl'], BIS: [60, 53, 'small'], LH2: [60, 64, 'pearl'], LH3: [60, 86, 'pearl'],
  LH_Gs: [34, 100, 'pill'], LH_Cs: [28, 111, 'pill'], LH_B: [42, 113, 'pill'], LH_Bb: [34, 123, 'pill'],
  RH_high_Fs: [80, 116, 'small'],
  RH_side_E: [92, 128, 'pillv'], RH_side_C: [92, 141, 'pillv'], RH_side_Bb: [92, 154, 'pillv'],
  RH1: [60, 132, 'pearl'], RH2: [60, 154, 'pearl'], RH3: [60, 176, 'pearl'],
  RH_Eb: [80, 190, 'pill'], RH_C: [74, 200, 'pill'],
};

export class FingeringChart {
  private els: (SVGElement | null)[] = [];
  private noteEl: HTMLDivElement;

  constructor(root: HTMLElement, private geo: SaxGeometry, private state: AppState) {
    const NS = 'http://www.w3.org/2000/svg';
    this.noteEl = document.createElement('div');
    this.noteEl.className = 'fc-note';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 212');
    svg.classList.add('fc-svg');
    // body outline
    const body = document.createElementNS(NS, 'path');
    body.setAttribute('d', 'M60 4 L60 182 Q60 206 84 206 Q100 206 100 190');
    body.setAttribute('class', 'fc-body');
    svg.appendChild(body);
    let extraY = 0;
    geo.keys.forEach((k, i) => {
      let pos = LAYOUT[k.id];
      if (!pos) { pos = [108, 10 + extraY, 'small']; extraY += 12; } // unknown id: column on the right
      const [x, y, shape] = pos;
      let el: SVGElement;
      if (shape === 'pearl' || shape === 'small') {
        el = document.createElementNS(NS, 'circle');
        el.setAttribute('cx', String(x)); el.setAttribute('cy', String(y)); el.setAttribute('r', shape === 'pearl' ? '7' : '3.6');
      } else {
        el = document.createElementNS(NS, 'rect');
        const w = shape === 'pill' ? 13 : 6, h = shape === 'pill' ? 6 : 11;
        el.setAttribute('x', String(x - w / 2)); el.setAttribute('y', String(y - h / 2));
        el.setAttribute('width', String(w)); el.setAttribute('height', String(h)); el.setAttribute('rx', '3');
      }
      el.setAttribute('class', 'fc-key');
      const t = document.createElementNS(NS, 'title');
      t.textContent = `${k.label ?? k.id} [${k.id}] — click to hold`;
      el.appendChild(t);
      el.addEventListener('click', () => state.toggleLatch(i));
      svg.appendChild(el);
      this.els[i] = el;
    });
    root.append(this.noteEl, svg);
    state.onKeys(() => this.refresh());
    this.refresh();
  }

  /** recognised fingering entry (name + sounding f_target if the data has it), or null */
  recognisedEntry(): { name: string; f_target?: number; register?: number } | null {
    const down = new Set<string>();
    this.geo.keys.forEach((k, i) => { if (this.state.keyDown[i] > 0.5) down.add(k.id); });
    const all = [
      ...this.geo.fingerings.map((f) => ({ name: f.note, keys: f.keys, f_target: f.f_target as number | undefined, register: f.register as number | undefined })),
      ...(this.geo.alternate_fingerings ?? []).map((a) => ({ name: `${a.note} (${a.name ?? 'alt'})`, keys: a.keys, f_target: a.f_target as number | undefined, register: a.register as number | undefined })),
    ];
    return all.find((f) => f.keys.length === down.size && f.keys.every((k) => down.has(k))) ?? null;
  }

  /** recognised fingering name (written) for the current key set, or '' */
  recognised(): string {
    const down = new Set<string>();
    this.geo.keys.forEach((k, i) => { if (this.state.keyDown[i] > 0.5) down.add(k.id); });
    const all = [...this.geo.fingerings.map((f) => ({ name: f.note, keys: f.keys })), ...(this.geo.alternate_fingerings ?? []).map((a) => ({ name: `${a.note} (${a.name ?? 'alt'})`, keys: a.keys }))];
    const m = all.find((f) => f.keys.length === down.size && f.keys.every((k) => down.has(k)));
    return m ? m.name : '';
  }

  refresh(): void {
    this.geo.keys.forEach((_k, i) => {
      const el = this.els[i];
      if (!el) return;
      const m = this.state.keyMask[i];
      el.classList.toggle('down', m !== 0);
      el.classList.toggle('latched', (m & KEY_SRC.latch) !== 0);
    });
    const r = this.recognised();
    const any = this.state.keyDown.some((v) => v > 0.5);
    const e = this.recognisedEntry();
    this.noteEl.textContent = r ? `${r.split(' (')[0]}${e?.register === 3 ? ' · altissimo' : r.includes('(') ? ' · alt' : ''}` : any ? '—' : 'C♯5 (open)';
    this.noteEl.title = r;
  }
}

/** static (non-interactive) fingering diagram with the given key ids pressed — used by the coach */
export function staticFingering(geo: SaxGeometry, keyIds: string[]): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 212');
  svg.classList.add('fc-svg');
  const body = document.createElementNS(NS, 'path');
  body.setAttribute('d', 'M60 4 L60 182 Q60 206 84 206 Q100 206 100 190');
  body.setAttribute('class', 'fc-body');
  svg.appendChild(body);
  const down = new Set(keyIds);
  let extraY = 0;
  for (const k of geo.keys) {
    let pos = LAYOUT[k.id];
    if (!pos) { pos = [108, 10 + extraY, 'small']; extraY += 12; }
    const [x, y, shape] = pos;
    let el: SVGElement;
    if (shape === 'pearl' || shape === 'small') {
      el = document.createElementNS(NS, 'circle');
      el.setAttribute('cx', String(x)); el.setAttribute('cy', String(y)); el.setAttribute('r', shape === 'pearl' ? '7' : '3.6');
    } else {
      el = document.createElementNS(NS, 'rect');
      const w = shape === 'pill' ? 13 : 6, h = shape === 'pill' ? 6 : 11;
      el.setAttribute('x', String(x - w / 2)); el.setAttribute('y', String(y - h / 2));
      el.setAttribute('width', String(w)); el.setAttribute('height', String(h)); el.setAttribute('rx', '3');
    }
    el.setAttribute('class', down.has(k.id) ? 'fc-key down' : 'fc-key');
    svg.appendChild(el);
  }
  return svg;
}
