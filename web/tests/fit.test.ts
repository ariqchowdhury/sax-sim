// Coach fit (web/src/coach/fit): recover hidden player/mouthpiece controls from simulated
// "recordings" (no room/mic), on Node worker_threads with engine.wasm and data/coach_model.json.
//   node web/tests/fit.test.ts                  (2 cases)
//   FIT_CASES=all node web/tests/fit.test.ts    (all cases)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePool } from '../src/coach/fit/node/nodePool.ts';
import { fit } from '../src/coach/fit/fit.ts';
import { loadModel } from '../src/coach/fit/model.ts';
import { TEST_SET, defaultControlValues, jobFor, modelNote } from '../src/coach/fit/testset.ts';
import { loss, residuals, target } from '../src/coach/fit/objective.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wasmFile = ['engine_relaxed.wasm', 'engine.wasm'].map((f) => path.join(root, 'web/public', f)).find((f) => fs.existsSync(f));
if (!wasmFile) {
  console.log('SKIP fit test: web/public/engine.wasm missing (npm run build:engine)');
  process.exit(0);
}
let mod: WebAssembly.Module;
try {
  mod = new WebAssembly.Module(fs.readFileSync(wasmFile));
} catch {
  mod = new WebAssembly.Module(fs.readFileSync(path.join(root, 'web/public/engine.wasm')));
}
if (!WebAssembly.Module.exports(mod).some((e) => e.name === 'sax_analyze')) {
  console.log('SKIP fit test: engine.wasm has no sax_analyze (rebuild the engine)');
  process.exit(0);
}
const modelPath = path.join(root, 'data/coach_model.json');
const model = loadModel(fs.existsSync(modelPath) ? fs.readFileSync(modelPath, 'utf8') : undefined);
const geometry = fs.readFileSync(path.join(root, 'data/alto_sax.json'), 'utf8');
const pool = nodePool(mod, geometry);
const baseNotes = TEST_SET.filter((n) => !n.optional).map((t) => ({ id: t.id, n: modelNote(model, t.id)! }));
const pushNote = { id: 'G4push', n: modelNote(model, 'G4push')! };

// renders are bit-identical whatever the worker rendered before (sax_reset_state)
{
  const j = jobFor(model, defaultControlValues(model), baseNotes[10].n, { oversample: 4, seconds: 1.5, seed: 3 });
  const other = jobFor(model, { ...defaultControlValues(model), lip_force: 2 }, baseNotes[8].n, { oversample: 4, seconds: 1.5, seed: 9 });
  const r = await pool.run([j, other, j, j, other, j, j, j, j, j, j, j, j, j, j, j, j, j]);
  const ref = r[0].features;
  const same = r.filter((_, i) => i !== 1 && i !== 4).every((x) => x.features.every((v, k) => Object.is(v, ref[k])));
  console.log(`${same ? 'PASS' : 'FAIL'}  back-to-back renders bit-identical across workers`);
  if (!same) process.exit(1);
}

// hidden players: offsets in control steps from the defaults
// (the last two are weakly identifiable: a lip force ↔ lip position ↔ tip opening valley whose
//  objective differs from the truth by less than the recording-vs-simulation mismatch)
const CASES: { name: string; steps: Record<string, number>; push?: boolean; weak?: boolean }[] = [
  { name: 'sharp: mouthpiece pushed in, firm lip, small chamber', steps: { mouthpiece_insertion: 1.3, lip_force: 2, chamber_size: -1 } },
  { name: 'bright: high baffle, little lip damping, more air', steps: { baffle_height: 2.5, lip_damping: -1.6, lung_pressure: 2.5 } },
  { name: 'flat: mouthpiece pulled out, soft reed, damped lip, open jaw', steps: { mouthpiece_insertion: -1.3, reed_strength: -1, lip_damping: 2, 'jaw_open@low': 1 } },
  { name: 'big mouthpiece/reed change: more mouthpiece, open tip, hard reed', steps: { lip_position: 2, tip_opening: 2, reed_strength: 1.5, baffle_height: 1.5 }, weak: true },
  { name: 'same big change, with the G4push take', steps: { lip_position: 2, tip_opening: 2, reed_strength: 1.5, baffle_height: 1.5 }, push: true, weak: true },
];
const which = process.env.FIT_CASES === 'all' ? CASES : process.env.FIT_CASES ? process.env.FIT_CASES.split(',').map((i) => CASES[Number(i)]).filter(Boolean) : CASES.slice(0, 2);

