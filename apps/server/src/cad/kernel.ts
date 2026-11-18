// The CAD kernel as the server sees it: OpenCascade runs in a worker thread, one job at a time, with meshes
// cached by meshKey.

import { Worker } from 'node:worker_threads';
import type { Feature, Part, PrintSettings, Project } from '@jarvis/core';
import { meshKey } from './key.js';
import { qualityKey, type MeshQuality } from './meshQuality.js';
import type { CombineContext } from './context.js';
import type { WorkerRequest, WorkerResponse } from './worker.js';
import type { MassProps } from './props.js';
import type { ModelQuery, ModelSketch, PlaneFrame3 } from '@jarvis/core/projection';
import type { BodyInfo } from '@jarvis/core/visibility';
import type { FreecadExport } from '../export/freecadMacro.js';
import type { ChangeRange } from './change.js';
import { jobLabel, KernelTracker, type KernelActivity, type KernelJobLabel } from './activity.js';
import type { ImportJob, ImportJobResult } from '../import/job.js';
import type { MateEntityAnswer, ModelMatePick } from './mateEntities.js';

export { meshKey } from './key.js';
export { combineContext, type CombineContext, type CombinePart } from './context.js';
export { replicadApiNames } from './script.js';
export type { MassProps, Mat3 } from './props.js';

/** Mass properties of a part's solid: null props when it has no body; `error` when its history failed part way. */
export interface PropsResult {
    props: MassProps | null;
    error?: string;
}

export interface MeshData {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    /** Line segment pairs (x,y,z,x,y,z) of the solid's real B-rep edges, for CAD-style outlines. */
    edges: Float32Array;
    /** Per triangle: ordinal (0..F-1, in order of first appearance) of the B-rep face it belongs to. */
    triFace: Uint32Array;
    /** Per segment of `edges`: ordinal (0..E-1) of the B-rep edge it belongs to (seams excluded). */
    segEdge: Uint32Array;
    /** Reference steps whose references taken from the model were found again, as found (by step id). */
    followed?: Record<string, Feature>;
    /** What a tool form should say about the steps (a thread cut to the length of its hole). */
    notes?: string[];
    /** Per face ordinal: the body (index into `bodies`) it belongs to; faces past the end are on body 0. */
    faceBody?: Uint32Array;
    /** Per edge ordinal: the body it belongs to. */
    edgeBody?: Uint32Array;
    /** The solid bodies, in order (see cad/bodies.ts). */
    bodies?: BodyInfo[];
    /** Line segment pairs marking where cosmetic (hidden) threads run, and per segment its body. */
    cosmetic?: Float32Array;
    cosmeticBody?: Uint32Array;
}

/** A preview's mesh and what the steps of its range do, as a mesh of its own (null: nothing); see change.ts. */
export interface MeshWithChange {
    mesh: MeshData;
    change: MeshData | null;
    /** Time the kernel spent on the change beyond the build and its mesh. */
    changeMs: number;
}

/** A part whose history failed; `partial` is the solid up to the failing step, when there is one. */
export class CadBuildError extends Error {
    constructor(message: string, readonly partial?: MeshData) {
        super(message);
        this.name = 'CadBuildError';
    }
}

/** A queued mesh job nobody wanted any more by the time its turn came (see MeshOptions.stale). */
export class CadJobDropped extends Error {
    constructor() {
        super('CAD job dropped: the model changed again before it started');
        this.name = 'CadJobDropped';
    }
}

export interface MeshOptions {
    /** Asked before the job starts: true when the mesh is no longer wanted, and the job is then dropped. */
    stale?: () => boolean;
    /** A coarse mesh of the same solid, sent first when the mesh itself will take a while (see cad/interimMesh.ts). */
    interim?: (mesh: MeshData) => void;
}

export interface CadKernelOptions {
    /**
     * Per-job timeout; on expiry the worker is restarted. Default 15 minutes: a part with long modelled threads takes
     * more than a minute to build from nothing (after a server restart, when no step is cached yet), and a limit
     * below that makes it fail every time.
     */
    timeoutMs?: number;
    /** Meshes kept in memory. Default 500. */
    cacheSize?: number;
}

type JobRequest = Omit<Extract<WorkerRequest, { type: 'mesh' }>, 'id'> | Omit<Extract<WorkerRequest, { type: 'step' }>, 'id'>
    | Omit<Extract<WorkerRequest, { type: 'change' }>, 'id'>
    | Omit<Extract<WorkerRequest, { type: 'props' }>, 'id'> | Omit<Extract<WorkerRequest, { type: 'project' }>, 'id'>
    | Omit<Extract<WorkerRequest, { type: 'freecad' }>, 'id'>
    | Omit<Extract<WorkerRequest, { type: 'import' }>, 'id'>
    | Omit<Extract<WorkerRequest, { type: 'entities' }>, 'id'>;

