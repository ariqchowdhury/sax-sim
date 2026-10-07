// Cause ranking from data/coach_model.json (docs/COACHING.md §Diagnosis):
//  • observation rules: machine-readable `trigger`s — exact port of tools/coach/triggers.py
//  • template ranking (primary): χ² improvement over the default player of the best-matching
//    precomputed cause template, σ_eff² = σ_room² + σ_nuisance²; confidence = softmax over rules.
//    Uses the fitter's `rankCauses()` when present in fit/, else the implementation below.
//  • room requirement per rule ("any" | "dry_or_some" | "dry").
import { FEATURE_NAMES } from './features';
import { robustVector } from './fit/robust';
import type { ModelNote } from './fit/model';

export type RoomName = 'dry' | 'some' | 'too_reverberant' | 'uncertain';
export const ROOM_NAMES: RoomName[] = ['dry', 'some', 'too_reverberant', 'uncertain'];
const ROOM_OK: Record<string, Set<RoomName>> = {
  any: new Set(['dry', 'some', 'too_reverberant', 'uncertain']),
  dry_or_some: new Set(['dry', 'some', 'uncertain']),
  dry: new Set(['dry']),
};

/** model label of a UI take id ("G4 pp" → "G4pp") */
export const modelLabel = (id: string): string => id.replace(/\s+/g, '');

export type FeatsByLabel = Map<string, ArrayLike<number>>;

interface Cond { type: string; x?: string; a?: string; b?: string; feature?: string; notes?: string[] | 'mf'; op: string; value: number }
export interface Trigger { any?: Cond[]; all?: Cond[] }

const OPS: Record<string, (a: number, b: number) => boolean> = {
  '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b,
  '!=': (a, b) => Math.abs(a - b) > 1e-6, '==': (a, b) => Math.abs(a - b) <= 1e-6,
};
const IDX = new Map(FEATURE_NAMES.map((n, i) => [n, i]));
const VALID = IDX.get('valid')!;

function get(feats: FeatsByLabel, ref: string): number | null {
  const [name, lbl] = ref.split('@');
  const f = feats.get(lbl);
  if (!f) return null;
  if ((f[VALID] ?? 1) < 0.5) return null;
  const i = IDX.get(name);
  return i === undefined ? null : Number(f[i]);
}

function notesOf(feats: FeatsByLabel, notes: string[] | 'mf', mfLabels: string[]): string[] {
  return (notes === 'mf' ? mfLabels : notes).filter((n) => feats.has(n));
}

export function condition(feats: FeatsByLabel, c: Cond, mfLabels: string[]): boolean {
  let x: number | null;
  if (c.type === 'value') x = get(feats, c.x!);
  else if (c.type === 'diff') {
    const a = get(feats, c.a!), b = get(feats, c.b!);
    x = a === null || b === null ? null : a - b;
  } else if (c.type === 'any_note' || c.type === 'mean' || c.type === 'max_abs') {
    const vals = notesOf(feats, c.notes!, mfLabels).map((n) => get(feats, `${c.feature}@${n}`)).filter((v): v is number => v !== null);
    if (!vals.length) return false;
    if (c.type === 'any_note') return vals.some((v) => OPS[c.op](v, c.value));
    x = c.type === 'mean' ? vals.reduce((p, q) => p + q, 0) / vals.length : Math.max(...vals.map(Math.abs));
  } else throw new Error(`unknown trigger type ${c.type}`);
  return x !== null && OPS[c.op](x, c.value);
}

export function roomAllows(rule: { room?: string }, room: RoomName): boolean {
  return (ROOM_OK[rule.room ?? 'any'] ?? ROOM_OK.any).has(room);
}

/** tools/coach/triggers.py `fired` */
export function fired(rule: { trigger?: Trigger; room?: string }, feats: FeatsByLabel, room: RoomName, mfLabels: string[]): boolean {
  const t = rule.trigger;
  if (!t) return false;
  if (!roomAllows(rule, room)) return false;
  if (t.all) return t.all.every((c) => condition(feats, c, mfLabels));
  return (t.any ?? []).some((c) => condition(feats, c, mfLabels));
}

// ---- template ranking --------------------------------------------------------------------------
export interface RankedCause { id: string; score: number; p: number; mag?: number }

interface RawModel {
  test_set?: { label: string; written: string; dynamic: number; register_group: string }[];
  protocol_extensions?: { label: string; written: string; dynamic: number; register_group: string; control_offsets?: Record<string, number> }[];
  weights?: { names: string[]; sigma: number[]; weight: number[]; by_room?: Record<string, number[]> };
  cause_ranking?: { templates?: Record<string, { names: string[]; default: number[]; templates: { id: string; mag: number; robust: number[] }[] }>; sigma_nuisance?: Record<string, number[]> };
  rules?: { id: string; kind: string; room?: string }[];
}

