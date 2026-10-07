// Node worker_threads entry of the fit pool (tests / CLI benchmarks only; not bundled).
import { parentPort } from 'node:worker_threads';
import { makeWorkerHandler } from '../workerCore.ts';
import type { ToFitWorker } from '../protocol.ts';

const handle = makeWorkerHandler((m, t) => parentPort!.postMessage(m, (t ?? []) as never));
parentPort!.on('message', (m: ToFitWorker) => handle(m));
