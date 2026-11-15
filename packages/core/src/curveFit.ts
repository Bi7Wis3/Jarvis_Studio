// Splines fitted to exact curves within a tolerance (equation driven curves, Fit Spline, Simplify Spline): the
// spline of @jarvis/core/curves (splineBezier) through points on the curve, adding points where the spline strays
// further than the tolerance, and the deviation measured both ways (curve to spline and spline to curve).

import { splineBezier, type P2, type SplineShape } from './curves';

/** A curve by its parameter over [s0, s1]. */
export type ParamCurve = (s: number) => P2;

export interface FitResult {
    /** The spline points (a closed spline ends on its first point again). */
    points: P2[];
    /** The curve parameter of each point. */
    params: number[];
    closed: boolean;
    /** Tangency handles at the ends of an open spline (the curve's end directions), as the spline's handles. */
    handles: { start?: P2; end?: P2 };
    /** Largest distance between the spline and the curve, mm. */
    deviation: number;
    /** False when the point limit was reached first. */
    within: boolean;
}

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function bez(p: P2[], t: number): { at: P2; d1: P2; d2: P2 } {
    const s = 1 - t;
    const at: P2 = [0, 1].map((k) => s * s * s * p[0][k] + 3 * s * s * t * p[1][k] + 3 * s * t * t * p[2][k] + t * t * t * p[3][k]) as P2;
    const d1: P2 = [0, 1].map((k) => 3 * (s * s * (p[1][k] - p[0][k]) + 2 * s * t * (p[2][k] - p[1][k]) + t * t * (p[3][k] - p[2][k]))) as P2;
    const d2: P2 = [0, 1].map((k) => 6 * (s * (p[2][k] - 2 * p[1][k] + p[0][k]) + t * (p[3][k] - 2 * p[2][k] + p[1][k]))) as P2;
    return { at, d1, d2 };
}

/** Distance from q to a cubic Bezier piece, by Newton's method from t0. */
function toBezier(piece: P2[], q: P2, t0: number): number {
    let t = t0;
    for (let k = 0; k < 12; k++) {
        const { at, d1, d2 } = bez(piece, t);
        const r = sub(at, q);
        const g = dot(r, d1);
        const h = dot(d1, d1) + dot(r, d2);
        if (!(h > 0)) {
            break;
        }
        const next = Math.min(1, Math.max(0, t - g / h));
        if (Math.abs(next - t) < 1e-14) {
            t = next;
            break;
        }
        t = next;
    }
    return Math.min(dist(bez(piece, t).at, q), dist(bez(piece, t0).at, q));
}

/** Distance from q to the curve near s0 (between lo and hi), by Newton's method with numeric derivatives. */
function toCurve(f: ParamCurve, q: P2, s0: number, lo: number, hi: number): number {
    const h = Math.max(Math.abs(hi - lo) * 1e-5, 1e-12);
    let s = s0;
    let best = dist(f(s0), q);
    for (let k = 0; k < 12; k++) {
        const a = f(s);
        const [m, p] = [f(Math.max(lo, s - h)), f(Math.min(hi, s + h))];
        const span = Math.min(hi, s + h) - Math.max(lo, s - h);
        if (!(span > 0)) {
            break;
        }
        const d1: P2 = [(p[0] - m[0]) / span, (p[1] - m[1]) / span];
        const d2: P2 = [(p[0] - 2 * a[0] + m[0]) / (h * h), (p[1] - 2 * a[1] + m[1]) / (h * h)];
        const r = sub(a, q);
        const g = dot(r, d1);
        const hh = dot(d1, d1) + dot(r, d2);
        if (!(hh > 0)) {
            break;
        }
        s = Math.min(hi, Math.max(lo, s - g / hh));
        best = Math.min(best, dist(f(s), q));
    }
    return best;
}

/** Each piece's deviation between the spline through `points` and the curve between the points' parameters. */
export function pieceDeviations(f: ParamCurve, params: number[], points: P2[], closed: boolean, samples = 8, handles: { start?: P2; end?: P2 } = {}): number[] {
    const poles = splineBezier(points, closed, handles);
    const out: number[] = [];
    const [first, last] = [params[0], params[params.length - 1]];
    for (let i = 0; i + 1 < params.length; i++) {
        const piece = poles.slice(3 * i, 3 * i + 4);
        if (piece.length < 4) {
            break;
        }
        const [a, b] = [params[i], params[i + 1]];
        const reach = (b - a) * 0.5;
        let worst = 0;
        for (let k = 1; k < samples; k++) {
            const u = k / samples;
            worst = Math.max(worst, toBezier(piece, f(a + (b - a) * u), u));
            worst = Math.max(worst, toCurve(f, bez(piece, u).at, a + (b - a) * u, Math.max(first, a - reach), Math.min(last, b + reach)));
        }
        out.push(worst);
    }
    return out;
}