export function modelNotes(m: RawModel): ModelNote[] {
  const all = [...(m.test_set ?? []), ...(m.protocol_extensions ?? [])];
  return all.map((t) => ({ label: t.label, written: t.written, dynamic: t.dynamic, register_group: t.register_group as ModelNote['register_group'], control_offsets: (t as { control_offsets?: Record<string, number> }).control_offsets }));
}

const fitMods = import.meta.glob('./fit/*.ts');

/** the fitter's rankCauses() if it exists (same semantics), else null */
async function fitterRank(): Promise<((...a: unknown[]) => unknown) | null> {
  for (const load of Object.values(fitMods)) {
    const mod = (await load()) as Record<string, unknown>;
    if (typeof mod.rankCauses === 'function') return mod.rankCauses as (...a: unknown[]) => unknown;
  }
  return null;
}

/** template ranking implemented from the documented method (used when fit/ has no rankCauses yet) */
export function templateRankLocal(m: RawModel, feats: FeatsByLabel, room: RoomName): { ranked: RankedCause[]; protocol: string } {
  const cr = m.cause_ranking;
  if (!cr?.templates) return { ranked: [], protocol: '' };
  const proto = feats.has('G4push') && cr.templates.G4push ? 'G4push' : 'v1';
  const T = cr.templates[proto];
  const sn = cr.sigma_nuisance?.[proto] ?? [];
  const notes = modelNotes(m).filter((n) => feats.has(n.label));
  const fmap = new Map<string, Float32Array>();
  for (const n of notes) fmap.set(n.label, Float32Array.from(feats.get(n.label)!));
  const rec = robustVector(notes, fmap);
  const recBy = new Map(rec.names.map((n, i) => [n, rec.values[i]]));
  const w = m.weights!;
  const wRoom = w.by_room?.[room] ?? w.weight;
  const wBy = new Map(w.names.map((n, i) => [n, { sigma: w.sigma[i], weight: wRoom[i] }]));
  // usable features: present in the recording, finite, weight > 0
  const use: { i: number; r: number; s2: number }[] = [];
  T.names.forEach((name, i) => {
    const r = recBy.get(name);
    const ww = wBy.get(name);
    if (r === undefined || !Number.isFinite(r) || !ww || !(ww.weight > 0)) return;
    const sRoom = 1 / ww.weight;
    use.push({ i, r, s2: sRoom * sRoom + (sn[i] ?? 0) ** 2 });
  });
  const chi = (v: number[]): number => use.reduce((a, u) => a + (u.r - v[u.i]) ** 2 / u.s2, 0);
  const c0 = chi(T.default);
  const best = new Map<string, { score: number; mag: number }>();
  for (const t of T.templates) {
    const sc = c0 - chi(t.robust);
    const b = best.get(t.id);
    if (!b || sc > b.score) best.set(t.id, { score: sc, mag: t.mag });
  }
  const allowed = new Set((m.rules ?? []).filter((r) => r.kind === 'control' && roomAllows(r, room)).map((r) => r.id));
  const list = [...best.entries()].filter(([id]) => allowed.size === 0 || allowed.has(id)).map(([id, b]) => ({ id, score: b.score, mag: b.mag, p: 0 }));
  const mx = Math.max(...list.map((x) => x.score), 0);
  const z = list.reduce((a, x) => a + Math.exp(0.5 * (x.score - mx)), 0);
  for (const x of list) x.p = Math.exp(0.5 * (x.score - mx)) / z;
  return { ranked: list.sort((a, b) => b.score - a.score), protocol: proto };
}

export async function templateRank(m: RawModel, feats: FeatsByLabel, room: RoomName): Promise<{ ranked: RankedCause[]; source: string }> {
  const fr = await fitterRank().catch(() => null);
  if (fr) {
    try {
      const { loadModel } = await import('./fit/model');
      const known = new Set(modelNotes(m).map((n) => n.label));
      const recorded = [...feats.entries()].filter(([id]) => known.has(id)).map(([id, f]) => ({ id, features: Float32Array.from(f) }));
      const out = (await fr(recorded, loadModel(m), room)) as { id: string; score: number; confidence?: number; magnitude?: number }[];
      if (Array.isArray(out)) return { ranked: out.map((x) => ({ id: x.id, score: x.score, p: x.confidence ?? 0, mag: x.magnitude })), source: 'template ranking (fit/rankCauses)' };
    } catch (err) {
      console.warn('[coach] rankCauses failed, using the local template ranking:', err);
    }
  }
  const r = templateRankLocal(m, feats, room);
  return { ranked: r.ranked, source: `template ranking (${r.protocol})` };
}
