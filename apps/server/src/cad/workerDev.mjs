// In dev the kernel runs as TypeScript under tsx. A worker thread does not reliably inherit tsx's loader (Node 20 drops
// `--import tsx` in a worker's execArgv), so the worker registers it itself, then loads the real worker (kernel.ts spawn).
import { register } from 'tsx/esm/api';
import { workerData } from 'node:worker_threads';

register();
await import(workerData.entry);
