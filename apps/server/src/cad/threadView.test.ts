import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRINT, DEFAULT_VIEW, type Feature, type MeshStatus, type Part, type Project } from '@jarvis/core';
import { CadKernel } from './kernel.js';
import { MeshService } from '../meshes.js';

const SLOW = 600_000;

let kernel: CadKernel;

beforeAll(() => {
    kernel = CadKernel.start();
});

afterAll(async () => {
    await kernel.close();
});

// A block 20 x 20 x 20 with an 8 mm hole along -X from x = 10, threaded M10 x 1.5 for 12 mm.
const drilled: Feature[] = [{ id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] }];
const threaded: Feature[] = [...drilled, { id: 't', name: 'Thread1', op: 'thread', kind: 'internal', at: [10, 4.1, 0], diameter: 10, pitch: 1.5, length: 12 }];

function project(features: Feature[], hiddenSketches: string[] = []): Project {
    const part: Part = {
        id: 'p1', name: 'Block', shape: { kind: 'box', size: [20, 20, 20], radius: 0 }, position: [0, 0, 0], rotation: [0, 0, 0],
        material: { color: '#cccccc', metalness: 0, roughness: 0.5 }, features,
    };
    return { name: 'Thread view', parts: [part], view: { ...DEFAULT_VIEW, hiddenSketches } };
}

/** Counts of the /api/mesh3 header: positions, indices, edges, faces, edge ordinals, cosmetic, json bytes. */
const header = (buffer: Buffer): number[] => [...new Uint32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + 28))];

const faces = (step: Buffer): number => (step.toString('latin1').match(/ADVANCED_FACE\(/g) ?? []).length;

describe('a thread hidden in the view', () => {
    it('is left out of the view build and kept in the STL and STEP exports', async () => {
        const hidden = project(threaded, ['p1/t']);
        let published: (status: MeshStatus) => void = () => undefined;
        const built = new Promise<MeshStatus>((resolve) => {
            published = (status) => status.keys.p1 && resolve(status);
        });
        const meshes = new MeshService(kernel, (status) => published(status));
        meshes.update(hidden);
        const status = await built;
        expect(status.errors.p1).toBeUndefined();
        const view = meshes.get3(status.keys.p1!)!;
        const [, indices, , faceCount, , cosmetic] = header(view);
        // The plain hole: as many faces as the block drilled without a thread, and the thread marked.
        const plain = await kernel.mesh(project(drilled).parts[0], DEFAULT_PRINT);
        expect(faceCount).toBe(Math.max(...plain.triFace) + 1);
        expect(cosmetic).toBeGreaterThan(0);

        // STL: the export waits for, and uses, the part with its thread modelled.
        await meshes.ready(hidden);
        const full = meshes.meshFor(hidden.parts[0], hidden)!;
        expect(full.cosmetic).toBeUndefined();
        expect(full.indices.length).toBeGreaterThan(indices * 3);

        // STEP: the modelled thread's helical faces are there.
        const withThread = await kernel.step(hidden);
        const without = await kernel.step(project(drilled));
        expect(faces(withThread)).toBeGreaterThan(faces(without) + 8);
    }, SLOW);
});
