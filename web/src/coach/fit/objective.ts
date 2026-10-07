// Objective v1 (docs/COACHING.md; same definition as tools/coach/fit.py):
//   r = W · (robust(sim(u)) − robust(rec))  ⊕  λ · u,   loss = ½ |r|²
// W_i = 1/σ_i from data/coach_model.json (robust features are compared by name; features the
// model gives no weight are ignored), u = (control − default)/step over the fitted controls.
// Fitter-side addition: a `sounding@L` term (weight 10) for every take that sounds in the
// recording but not in the simulation, so a fit where notes go silent cannot look converged.
import { robustVector, sounding } from './robust.ts';
import { weightOf, type CoachModel, type ModelNote } from './model.ts';

export interface Residual {
  /** robust feature name ("cents@G4", "H3_rel@D4", "level_ff-pp@G4", "sounding@F6", …) */
  name: string;
  /** take label the term belongs to ('' for set-level terms) */
  note: string;
  /** W · (sim − rec) */
  r: number;
}

/** The recording side, precomputed once per fit. */
export interface Target {
  notes: ModelNote[];
  names: string[];
  values: Map<string, number>;
  /** labels of takes that sound in the recording */
  soundingLabels: Set<string>;
  room?: string;
}

export function target(notes: readonly ModelNote[], rec: ReadonlyMap<string, Float32Array>, room?: string, exclude?: ReadonlySet<string>): Target {
  // Only takes that sound in the recording carry information: a silent / unpitched take's feature
  // vector is undefined (cents 0, regime 0, …), and comparing the simulation against it biases the
  // fit (e.g. a pp take below the player's threshold pulled every pitch towards 0 ¢). Such takes
  // are dropped from the robust vector on both sides (the simulated mf means use the same takes).
  // (`exclude`: further takes to leave out, e.g. recorded in the wrong regime — see fit.ts)
  const used = notes.filter((n) => rec.has(n.label) && sounding(rec.get(n.label)!) && !exclude?.has(n.label));
  const rv = robustVector(used, new Map(used.map((n) => [n.label, rec.get(n.label)!])));
  return {
    notes: used,
    names: rv.names,
    values: new Map(rv.names.map((n, i) => [n, rv.values[i]])),
    soundingLabels: new Set(used.map((n) => n.label)),
    room,
  };
}

const noteOf = (name: string): string => {
  const at = name.lastIndexOf('@');
  return at >= 0 ? name.slice(at + 1) : '';
};

/** Residuals of a simulated test set against the target; fixed length/order for a given target. */
export function residuals(t: Target, sim: ReadonlyMap<string, Float32Array>, m: CoachModel): Residual[] {
  const rv = robustVector(t.notes, new Map(t.notes.filter((n) => sim.has(n.label)).map((n) => [n.label, sim.get(n.label)!])));
  const sv = new Map(rv.names.map((n, i) => [n, rv.values[i]]));
  const out: Residual[] = [];
  for (const name of t.names) {
    const w = weightOf(m, name, t.room);
    if (!w) continue;
    const label = noteOf(name);
    // a take that is silent in the simulation contributes through `sounding@` only
    const silent = label !== '' && t.soundingLabels.has(label) && !sounding(sim.get(label)!);
    const s = sv.get(name);
    const r = silent || s === undefined || !Number.isFinite(s) ? 0 : w * (s - t.values.get(name)!);
    out.push({ name, note: label, r });
  }
  for (const label of t.soundingLabels) {
    const f = sim.get(label);
    out.push({ name: `sounding@${label}`, note: label, r: f && sounding(f) ? 0 : weightOf(m, `sounding@${label}`, t.room) });
  }
  return out;
}

export function loss(res: readonly Residual[]): number {
  return 0.5 * res.reduce((s, x) => s + x.r * x.r, 0);
}

/** Small dense solve (Gaussian elimination with partial pivoting); null if singular. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-14)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}
