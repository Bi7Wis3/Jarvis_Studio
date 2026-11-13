// worker_threads entry for the CAD kernel: loads OpenCascade once, then serves one job at a time.

import { parentPort } from 'node:worker_threads';
import { exportSTEP, type Shape3D } from 'replicad';
import { DEFAULT_PRINT, effectivePart, type Part, type PrintSettings, type Project } from '@jarvis/core';
import { combineContext, type CombineContext } from './context.js';
import { buildPartial, initOC, meshSolid, place, repeatCopies, errorMessage, type PartSpec } from './build.js';
import { meshKey } from './key.js';
import type { MeshData, PropsResult } from './kernel.js';
import { massProperties } from './props.js';

export type WorkerRequest =
    | { id: number; type: 'mesh'; part: PartSpec; print: PrintSettings; context?: CombineContext }
    | { id: number; type: 'step'; project: Project }
    | { id: number; type: 'props'; part: PartSpec; print: PrintSettings; context?: CombineContext };

export type WorkerResponse =
    | { type: 'ready' }
    | { type: 'fatal'; error: string }
    | { id: number; ok: true; mesh: MeshData }
    | { id: number; ok: true; step: Uint8Array }
    | { id: number; ok: true; props: PropsResult }
    | { id: number; ok: false; error: string; partial?: MeshData };

const port = parentPort;
if (!port) {
    throw new Error('cad/worker.ts must run in a worker thread');
}

interface Built {
    shape: Shape3D | null;
    error: string | null;
}

// Recently built solids, so a STEP export after meshing does not rebuild everything.
const SHAPE_CACHE_SIZE = 64;
const shapes = new Map<string, Built>();

function build(part: PartSpec, print: PrintSettings, context?: CombineContext): Built {
    const key = meshKey(part, print, context);
    const cached = shapes.get(key);
    if (cached && !cached.error) {
        shapes.delete(key);
        shapes.set(key, cached);
        return cached;
    }
    const built = buildPartial(part, print, context);
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
    try {
        if (request.type === 'mesh') {
            const built = build(request.part, request.print, request.context);
            if (built.error) {
                const partial = built.shape ? meshSolid(built.shape) : undefined;
                const response: WorkerResponse = { id: request.id, ok: false, error: built.error, partial };
                port!.postMessage(response, partial ? meshTransfer(partial) : []);
                return;
            }
            // A part with no body yet (an empty shape with only sketches) meshes as nothing.
            const mesh = built.shape ? meshSolid(built.shape) : emptyMesh();
            port!.postMessage({ id: request.id, ok: true, mesh } satisfies WorkerResponse, meshTransfer(mesh));
        } else if (request.type === 'props') {
            // A failed history still reports the solid as far as it built, with the error alongside.
            const built = build(request.part, request.print, request.context);
            const props: PropsResult = {
                props: built.shape ? massProperties(built.shape) : null,
                ...(built.error ? { error: built.error } : {}),
            };
            port!.postMessage({ id: request.id, ok: true, props } satisfies WorkerResponse);
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
