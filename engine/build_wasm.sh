#!/usr/bin/env bash
# Build the engine for the AudioWorklet and copy it to web/public/engine.wasm.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$HERE"
cargo build --release --target wasm32-unknown-unknown --lib
SRC="$HERE/target/wasm32-unknown-unknown/release/sax_engine.wasm"
mkdir -p "$ROOT/web/public"
cp "$SRC" "$ROOT/web/public/engine.wasm"
# Sanity check: exports present, no imports (needs node; skipped if absent).
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const m = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
    const imp = WebAssembly.Module.imports(m);
    const exp = WebAssembly.Module.exports(m).map(e => e.name);
    const need = ["memory","sax_alloc","sax_free","sax_init","sax_load_geometry","sax_set_param","sax_set_key","sax_process","sax_telemetry_ptr","sax_telemetry_len","sax_pad_openness_ptr"];
    const missing = need.filter(n => !exp.includes(n));
    console.log("engine.wasm:", fs.statSync(process.argv[1]).size, "bytes; exports:", exp.join(", "));
    if (imp.length) { console.error("ERROR: unexpected imports:", JSON.stringify(imp)); process.exit(1); }
    if (missing.length) { console.error("ERROR: missing exports:", missing.join(", ")); process.exit(1); }
    console.log("OK: no imports, all ABI exports present");
  ' "$ROOT/web/public/engine.wasm"
fi
