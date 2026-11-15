import { describe, expect, it } from 'vitest';
import { bsplineAt, conicAt, conicWeight, ellipseAxes, splinePoints, type P2 } from './curves';
import { carrierOf, closestParam, crossings, paramOf, pointAt, type CurveGeom } from './curveIntersect';
import { bsplineGeom, bsplinePiece, conicPiece, splineGeom, splinePiece } from './curveSplit';

const dist = (p: P2, q: P2) => Math.hypot(q[0] - p[0], q[1] - p[1]);
/** Largest distance from the sampled points to the curve. */
const off = (pts: P2[], g: CurveGeom) => Math.max(...pts.map((p) => dist(p, pointAt(g, closestParam(g, p)))));

describe('crossings', () => {
    const circle: CurveGeom = { kind: 'circle', c: [1, 2], r: 5 };
    const ellipse: CurveGeom = { kind: 'ellipse', e: ellipseAxes([0, 0], [10, 0], 4) };
    const conic: CurveGeom = { kind: 'conic', p0: [-8, -6], p1: [0, 14], p2: [8, -6], w: conicWeight(0.45) };
    const spline = splineGeom([[-12, 1], [-4, 5], [3, -2], [11, 2]], false);
    const style = bsplineGeom([[-12, -3], [-6, 6], [0, -6], [6, 6], [12, -3]], 3);

    it('meets lines, circles, ellipses, conics and splines exactly, each point with its parameter on both', () => {
        const all: CurveGeom[] = [{ kind: 'line', a: [-20, 1], b: [20, 0.5] }, circle, ellipse, conic, spline, style];
        for (const a of all) {
            for (const b of all) {
                if (a === b) {
                    continue;
                }
                const hits = crossings(a, b);
                expect(hits.length, `${a.kind} x ${b.kind}`).toBeGreaterThan(0);
                for (const h of hits) {
                    expect(dist(pointAt(a, h.ta), h.at)).toBeLessThan(1e-9);
                    expect(dist(pointAt(b, h.tb), h.at)).toBeLessThan(1e-9);
                }
                // The same points either way round.
                expect(crossings(b, a).length).toBe(hits.length);
            }
        }
    });

    it('finds a line touching a circle, and a line along the axis meeting an ellipse twice', () => {
        const touch = crossings({ kind: 'line', a: [-10, 7], b: [10, 7] }, circle);
        expect(touch).toHaveLength(1);
        expect(dist(touch[0].at, [1, 7])).toBeLessThan(1e-6);
        const axis = crossings({ kind: 'line', a: [0, 0], b: [1, 0], infinite: true }, ellipse);
        const xs = axis.map((h) => h.at[0]).sort((x, y) => x - y);
        expect(xs).toHaveLength(2);
        expect(xs[0]).toBeCloseTo(-10, 12);
        expect(xs[1]).toBeCloseTo(10, 12);
    });

    it('meets the natural paths past the ends: a line extended to a circle, an arc round its circle', () => {
        const line: CurveGeom = { kind: 'line', a: [-20, 2], b: [-15, 2] };
        expect(crossings(line, circle)).toHaveLength(0);
        const ahead = crossings(line, circle, { carrierA: true });
        expect(ahead.map((h) => h.ta).every((t) => t > 1)).toBe(true);
        expect(ahead.map((h) => dist(h.at, [1, 2])).every((d) => Math.abs(d - 5) < 1e-9)).toBe(true);
        const arc: CurveGeom = { kind: 'circle', c: [0, 0], r: 3, from: 0, sweep: Math.PI / 2 };
        const down: CurveGeom = { kind: 'line', a: [0, -5], b: [0, 5] };
        const end = crossings(arc, down);
        expect(end).toHaveLength(1);
        expect(end[0].at[1]).toBeCloseTo(3, 12);
        const round = crossings(arc, down, { carrierA: true });
        expect(round).toHaveLength(2);
        expect(round[0].ta).toBeCloseTo(Math.PI / 2, 12);
        expect(round[1].ta).toBeCloseTo((3 * Math.PI) / 2, 12);
    });

    it('takes a conic round its whole ellipse, but only one branch of a hyperbola', () => {
        expect(carrierOf(conic)!.period).toBe(Math.PI);
        const flat: CurveGeom = { kind: 'line', a: [-30, -9], b: [30, -9] };
        expect(crossings(conic, flat)).toHaveLength(0);
        expect(crossings(conic, flat, { carrierA: true })).toHaveLength(2);
        const hyper: CurveGeom = { kind: 'conic', p0: [-8, -6], p1: [0, 14], p2: [8, -6], w: conicWeight(0.8) };
        const far = crossings(hyper, flat, { carrierA: true });
        expect(far).toHaveLength(2);
        far.forEach((h) => expect(h.at[1]).toBeCloseTo(-9, 9));
        // Above the top vertex lies only the other branch.
        expect(crossings(hyper, { kind: 'line', a: [-30, 30], b: [30, 30] }, { carrierA: true })).toHaveLength(0);
    });

    it('gives a conic point its parameter back exactly, inside and past its ends', () => {
        for (const t of [0, 0.3, Math.PI / 2, 2, -0.6]) {
            expect(paramOf(conic, pointAt(conic, t)) - (t < -Math.PI / 4 ? t + Math.PI : t)).toBeCloseTo(0, 12);
        }
    });
});