let failures = 0;
for (const c of which) {
  const hidden = defaultControlValues(model);
  for (const [k, s] of Object.entries(c.steps)) {
    const ctl = model.controls.find((q) => q.key === k)!;
    hidden[k] = ctl.default + s * ctl.step;
  }
  const notes = c.push ? [...baseNotes, pushNote] : baseNotes;
  // "recording": higher oversampling, longer notes, another breath-noise seed than the fit
  const recs = await pool.run(notes.map(({ n }) => jobFor(model, hidden, n, { oversample: 4, seconds: 2.5, seed: 101 })));
  const recorded = notes.map(({ id }, i) => ({ id, features: recs[i].features }));
  // reference: how well the hidden controls themselves explain the recording at fit settings
  const truth = await pool.run(notes.map(({ n }) => jobFor(model, hidden, n, { oversample: 4, seconds: model.sim.seconds, seed: model.sim.seed })));
  const tgt = target(notes.map((x) => x.n), new Map(notes.map(({ n }, i) => [n.label, recs[i].features])));
  const lossTruth = loss(residuals(tgt, new Map(notes.map(({ n }, i) => [n.label, truth[i].features])), model));
  const run = fit(recorded, { evaluator: pool, model, timeBudgetMs: Number(process.env.FIT_BUDGET_MS ?? 150000), maxEvaluations: Number(process.env.FIT_MAX_EVALS ?? 400), seconds: process.env.FIT_SECONDS ? Number(process.env.FIT_SECONDS) : undefined, cmaSigma: process.env.CMA_SIGMA ? Number(process.env.CMA_SIGMA) : undefined });
  let stages = 0;
  for await (const p of run) { stages++; if (process.env.FIT_VERBOSE) console.log(`    ${(p.elapsedMs / 1000).toFixed(1)} s ${p.stage}: ${p.message} (best ${p.bestLoss.toFixed(1)})`); }
  const r = await run.result;
  // recovery in control steps (the resolution of the advice) over the well-determined controls,
  // after removing errors along the reported trade-off directions
  // (posterior sd < ½ prior sd): RMS ≤ 0.6 steps and none beyond 1.5 steps (confounded pairs such
  // as reed strength ↔ lip damping ↔ air pressure trade off within that)
  const lines: string[] = [];
  const errs: number[] = [];
  // errors along a reported trade-off direction are not counted (the UI says "either A or B"):
  // remove each error vector's projection onto the group's flat direction (in control steps)
  const errStep = new Map(r.controls.map((fc) => [fc.key, (fc.value - hidden[fc.key]) / model.controls.find((q) => q.key === fc.key)!.step]));
  const residualErr = new Map(errStep);
  for (const t of r.tradeOffs) {
    const dir = t.controls.map((k) => t.direction[k] / model.controls.find((q) => q.key === k)!.step);
    const n = Math.hypot(...dir) || 1;
    const proj = t.controls.reduce((a, k, i) => a + residualErr.get(k)! * (dir[i] / n), 0);
    t.controls.forEach((k, i) => residualErr.set(k, residualErr.get(k)! - proj * (dir[i] / n)));
  }
  for (const fc of r.controls) {
    const err = residualErr.get(fc.key)!;
    const determined = fc.identifiability < 0.5;
    if (determined) errs.push(err);
    const flag = determined && Math.abs(err) > 1.5 ? '✗' : determined && Math.abs(err) > 1 ? '~' : ' ';
    lines.push(`  ${flag} ${fc.key.padEnd(22)} hidden ${hidden[fc.key].toFixed(2).padStart(6)}  fit ${fc.value.toFixed(2).padStart(6)} ± ${fc.sd.toFixed(2).padEnd(5)} err ${errStep.get(fc.key)!.toFixed(2).padStart(5)} steps (${err.toFixed(2)} off the trade-offs)  (ident ${fc.identifiability.toFixed(2)}${determined ? '' : ', not determined'})`);
  }
  const rms = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / Math.max(1, errs.length));
  const worst = Math.max(0, ...errs.map(Math.abs));
  const bad = rms <= 0.6 && worst <= 1.5 ? 0 : 1;
  // the fit must explain the recording about as well as the truth, sound everywhere, in budget
  const explains = r.lossConfirm <= 1.5 * lossTruth + 5;
  // (search scheduled by evaluations — 400 test sets — so the result does not depend on machine
  // load; the 60 s wall-time target is reported, not asserted)
  const ok = bad === 0 && explains && r.status === 'ok' && stages > 3;
  // weakly identifiable cases are reported, not asserted
  if (!ok && !c.weak) failures++;
  console.log(`${ok ? 'PASS' : c.weak ? 'INFO (weakly identifiable, not asserted)' : 'FAIL'}  ${c.name}: recovery RMS ${rms.toFixed(2)} steps (worst ${worst.toFixed(2)}), ${(r.elapsedMs / 1000).toFixed(1)} s, ${r.evaluations} evaluations, loss os2 ${r.loss.toFixed(1)} / os4 ${r.lossConfirm.toFixed(1)} (truth ${lossTruth.toFixed(1)}), status ${r.status}${r.problems.length ? ' — ' + r.problems.join('; ') : ''}`);
  console.log(`      stages ${Object.entries(r.timings).map(([k, v]) => `${k} ${((v ?? 0) / 1000).toFixed(1)} s`).join(', ')}`);
  for (const l of lines) console.log(l);
  if (r.causes) console.log(`      template causes: ${r.causes.slice(0, 3).map((x) => `${x.id} ${(100 * x.confidence).toFixed(0)}%`).join(', ')}`);
  for (const t of r.tradeOffs) console.log(`      trade-off (ρ ${t.correlation.toFixed(2)}): ${t.message}`);
}
// recording guard: a silent take and a take in the wrong regime are left out and reported (not fitted)
{
  const recs = await pool.run(baseNotes.map(({ n }) => jobFor(model, defaultControlValues(model), n, { oversample: 2, seconds: 1.5, seed: 7 })));
  const recorded = baseNotes.map(({ id }, i) => ({ id, features: Float32Array.from(recs[i].features) }));
  const pp = recorded.find((x) => x.id === 'G4 pp')!;
  pp.features.fill(0); // silent take (no stable pitch)
  const c5 = recorded.find((x) => x.id === 'C5')!;
  c5.features[24] = 2; // overblown to the octave: left out
  const d4 = recorded.find((x) => x.id === 'D4')!;
  d4.features[1] = 400; // wrong note: left out
  // the objective ignores the silent take's undefined features
  const tg = target(baseNotes.map((x) => x.n), new Map(baseNotes.map(({ n }, i) => [n.label, recorded[i].features])));
  const silentIn = tg.names.some((nm) => nm.endsWith('@G4pp') || nm.includes('-pp@G4'));
  const r = await fit(recorded, { evaluator: pool, model, maxEvaluations: 30, timeBudgetMs: 60000, noCma: true, multiStart: false }).result;
  const ok = !silentIn && r.excluded.includes('G4pp') && r.excluded.includes('D4') && r.excluded.includes('C5') && r.problems.some((p) => p.startsWith('G4 pp: no stable pitch')) && r.problems.some((p) => p.startsWith('D4: recorded +400 ¢')) && r.problems.some((p) => p.startsWith('C5: recorded in a different regime')) && r.status === 'ok';
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  recording guard: silent / wrong-regime / wrong-note takes left out and reported — excluded [${r.excluded.join(', ')}]; ${r.problems.join('; ')}`);
}
pool.close();
console.log(`fit: ${failures} failure(s) in ${which.length} cases (model: ${model.source})`);
process.exit(failures ? 1 : 0);
