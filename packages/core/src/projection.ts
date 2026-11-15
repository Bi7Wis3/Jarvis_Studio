// Model geometry seen from a sketch plane: model edges (and curves of other sketches) projected straight onto the
// plane as exact sketch curves in its (u, v). Shared by the CAD kernel (which reads the edges) and the sketcher (which
// turns the result into sketch entities and snaps to it). Coordinates in mm, directions as unit vectors.

import type { Vec3 } from './index';
import { asCircular, KIND_TOLERANCE, oneSimpleCurve, simplestPieces } from './curveKinds';

export { joinCurves, KIND_TOLERANCE, oneSimpleCurve, simplestPieces, type BezierPiece } from './curveKinds';

export type P2 = [number, number];

/** A sketch plane in the part frame: origin, in-plane axes u and v, and the normal n = u × v. */
export interface PlaneFrame3 {
    origin: Vec3;
    u: Vec3;
    v: Vec3;
    n: Vec3;
}

/**
 * One exact curve in sketch (u, v). Arcs and partial ellipses run counter-clockwise from start to end. `major` is
 * the end of the long axis of an ellipse, `minor` its short radius. A bezier has any number of control vertices
 * (its degree is their count less one); a bspline is clamped with evenly spaced knots (as the sketch's style spline).
 * A conic is the rational quadratic from start to end whose end tangents meet at `apex`, with Rho 0 to 1.
 */
export type ModelCurve =
    | { kind: 'line'; a: P2; b: P2 }
    | { kind: 'circle'; center: P2; radius: number }
    | { kind: 'arc'; center: P2; start: P2; end: P2 }
    | { kind: 'ellipse'; center: P2; major: P2; minor: number }
    | { kind: 'ellipseArc'; center: P2; major: P2; minor: number; start: P2; end: P2 }
    | { kind: 'bezier'; poles: P2[] }
    | { kind: 'bspline'; poles: P2[]; degree: 3 | 5 | 7 }
    | { kind: 'conic'; start: P2; apex: P2; end: P2; rho: number };

/** A projected curve and what it came from: a model edge (by its index in the body), a loop of a picked face. */
export type TaggedCurve = ModelCurve & { edge?: number; face?: number; loop?: number };

/** A model edge or a face loop that has no exact sketch curve, by name. */
export interface Skipped {
    what: string;
    why: string;
}

/** What the kernel answers for a sketch plane: curves, the projected vertices, and what it could not convert. */
export interface ModelSketch {
    curves: TaggedCurve[];
    points: P2[];
    skipped: Skipped[];
    /** Per picked face (in pick order), how many loops it has (loop 0 is the outer one). */
    loops?: number[];
}

/** Questions to the kernel about the body as it is before a sketch step. */
export type ModelQuery =
    /** Every edge and vertex of the body, projected. */
    | { kind: 'edges' }
    /** The picked edges (points on them) and the loops of the picked faces (points on them, with normals). */
    | { kind: 'convert'; edges: Vec3[]; faces: { at: Vec3; normal?: Vec3 }[] }
    /** Where the sketch plane cuts the picked faces, or the whole body when none are given. */
    | { kind: 'section'; faces: { at: Vec3; normal?: Vec3 }[] }
    /** The outline of the body seen along the plane normal; external: only the outer boundary. */
    | { kind: 'silhouette'; external: boolean }
    /** Where the picked edges (points on them) pass through the plane: `points` of the answer. */
    | { kind: 'pierce'; edges: Vec3[] }
    /**
     * The loops of the body's flat faces that lie in the sketch plane (the faces a sketch on a face sits on), tagged
     * by face and loop (loop 0 the outer one); `loops` counts them per face. Close Sketch to Model and contours
     * bounded by model edges use them.
     */
    | { kind: 'planeFaces' };

// ---- Vectors ----------------------------------------------------------------------------------------------

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross2 = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0];
const dot2 = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1];
const len2 = (a: P2): number => Math.hypot(a[0], a[1]);

/** Rounds away float noise far below anything the app shows (1e-9 mm), so 9.999999999999998 reads 10. */
export const tidy = (x: number): number => Math.round(x * 1e9) / 1e9 + 0;
const tidyP = (p: P2): P2 => [tidy(p[0]), tidy(p[1])];

/** The (u, v) of a part-frame point on (or seen straight onto) the plane. */
export function projectPoint(f: PlaneFrame3, p: Vec3): P2 {
    const rel = sub3(p, f.origin);
    return [dot3(rel, f.u), dot3(rel, f.v)];
}

