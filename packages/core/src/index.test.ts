import { describe, expect, it } from 'vitest';
import {
    DEFAULT_VIEW, effectivePart, explodeOffsets, partsAtTimeline, shapeHalfExtents, timelineSteps, type Part, type Project,
    type Vec3,
} from './index.js';

function part(id: string, y: number, extra: Partial<Part> = {}): Part {
    return {
        id,
        name: id,
        shape: { kind: 'box', size: [10, 10, 10] },
        position: [0, y, 0],
        rotation: [0, 0, 0],
        material: { color: '#ffffff', metalness: 0, roughness: 1 },
        ...extra,
    };
}

function project(parts: Part[], view: Partial<Project['view']> = {}): Project {
    return { name: 'Test', parts, view: { ...DEFAULT_VIEW, ...view } };
}

describe('shapeHalfExtents', () => {
    it('halves the size of a box', () => {
        expect(shapeHalfExtents({ kind: 'box', size: [10, 20, 30] })).toEqual([5, 10, 15]);
    });

    it('uses the radius and half the height for a cylinder', () => {
        expect(shapeHalfExtents({ kind: 'cylinder', radius: 4, height: 20 })).toEqual([4, 10, 4]);
    });

    it('uses the larger radius when radiusTop exceeds radius', () => {
        expect(shapeHalfExtents({ kind: 'cylinder', radius: 4, radiusTop: 9, height: 20 })).toEqual([9, 10, 9]);
    });

    it('keeps the base radius when radiusTop is smaller', () => {
        expect(shapeHalfExtents({ kind: 'cylinder', radius: 8, radiusTop: 2, height: 20 })).toEqual([8, 10, 8]);
    });

    it('uses the outer radius for a tube', () => {
        expect(shapeHalfExtents({ kind: 'tube', outerRadius: 12, innerRadius: 10, height: 6 })).toEqual([12, 3, 12]);
    });

    it('uses the radius on every axis for a sphere', () => {
        expect(shapeHalfExtents({ kind: 'sphere', radius: 7 })).toEqual([7, 7, 7]);
    });

    it('adds the wire radius to the ring radius for a torus and is flat in Y', () => {
        expect(shapeHalfExtents({ kind: 'torus', radius: 20, tube: 3 })).toEqual([23, 3, 23]);
    });

    it('uses the base radius and half the height for a cone', () => {
        expect(shapeHalfExtents({ kind: 'cone', radius: 6, height: 15 })).toEqual([6, 7.5, 6]);
    });

    it('adds the end caps to half the length for a capsule', () => {
        expect(shapeHalfExtents({ kind: 'capsule', radius: 5, length: 20 })).toEqual([5, 15, 5]);
    });

    it('takes the largest absolute profile values for a lathe', () => {
        const profile: [number, number][] = [[2, -8], [6, 0], [-9, 4]];
        expect(shapeHalfExtents({ kind: 'lathe', profile })).toEqual([9, 8, 9]);
    });
});

describe('explodeOffsets', () => {
    it('returns an empty object for an empty project', () => {
        expect(explodeOffsets(project([]))).toEqual({});
    });

    it('starts at zero for the lowest part and increases with height', () => {
        const offsets = explodeOffsets(project([part('top', 50), part('bottom', 0), part('mid', 20)], {
            explodeSpacing: 10,
        }));
        expect(offsets.bottom).toEqual([0, 0, 0]);
        expect(offsets.mid).toEqual([0, 10, 0]);
        expect(offsets.top).toEqual([0, 20, 0]);
    });

    it('starts at zero even when the lowest part is not at y = 0', () => {
        const offsets = explodeOffsets(project([part('a', 40), part('b', 90)], { explodeSpacing: 10 }));
        expect(offsets.a).toEqual([0, 0, 0]);
        expect(offsets.b).toEqual([0, 10, 0]);
    });

    it('gives parts at the same height the same offset', () => {
        const offsets = explodeOffsets(project([part('a', 0), part('b', 30), part('c', 30)], { explodeSpacing: 10 }));
        expect(offsets.b).toEqual(offsets.c);
        expect(offsets.b).toEqual([0, 10, 0]);
    });

    it('returns an explicit explodeOffset unchanged', () => {
        const custom: Vec3 = [5, -7, 3];
        const offsets = explodeOffsets(project([part('a', 0), part('b', 10, { explodeOffset: custom })], {
            explodeSpacing: 10,
        }));
        expect(offsets.b).toBe(custom);
    });

    it('does not let explicit parts affect the ranking of the others', () => {
        const parts = [part('a', 10), part('fixed', 0, { explodeOffset: [1, 2, 3] }), part('b', 20)];
        const offsets = explodeOffsets(project(parts, { explodeSpacing: 10 }));
        expect(offsets.a).toEqual([0, 0, 0]);
        expect(offsets.b).toEqual([0, 10, 0]);
    });

    it('lets view.explodeSpacing override the automatic spacing', () => {
        const parts = [part('a', 0), part('b', 10)];
        expect(explodeOffsets(project(parts, { explodeSpacing: 33 })).b).toEqual([0, 33, 0]);
        expect(explodeOffsets(project(parts, { explodeSpacing: 0 })).b).toEqual([0, 0, 0]);
    });

    it('uses 60% of the tallest part for automatic spacing, with a 15 mm minimum', () => {
        const tall = part('tall', 0, { shape: { kind: 'box', size: [10, 100, 10] } });
        expect(explodeOffsets(project([tall, part('b', 10)])).b).toEqual([0, 60, 0]);
        expect(explodeOffsets(project([part('a', 0), part('b', 10)])).b).toEqual([0, 15, 0]);
    });
});

