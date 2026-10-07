// Test-set protocol v1 (docs/COACHING.md) and how a test note is rendered from fitted controls.
// Note ids are the UI's ("G4 pp"); the coaching model's labels drop the space ("G4pp").
import { PARAMS } from '../../engine/params.ts';
import type { RenderJob } from './engineHost.ts';
import type { CoachModel, ModelControl, ModelNote, RegisterGroup } from './model.ts';

export type { RegisterGroup };
export type Dynamic = 'pp' | 'mf' | 'ff';

export interface TestNote {
  /** stable id, e.g. "G4", "G4 pp" */
  id: string;
  /** written note name = fingering name in data/alto_sax.json */
  note: string;
  dynamic: Dynamic;
  group: RegisterGroup;
  optional?: boolean;
  /** extra instruction for the player (protocol extensions) */
  instruction?: string;
}

export const TEST_SET: readonly TestNote[] = [
  { id: 'Bb3', note: 'Bb3', dynamic: 'mf', group: 'low' },
  { id: 'D4', note: 'D4', dynamic: 'mf', group: 'low' },
  { id: 'G4', note: 'G4', dynamic: 'mf', group: 'low' },
  { id: 'C5', note: 'C5', dynamic: 'mf', group: 'low' },
  { id: 'C#5', note: 'C#5', dynamic: 'mf', group: 'low' },
  { id: 'D5', note: 'D5', dynamic: 'mf', group: 'mid' },
  { id: 'G5', note: 'G5', dynamic: 'mf', group: 'mid' },
  { id: 'C6', note: 'C6', dynamic: 'mf', group: 'mid' },
  { id: 'F6', note: 'F6', dynamic: 'mf', group: 'palm' },
  { id: 'G4 pp', note: 'G4', dynamic: 'pp', group: 'low' },
  { id: 'G4 ff', note: 'G4', dynamic: 'ff', group: 'low' },
  { id: 'D5 pp', note: 'D5', dynamic: 'pp', group: 'mid', optional: true },
  { id: 'D5 ff', note: 'D5', dynamic: 'ff', group: 'mid', optional: true },
  // protocol extension (recommended): G4 again with the mouthpiece 5 mm further onto the cork —
  // pins the pitch-vs-length slope, breaks the reed/lip-damping/support confounds
  { id: 'G4push', note: 'G4', dynamic: 'mf', group: 'low', optional: true, instruction: 'Push the mouthpiece 5 mm further onto the cork, play G4 mf, then put it back.' },
];

/**
 * Nominal lung pressure (kPa) per take dynamic for pure-physics renders (player_assist 0: UI
 * stand-ins and test fixtures). The fitter does not use it: one `lung_pressure` control serves all
 * takes and the dynamic is realised by the player model (`dynamic` param, player_assist on).
 */
export const DYN_PRESSURE: Record<Dynamic, number> = { pp: 2.2, mf: 3.5, ff: 5.5 };
/** engine `dynamic` param per take dynamic (if the model has no dynamic_by_label entry) */
export const DYNAMIC_PARAM: Record<Dynamic, number> = { pp: 0.15, mf: 0.5, ff: 0.9 };

/** Model label of a UI note id ("G4 pp" → "G4pp"). */
export function labelOf(id: string): string {
  return id.replace(/\s+/g, '');
}

/** Coaching-model note for a UI id or model label (test set or protocol extension). */
export function modelNote(model: CoachModel, id: string): ModelNote | undefined {
  const label = labelOf(id);
  const n = model.test_set.find((t) => t.label === label) ?? model.extensions.find((t) => t.label === label);
  if (n) return n;
  // a protocol note the model does not list (e.g. optional D5 pp): derive it
  const t = TEST_SET.find((x) => labelOf(x.id) === label);
  return t ? { label, written: t.note, dynamic: DYNAMIC_PARAM[t.dynamic], register_group: t.group } : undefined;
}

const PARAM_ID = new Map(PARAMS.map((d) => [d.name, d.id]));

function applies(c: ModelControl, n: ModelNote): boolean {
  return c.scope === 'global' || c.scope === 'dyn' || c.scope === n.register_group;
}

/** Control values at the model defaults. */
export function defaultControlValues(model: CoachModel): Record<string, number> {
  return Object.fromEntries(model.controls.map((c) => [c.key, c.default]));
}

/** Engine params (id, value) of one test note for full control values (fitted + fixed). */
export function paramsFor(model: CoachModel, values: Record<string, number>, n: ModelNote): [number, number][] {
  const byParam = new Map<string, number>();
  for (const c of model.controls) {
    if (!applies(c, n)) continue;
    const v = values[c.key] ?? c.default;
    byParam.set(c.param, Math.min(c.max, Math.max(c.min, v)));
  }
  for (const [k, dv] of Object.entries(n.control_offsets ?? {})) {
    const c = model.controls.find((x) => x.key === k || x.param === k);
    byParam.set(c ? c.param : k, (byParam.get(c ? c.param : k) ?? 0) + dv);
  }
  byParam.set('dynamic', model.sim.dynamic_by_label[n.label] ?? n.dynamic);
  byParam.set('player_assist', model.sim.player_assist);
  const out: [number, number][] = [];
  for (const [name, v] of byParam) {
    const id = PARAM_ID.get(name);
    if (id !== undefined) out.push([id, v]);
  }
  return out;
}

/** Render job of one test note (the model's render protocol: tongued attack, assist, dynamic). */
export function jobFor(model: CoachModel, values: Record<string, number>, n: ModelNote, o: { oversample: number; seconds: number; seed: number; wantAudio?: boolean }): RenderJob {
  return { note: n.written, params: paramsFor(model, values, n), tongueRelease: model.sim.tongue_release, ...o };
}
