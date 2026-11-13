import { beforeAll, describe, expect, it } from 'vitest';
import opencascade from 'replicad-opencascadejs';
import { makeBox, measureArea, setOC, type Shape3D } from 'replicad';
import { resolveEdges, resolveFaces, resolveVertex } from './refs.js';

const SLOW = 120_000;

// Box 40 x 10 x 20: x 0..40, y 0..10 (up), z 0..20. Top face y = 10 (800 mm²), front face z = 0 (400 mm²).
let box: Shape3D;
let rounded: Shape3D;

beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
    box = makeBox([0, 0, 0], [40, 10, 20]);
    rounded = box.clone().fillet((e) => {
        const [lo, hi] = e.boundingBox.bounds;
        return hi[0] - lo[0] < 1e-6 && hi[2] - lo[2] < 1e-6 ? 3 : null;
    });
}, SLOW);

describe('resolveEdges', () => {
    it('resolves a pick at the middle of a top edge to that edge only', () => {
        const edges = resolveEdges(box, [[20, 10, 0]]);
        expect(edges).toHaveLength(1);
        expect(edges[0].length).toBeCloseTo(40, 6);
    });

    it('still resolves a pick 0.2 mm off the edge, and dedupes repeated picks', () => {
        const edges = resolveEdges(box, [[20, 10.2, 0], [10, 10, 0.1]]);
        expect(edges).toHaveLength(1);
        expect(edges[0].length).toBeCloseTo(40, 6);
    });

    it('fails clearly for a pick 5 mm away', () => {
        expect(() => resolveEdges(box, [[20, 10, 0], [20, 15, 0]]))
            .toThrow(/selected edge 2 no longer exists on the part \(nearest edge is 5 mm away\); pick it again/);
    });

    it('walks the tangent chain around a filleted top loop', () => {
        expect(resolveEdges(rounded, [[20, 10, 0]])).toHaveLength(1);
        // 4 straight edges + 4 arcs of the top outline; the vertical seams meet them at right angles.
        expect(resolveEdges(rounded, [[20, 10, 0]], { tangent: true })).toHaveLength(8);
    });
});

describe('resolveFaces', () => {
    it('resolves a pick on the top face', () => {
        const faces = resolveFaces(box, [{ at: [20, 10, 10], normal: [0, 1, 0] }]);
        expect(faces).toHaveLength(1);
        expect(measureArea(faces[0])).toBeCloseTo(800, 3);
    });

    it('decides a pick on a shared edge by its normal', () => {
        const top = resolveFaces(box, [{ at: [20, 10, 0], normal: [0, 1, 0] }]);
        const front = resolveFaces(box, [{ at: [20, 10, 0], normal: [0, 0, -1] }]);
        expect(measureArea(top[0])).toBeCloseTo(800, 3);
        expect(measureArea(front[0])).toBeCloseTo(400, 3);
    });

    it('fails clearly for a pick off the body, and propagates across smooth edges', () => {
        expect(() => resolveFaces(box, [{ at: [20, 13, 10] }])).toThrow(/selected face 1 .*3 mm away/);
        // A side face of the rounded box: 4 sides + 4 corner fillets, not the top or bottom.
        expect(resolveFaces(rounded, [{ at: [20, 5, 0], normal: [0, 0, -1] }], { tangent: true })).toHaveLength(8);
    });
});

describe('resolveVertex', () => {
    it('finds a corner and rejects a far pick', () => {
        expect(resolveVertex(box, [40.1, 10, 20]).asTuple()).toEqual([40, 10, 20]);
        expect(() => resolveVertex(box, [20, 10, 10])).toThrow(/selected vertex/);
    });
});
