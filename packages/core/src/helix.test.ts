import { describe, expect, it } from 'vitest';
import type { Feature, Sketch, Vec3 } from './index.js';
import {
    helixCircle, helixDerivatives, helixLength, helixOfStep, helixPoint, helixRows, helixShape, helixSummary, type HelixOptions,
} from './helix.js';
import { sketchFrameOf } from './reference.js';

const close = (a: Vec3, b: Vec3, digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A circle of radius 10 at (5, 0) on the top plane: the axis is vertical through (5, 0, 0), u = +X, v = -Z.
const top = sketchFrameOf({ plane: 'top' }, []);
const circle = { centre: [5, 0] as [number, number], radius: 10 };
const shape = (o: HelixOptions) => helixShape(o, circle, top);
const helixLengthOf = (radius: number, pitch: number, turns: number) => turns * Math.hypot(2 * Math.PI * radius, pitch);

describe('helix and spiral curves', () => {
    it('gives the height, revolutions and length of each Defined by mode', () => {
        const cases: [HelixOptions, number, number][] = [
            [{ definedBy: 'pitchRevolution', pitch: 4, revolutions: 10 }, 40, 10],
            [{ definedBy: 'heightRevolution', height: 30, revolutions: 6 }, 30, 6],
            [{ definedBy: 'heightPitch', height: 25, pitch: 2 }, 25, 12.5],
        ];
        for (const [o, height, turns] of cases) {
            const s = shape(o);
            expect(s.height).toBeCloseTo(height, 12);
            expect(s.revolutions).toBeCloseTo(turns, 12);
            expect(helixLength(s)).toBeCloseTo(helixLengthOf(10, height / turns, turns), 9);
            // Starts on the circle at the start angle (0: along u) and ends right above it after whole turns.
            close(helixPoint(s, 0), [15, 0, 0]);
            const end = helixPoint(s, s.revolutions);
            expect(end[1]).toBeCloseTo(height, 9);
            expect(Math.hypot(end[0] - 5, end[2])).toBeCloseTo(10, 9);
        }
    });

    it('works out a variable pitch table, joining smoothly at its rows', () => {
        // A compression spring: closed ends (pitch 1) and active coils (pitch 4), as the table's rows.
        const variablePitch = [
            { pitch: 1 }, { pitch: 1, revolutions: 1 }, { pitch: 4, revolutions: 2 }, { pitch: 4, revolutions: 6 },
            { pitch: 1, revolutions: 7 }, { pitch: 1, revolutions: 8 },
        ];
        const s = shape({ definedBy: 'pitchRevolution', variablePitch });
        // Height: 1 + (1 + 4) / 2 + 4 x 4 + 2.5 + 1 = 23 over 8 revolutions.
        expect(s.rows!.map((r) => r.height)).toEqual([0, 1, 3.5, 19.5, 22, 23]);
        expect(s.height).toBeCloseTo(23, 12);
        expect(s.revolutions).toBe(8);
        close(helixPoint(s, 8), [15, 23, 0]);
        // The same table by height and revolution, and by height and pitch, gives the same curve.
        const byHeight = helixRows('heightRevolution', s.rows!.map((r, i) => (i ? { height: r.height, revolutions: r.revolutions } : { pitch: 1 })), 20);
        expect(byHeight.map((r) => r.pitch)).toEqual([1, 1, 4, 4, 1, 1]);
        const byPitch = helixRows('heightPitch', s.rows!.map((r, i) => (i ? { height: r.height, pitch: r.pitch } : { pitch: 1 })), 20);
        byPitch.forEach((r, i) => expect(r.revolutions).toBeCloseTo(s.rows![i].revolutions, 12));
        // The tangent is the same either side of every row, and the speed of rising is the row's pitch.
        for (let i = 1; i < s.pieces.length; i++) {
            const t = s.pieces[i].t0;
            const before = helixDerivatives(s, t, 1, s.pieces[i - 1]);
            const after = helixDerivatives(s, t, 1, s.pieces[i]);
            close(before[0], after[0]);
            close(before[1], after[1]);
            expect(after[1][1]).toBeCloseTo(s.rows![i].pitch, 9);
        }
        // Length: integrated against a fine polyline.
        let polyline = 0;
        const n = 200000;
        for (let i = 0; i < n; i++) {
            polyline += Math.hypot(...sub(helixPoint(s, (8 * (i + 1)) / n), helixPoint(s, (8 * i) / n)));
        }
        expect(helixLength(s) / polyline).toBeCloseTo(1, 8);
    });

    it('changes the diameter smoothly through the rows, never beyond them', () => {
        const s = shape({ definedBy: 'pitchRevolution', variablePitch: [{ pitch: 3 }, { pitch: 3, revolutions: 2, diameter: 20 }, { pitch: 3, revolutions: 4, diameter: 40 }, { pitch: 3, revolutions: 6, diameter: 40 }] });
        expect(s.endDiameter).toBe(40);
        for (let t = 0; t <= 6; t += 0.01) {
            const p = helixPoint(s, t);
            const r = Math.hypot(p[0] - 5, p[2]);
            expect(r).toBeGreaterThanOrEqual(10 - 1e-9);
            expect(r).toBeLessThanOrEqual(20 + 1e-9);
        }
        const at = (t: number) => { const p = helixPoint(s, t); return Math.hypot(p[0] - 5, p[2]); };
        expect(at(2)).toBeCloseTo(10, 9);
        expect(at(4)).toBeCloseTo(20, 9);
        expect(at(5)).toBeCloseTo(20, 9);
    });

    it('tapers a constant pitch helix inward, or outward', () => {
        const angle = 10;
        const inward = shape({ definedBy: 'pitchRevolution', pitch: 5, revolutions: 4, taper: angle });
        expect(inward.endDiameter).toBeCloseTo(20 - 2 * 20 * Math.tan((angle * Math.PI) / 180), 12);
        const end = helixPoint(inward, 4);
        expect(Math.hypot(end[0] - 5, end[2])).toBeCloseTo(10 - 20 * Math.tan((angle * Math.PI) / 180), 9);
        const outward = shape({ definedBy: 'heightRevolution', height: 20, revolutions: 4, taper: angle, taperOutward: true });
        expect(outward.endDiameter).toBeCloseTo(20 + 2 * 20 * Math.tan((angle * Math.PI) / 180), 12);
        // On the cone the slant is the pitch over cos(angle) per turn, the girth that of the mean radius.
        const mean = 10 + 10 * Math.tan((angle * Math.PI) / 180);
        expect(helixLength(outward) / helixLengthOf(mean, 5, 4)).toBeCloseTo(1, 3);
        expect(() => shape({ definedBy: 'pitchRevolution', pitch: 10, revolutions: 10, taper: 45 })).toThrow(/taper closes/);
        expect(() => shape({ definedBy: 'spiral', pitch: 1, revolutions: 2, taper: 5 })).toThrow(/constant pitch helix/);
    });

    it('makes a flat spiral, outward or inward', () => {
        const s = shape({ definedBy: 'spiral', pitch: 2, revolutions: 3 });
        expect(s.height).toBe(0);
        expect(s.endDiameter).toBe(32);
        for (let t = 0; t <= 3; t += 0.125) {
            const p = helixPoint(s, t);
            expect(p[1]).toBeCloseTo(0, 12);
            expect(Math.hypot(p[0] - 5, p[2])).toBeCloseTo(10 + 2 * t, 9);
        }
        // Archimedean spiral length: the integral of sqrt(r^2 + (dr/da)^2) da.
        let exact = 0;
        const n = 100000;
        for (let i = 0; i < n; i++) {
            const a = ((i + 0.5) / n) * 6 * Math.PI;
            const r = 10 + (2 * a) / (2 * Math.PI);
            exact += Math.hypot(r, 2 / (2 * Math.PI)) * ((6 * Math.PI) / n);
        }
        expect(helixLength(s) / exact).toBeCloseTo(1, 8);
        const inward = shape({ definedBy: 'spiral', pitch: 2, revolutions: 3, reverse: true });
        expect(inward.endDiameter).toBe(8);
        expect(() => shape({ definedBy: 'spiral', pitch: 2, revolutions: 5, reverse: true })).toThrow(/runs into its centre/);
    });

    it('starts at the start angle and turns as set, reversed below the sketch', () => {
        const ccw = shape({ definedBy: 'pitchRevolution', pitch: 4, revolutions: 2, startAngle: 90 });
        // 90 degrees from u (+X) towards v (-Z).
        close(helixPoint(ccw, 0), [5, 0, -10]);
        // Counterclockwise seen from above (+Y): the turn about +Y is positive, and it rises: a right-hand helix.
        const [p, d] = helixDerivatives(ccw, 0, 1);
        const radial = sub(p, [5, p[1], 0]);
        expect(dot(cross(radial, d), [0, 1, 0])).toBeGreaterThan(0);
        expect(d[1]).toBeGreaterThan(0);
        const cw = shape({ definedBy: 'pitchRevolution', pitch: 4, revolutions: 2, startAngle: 90, clockwise: true });
        const [q, e] = helixDerivatives(cw, 0, 1);
        expect(dot(cross(sub(q, [5, q[1], 0]), e), [0, 1, 0])).toBeLessThan(0);
        const down = shape({ definedBy: 'pitchRevolution', pitch: 4, revolutions: 2, reverse: true });
        expect(helixPoint(down, 2)[1]).toBeCloseTo(-8, 12);
        // A quarter turn counterclockwise from u lands on v.
        close(helixPoint(shape({ definedBy: 'pitchRevolution', pitch: 4, revolutions: 2 }), 0.25), [5, 1, -10]);
        close(helixPoint(shape({ definedBy: 'pitchRevolution', pitch: 4, revolutions: 2, clockwise: true }), 0.25), [5, 1, 10]);
    });

    it('takes the one circle of its sketch, by reference and with its plane', () => {
        const sketch: Sketch = { plane: 'front', offset: 2, profiles: [{ kind: 'circle', center: [0, 3], radius: 4 }] };
        const features: Feature[] = [
            { id: 's', op: 'sketch', sketch },
            { id: 'h', op: 'helix', sketchRef: 's', definedBy: 'pitchRevolution', pitch: 1, revolutions: 1 },
        ];
        const s = helixOfStep(features[1] as Extract<Feature, { op: 'helix' }>, features.slice(0, 1));
        close(s.centre, [0, 3, 2]);
        close(s.axis, [0, 0, 1]);
        close(helixPoint(s, 1), [4, 3, 3]);
        expect(() => helixCircle({ profiles: [] })).toThrow(/needs a circle/);
        expect(() => helixCircle({ profiles: [{ kind: 'circle', center: [0, 0], radius: 1 }, { kind: 'circle', center: [5, 0], radius: 1 }] }))
            .toThrow(/2 circles/);
        expect(() => helixCircle({ profiles: [{ kind: 'circle', center: [0, 0], radius: 1 }, { kind: 'rect', center: [0, 0], width: 1, height: 1 }] }))
            .toThrow(/more than a circle/);
        expect(helixSummary({ definedBy: 'heightPitch', height: 20, pitch: 2, clockwise: true })).toBe('Helix · height 20 · pitch 2 · clockwise');
    });
});
