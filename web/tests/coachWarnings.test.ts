// Unit test of the coach's player-facing recording-guard messages (web/src/coach/warnings.ts).
// Run: node web/tests/coachWarnings.test.ts
import { recordingWarnings } from '../src/coach/warnings.ts';

const fv = (o: { valid?: number; cents?: number; regime?: number }): Float32Array => {
  const f = new Float32Array(26);
  f[25] = o.valid ?? 1;
  f[1] = o.cents ?? 0;
  f[24] = o.regime ?? 1;
  return f;
};
const takes = [
  { id: 'Bb3', features: fv({}) },
  { id: 'D4', features: fv({ cents: 400 }) },
  { id: 'C5', features: fv({ regime: 2, cents: -6 }) },
  { id: 'F6', features: fv({ regime: 0.5 }) },
  { id: 'G4 pp', features: fv({ valid: 0 }) },
];
const problems = [
  'D4: recorded +400 ¢ from the written note (wrong note or fingering?) — left out of the fit',
  'C5: recorded in a different regime (×2 of the written note; cracked or dropped a register?) — left out of the fit',
  'F6: recorded in a different regime (×0.5 of the written note; cracked or dropped a register?) — left out of the fit',
  'G4 pp: no stable pitch in the recording — left out of the fit',
  'D5: not recorded — the fit uses the other takes',
];
const got = recordingWarnings(takes, ['D4', 'C5', 'F6', 'G4pp'], problems);
const want = [
  "D4 was +400 ¢ off the written note (wrong note or fingering?) — left out.",
  'C5 cracked to the octave — left out; try again with a looser lip and slower air.',
  'F6 dropped a register — left out; try again with firmer support.',
  "G4 pp didn't sound — left out; try again with more support.",
  'D5: not recorded — the fit uses the other takes',
];
let fail = 0;
const eq = (name: string, a: unknown, b: unknown): void => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n  got  ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`}`);
};
eq('messages for excluded takes + other problems (exact texts, protocol order)', got, want);
eq('cracked up ×3 (not an octave)', recordingWarnings([{ id: 'Bb3', features: fv({ regime: 3 }) }], ['Bb3'], []), ['Bb3 cracked up (×3.0) — left out; try again with a looser lip and slower air.']);
eq('no exclusions, no problems → no warnings', recordingWarnings(takes, [], []), []);
console.log(`coach warnings: ${fail ? `${fail} failure(s)` : 'all passed'}`);
process.exit(fail ? 1 : 0);