/** The (u, v) of a part-frame direction (or vector). */
export function projectVector(f: PlaneFrame3, d: Vec3): P2 {
    return [dot3(d, f.u), dot3(d, f.v)];
}

/** Height of a part-frame point above the plane, along its normal. */
export function heightAbove(f: PlaneFrame3, p: Vec3): number {
    return dot3(sub3(p, f.origin), f.n);
}

// ---- Circles and ellipses ---------------------------------------------------------------------------------

const TAU = 2 * Math.PI;

/**
 * The projection of the conic arc C + X cos t + Y sin t for t from t0 to t1 (X and Y are the semi-axis vectors of a
 * circle or an ellipse; `full`: the whole curve). Parallel to the plane a circle stays a circle; at a tilt it is an
 * ellipse; edge-on it is the line it covers. Null when it shrinks to a point.
 */
export function projectConic(f: PlaneFrame3, centre: Vec3, X: Vec3, Y: Vec3, t0: number, t1: number, full: boolean): ModelCurve | null {
    const c = projectPoint(f, centre);
    let x = projectVector(f, X);
    let y = projectVector(f, Y);
    const size = Math.max(Math.hypot(...X), Math.hypot(...Y));
    if (!(size > 0)) {
        return null;
    }
    const area = cross2(x, y);
    if (Math.abs(area) <= 1e-9 * size * size) {
        return edgeOn(c, x, y, t0, full ? t0 + TAU : t1, size);
    }
    let [s0, s1] = [t0, full ? t0 + TAU : t1];
    if (area < 0) {
        // Seen from behind: run the parameter backwards so the curve turns counter-clockwise in (u, v).
        y = [-y[0], -y[1]];
        [s0, s1] = [-s1, -s0];
    }
    const at2 = (t: number): P2 => [c[0] + x[0] * Math.cos(t) + y[0] * Math.sin(t), c[1] + x[1] * Math.cos(t) + y[1] * Math.sin(t)];
    const xx = dot2(x, x);
    const yy = dot2(y, y);
    const xy = dot2(x, y);
    const round = Math.abs(xx - yy) <= 1e-9 * (xx + yy) && Math.abs(xy) <= 1e-9 * (xx + yy);
    if (round) {
        const radius = tidy(Math.sqrt((xx + yy) / 2));
        return full ? { kind: 'circle', center: tidyP(c), radius } : { kind: 'arc', center: tidyP(c), start: tidyP(at2(s0)), end: tidyP(at2(s1)) };
    }
    // Principal axes of the conjugate diameters x, y: the parameter where the radius is longest.
    const tm = 0.5 * Math.atan2(2 * xy, xx - yy);
    const A: P2 = [x[0] * Math.cos(tm) + y[0] * Math.sin(tm), x[1] * Math.cos(tm) + y[1] * Math.sin(tm)];
    const B: P2 = [-x[0] * Math.sin(tm) + y[0] * Math.cos(tm), -x[1] * Math.sin(tm) + y[1] * Math.cos(tm)];
    const major: P2 = [c[0] + A[0], c[1] + A[1]];
    const minor = tidy(len2(B));
    return full
        ? { kind: 'ellipse', center: tidyP(c), major: tidyP(major), minor }
        : { kind: 'ellipseArc', center: tidyP(c), major: tidyP(major), minor, start: tidyP(at2(s0)), end: tidyP(at2(s1)) };
}

/** An arc seen edge-on: the stretch of line it covers between its extreme points. */
function edgeOn(c: P2, x: P2, y: P2, t0: number, t1: number, size: number): ModelCurve | null {
    const d0 = len2(x) >= len2(y) ? x : y;
    const l = len2(d0);
    if (!(l > 1e-9 * size)) {
        return null;
    }
    const d: P2 = [d0[0] / l, d0[1] / l];
    // s(t) = p cos t + q sin t = R cos(t - phi): the extremes are at the ends and at t = phi + k pi inside the range.
    const p = dot2(x, d);
    const q = dot2(y, d);
    const phi = Math.atan2(q, p);
    const ts = [t0, t1];
    for (let k = Math.ceil((t0 - phi) / Math.PI); phi + k * Math.PI <= t1; k++) {
        ts.push(phi + k * Math.PI);
    }
    const s = ts.map((t) => p * Math.cos(t) + q * Math.sin(t));
    const lo = Math.min(...s);
    const hi = Math.max(...s);
    if (!(hi - lo > 1e-9 * size)) {
        return null;
    }
    return { kind: 'line', a: tidyP([c[0] + d[0] * lo, c[1] + d[1] * lo]), b: tidyP([c[0] + d[0] * hi, c[1] + d[1] * hi]) };
}

