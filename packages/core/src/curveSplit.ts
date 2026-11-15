// Exact pieces of sketch curves, for the tools that cut them (trim, split) and lengthen them (extend, corner): a
// conic piece is a conic again (its rational quadratic re-parametrised by blossoming), a spline piece a spline
// through the same points that keeps its shape (end handles at the cuts and the parent's parameter spacing), a
// style spline piece a Bezier or B-spline of the same degree (de Casteljau and knot insertion). Ellipse, circle,
// parabola and line pieces only need their new end points. Coordinates are sketch (u, v) in mm.

import { clampedKnots, splineBezier, splineSpans, type P2, type SplineOptions } from './curves';
import { conicBlossom, type BezierPiece, type CurveGeom } from './curveIntersect';

const dist = (p: P2, q: P2): number => Math.hypot(q[0] - p[0], q[1] - p[1]);
const lerp = (p: P2, q: P2, t: number): P2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/** The Bezier curve split at s: the control points of the part before and the part after. */
export function bezierSplit(poles: P2[], s: number): [P2[], P2[]] {
    const left: P2[] = [];
    const right: P2[] = [];
    let row = poles;
    while (row.length) {
        left.push(row[0]);
        right.unshift(row[row.length - 1]);
        row = row.slice(1).map((q, i) => lerp(row[i], q, s));
    }
    return [left, right];
}

/** The same polynomial curve taken from s0 to s1 (any values, past its ends too), by blossoming. */
export function bezierOver(poles: P2[], s0: number, s1: number): P2[] {
    const n = poles.length - 1;
    return Array.from({ length: n + 1 }, (_, i) => {
        // The blossom at (s0 n - i times, s1 i times): de Casteljau with those parameters level by level.
        let row = poles;
        for (let k = 0; k < n; k++) {
            const s = k < n - i ? s0 : s1;
            row = row.slice(1).map((q, j) => lerp(row[j], q, s));
        }
        return row[0];
    });
}

/** The part of a Bezier curve from s0 to s1 (0 ≤ s0 < s1 ≤ 1). */
export function bezierRange(poles: P2[], s0: number, s1: number): P2[] {
    const head = s1 < 1 ? bezierSplit(poles, s1)[0] : poles;
    return s0 > 0 ? bezierSplit(head, s0 / s1)[1] : head;
}

// ---- Splines through points ---------------------------------------------------------------------------------

/** Without the repeated first point of a closed spline. */
function distinct(points: P2[], closed: boolean): P2[] {
    return closed && points.length > 1 && dist(points[0], points[points.length - 1]) < 1e-12 ? points.slice(0, -1) : points;
}

/** A spline through points as Bezier pieces: piece i runs from point i to point i + 1, its parameter from i to i + 1. */
export function splineGeom(points: P2[], closed: boolean, o: SplineOptions = {}): Extract<CurveGeom, { kind: 'bezier' }> {
    const pts = distinct(points, closed);
    const poles = splineBezier(pts, closed, o);
    const pieces: BezierPiece[] = [];
    for (let i = 0; i + 3 < poles.length; i += 3) {
        pieces.push({ poles: poles.slice(i, i + 4), t0: i / 3, t1: i / 3 + 1 });
    }
    return { kind: 'bezier', pieces, ...(closed ? { closed: true } : {}) };
}

/** A piece of a spline through points, ready to be a spline of its own. */
export interface SplinePiece {
    /** Its points in order: the index of a point of the spline that it keeps, or the position of a new point. */
    points: (number | P2)[];
    /** Its end handles (none at an end that stays a free end of the spline). */
    startHandle?: P2;
    endHandle?: P2;
    /** Per piece between its points, the parameter length over the chord; absent when all are 1. */
    spacing?: number[];
}

/**
 * The part of the spline through `points` from parameter t0 to t1 (see splineGeom; a closed spline's part may run
 * on past its first point). The part runs through the spline's own points between, has end handles where it was
 * cut (the cut's own control points), and keeps the parent's parameter spacing, so it is the same curve exactly.
 */
