import { describe, expect, it } from 'vitest';
import type { Feature, Vec3 } from './index.js';
import {
    followsModel, pointOfDefinition, pointsAlong, resolveAxis, resolvePlane, resolvePoint, resolveRevolveAxis, sketchCentrelines, withoutFollowCaches,
} from './reference.js';

const close = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('resolvePlane', () => {
    it('maps the named planes like the kernel does (v = normal x u)', () => {
        expect(resolvePlane('top', [])).toEqual({ origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] });
        expect(resolvePlane('right', []).xDir).toEqual([0, 0, -1]);
    });

    it('offsets, turns and chains plane steps', () => {
        const features: Feature[] = [
            { id: 'p1', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 20 } },
            { id: 'p2', op: 'plane', definition: { kind: 'angle', base: { planeRef: 'p1' }, about: 'u', angle: 90 } },
        ];
        close(resolvePlane({ planeRef: 'p1' }, features).origin, [0, 20, 0]);
        const turned = resolvePlane({ planeRef: 'p2' }, features);
        close(turned.origin, [0, 20, 0]);
        // Top's normal (+Y) turned 90 degrees about its u axis (+X) points to +Z.
        close(turned.normal, [0, 0, 1]);
    });

    it('builds planes through three points, from a point and normal, and midway', () => {
        const features: Feature[] = [
            { id: 'a', op: 'plane', definition: { kind: 'threePoints', points: [[0, 0, 0], [10, 0, 0], [0, 10, 0]] } },
            { id: 'b', op: 'plane', definition: { kind: 'pointNormal', point: [1, 2, 3], normal: [0, 0, 5] } },
            { id: 'lo', op: 'plane', definition: { kind: 'offset', base: 'front', distance: 4 } },
            { id: 'hi', op: 'plane', definition: { kind: 'offset', base: 'front', distance: 30 } },
            { id: 'mid', op: 'plane', definition: { kind: 'midplane', a: { planeRef: 'lo' }, b: { planeRef: 'hi' } } },
        ];
        close(resolvePlane({ planeRef: 'a' }, features).normal, [0, 0, 1]);
        close(resolvePlane({ planeRef: 'b' }, features).normal, [0, 0, 1]);
        close(resolvePlane({ planeRef: 'mid' }, features).origin, [0, 0, 17]);
    });

    it('refuses references to later or missing steps and degenerate input', () => {
        const features: Feature[] = [
            { id: 'p', op: 'plane', definition: { kind: 'offset', base: { planeRef: 'q' }, distance: 1 } },
            { id: 'q', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 1 } },
            { id: 'line', op: 'plane', definition: { kind: 'threePoints', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] } },
        ];
        expect(() => resolvePlane({ planeRef: 'p' }, features)).toThrow(/not found/);
        expect(() => resolvePlane({ planeRef: 'nope' }, features)).toThrow(/not found/);
        expect(() => resolvePlane({ planeRef: 'line' }, features)).toThrow(/one line/);
    });
});

