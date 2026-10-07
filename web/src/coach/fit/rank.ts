// Template cause ranking (primary, no fit needed) — the method of docs/COACHING.md "Cause ranking"
// and tools/coach/fit.py `rank_causes_template`:
//   score_r = χ²(y, default) − min_m χ²(y, T_r,m),   χ² = Σ ((y_i − t_i)/σ_eff,i)²,
//   σ_eff² = σ_room² + σ_nuisance²,
// with y the recording's robust vector, T_r,m the precomputed robust vectors of a player with only
// cause r at magnitude m (cause_ranking.templates), σ_room = weights.sigma, σ_nuisance =
// cause_ranking.sigma_nuisance. Protocol "G4push" templates are used when that take is present.
// Confidence = softmax(score/τ) over the control rules with τ = √(2n), n = number of robust
// features used — the spread of χ² itself, so score differences below the χ² noise are not
// treated as decisive (softmax(score/2), the nominal likelihood ratio, is ~100 % sure even when
// wrong because σ_eff omits model error). Override with `temperature`.
import { modelNote } from './testset.ts';
import { robustVector } from './robust.ts';
import type { CoachModel, ModelNote } from './model.ts';

export interface CauseScore {
  /** rule id */
  id: string;
  /** χ² improvement over the default player (higher = better explanation) */
  score: number;
  /** softmax(score/τ) over all ranked rules */
  confidence: number;
  /** template magnitude (control steps along the signature) that matched best */
  magnitude: number;
  /** the rule's room requirement is met by the room verdict (unknown verdict → true) */
  roomOk: boolean;
}

export interface RankInput {
  /** test-set id or model label */
  id: string;
  features: Float32Array;
}

const ROOM_OK: Record<string, (v: string) => boolean> = {
  any: () => true,
  dry_or_some: (v) => v === 'dry' || v === 'some',
  dry: (v) => v === 'dry',
};

/**
 * Rank the model's control rules for a recorded test set.
 * @param room  room verdict ('dry' | 'some' | 'too_reverberant' | 'uncertain'); features the model
 *              gives zero weight in that room are left out (Python reference: room-independent)
 */
export function rankCauses(recorded: readonly RankInput[], model: CoachModel, room?: string, temperature?: number): CauseScore[] {
  const notes: ModelNote[] = [];
  const feats = new Map<string, Float32Array>();
  for (const r of recorded) {
    const n = modelNote(model, r.id);
    if (!n) throw new Error(`unknown test-set note "${r.id}"`);
    notes.push(n);
    feats.set(n.label, r.features);
  }
  const proto = feats.has('G4push') && model.templates.G4push ? 'G4push' : 'v1';
  const T = model.templates[proto];
  if (!T) throw new Error(`coach_model.json has no cause_ranking templates for protocol ${proto}`);
  const y = robustVector(notes, feats);
  const col = new Map(T.names.map((n, i) => [n, i]));
  const roomW = room ? model.weights_by_room[room] : undefined;
  const idx: number[] = [];
  const yy: number[] = [];
  const sg: number[] = [];
  y.names.forEach((name, i) => {
    const k = col.get(name);
    if (k === undefined) return;
    if (roomW && roomW.get(name) === 0) return;
    idx.push(k);
    yy.push(y.values[i]);
    const s = model.sigma.get(name) ?? 3.0;
    sg.push(Math.sqrt(s * s + T.sigma_nuisance[k] ** 2));
  });
  const chi = (t: number[]) => yy.reduce((acc, v, i) => acc + ((v - t[idx[i]]) / sg[i]) ** 2, 0);
  const d0 = chi(T.default);
  const best = new Map<string, { chi: number; mag: number }>();
  for (const t of T.templates) {
    const c = chi(t.robust);
    const b = best.get(t.id);
    if (!b || c < b.chi) best.set(t.id, { chi: c, mag: t.mag });
  }
  const scored = [...best].map(([id, b]) => ({ id, score: d0 - b.chi, mag: b.mag })).sort((a, b) => b.score - a.score);
  const top = scored.length ? scored[0].score : 0;
  const tau = temperature ?? Math.max(2, Math.sqrt(2 * yy.length));
  const ex = scored.map((s) => Math.exp((s.score - top) / tau));
  const z = ex.reduce((a, b) => a + b, 0) || 1;
  return scored.map((s, i) => {
    const req = model.rules.find((r) => r.id === s.id)?.room ?? 'any';
    return { id: s.id, score: s.score, confidence: ex[i] / z, magnitude: s.mag, roomOk: !room || room === 'uncertain' || (ROOM_OK[req] ?? (() => true))(room) };
  });
}

/**
 * Control-space offsets (control steps) of a rule at magnitude `mag` — the player the templates
 * were rendered for (tools/coach/fit.py `rule_controls`: mag · w/|w| · √(#controls) steps).
 */
export function ruleOffsetSteps(signature: Record<string, number>, mag: number): Record<string, number> {
  const ks = Object.keys(signature);
  const norm = Math.hypot(...ks.map((k) => signature[k]));
  return Object.fromEntries(ks.map((k) => [k, norm > 0 ? (mag * signature[k] * Math.sqrt(ks.length)) / norm : 0]));
}
