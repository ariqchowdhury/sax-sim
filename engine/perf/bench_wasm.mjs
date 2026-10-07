// Node benchmark of the AudioWorklet engine (wasm32 + simd128).
//   node engine/perf/bench_wasm.mjs [engine.wasm] [--fingering C#5] [--os 2,4,8] [--reed 0|1] [--seconds 2]
// Loads the wasm, data/alto_sax.json, presses the fingering's keys, blows 4 kPa and times
// sax_process(128) loops (best of 5 trials after a 0.5 s warm-up). Reports µs per 128-sample
// block and × real time at 48 kHz.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const wasmPath = args[0] && !args[0].startsWith('--') ? args[0] : path.join(root, 'web/public/engine.wasm');
const fingering = opt('--fingering', 'C#5');
const oss = opt('--os', '2,4,8').split(',').map(Number);
const reedModel = Number(opt('--reed', '0'));
const seconds = Number(opt('--seconds', '1'));
const geomText = fs.readFileSync(path.join(root, 'data/alto_sax.json'), 'utf8');
const geom = JSON.parse(geomText);
const keyIdx = Object.fromEntries(geom.keys.map((k, i) => [k.id, i]));
const fing = geom.fingerings.find((f) => f.note === fingering);
if (!fing) throw new Error(`no fingering ${fingering}`);
const module = new WebAssembly.Module(fs.readFileSync(wasmPath));
const FS = 48000, BLOCK = 128;

for (const os of oss) {
  const { exports: ex } = new WebAssembly.Instance(module, {});
  ex.sax_init(FS);
  const bytes = new TextEncoder().encode(geomText);
  const ptr = ex.sax_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
  if (ex.sax_load_geometry(ptr, bytes.length) !== 0) throw new Error('geometry');
  ex.sax_free(ptr, bytes.length);
  ex.sax_set_param(21, os); // oversample
  ex.sax_set_param(22, reedModel); // reed_model
  for (const k of fing.keys) ex.sax_set_key(keyIdx[k], 1);
  ex.sax_set_param(0, 4.0); // lung pressure (kPa)
  const blocks = Math.round((seconds * FS) / BLOCK);
  for (let i = 0; i < (0.5 * FS) / BLOCK; i++) ex.sax_process(BLOCK);
  let best = Infinity;
  for (let t = 0; t < 5; t++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < blocks; i++) ex.sax_process(BLOCK);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e3 / blocks);
  }
  const tel = new Float32Array(ex.memory.buffer, ex.sax_telemetry_ptr(), ex.sax_telemetry_len());
  const budget = (BLOCK / FS) * 1e6;
  console.log(
    `wasm ${fingering} os=${os} reed=${reedModel}: ${best.toFixed(1)} µs / 128-sample block  (${(budget / best).toFixed(1)}x realtime, ${((100 * best) / budget).toFixed(1)}% of one core)  f0=${tel[6].toFixed(1)} Hz`,
  );
}
