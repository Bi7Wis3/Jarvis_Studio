import { describe, expect, it } from 'vitest';
import { ellipseAxes, type P2 } from './curves';
import { closestParam, crossings, domainOf, pointAt, type CurveGeom } from './curveIntersect';
import { bsplineGeom, splineGeom } from './curveSplit';
import { filletFit, geomEval, offsetCurve, offsetEval, pointAtDistance, reversedEval } from './curveOffset';

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Points along an offset piece. */
function samples(piece: ReturnType<typeof offsetCurve>, n = 200): P2[] {
    const p = piece!.piece;
    if (p.kind !== 'spline') {
        return [p.a, p.b];
    }
    const g = splineGeom(p.points, p.closed, { start: p.start, end: p.end });
    const d = domainOf(g);
    return Array.from({ length: n + 1 }, (_, i) => pointAt(g, d.t0 + ((d.t1 - d.t0) * i) / n));
}

const e = ellipseAxes([3, -2], [33, -2], 15);
const cases: [string, CurveGeom, number][] = [
    ['ellipse', { kind: 'ellipse', e }, 3],
    ['ellipse inside', { kind: 'ellipse', e }, -2],
    ['partial ellipse', { kind: 'ellipse', e, from: -0.4, sweep: 2.5 }, 2.5],
    ['parabola', { kind: 'conic', p0: [-8, 5.33], p1: [-1.5, -3.33], p2: [5, 2.08], w: 1 }, -1.5],
    ['conic', { kind: 'conic', p0: [0, 0], p1: [6, 9], p2: [14, 1], w: 0.35 / 0.65 }, 1],
    ['spline', splineGeom([[0, 0], [5, 6], [11, 3], [16, 9], [22, 2]], false), -1],
    ['spline with handles and spacing', splineGeom([[0, 0], [5, 6], [11, 3], [16, 9]], false, { start: [1, 4], end: [14, 7], spacing: [1.1, 0.9, 1.05] }), 0.8],
    ['closed spline', splineGeom([[10, 0], [4, 7], [-6, 5], [-9, -3], [0, -8]], true), 1.5],
    ['style spline', bsplineGeom([[0, 0], [3, 8], [9, 9], [14, -2], [18, 4], [22, 7], [25, 0]], 3), 0.8],
];

describe('offsets of curves that are not lines or arcs', () => {
    for (const [name, g, d] of cases) {
        it(`offsets a ${name} by ${d} as a spline within 0.000001 mm of the true offset`, () => {
            const ev = geomEval(g);
            const fit = offsetCurve(g, ev, d, ev.t0, ev.t0 + (ev.period ?? ev.t1 - ev.t0))!;
            expect(fit.piece.kind).toBe('spline');
            expect(fit.within).toBe(true);
            expect(fit.deviation).toBeLessThanOrEqual(1e-6);
            for (const q of samples(fit)) {
                expect(Math.abs(dist(q, pointAt(g, closestParam(g, q))) - Math.abs(d))).toBeLessThan(2e-6);
            }
        });
    }

    it('keeps lines and arcs exact, refuses an arc turned inside out, and offsets a curve run backward the other way', () => {
        const line: CurveGeom = { kind: 'line', a: [0, 0], b: [10, 4] };
        expect(offsetCurve(line, geomEval(line), 2, 0, 1)!.piece.kind).toBe('line');
        const arc: CurveGeom = { kind: 'circle', c: [1, 2], r: 7, from: 0.3, sweep: 2.1 };
        const ae = geomEval(arc);
        const fit = offsetCurve(arc, ae, 2, ae.t0, ae.t1)!.piece as Extract<ReturnType<typeof offsetCurve>, object>['piece'] & { kind: 'arc' };
        expect(fit.r).toBeCloseTo(5, 12);
        expect(offsetCurve(arc, ae, 8, ae.t0, ae.t1)).toBeNull();
        const back = reversedEval(ae);
        expect(dist(offsetEval(back, 2).at(back.t0), offsetEval(ae, -2).at(ae.t1))).toBeLessThan(1e-12);
    });
});

describe('fillets and chamfers between any two curves', () => {
    it('rounds a line and a spline with an arc tangent to both, its touch points on them', () => {
        const spline = splineGeom([[0, 0], [6, 5], [12, 3], [18, 8]], false);
        const line: CurveGeom = { kind: 'line', a: [0, 0], b: [20, -3] };
        const [a, b] = [geomEval(spline), geomEval(line)];
        const fit = filletFit({ ev: a, corner: a.t0, far: a.t1 }, { ev: b, corner: 0, far: 1 }, 2, [0, 0])!;
        expect(fit).not.toBeNull();
        for (const [ev, t] of [[a, fit.t[0]], [b, fit.t[1]]] as const) {
            const p = ev.at(t);
            expect(Math.abs(dist(p, fit.centre) - 2)).toBeLessThan(1e-9);
            const d = ev.d1(t);
            const r: P2 = [p[0] - fit.centre[0], p[1] - fit.centre[1]];
            expect(Math.abs(d[0] * r[0] + d[1] * r[1]) / Math.hypot(...d) / 2).toBeLessThan(1e-9);
        }
        for (const ev of [a, b]) {
            for (let i = 0; i <= 200; i++) {
                expect(dist(ev.at(ev.t0 + ((ev.t1 - ev.t0) * i) / 200), fit.centre)).toBeGreaterThan(2 - 1e-9);
            }
        }
    });

    it('finds a point at a straight distance along a side', () => {
        const ellipse: CurveGeom = { kind: 'ellipse', e };
        const line: CurveGeom = { kind: 'line', a: [-40, 1], b: [40, 1] };
        expect(crossings(ellipse, line)).toHaveLength(2);
        const b = geomEval({ kind: 'line', a: [0, 0], b: [10, 4] });
        const t = pointAtDistance({ ev: b, corner: 0, far: 1 }, [0, 0], 5)!;
        expect(dist(b.at(t), [0, 0])).toBeCloseTo(5, 12);
    });
});