interface Job {
    request: JobRequest;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    label: KernelJobLabel;
    /** Dropped before it starts when all of these say so; absent: always run (exports, previews, ready). */
    stale?: (() => boolean)[];
    interim?: ((mesh: MeshData) => void)[];
}

interface CacheEntry {
    promise: Promise<MeshData>;
    /** Set when the build failed: the feature names in its message, to rebuild if they are renamed. */
    failedNames?: string;
    job: Partial<Job>;
}

const featureNames = (part: Pick<Part, 'features'>): string =>
    JSON.stringify((part.features ?? []).map((f) => [f.id, f.name]));

/** Another caller of a mesh job: it keeps a queued job from being dropped unless it may be dropped too, and hears its interim mesh. */
function join(job: Partial<Job>, options: MeshOptions, queued: boolean, running: boolean): void {
    if (queued) {
        if (options.stale && job.stale) {
            job.stale.push(options.stale);
        } else {
            delete job.stale;
        }
        if (options.interim && job.request?.type === 'mesh') {
            job.request = { ...job.request, interim: true };
        }
    }
    if (options.interim && (queued || running)) {
        (job.interim ??= []).push(options.interim);
    }
}

export class CadKernel {
    /** Mutable so tests can shorten it. */
    timeoutMs: number;
    private readonly cacheSize: number;
    private readonly cache = new Map<string, CacheEntry>();
    private readonly projections = new Map<string, Promise<ModelSketch>>();
    private readonly entityCache = new Map<string, Promise<MateEntityAnswer[]>>();
    private worker: Worker | null = null;
    private ready = false;
    private closed = false;
    private readonly queue: Job[] = [];
    private current: { id: number; job: Job; timer: NodeJS.Timeout } | null = null;
    private nextId = 1;
    /** What the kernel is doing, for the busy display (activity.ts). */
    private readonly tracker = new KernelTracker(() => ({
        current: this.current && { id: this.current.id, label: this.current.job.label },
        queue: this.queue.map((job) => job.label),
    }));

    private constructor(options: CadKernelOptions) {
        this.timeoutMs = options.timeoutMs ?? (Number(process.env.JARVIS_CAD_TIMEOUT_MS) || 900_000);
        this.cacheSize = options.cacheSize ?? 500;
    }

    /** Spawns the worker; OpenCascade initialises in the background and jobs wait for it. */
    static start(options: CadKernelOptions = {}): CadKernel {
        const kernel = new CadKernel(options);
        kernel.spawn();
        return kernel;
    }

    /**
     * Mesh of a part's solid at a display quality (see meshQuality.ts). `context` supplies the parts its combine steps
     * use (see combineContext). Results are shared between callers: do not modify them. `options`: see MeshOptions.
     */
    mesh(part: Pick<Part, 'shape' | 'features'>, print: PrintSettings, context?: CombineContext, quality: MeshQuality = 'normal',
        options: MeshOptions = {}): Promise<MeshData> {
        const key = qualityKey(meshKey(part, print, context), quality);
        const names = featureNames(part);
        const hit = this.cache.get(key);
        if (hit && (hit.failedNames === undefined || hit.failedNames === names)) {
            this.cache.delete(key);
            this.cache.set(key, hit);
            join(hit.job, options, this.queue.includes(hit.job as Job), this.current?.job === hit.job);
            return hit.promise;
        }
        const job: Partial<Job> = {
            ...(options.stale ? { stale: [options.stale] } : {}),
            ...(options.interim ? { interim: [options.interim] } : {}),
        };
        const entry: CacheEntry = {
            promise: this.run({ type: 'mesh', part: { shape: part.shape, features: part.features }, print, context, quality,
                ...(options.interim ? { interim: true } : {}) }, part, job) as Promise<MeshData>,
            job,
        };
        entry.promise.catch((error: unknown) => {
            if (error instanceof CadBuildError) {
                entry.failedNames = names; // deterministic: keep it, so a broken part is not rebuilt every time
            } else if (this.cache.get(key) === entry) {
                this.cache.delete(key); // timeouts and crashes may succeed next time
            }
        });
        this.cache.set(key, entry);
        while (this.cache.size > this.cacheSize) {
            this.cache.delete(this.cache.keys().next().value as string);
        }
        return entry.promise;
    }

