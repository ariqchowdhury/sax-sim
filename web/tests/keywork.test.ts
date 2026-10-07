// Node test: web/src/scene/keywork.ts ≡ engine keywork (pad openness from engine.wasm) for every
// fingering, every alternate fingering and random fractional key states.
// Run: node web/tests/keywork.test.ts   (Node ≥ 23 strips TypeScript types natively)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keywork } from '../src/scene/keywork.ts';
import type { SaxGeometry } from '../src/scene/geometry.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wasmPath = path.join(root, 'web/public/engine.wasm');
if (!fs.existsSync(wasmPath)) {
  console.log('SKIP keywork test: web/public/engine.wasm missing (npm run build:engine)');
  process.exit(0);
}
interface Ex {
  memory: WebAssembly.Memory;
  sax_init(sr: number): number; sax_alloc(n: number): number; sax_load_geometry(p: number, n: number): number;
  sax_set_key(i: number, v: number): void; sax_process(n: number): number; sax_pad_openness_ptr(): number;
}
const ex = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(wasmPath)), {}).exports as unknown as Ex;
ex.sax_init(48000);
const json = fs.readFileSync(path.join(root, 'data/alto_sax.json'));
const geo = JSON.parse(json.toString()) as SaxGeometry;
const ptr = ex.sax_alloc(json.length);
new Uint8Array(ex.memory.buffer, ptr, json.length).set(json);
if (ex.sax_load_geometry(ptr, json.length) !== 0) throw new Error('sax_load_geometry failed');

const kw = new Keywork(geo);
if (kw.warnings.length) console.warn('keywork warnings:', kw.warnings);
const nh = geo.tone_holes.length;
const out = new Float32Array(nh);
let seed = 12345;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const cases: { name: string; pressed: number[] }[] = [];
for (const f of geo.fingerings) cases.push({ name: f.note, pressed: geo.keys.map((k) => (f.keys.includes(k.id) ? 1 : 0)) });
for (const f of geo.alternate_fingerings ?? []) cases.push({ name: `${f.note} (${f.name ?? 'alt'})`, pressed: geo.keys.map((k) => (f.keys.includes(k.id) ? 1 : 0)) });
for (let r = 0; r < 60; r++) cases.push({ name: `random#${r}`, pressed: geo.keys.map(() => (rnd() < 0.3 ? rnd() : 0)) });

let fail = 0;
for (const c of cases) {
  c.pressed.forEach((v, i) => ex.sax_set_key(i, v));
  for (let b = 0; b < 400; b++) ex.sax_process(128); // let the engine's pads settle on their targets
  const pads = new Float32Array(ex.memory.buffer, ex.sax_pad_openness_ptr(), nh);
  kw.evaluate(c.pressed, out);
  const bad = geo.tone_holes.map((h, i) => [h.id, out[i], pads[i]] as const).filter(([, a, b]) => Math.abs(a - b) > 0.02);
  if (bad.length) {
    fail++;
    console.log(`FAIL ${c.name}: ${bad.map(([id, a, b]) => `${id} ts=${a.toFixed(2)} engine=${b.toFixed(2)}`).join(', ')}`);
  }
}
console.log(`keywork: ${cases.length - fail}/${cases.length} key states match the engine`);
process.exit(fail ? 1 : 0);
