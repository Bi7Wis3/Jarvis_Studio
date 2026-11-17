import { describe, expect, it } from 'vitest';
import type { Feature, Vec3 } from './index.js';
import { curveFrame, curveOf, nearestParam, pointsAlongCurve } from './curveRefs.js';
import { helixDerivatives, helixLength, helixLengthTo, type HelixOptions } from './helix.js';
import { resolvePlane, resolvePoint } from './reference.js';

const close = (a: Vec3, b: Vec3, digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
};

// A circle of radius 10 about the Y axis on the top plane, a 5-turn helix of pitch 4 on it.
const spring = (pitch = 4, radius = 10, extra: Partial<HelixOptions> = {}): Feature[] => [
    { id: 'ring', op: 'sketch', sketch: { plane: 'top', profiles: [{ kind: 'circle', center: [0, 0], radius }] } },
    { id: 'coil', op: 'helix', sketchRef: 'ring', definedBy: 'pitchRevolution', pitch, revolutions: 5, ...extra },
];

describe('points on a helix or spiral step', () => {
    it('resolves its start, end and part way, and follows the curve when it changes', () => {
        const f = spring();
        close(resolvePoint({ curveRef: 'coil', at: 'start' }, f), [10, 0, 0]);
        close(resolvePoint({ curveRef: 'coil', at: 'end' }, f), [10, 20, 0]);
        // Half way through 5 turns: 2.5 turns, on the far side, 10 up.
        close(resolvePoint({ curveRef: 'coil', at: 0.5 }, f), [-10, 10, 0]);
        close(resolvePoint({ curveRef: 'coil', at: 'end' }, spring(6, 12)), [12, 30, 0]);
        expect(() => resolvePoint({ curveRef: 'ring', at: 'end' }, f)).toThrow(/curve "ring" not found/);
        expect(() => resolvePoint({ curveRef: 'coil', at: 2 }, f)).toThrow(/fraction from 0 to 1/);
    });

    it('point steps made on the curve go where it is now, whatever position they kept', () => {
        const steps = (pitch: number): Feature[] => [
            ...spring(pitch),
            { id: 'tip', op: 'point', position: [0, 0, 0], definition: { kind: 'onCurve', curve: { curveRef: 'coil', at: 'end' } } },
            { id: 'quarter', op: 'point', position: [0, 0, 0], definition: { kind: 'alongCurve', curve: { curveRef: 'coil' }, by: 'percent', amount: 25, index: 1 } },
        ];
        close(resolvePoint({ pointRef: 'tip' }, steps(4)), [10, 20, 0]);
        close(resolvePoint({ pointRef: 'tip' }, steps(5)), [10, 25, 0]);
        // A constant pitch helix runs evenly: a quarter of its length is a quarter of its turns.
        close(resolvePoint({ pointRef: 'quarter' }, steps(4)), [0, 5, 10].map((c, i) => (i === 0 ? 10 * Math.cos(2.5 * Math.PI) : i === 2 ? -10 * Math.sin(2.5 * Math.PI) : c)) as Vec3, 6);
    });

    it('spaces points along the curve by length, from either end', () => {
        const s = curveOf('coil', spring(4, 10, { variablePitch: [{ pitch: 1 }, { pitch: 6, revolutions: 3 }, { pitch: 6, revolutions: 5 }], pitch: undefined, revolutions: undefined }));
        const total = helixLength(s);
        const pts = pointsAlongCurve(s, 'distance', total / 4, 3);
        pts.forEach((p, i) => {
            const t = nearestParam(s, p);
            expect(helixLengthTo(s, t) / (((i + 1) * total) / 4)).toBeCloseTo(1, 7);
        });
        const back = pointsAlongCurve(s, 'percent', 25, 1, true)[0];
        expect(helixLengthTo(s, nearestParam(s, back)) / (0.75 * total)).toBeCloseTo(1, 7);
        expect(() => pointsAlongCurve(s, 'percent', 40, 3)).toThrow(/run past the end/);
    });
});

describe('a plane perpendicular to a helix or spiral', () => {
    it('is square to the curve at its start, origin there, X towards the axis', () => {
        const f: Feature[] = [
            ...spring(),
            { id: 'p', op: 'plane', definition: { kind: 'curveNormal', curve: { curveRef: 'coil' }, point: { curveRef: 'coil', at: 'start' } } },
        ];
        const plane = resolvePlane({ planeRef: 'p' }, f);
        const s = curveOf('coil', f);
        const [, d] = helixDerivatives(s, 0, 1);
        close(plane.origin, [10, 0, 0]);
        close(plane.normal, unit(d));
        // X points at the axis (from (10, 0, 0) towards -X), square to the curve.
        close(plane.xDir, [-1, 0, 0]);
        expect(dot(plane.xDir, plane.normal)).toBeCloseTo(0, 12);
        // It follows the curve: a bigger circle and pitch move it.
        const moved = resolvePlane({ planeRef: 'p' }, [...spring(6, 12), f[2]]);
        close(moved.origin, [12, 0, 0]);
    });

    it('through a point off the curve: square to the curve where it passes nearest, the origin at the point or on the curve', () => {
        const off: Vec3 = [10.5, 20.3, 0.2];
        const base: Feature[] = [...spring()];
        const s = curveOf('coil', base);
        const t = nearestParam(s, off);
        const frame = curveFrame(s, t);
        // The point lies in the plane square to the curve at its nearest point.
        expect(dot([off[0] - frame.point[0], off[1] - frame.point[1], off[2] - frame.point[2]], frame.tangent)).toBeCloseTo(0, 9);
        const at = (originOnCurve: boolean) => resolvePlane({ planeRef: 'p' }, [
            ...base, { id: 'p', op: 'plane', definition: { kind: 'curveNormal', curve: { curveRef: 'coil' }, point: off, ...(originOnCurve ? { originOnCurve } : {}) } },
        ]);
        close(at(false).origin, off);
        close(at(true).origin, frame.point);
        close(at(true).normal, at(false).normal);
    });

    it('works on a flat spiral, its X towards the centre in the spiral\'s plane', () => {
        const f: Feature[] = [
            spring()[0],
            { id: 'coil', op: 'helix', sketchRef: 'ring', definedBy: 'spiral', pitch: 3, revolutions: 2 },
            { id: 'p', op: 'plane', definition: { kind: 'curveNormal', curve: { curveRef: 'coil' }, point: { curveRef: 'coil', at: 'end' } } },
        ];
        const plane = resolvePlane({ planeRef: 'p' }, f);
        close(plane.origin, [16, 0, 0]);
        expect(plane.normal[1]).toBeCloseTo(0, 12);
        expect(plane.xDir[1]).toBeCloseTo(0, 12);
        expect(dot(plane.xDir, [-1, 0, 0])).toBeGreaterThan(0.99);
    });
});
