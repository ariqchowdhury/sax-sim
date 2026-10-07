// Feature vector layout — docs/COACHING.md "Feature vector (per sustained note) — analysis.rs v1".
// Single definition shared with the fitter (fit/features.ts); units added for display.
export { F, FEATURE_LEN, FEATURE_NAMES } from './fit/features';
import { F } from './fit/features';

export const FEATURE_UNITS: string[] = [
  'Hz', '¢', '¢', 'Hz', '¢', 'dB', '×f0', 'dB', 'dB', 'dB', 'dB', 'dB', 'dB', 'dB', 'dB', 'dB', 'dB',
  'dB', 'dB/oct', 'dB', 'dB', 'ms', '¢', 'dB', '', '',
];

export function harmonic(fv: ArrayLike<number>, k: number): number {
  return fv[F.h1 + k - 1];
}