describe('points, parallel and normal planes, sketch-line axes', () => {
    const sketch = {
        plane: { planeRef: 'up' } as const,
        profiles: [],
        geometry: {
            points: [{ id: 'a', u: 5, v: 0 }, { id: 'b', u: 5, v: 10 }],
            curves: [{ id: 'cl', kind: 'line' as const, a: 'a', b: 'b', construction: true }, { id: 'c', kind: 'line' as const, a: 'origin', b: 'a' }],
            constraints: [],
        },
    };
    const features: Feature[] = [
        { id: 'pt', op: 'point', position: [3, 7, 1] },
        { id: 'par', op: 'plane', definition: { kind: 'parallel', base: 'top', point: { pointRef: 'pt' } } },
        { id: 'tp', op: 'plane', definition: { kind: 'threePoints', points: [{ pointRef: 'pt' }, [4, 7, 1], [3, 7, 0]] } },
        { id: 'up', op: 'plane', definition: { kind: 'offset', base: 'front', distance: 2 } },
        { id: 'sk', op: 'sketch', sketch },
        { id: 'line', op: 'axis', definition: { kind: 'sketchLine', sketchRef: 'sk', line: 'cl' } },
        { id: 'nrm', op: 'plane', definition: { kind: 'normal', axis: { axisRef: 'line' }, point: [0, 4, 0] } },
        { id: 'pp', op: 'axis', definition: { kind: 'pointPlane', point: { pointRef: 'pt' }, plane: 'right' } },
    ];

    it('resolves point steps, parallel planes through a point and planes normal to an axis', () => {
        expect(resolvePoint({ pointRef: 'pt' }, features)).toEqual([3, 7, 1]);
        const par = resolvePlane({ planeRef: 'par' }, features);
        close(par.origin, [3, 7, 1]);
        close(par.normal, [0, 1, 0]);
        expect(Math.abs(resolvePlane({ planeRef: 'tp' }, features).normal[1])).toBeCloseTo(1, 6);
        // The centreline runs along +Y at x = 5 on the front plane moved to z = 2.
        const line = resolveAxis({ axisRef: 'line' }, features);
        close(line.point, [5, 0, 2]);
        close(line.direction, [0, 1, 0]);
        const nrm = resolvePlane({ planeRef: 'nrm' }, features);
        close(nrm.normal, [0, 1, 0]);
        close(nrm.origin, [0, 4, 0]);
        close(resolveAxis({ axisRef: 'pp' }, features).direction, [1, 0, 0]);
        expect(() => resolvePoint({ pointRef: 'nope' }, features)).toThrow(/not found/);
    });

    it('resolves revolve axes: sketch axes, lines of the sketch and axis steps, in and out of the sketch plane', () => {
        const before = features.slice(0, 4);
        expect(resolveRevolveAxis('v', sketch, before).inPlane).toEqual({ point: [0, 0], direction: [0, 1] });
        const cl = resolveRevolveAxis({ line: 'cl' }, sketch, before);
        close(cl.point, [5, 0, 2]);
        expect(cl.inPlane).toEqual({ point: [5, 0], direction: [0, 1] });
        // The axis step lies in the sketch plane, so it is also a line in (u, v).
        const step = resolveRevolveAxis({ axisRef: 'line' }, sketch, features);
        expect(step.inPlane?.point[0]).toBeCloseTo(5, 6);
        expect(resolveRevolveAxis('y', sketch, features).inPlane).toBeNull();
        expect(() => resolveRevolveAxis('z', sketch, features)).toThrow(/perpendicular/);
        expect(() => resolveRevolveAxis({ line: 'nope' }, sketch, before)).toThrow(/no line/);
        expect(sketchCentrelines(sketch)).toEqual(['cl']);
    });
});

describe('resolveAxis', () => {
    it('resolves named axes, two points and plane intersections', () => {
        expect(resolveAxis('y', [])).toEqual({ point: [0, 0, 0], direction: [0, 1, 0] });
        const features: Feature[] = [
            { id: 'p', op: 'plane', definition: { kind: 'offset', base: 'front', distance: 10 } },
            { id: 'ax', op: 'axis', definition: { kind: 'planeIntersection', a: 'top', b: { planeRef: 'p' } } },
            { id: 'tp', op: 'axis', definition: { kind: 'twoPoints', a: [0, 0, 0], b: [0, 0, 5] } },
        ];
        const ax = resolveAxis({ axisRef: 'ax' }, features);
        // Ground plane meets the plane z = 10 along a line parallel to X at y = 0, z = 10.
        expect(Math.abs(ax.direction[0])).toBeCloseTo(1, 6);
        close(ax.point, [0, 0, 10]);
        close(resolveAxis({ axisRef: 'tp' }, features).direction, [0, 0, 1]);
    });

    it('rejects parallel planes', () => {
        const features: Feature[] = [
            { id: 'p', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 10 } },
            { id: 'ax', op: 'axis', definition: { kind: 'planeIntersection', a: 'top', b: { planeRef: 'p' } } },
        ];
        expect(() => resolveAxis({ axisRef: 'ax' }, features)).toThrow(/parallel/);
    });
});

