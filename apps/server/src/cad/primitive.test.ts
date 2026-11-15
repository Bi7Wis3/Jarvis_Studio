import { beforeAll, describe, expect, it } from 'vitest';
import { measureVolume, type Shape3D } from 'replicad';
import { DEFAULT_PRINT, type Feature, type Shape, type Vec3 } from '@jarvis/core';
import { buildPartial, initOC } from './build.js';

const SLOW = 300_000;

beforeAll(async () => {
    await initOC();
}, SLOW);

function built(shape: Shape, features: Feature[]): Shape3D {
    const result = buildPartial({ shape, features }, DEFAULT_PRINT);
    expect(result.error).toBeNull();
    return result.shape!;
}

function expectBounds(shape: Shape3D, min: Vec3, max: Vec3): void {
    const [lo, hi] = shape.boundingBox.bounds as [Vec3, Vec3];
    for (let i = 0; i < 3; i++) {
        expect(lo[i]).toBeCloseTo(min[i], 4);
        expect(hi[i]).toBeCloseTo(max[i], 4);
    }
}

describe('primitive steps (toolbar primitives)', () => {
    it('a box added to an empty part starts its body; a turned wedge and a cylinder cut from it are exact', () => {
        const shape = built({ kind: 'empty' }, [
            { id: 'b', op: 'add', shape: { kind: 'box', size: [40, 20, 30], radius: 0 }, position: [0, 10, 0] },
            // A wedge lying on the top face, its slope along +X.
            { id: 'w', op: 'add', shape: { kind: 'wedge', size: [12.5, 6.25, 8] }, position: [0, 23.125, 0] },
            // A cylinder along X (rotated -90 degrees about Z), cut through the box.
            { id: 'c', op: 'cut', shape: { kind: 'cylinder', radius: 3.0001, height: 50, bevel: 0 }, position: [0, 10, 0], rotation: [0, 0, -90] },
        ]);
        expectBounds(shape, [-20, 0, -15], [20, 26.25, 15]);
        const expected = 40 * 20 * 30 + (12.5 * 6.25 * 8) / 2 - Math.PI * 3.0001 ** 2 * 40;
        expect(Math.abs(measureVolume(shape) - expected)).toBeLessThan(1e-3);
    }, SLOW);

    it('the wedge is a ramp: full height at -X, nothing at +X', () => {
        const shape = built({ kind: 'empty' }, [{ id: 'w', op: 'add', shape: { kind: 'wedge', size: [10, 4, 6] } }]);
        expectBounds(shape, [-5, -2, -3], [5, 2, 3]);
        expect(measureVolume(shape)).toBeCloseTo(10 * 4 * 6 / 2, 6);
        // A slab 0.1 wide about x = 4, where a tenth of the height is left: 0.1 * 0.4 * 6.
        const slab = built({ kind: 'empty' }, [
            { id: 'w', op: 'add', shape: { kind: 'wedge', size: [10, 4, 6] } },
            { id: 'l', op: 'cut', shape: { kind: 'box', size: [10, 10, 10], radius: 0 }, position: [-1.05, 0, 0] },
            { id: 'r', op: 'cut', shape: { kind: 'box', size: [10, 10, 10], radius: 0 }, position: [9.05, 0, 0] },
        ]);
        expect(measureVolume(slab)).toBeCloseTo(0.1 * 0.4 * 6, 5);
    }, SLOW);

    it('a tube with no bevel and a sphere added to a body are exact', () => {
        const shape = built({ kind: 'box', size: [10, 10, 10], radius: 0 }, [
            { id: 't', op: 'add', shape: { kind: 'tube', outerRadius: 4, innerRadius: 3, height: 7, bevel: 0 }, position: [0, 8.5, 0] },
            { id: 's', op: 'add', shape: { kind: 'sphere', radius: 2 }, position: [20, 0, 0] },
        ]);
        const expected = 1000 + Math.PI * (16 - 9) * 7 + (4 / 3) * Math.PI * 8;
        expect(Math.abs(measureVolume(shape) - expected)).toBeLessThan(1e-3);
    }, SLOW);

    it('a cut as the first step of an empty part says it needs a body', () => {
        const result = buildPartial({ shape: { kind: 'empty' }, features: [
            { id: 'c', op: 'cut', shape: { kind: 'box', size: [1, 1, 1], radius: 0 } },
        ] }, DEFAULT_PRINT);
        expect(result.error).toMatch(/needs a body first/);
    }, SLOW);
});
