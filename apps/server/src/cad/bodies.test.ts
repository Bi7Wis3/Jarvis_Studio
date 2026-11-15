import { beforeAll, describe, expect, it } from 'vitest';
import { measureVolume } from 'replicad';
import { DEFAULT_PRINT, type Feature, type Vec3 } from '@jarvis/core';
import { viewPart } from '@jarvis/core/visibility';
import { buildPartial, initOC, meshSolid } from './build.js';
import type { MeshData } from './kernel.js';

const SLOW = 300_000;

beforeAll(async () => {
    await initOC();
}, SLOW);

const cube = (size: number) => ({ kind: 'box' as const, size: [size, size, size] as Vec3, radius: 0 });

/** Bounding box of the triangles of one body of a mesh. */
function bodyBox(mesh: MeshData, body: number): { min: Vec3; max: Vec3 } | null {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (let t = 0; t < mesh.triFace.length; t++) {
        if ((mesh.faceBody![mesh.triFace[t]] ?? 0) !== body) {
            continue;
        }
        any = true;
        for (let c = 0; c < 3; c++) {
            const v = mesh.indices[t * 3 + c] * 3;
            for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k], mesh.positions[v + k]);
                max[k] = Math.max(max[k], mesh.positions[v + k]);
            }
        }
    }
    return any ? { min, max } : null;
}

describe('solid bodies', () => {
    // A 10 mm cube at the origin and a second one 30 mm along X, apart from it.
    const two: Feature[] = [{ id: 'b2', name: 'Boss2', op: 'add', shape: cube(10), position: [30, 0, 0] }];

    it('reports each solid as a body of its own, with its faces and edges', () => {
        const built = buildPartial({ shape: cube(10), features: two }, DEFAULT_PRINT);
        expect(built.error).toBeNull();
        expect(built.bodies).toEqual([{ key: 'base', by: '' }, { key: 'b2', by: 'b2' }]);
        const mesh = meshSolid(built.shape!);
        expect(mesh.faceBody).toHaveLength(12);
        expect([...mesh.faceBody!].filter((b) => b === 0)).toHaveLength(6);
        expect([...mesh.edgeBody!].filter((b) => b === 1)).toHaveLength(12);
        // Body 0 is the cube at the origin, body 1 the one at x = 30.
        expect(bodyBox(mesh, 0)!.max[0]).toBeCloseTo(5, 3);
        expect(bodyBox(mesh, 1)!.min[0]).toBeCloseTo(25, 3);
    }, SLOW);

    it('keeps a body a later step leaves alone, and names a changed one after the step', () => {
        const features: Feature[] = [
            ...two,
            // A hole through the second cube only.
            { id: 'h', name: 'Hole1', op: 'hole', spec: { kind: 'plain', diameter: 3 }, position: [30, 5, 0] },
        ];
        const built = buildPartial({ shape: cube(10), features }, DEFAULT_PRINT);
        expect(built.error).toBeNull();
        expect(built.bodies).toEqual([{ key: 'base', by: '' }, { key: 'b2', by: 'h' }]);
    }, SLOW);

    it('names a single body after the last step that changed it, under one key', () => {
        const features: Feature[] = [
            { id: 'c', name: 'Cut1', op: 'cut', shape: cube(4), position: [5, 5, 5] },
            { id: 'p', name: 'Plane1', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 3 } },
        ];
        const built = buildPartial({ shape: cube(10), features }, DEFAULT_PRINT);
        expect(built.error).toBeNull();
        // The plane changes nothing: the body is still named after the cut.
        expect(built.bodies).toEqual([{ key: 'base', by: 'c' }]);
    }, SLOW);

    it('numbers the bodies one step splits, keeping the key on the larger overlap', () => {
        // A slab 30 long cut through its middle: two bodies, both named after the cut.
        const features: Feature[] = [{ id: 'k', name: 'Cut2', op: 'cut', shape: { kind: 'box', size: [2, 20, 20], radius: 0 } }];
        const built = buildPartial({ shape: { kind: 'box', size: [30, 10, 10], radius: 0 }, features }, DEFAULT_PRINT);
        expect(built.error).toBeNull();
        expect(built.bodies).toHaveLength(2);
        expect(built.bodies!.map((b) => [b.by, b.n])).toEqual([['k', 1], ['k', 2]]);
        expect(new Set(built.bodies!.map((b) => b.key)).size).toBe(2);
        expect(built.bodies!.some((b) => b.key === 'base')).toBe(true);
    }, SLOW);
});

