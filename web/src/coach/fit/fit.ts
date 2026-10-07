// Fit the simulator's player/mouthpiece controls to a recorded test set (docs/COACHING.md
// "Fitting" and "Objective v1").
//
//   const run = fit(recorded, { evaluator: browserPool(url, geometryJson), model: loadModel(json) });
//   for await (const p of run) ui.progress(p);
//   const result = await run.result;     // result.status === 'ok' | 'failed'
//
// Pipeline (all renders offline, in parallel on the evaluator's workers):
//  1. sensitivity-informed initialisation: the model's sensitivity table (∂robust/∂control at the
//     defaults) gives the first Gauss–Newton step without renders;
//  2. Levenberg–Marquardt with a forward-difference Jacobian refreshed every iteration (several
//     damping levels evaluated in parallel), as tools/coach/fit.py;
//  3. CMA-ES polish with the remaining time, its covariance seeded from the Gauss–Newton posterior;
//  4. uncertainty: Gauss–Newton covariance at the optimum (scaled by the reduced χ² when > 1);
//  5. confirmation at the higher oversampling, with up to two LM steps there.
import { F } from './features.ts';
import { DEFAULT_MODEL, type CoachModel, type ModelControl, type ModelNote } from './model.ts';
import { loss, residuals, solve, target, type Residual } from './objective.ts';
import { sounding } from './robust.ts';
import { CmaEs, eigSym } from './cmaes.ts';
import { rankCauses, ruleOffsetSteps, type CauseScore } from './rank.ts';
import { TEST_SET, defaultControlValues, jobFor, labelOf, modelNote, paramsFor } from './testset.ts';
import type { Evaluator } from './pool.ts';
import type { RenderJob } from './engineHost.ts';

export interface RecordedNote {
  /** test-set id ("G4", "G4 pp", …) or model label ("G4pp", "G4push") */
  id: string;
  features: Float32Array;
}

export interface FitOptions {
  evaluator: Evaluator;
  /** coaching model (loadModel(data/coach_model.json)); default: built-in defaults */
  model?: CoachModel;
  /** room verdict for the weights ('dry' | 'some' | 'too_reverberant' | 'uncertain') */
  room?: string;
  /** total wall-time budget (ms), default 60 000 */
  timeBudgetMs?: number;
  /**
   * evaluation budget (candidate test sets): when set, the search stages are scheduled by
   * evaluations instead of wall time (machine-load independent, reproducible); the wall-time
   * budget still applies as a hard cap
   */
  maxEvaluations?: number;
  /** rendered note length (s), default model.sim.seconds (2.0) */
  seconds?: number;
  searchOversample?: number;
  confirmOversample?: number;
  seed?: number;
  /** start point (control key → value; default: model defaults) */
  start?: Record<string, number>;
  /** CMA-ES generations without improvement before stopping (default 8) */
  patience?: number;
  /** CMA-ES: isotropic initial step size (control steps) instead of the Gauss–Newton shape */
  cmaSigma?: number;
  /** multi-start from the cause-rule directions (default true) and how many starts to keep (3) */
  multiStart?: boolean;
  starts?: number;
  /** skip the CMA-ES polish (LM only, like tools/coach/fit.py) */
  noCma?: boolean;
  signal?: AbortSignal;
}

export type FitStage = 'init' | 'gauss-newton' | 'cma' | 'uncertainty' | 'confirm' | 'done';

export interface FitProgress {
  stage: FitStage;
  /** 0…1 (time-based estimate) */
  fraction: number;
  evaluations: number;
  elapsedMs: number;
  bestLoss: number;
  message: string;
}

export interface FittedControl {
  key: string;
  /** engine param name */
  param: string;
  value: number;
  /** 1-σ uncertainty (control units), local Gauss–Newton estimate */
  sd: number;
  /** posterior sd / prior sd (prior sd = step/λ): ≪ 1 well determined, ≈ 1 not identifiable */
  identifiability: number;
}

export interface NoteFit {
  id: string;
  label: string;
  recorded: Float32Array;
  /** simulated features at the confirmation oversampling */
  simulated: Float32Array;
  /** engine params (id, value) of this take at the fitted controls (to load / A-B in the simulator) */
  params: [number, number][];
  residuals: { feature: string; r: number }[];
  loss: number;
}

