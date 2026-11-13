import { beforeAll, describe, expect, it } from 'vitest';
import opencascade from 'replicad-opencascadejs';
import { makeBox, measureArea, measureVolume, setOC, type Shape3D } from 'replicad';
import { chamferEdges, draftFaces, filletEdges, filletFaces, shellFaces } from './applied.js';
import { distanceToShape, resolveEdges, resolveFaces } from './refs.js';

const SLOW = 120_000;
const BOX = 40 * 10 * 20;

// Box 40 x 10 x 20: x 0..40, y 0..10 (up), z 0..20. Top edge along x at z = 0: midpoint (20, 10, 0).
let box: Shape3D;

beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
    box = makeBox([0, 0, 0], [40, 10, 20]);
}, SLOW);

const within = (actual: number, expected: number, fraction: number): void => {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * fraction);
};

function size(shape: Shape3D): number[] {
    const b = shape.boundingBox;
    const [lo, hi] = b.bounds;
    b.delete();
    return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

describe('filletEdges', () => {
    it('rounds one picked edge by the analytic volume', () => {
        const r = 2;
        const result = filletEdges(box, resolveEdges(box, [[20, 10, 0]]), { radius: r });
        within(measureVolume(result), BOX - (r * r - (Math.PI * r * r) / 4) * 40, 0.005);
    });

    it('rounds four picked vertical edges', () => {
        const r = 3;
        const edges = resolveEdges(box, [[0, 5, 0], [40, 5, 0], [0, 5, 20], [40, 5, 20]]);
        expect(edges).toHaveLength(4);
        within(measureVolume(filletEdges(box, edges, { radius: r })), BOX - 4 * (r * r - (Math.PI * r * r) / 4) * 10, 0.005);
    });

    it('varies the radius from the end nearest `from`', () => {
        const result = filletEdges(box, resolveEdges(box, [[20, 10, 0]]), { radii: [1, 3], from: [0, 10, 0] });
        // The sharp corner line is r (sqrt 2 - 1) from the fillet surface.
        const k = Math.SQRT2 - 1;
        expect(distanceToShape([0.5, 10, 0], result)).toBeCloseTo((1 + 2 * 0.5 / 40) * k, 1);
        expect(distanceToShape([39.5, 10, 0], result)).toBeCloseTo((3 - 2 * 0.5 / 40) * k, 1);
    });

    it('explains a radius too large for the faces', () => {
        expect(() => filletEdges(box, resolveEdges(box, [[20, 10, 0]]), { radius: 15 })).toThrow(/fillet of 15 mm/);
    });

    it('fillets all edges of a picked face', () => {
        const top = resolveFaces(box, [{ at: [20, 10, 10], normal: [0, 1, 0] }]);
        const r = 1;
        within(measureVolume(filletFaces(box, top, r)), BOX - (r * r - (Math.PI * r * r) / 4) * 120, 0.01);
    });
});

describe('chamferEdges', () => {
    const edge = () => resolveEdges(box, [[20, 10, 0]]);

    it('equal distance', () => {
        within(measureVolume(chamferEdges(box, edge(), { distance: 2 })), BOX - 2 * 2 / 2 * 40, 0.001);
    });

    it('two distances, and distance-angle matching it', () => {
        const up: [number, number, number] = [0, 1, 0];
        const two = chamferEdges(box, edge(), { distances: [2, 3], side: up });
        within(measureVolume(two), BOX - 2 * 3 / 2 * 40, 0.001);
        // Reference face = top: 2 mm along the top, 3 mm down the front.
        expect(distanceToShape([20, 10, 2.5], two)).toBeLessThan(1e-6);
        expect(distanceToShape([20, 7.5, 0], two)).toBeGreaterThan(0.1);
        const angled = chamferEdges(box, edge(), { distance: 2, angle: (Math.atan(3 / 2) * 180) / Math.PI, side: up });
        within(measureVolume(angled), measureVolume(two), 0.001);
        expect(distanceToShape([20, 10, 2.5], angled)).toBeLessThan(1e-6);
    });
});

describe('shellFaces', () => {
    const top = () => resolveFaces(box, [{ at: [20, 10, 10], normal: [0, 1, 0] }]);

    it('removes the picked top face', () => {
        within(measureVolume(shellFaces(box, 1, top())), BOX - 38 * 9 * 18, 0.001);
    });

    it('grows outward', () => {
        const result = shellFaces(box, 1, top(), { outward: true });
        const [x, y, z] = size(result);
        expect(x).toBeCloseTo(42, 3);
        expect(y).toBeCloseTo(11, 3);
        expect(z).toBeCloseTo(22, 3);
        expect(measureVolume(result)).toBeGreaterThan(42 * 11 * 22 - BOX - 50);
    });

    it('makes a closed hollow body with no faces picked', () => {
        within(measureVolume(shellFaces(box, 1, [])), BOX - 38 * 8 * 18, 0.001);
    });
});

describe('draftFaces', () => {
    it('tapers the four sides about the bottom plane', () => {
        const sides = resolveFaces(box, [
            { at: [0, 5, 10], normal: [-1, 0, 0] }, { at: [40, 5, 10], normal: [1, 0, 0] },
            { at: [20, 5, 0], normal: [0, 0, -1] }, { at: [20, 5, 20], normal: [0, 0, 1] },
        ]);
        expect(sides).toHaveLength(4);
        const result = draftFaces(box, sides, 5, { origin: [0, 0, 0], normal: [0, 1, 0] });
        const inset = 2 * 10 * Math.tan((5 * Math.PI) / 180);
        const topFace = resolveFaces(result, [{ at: [20, 10, 10], normal: [0, 1, 0] }]);
        within(measureArea(topFace[0]), (40 - inset) * (20 - inset), 0.01);
    });
});
