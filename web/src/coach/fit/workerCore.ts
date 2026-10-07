// Shared worker logic (browser Web Worker and Node worker_threads): one EngineHost per worker.
import { EngineHost } from './engineHost.ts';
import { fetchEngineWasm } from '../../engine/wasmSelect.ts';
import type { FromFitWorker, ToFitWorker } from './protocol.ts';

export function makeWorkerHandler(post: (m: FromFitWorker, transfer?: Transferable[]) => void): (m: ToFitWorker) => void {
  let host: EngineHost | null = null;
  const pending: ToFitWorker[] = [];
  let initialising = false;
  const handle = (m: ToFitWorker): void => {
    if (m.type === 'init') {
      initialising = true;
      void (async () => {
        try {
          let mod: WebAssembly.Module;
          if (m.wasm instanceof WebAssembly.Module) mod = m.wasm;
          else if (typeof m.wasm === 'string') {
            const got = await fetchEngineWasm(m.wasm);
            if (!got) throw new Error(`engine.wasm not available at ${m.wasm}`);
            mod = await WebAssembly.compile(got.bytes);
          } else mod = await WebAssembly.compile(m.wasm);
          host = new EngineHost(mod, m.geometry);
          initialising = false;
          post({ type: 'ready', native: host.native });
          for (const q of pending.splice(0)) handle(q);
        } catch (err) {
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }
    if (!host || initialising) {
      pending.push(m);
      return;
    }
    try {
      const r = host.render(m.job);
      const transfer: Transferable[] = [r.features.buffer as ArrayBuffer];
      if (r.audio) transfer.push(r.audio.buffer as ArrayBuffer);
      post({ type: 'result', id: m.id, features: r.features, audio: r.audio, ms: r.ms }, transfer);
    } catch (err) {
      post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
    }
  };
  return handle;
}
