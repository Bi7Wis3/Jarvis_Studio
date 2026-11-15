import { beforeAll, describe, expect, it } from 'vitest';
import { measureVolume } from 'replicad';
import { DEFAULT_PRINT, type Feature, type FixedPlaneRef, type Shape, type SketchProfile, type Vec3 } from '@jarvis/core';
import { buildPartial, initOC } from './build.js';
import { CadKernel } from './kernel.js';
import { resolvePlane } from '@jarvis/core/reference';

const SLOW = 120_000;

beforeAll(async () => {
    await initOC();
}, SLOW);

const empty: Shape = { kind: 'empty' };
const rect = (width: number, height: number): SketchProfile => ({ kind: 'rect', center: [0, 0], width, height });
const close = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

/** A 20 x 20 block standing on the top plane, `height` tall: x and z -10..10, y 0..height. */
const block = (height: number, profile: SketchProfile = rect(20, 20)): Feature =>
    ({ id: 'e1', name: 'Base', op: 'extrude', mode: 'add', distance: height, sketch: { plane: 'top', profiles: [profile] } });

/** The block's top face as the Plane form takes it: a plane by value (the face centre) and the pick that follows it. */
const topFace: FixedPlaneRef = {
    fixedPlane: { origin: [0, 10, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, from: 'face', pick: { face: { at: [3, 10, 2], normal: [0, 1, 0] } },
};

/** A 4 x 4 pocket cut 12 mm down from the plane, centred on it. */
const pocket: Feature = {
    id: 'c', op: 'extrude', mode: 'cut', distance: 12, direction: 'reverse', sketch: { plane: { planeRef: 'p' }, profiles: [rect(4, 4)] },
};

function build(features: Feature[]) {
    const built = buildPartial({ shape: empty, features }, DEFAULT_PRINT);
    return { ...built, volume: built.shape ? measureVolume(built.shape) : 0 };
}

describe('references taken from the model follow it', () => {
    it('a plane offset from a face follows when the extrude below it gets taller', () => {
        const plane: Feature = { id: 'p', name: 'Plane1', op: 'plane', definition: { kind: 'offset', base: topFace, distance: 5 } };
        const short = build([block(10), plane, pocket]);
        expect(short.error).toBeNull();
        // The plane 5 above the top (y = 15), the pocket 12 down from it: y 3..10.
        expect(short.volume).toBeCloseTo(20 * 20 * 10 - 4 * 4 * 7, 3);
        const tall = build([block(20), plane, pocket]);
        expect(tall.error).toBeNull();
        // The top is at y = 20 now, the plane at 25 and the pocket y 13..20 (by value it would have stayed at 15: 3..15).
        expect(tall.volume).toBeCloseTo(20 * 20 * 20 - 4 * 4 * 7, 3);
        const found = tall.followed?.p;
        expect(found?.op).toBe('plane');
        const base = (found as Extract<Feature, { op: 'plane' }>).definition;
        expect(base.kind === 'offset' && typeof base.base === 'object' && 'fixedPlane' in base.base ? base.base.fixedPlane : null)
            .toEqual({ origin: [0, 20, 0], normal: [0, 1, 0], xDir: [1, 0, 0] });
        // The pick itself is kept as it was.
        expect(base.kind === 'offset' && typeof base.base === 'object' && 'pick' in base.base ? base.base.pick : null).toEqual(topFace.pick);
        // A shorter block: the plane follows down (y = 9) and the pocket goes through (y -3..9).
        const low = build([block(4), plane, pocket]);
        expect(low.error).toBeNull();
        expect(low.volume).toBeCloseTo(20 * 20 * 4 - 4 * 4 * 4, 3);
    }, SLOW);

    it('builds that start from cached steps keep the references as found, and the kernel reports them with the mesh', async () => {
        const plane: Feature = { id: 'p', name: 'Plane1', op: 'plane', definition: { kind: 'offset', base: topFace, distance: 5 } };
        build([block(20), plane, pocket]);
        // Only the pocket changed: the block and the plane come from the cache, the plane still at y = 25 (pocket y 15..20).
        const again = build([block(20), plane, { ...pocket, distance: 10 }]);
        expect(again.error).toBeNull();
        expect(again.volume).toBeCloseTo(20 * 20 * 20 - 4 * 4 * 5, 3);
        expect(again.followed?.p).toBeDefined();
        const kernel = CadKernel.start();
        try {
            const mesh = await kernel.mesh({ shape: empty, features: [block(20), plane] }, DEFAULT_PRINT);
            const found = mesh.followed?.p as Extract<Feature, { op: 'plane' }> | undefined;
            expect(found?.definition).toMatchObject({ base: { fixedPlane: { origin: [0, 20, 0] } } });
        } finally {
            await kernel.close();
        }
    }, SLOW);

    it('a lost reference is an error naming the plane and what it lost, not the old value', () => {
        // The block's -X side, then the block becomes a round boss: no flat face looks that way any more.
        const side: FixedPlaneRef = {
            fixedPlane: { origin: [-10, 5, 0], normal: [-1, 0, 0], xDir: [0, 0, -1] }, from: 'face', pick: { face: { at: [-10, 5, 1], normal: [-1, 0, 0] } },
        };
        const plane: Feature = { id: 'p', name: 'Side plane', op: 'plane', definition: { kind: 'offset', base: side, distance: 2 } };
        expect(build([block(10), plane]).error).toBeNull();
        const round = build([block(10, { kind: 'circle', center: [0, 0], radius: 10 }), plane, pocket]);
        expect(round.error).toBe('feature "Side plane" (plane): a reference it was made from is missing (it dangles): the flat face picked at '
            + '(-10, 5, 1) is no longer on the part. Edit Side plane and pick it again');
        // The body up to the plane is still shown.
        expect(round.volume).toBeCloseTo(Math.PI * 100 * 10, 1);
    }, SLOW);

    it('an axis taken from a hole stays on it when the hole gets bigger, and is lost when the hole goes', () => {
        const hole = (radius: number, x = 0): Feature => ({
            id: 'h', op: 'extrude', mode: 'cut', end: 'throughAll', sketch: { plane: 'top', offset: 10, profiles: [{ kind: 'circle', center: [x, 0], radius }] },
            direction: 'reverse',
        });
        const axis: Feature = {
            id: 'a', name: 'Hole axis', op: 'axis', definition: {
                kind: 'along', axis: { fixedAxis: { point: [0, 5, 0], direction: [0, 1, 0] }, from: 'cylinder', pick: { face: { at: [3, 5, 0], normal: [-1, 0, 0] } } },
            },
        };
        const fixedAxis = (f?: Feature) => (f?.op === 'axis' && f.definition.kind === 'along' && typeof f.definition.axis === 'object'
            && 'fixedAxis' in f.definition.axis ? f.definition.axis.fixedAxis : null);
        const small = build([block(10), hole(3), axis]);
        expect(small.error).toBeNull();
        close(fixedAxis(small.followed?.a)!.point, [0, 5, 0]);
        const big = build([block(10), hole(5), axis]);
        expect(big.error).toBeNull();
        close(fixedAxis(big.followed?.a)!.point, [0, 5, 0]);
        close(fixedAxis(big.followed?.a)!.direction, [0, 1, 0]);
        expect(build([block(10), axis]).error).toMatch(/^feature "Hole axis" \(axis\): .*the cylindrical face picked at \(3, 5, 0\) is no longer on the part/);
    }, SLOW);

    it('a plane tangent where a boss was clicked stays on it when the boss gets wider', () => {
        const boss = (radius: number) => block(10, { kind: 'circle', center: [0, 0], radius });
        const tangent: Feature = {
            id: 't', op: 'plane', definition: {
                kind: 'tangent', point: [10, 5, 0],
                cylinder: { point: [0, 5, 0], direction: [0, 1, 0], radius: 10, pick: { face: { at: [10, 5, 0], normal: [1, 0, 0] } } },
            },
        };
        const wide = build([boss(12), tangent]);
        expect(wide.error).toBeNull();
        const found = wide.followed?.t as Extract<Feature, { op: 'plane' }>;
        expect(found.definition).toMatchObject({ kind: 'tangent', cylinder: { radius: 12 } });
        close((found.definition as { point: Vec3 }).point, [12, 5, 0]);
        close(resolvePlane({ planeRef: 't' }, [found]).origin, [12, 5, 0]);
    }, SLOW);

    it('older steps kept by value build as before', () => {
        const { pick: _pick, ...byValue } = topFace;
        const plane: Feature = { id: 'p', op: 'plane', definition: { kind: 'offset', base: byValue, distance: 5 } };
        // The plane stays at y = 15: the pocket runs y 3..15 in the 20 mm block.
        const tall = build([block(20), plane, pocket]);
        expect(tall.error).toBeNull();
        expect(tall.volume).toBeCloseTo(20 * 20 * 20 - 4 * 4 * 12, 3);
        expect(tall.followed).toEqual({});
    }, SLOW);

    it('edges, vertices and circles follow the faces that meet at them', () => {
        // The block's top front edge (y = 10, z = 10), its top front right corner and, on a round boss, its top circle.
        const top = { at: [0, 10, 0] as Vec3, normal: [0, 1, 0] as Vec3 };
        const front = { at: [0, 9, 10] as Vec3, normal: [0, 0, 1] as Vec3 };
        const right = { at: [10, 9, 0] as Vec3, normal: [1, 0, 0] as Vec3 };
        const steps: Feature[] = [
            block(20),
            {
                id: 'a', op: 'axis', definition: {
                    kind: 'along', axis: {
                        fixedAxis: { point: [0, 10, 10], direction: [1, 0, 0] }, from: 'edge',
                        pick: { edge: [0, 10, 10], faces: [top, front], shape: { type: 'line', a: [-10, 10, 10], b: [10, 10, 10] } },
                    },
                },
            },
            { id: 'v', op: 'point', position: [10, 10, 10], definition: { kind: 'vertex', vertex: { vertex: [10, 10, 10], faces: [top, front, right] } } },
            {
                id: 'm', op: 'point', position: [5, 10, 10], definition: {
                    kind: 'along', by: 'percent', amount: 75, index: 1,
                    edge: { edge: [0, 10, 10], faces: [top, front], shape: { type: 'line', a: [-10, 10, 10], b: [10, 10, 10] } },
                },
            },
        ];
        const built = build(steps);
        expect(built.error).toBeNull();
        const axis = built.followed?.a as Extract<Feature, { op: 'axis' }>;
        const along = axis.definition.kind === 'along' && typeof axis.definition.axis === 'object' && 'fixedAxis' in axis.definition.axis
            ? axis.definition.axis.fixedAxis : null;
        close(along!.point, [0, 20, 10]);
        close(along!.direction, [1, 0, 0]);
        close((built.followed?.v as Extract<Feature, { op: 'point' }>).position, [10, 20, 10]);
        // 75% along the edge from its start at x = -10.
        close((built.followed?.m as Extract<Feature, { op: 'point' }>).position, [5, 20, 10]);

        // A round boss 6 tall: the centre of its top circle, then the boss made 3 tall.
        const circle = (height: number): Feature[] => [
            block(height, { kind: 'circle', center: [0, 0], radius: 10 }),
            {
                id: 'o', op: 'point', position: [0, 6, 0], definition: {
                    kind: 'arcCentre', edge: {
                        edge: [10, 6, 0], faces: [{ at: [0, 6, 1], normal: [0, 1, 0] }, { at: [10, 5.9, 0], normal: [1, 0, 0] }],
                        shape: { type: 'circle', centre: [0, 6, 0], normal: [0, 1, 0], radius: 10, full: true, start: [10, 6, 0], end: [10, 6, 0] },
                    },
                },
            },
        ];
        close((build(circle(6)).followed?.o as Extract<Feature, { op: 'point' }>).position, [0, 6, 0]);
        expect(build(circle(3)).error).toBeNull();
        close((build(circle(3)).followed?.o as Extract<Feature, { op: 'point' }>).position, [0, 3, 0]);
        close((build(circle(12)).followed?.o as Extract<Feature, { op: 'point' }>).position, [0, 12, 0]);
    }, SLOW);
});