export function splinePiece(points: P2[], closed: boolean, o: SplineOptions, t0: number, t1: number): SplinePiece {
    const pts = distinct(points, closed);
    const n = pts.length;
    const count = closed ? n : n - 1;
    const poles = splineBezier(pts, closed, o);
    const h = splineSpans(pts, closed, o.spacing);
    const E = 1e-12;
    let a = t0;
    let b = t1;
    if (closed) {
        a = ((a % count) + count) % count;
        b = a + (t1 - t0);
    } else {
        a = Math.max(0, Math.min(count, a));
        b = Math.max(a, Math.min(count, b));
    }
    let i0 = Math.floor(a);
    let s0 = a - i0;
    if (s0 > 1 - E) {
        i0 += 1;
        s0 = 0;
    }
    let i1 = Math.ceil(b) - 1;
    let s1 = b - i1;
    if (s1 < E) {
        i1 -= 1;
        s1 = 1;
    }
    if (s1 > 1 - E) {
        s1 = 1;
    }
    if (s0 < E) {
        s0 = 0;
    }
    i1 = Math.max(i1, i0);
    const spans: { bez: P2[]; length: number }[] = [];
    for (let j = i0; j <= i1; j++) {
        const k = ((j % count) + count) % count;
        const lo = j === i0 ? s0 : 0;
        const hi = j === i1 ? s1 : 1;
        spans.push({ bez: bezierRange(poles.slice(3 * k, 3 * k + 4), lo, hi), length: h[k] * (hi - lo) });
    }
    const out: (number | P2)[] = [s0 === 0 ? ((i0 % n) + n) % n : spans[0].bez[0]];
    for (let j = i0; j < i1; j++) {
        out.push(((j + 1) % n + n) % n);
    }
    const last = spans[spans.length - 1].bez;
    out.push(s1 === 1 ? ((i1 + 1) % n + n) % n : last[3]);
    const spacing = spans.map((sp) => {
        const chord = dist(sp.bez[0], sp.bez[3]);
        return chord > 1e-12 ? sp.length / chord : 1;
    });
    const startFree = !closed && a <= E && !o.start;
    const endFree = !closed && b >= count - E && !o.end;
    return {
        points: out,
        ...(startFree ? {} : { startHandle: spans[0].bez[1] }),
        ...(endFree ? {} : { endHandle: last[2] }),
        ...(spacing.some((f) => Math.abs(f - 1) > 1e-12) ? { spacing } : {}),
    };
}

// ---- Style splines ------------------------------------------------------------------------------------------

/** One knot inserted into a B-spline of degree p (Boehm's algorithm); `knots` is the full knot vector. */
function insertKnot(poles: P2[], knots: number[], p: number, u: number): { poles: P2[]; knots: number[] } {
    const n = poles.length - 1;
    let k = p;
    while (k < n && u >= knots[k + 1]) {
        k++;
    }
    const out: P2[] = [];
    for (let i = 0; i <= n + 1; i++) {
        if (i <= k - p) {
            out.push(poles[i]);
        } else if (i > k) {
            out.push(poles[i - 1]);
        } else {
            out.push(lerp(poles[i - 1], poles[i], (u - knots[i]) / (knots[i + p] - knots[i])));
        }
    }
    return { poles: out, knots: [...knots.slice(0, k + 1), u, ...knots.slice(k + 1)] };
}

type Spline = { poles: P2[]; knots: number[] };

/** A clamped B-spline cut in two at u (inside its knot range): each part clamped again, on the same knots. */
function splitAtKnot(s: Spline, p: number, u: number): [Spline, Spline] {
    let cur = s;
    const have = cur.knots.filter((k) => Math.abs(k - u) < 1e-12).length;
    for (let i = have; i < p; i++) {
        cur = insertKnot(cur.poles, cur.knots, p, u);
    }
    const r = cur.knots.findIndex((k) => Math.abs(k - u) < 1e-12);
    return [
        { poles: cur.poles.slice(0, r), knots: [...cur.knots.slice(0, r + p), u] },
        { poles: cur.poles.slice(r - 1), knots: [u, ...cur.knots.slice(r)] },
    ];
}

