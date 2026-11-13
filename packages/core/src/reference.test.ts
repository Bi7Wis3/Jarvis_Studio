import { describe, expect, it } from 'vitest';
import type { Feature, Vec3 } from './index.js';
import { resolveAxis, resolvePlane } from './reference.js';

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
