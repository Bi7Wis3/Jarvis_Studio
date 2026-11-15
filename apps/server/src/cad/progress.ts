// How far the CAD worker is with its job, for the busy display: the step it is on and whether it is meshing.
//
// The worker posts progress to the main thread, throttled, and also keeps the latest in a small shared buffer. A step
// runs synchronously inside OpenCascade (a modelled thread takes over a minute), so the worker cannot post anything
// until it ends: a step entered just after a post would otherwise show as the step before it for the whole time. The
// kernel reads the buffer while a job runs (activity.ts) and so always knows the step being built.

import { workerData, type MessagePort } from 'node:worker_threads';
import type { CadPhase, CadStep } from '@jarvis/core/cadActivity';
import { progressTap } from './progressTap.js';

/** What the worker says about the job with id `id`; `n` counts up within a job, so a newer report wins. */
export interface WorkerProgress {
    id: number;
    n: number;
    phase: CadPhase;
    step?: CadStep;
    /** The part being built, when the job builds several (a STEP export of the project). */
    part?: { id: string; name: string };
}

/** At most about four posts a second; the first report of a job and the start of meshing are always sent at once. */
export const PROGRESS_INTERVAL_MS = 250;

/** Room for one report as JSON; a report that does not fit is not written. */
const MAILBOX_BYTES = 8192;

/** The latest report, shared between the worker and the main thread (a sequence lock around JSON bytes). */
export class ProgressMailbox {
    private readonly head: Int32Array;
    private readonly body: Uint8Array;

    constructor(readonly buffer: SharedArrayBuffer = new SharedArrayBuffer(8 + MAILBOX_BYTES)) {
        this.head = new Int32Array(buffer, 0, 2);
        this.body = new Uint8Array(buffer, 8);
    }

    write(report: WorkerProgress): void {
        const bytes = new TextEncoder().encode(JSON.stringify(report));
        if (bytes.length > this.body.length) {
            return;
        }
        Atomics.add(this.head, 0, 1); // odd: being written
        this.body.set(bytes);
        Atomics.store(this.head, 1, bytes.length);
        Atomics.add(this.head, 0, 1);
    }

    /** The latest report, or null when there is none or it is being written just now. */
    read(): WorkerProgress | null {
        const before = Atomics.load(this.head, 0);
        if (before === 0 || before % 2 === 1) {
            return null;
        }
        const length = Atomics.load(this.head, 1);
        const bytes = this.body.slice(0, length);
        if (Atomics.load(this.head, 0) !== before) {
            return null;
        }
        try {
            return JSON.parse(new TextDecoder().decode(bytes)) as WorkerProgress;
        } catch {
            return null;
        }
    }
}

/** Keeps the state of the job running in the worker and reports it: posted throttled, written to the mailbox always. */
export class ProgressReporter {
    private job: number | null = null;
    private n = 0;
    private state: Omit<WorkerProgress, 'id' | 'n'> = { phase: 'building' };
    private posted = -Infinity;

    constructor(
        private readonly post: (report: WorkerProgress) => void,
        private readonly mailbox: ProgressMailbox | null = null,
        private readonly now: () => number = Date.now,
        private readonly interval = PROGRESS_INTERVAL_MS,
    ) {}

    begin(id: number): void {
        this.job = id;
        this.n = 0;
        this.state = { phase: 'building' };
        this.report(true);
    }

    /** A step of the build (see progressTap.ts): steps taken from the cache and builds of combined parts are left out. */
    step(index: number, step: { id: string; name?: string; op: string }, start: number, total: number, depth: number): void {
        if (this.job === null || depth > 1 || index < start) {
            return;
        }
        this.state = {
            ...this.state,
            phase: 'building',
            step: { index, id: step.id, name: step.name ?? step.id, op: step.op, ordinal: index - start + 1, count: total - start },
        };
        this.report(false);
    }

    /** The next part of a job that builds several. */
    part(id: string, name: string): void {
        if (this.job !== null) {
            this.state = { phase: 'building', part: { id, name } };
            this.report(false);
        }
    }

    meshing(): void {
        if (this.job !== null && this.state.phase !== 'meshing') {
            this.state = { ...this.state, phase: 'meshing' };
            this.report(true);
        }
    }

    private report(now: boolean): void {
        const report: WorkerProgress = { id: this.job!, n: ++this.n, ...this.state };
        this.mailbox?.write(report);
        const t = this.now();
        if (now || t - this.posted >= this.interval) {
            this.posted = t;
            this.post(report);
        }
    }
}

/**
 * Starts reporting from the worker thread, into the mailbox the kernel passed as `workerData.progress`: builds tell the
 * reporter their steps through progressTap.
 */
export function startProgress(port: MessagePort): ProgressReporter {
    const buffer: unknown = (workerData as { progress?: unknown } | null)?.progress;
    const mailbox = buffer instanceof SharedArrayBuffer ? new ProgressMailbox(buffer) : null;
    const reporter = new ProgressReporter((progress) => port.postMessage({ type: 'progress', progress }), mailbox);
    progressTap.on = (index, step, start, total, depth) => reporter.step(index, step, start, total, depth);
    return reporter;
}