/** A style spline as Bezier pieces between its knots, its parameter 0 to 1 (Bezier: one piece). */
export function bsplineGeom(poles: P2[], degree: number, inner?: number[]): Extract<CurveGeom, { kind: 'bezier' }> {
    const p = Math.max(1, Math.min(degree, poles.length - 1));
    if (p === poles.length - 1) {
        return { kind: 'bezier', pieces: [{ poles, t0: 0, t1: 1 }] };
    }
    let cur: Spline = { poles, knots: clampedKnots(poles.length, p, inner) };
    const pieces: BezierPiece[] = [];
    const inside = [...new Set(cur.knots.filter((k) => k > 0 && k < 1))];
    let start = 0;
    for (const u of inside) {
        const [left, right] = splitAtKnot(cur, p, u);
        pieces.push({ poles: left.poles.slice(-(p + 1)), t0: start, t1: u });
        cur = right;
        start = u;
    }
    pieces.push({ poles: cur.poles, t0: start, t1: 1 });
    return { kind: 'bezier', pieces };
}

/**
 * The part of a style spline from t0 to t1 (0 ≤ t0 < t1 ≤ 1): the control vertices of the same degree and, for a
 * B-spline, its inner knots (absent when they are evenly spaced). A part with degree + 1 vertices is a Bezier curve.
 */
export function bsplinePiece(poles: P2[], degree: number, inner: number[] | undefined, t0: number, t1: number): { poles: P2[]; knots?: number[] } {
    const p = Math.max(1, Math.min(degree, poles.length - 1));
    if (p === poles.length - 1) {
        return { poles: bezierRange(poles, t0, t1) };
    }
    let cur: Spline = { poles, knots: clampedKnots(poles.length, p, inner) };
    if (t1 < 1 - 1e-12) {
        cur = splitAtKnot(cur, p, t1)[0];
    }
    if (t0 > 1e-12) {
        cur = splitAtKnot(cur, p, t0)[1];
    }
    const lo = cur.knots[0];
    const hi = cur.knots[cur.knots.length - 1];
    const knots = cur.knots.slice(p + 1, cur.knots.length - p - 1).map((k) => (k - lo) / (hi - lo));
    const even = knots.every((k, i) => Math.abs(k - (i + 1) / (knots.length + 1)) < 1e-12);
    return { poles: cur.poles, ...(knots.length && !even ? { knots } : {}) };
}

// ---- Conics ---------------------------------------------------------------------------------------------------

/**
 * The conic from parameter t0 to t1 (see CurveGeom; less than pi apart) as a conic of its own: its ends, its top
 * vertex (where the end tangents meet) and Rho. Null when the tangents no longer meet ahead of it (the piece would
 * turn half a turn or more, as far round an ellipse as that) or an end is off at infinity.
 */
export function conicPiece(g: Extract<CurveGeom, { kind: 'conic' }>, t0: number, t1: number): { start: P2; apex: P2; end: P2; rho: number } | null {
    const [h0, h1, h2] = conicBlossom(g, t0, t1);
    if (!(h0[2] > 1e-12 && h2[2] > 1e-12)) {
        return null;
    }
    const w = h1[2] / Math.sqrt(h0[2] * h2[2]);
    if (!(w > 1e-9) || !Number.isFinite(w)) {
        return null;
    }
    return {
        start: [h0[0] / h0[2], h0[1] / h0[2]],
        apex: [h1[0] / h1[2], h1[1] / h1[2]],
        end: [h2[0] / h2[2], h2[1] / h2[2]],
        rho: w / (1 + w),
    };
}
