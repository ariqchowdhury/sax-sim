#!/usr/bin/env bash
# Build the engine for the AudioWorklet and copy it to web/public/:
#   engine.wasm          wasm32 + SIMD128 (baseline: every browser the app supports)
#   engine_relaxed.wasm  + relaxed SIMD (fused multiply-add in the bore kernel); the web loader
#                        (web/src/engine/wasmSelect.ts) picks it when WebAssembly.validate accepts
#                        a relaxed-SIMD probe and falls back to engine.wasm otherwise.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$HERE"
cargo build --profile wasm --target wasm32-unknown-unknown --lib
# RUSTFLAGS replaces .cargo/config.toml's rustflags, so restate +simd128; separate target dir
# so the two builds don't invalidate each other.
RUSTFLAGS="-C target-feature=+simd128,+relaxed-simd" \
  cargo build --profile wasm --target wasm32-unknown-unknown --lib --target-dir "$HERE/target/relaxed"
mkdir -p "$ROOT/web/public"
cp "$HERE/target/wasm32-unknown-unknown/wasm/sax_engine.wasm" "$ROOT/web/public/engine.wasm"
cp "$HERE/target/relaxed/wasm32-unknown-unknown/wasm/sax_engine.wasm" "$ROOT/web/public/engine_relaxed.wasm"
# Sanity check: exports present, no imports, identical ABI (needs node; skipped if absent).
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const need = ["memory","sax_alloc","sax_free","sax_init","sax_load_geometry","sax_set_param","sax_set_key","sax_process","sax_telemetry_ptr","sax_telemetry_len","sax_pad_openness_ptr","sax_compute_impedance"];
    const sigs = [];
    for (const f of process.argv.slice(1)) {
      const m = new WebAssembly.Module(fs.readFileSync(f));
      const imp = WebAssembly.Module.imports(m);
      const exp = WebAssembly.Module.exports(m).map(e => e.name);
      const missing = need.filter(n => !exp.includes(n));
      console.log(f.split("/").pop() + ":", fs.statSync(f).size, "bytes; exports:", exp.join(", "));
      if (imp.length) { console.error("ERROR: unexpected imports:", JSON.stringify(imp)); process.exit(1); }
      if (missing.length) { console.error("ERROR: missing exports:", missing.join(", ")); process.exit(1); }
      sigs.push(exp.slice().sort().join(","));
    }
    if (sigs[0] !== sigs[1]) { console.error("ERROR: the two builds export different symbols"); process.exit(1); }
    console.log("OK: no imports, all ABI exports present, both builds export the same ABI");
  ' "$ROOT/web/public/engine.wasm" "$ROOT/web/public/engine_relaxed.wasm"
fi