describe('references taken from the model (by value)', () => {
    // A 40 x 10 x 20 block's top face (y = 10, outward +Y) and its bottom face (y = 0, outward -Y).
    const topFace = { fixedPlane: { origin: [5, 10, 3] as Vec3, normal: [0, 1, 0] as Vec3, xDir: [1, 0, 0] as Vec3 }, from: 'face' as const };
    const bottomFace = { fixedPlane: { origin: [1, 0, 2] as Vec3, normal: [0, -1, 0] as Vec3, xDir: [1, 0, 0] as Vec3 }, from: 'face' as const };
    // The block's top front edge, along X at y = 10, z = 20.
    const edge = { fixedAxis: { point: [0, 10, 20] as Vec3, direction: [1, 0, 0] as Vec3 }, from: 'edge' as const };
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    it('offsets from a picked face, along its outward normal, and flips the normal', () => {
        const features: Feature[] = [
            { id: 'o', op: 'plane', definition: { kind: 'offset', base: topFace, distance: 2.5 } },
            { id: 'f', op: 'plane', definition: { kind: 'offset', base: topFace, distance: 2.5, flipNormal: true } },
        ];
        const o = resolvePlane({ planeRef: 'o' }, features);
        expect(o.origin[1]).toBeCloseTo(12.5, 9);
        close(o.normal, [0, 1, 0]);
        const f = resolvePlane({ planeRef: 'f' }, features);
        expect(f.origin[1]).toBeCloseTo(12.5, 9);
        close(f.normal, [0, -1, 0]);
    });

    it('makes a mid plane between two picked faces that face away from each other', () => {
        const features: Feature[] = [{ id: 'm', op: 'plane', definition: { kind: 'midplane', a: topFace, b: bottomFace } }];
        const m = resolvePlane({ planeRef: 'm' }, features);
        expect(m.origin[1]).toBeCloseTo(5, 9);
        expect(Math.abs(m.normal[1])).toBeCloseTo(1, 9);
    });

    it('makes a plane through three picked vertices', () => {
        const features: Feature[] = [
            { id: 't', op: 'plane', definition: { kind: 'threePoints', points: [[0, 10, 0], [40, 10, 0], [0, 0, 20]] } },
        ];
        const t = resolvePlane({ planeRef: 't' }, features);
        // Through the top back edge and the bottom front corner: the normal is perpendicular to X and to (0, -10, 20).
        expect(t.normal[0]).toBeCloseTo(0, 9);
        expect(t.normal[1] * -10 + t.normal[2] * 20).toBeCloseTo(0, 9);
    });

    it('turns a face about a picked edge, moving it onto the edge first; perpendicular and through an edge and a point', () => {
        const features: Feature[] = [
            // The bottom face turned about the top front edge (parallel to it, 10 mm off): the plane passes through the edge.
            { id: 'a', op: 'plane', definition: { kind: 'angle', base: bottomFace, about: edge, angle: 90, throughAxis: true } },
            { id: 'p', op: 'plane', definition: { kind: 'perpendicular', base: topFace, axis: edge } },
            { id: 'lp', op: 'plane', definition: { kind: 'linePoint', axis: edge, point: [0, 0, 20] } },
            { id: 'x', op: 'plane', definition: { kind: 'angle', base: 'right', about: edge, angle: 10, throughAxis: true } },
        ];
        const a = resolvePlane({ planeRef: 'a' }, features);
        expect(dot(a.normal, a.origin)).toBeCloseTo(dot(a.normal, [0, 10, 20]), 9);
        expect(Math.abs(a.normal[2])).toBeCloseTo(1, 9);
        const p = resolvePlane({ planeRef: 'p' }, features);
        expect(Math.abs(p.normal[2])).toBeCloseTo(1, 9);
        expect(p.origin[2]).toBeCloseTo(20, 9);
        // The front face: through the edge and a point below it.
        const lp = resolvePlane({ planeRef: 'lp' }, features);
        expect(Math.abs(lp.normal[2])).toBeCloseTo(1, 9);
        expect(lp.origin[2]).toBeCloseTo(20, 9);
        expect(() => resolvePlane({ planeRef: 'x' }, features)).toThrow(/lie in the plane/);
    });

    it('makes planes tangent to a picked cylinder', () => {
        const cylinder = { point: [0, 0, 0] as Vec3, direction: [0, 1, 0] as Vec3, radius: 5 };
        const features: Feature[] = [
            { id: 'on', op: 'plane', definition: { kind: 'tangent', cylinder, point: [5, 3, 0] } },
            { id: 'off', op: 'plane', definition: { kind: 'tangent', cylinder, point: [10, 3, 0] } },
            { id: 'off2', op: 'plane', definition: { kind: 'tangent', cylinder, point: [10, 3, 0], flip: true } },
            { id: 'par', op: 'plane', definition: { kind: 'tangent', cylinder, plane: 'front' } },
            { id: 'ang', op: 'plane', definition: { kind: 'tangent', cylinder, plane: 'front', angle: 90, flip: true } },
            { id: 'in', op: 'plane', definition: { kind: 'tangent', cylinder, point: [1, 0, 0] } },
        ];
        const on = resolvePlane({ planeRef: 'on' }, features);
        close(on.normal, [1, 0, 0]);
        close(on.origin, [5, 3, 0]);
        for (const id of ['off', 'off2']) {
            const p = resolvePlane({ planeRef: id }, features);
            // Through the point, and the radius from the axis.
            expect(dot(p.normal, [10, 3, 0])).toBeCloseTo(dot(p.normal, p.origin), 9);
            expect(Math.abs(dot(p.normal, p.origin))).toBeCloseTo(5, 9);
        }
        expect(resolvePlane({ planeRef: 'off' }, features).normal[2]).toBeCloseTo(-resolvePlane({ planeRef: 'off2' }, features).normal[2], 9);
        const par = resolvePlane({ planeRef: 'par' }, features);
        close(par.normal, [0, 0, 1]);
        close(par.origin, [0, 0, 5]);
        const ang = resolvePlane({ planeRef: 'ang' }, features);
        // Front's normal (+Z) turned 90 degrees about +Y is +X; flipped, the tangent at x = -5.
        close(ang.normal, [-1, 0, 0]);
        close(ang.origin, [-5, 0, 0]);
        expect(() => resolvePlane({ planeRef: 'in' }, features)).toThrow(/inside/);
    });

    it('resolves axes along a picked edge or cylinder axis, and planes and axes built on picked faces', () => {
        const features: Feature[] = [
            { id: 'e', op: 'axis', definition: { kind: 'along', axis: edge } },
            { id: 'n', op: 'plane', definition: { kind: 'normal', axis: { axisRef: 'e' }, point: [7, 10, 20] } },
            { id: 'i', op: 'axis', definition: { kind: 'planeIntersection', a: topFace, b: 'front' } },
            { id: 'pp', op: 'axis', definition: { kind: 'pointPlane', point: [1, 2, 3], plane: topFace } },
        ];
        expect(resolveAxis({ axisRef: 'e' }, features)).toEqual({ point: [0, 10, 20], direction: [1, 0, 0] });
        const n = resolvePlane({ planeRef: 'n' }, features);
        close(n.normal, [1, 0, 0]);
        close(n.origin, [7, 10, 20]);
        close(resolveAxis({ axisRef: 'i' }, features).point, [0, 10, 0]);
        close(resolveAxis({ axisRef: 'pp' }, features).direction, [0, 1, 0]);
        expect(() => resolveAxis({ fixedAxis: { point: [0, 0, 0], direction: [0, 0, 0] } }, [])).toThrow(/non-zero/);
        expect(() => resolvePlane({ fixedPlane: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [0, 2, 0] } }, [])).toThrow(/xDir/);
    });
});