export interface FitResult {
  /** 'failed' when takes that sound in the recording do not sound in the fitted simulation */
  status: 'ok' | 'failed';
  /** recording problems (takes left out, protocol notes missing) and fit problems */
  problems: string[];
  /** labels of recorded takes left out of the objective (silent, wrong regime, far off pitch) */
  excluded: string[];
  /** fitted controls */
  controls: FittedControl[];
  /** all control values (fitted + fixed at their defaults), control key → value */
  values: Record<string, number>;
  /** objective (½|r|², incl. prior) at the search / confirmation oversampling */
  loss: number;
  lossConfirm: number;
  perNote: NoteFit[];
  evaluations: number;
  elapsedMs: number;
  /** wall time per stage (ms) */
  timings: Partial<Record<FitStage, number>>;
  model: string;
  /**
   * confounded groups (identifiability study's confound pairs + |ρ| ≥ 0.6 in this fit's
   * covariance): the direction along which the fit is flat — "either A or B" for the UI
   */
  tradeOffs: TradeOff[];
  /** template cause ranking of the recording (null if the model has no templates) */
  causes: CauseScore[] | null;
}

export interface FitRun extends AsyncIterable<FitProgress> {
  result: Promise<FitResult>;
  abort(): void;
}

interface Eval {
  /** loss incl. prior */
  f: number;
  res: Residual[];
  feats: Map<string, Float32Array>;
}