// ---- B-splines --------------------------------------------------------------------------------------------

/** A B-spline in (u, v): poles, weights (null: not rational), the full knot sequence (repeats written out), degree. */
export interface Spline2 {
    poles: P2[];
    weights: number[] | null;
    knots: number[];
    degree: number;
}

type H = [number, number, number];

/** Inserts knot u once (Boehm), on homogeneous poles. */
function insertKnot(poles: H[], knots: number[], p: number, u: number): { poles: H[]; knots: number[] } {
    let k = p;
    while (k < knots.length - p - 2 && u >= knots[k + 1]) {
        k++;
    }
    const out: H[] = [];
    for (let i = 0; i <= poles.length; i++) {
        if (i <= k - p) {
            out.push(poles[i]);
        } else if (i > k) {
            out.push(poles[i - 1]);
        } else {
            const den = knots[i + p] - knots[i];
            const a = den > 0 ? (u - knots[i]) / den : 0;
            out.push([0, 1, 2].map((j) => (1 - a) * poles[i - 1][j] + a * poles[i][j]) as H);
        }
    }
    return { poles: out, knots: [...knots.slice(0, k + 1), u, ...knots.slice(k + 1)] };
}

const KNOT_EQ = 1e-12;
const multiplicity = (knots: number[], u: number): number => knots.filter((k) => Math.abs(k - u) <= KNOT_EQ * Math.max(1, Math.abs(u))).length;

/**
 * The B-spline cut into its polynomial (or rational) pieces, each as Bezier poles with weights. Only the part from
 * the first to the last knot of the clamped range is kept.
 */
export function bezierPieces(s: Spline2): { poles: P2[]; weights: number[] }[] {
    const p = s.degree;
    let poles: H[] = s.poles.map((q, i) => {
        const w = s.weights ? s.weights[i] : 1;
        return [q[0] * w, q[1] * w, w];
    });
    let knots = [...s.knots];
    const a = knots[p];
    const b = knots[knots.length - p - 1];
    const breaks = [...new Set(knots.filter((k) => k > a && k < b))];
    for (const u of [a, ...breaks, b]) {
        while (multiplicity(knots, u) < p) {
            ({ poles, knots } = insertKnot(poles, knots, p, u));
        }
    }
    const out: { poles: P2[]; weights: number[] }[] = [];
    for (let i = p; i < knots.length - p - 1; i++) {
        if (knots[i + 1] - knots[i] > KNOT_EQ * Math.max(1, Math.abs(knots[i]))) {
            const h = poles.slice(i - p, i + 1);
            out.push({ poles: h.map((q) => [q[0] / q[2], q[1] / q[2]] as P2), weights: h.map((q) => q[2]) });
        }
    }
    return out;
}

/** Whether the knots are clamped with evenly spaced single interior knots (the sketch's style spline). */
function evenClamped(s: Spline2): boolean {
    const p = s.degree;
    const k = s.knots;
    const count = s.poles.length;
    if (k.length !== count + p + 1) {
        return false;
    }
    const [a, b] = [k[0], k[k.length - 1]];
    const spans = count - p;
    if (!(b > a)) {
        return false;
    }
    return k.every((x, i) => {
        const want = i <= p ? 0 : i >= count ? 1 : (i - p) / spans;
        return Math.abs((x - a) / (b - a) - want) <= 1e-9;
    });
}

/**
 * Exact sketch curves for a projected B-spline, the simplest that hold it within `tolerance` (curveKinds.ts): one
 * line, circle or arc when the whole curve is one; else one style spline when its knots are those the sketch uses;
 * else its pieces, runs of them that make one line or arc joined, the others as Beziers (conics for rational
 * quadratics). [] when it is seen end-on. Null: a rational piece of degree three or more, which no sketch curve holds.
 */
export function splineCurves(s: Spline2, tolerance = KIND_TOLERANCE): ModelCurve[] | null {
    const rational = !!s.weights && s.weights.some((w) => Math.abs(w - s.weights![0]) > 1e-12 * Math.abs(s.weights![0]));
    const plain: Spline2 = rational ? s : { ...s, weights: null };
    const pieces = bezierPieces(plain);
    const at = pieces[0]?.poles[0];
    if (!at || pieces.every((p) => p.poles.every((q) => Math.hypot(q[0] - at[0], q[1] - at[1]) <= tolerance))) {
        // Seen end-on: a point, nothing to draw.
        return [];
    }
    const whole = oneSimpleCurve(pieces, tolerance);
    if (whole) {
        return [whole];
    }
    if (!rational && (s.degree === 3 || s.degree === 5 || s.degree === 7) && s.poles.length > s.degree && evenClamped(plain)) {
        return [{ kind: 'bspline', poles: s.poles.map(tidyP), degree: s.degree }];
    }
    return simplestPieces(pieces, tolerance, true);
}