describe('references taken from the model', () => {
    const picked = {
        fixedPlane: { origin: [0, 10, 0] as Vec3, normal: [0, 1, 0] as Vec3, xDir: [1, 0, 0] as Vec3 }, from: 'face' as const,
        pick: { face: { at: [3, 10, 2] as Vec3, normal: [0, 1, 0] as Vec3 } },
    };
    const line = { type: 'line' as const, a: [0, 0, 0] as Vec3, b: [10, 0, 0] as Vec3 };

    it('resolves points taken from the model where they were last found, and tells which steps follow the model', () => {
        expect(resolvePoint({ fixedPoint: [1, 2, 3], from: 'vertex', pick: { vertex: [1, 2, 3] } }, [])).toEqual([1, 2, 3]);
        expect(followsModel({ id: 'p', op: 'plane', definition: { kind: 'offset', base: picked, distance: 1 } })).toBe(true);
        const { pick: _pick, ...byValue } = picked;
        expect(followsModel({ id: 'p', op: 'plane', definition: { kind: 'offset', base: byValue, distance: 1 } })).toBe(false);
        expect(followsModel({ id: 'o', op: 'point', position: [0, 0, 0] })).toBe(false);
        expect(followsModel({ id: 'o', op: 'point', position: [0, 0, 0], definition: { kind: 'vertex', vertex: { vertex: [0, 0, 0] } } })).toBe(true);
    });

    it('leaves out only what says where the references were found', () => {
        const step: Feature = { id: 'p', op: 'plane', definition: { kind: 'offset', base: picked, distance: 1 } };
        expect(withoutFollowCaches(step)).toEqual({ id: 'p', op: 'plane', definition: { kind: 'offset', base: { from: 'face', pick: picked.pick }, distance: 1 } });
        const point: Feature = {
            id: 'o', op: 'point', position: [5, 0, 0], definition: { kind: 'along', edge: { edge: [5, 0, 0], shape: line }, by: 'percent', amount: 50, index: 1 },
        };
        expect(withoutFollowCaches(point)).toEqual({ id: 'o', op: 'point', definition: { kind: 'along', edge: { edge: [5, 0, 0] }, by: 'percent', amount: 50, index: 1 } });
    });

    it('places points from their edges as found', () => {
        expect(pointOfDefinition({ kind: 'along', edge: { edge: [5, 0, 0], shape: line }, by: 'distance', amount: 2.5, index: 3, reverse: true }, [0, 0, 0]))
            .toEqual([2.5, 0, 0]);
        const crossing = pointOfDefinition({
            kind: 'intersection', a: { edge: [0, 0, 0], shape: line }, b: { edge: [4, 1, 0], shape: { type: 'line', a: [4, 1, 0], b: [4, 5, 0] } },
        }, [9, 9, 9]);
        close(crossing, [4, 0, 0]);
        expect(pointOfDefinition({ kind: 'vertex', vertex: { vertex: [0, 0, 0] } }, [1, 1, 1])).toEqual([1, 1, 1]);
        expect(() => pointsAlong(line, 'distance', 6, 2)).toThrow(/past the end/);
    });
});
