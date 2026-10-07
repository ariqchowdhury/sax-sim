// Browser Web Worker of the fit pool (module worker): see pool.ts.
import { makeWorkerHandler } from './workerCore.ts';
import type { FromFitWorker, ToFitWorker } from './protocol.ts';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<ToFitWorker>) => void) | null; postMessage(m: FromFitWorker, t?: Transferable[]): void };
const handle = makeWorkerHandler((m, t) => ctx.postMessage(m, t ?? []));
ctx.onmessage = (e) => handle(e.data);
