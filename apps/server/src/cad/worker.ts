// worker_threads entry for the CAD kernel: loads OpenCascade once, then serves one job at a time.

import { parentPort } from 'node:worker_threads';
import { exportSTEP, type Shape3D } from 'replicad';
import { DEFAULT_PRINT, effectivePart, type Feature, type Part, type PrintSettings, type Project } from '@jarvis/core';
import { combineContext, type CombineContext } from './context.js';
import { buildPartial, initOC, meshSolid, place, repeatCopies, errorMessage, type PartSpec } from './build.js';
import { meshKey } from './key.js';
import type { MeshQuality } from './meshQuality.js';
import type { MeshData, PropsResult } from './kernel.js';
import { massProperties } from './props.js';
import { modelSketch } from './project.js';
import { ChangeWatch, type ChangeRange } from './change.js';
import type { ModelQuery, ModelSketch, PlaneFrame3 } from '@jarvis/core/projection';
import { freecadMacro, type FreecadExport } from '../export/freecadMacro.js';
import type { BodyRecord } from './bodies.js';
import { startProgress, type WorkerProgress } from './progress.js';

export type WorkerRequest =
    | { id: number; type: 'mesh'; part: PartSpec; print: PrintSettings; context?: CombineContext; quality?: MeshQuality }
    /** A preview's mesh with, alongside, what the steps of `range` do (see change.ts). */
    | { id: number; type: 'change'; part: PartSpec; print: PrintSettings; context?: CombineContext; quality?: MeshQuality; range: ChangeRange }
    | { id: number; type: 'step'; project: Project }
    | { id: number; type: 'props'; part: PartSpec; print: PrintSettings; context?: CombineContext }
    | { id: number; type: 'project'; part: PartSpec; print: PrintSettings; context?: CombineContext; frame: PlaneFrame3; query: ModelQuery }
    | { id: number; type: 'freecad'; project: Project; partIds: string[] };

export type WorkerResponse =
    | { type: 'ready' }
    | { type: 'fatal'; error: string }
    /** How far the job is (progress.ts). */
    | { type: 'progress'; progress: WorkerProgress }
    | { id: number; ok: true; mesh: MeshData; change: MeshData | null; changeMs: number }
    | { id: number; ok: true; mesh: MeshData }
    | { id: number; ok: true; step: Uint8Array }
    | { id: number; ok: true; props: PropsResult }
    | { id: number; ok: true; model: ModelSketch }
    | { id: number; ok: true; freecad: FreecadExport }
    | { id: number; ok: false; error: string; partial?: MeshData };

const port = parentPort;
if (!port) {
    throw new Error('cad/worker.ts must run in a worker thread');
}
const progress = startProgress(port);

interface Built {
    shape: Shape3D | null;
    error: string | null;
    followed?: Record<string, Feature>;
    notes?: string[];
    bodies?: BodyRecord[];
}

// Recently built solids, so a STEP export after meshing does not rebuild everything.
const SHAPE_CACHE_SIZE = 64;
const shapes = new Map<string, Built>();

function build(part: PartSpec, print: PrintSettings, context?: CombineContext, watch?: ChangeWatch): Built {
    const key = meshKey(part, print, context);
    const cached = shapes.get(key);
    if (cached && !cached.error && !watch) {
        shapes.delete(key);
        shapes.set(key, cached);
        return cached;
    }
    let built: Built;
    try {
        built = buildPartial(part, print, context, undefined, watch);
    } finally {
        watch?.finish();
    }
    shapes.delete(key);
    shapes.set(key, built);
    while (shapes.size > SHAPE_CACHE_SIZE) {
        const oldest = shapes.keys().next().value as string;
        shapes.get(oldest)?.shape?.delete();
        shapes.delete(oldest);
    }
    return built;
}

function meshTransfer(mesh: MeshData): ArrayBuffer[] {
    return [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.edges.buffer, mesh.triFace.buffer, mesh.segEdge.buffer] as ArrayBuffer[];
}

function emptyMesh(): MeshData {
    return {
        positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), edges: new Float32Array(0),
        triFace: new Uint32Array(0), segEdge: new Uint32Array(0),
    };
}

function instanceName(part: Part, index: number, count: number): string {
    return count > 1 ? `${part.name} ${index + 1}` : part.name;
}

