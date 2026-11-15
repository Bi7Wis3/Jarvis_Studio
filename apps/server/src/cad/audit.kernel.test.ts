// Audit of the sketch tools through the kernel: once per tool group, a profile is drawn with the sketcher's tools
// (as the toolbar drives them; apps/web/src/audit/kernelSketches.ts), read out as the finished sketch and extruded;
// the solid must match the sketch.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRINT, type Shape, type Sketch, type Vec3 } from '@jarvis/core';
import type { ModelCurve, PlaneFrame3 } from '@jarvis/core/projection';
import { CadKernel, type MeshData } from './kernel.js';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

const SLOW = 180_000;

/** The web side's sketches, loaded at run time so the server's typecheck does not take in the web app. */
interface Sketches {
    ready(): Promise<void>;
    drawSketch(): Sketch;
    modifySketch(): Promise<Sketch>;
    dimensionSketch(): Sketch;
    modelSketch(curves: ModelCurve[]): Sketch;
    itemsSketch(): Sketch;
    blocksSketch(): Sketch;
}

const WEB = '../../../web/src/audit/kernelSketches';

let kernel: CadKernel;
let web: Sketches;

beforeAll(async () => {
    kernel = CadKernel.start();
    web = (await import(/* @vite-ignore */ WEB)) as Sketches;
    await web.ready();
});

afterAll(async () => {
    await kernel.close();
});

const extrude = (sketch: Sketch, distance: number): Promise<MeshData> =>
    kernel.mesh({ shape: { kind: 'sketch', sketch, extrude: { distance } } as Shape }, DEFAULT_PRINT);

function volume(m: MeshData): number {
    const p = m.positions;
    let v = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
        v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
            + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return v / 6;
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

describe('the sketch tools through the kernel', () => {
    it('Draw: line, tangent arc and lines round a plate with a circle and an ellipse hole', async () => {
        const sketch = web.drawSketch();
        expect(sketch.profiles.length).toBeGreaterThanOrEqual(1);
        const m = await extrude(sketch, 5);
        expect(volume(m) / (5 * (800 + 50 * Math.PI - 9 * Math.PI - 8 * Math.PI))).toBeCloseTo(1, 2);
    }, SLOW);

    it('Modify: a tilted square filleted, chamfered, with a hole patterned along its side', async () => {
        const m = await extrude(await web.modifySketch(), 3);
        const area = 169 - 4 * (1 - Math.PI / 4) - 1.125 - 2 * Math.PI * 2.25;
        expect(volume(m) / (3 * area)).toBeCloseTo(1, 2);
    }, SLOW);

    it('Dimensions: a plate dimensioned to 40.0001 x 20.0002, fully defined, comes out that size', async () => {
        const b = bounds(await extrude(web.dimensionSketch(), 2));
        // Mesh positions are 32-bit floats (about 0.000004 mm apart at 40 mm): good to that, not to the solver's 0.000001.
        expect(Math.abs(b.max[0] - b.min[0] - 40.0001)).toBeLessThan(1e-5);
        expect(Math.abs(b.max[1] - b.min[1] - 20.0002)).toBeLessThan(1e-5);
    }, SLOW);

    it('Model: the section of a box by the sketch plane, converted and extruded; its silhouette too', async () => {
        const box: Shape = { kind: 'box', size: [40, 10, 20], radius: 0 };
        const frame: PlaneFrame3 = { origin: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
        const section = await kernel.project({ shape: box, features: [] }, DEFAULT_PRINT, frame, { kind: 'section', faces: [] });
        expect(section.curves.length).toBe(4);
        const silhouette = await kernel.project({ shape: box, features: [] }, DEFAULT_PRINT, frame, { kind: 'silhouette', external: true });
        expect(silhouette.curves.length).toBeGreaterThanOrEqual(4);
        expect(volume(await extrude(web.modelSketch(section.curves), 3)) / (3 * 40 * 10)).toBeCloseTo(1, 3);
        expect(volume(await extrude(web.modelSketch(silhouette.curves), 3)) / (3 * 40 * 10)).toBeCloseTo(1, 3);
    }, SLOW);

    it('Items: text "O", a block instance and a closed equation curve extrude as their regions', async () => {
        const m = await extrude(web.itemsSketch(), 2);
        expect(volume(m) / (2 * (80 - 24 + 25 + 16 * Math.PI))).toBeCloseTo(1, 2);
    }, SLOW);

    it('Blocks: a block holding text and a nested block, scaled, turned and moved by a relation, extrudes to its area', async () => {
        const sketch = web.blocksSketch();
        const m = await extrude(sketch, 2);
        expect(volume(m) / (2 * 2.25 * (80 - 24 + 25))).toBeCloseTo(1, 4);
        // Moved with its insertion point to (100.0001, -20): every corner is within reach of it.
        const b = bounds(m);
        expect(b.min[0]).toBeGreaterThan(100.0001 - 1.5 * 40);
        expect(b.max[0]).toBeLessThan(100.0001 + 1.5 * 40);
    }, SLOW);
});
