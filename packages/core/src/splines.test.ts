import { describe, expect, it } from 'vitest';
import { reverseSegment, segmentPoints, splineBezier } from './curves';
import {
    bsplineAsPieces, cubicPieces, curvatureComb, inflectionPoints, innerKnots, minimumRadius, nurbsAt, nurbsPieces, pieceCurvature,
    pieceDerivatives, piecesLength, solveSpline, splineAsBSpline, splitPiece, type P2,
} from './splines';

const pts: P2[] = [[0, 0], [10, 8], [20, -2], [32, 6], [40, 0]];
const near = (a: P2, b: P2, digits = 9) => {
    expect(a[0]).toBeCloseTo(b[0], digits);
    expect(a[1]).toBeCloseTo(b[1], digits);
};
/** Curvature at the end of piece i - 1 and at the start of piece i. */
const sides = (poles: P2[], i: number): [number, number] => {
    const pieces = cubicPieces(poles);
    return [pieceCurvature(pieces[i - 1], 1), pieceCurvature(pieces[i], 0)];
};
const accel = (poles: P2[], spans: number[], i: number): [P2, P2] => {
    const pieces = cubicPieces(poles);
    const l = pieceDerivatives(pieces[i - 1], 1).d2;
    const r = pieceDerivatives(pieces[i], 0).d2;
    return [[l[0] / spans[i - 1] ** 2, l[1] / spans[i - 1] ** 2], [r[0] / spans[i] ** 2, r[1] / spans[i] ** 2]];
};

describe('spline through points', () => {
    it('runs through its points, C2 inside and straight at free ends', () => {
        const { poles, spans } = solveSpline(pts);
        pts.forEach((p, i) => near(poles[3 * i], p, 12));
        for (let i = 1; i < pts.length - 1; i++) {
            const [l, r] = accel(poles, spans, i);
            near(l, r, 9);
        }
        expect(pieceCurvature(cubicPieces(poles)[0], 0)).toBeCloseTo(0, 9);
    });

    it('takes a handle at an inner point: its control points as given, the weights of each side apart', () => {
        // In line with the point (20, -2), with two different lengths each side.
        const k = { at: 2, prev: [20 - 3, -2 + 0.375 * 3] as P2, next: [20 + 6, -2 - 0.375 * 6] as P2 };
        const { poles } = solveSpline(pts, false, { inner: [k] });
        near(poles[5], k.prev, 12);
        near(poles[7], k.next, 12);
    });

    it('holds a curvature at a handle on both sides, and keeps the curve curvature continuous next to it', () => {
        const base = solveSpline(pts).poles;
        const k = { at: 2, prev: base[5], next: base[7] };
        const r = solveSpline(pts, false, { inner: [k], curvature: [{ at: 2, value: 0.05 }] });
        expect(r.unmet).toEqual([]);
        const [l, rr] = sides(r.poles, 2);
        expect(l).toBeCloseTo(0.05, 9);
        expect(rr).toBeCloseTo(0.05, 9);
        // The points either side that gave the freedom stay curvature continuous.
        for (const i of [1, 3]) {
            const [a, b] = sides(r.poles, i);
            expect(a).toBeCloseTo(b, 9);
        }
    });

    it('keeps the curvature continuous across a handle with Maintain internal continuity, and not without', () => {
        const k = { at: 2, prev: [16, -2] as P2, next: [26, -2] as P2 };
        const off = solveSpline(pts, false, { inner: [k] });
        const [a, b] = sides(off.poles, 2);
        expect(Math.abs(a - b)).toBeGreaterThan(1e-4);
        const on = solveSpline(pts, false, { inner: [k], continuity: true });
        const [c, d] = sides(on.poles, 2);
        expect(c).toBeCloseTo(d, 9);
        near(on.poles[5], k.prev, 12);
    });

    it('says when a held curvature has no free point to take its freedom from', () => {
        const two: P2[] = [[0, 0], [10, 0]];
        const r = solveSpline(two, false, { start: [3, 3], end: [7, 3], curvature: [{ at: 0, value: 0.1 }] });
        expect(r.unmet).toEqual([0]);
        // One free point that would have to run far away to give it: not held, and the spline stays tame.
        const run: P2[] = [[-14, 0], [-4, 10], [4, 7], [10, 3], [14, 0]];
        const shape = { start: [-12, 4] as P2, inner: [{ at: 2, prev: [1, 8.5] as P2, next: [7, 5.5] as P2 }], continuity: true, spacing: [0.95, 1.05, 1, 1.1] };
        const wild = solveSpline(run, false, { ...shape, curvature: [{ at: 2, value: -0.05 }] });
        expect(wild.unmet).toContain(2);
        expect(Math.max(...wild.poles.map((p) => Math.hypot(p[0], p[1])))).toBeLessThan(40);
        const held = solveSpline(run, false, { ...shape, curvature: [{ at: 2, value: -0.03 }] });
        expect(held.unmet).toEqual([]);
        expect(pieceCurvature(cubicPieces(held.poles)[2], 0)).toBeCloseTo(-0.03, 9);
    });

    it('spaces its pieces by the stored spacing (parameter length over chord)', () => {
        const spacing = [1, 3, 1, 2];
        const r = solveSpline(pts, false, { spacing });
        r.spans.forEach((h, i) => expect(h).toBeCloseTo(spacing[i] * Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]), 12));
        for (let i = 1; i < pts.length - 1; i++) {
            const [l, rr] = accel(r.poles, r.spans, i);
            near(l, rr, 9);
        }
    });

    it('reverses with its handles, curvatures and spans: the same curve run the other way', () => {
        const base = solveSpline(pts).poles;
        const seg = {
            kind: 'spline' as const, to: pts[4], through: pts.slice(1, 4),
            handles: [{ at: 1, prev: base[2], next: base[4] }], curvature: [{ at: 1, value: 0.02 }], spacing: [1.2, 0.9, 1, 1.3],
        };
        const fwd = [pts[0], ...segmentPoints(pts[0], seg, 64)];
        const back = [pts[4], ...segmentPoints(pts[4], reverseSegment(pts[0], seg), 64)].reverse();
        // A held curvature is met by an iterated least squares solve: either way round to well within 0.000001 mm.
        fwd.forEach((p, i) => near(p, back[i], 7));
    });
});

