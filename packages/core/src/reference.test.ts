import { describe, expect, it } from 'vitest';
import type { Feature, Vec3 } from './index.js';
import { resolveAxis, resolvePlane, resolvePoint, resolveRevolveAxis, sketchCentrelines } from './reference.js';

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
