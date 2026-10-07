// Bridge to the performance engineer's fitter (web/src/coach/fit/fit.ts: Jacobian init →
// Gauss-Newton/CMA-ES over offline renders in a Web Worker pool, docs/COACHING.md "Fitting").
// If the fitter fails (e.g. no worker support), a clearly-labelled heuristic stand-in fits the two
// most robust controls (mouthpiece insertion from the mean cents, lip force from the register-2 /
// register-1 pitch difference) by render-based slopes.
import { P, PARAMS } from '../engine/params';
import type { CoachEngine } from './CoachEngine';
import { F } from './features';
import { DYN_PRESSURE, type Dynamic, type RegisterGroup } from './fit/testset';
import type { FitSummary, TakeResult } from './session';

export interface FitNote {
  id: string;
  note: string;
  dynamic: Dynamic;
  group: RegisterGroup;
  features: Float32Array;
  target: number;
}

export interface FitRequest {
  notes: FitNote[];
  refA: number;
  wasmUrl: string;
  geometry: string;
  onProgress?: (fraction: number, message: string) => void;
  /** recording-quality verdict of sax_room (0 dry · 1 some · 2 too reverberant · 3 uncertain) */
  roomVerdict?: number;
}

interface FitOutput {
  controls: Record<string, number>;
  uncertainty?: Record<string, number>;
  identifiability?: Record<string, number>;
  simFeatures?: Record<string, ArrayLike<number>>;
  perNoteParams?: Record<string, [number, number][]>;
  residual?: number;
  status?: 'ok' | 'failed';
  problems?: string[];
  model?: string;
}