/**
 * A spline through points of the curve over [s0, s1] that keeps within `tolerance` of it, with as few points as the
 * refinement needs (from `start` points evenly spaced), up to `maxPoints`. Ends that meet give a closed spline.
 */
export function fitSpline(f: ParamCurve, s0: number, s1: number, o: { tolerance: number; maxPoints?: number; start?: number; params?: number[]; clampEnds?: boolean }): FitResult {
    const maxPoints = Math.max(2, o.maxPoints ?? 200);
    const n0 = Math.min(maxPoints, Math.max(2, o.start ?? 9));
    let params = o.params ?? Array.from({ length: n0 }, (_, i) => s0 + ((s1 - s0) * i) / (n0 - 1));
    const size = Math.max(1e-9, ...params.map((s) => dist(f(s), f(s0))));
    const closed = dist(f(s0), f(s1)) <= size * 1e-9 && params.length > 3;
    const pointsOf = (ps: number[]) => {
        const pts = ps.map(f);
        if (closed) {
            pts[pts.length - 1] = pts[0];
        }
        return pts;
    };
    // An open spline's ends follow the curve's own end directions (else they would end straight, curvature free).
    const tangent = (s: number, toward: number): P2 | null => {
        const h = (s1 - s0) * 1e-6 * Math.sign(toward - s);
        const [a, b] = [f(s), f(s + h)];
        const d = dist(a, b);
        return d > 0 ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : null;
    };
    const [startDir, endDir] = closed || o.clampEnds === false ? [null, null] : [tangent(s0, s1), tangent(s1, s0)];
    const handlesOf = (pts: P2[]): { start?: P2; end?: P2 } => {
        if (pts.length < 3) {
            return {};
        }
        const out: { start?: P2; end?: P2 } = {};
        const n = pts.length;
        if (startDir) {
            const h = dist(pts[0], pts[1]) / 3;
            out.start = [pts[0][0] + startDir[0] * h, pts[0][1] + startDir[1] * h];
        }
        if (endDir) {
            const h = dist(pts[n - 1], pts[n - 2]) / 3;
            out.end = [pts[n - 1][0] + endDir[0] * h, pts[n - 1][1] + endDir[1] * h];
        }
        return out;
    };
    for (;;) {
        const points = pointsOf(params);
        const handles = handlesOf(points);
        const devs = pieceDeviations(f, params, points, closed, 8, handles);
        const bad = devs.map((d, i) => (d > o.tolerance ? i : -1)).filter((i) => i >= 0);
        if (!bad.length || params.length >= maxPoints) {
            // The final check, sampled more finely.
            const fine = pieceDeviations(f, params, points, closed, 16, handles);
            const deviation = Math.max(0, ...fine);
            if (deviation > o.tolerance && params.length < maxPoints) {
                // A worse spot the coarse check missed: split there too.
                const worst = fine.indexOf(Math.max(...fine));
                params = [...params.slice(0, worst + 1), (params[worst] + params[worst + 1]) / 2, ...params.slice(worst + 1)];
                continue;
            }
            return { points, params, closed, handles, deviation, within: deviation <= o.tolerance };
        }
        const room = maxPoints - params.length;
        // Short of room, the worst pieces first.
        const split = new Set([...bad].sort((a, b) => devs[b] - devs[a]).slice(0, room));
        const next: number[] = [];
        params.forEach((s, i) => {
            next.push(s);
            if (split.has(i)) {
                next.push((s + params[i + 1]) / 2);
            }
        });
        params = next;
    }
}

/** A spline through points as a curve of one parameter over [0, pieces] (piece i from i to i + 1). */
export function splineCurve(points: P2[], closed: boolean, handles: SplineShape = {}): { f: ParamCurve; pieces: number } {
    const poles = splineBezier(points, closed, handles);
    const pieces = Math.max(1, (poles.length - 1) / 3);
    return {
        pieces,
        f: (u) => {
            const i = Math.min(pieces - 1, Math.max(0, Math.floor(u)));
            return bez(poles.slice(3 * i, 3 * i + 4), Math.min(1, Math.max(0, u - i))).at;
        },
    };
}