describe('a thread hidden in the view', () => {
    // A block 20 x 20 x 20 with an 8 mm hole along -X from x = 10, threaded M10 x 1.5 for 12 mm.
    const drilled: Feature[] = [{ id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] }];
    const threaded: Feature[] = [...drilled, { id: 't', name: 'Thread1', op: 'thread', kind: 'internal', at: [10, 4.1, 0], diameter: 10, pitch: 1.5, length: 12 }];
    const block = { shape: cube(20) };

    it('builds the hole plain, marks the thread at its major diameter and names the body after it', () => {
        const view = viewPart({ ...block, features: threaded }, 'p1', { hiddenSketches: ['p1/t'] });
        expect(view.features!.find((f) => f.id === 't')).toMatchObject({ cosmetic: true });
        const plain = buildPartial({ ...block, features: drilled }, DEFAULT_PRINT);
        const shown = buildPartial(view, DEFAULT_PRINT);
        expect(shown.error).toBeNull();
        expect(Math.abs(measureVolume(shown.shape!) - measureVolume(plain.shape!))).toBeLessThan(1e-6);
        expect(shown.bodies).toEqual([{ key: 'base', by: 't' }]);
        const mesh = meshSolid(shown.shape!);
        expect(mesh.triFace.length).toBe(meshSolid(plain.shape!).triFace.length);
        // One helix on the hole's own surface (lifted 0.02 mm into the hole) from its mouth (x = 10) for the 12 mm
        // of the thread, a turn per 1.5 mm, all of it one line.
        const lines = mesh.cosmetic!;
        expect(lines.length).toBeGreaterThan(0);
        expect(mesh.cosmeticBody).toHaveLength(lines.length / 6);
        const radius = (8 + DEFAULT_PRINT.holeTolerance) / 2 - 0.02;
        for (let i = 0; i < lines.length; i += 3) {
            expect(Math.hypot(lines[i + 1], lines[i + 2])).toBeCloseTo(radius, 4);
        }
        const xs = [...lines].filter((_, i) => i % 3 === 0);
        expect(Math.max(...xs)).toBeCloseTo(10, 6);
        expect(Math.min(...xs)).toBeCloseTo(-2, 6);
        for (let i = 6; i < lines.length; i += 6) {
            expect(Math.hypot(lines[i] - lines[i - 3], lines[i + 1] - lines[i - 2], lines[i + 2] - lines[i - 1])).toBeLessThan(1e-6);
        }
        let turned = 0;
        for (let i = 0; i < lines.length; i += 6) {
            const [a, b] = [Math.atan2(lines[i + 2], lines[i + 1]), Math.atan2(lines[i + 5], lines[i + 4])];
            turned += Math.atan2(Math.sin(b - a), Math.cos(b - a));
        }
        expect(Math.abs(turned) / (2 * Math.PI)).toBeCloseTo(12 / 1.5, 3);
    }, SLOW);

    it('draws the helix only on the hole\'s surface, up to where the hole comes out through a slanted face', () => {
        // The far top edge cut off at 45 degrees, 12 mm deep: the hole comes out through that face (y - x = 8).
        const slanted: Feature[] = [{ id: 's', op: 'chamfer', size: 12, at: [[-10, 10, 0]] }, ...drilled,
            { id: 't', name: 'Thread1', op: 'thread', kind: 'internal', at: [10, 4.1, 0], diameter: 10, pitch: 1.5, length: 30 }];
        const view = viewPart({ ...block, features: slanted }, 'p1', { hiddenSketches: ['p1/t'] });
        const shown = buildPartial(view, DEFAULT_PRINT);
        expect(shown.error).toBeNull();
        const lines = meshSolid(shown.shape!).cosmetic!;
        expect(lines.length).toBeGreaterThan(0);
        const radius = (8 + DEFAULT_PRINT.holeTolerance) / 2;
        let past = -Infinity;
        let far = Infinity;
        for (let i = 0; i < lines.length; i += 3) {
            const [x, y, z] = [lines[i], lines[i + 1], lines[i + 2]];
            expect(Math.abs(Math.hypot(y, z) - (radius - 0.02))).toBeLessThan(1e-4);
            expect(x).toBeGreaterThan(-10 - 1e-6);
            expect(x).toBeLessThan(10 + 1e-6);
            // On the hole's surface (the point taken out to it), on the part's side of the slanted face.
            past = Math.max(past, (y * radius) / (radius - 0.02) - x);
            far = Math.min(far, x);
        }
        expect(past).toBeLessThan(8 + 1e-3);
        expect(past).toBeGreaterThan(8 - 0.01);
        // It runs on into the last turn before the far face (x = -10), below the slant, where the hole's wall does.
        expect(far).toBeLessThan(-8.5);
    }, SLOW);
});
