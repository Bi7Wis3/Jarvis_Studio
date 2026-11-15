import { describe, expect, it } from 'vitest';
import type { Vec3 } from './index';
import { joinCurves, oneSimpleCurve, simplestPieces, type BezierPiece } from './curveKinds';
import { projectConic, spaceCircle, splineCurves, type ModelCurve, type P2, type PlaneFrame3 } from './projection';

/** Bernstein basis value. */
function bernstein(n: number, i: number, t: number): number {
    let c = 1;
    for (let k = 0; k < i; k++) {
        c = (c * (n - k)) / (k + 1);
    }
    return c * t ** i * (1 - t) ** (n - i);
}

/** The degree-n Bezier through f at n + 1 Chebyshev points (ends included), as the kernel approximates a curve. */
function interpolant<T extends number[]>(n: number, f: (t: number) => T): T[] {
    const ts = Array.from({ length: n + 1 }, (_, i) => (1 - Math.cos((Math.PI * i) / n)) / 2);
    const m = ts.map((t) => Array.from({ length: n + 1 }, (_, j) => bernstein(n, j, t)));
    const dims = f(0).length;
    const rhs = ts.map((t) => f(t));
    // Gaussian elimination on [m | rhs].
    const a = m.map((row, i) => [...row, ...rhs[i]]);
    for (let col = 0; col <= n; col++) {
        let p = col;
        for (let r = col + 1; r <= n; r++) {
            if (Math.abs(a[r][col]) > Math.abs(a[p][col])) {
                p = r;
            }
        }
        [a[col], a[p]] = [a[p], a[col]];
        for (let r = 0; r <= n; r++) {
            if (r !== col) {
                const k = a[r][col] / a[col][col];
                for (let c = col; c < a[r].length; c++) {
                    a[r][c] -= k * a[col][c];
                }
            }
        }
    }
    return a.map((row, i) => row.slice(n + 1, n + 1 + dims).map((x) => x / row[i]) as T);
}

const polynomial = (poles: P2[]): BezierPiece => ({ poles, weights: poles.map(() => 1) });
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A quarter arc of radius 10.72 about (-0.024, 82.69) as a degree 8 polynomial, like the end of the owner's loft. */
const C: P2 = [-0.024325, 82.689468];
const R = 10.721406;
const quarter = (bump = 0) => interpolant(8, (t) => {
    const a = (Math.PI / 2) * t;
    // A wave the circle through the ends cannot take up: out, then in.
    const r = R + bump * Math.sin(2 * Math.PI * t);
    return [C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)] as P2;
});

describe('a spline that is really a line or a circle', () => {
    it('a degree 8 spline with its poles along a line is that line, end to end', () => {
        const poles: P2[] = [0, 0.05, 0.2, 0.31, 0.5, 0.62, 0.8, 0.97, 1].map((t) => [10.697081, 82.689468 - 24.979741387 * t]);
        expect(oneSimpleCurve([polynomial(poles)])).toEqual({ kind: 'line', a: [10.697081, 82.689468], b: [10.697081, 57.709726613] });
    });

    it('a polynomial quarter arc is an arc, counter-clockwise whichever way it runs', () => {
        const poles = quarter();
        const arc = oneSimpleCurve([polynomial(poles)]);
        expect(arc?.kind).toBe('arc');
        if (arc?.kind === 'arc') {
            expect(dist(arc.center, C)).toBeLessThan(1e-8);
            expect(arc.start).toEqual([C[0] + R, C[1]].map((x) => Math.round(x * 1e9) / 1e9));
            expect(dist(arc.end, [C[0], C[1] + R])).toBeLessThan(1e-9);
        }
        expect(oneSimpleCurve([polynomial([...poles].reverse())])).toEqual(arc);
    });

    it('accepts within 1e-6 mm and no more: 4e-7 off the circle is an arc, 1e-5 off is a spline', () => {
        expect(oneSimpleCurve([polynomial(quarter(4e-7))])?.kind).toBe('arc');
        expect(oneSimpleCurve([polynomial(quarter(1e-5))])).toBeNull();
        // The same edge with the kernel's looser tolerance of an intersection curve.
        expect(oneSimpleCurve([polynomial(quarter(4e-6))], 5e-6)?.kind).toBe('arc');
    });

    it('a rational quarter circle is an arc, a whole rational circle a circle', () => {
        const w = Math.SQRT1_2;
        expect(splineCurves({ poles: [[1, 0], [1, 1], [0, 1]], weights: [1, w, 1], knots: [0, 0, 0, 1, 1, 1], degree: 2 }))
            .toEqual([{ kind: 'arc', center: [0, 0], start: [1, 0], end: [0, 1] }]);
        const poles: P2[] = [[5, 0], [5, 5], [0, 5], [-5, 5], [-5, 0], [-5, -5], [0, -5], [5, -5], [5, 0]];
        const weights = poles.map((_, i) => (i % 2 ? w : 1));
        const knots = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];
        const translated = poles.map(([x, y]) => [x + 3, y - 2] as P2);
        expect(splineCurves({ poles: translated, weights, knots, degree: 2 })).toEqual([{ kind: 'circle', center: [3, -2], radius: 5 }]);
        // A rational quadratic that is not round stays a conic.
        expect(splineCurves({ poles: [[1, 0], [1, 1], [0, 1]], weights: [1, 2, 1], knots: [0, 0, 0, 1, 1, 1], degree: 2 })?.[0].kind).toBe('conic');
    });

    it('a free-form spline stays a spline', () => {
        const poles: P2[] = [[0, 0], [1, 2], [3, 3], [4, 0], [6, -1]];
        expect(splineCurves({ poles, weights: null, knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1], degree: 3 })).toEqual([{ kind: 'bspline', poles, degree: 3 }]);
        expect(oneSimpleCurve([polynomial([[0, 0], [2, 3], [5, -1], [8, 2]])])).toBeNull();
    });

    it('a spline seen end-on is nothing', () => {
        expect(splineCurves({ poles: [[30, 0], [30, 0], [30, 0]], weights: null, knots: [0, 0, 0, 1, 1, 1], degree: 2 })).toEqual([]);
    });
});

