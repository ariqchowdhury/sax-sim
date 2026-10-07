// Altissimo list (Play mode): every register-3 entry of the auto-player table (data/alto_sax.json
// `auto_player.entries`, read at run time) with its fingering diagram, the note-mode key and MIDI
// note that play it, the data's caveats (achieved cents / robustness), and a ▶ button that fingers
// and blows it at the current Volume (and lights those keys on the 3D sax).
import type { SaxGeometry } from '../scene/geometry';
import type { SceneApp } from '../scene/SceneApp';
import { staticFingering } from './fingeringChart';
import { keyLabel, noteKeyFor, noteNameToMidi, type KeyboardPlayer } from './keyboard';

interface Achieved { cents?: number; db_re_mf?: number; ok?: boolean; via?: string }
interface RawEntry { note: string; register?: number; keys: string[]; f_target?: number; achieved?: Record<string, Achieved>; robust?: Record<string, boolean> }

export interface AltEntry { note: string; keys: string[]; f: number; midi: number; key: string; caveats: string[] }

const PLAY_MS = 1800;

/** register-3 entries of `auto_player.entries`, with keyboard mapping and caveats */
export function altissimoEntries(geo: SaxGeometry): AltEntry[] {
  const raw = (geo as { auto_player?: { entries?: RawEntry[] } }).auto_player?.entries ?? [];
  const out: AltEntry[] = [];
  for (const e of raw) {
    if (e.register !== 3 || !Array.isArray(e.keys)) continue;
    const midi = noteNameToMidi(e.note);
    if (midi === null) continue;
    const k = noteKeyFor(midi);
    const key = k ? `${k.shift > 0 ? '↑ then ' : k.shift < 0 ? '↓ then ' : ''}${keyLabel(k.code)}` : '—';
    const caveats: string[] = [];
    const mf = e.achieved?.mf;
    if (mf && typeof mf.cents === 'number' && Math.abs(mf.cents) >= 15) caveats.push(`runs about ${mf.cents >= 0 ? '+' : '−'}${Math.abs(mf.cents).toFixed(0)} ¢`);
    const failed = Object.entries(e.achieved ?? {}).filter(([, a]) => a.ok === false).map(([d]) => d);
    if (failed.length) caveats.push(`may not speak at ${failed.join('/')}`);
    if (e.robust && e.robust.slur_mf === false) caveats.push('tongue it — slurring in may fail');
    out.push({ note: e.note, keys: e.keys, f: e.f_target ?? 0, midi, key, caveats });
  }
  return out;
}

export class AltissimoList {
  readonly entries: AltEntry[];
  private timer = 0;
  private playing: number | null = null;
  private lit: number[] = [];

  constructor(private root: HTMLElement, private btn: HTMLButtonElement, private geo: SaxGeometry, private kb: KeyboardPlayer, private scene: SceneApp,
    private ensureAudio: () => Promise<boolean>) {
    this.entries = altissimoEntries(geo);
    const list = root.querySelector('.alt-list')!;
    this.entries.forEach((e, i) => {
      const item = document.createElement('div');
      item.className = 'alt-item';
      item.dataset.note = e.note;
      const head = document.createElement('div');
      head.className = 'alt-note';
      head.textContent = e.note;
      const fig = staticFingering(geo, e.keys);
      fig.classList.add('alt-fig');
      fig.setAttribute('role', 'img');
      fig.setAttribute('aria-label', `${e.note} fingering: ${e.keys.join(', ')}`);
      const map = document.createElement('div');
      map.className = 'alt-map';
      map.innerHTML = `<kbd title="note-mode key">${e.key}</kbd><br><span title="MIDI note number (written pitch)">MIDI ${e.midi}</span>`;
      const play = document.createElement('button');
      play.className = 'alt-play';
      play.textContent = '▶';
      play.title = `Play ${e.note} (fingers it and blows at the current Volume)`;
      play.setAttribute('aria-label', `Play ${e.note}`);
      play.addEventListener('click', () => void this.play(i));
      item.append(head, fig, map);
      if (e.caveats.length) {
        const c = document.createElement('div');
        c.className = 'alt-cav';
        c.textContent = e.caveats.join(' · ');
        item.append(c);
      }
      item.append(play);
      list.append(item);
    });
    btn.addEventListener('click', () => this.toggle(root.hidden === true));
    root.querySelector('.alt-close')!.addEventListener('click', () => this.toggle(false));
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.toggle(false); });
  }

  toggle(open: boolean): void {
    this.root.hidden = !open;
    this.btn.setAttribute('aria-expanded', String(open));
  }

  /** finger + blow entry i for PLAY_MS (a second click stops it), light its keys on the 3D sax */
  async play(i: number): Promise<void> {
    const wasPlaying = this.playing;
    this.stop();
    if (wasPlaying === i) return;
    await this.ensureAudio();
    const e = this.entries[i];
    this.playing = i;
    this.kb.noteOn(e.midi);
    this.light(e.keys);
    this.root.querySelectorAll('.alt-item').forEach((el, k) => el.classList.toggle('on', k === i));
    this.timer = window.setTimeout(() => this.stop(), PLAY_MS);
  }

  /** stop playback: the air stops and ▶ lifts its fingering (it leaves no keys down) */
  stop(): void {
    window.clearTimeout(this.timer);
    if (this.playing !== null) {
      this.kb.noteOff(this.entries[this.playing].midi);
      this.kb.liftFingers();
    }
    this.playing = null;
    this.light([]);
    this.root.querySelectorAll('.alt-item.on').forEach((el) => el.classList.remove('on'));
  }

  private light(keys: string[]): void {
    for (const i of this.lit) this.scene.sax.setKeyHover(i, false);
    this.lit = keys.map((id) => this.geo.keys.findIndex((k) => k.id === id)).filter((i) => i >= 0);
    for (const i of this.lit) this.scene.sax.setKeyHover(i, true);
  }
}
