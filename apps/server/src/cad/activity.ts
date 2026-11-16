// What the CAD kernel is doing, kept by CadKernel for the busy display: the job running with the worker's latest
// report (progress.ts), the jobs waiting, and how the last one ended. cadActivity.ts in the server turns it into the
// CadActivity browsers get.

import type { CadPhase, CadStep } from '@jarvis/core/cadActivity';
import { meshKey } from './key.js';
import { qualityKey } from './meshQuality.js';
import { PROGRESS_INTERVAL_MS, ProgressMailbox, type WorkerProgress } from './progress.js';
import type { WorkerRequest } from './worker.js';

/** mesh: a part's mesh (for the view, an export or a preview without steps of its own); preview: a tool's preview. */
export type KernelJobKind = 'mesh' | 'preview' | 'export' | 'props' | 'query' | 'import';

export interface KernelJobLabel {
    kind: KernelJobKind;
    partId?: string;
    partName?: string;
    /** The mesh key the job makes (mesh and preview jobs), to tell whose shown mesh it is. */
    key?: string;
}

export interface KernelJob extends KernelJobLabel {
    id: number;
    startedAt: number;
    phase: CadPhase;
    step?: CadStep;
}

export interface KernelJobEnd extends KernelJobLabel {
    id: number;
    ok: boolean;
    endedAt: number;
    ms: number;
}

export interface KernelActivity {
    job: KernelJob | null;
    queue: KernelJobLabel[];
    last: KernelJobEnd | null;
}

type JobRequest = WorkerRequest extends infer R ? R extends WorkerRequest ? Omit<R, 'id'> : never : never;

const KIND: Record<WorkerRequest['type'], KernelJobKind> = {
    mesh: 'mesh', change: 'preview', step: 'export', freecad: 'export', props: 'props', project: 'query', import: 'import',
};

/** What a job is, from its request and the part it was asked for (a whole Part when the caller had one). */
export function jobLabel(request: JobRequest, part?: object): KernelJobLabel {
    const named = part as { id?: unknown; name?: unknown } | undefined;
    return {
        kind: KIND[request.type],
        ...(typeof named?.id === 'string' ? { partId: named.id } : {}),
        ...(typeof named?.name === 'string' ? { partName: named.name } : {}),
        ...(request.type === 'mesh' || request.type === 'change'
            ? { key: qualityKey(meshKey(request.part, request.print, request.context), request.quality ?? 'normal') }
            : {}),
    };
}

/** The kernel's job running and its queue, as the tracker reads them. */
export interface KernelJobs {
    current: { id: number; label: KernelJobLabel } | null;
    queue: KernelJobLabel[];
}

export class KernelTracker {
    /** Shared with the worker (passed as workerData.progress). */
    readonly mailbox = new ProgressMailbox();
    private readonly listeners = new Set<(activity: KernelActivity) => void>();
    private job: KernelJob | null = null;
    /** The newest report taken for the job running. */
    private seen = 0;
    private queue: KernelJobLabel[] = [];
    private last: KernelJobEnd | null = null;
    /** The state listeners last heard, as JSON. */
    private told = JSON.stringify({ job: null, queue: [], last: null });
    private timer: NodeJS.Timeout | null = null;
    private pending = false;

    constructor(
        private readonly read: () => KernelJobs,
        private readonly now: () => number = Date.now,
        private readonly pollMs = PROGRESS_INTERVAL_MS,
    ) {}

    activity(): KernelActivity {
        this.sync();
        const activity = this.state();
        if (JSON.stringify(activity) !== this.told) {
            this.changed();
        }
        return activity;
    }

    subscribe(listener: (activity: KernelActivity) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** A report the worker posted. */
    progress(report: WorkerProgress): void {
        this.sync();
        this.take(report);
        this.changed();
    }

    /** Job `id` returned its result (`ok` false: its build failed). */
    finished(id: number, ok: boolean): void {
        if (this.job?.id === id) {
            this.end(ok);
        }
        this.changed();
    }

    /** The queue or the job running may have changed: listeners hear about it once per turn of the event loop. */
    changed(): void {
        if (!this.pending) {
            this.pending = true;
            queueMicrotask(() => {
                this.pending = false;
                this.emit();
            });
        }
    }

    private emit(): void {
        this.sync();
        // While a job runs the mailbox is read every poll, as the worker cannot post in the middle of a long step.
        if (this.job && !this.timer) {
            this.timer = setInterval(() => this.emit(), this.pollMs);
            this.timer.unref();
        } else if (!this.job && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        const activity = this.state();
        const json = JSON.stringify(activity);
        if (json !== this.told) {
            this.told = json;
            for (const listener of this.listeners) {
                listener(activity);
            }
        }
    }

    private state(): KernelActivity {
        return { job: this.job && { ...this.job }, queue: [...this.queue], last: this.last };
    }

    /** Brings the state level with the kernel's job and queue, and with the mailbox. */
    private sync(): void {
        const { current, queue } = this.read();
        this.queue = queue;
        if (this.job && this.job.id !== current?.id) {
            this.end(false); // gone without a result: the worker crashed, timed out or was closed
        }
        if (current && !this.job) {
            this.job = { ...current.label, id: current.id, startedAt: this.now(), phase: 'building' };
            this.seen = 0;
        }
        const latest = this.mailbox.read();
        if (latest) {
            this.take(latest);
        }
    }

    private take(report: WorkerProgress): void {
        if (!this.job || report.id !== this.job.id || report.n <= this.seen) {
            return;
        }
        this.seen = report.n;
        const { step: _step, ...job } = this.job;
        this.job = {
            ...job,
            phase: report.phase,
            ...(report.part ? { partId: report.part.id, partName: report.part.name } : {}),
            ...(report.step ? { step: report.step } : {}),
        };
    }

    private end(ok: boolean): void {
        const { step: _step, phase: _phase, startedAt, ...label } = this.job!;
        const endedAt = this.now();
        this.last = { ...label, ok, endedAt, ms: endedAt - startedAt };
        this.job = null;
    }
}