describe('pieces of one spline', () => {
    it('a line, a quarter arc and a line in one spline come out as those three', () => {
        const w = Math.SQRT1_2;
        const poles: P2[] = [[0, 0], [5, 0], [10, 0], [15, 0], [15, 5], [15, 10], [15, 15]];
        const curves = splineCurves({ poles, weights: [1, 1, 1, w, 1, 1, 1], knots: [0, 0, 0, 1, 1, 2, 2, 3, 3, 3], degree: 2 });
        expect(curves).toEqual([
            { kind: 'line', a: [0, 0], b: [10, 0] },
            { kind: 'arc', center: [10, 5], start: [10, 0], end: [15, 5] },
            { kind: 'line', a: [15, 5], b: [15, 15] },
        ]);
    });

    it('consecutive pieces of one line or one arc join into one', () => {
        const pieces = [
            polynomial([[0, 0], [1, 0], [2, 0], [3, 0]]),
            polynomial([[3, 0], [4, 0], [6, 0], [7, 0]]),
            polynomial([[7, 0], [8, 2], [9, -1], [10, 3]]),
            polynomial([[10, 3], [10, 4], [10, 5], [10, 6]]),
        ];
        expect(simplestPieces(pieces)).toEqual([
            { kind: 'line', a: [0, 0], b: [7, 0] },
            { kind: 'bezier', poles: [[7, 0], [8, 2], [9, -1], [10, 3]] },
            { kind: 'line', a: [10, 3], b: [10, 6] },
        ]);
        // Two halves of one quarter arc.
        const half = (from: number, to: number) => interpolant(6, (t) => {
            const a = from + (to - from) * t;
            return [R * Math.cos(a), R * Math.sin(a)] as P2;
        });
        const [arc] = simplestPieces([polynomial(half(0, Math.PI / 4)), polynomial(half(Math.PI / 4, Math.PI / 2))])!;
        expect(arc).toMatchObject({ kind: 'arc', start: [R, 0], end: [0, R] });
        expect(arc.kind === 'arc' && dist(arc.center, [0, 0])).toBeLessThan(1e-8);
    });
});