describe('curvature', () => {
    it('finds the inflection of an S and the tightest radius of a circular arc', () => {
        const s: P2[] = [[0, 0], [10, 10], [20, 0], [30, -10], [40, 0]];
        const inf = inflectionPoints(cubicPieces(splineBezier(s)));
        expect(inf.length).toBe(1);
        expect(inf[0].at[0]).toBeCloseTo(20, 6);
        // A quarter circle of radius 7 as a rational quadratic: the radius is 7 all along.
        const w = Math.SQRT1_2;
        const quarter = { poles: [[7, 0], [7, 7], [0, 7]] as P2[], weights: [1, w, 1] };
        const m = minimumRadius([quarter])!;
        expect(m.radius).toBeCloseTo(7, 9);
        near(m.centre, [0, 0], 9);
        expect(inflectionPoints([quarter])).toEqual([]);
    });

    it('draws the comb away from the centre of curvature, as long as the curvature times the scale', () => {
        const w = Math.SQRT1_2;
        const quarter = { poles: [[7, 0], [7, 7], [0, 7]] as P2[], weights: [1, w, 1] };
        const { teeth } = curvatureComb([quarter], 5, 14);
        for (const [a, b] of teeth) {
            expect(Math.hypot(a[0], a[1])).toBeCloseTo(7, 9);
            expect(Math.hypot(b[0], b[1])).toBeCloseTo(9, 9);
        }
    });

    it('measures a length', () => {
        const w = Math.SQRT1_2;
        expect(piecesLength([{ poles: [[7, 0], [7, 7], [0, 7]], weights: [1, w, 1] }])).toBeCloseTo((7 * Math.PI) / 2, 9);
        expect(piecesLength([{ poles: [[0, 0], [3, 4]] }])).toBeCloseTo(5, 12);
    });
});

describe('B-splines', () => {
    it('cuts a B-spline into its Bezier pieces, the same curve', () => {
        const cv: P2[] = [[0, 0], [5, 9], [12, 9], [16, -3], [24, 4], [30, 0]];
        const inner = [0.2, 0.7];
        const weights = [1, 2, 0.5, 1, 1.5, 1];
        const { pieces, breaks } = nurbsPieces(cv, 3, inner, weights);
        expect(breaks).toEqual([0, 0.2, 0.7, 1]);
        for (let s = 0; s < pieces.length; s++) {
            for (const f of [0, 0.3, 0.8, 1]) {
                const t = breaks[s] + (breaks[s + 1] - breaks[s]) * f;
                near(pieceDerivatives(pieces[s], f).at, nurbsAt(cv, 3, t, inner, weights), 9);
            }
        }
    });

    it('turns a spline through points into the cubic B-spline that is the same curve, and back', () => {
        const r = solveSpline(pts);
        const b = splineAsBSpline(r.poles, r.spans);
        expect(b.mults).toEqual([4, 1, 1, 1, 4]);
        expect(b.poles.length).toBe(pts.length + 2);
        const pieces = cubicPieces(r.poles);
        const total = r.spans.reduce((x, y) => x + y, 0);
        let u = 0;
        pieces.forEach((p, i) => {
            for (const f of [0, 0.25, 0.5, 1]) {
                near(pieceDerivatives(p, f).at, nurbsAt(b.poles, 3, (u + r.spans[i] * f) / total, innerKnots(b.knots, b.mults, 3)), 8);
            }
            u += r.spans[i];
        });
        const back = bsplineAsPieces(b.poles, b.knots, b.mults);
        back.forEach((p, i) => near(p, r.poles[i], 8));
        // A handle with different weights each side is a double knot.
        const k = { at: 2, prev: [17, -0.875] as P2, next: [26, -4.25] as P2 };
        const r2 = solveSpline(pts, false, { inner: [k] });
        expect(splineAsBSpline(r2.poles, r2.spans).mults).toEqual([4, 1, 3, 1, 4]);
    });

    it('splits a piece into two that are the same curve', () => {
        const piece = { poles: [[0, 0], [3, 8], [9, 8], [12, 0]] as P2[] };
        const [a, b] = splitPiece(piece, 0.3);
        near(pieceDerivatives(a, 1).at, pieceDerivatives(piece, 0.3).at, 12);
        near(pieceDerivatives(b, 0.5).at, pieceDerivatives(piece, 0.65).at, 12);
    });
});