export function fit(recorded: readonly RecordedNote[], options: FitOptions): FitRun {
  const queue: FitProgress[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let aborted = false;
  const push = (p: FitProgress) => {
    queue.push(p);
    wake?.();
  };
  const result = runFit(recorded, options, push, () => aborted || !!options.signal?.aborted).finally(() => {
    finished = true;
    wake?.();
  });
  result.catch(() => {});
  return {
    result,
    abort: () => {
      aborted = true;
    },
    [Symbol.asyncIterator]: async function* () {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (finished) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}

/** a recorded take further than this from its written note (cents) is treated as a wrong note */
export const REC_MAX_CENTS = 150;

const matmulT = (J: number[][], d: number) => Array.from({ length: d }, (_, a) => Array.from({ length: d }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));

async function runFit(recorded: readonly RecordedNote[], o: FitOptions, push: (p: FitProgress) => void, stopped: () => boolean): Promise<FitResult> {
  const t0 = Date.now();
  const model = o.model ?? DEFAULT_MODEL;
  const budget = o.timeBudgetMs ?? 60000;
  const seconds = o.seconds ?? model.sim.seconds;
  const osSearch = o.searchOversample ?? model.sim.oversample;
  const osConfirm = o.confirmOversample ?? 4;
  const seed = o.seed ?? model.sim.seed;
  const lam = model.lambda_prior;

  // --- takes
  const notes: ModelNote[] = [];
  const ids: string[] = [];
  const rec = new Map<string, Float32Array>();
  for (const r of recorded) {
    const n = modelNote(model, r.id);
    if (!n) throw new Error(`unknown test-set note "${r.id}"`);
    if (rec.has(n.label)) throw new Error(`duplicate take "${r.id}"`);
    notes.push(n);
    ids.push(r.id);
    rec.set(n.label, sanitize(Float32Array.from(r.features)));
  }
  // --- recording checks: takes that cannot be compared with the simulator are excluded from the
  // objective and reported (a silent pp take, an overblown/underblown note or a take assigned to
  // the wrong note would otherwise drag every control towards explaining it)
  const recProblems: string[] = [];
  const excluded = new Set<string>();
  // A take in another regime (cracked to the octave, dropped a register) is left out too: the
  // regime boundary is a cliff in the objective (a fit that has to straddle it lands far off —
  // tested on the flat-player case, whose F6 drops a register), and a crack in a real recording
  // is more often an accident of that take than a property of the setup.
  notes.forEach((n, i) => {
    const f = rec.get(n.label)!;
    const why = !sounding(f)
      ? 'no stable pitch in the recording'
      : Math.abs(Math.log2(f[F.regime] || 1)) > 0.1
        ? `recorded in a different regime (×${+f[F.regime].toFixed(2)} of the written note; cracked or dropped a register?)`
        : Math.abs(f[F.cents]) > REC_MAX_CENTS
          ? `recorded ${f[F.cents] > 0 ? '+' : ''}${f[F.cents].toFixed(0)} ¢ from the written note (wrong note or fingering?)`
          : '';
    if (why) {
      excluded.add(n.label);
      recProblems.push(`${ids[i]}: ${why} — left out of the fit`);
    }
  });
  for (const t of TEST_SET) if (!t.optional && !notes.some((n) => n.label === labelOf(t.id))) recProblems.push(`${t.id}: not recorded — the fit uses the other takes`);
  const tgt = target(notes, rec, o.room, excluded);
  if (!tgt.soundingLabels.size) throw new Error('no recorded take has a stable pitch');

  // --- fitted controls: the model's fit_controls that act on at least one take
  const groups = new Set<string>(notes.map((n) => n.register_group));
  const fitted: ModelControl[] = model.fit_controls.map((k) => model.controls.find((c) => c.key === k)!).filter((c) => c.scope === 'global' || c.scope === 'dyn' || groups.has(c.scope));
  const d = fitted.length;
  const base = { ...defaultControlValues(model), ...(o.start ?? {}) };
  const lo = fitted.map((c) => (c.min - c.default) / c.step);
  const hi = fitted.map((c) => (c.max - c.default) / c.step);
  const clampU = (u: ArrayLike<number>) => Float64Array.from({ length: d }, (_, i) => Math.min(hi[i], Math.max(lo[i], u[i])));
  const values = (u: ArrayLike<number>): Record<string, number> => {
    const v = { ...base };
    fitted.forEach((c, i) => (v[c.key] = Math.min(c.max, Math.max(c.min, c.default + u[i] * c.step))));
    return v;
  };
  const prior = (u: ArrayLike<number>) => Array.from({ length: d }, (_, i) => lam * u[i]);

  let evaluations = 0;
  let best: { u: Float64Array; e: Eval } | null = null;
  const timings: Partial<Record<FitStage, number>> = {};
  let stageStart = Date.now();
  let stage: FitStage = 'init';
  const enter = (s: FitStage) => {
    timings[stage] = (timings[stage] ?? 0) + Date.now() - stageStart;
    stage = s;
    stageStart = Date.now();
  };
  const bestF = () => (best as { e: Eval } | null)?.e.f ?? Infinity;
  const report = (message: string) => push({ stage, fraction: Math.min(1, (Date.now() - t0) / budget), evaluations, elapsedMs: Date.now() - t0, bestLoss: bestF(), message });

  /** Evaluate candidates (u, clamped) at oversampling `os`. */
  const evaluate = async (us: Float64Array[], os: number): Promise<Eval[]> => {
    const jobs: RenderJob[] = [];
    for (const u of us) {
      const v = values(u);
      for (const n of notes) jobs.push(jobFor(model, v, n, { oversample: os, seconds, seed }));
    }
    const rs = await o.evaluator.run(jobs);
    evaluations += us.length;
    return us.map((u, k) => {
      const feats = new Map(notes.map((n, i) => [n.label, sanitize(rs[k * notes.length + i].features)]));
      const res = residuals(tgt, feats, model);
      const e: Eval = { f: loss(res) + 0.5 * prior(u).reduce((s, x) => s + x * x, 0), res, feats };
      if (os === osSearch && e.f < bestF()) best = { u: clampU(u), e };
      return e;
    });
  };
  const rvec = (e: Eval, u: ArrayLike<number>) => [...e.res.map((x) => x.r), ...prior(u)];
  /** forward-difference Jacobian of rvec (h = 0.5 control steps, as tools/coach/fit.py) */
  const jacobian = async (u: Float64Array, e0: Eval, h = 0.5): Promise<number[][]> => {
    const us = fitted.map((_, j) => {
      const v = Float64Array.from(u);
      v[j] = u[j] + h <= hi[j] ? u[j] + h : u[j] - h;
      return v;
    });
    const es = await evaluate(us, osSearch);
    const r0 = rvec(e0, u);
    const J: number[][] = r0.map(() => new Array(d).fill(0));
    for (let j = 0; j < d; j++) {
      const rj = rvec(es[j], us[j]);
      const hj = us[j][j] - u[j];
      for (let i = 0; i < r0.length; i++) J[i][j] = (rj[i] - r0[i]) / hj;
    }
    return J;
  };
  /** Jacobian from the model's sensitivity table (no renders); null if it does not cover the fit. */
  const tableJacobian = (u: Float64Array, e0: Eval): number[][] | null => {
    const st = model.sensitivity;
    if (!st || !fitted.every((c) => st.J_robust[c.key])) return null;
    const col = new Map(st.robust_names.map((n, i) => [n, i]));
    const J: number[][] = rvec(e0, u).map(() => new Array(d).fill(0));
    let covered = 0;
    e0.res.forEach((x, i) => {
      const k = col.get(x.name);
      if (k === undefined) return;
      covered++;
      // r = W (s − rec) → ∂r/∂u = W · ∂s/∂control · step
      const W = model.weights.get(x.name) ?? 0;
      fitted.forEach((c, j) => (J[i][j] = W * st.J_robust[c.key][k] * c.step));
    });
    fitted.forEach((_, j) => (J[e0.res.length + j][j] = lam));
    return covered > 0.5 * e0.res.length ? J : null;
  };
  /** Levenberg–Marquardt trial points for several damping levels (steps capped at ±3). */
  const lmTrials = (J: number[][], r: number[], u: Float64Array, levels: number[]): Float64Array[] => {
    const H = matmulT(J, d);
    const g = Array.from({ length: d }, (_, a) => J.reduce((s, row, i) => s + row[a] * r[i], 0));
    const out: Float64Array[] = [];
    for (const l of levels) {
      const A = H.map((row, a) => row.map((v, c) => v + (a === c ? l * (H[a][a] + 1e-6) : 0)));
      const step = solve(A, g.map((x) => -x));
      if (step) out.push(clampU(Float64Array.from(u, (v, i) => v + Math.max(-3, Math.min(3, step[i])))));
    }
    return out;
  };

  // ---- 1. starting points: default, sensitivity-table predictions, cause-rule directions ------
  // The objective is multi-modal for large multi-control changes, so several starts run in
  // parallel: the default (or the given start), the Gauss–Newton step predicted by the model's
  // sensitivity table, for every cause rule its signature direction at the magnitude the table
  // predicts (≥ ½ step), and a non-negative combination of all rule directions (table NNLS).
  report('screening starting points');
  let causes: CauseScore[] | null = null;
  try {
    causes = rankCauses(recorded, model, o.room);
  } catch {
    causes = null; // model without templates: rule directions only
  }
  let u0: Float64Array = new Float64Array(d);
  if (o.start) fitted.forEach((c, i) => (u0[i] = ((o.start![c.key] ?? c.default) - c.default) / c.step));
  u0 = clampU(u0);
  const [e0] = await evaluate([u0], osSearch);
  const perCandidateMs = Math.max(1, Date.now() - t0);
  const Jt = tableJacobian(u0, e0);
  const starts: { u: Float64Array; why: string }[] = [];
  const sigs: { id: string; v: Float64Array }[] = [];
  for (const rule of model.rules) {
    const v = Float64Array.from(fitted, (c) => rule.signature[c.key] ?? 0);
    const n = Math.hypot(...v);
    if (n > 0) sigs.push({ id: rule.id, v: v.map((x) => x / n) });
  }
  if (o.multiStart !== false) {
    // the template cause ranking's top causes at their best-matching magnitude
    if (causes) {
      for (const cs of causes.slice(0, 4)) {
        const rule = model.rules.find((r) => r.id === cs.id);
        if (!rule) continue;
        const off = ruleOffsetSteps(rule.signature, cs.magnitude);
        starts.push({ u: clampU(Float64Array.from(u0, (x, j) => x + (off[fitted[j].key] ?? 0))), why: `cause ${cs.id} ×${cs.magnitude}` });
      }
    }
    if (Jt) {
      const r0 = rvec(e0, u0);
      for (const t of lmTrials(Jt, r0, u0, [0.1])) starts.push({ u: t, why: 'sensitivity-table step' });
      // per rule: best magnitude along J·s (linear), at least half a step
      const cols = sigs.map((sg) => r0.map((_, i) => Jt[i].reduce((acc, x, j) => acc + x * sg.v[j], 0)));
      sigs.forEach((sg, k) => {
        const v = cols[k];
        const vv = v.reduce((a, x) => a + x * x, 0);
        const a = vv > 0 ? Math.min(3, Math.max(0.5, -v.reduce((acc, x, i) => acc + x * r0[i], 0) / vv)) : 1.5;
        starts.push({ u: clampU(Float64Array.from(u0, (x, j) => x + a * sg.v[j])), why: `rule ${sg.id}` });
      });
      // non-negative combination of rule directions (projected gradient on the linear model)
      const a = new Array(sigs.length).fill(0);
      const L = cols.reduce((acc, v) => acc + v.reduce((s2, x) => s2 + x * x, 0), 0) || 1;
      for (let it = 0; it < 300; it++) {
        const res = r0.map((x, i) => x + cols.reduce((acc, v, k) => acc + v[i] * a[k], 0));
        for (let k = 0; k < a.length; k++) a[k] = Math.min(3, Math.max(0, a[k] - cols[k].reduce((acc, x, i) => acc + x * res[i], 0) / L));
      }
      starts.push({ u: clampU(Float64Array.from(u0, (x, j) => x + sigs.reduce((acc, sg, k) => acc + a[k] * sg.v[j], 0))), why: 'rule combination' });
    } else {
      for (const sg of sigs) starts.push({ u: clampU(Float64Array.from(u0, (x, j) => x + 1.5 * sg.v[j])), why: `rule ${sg.id}` });
    }
  }
  const se = starts.length ? await evaluate(starts.map((x) => x.u), osSearch) : [];
  // keep the best few distinct starts (≥ 0.5 step apart) for the local search
  const pool = [{ u: u0, e: e0, why: 'default' }, ...starts.map((x, i) => ({ u: x.u, e: se[i], why: x.why }))].sort((p, q) => p.e.f - q.e.f);
  const keep: typeof pool = [];
  for (const c of pool) {
    if (keep.length >= (o.starts ?? 3)) break;
    if (keep.every((k) => Math.hypot(...k.u.map((x, i) => x - c.u[i])) > 0.5)) keep.push(c);
  }
  report(`starting from ${keep.map((k) => k.why).join(', ')}`);

  // ---- 2. Levenberg–Marquardt, all starts in parallel ----------------------------------------
  enter('gauss-newton');
  interface Track {
    u: Float64Array;
    e: Eval;
    J: number[][] | null;
    done: boolean;
    why: string;
  }
  const tracks: Track[] = keep.map((k) => ({ u: k.u, e: k.e, J: null, done: false, why: k.why }));
  let J: number[][] | null = null;
  const spent = (frac: number) => (o.maxEvaluations ? evaluations >= frac * o.maxEvaluations : false) || Date.now() - t0 >= frac * budget;
  for (let it = 0; it < 10 && !stopped() && !spent(0.6); it++) {
    const act = tracks.filter((t) => !t.done);
    if (!act.length) break;
    // Jacobians of all active tracks in one batch
    const probeU: Float64Array[] = [];
    for (const t of act) for (let j = 0; j < d; j++) {
      const v = Float64Array.from(t.u);
      v[j] = t.u[j] + 0.5 <= hi[j] ? t.u[j] + 0.5 : t.u[j] - 0.5;
      probeU.push(v);
    }
    const pe = await evaluate(probeU, osSearch);
    const probeBest: { u: Float64Array; e: Eval }[] = [];
    act.forEach((t, ti) => {
      const r0 = rvec(t.e, t.u);
      const Jm: number[][] = r0.map(() => new Array(d).fill(0));
      let pb = { u: t.u, e: t.e };
      for (let j = 0; j < d; j++) {
        const k = ti * d + j;
        const rj = rvec(pe[k], probeU[k]);
        const hj = probeU[k][j] - t.u[j];
        for (let i = 0; i < r0.length; i++) Jm[i][j] = (rj[i] - r0[i]) / hj;
        if (pe[k].f < pb.e.f) pb = { u: probeU[k], e: pe[k] };
      }
      t.J = Jm;
      probeBest.push(pb);
    });
    // LM trials of all active tracks in one batch
    const trialSets = act.map((t) => lmTrials(t.J!, rvec(t.e, t.u), t.u, [0.01, 0.1, 1, 10, 100]));
    const te = await evaluate(trialSets.flat(), osSearch);
    let off = 0;
    act.forEach((t, ti) => {
      const es = te.slice(off, off + trialSets[ti].length);
      const ts = trialSets[ti];
      off += ts.length;
      let k = -1;
      es.forEach((ek, i) => {
        if (ek.f < (k < 0 ? t.e.f : es[k].f)) k = i;
      });
      const before = t.e.f;
      if (k >= 0 && (probeBest[ti].e.f >= es[k].f || probeBest[ti].e.f >= before * 0.99)) {
        t.u = ts[k];
        t.e = es[k];
      } else if (probeBest[ti].e.f < before * 0.99) {
        // the linear model failed but a sensitivity probe found a better point: continue there
        t.u = probeBest[ti].u;
        t.e = probeBest[ti].e;
      } else t.done = true;
      if ((before - t.e.f) / Math.max(before, 1e-9) < 0.005) t.done = true;
    });
    // drop tracks far behind the leader after the first round
    const lead = Math.min(...tracks.map((t) => t.e.f));
    for (const t of tracks) if (it >= 1 && t.e.f > 3 * lead + 5) t.done = true;
    report(`Levenberg–Marquardt round ${it + 1} (${act.length} start${act.length > 1 ? 's' : ''})`);
  }
  {
    const lead = tracks.reduce((a, b) => (b.e.f < a.e.f ? b : a));
    J = lead.J;
  }
  let u = (best as { u: Float64Array } | null)?.u ?? u0;

  // ---- 3. CMA-ES polish ----------------------------------------------------------------------
  enter('cma');
  const reserve = 0.2 * budget; // uncertainty + confirmation
  if (!o.noCma && !spent(0.8)) {
    const b0 = best as { u: Float64Array; e: Eval } | null;
    const start = b0 ? b0.u : u;
    void u;
    // shape from the Gauss–Newton covariance at the best point when a Jacobian is at hand
    let cov: Float64Array[] | undefined;
    let sigma = 0.6;
    const C0 = J && !o.cmaSigma ? gnCov(J, d) : null;
    if (o.cmaSigma) sigma = o.cmaSigma;
    if (C0 && C0.every((row) => row.every(Number.isFinite))) {
      const diag = C0.map((row, i) => Math.max(1e-4, Math.min(4, row[i])));
      const m = Math.max(...diag);
      cov = C0.map((row, i) => Float64Array.from(row, (v, j) => (i === j ? diag[i] / m : ((0.98 * v) / Math.sqrt(Math.max(1e-12, row[i] * C0[j][j]))) * Math.sqrt((diag[i] * diag[j]) / (m * m)))));
      sigma = Math.min(1, Math.max(0.15, Math.sqrt(m)));
    }
    const lambda = Math.max(4 + Math.floor(3 * Math.log(d)), Math.min(16, o.evaluator.size * 2));
    const cma = new CmaEs({ mean: Float64Array.from(start), sigma, cov, lambda, seed });
    let stall = 0;
    let lastBest = bestF();
    let genMs = perCandidateMs * lambda;
    for (let gen = 0; !stopped(); gen++) {
      if (Date.now() - t0 + genMs > budget - reserve) break;
      if (o.maxEvaluations && evaluations + lambda > 0.8 * o.maxEvaluations) break;
      const g0 = Date.now();
      const xs = cma.ask();
      const es = await evaluate(xs.map(clampU), osSearch);
      cma.tell(
        xs,
        es.map((ek, i) => {
          let pen = 0;
          xs[i].forEach((v, j) => (pen += v < lo[j] ? (lo[j] - v) ** 2 : v > hi[j] ? (v - hi[j]) ** 2 : 0));
          return ek.f + 100 * pen;
        }),
      );
      genMs = Date.now() - g0;
      const bf = bestF();
      stall = bf < lastBest * (1 - 0.002) ? 0 : stall + 1;
      lastBest = Math.min(lastBest, bf);
      report(`CMA-ES generation ${gen + 1} (σ ${cma.spread.toFixed(2)} steps)`);
      if (stall >= (o.patience ?? 8) || cma.spread < 0.02) break;
    }
  }
  if (!best) throw new Error('no evaluation succeeded');
  const b = best as { u: Float64Array; e: Eval };

  // ---- 4. uncertainty ------------------------------------------------------------------------
  enter('uncertainty');
  report('estimating uncertainty');
  const priorSd = 1 / Math.max(lam, 1e-6);
  let sdU: number[] = new Array(d).fill(priorSd);
  let Jb: number[][] | null = null;
  let Cu: number[][] | null = null;
  if (!stopped()) {
    Jb = await jacobian(b.u, b.e);
    const C = gnCov(Jb, d);
    const chi2 = Math.max(1, (2 * b.e.f) / Math.max(1, Jb.length - d));
    if (C) {
      Cu = C.map((row) => row.map((v) => v * chi2));
      sdU = Cu.map((row, i) => Math.sqrt(Math.max(0, row[i])));
    }
  }
  // floor: the model's identifiability study (posterior sd under room/mic colouration, which the
  // local estimate on clean renders does not see) for the protocol variant that was recorded
  const ext = model.extensions.map((x) => x.label).filter((l) => rec.has(l));
  const floors = model.identifiability[ext.length ? ext.join('_') : 'v1'] ?? model.identifiability.v1 ?? {};
  sdU = sdU.map((s, i) => Math.max(s, floors[fitted[i].key] ?? 0));

  // ---- 5. confirmation at the higher oversampling ---------------------------------------------
  // The search oversampling biases pitch (~1 ¢ median) and can flip marginal regimes: re-render the
  // optimum at the confirmation oversampling and take up to two LM steps there (search-rate J).
  enter('confirm');
  report(`confirming at oversample ${osConfirm}`);
  let uc: Float64Array = b.u;
  let [ec] = await evaluate([uc], osConfirm);
  for (let it = 0; it < 2 && Jb && !stopped(); it++) {
    const trials = lmTrials(Jb, rvec(ec, uc), uc, [0.1, 1, 10]);
    if (!trials.length) break;
    const es = await evaluate(trials, osConfirm);
    let k = -1;
    es.forEach((ek, i) => {
      if (ek.f < (k < 0 ? ec.f : es[k].f)) k = i;
    });
    report(`refining at oversample ${osConfirm} (step ${it + 1})`);
    if (k < 0) break;
    uc = trials[k];
    ec = es[k];
  }
  enter('done');
  const vals = values(uc);
  const problems: string[] = [...recProblems];
  notes.forEach((n, i) => {
    if (!tgt.soundingLabels.has(n.label)) return;
    const sf = ec.feats.get(n.label)!;
    const rf = rec.get(n.label)!;
    if (!sounding(sf)) problems.push(`${ids[i]}: does not sound in the fitted simulation`);
    else if (Math.abs(Math.log2((sf[F.regime] || 1) / (rf[F.regime] || 1))) > 0.1) problems.push(`${ids[i]}: sounds in a different regime (simulation ×${sf[F.regime]}, recording ×${rf[F.regime]})`);
  });
  const perNote: NoteFit[] = notes.map((n, i) => {
    const rs = ec.res.filter((r) => r.note === n.label).map((r) => ({ feature: r.name, r: r.r }));
    return { id: ids[i], label: n.label, recorded: rec.get(n.label)!, simulated: ec.feats.get(n.label)!, params: paramsFor(model, vals, n), residuals: rs, loss: 0.5 * rs.reduce((s, r) => s + r.r * r.r, 0) };
  });
  const tradeOffs = Cu ? confoundedDirections(Cu, fitted, model.confounds, sdU) : [];
  const res: FitResult = {
    tradeOffs,
    status: problems.some((p) => p.includes('does not sound')) ? 'failed' : 'ok',
    excluded: [...excluded],
    problems,
    controls: fitted.map((c, i) => ({ key: c.key, param: c.param, value: vals[c.key], sd: sdU[i] * c.step, identifiability: sdU[i] / priorSd })),
    values: vals,
    loss: b.e.f,
    lossConfirm: ec.f,
    perNote,
    evaluations,
    elapsedMs: Date.now() - t0,
    timings,
    model: model.source,
    causes,
  };
  report(`done (${res.status}): loss ${b.e.f.toFixed(2)} (oversample ${osConfirm}: ${ec.f.toFixed(2)})`);
  return res;
}

export interface TradeOff {
  /** control keys of the group */
  controls: string[];
  /** unit flat direction in control units per 1-σ step along it (same sign = move together) */
  direction: Record<string, number>;
  /** 1-σ extent along the flat direction (control steps) */
  sdSteps: number;
  /** largest |correlation| within the group (this fit's covariance) */
  correlation: number;
  /** e.g. "baffle_height +0.12 together with chamber_size +0.09 explain the recording equally well" */
  message: string;
}

/** Flat directions of confounded control groups from the (u-space) covariance. */
function confoundedDirections(C: number[][], fitted: readonly ModelControl[], pairs: readonly [string, string, number][], sdU: number[]): TradeOff[] {
  const d = fitted.length;
  const idx = new Map(fitted.map((c, i) => [c.key, i]));
  const corr = (i: number, j: number) => C[i][j] / Math.sqrt(Math.max(1e-30, C[i][i] * C[j][j]));
  // union–find over the confounded pairs
  const parent = fitted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const link = (a: number, b: number) => (parent[find(a)] = find(b));
  for (const [a, b, r] of pairs) {
    const i = idx.get(a), j = idx.get(b);
    if (i !== undefined && j !== undefined && Math.abs(r) >= 0.6) link(i, j);
  }
  for (let i = 0; i < d; i++) for (let j = i + 1; j < d; j++) if (Math.abs(corr(i, j)) >= 0.6) link(i, j);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < d; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  const out: TradeOff[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // principal axis of the group's covariance in standardised coordinates (so a control with a
    // large step does not dominate), mapped back to steps
    const sub = g.map((i) => Float64Array.from(g, (j) => corr(i, j)));
    const { w, V } = eigSym(sub);
    let k = 0;
    for (let q = 1; q < w.length; q++) if (w[q] > w[k]) k = q;
    const vStd = g.map((_, a) => V[a][k]);
    const vSteps = vStd.map((x, a) => x * Math.sqrt(Math.max(0, C[g[a]][g[a]])));
    const n = Math.hypot(...vSteps) || 1;
    const sdSteps = Math.sqrt(Math.max(0, w[k])) * Math.max(...g.map((i) => sdU[i]));
    const sign = Math.sign(vSteps[vSteps.reduce((m, x, a) => (Math.abs(x) > Math.abs(vSteps[m]) ? a : m), 0)]) || 1;
    const direction: Record<string, number> = {};
    g.forEach((i, a) => (direction[fitted[i].key] = ((sign * vSteps[a]) / n) * sdSteps * fitted[i].step));
    let rmax = 0;
    for (const i of g) for (const j of g) if (i < j) rmax = Math.max(rmax, Math.abs(corr(i, j)));
    const parts = g.map((i) => `${fitted[i].key} ${direction[fitted[i].key] >= 0 ? '+' : ''}${direction[fitted[i].key].toPrecision(2)}`);
    out.push({ controls: g.map((i) => fitted[i].key), direction, sdSteps, correlation: rmax, message: `${parts.join(' together with ')} (or the opposite) explain the recording about equally well` });
  }
  return out.sort((a, b) => b.correlation - a.correlation);
}

/** (JᵀJ)⁻¹ (the prior rows are part of J) or null if singular. */
function gnCov(J: number[][], d: number): number[][] | null {
  const H = matmulT(J, d);
  const inv: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
  for (let k = 0; k < d; k++) {
    const e = new Array(d).fill(0);
    e[k] = 1;
    const col = solve(H.map((r) => [...r]), e);
    if (!col) return null;
    for (let i = 0; i < d; i++) inv[i][k] = col[i];
  }
  return inv;
}

/** Non-finite feature values (e.g. −∞ dB) → finite: NaN → 0, ±∞ → ±120. */
function sanitize(f: Float32Array): Float32Array {
  for (let i = 0; i < f.length; i++) if (!Number.isFinite(f[i])) f[i] = Number.isNaN(f[i]) ? 0 : Math.sign(f[i]) * 120;
  return f;
}

/** Valid-pitch check helper for UIs: a recorded take usable for fitting. */
export function usable(f: Float32Array): boolean {
  return f[F.valid] > 0.5;
}

export { labelOf };