describe('joining the curves of a loop', () => {
    it('joins two lines of one line, and two arcs of one circle into the circle', () => {
        const lines: ModelCurve[] = [{ kind: 'line', a: [0, 0], b: [4, 0] }, { kind: 'line', a: [10, 0], b: [4, 0] }, { kind: 'line', a: [10, 0], b: [10, 5] }];
        expect(joinCurves(lines)).toEqual([{ kind: 'line', a: [0, 0], b: [10, 0] }, { kind: 'line', a: [10, 0], b: [10, 5] }]);
        const halves: ModelCurve[] = [
            { kind: 'arc', center: [1, 1], start: [6, 1], end: [-4, 1] },
            { kind: 'arc', center: [1, 1], start: [-4, 1], end: [6, 1] },
        ];
        expect(joinCurves(halves)).toEqual([{ kind: 'circle', center: [1, 1], radius: 5 }]);
        const quarters: ModelCurve[] = [
            { kind: 'arc', center: [0, 0], start: [5, 0], end: [0, 5] },
            { kind: 'arc', center: [0, 0], start: [0, 5], end: [-5, 0] },
        ];
        expect(joinCurves(quarters)).toEqual([{ kind: 'arc', center: [0, 0], start: [5, 0], end: [-5, 0] }]);
    });

    it('leaves a corner, a third curve at the meeting point, other loops and other circles alone', () => {
        const t: ModelCurve[] = [{ kind: 'line', a: [0, 0], b: [4, 0] }, { kind: 'line', a: [4, 0], b: [8, 0] }, { kind: 'line', a: [4, 0], b: [4, 3] }];
        expect(joinCurves(t)).toEqual(t);
        const loops = [{ kind: 'line', a: [0, 0], b: [4, 0], loop: 0 }, { kind: 'line', a: [4, 0], b: [8, 0], loop: 1 }] as (ModelCurve & { loop: number })[];
        expect(joinCurves(loops, 1e-6, (c) => String(c.loop))).toEqual(loops);
        // Two faces' loops meeting at a corner: each loop joins on its own.
        const faces = [
            { kind: 'line', a: [0, 0], b: [4, 0], face: 0 }, { kind: 'line', a: [4, 0], b: [8, 0], face: 0 },
            { kind: 'line', a: [4, 0], b: [4, 5], face: 1 }, { kind: 'line', a: [4, 5], b: [4, 9], face: 1 },
        ] as (ModelCurve & { face: number })[];
        expect(joinCurves(faces, 1e-6, (c) => String(c.face))).toEqual([
            { kind: 'line', a: [0, 0], b: [8, 0], face: 0 }, { kind: 'line', a: [4, 0], b: [4, 9], face: 1 },
        ]);
        const two: ModelCurve[] = [
            { kind: 'arc', center: [0, 0], start: [5, 0], end: [0, 5] },
            { kind: 'arc', center: [0, 10], start: [0, 5], end: [-5, 10] },
        ];
        expect(joinCurves(two)).toEqual(two);
    });
});

describe('a circle in space', () => {
    // A quarter circle of radius 6 about (1, 2, 3) in a plane tilted 40 degrees, as a degree 8 polynomial.
    const T = (40 * Math.PI) / 180;
    const e1: Vec3 = [1, 0, 0];
    const e2: Vec3 = [0, Math.cos(T), Math.sin(T)];
    const arc3 = interpolant(8, (t) => {
        const a = (Math.PI / 2) * t;
        return [0, 1, 2].map((i) => [1, 2, 3][i] + 6 * (Math.cos(a) * e1[i] + Math.sin(a) * e2[i])) as Vec3;
    });
    const knots = [...Array(9).fill(0), ...Array(9).fill(1)];
    const top: PlaneFrame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };

    it('is found, and seen at a tilt projects as the exact elliptical arc', () => {
        const round = spaceCircle(arc3, null, knots, 8);
        expect(round).not.toBeNull();
        expect(Math.hypot(...round!.X)).toBeCloseTo(6, 8);
        expect(round!.sweep).toBeCloseTo(Math.PI / 2, 8);
        const e = projectConic(top, round!.centre, round!.X, round!.Y, 0, round!.sweep, false);
        expect(e?.kind).toBe('ellipseArc');
        if (e?.kind === 'ellipseArc') {
            expect(dist(e.center, [1, 2])).toBeLessThan(1e-8);
            expect(Math.hypot(e.major[0] - e.center[0], e.major[1] - e.center[1])).toBeCloseTo(6, 8);
            expect(e.minor).toBeCloseTo(6 * Math.cos(T), 8);
        }
    });

    it('a curve out of one plane, or flat but not round, is not one', () => {
        const helix = interpolant(8, (t) => [Math.cos(3 * t), Math.sin(3 * t), 2 * t] as Vec3);
        expect(spaceCircle(helix, null, knots, 8)).toBeNull();
        const wave = interpolant(8, (t) => [10 * t, Math.sin(3 * t), 0] as Vec3);
        expect(spaceCircle(wave, null, knots, 8)).toBeNull();
    });
});
