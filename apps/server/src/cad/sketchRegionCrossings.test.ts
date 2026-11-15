// Regions where sketch curves cross or touch without a shared point, through the kernel: the sketch is drawn on the
// web side (apps/web/src/regionKernelSketches.ts), read out with its regions, and only the picked area is extruded.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRINT, type Feature, type Shape, type Sketch, type Vec3 } from '@jarvis/core';
import { CadKernel, type MeshData } from './kernel.js';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

const SLOW = 180_000;

interface Sketches {
    slotWithLineThrough(): Sketch;
    slotWithLineTouching(): Sketch;
    crossingCircles(): Sketch;
    rectangleCrossedBy(kind: 'spline' | 'styleSpline' | 'conic' | 'ellipseArc' | 'ellipse'): Sketch;
}

const WEB = '../../../web/src/regionKernelSketches';

let kernel: CadKernel;
let web: Sketches;

beforeAll(async () => {
    kernel = CadKernel.start();
    web = (await import(/* @vite-ignore */ WEB)) as Sketches;
});

afterAll(async () => {
    await kernel.close();
});

const empty: Shape = { kind: 'empty' };
const part = (sketch: Sketch, regions: [number, number][], distance: number) => {
    const f: Feature = { id: 'e', op: 'extrude', mode: 'add', distance, sketch, regions };
    return { shape: empty, features: [f] };
};

/** The extruded solid: its mesh (for the bounds) and its exact volume (from the solid itself, not the mesh). */
async function extrude(sketch: Sketch, regions: [number, number][], distance = 4): Promise<{ m: MeshData; volume: number }> {
    const m = await kernel.mesh(part(sketch, regions, distance), DEFAULT_PRINT);
    const props = await kernel.properties(part(sketch, regions, distance), DEFAULT_PRINT);
    return { m, volume: props.props!.volume };
}

async function volumeOf(sketch: Sketch, regions: [number, number][], distance: number): Promise<number> {
    const props = await kernel.properties(part(sketch, regions, distance), DEFAULT_PRINT);
    if (!props.props) {
        throw new Error(props.error ?? 'no solid');
    }
    return props.props.volume;
}

function bounds(m: MeshData): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], m.positions[i + k]);
            max[k] = Math.max(max[k], m.positions[i + k]);
        }
    }
    return { min, max };
}

describe('regions bounded by curves that cross or touch without a shared point', () => {
    const half = 100 + (25 * Math.PI) / 2;

    it('extrudes just the upper half of a slot split by a line along its middle', async () => {
        const sketch = web.slotWithLineThrough();
        expect(sketch.regions).toHaveLength(2);
        // Top plane: u = +X, v = -Z; the upper half (v > 0) lies at z < 0.
        const { m, volume } = await extrude(sketch, [[10, 2.5]]);
        expect(volume / (4 * half)).toBeCloseTo(1, 9);
        const b = bounds(m);
        expect(b.min[2]).toBeCloseTo(-5, 3);
        expect(b.max[2]).toBeCloseTo(0, 3);
        expect(b.min[0]).toBeCloseTo(-5, 3);
        expect(b.max[0]).toBeCloseTo(25, 3);
        // Both halves together: the whole slot.
        const both = await extrude(sketch, [[10, 2.5], [10, -2.5]]);
        expect(both.volume / (4 * 2 * half)).toBeCloseTo(1, 9);
    }, SLOW);

    it('extrudes one end of a slot cut across by a line that only ends on its sides', async () => {
        const { m, volume } = await extrude(web.slotWithLineTouching(), [[3, 0]]);
        expect(volume / (4 * half)).toBeCloseTo(1, 9);
        const b = bounds(m);
        expect(b.min[0]).toBeCloseTo(-5, 3);
        expect(b.max[0]).toBeCloseTo(10, 3);
    }, SLOW);

    it('builds the pieces of splines, style splines, conics and ellipses exactly: the areas on either side add up', async () => {
        for (const kind of ['spline', 'styleSpline', 'conic', 'ellipseArc'] as const) {
            const sketch = web.rectangleCrossedBy(kind);
            expect(sketch.regions, kind).toHaveLength(2);
            const parts = await Promise.all(sketch.regions!.map((r) => volumeOf(sketch, [r.at], 3)));
            expect(parts.every((v) => v > 1), kind).toBe(true);
            expect((parts[0] + parts[1]) / (3 * 800), kind).toBeCloseTo(1, 9);
        }
        // An ellipse (8 by 4) centred on the rectangle's right side: half of it inside, half outside.
        const sketch = web.rectangleCrossedBy('ellipse');
        expect(sketch.regions).toHaveLength(3);
        const parts = (await Promise.all(sketch.regions!.map((r) => volumeOf(sketch, [r.at], 3)))).sort((a, b) => a - b);
        expect(parts[0] / (3 * 16 * Math.PI)).toBeCloseTo(1, 9);
        expect(parts[1] / (3 * 16 * Math.PI)).toBeCloseTo(1, 9);
        expect(parts[2] / (3 * (800 - 16 * Math.PI))).toBeCloseTo(1, 9);
    }, SLOW);

    it('extrudes the lens of two crossing circles', async () => {
        const lens = 2 * 25 * Math.acos(6 / 10) - 3 * Math.sqrt(100 - 36);
        const { m, volume } = await extrude(web.crossingCircles(), [[3, 0]], 2);
        expect(volume / (2 * lens)).toBeCloseTo(1, 9);
        // The mesh only approximates the arcs: its bounds are good to its tolerance.
        const b = bounds(m);
        expect(b.min[0]).toBeCloseTo(1, 1);
        expect(b.max[0]).toBeCloseTo(5, 1);
    }, SLOW);
});
