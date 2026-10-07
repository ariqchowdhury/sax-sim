// Test-set protocol v1 (docs/COACHING.md) for the wizard: the fitter's TEST_SET (single source)
// plus the optional altissimo note, with the "why" text and helpers for pitch and fingerings.
import type { SaxGeometry } from '../scene/geometry';
import { noteNameToMidi } from '../ui/keyboard';
import { TEST_SET, type Dynamic, type TestNote } from './fit/testset';

export type { Dynamic, TestNote };

const WHY: Record<string, string> = {
  Bb3: 'low register, subtone/stuffiness, cracking up',
  D4: 'low-mid',
  G4: 'reference mid note',
  C5: 'top of register 1',
  'C#5': 'open C#: notoriously unstable / sharp-thin',
  D5: 'first octave-key note (vent switching)',
  G5: 'register 2',
  C6: 'upper register 2',
  F6: 'palm keys: voicing-sensitive',
  'G4 pp': 'dynamic behaviour',
  'G4 ff': 'dynamic behaviour, brightening',
  'D5 pp': 'register-2 dynamics (optional)',
  'D5 ff': 'register-2 dynamics (optional)',
  G6: 'altissimo (only if you have it)',
};

export interface ProtocolNote extends TestNote {
  why: string;
  /** shown prominently in the wizard */
  instruction?: string;
  /** optional but recommended (on by default) */
  recommended?: boolean;
  /** simulator control offsets for this take (G4push: mouthpiece pushed in) */
  controlOffsets?: Record<string, number>;
}

const PUSH_WHY = 'Reference take: the same G4 with the mouthpiece pushed 5 mm further onto the cork. The pitch change it causes pins your instrument\'s pitch-vs-length slope, which lets the coach tell reed strength, lip cushion and air support apart (they sound alike otherwise).';

const PUSH_EXTRA: Partial<ProtocolNote> = {
  recommended: true, why: PUSH_WHY,
  instruction: 'Push the mouthpiece 5 mm further onto the cork, play G4 mf (don\'t adjust your embouchure to fix the pitch), then put it back.',
  controlOffsets: { mouthpiece_insertion: 5 },
};

/** the fitter's TEST_SET (single source, incl. its G4push extension) + UI extras; G6 optional */
export const PROTOCOL: ProtocolNote[] = (() => {
  const list: ProtocolNote[] = TEST_SET.map((n) => ({ ...n, why: WHY[n.id] ?? '', ...(n.id === 'G4push' ? PUSH_EXTRA : {}) }));
  if (!list.some((n) => n.id === 'G4push')) list.push({ id: 'G4push', note: 'G4', dynamic: 'mf', group: 'low', optional: true, ...PUSH_EXTRA } as ProtocolNote);
  if (!list.some((n) => n.id === 'G6')) list.push({ id: 'G6', note: 'G6', dynamic: 'mf', group: 'palm', optional: true, why: WHY.G6 });
  return list;
})();

/** sounding target frequency of a written note on E♭ alto (sounding = written − 9 semitones) */
export function targetHz(note: string, refA = 440): number {
  const m = noteNameToMidi(note);
  return m === null ? 0 : refA * Math.pow(2, (m - 9 - 69) / 12);
}

/** fingering key ids for a written note (standard chart, else a register-3 alternate) */
export function fingeringFor(geo: SaxGeometry, note: string): string[] {
  const midi = noteNameToMidi(note);
  const f = geo.fingerings.find((x) => x.note === note || x.written_midi === midi);
  if (f) return f.keys;
  const a = (geo.alternate_fingerings ?? []).find((x) => x.note === note);
  return a?.keys ?? [];
}

export function dynamicLabel(d: Dynamic): string {
  return d === 'pp' ? 'pianissimo (pp)' : d === 'ff' ? 'fortissimo (ff)' : 'mezzo-forte (mf)';
}