    /**
     * Mesh of a part as `mesh` gives it, built afresh from step `range.from` on, with the mesh of what the steps of
     * `range` do (for a tool preview). Not cached: the caller keeps the meshes.
     */
    meshWithChange(part: Pick<Part, 'shape' | 'features'>, print: PrintSettings, range: ChangeRange, context?: CombineContext,
        quality: MeshQuality = 'normal'): Promise<MeshWithChange> {
        return this.run({ type: 'change', part: { shape: part.shape, features: part.features }, print, context, quality, range }, part) as Promise<MeshWithChange>;
    }

    /** STEP (AP214) of the assembled project, Z-up like the STL export, parts named and coloured. */
    async step(project: Project): Promise<Buffer> {
        const bytes = (await this.run({ type: 'step', project })) as Uint8Array;
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    /** A FreeCAD macro that rebuilds the parts' histories (all parts when `partIds` is empty); see export/freecadMacro.ts. */
    freecadMacro(project: Project, partIds: string[] = []): Promise<FreecadExport> {
        return this.run({ type: 'freecad', project, partIds }) as Promise<FreecadExport>;
    }

    /**
     * Model geometry for a sketch on `frame` (see cad/project.ts): the part's edges projected onto the plane, picked
     * edges and face loops, a section or the silhouette. `part` holds the steps before the sketch. Cached.
     */
    project(part: Pick<Part, 'shape' | 'features'>, print: PrintSettings, frame: PlaneFrame3, query: ModelQuery, context?: CombineContext): Promise<ModelSketch> {
        const key = `${meshKey(part, print, context)} ${JSON.stringify(frame)} ${JSON.stringify(query)}`;
        const hit = this.projections.get(key);
        if (hit) {
            this.projections.delete(key);
            this.projections.set(key, hit);
            return hit;
        }
        const promise = this.run({ type: 'project', part: { shape: part.shape, features: part.features }, print, context, frame, query }, part) as Promise<ModelSketch>;
        promise.catch(() => this.projections.delete(key));
        this.projections.set(key, promise);
        while (this.projections.size > 200) {
            this.projections.delete(this.projections.keys().next().value as string);
        }
        return promise;
    }

    /** Volume, area, centre of mass and inertia (unit density) of a part's solid. Not cached. */
    properties(part: Pick<Part, 'shape' | 'features'>, print: PrintSettings, context?: CombineContext): Promise<PropsResult> {
        return this.run({ type: 'props', part: { shape: part.shape, features: part.features }, print, context }, part) as Promise<PropsResult>;
    }

    /**
     * The geometry of faces, edges and vertices picked for mates on a part's body (mateEntities.ts), each found again as
     * feature picks are. Cached by the part's mesh key and the picks.
     */
    entities(part: Pick<Part, 'shape' | 'features'>, print: PrintSettings, picks: ModelMatePick[], context?: CombineContext): Promise<MateEntityAnswer[]> {
        const key = `entities ${meshKey(part, print, context)} ${JSON.stringify(picks)}`;
        const hit = this.entityCache.get(key);
        if (hit) {
            return hit;
        }
        const promise = this.run({ type: 'entities', part: { shape: part.shape, features: part.features }, print, context, picks }, part) as Promise<MateEntityAnswer[]>;
        promise.catch(() => this.entityCache.delete(key));
        this.entityCache.set(key, promise);
        while (this.entityCache.size > 500) {
            this.entityCache.delete(this.entityCache.keys().next().value as string);
        }
        return promise;
    }

    /** Reads a CAD file (STEP, STL...) and stores its bodies as assets, in the worker; see import/job.ts. */
    importFile(job: ImportJob): Promise<ImportJobResult> {
        return this.run({ type: 'import', job }) as Promise<ImportJobResult>;
    }

    async close(): Promise<void> {
        this.closed = true;
        const error = new Error('CAD kernel closed');
        if (this.current) {
            clearTimeout(this.current.timer);
            this.current.job.reject(error);
            this.current = null;
        }
        for (const job of this.queue.splice(0)) {
            job.reject(error);
        }
        const worker = this.worker;
        this.worker = null;
        await worker?.terminate();
    }

    /** What the kernel is doing now: the job running and how far it is, and the jobs waiting (see activity.ts). */
    activity(): KernelActivity {
        return this.tracker.activity();
    }

    /** Calls `listener` whenever the activity changes; returns the unsubscribe. */
    onActivity(listener: (activity: KernelActivity) => void): () => void {
        return this.tracker.subscribe(listener);
    }

    /** `part` is what the caller asked about (a whole Part when it had one), to name the job; `extra`: the job's stale and
     * interim hooks. */
    private run(request: JobRequest, part?: object, extra: Partial<Job> = {}): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new Error('CAD kernel closed'));
        }
        return new Promise((resolve, reject) => {
            this.queue.push(Object.assign(extra, { request, resolve, reject, label: jobLabel(request, part) }));
            if (!this.worker) {
                this.spawn();
            }
            this.pump();
            this.tracker.changed();
        });
    }

    private spawn(): void {
        // In dev and tests the kernel runs as TypeScript under tsx; the worker registers the same loader (workerDev.mjs).
        const typescript = import.meta.url.endsWith('.ts');
        const progress = this.tracker.mailbox.buffer;
        const worker = typescript
            ? new Worker(new URL('./workerDev.mjs', import.meta.url), { workerData: { progress, entry: new URL('./worker.ts', import.meta.url).href } })
            : new Worker(new URL('./worker.js', import.meta.url), { workerData: { progress } });
        this.worker = worker;
        this.ready = false;
        worker.on('message', (message: WorkerResponse) => this.onMessage(worker, message));
        worker.on('error', (error: unknown) => this.onCrash(worker, `CAD worker crashed: ${error instanceof Error ? error.message : String(error)}`));
        worker.on('exit', (code) => this.onCrash(worker, `CAD worker exited (code ${code})`));
    }

    private onMessage(worker: Worker, message: WorkerResponse): void {
        if (worker !== this.worker) {
            return;
        }
        if ('type' in message) {
            if (message.type === 'progress') {
                this.tracker.progress(message.progress);
                return;
            }
            if (message.type === 'ready') {
                this.ready = true;
                this.pump();
            } else {
                this.failAll(new Error(`CAD kernel could not start: ${message.error}`));
                this.stopWorker();
            }
            return;
        }
        const current = this.current;
        if (!current || current.id !== message.id) {
            return;
        }
        if ('interim' in message) {
            for (const listener of current.job.interim ?? []) {
                try {
                    listener(message.interim);
                } catch {
                    // A listener's trouble is its own; the job goes on.
                }
            }
            return;
        }
        clearTimeout(current.timer);
        this.current = null;
        if (message.ok) {
            current.job.resolve('change' in message ? { mesh: message.mesh, change: message.change, changeMs: message.changeMs }
                : 'mesh' in message ? message.mesh : 'props' in message ? message.props : 'model' in message ? message.model
                : 'freecad' in message ? message.freecad : 'imported' in message ? message.imported
                    : 'entities' in message ? message.entities : message.step);
        } else {
            current.job.reject(new CadBuildError(message.error, message.partial));
        }
        this.tracker.finished(current.id, message.ok);
        this.pump();
    }

    private onCrash(worker: Worker, reason: string): void {
        if (worker !== this.worker || this.closed) {
            return;
        }
        const starting = !this.ready;
        console.warn(`[cad] ${reason}${starting ? ' (while starting)' : ''}`);
        this.worker = null;
        this.ready = false;
        if (this.current) {
            clearTimeout(this.current.timer);
            this.current.job.reject(new Error(reason));
            this.current = null;
        }
        if (starting) {
            // A worker that dies before it is ready would die again: the jobs waiting fail with the reason rather than
            // workers being started in a loop. The next job asked for starts a new one.
            this.failAll(new Error(reason));
        } else if (this.queue.length) {
            this.spawn();
        }
    }

    private failAll(error: Error): void {
        if (this.current) {
            clearTimeout(this.current.timer);
            this.current.job.reject(error);
            this.current = null;
        }
        for (const job of this.queue.splice(0)) {
            job.reject(error);
        }
        this.tracker.changed();
    }

    private stopWorker(): void {
        const worker = this.worker;
        this.worker = null;
        this.ready = false;
        void worker?.terminate();
    }

    private pump(): void {
        if (!this.worker || !this.ready || this.current) {
            return;
        }
        // A build for a state of the model that has been edited again since it was asked for is dropped, not run.
        let dropped = false;
        while (this.queue[0]?.stale?.length && this.queue[0].stale.every((stale) => stale())) {
            this.queue.shift()!.reject(new CadJobDropped());
            dropped = true;
        }
        if (this.queue.length === 0) {
            if (dropped) {
                this.tracker.changed();
            }
            return;
        }
        const job = this.queue.shift()!;
        const id = this.nextId++;
        const timeout = this.timeoutMs;
        const timer = setTimeout(() => {
            if (this.current?.id !== id) {
                return;
            }
            this.current = null;
            job.reject(new Error(`CAD job (${job.request.type}) timed out after ${(timeout / 1000).toFixed(1)} s; `
                + 'the CAD worker was restarted'));
            this.stopWorker();
            if (this.queue.length) {
                this.spawn();
            }
        }, timeout);
        this.current = { id, job, timer };
        this.worker.postMessage({ ...job.request, id } as WorkerRequest);
        this.tracker.changed();
    }
}
