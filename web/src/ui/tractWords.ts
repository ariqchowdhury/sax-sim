// Plain-words description of the vocal-tract resonance against the note being played.
// The reed sees Z_bore + Z_tract in series: a strong tract peak from just at to a few hundred cents
// ABOVE the playing frequency supports the note (altissimo / upper-register voicing,
// docs/ALTISSIMO.md: up to about a minor third above); one sitting on a lower bore peak can pull
// the note down; near a harmonic it colours the tone; elsewhere it does little.

/** a tract peak at least this strong (Pa·s/m³) is "strong" (10 MPa·s/m³) */
export const TRACT_STRONG = 10e6;

export interface TractWords {
  /** 3D label: numbers */
  txt: string;
  /** context card: sentence */
  plain: string;
  /** inset: a few words */
  short: string;
  /** airway cue: 2 supporting (green), 1 near / pulling (amber), 0 none */
  cue: number;
}

const signed = (x: number, d = 0): string => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;

/**
 * @param tr tract resonance (Hz, 0 = unknown) · @param mag its |Z| (Pa·s/m³)
 * @param target playing frequency, else the fingering's target (Hz, 0 = none)
 * @param borePeaks bore impedance peaks (Hz) · @param tongueY tongue height in effect (0…1)
 */
export function tractWords(tr: number, mag: number, target: number, borePeaks: readonly number[], tongueY: number): TractWords {
  if (!(tr > 0)) return { txt: 'computing…', plain: 'Tract resonance: computing…', short: 'tract: computing…', cue: 0 };
  const strong = mag >= TRACT_STRONG;
  let txt = `≈ ${Math.round(tr)} Hz · ${(mag / 1e6).toFixed(0)} MPa·s/m³`;
  let plain = `Tract resonance ≈ ${Math.round(tr)} Hz`;
  let short = `Tract ≈ ${Math.round(tr)} Hz`;
  let cue = 0;
  if (target > 20) {
    const c = 1200 * Math.log2(tr / target);
    txt += ` · note ${Math.round(target)} Hz (${c >= 0 ? '+' : ''}${c.toFixed(0)}¢)`;
    const near = (f: number): boolean => Math.abs(1200 * Math.log2(tr / f)) <= 50;
    const lowerPeak = borePeaks.find((p) => p < target * 0.97 && near(p));
    const harm = [2, 3].find((k) => near(k * target));
    let where: string, w: string;
    if (strong && c >= -30 && c <= 400) { cue = 2; where = `${signed(c)}¢: tuned just above the note — supporting it (altissimo / upper-register voicing)`; w = `${signed(c)}¢ · supporting the note`; }
    else if (strong && lowerPeak) { cue = 1; where = `on a lower bore resonance (${Math.round(lowerPeak)} Hz) — may pull the note down`; w = 'may pull the note down'; }
    else if (strong && harm) { where = `near harmonic ${harm} of the note — colours the tone`; w = `colours harmonic ${harm}`; }
    else { where = `${signed(c)}¢ from the note — little effect`; w = 'not near the note'; }
    if (strong && cue === 0 && c > -500 && c < 900 && !lowerPeak) cue = 1;
    plain += ` — ${where}`;
    short += ` · ${w}`;
  }
  if (!strong) {
    const neutral = tongueY < 0.5;
    txt += ` · weak${neutral ? ' (neutral tongue)' : ''}`;
    plain += ` (weak${neutral ? ': neutral tongue' : ''})`;
    short += ' (weak)';
  }
  return { txt, plain, short, cue };
}
