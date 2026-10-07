// Robust (room/mic-invariant) feature vector — the transform of docs/COACHING.md "Objective v1",
// identical to tools/coach/common.py robust_vector (names and order), generalised to a partial
// test set: entries whose inputs are missing are omitted (the objective compares by name).
import { F, FEATURE_NAMES } from './features.ts';
import type { ModelNote } from './model.ts';

const IDX = new Map(FEATURE_NAMES.map((n, i) => [n, i]));
const SHAPE = ['H2', 'H3', 'H4', 'H5', 'H6', 'tilt', 'odd_even', 'edge', 'hnr'];
const MEAN = ['tilt', 'odd_even', 'edge', 'hnr', 'centroid_rel'];
const DELTA = ['level', 'centroid_rel', 'tilt', 'H2', 'H3', 'H4', 'edge'];

export interface RobustVector {
  names: string[];
  values: number[];
}

/**
 * @param notes  the takes, in protocol order (labels as in the coaching model)
 * @param feats  label → raw feature vector (analysis.rs v1)
 */
export function robustVector(notes: readonly ModelNote[], feats: ReadonlyMap<string, Float32Array>): RobustVector {
  const names: string[] = [];
  const values: number[] = [];
  const push = (n: string, v: number) => {
    names.push(n);
    values.push(v);
  };
  const g = (lbl: string, n: string) => feats.get(lbl)![IDX.get(n)!];
  const have = (lbl: string) => feats.has(lbl);
  // protocol-order test set first (cents, regime of every take)
  for (const t of notes) {
    if (!have(t.label)) continue;
    push(`cents@${t.label}`, g(t.label, 'cents'));
    push(`regime@${t.label}`, g(t.label, 'regime'));
  }
  // mf takes (dynamic 0.5, including protocol extensions such as G4push — as common.py):
  // harmonic shape relative to their mean
  const mf = notes.filter((t) => t.dynamic === 0.5 && have(t.label)).map((t) => t.label);
  if (mf.length) {
    const mean = new Map<string, number>();
    for (const n of new Set([...SHAPE, ...MEAN])) mean.set(n, mf.reduce((s, l) => s + g(l, n), 0) / mf.length);
    for (const l of mf) {
      for (const n of SHAPE) push(`${n}_rel@${l}`, g(l, n) - mean.get(n)!);
      push(`pitch_std@${l}`, g(l, 'pitch_std'));
      push(`scoop@${l}`, g(l, 'scoop'));
    }
    for (const n of MEAN) push(`${n}_mean`, mean.get(n)!);
  }
  for (const n of DELTA) {
    if (have('G4ff') && have('G4pp')) push(`${n}_ff-pp@G4`, g('G4ff', n) - g('G4pp', n));
    if (have('G4') && have('G4pp')) push(`${n}_mf-pp@G4`, g('G4', n) - g('G4pp', n));
    if (have('D5pp') && have('D5ff')) push(`${n}_ff-pp@D5`, g('D5ff', n) - g('D5pp', n));
    if (have('C6ff') && have('C6')) push(`${n}_ff-mf@C6`, g('C6ff', n) - g('C6', n));
  }
  if (have('G4push') && have('G4')) {
    push('cents_push-ref@G4', g('G4push', 'cents') - g('G4', 'cents'));
    if (have('C6')) push('cents_push@C6vsG4', g('C6', 'cents') - g('G4', 'cents'));
  }
  return { names, values };
}

/** Did the take produce a stable pitch? */
export const sounding = (f: Float32Array): boolean => f[F.valid] > 0.5;