async function step(project: Project): Promise<Uint8Array> {
    const print = project.print ?? DEFAULT_PRINT;
    const configs: { shape: Shape3D; name: string; color: string }[] = [];
    for (const part of project.parts) {
        progress.part(part.id, part.name);
        // Instances build their source's design; combine steps need the other parts.
        const { shape } = build(effectivePart(part, project.parts), print, combineContext(part, project.parts));
        if (!shape) {
            continue;
        }
        // Local placement, then the repeat copies, then Y-up to Z-up like the STL export.
        const copies = repeatCopies(place(shape.clone(), part.position, part.rotation), part.repeat);
        copies.forEach((copy, i) => {
            configs.push({
                shape: copy.rotate(90, [0, 0, 0], [1, 0, 0]),
                name: instanceName(part, i, copies.length),
                color: /^#[0-9a-f]{6}$/i.test(part.material.color) ? part.material.color : '#cccccc',
            });
        });
    }
    if (configs.length === 0) {
        throw new Error('Nothing to export: no part could be built');
    }
    const blob = exportSTEP(configs, { unit: 'MM', modelUnit: 'MM' });
    for (const config of configs) {
        config.shape.delete();
    }
    return new Uint8Array(await blob.arrayBuffer());
}

async function handle(request: WorkerRequest): Promise<void> {
    progress.begin(request.id);
    try {
        if (request.type === 'mesh' || request.type === 'change') {
            // A preview also gets the mesh of what the steps of its range do.
            const watch = request.type === 'change' ? new ChangeWatch(request.range) : undefined;
            const built = build(request.part, request.print, request.context, watch);
            progress.meshing();
            // Where its reference steps found the model, for the view to draw them there.
            const extra = {
                ...(built.followed && Object.keys(built.followed).length ? { followed: built.followed } : {}),
                // The solid bodies, for the Solid Bodies folder of the tree.
                ...(built.bodies ? { bodies: built.bodies } : {}),
                // What the build says about its steps, for an open tool form (a thread cut to its hole's length).
                ...(built.notes?.length ? { notes: built.notes } : {}),
            };
            if (built.error) {
                watch?.discard();
                const partial = built.shape ? { ...meshSolid(built.shape, request.quality), ...extra } : undefined;
                const response: WorkerResponse = { id: request.id, ok: false, error: built.error, partial };
                port!.postMessage(response, partial ? meshTransfer(partial) : []);
                return;
            }
            // A part with no body yet (an empty shape with only sketches) meshes as nothing.
            const mesh = { ...(built.shape ? meshSolid(built.shape, request.quality) : emptyMesh()), ...extra };
            if (watch) {
                const change = watch.mesh(built.shape, mesh, request.quality);
                port!.postMessage({ id: request.id, ok: true, mesh, change, changeMs: watch.ms } satisfies WorkerResponse,
                    [...meshTransfer(mesh), ...(change ? meshTransfer(change) : [])]);
                return;
            }
            port!.postMessage({ id: request.id, ok: true, mesh } satisfies WorkerResponse, meshTransfer(mesh));
        } else if (request.type === 'props') {
            // A failed history still reports the solid as far as it built, with the error alongside.
            const built = build(request.part, request.print, request.context);
            const props: PropsResult = {
                props: built.shape ? massProperties(built.shape) : null,
                ...(built.error ? { error: built.error } : {}),
            };
            port!.postMessage({ id: request.id, ok: true, props } satisfies WorkerResponse);
        } else if (request.type === 'project') {
            // The body as far as it builds: a sketch sees the model as it is before its own step.
            const built = build(request.part, request.print, request.context);
            const model = modelSketch(built.shape, request.frame, request.query);
            port!.postMessage({ id: request.id, ok: true, model } satisfies WorkerResponse);
        } else if (request.type === 'freecad') {
            port!.postMessage({ id: request.id, ok: true, freecad: freecadMacro(request.project, request.partIds) } satisfies WorkerResponse);
        } else {
            const bytes = await step(request.project);
            port!.postMessage({ id: request.id, ok: true, step: bytes } satisfies WorkerResponse,
                [bytes.buffer as ArrayBuffer]);
        }
    } catch (e) {
        port!.postMessage({ id: request.id, ok: false, error: errorMessage(e) } satisfies WorkerResponse);
    }
}

// Jobs arrive one at a time from the kernel, but keep them strictly sequential anyway.
let queue = Promise.resolve();
port.on('message', (request: WorkerRequest) => {
    queue = queue.then(() => handle(request));
});

initOC().then(
    () => port.postMessage({ type: 'ready' } satisfies WorkerResponse),
    (e) => port.postMessage({ type: 'fatal', error: errorMessage(e) } satisfies WorkerResponse),
);