const modelFiles = import.meta.glob('@data/coach_model.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

/** the real fitter (CMA-ES etc.) with a worker pool; resolves to the bridge's FitOutput */
const ROOM_NAMES = ['dry', 'some', 'too_reverberant', 'uncertain'];

/** the real fitter (Gauss–Newton + CMA-ES over offline renders in a worker pool) */
const realFit = async (req: FitRequest): Promise<FitOutput> => {
  const [{ fit }, { browserPool }, { loadModel }, { TEST_SET }] = await Promise.all([import('./fit/fit'), import('./fit/pool'), import('./fit/model'), import('./fit/testset')]);
  const raw = Object.values(modelFiles)[0];
  const model = loadModel(raw ? JSON.parse(raw) : undefined);
  // test-set ids plus the model's protocol extensions (G4push, D5pp/ff, C6ff) by label
  const ext = new Set(model.extensions.map((x) => x.label));
  const recorded = req.notes.filter((n) => TEST_SET.some((t) => t.id === n.id) || ext.has(n.id.replace(/\s+/g, ''))).map((n) => ({ id: n.id, features: n.features }));
  if (recorded.length < 3) throw new Error('need at least 3 test-set notes to fit');
  const pool = browserPool(req.wasmUrl, req.geometry);
  try {
    const room = req.roomVerdict !== undefined ? ROOM_NAMES[req.roomVerdict] : undefined;
    const run = fit(recorded, { evaluator: pool, model, room });
    for await (const p of run) req.onProgress?.(p.fraction, `${p.stage}: ${p.message}`);
    const r = await run.result;
    const controls: Record<string, number> = {}, uncertainty: Record<string, number> = {}, identifiability: Record<string, number> = {};
    for (const c of r.controls) { controls[c.key] = c.value; uncertainty[c.key] = c.sd; identifiability[c.key] = c.identifiability; }
    const simFeatures: Record<string, ArrayLike<number>> = {};
    const perNoteParams: Record<string, [number, number][]> = {};
    for (const n of r.perNote) { simFeatures[n.id] = n.simulated; perNoteParams[n.id] = n.params; }
    return { controls, uncertainty, identifiability, simFeatures, perNoteParams, residual: r.lossConfirm, status: r.status, problems: r.problems, model: r.model };
  } finally {
    pool.close();
  }
};

export function groupOf(note: string): RegisterGroup {
  const order = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const m = /^([A-G][#b]?)(\d)/.exec(note);
  if (!m) return 'low';
  const midi = 12 * (+m[2] + 1) + order.indexOf(m[1]);
  return midi >= 86 ? 'palm' : midi >= 74 ? 'mid' : 'low';
}

/** engine params (name → value) that a control dict gives for one test note (heuristic fit / demo) */
export function paramsForTake(controls: Record<string, number>, note: string, dynamic: Dynamic): Record<string, number> {
  const g = groupOf(note);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(controls)) {
    const [name, scope] = k.split('@');
    if (!PARAMS.some((d) => d.name === name)) continue;
    if (!scope || scope === g || scope === dynamic) out[name] = v;
  }
  if (out.lung_pressure === undefined) out.lung_pressure = DYN_PRESSURE[dynamic];
  return out;
}

function jobParams(p: Record<string, number>): [number, number][] {
  return Object.entries(p).map(([n, v]) => [PARAMS.find((d) => d.name === n)!.id, v] as [number, number]);
}

async function heuristicFit(req: FitRequest, eng: CoachEngine): Promise<FitOutput> {
  const prog = req.onProgress ?? (() => {});
  const mfLow = req.notes.filter((n) => n.dynamic === 'mf' && n.group === 'low' && n.features[F.valid] > 0);
  const mfMid = req.notes.filter((n) => n.dynamic === 'mf' && n.group === 'mid' && n.features[F.valid] > 0);
  const mf = req.notes.filter((n) => n.dynamic === 'mf' && n.features[F.valid] > 0);
  const mean = (a: number[]): number => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0);
  // cents re the recording's own reference — the simulator is tuned at A = 440, so compare at 440
  const recCents = (n: FitNote): number => n.features[F.cents] + 1200 * Math.log2(req.refA / 440);
  const sim = async (note: string, p: Record<string, number>): Promise<number> => {
    const r = await eng.render({ note, params: jobParams({ lung_pressure: DYN_PRESSURE.mf, ...p }), oversample: 2, seconds: 1.6, seed: 1 });
    return r.features[F.valid] > 0 ? r.features[F.cents] : NaN;
  };
  const base = PARAMS[P.mouthpiece_insertion].default, lip0 = PARAMS[P.lip_force].default;
  prog(0.05, 'insertion sensitivity');
  const g0 = await sim('G4', {});
  const g1 = await sim('G4', { mouthpiece_insertion: base + 6 });
  const slopeIns = Number.isFinite(g0) && Number.isFinite(g1) && Math.abs(g1 - g0) > 1 ? (g1 - g0) / 6 : 2.5;
  let insertion = base;
  if (mf.length) insertion = Math.max(0, Math.min(20, base + (mean(mf.map(recCents)) - (Number.isFinite(g0) ? g0 : 0)) / slopeIns));
  let lip = lip0;
  if (mfLow.length && mfMid.length) {
    prog(0.2, 'lip-force sensitivity');
    const d = mean(mfMid.map(recCents)) - mean(mfLow.map(recCents));
    const p0 = { mouthpiece_insertion: insertion };
    const s0 = (await sim('D5', p0)) - (await sim('G4', p0));
    const p1 = { mouthpiece_insertion: insertion, lip_force: lip0 + 0.5 };
    const s1 = (await sim('D5', p1)) - (await sim('G4', p1));
    const k = Number.isFinite(s0) && Number.isFinite(s1) && Math.abs(s1 - s0) > 0.5 ? (s1 - s0) / 0.5 : 0;
    if (k) lip = Math.max(0.2, Math.min(3, lip0 + (d - s0) / k));
  }
  const controls: Record<string, number> = { mouthpiece_insertion: insertion, lip_force: lip };
  const simFeatures: Record<string, number[]> = {};
  for (let i = 0; i < req.notes.length; i++) {
    const n = req.notes[i];
    prog(0.35 + (0.65 * i) / req.notes.length, `simulating ${n.id}`);
    const r = await eng.render({ note: n.note, params: jobParams(paramsForTake(controls, n.note, n.dynamic)), oversample: 2, seconds: 2.0, seed: 1 });
    simFeatures[n.id] = Array.from(r.features);
  }
  prog(1, 'done');
  return { controls, simFeatures };
}

export async function runFit(req: FitRequest, eng: CoachEngine): Promise<FitSummary> {
  const t0 = performance.now();
  let method = 'fitter (web/src/coach/fit)';
  let out: FitOutput;
  try {
    out = await realFit(req);
    if (out.model) method += ` · model ${out.model}`;
  } catch (err) {
    console.warn('[coach] fitter unavailable, using the heuristic stand-in:', err);
    method = `heuristic stand-in (insertion + lip force) — fitter failed: ${(err as Error).message}`;
    out = await heuristicFit(req, eng);
  }
  const sf: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(out.simFeatures ?? {})) sf[k] = Array.from(v);
  return {
    method,
    controls: out.controls,
    uncertainty: out.uncertainty,
    identifiability: out.identifiability,
    simFeatures: sf,
    perNoteParams: out.perNoteParams,
    status: out.status ?? 'ok',
    problems: out.problems ?? [],
    residual: out.residual,
    ms: performance.now() - t0,
  };
}

export function takesToFitNotes(takes: TakeResult[]): FitNote[] {
  return takes.map((t) => ({ id: t.id, note: t.note, dynamic: t.dynamic, group: groupOf(t.note), features: Float32Array.from(t.features), target: t.target }));
}
