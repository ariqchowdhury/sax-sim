// Engine build selection (web/src/engine/wasmSelect.ts): relaxed-SIMD build when supported,
// baseline otherwise or when the relaxed file is missing.  node web/tests/wasmSelect.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pub = path.join(root, 'web/public');
if (!fs.existsSync(path.join(pub, 'engine.wasm'))) {
  console.log('SKIP wasmSelect: web/public/engine.wasm missing (npm run build:engine)');
  process.exit(0);
}
let missing = new Set<string>();
globalThis.fetch = (async (url: string) => {
  const f = path.join(pub, String(url).replace(/^\/+/, '').replace(/\?.*$/, ''));
  if (missing.has(path.basename(f)) || !fs.existsSync(f)) return new Response('<!doctype html>', { status: 200 });
  return new Response(fs.readFileSync(f));
}) as typeof fetch;

let fails = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const mod = '../src/engine/wasmSelect.ts';

{
  const s = await import(mod + '?a');
  check('relaxed SIMD detected in this runtime', s.relaxedSimdSupported());
  const got = await s.fetchEngineWasm('/engine.wasm');
  check('picks engine_relaxed.wasm', got?.relaxed === true && got.url === '/engine_relaxed.wasm', got?.url);
  missing = new Set(['engine_relaxed.wasm']);
  const fb = await s.fetchEngineWasm('/engine.wasm');
  check('falls back when engine_relaxed.wasm is missing (SPA fallback page)', fb?.relaxed === false && fb.url === '/engine.wasm', fb?.url);
  missing = new Set();
}
{
  const validate = WebAssembly.validate;
  WebAssembly.validate = ((b: BufferSource) => (b as Uint8Array).byteLength < 100 ? false : validate(b)) as typeof WebAssembly.validate;
  const s = await import(mod + '?b');
  check('probe rejected → no relaxed SIMD', !s.relaxedSimdSupported());
  const got = await s.fetchEngineWasm('/engine.wasm');
  check('unsupported runtime gets engine.wasm', got?.relaxed === false && got.url === '/engine.wasm', got?.url);
  WebAssembly.validate = validate;
}
{
  const s = await import(mod + '?c');
  missing = new Set(['engine.wasm', 'engine_relaxed.wasm']);
  check('no build → null', (await s.fetchEngineWasm('/engine.wasm')) === null);
}
process.exit(fails ? 1 : 0);