describe('pieces', () => {
    it('cuts a spline through points into pieces that are the same curve, handles and spacing kept', () => {
        const pts: P2[] = [[0, 0], [10, 6], [18, -2], [30, 4], [36, 12]];
        for (const handles of [{}, { start: [-3, 6] as P2, end: [40, 9] as P2 }]) {
            const whole = splineGeom(pts, false, handles);
            for (const [t0, t1] of [[0, 1.4], [1.4, 4], [0.3, 0.7], [2, 3], [0.5, 3.25]]) {
                const piece = splinePiece(pts, false, handles, t0, t1);
                const through = piece.points.map((p) => (typeof p === 'number' ? pts[p] : p));
                const own = splinePoints(through, false, 40, { start: piece.startHandle, end: piece.endHandle, spacing: piece.spacing });
                expect(off(own, whole)).toBeLessThan(1e-9);
                expect(dist(through[0], pointAt(whole, t0))).toBeLessThan(1e-12);
                expect(dist(through[through.length - 1], pointAt(whole, t1))).toBeLessThan(1e-12);
                // A piece cut again stays exact.
                const again = splinePiece(through, false, { start: piece.startHandle, end: piece.endHandle, spacing: piece.spacing }, 0.25, through.length - 1.5);
                const twice = splinePoints(again.points.map((p) => (typeof p === 'number' ? through[p] : p)), false, 40, { start: again.startHandle, end: again.endHandle, spacing: again.spacing });
                expect(off(twice, whole)).toBeLessThan(1e-9);
            }
        }
    });

    it('opens a closed spline between two cuts, round past its first point', () => {
        const pts: P2[] = [[10, 0], [4, 7], [-6, 5], [-9, -3], [0, -8], [10, 0]];
        const whole = splineGeom(pts, true);
        const piece = splinePiece(pts, true, {}, 3.6, 6.3);
        expect(piece.points.filter((p) => typeof p === 'number')).toEqual([4, 0, 1]);
        const through = piece.points.map((p) => (typeof p === 'number' ? pts[p] : p));
        const own = splinePoints(through, false, 40, { start: piece.startHandle, end: piece.endHandle, spacing: piece.spacing });
        expect(off(own, whole)).toBeLessThan(1e-9);
    });

    it('cuts Bezier and B-spline style splines into pieces of the same degree that are the same curve', () => {
        const poles: P2[] = [[-14, 6], [-4, 14], [6, 2], [12, 15], [16, 4], [22, 9], [28, 0]];
        for (const degree of [6, 3, 5]) {
            const whole = bsplineGeom(poles, degree);
            for (const [t0, t1] of [[0, 0.37], [0.37, 1], [0.1, 0.8], [0.25, 0.5]]) {
                const piece = bsplinePiece(poles, degree, undefined, t0, t1);
                const d = degree === 6 ? piece.poles.length - 1 : degree;
                const own = Array.from({ length: 81 }, (_, i) => bsplineAt(piece.poles, d, i / 80, piece.knots));
                expect(off(own, whole)).toBeLessThan(1e-9);
                expect(dist(own[0], pointAt(whole, t0))).toBeLessThan(1e-9);
                expect(dist(own[80], pointAt(whole, t1))).toBeLessThan(1e-9);
                if (degree !== 6) {
                    expect(piece.poles.length).toBeGreaterThan(degree);
                }
            }
        }
    });

    it('cuts a conic into conics, and lengthens it along itself until its ends would turn half a turn', () => {
        const g: Extract<CurveGeom, { kind: 'conic' }> = { kind: 'conic', p0: [-8, -6], p1: [0, 9], p2: [8, -6], w: conicWeight(0.35) };
        const offPath = (pts: P2[]) => Math.max(...pts.map((p) => dist(p, pointAt(g, paramOf(g, p)))));
        for (const [t0, t1] of [[0, 0.6], [0.6, Math.PI / 2], [0.2, 1.1], [-0.3, Math.PI / 2 + 0.2]]) {
            const piece = conicPiece(g, t0, t1)!;
            expect(piece.rho).toBeGreaterThan(0);
            expect(piece.rho).toBeLessThan(1);
            const own = Array.from({ length: 41 }, (_, i) => conicAt(piece.start, piece.apex, piece.end, piece.rho, i / 40));
            expect(offPath(own)).toBeLessThan(1e-9);
            expect(dist(piece.start, pointAt(g, t0))).toBeLessThan(1e-9);
        }
        expect(conicPiece(g, -1.2, Math.PI / 2 + 1.2)).toBeNull();
    });
});
