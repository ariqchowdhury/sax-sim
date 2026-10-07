// Template cause ranking (web/src/coach/fit/rank.ts) against the physics lead's Python reference
// (tools/coach/fit.py rank_causes_template) on saved cases (web/tests/fixtures/rank_cases.json,
// regenerate with web/tests/fixtures/make_rank_cases.py).   node web/tests/rank.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel } from '../src/coach/fit/model.ts';
import { rankCauses } from '../src/coach/fit/rank.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const modelPath = path.join(root, 'data/coach_model.json');
const casesPath = path.join(here, 'fixtures/rank_cases.json');
if (!fs.existsSync(modelPath) || !fs.existsSync(casesPath)) {
  console.log('SKIP rank test: data/coach_model.json or fixtures missing');
  process.exit(0);
}
const model = loadModel(fs.readFileSync(modelPath, 'utf8'));
const { cases } = JSON.parse(fs.readFileSync(casesPath, 'utf8')) as {
  cases: { true: string; protocol: string; features: Record<string, number[]>; expected: { id: string; score: number }[] }[];
};
let fails = 0;
for (const [i, c] of cases.entries()) {
  const got = rankCauses(Object.entries(c.features).map(([id, f]) => ({ id, features: Float32Array.from(f) })), model);
  // scores agree (JSON stores σ and templates rounded to 4 decimals; features pass through f32)
  let worst = 0;
  for (const e of c.expected) {
    const g = got.find((x) => x.id === e.id);
    worst = Math.max(worst, g ? Math.abs(g.score - e.score) / Math.max(1, Math.abs(e.score)) : Infinity);
  }
  const top3 = got.slice(0, 3).map((x) => x.id).join(',');
  const ref3 = c.expected.slice(0, 3).map((x) => x.id).join(',');
  const conf = got.reduce((a, x) => a + x.confidence, 0);
  const ok = worst < 2e-3 && top3 === ref3 && Math.abs(conf - 1) < 1e-9;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  case ${i} (${c.protocol}, true ${c.true}): top-3 ${top3}${top3 === ref3 ? '' : ` ≠ Python ${ref3}`}; max rel score diff ${worst.toExponential(1)}; confidence top-1 ${(got[0].confidence * 100).toFixed(0)} %`);
}
console.log(`rank: ${cases.length - fails}/${cases.length} cases match the Python reference`);
process.exit(fails ? 1 : 0);