/** A circle or circular arc in space as projectConic takes it: C + X cos t + Y sin t for t from 0 to `sweep`. */
export interface SpaceCircle {
    centre: Vec3;
    X: Vec3;
    Y: Vec3;
    sweep: number;
    full: boolean;
}

const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: Vec3): Vec3 => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * A part-frame B-spline that is a circle or circular arc within `tolerance` (every pole within it of one plane, and
 * round in that plane as curveKinds proves it), or null. Seen at a tilt it then projects as the exact ellipse.
 */
export function spaceCircle(poles: Vec3[], weights: number[] | null, knots: number[], degree: number, tolerance = KIND_TOLERANCE): SpaceCircle | null {
    if (poles.length < 3) {
        return null;
    }
    const mid: Vec3 = [0, 1, 2].map((i) => poles.reduce((sum, q) => sum + q[i], 0) / poles.length) as Vec3;
    const far = poles.reduce((best, q) => (Math.hypot(...sub3(q, mid)) > Math.hypot(...sub3(best, mid)) ? q : best), poles[0]);
    const side = poles.reduce((best, q) => (Math.hypot(...cross3(sub3(far, mid), sub3(q, mid))) > Math.hypot(...cross3(sub3(far, mid), sub3(best, mid))) ? q : best), poles[0]);
    const normal = cross3(sub3(far, mid), sub3(side, mid));
    if (!(Math.hypot(...normal) > 1e-12 * Math.max(1, Math.hypot(...sub3(far, mid)) ** 2))) {
        return null;
    }
    const n = unit3(normal);
    // Every pole on the plane: the curve, inside their hull, is too.
    if (poles.some((q) => Math.abs(dot3(sub3(q, mid), n)) > tolerance)) {
        return null;
    }
    const e1 = unit3(sub3(far, mid));
    const e2 = cross3(n, e1);
    const flat = (q: Vec3): P2 => [dot3(sub3(q, mid), e1), dot3(sub3(q, mid), e2)];
    const round = asCircular(bezierPieces({ poles: poles.map(flat), weights, knots, degree }), tolerance);
    if (!round || (round.kind !== 'circle' && round.kind !== 'arc')) {
        return null;
    }
    const at = (p: P2): Vec3 => [0, 1, 2].map((i) => mid[i] + e1[i] * p[0] + e2[i] * p[1]) as Vec3;
    const centre = at(round.center);
    if (round.kind === 'circle') {
        return { centre, X: [0, 1, 2].map((i) => e1[i] * round.radius) as Vec3, Y: [0, 1, 2].map((i) => e2[i] * round.radius) as Vec3, sweep: TAU, full: true };
    }
    // Counter-clockwise about n from start to end.
    const X = sub3(at(round.start), centre);
    const Y = cross3(n, X);
    const s0: P2 = [round.start[0] - round.center[0], round.start[1] - round.center[1]];
    const s1: P2 = [round.end[0] - round.center[0], round.end[1] - round.center[1]];
    let sweep = Math.atan2(cross2(s0, s1), dot2(s0, s1));
    if (sweep <= 0) {
        sweep += TAU;
    }
    return { centre, X, Y, sweep, full: false };
}

/** Projects a part-frame B-spline onto the plane (a parallel projection keeps knots and weights). */
export function projectSpline(f: PlaneFrame3, poles: Vec3[], weights: number[] | null, knots: number[], degree: number): Spline2 {
    return { poles: poles.map((q) => projectPoint(f, q)), weights, knots, degree };
}

// ---- Lines ------------------------------------------------------------------------------------------------

/** A projected straight edge, or null when it is seen end-on (a point). */
export function projectLine(f: PlaneFrame3, a: Vec3, b: Vec3): ModelCurve | null {
    const pa = projectPoint(f, a);
    const pb = projectPoint(f, b);
    const size = Math.hypot(...sub3(b, a));
    return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) > 1e-9 * Math.max(1, size) ? { kind: 'line', a: tidyP(pa), b: tidyP(pb) } : null;
}

/** End points of a curve (none for a closed circle or ellipse). */
export function curveEnds(c: ModelCurve): P2[] {
    switch (c.kind) {
        case 'line':
            return [c.a, c.b];
        case 'circle':
        case 'ellipse':
            return [];
        case 'bezier':
        case 'bspline':
            return [c.poles[0], c.poles[c.poles.length - 1]];
        default:
            return [c.start, c.end];
    }
}