describe('timeline', () => {
    const part = (id: string, features: string[]): Part => ({
        id,
        name: id,
        shape: { kind: 'box', size: [10, 10, 10] },
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        material: { color: '#888888', metalness: 0, roughness: 0.5 },
        features: features.map((f) => ({ id: f, op: 'fillet', radius: 1 })),
    });
    const project = (timeline: number | null): Project => ({
        name: 't',
        parts: [part('a', ['a1', 'a2']), part('b', ['b1'])],
        view: { ...DEFAULT_VIEW, timeline },
    });

    it('lists creation then features, in part order', () => {
        expect(timelineSteps(project(null)).map((s) => s.featureId ?? s.partId)).toEqual(['a', 'a1', 'a2', 'b', 'b1']);
    });

    it('shows everything without a marker', () => {
        expect(partsAtTimeline(project(null))).toHaveLength(2);
    });

    it('cuts off later features and parts at the marker', () => {
        const at2 = partsAtTimeline(project(2));
        expect(at2.map((p) => [p.id, p.features?.length])).toEqual([['a', 1]]);
        const at4 = partsAtTimeline(project(4));
        expect(at4.map((p) => [p.id, p.features?.length])).toEqual([['a', 2], ['b', 0]]);
        expect(partsAtTimeline(project(0))).toEqual([]);
    });
});

describe('part rollback', () => {
    it('cuts off the features of one part only', () => {
        const box = (id: string): Part => ({
            id,
            name: id,
            shape: { kind: 'box', size: [10, 10, 10] },
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            material: { color: '#888888', metalness: 0, roughness: 0.5 },
            features: [{ id: 'f1', op: 'fillet', radius: 1 }, { id: 'f2', op: 'chamfer', size: 1 }],
        });
        const project: Project = {
            name: 'r',
            parts: [box('a'), box('b')],
            view: { ...DEFAULT_VIEW, rollback: { partId: 'a', count: 1 } },
        };
        const [a, b] = partsAtTimeline(project);
        expect(a.features?.map((f) => f.id)).toEqual(['f1']);
        expect(b.features).toHaveLength(2);
    });
});

describe('effectivePart', () => {
    it('gives an instance its source design and keeps its own placement', () => {
        const source: Part = {
            id: 'wheel', name: 'Wheel', shape: { kind: 'cylinder', radius: 26, height: 30 },
            position: [0, 0, 0], rotation: [0, 0, 90], material: { color: '#ffffff', metalness: 0, roughness: 0.5 },
            features: [{ id: 'f', op: 'fillet', radius: 2 }],
        };
        const copy: Part = {
            id: 'wheel-2', name: 'Wheel 2', instanceOf: 'wheel', shape: { kind: 'empty' },
            position: [100, 0, 0], rotation: [0, 0, 90], material: { color: '#000000', metalness: 0, roughness: 1 },
        };
        const shown = effectivePart(copy, [source, copy]);
        expect(shown.shape).toBe(source.shape);
        expect(shown.features).toBe(source.features);
        expect(shown.material.color).toBe('#ffffff');
        expect(shown.position).toEqual([100, 0, 0]);
        expect(effectivePart(source, [source, copy])).toBe(source);
    });
});
