// Web MIDI input: note-on/off → fingerings (+ blow with velocity), CC2/CC11 → breath (lung pressure),
// CC1 (mod wheel) → vibrato depth or tongue height.
import { P } from '../engine/params';
import type { AppState } from '../state';
import type { KeyboardPlayer } from './keyboard';
import type { Vibrato } from './vibrato';

export interface MidiOptions {
  /** MIDI note numbers are written pitch (sax players' habit) or concert pitch (+9 → written) */
  notes: 'written' | 'concert';
  modWheel: 'vibrato' | 'tongue_y';
  channel: number; // 0 = omni, 1..16
}

export class MidiInput {
  readonly opts: MidiOptions = { notes: 'written', modWheel: 'vibrato', channel: 0 };
  status = 'not connected';
  devices: string[] = [];
  lastEvent = '';
  onStatus: (() => void) | null = null;

  constructor(private state: AppState, private kb: KeyboardPlayer, private vibrato: Vibrato) {}

  async connect(): Promise<void> {
    const nav = navigator as Navigator & { requestMIDIAccess?: (o?: { sysex: boolean }) => Promise<MIDIAccess> };
    if (!nav.requestMIDIAccess) {
      this.status = 'Web MIDI not supported in this browser';
      this.onStatus?.();
      return;
    }
    try {
      const access = await nav.requestMIDIAccess({ sysex: false });
      const bind = (): void => {
        this.devices = [];
        access.inputs.forEach((inp) => {
          this.devices.push(inp.name ?? inp.id);
          inp.onmidimessage = (e) => this.onMessage(e.data);
        });
        this.status = this.devices.length ? `connected: ${this.devices.join(', ')}` : 'no MIDI inputs found';
        this.onStatus?.();
      };
      access.onstatechange = bind;
      bind();
    } catch (err) {
      this.status = `MIDI access denied (${(err as Error).message})`;
      this.onStatus?.();
    }
  }

  /** exposed for tests */
  onMessage(data: Uint8Array | null): void {
    if (!data || data.length < 2) return;
    const st = data[0] & 0xf0, ch = (data[0] & 0x0f) + 1;
    if (this.opts.channel && ch !== this.opts.channel) return;
    const d1 = data[1], d2 = data.length > 2 ? data[2] : 0;
    const written = (n: number): number => (this.opts.notes === 'concert' ? n + 9 : n);
    if (st === 0x90 && d2 > 0) {
      // With the player model active, velocity sets the pp–ff dynamic (pressure + lip + jaw together);
      // in pure physics (assist 0) the engine ignores `dynamic`, so velocity scales the blow pressure instead.
      if (this.kb.opts.velocitySensitive && this.state.get(P.player_assist) > 0) {
        this.state.set(P.dynamic, d2 / 127, 'midi');
        this.kb.noteOn(written(d1), 64);
      } else this.kb.noteOn(written(d1), d2);
      this.lastEvent = `note on ${d1} vel ${d2}`;
    } else if (st === 0x80 || (st === 0x90 && d2 === 0)) {
      this.kb.noteOff(written(d1));
      this.lastEvent = `note off ${d1}`;
    } else if (st === 0xb0) {
      if (d1 === 2 || d1 === 11) this.kb.breath(d2 / 127);
      else if (d1 === 1) {
        if (this.opts.modWheel === 'vibrato') {
          this.vibrato.opts.depth = d2 / 127;
          this.vibrato.opts.enabled = d2 > 0;
        } else this.state.set(P.tongue_y, d2 / 127, 'midi');
      } else if (d1 === 123 || d1 === 120) this.kb.releaseAll();
      this.lastEvent = `CC${d1} = ${d2}`;
    }
  }
}
