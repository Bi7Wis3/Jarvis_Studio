// Exact maths of the sketch curves beyond lines and circular arcs: ellipses and elliptical arcs, interpolating
// splines and conics (a parabola is the conic with Rho 0.5). Shared by the sketcher (drawing, picking, closed areas)
// and the CAD kernel (exact edges), so both see the same curve. Coordinates are sketch (u, v) in mm.

import type { SketchProfile, SketchSegment } from './index';
import { nurbsAt, solveSpline, type SplineShape } from './splines';

export type { SplineShape } from './splines';

export type P2 = [number, number];

const TAU = 2 * Math.PI;
const dist = (p: P2, q: P2): number => Math.hypot(q[0] - p[0], q[1] - p[1]);

// ---- Ellipses -----------------------------------------------------------------------------------------

/** An ellipse by its centre, the end of one axis and the other radius, as semi-axes a >= b and the a direction. */
export interface EllipseAxes {
    center: P2;
    /** Major semi-axis, its direction (radians from +u) and the minor semi-axis. */
    a: number;
    b: number;
    angle: number;
}

/** The ellipse with centre `center`, one axis ending at `axisEnd` and the other radius `other` (either may be longer). */
export function ellipseAxes(center: P2, axisEnd: P2, other: number): EllipseAxes {
    const r1 = dist(center, axisEnd);
    const t = Math.atan2(axisEnd[1] - center[1], axisEnd[0] - center[0]);
    return r1 >= other ? { center, a: r1, b: Math.abs(other), angle: t } : { center, a: Math.abs(other), b: r1, angle: t + Math.PI / 2 };
}

/** Point of the ellipse at parameter angle `phi` (0 at the major axis end). */
export function ellipseAt(e: EllipseAxes, phi: number): P2 {
    const [c, s] = [Math.cos(e.angle), Math.sin(e.angle)];
    const x = e.a * Math.cos(phi);
    const y = e.b * Math.sin(phi);
    return [e.center[0] + x * c - y * s, e.center[1] + x * s + y * c];
}

/** Parameter angle of the ellipse point nearest in angle to `p` (exact for points on the ellipse). */
export function ellipseParam(e: EllipseAxes, p: P2): number {
    const [c, s] = [Math.cos(e.angle), Math.sin(e.angle)];
    const dx = p[0] - e.center[0];
    const dy = p[1] - e.center[1];
    const x = dx * c + dy * s;
    const y = -dx * s + dy * c;
    return Math.atan2(y / (e.b || 1e-12), x / (e.a || 1e-12));
}

/** Points round a whole ellipse (closed: the first again at the end). */
export function ellipsePoints(e: EllipseAxes, steps = 96): P2[] {
    return Array.from({ length: steps + 1 }, (_, i) => ellipseAt(e, (i / steps) * TAU));
}

/** Start and sweep of an elliptical arc from `from` to `to` (sweep > 0 counter-clockwise). */
export function ellipseSweep(e: EllipseAxes, from: P2, to: P2, ccw: boolean): { start: number; sweep: number } {
    const start = ellipseParam(e, from);
    const end = ellipseParam(e, to);
    const ahead = (((end - start) % TAU) + TAU) % TAU;
    if (ccw) {
        return { start, sweep: ahead < 1e-12 ? TAU : ahead };
    }
    return { start, sweep: ahead < 1e-12 ? -TAU : ahead - TAU };
}

// ---- Splines through points -----------------------------------------------------------------------------

/** Spline options and spans (see splines.ts, where the spline is solved). */
export { splineSpans, type SplineOptions } from './splines';

/**
 * The cubic Bezier pieces of the curvature-continuous spline through `points` (chord-length spacing, free ends; or
 * periodic when `closed`, which runs on from the last point back to the first), shaped by the handles, held
 * curvatures and spans of `shape` (splines.ts, solveSpline). Returns the control points of all pieces in a row:
 * [p0, c, c, p1, c, c, p2, ...], ending at the last point (closed: at the first again).
 */
export function splineBezier(points: P2[], closed = false, shape: SplineShape = {}): P2[] {
    return solveSpline(points, closed, shape).poles;
}

function bezierAt(p0: P2, p1: P2, p2: P2, p3: P2, t: number): P2 {
    const s = 1 - t;
    const [a, b, c, d] = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
    return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** Points along the spline through `points` (excluding the first, `steps` per piece). */
export function splinePoints(points: P2[], closed = false, steps = 24, shape: SplineShape = {}): P2[] {
    const poles = splineBezier(points, closed, shape);
    const out: P2[] = [];
    for (let i = 0; i + 3 < poles.length; i += 3) {
        for (let k = 1; k <= steps; k++) {
            out.push(bezierAt(poles[i], poles[i + 1], poles[i + 2], poles[i + 3], k / steps));
        }
    }
    return out;
}

// ---- Style splines: Bezier and B-spline curves of control vertices -----------------------------------------

/** Whether `inner` are usable inner knots for `count` control vertices of `degree`: as many as needed, ascending inside 0..1. */
export function validInnerKnots(inner: number[] | undefined, count: number, degree: number): inner is number[] {
    return !!inner && inner.length === count - degree - 1 && inner.every((k, i) => k > 0 && k < 1 && (i === 0 || k >= inner[i - 1]));
}

/** Clamped knots for `count` control vertices of `degree` (0 to 1): `inner` inside when they fit, else evenly spaced. */
export function clampedKnots(count: number, degree: number, inner?: number[]): number[] {
    const spans = count - degree;
    return [
        ...new Array(degree + 1).fill(0),
        ...(validInnerKnots(inner, count, degree) ? inner : Array.from({ length: spans - 1 }, (_, i) => (i + 1) / spans)),
        ...new Array(degree + 1).fill(1),
    ];
}

/**
 * Point at t (0 to 1) of the curve of control vertices `poles`: a clamped B-spline of `degree` with even knots (or
 * the inner knots given), or with degree = poles - 1 the Bezier curve (de Boor's algorithm).
 */
export function bsplineAt(poles: P2[], degree: number, t: number, inner?: number[]): P2 {
    const p = Math.min(degree, poles.length - 1);
    const knots = clampedKnots(poles.length, p, inner);
    let k = p;
    while (k < poles.length - 1 && t >= knots[k + 1]) {
        k++;
    }
    const d = Array.from({ length: p + 1 }, (_, j) => [...poles[j + k - p]] as P2);
    for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
            const i = j + k - p;
            const den = knots[i + p - r + 1] - knots[i];
            const a = den > 0 ? (t - knots[i]) / den : 0;
            d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
        }
    }
    return d[p];
}

// ---- Conics -------------------------------------------------------------------------------------------

/** Weight of the middle control point of the rational quadratic for a Rho value (0 < rho < 1). */
export const conicWeight = (rho: number): number => rho / (1 - rho);

/** Point of the conic from a to b with tangents meeting at `apex`, at t in 0..1 (t = 0.5 is the shoulder). */
export function conicAt(a: P2, apex: P2, b: P2, rho: number, t: number): P2 {
    const w = conicWeight(rho);
    const s = 1 - t;
    const [k0, k1, k2] = [s * s, 2 * w * s * t, t * t];
    const den = k0 + k1 + k2;
    return [(k0 * a[0] + k1 * apex[0] + k2 * b[0]) / den, (k0 * a[1] + k1 * apex[1] + k2 * b[1]) / den];
}

/** Radius of curvature of the conic at its shoulder (t = 0.5). */
export function conicShoulderRadius(a: P2, apex: P2, b: P2, rho: number): number {
    const h = 1e-4;
    const [p, q, r] = [conicAt(a, apex, b, rho, 0.5 - h), conicAt(a, apex, b, rho, 0.5), conicAt(a, apex, b, rho, 0.5 + h)];
    const area = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    if (Math.abs(area) < 1e-18) {
        return Infinity;
    }
    return (dist(p, q) * dist(q, r) * dist(p, r)) / (2 * Math.abs(area));
}

/** The Rho that gives the conic a radius of curvature `radius` at its shoulder, or null when none does. */
export function conicRhoForRadius(a: P2, apex: P2, b: P2, radius: number): number | null {
    // The shoulder radius falls from very flat (Rho near 0) to a sharp corner (Rho near 1).
    let lo = 1e-6;
    let hi = 1 - 1e-6;
    const f = (rho: number) => conicShoulderRadius(a, apex, b, rho);
    if (!(radius > 0) || radius > f(lo) || radius < f(hi)) {
        return null;
    }
    for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
        const m = (lo + hi) / 2;
        if (f(m) > radius) {
            lo = m;
        } else {
            hi = m;
        }
    }
    return (lo + hi) / 2;
}

// ---- Segments of a path -------------------------------------------------------------------------------------

/** Circle through three points, or null when they are (nearly) in line. */
function circle3(a: P2, m: P2, b: P2): { c: P2; r: number } | null {
    const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    if (Math.abs(d) < 1e-12) {
        return null;
    }
    const sq = (p: P2) => p[0] * p[0] + p[1] * p[1];
    const c: P2 = [
        (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d,
        (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d,
    ];
    return { c, r: dist(c, a) };
}

/** The shape options a spline segment carries, for splineBezier. */
export function segmentShape(s: Extract<SketchSegment, { kind: 'spline' }>): SplineShape {
    return {
        start: s.startHandle, end: s.endHandle,
        ...(s.handles?.length ? { inner: s.handles } : {}),
        ...(s.curvature?.length ? { curvature: s.curvature } : {}),
        ...(s.continuity ? { continuity: true } : {}),
        ...(s.spacing ? { spacing: s.spacing } : {}),
    };
}

/** Points along a path segment that starts at `from`: excluding `from`, including its end. */
export function segmentPoints(from: P2, s: SketchSegment, steps = 48): P2[] {
    switch (s.kind) {
        case 'line':
            return [s.to];
        case 'arc': {
            const circle = circle3(from, s.through, s.to);
            if (!circle) {
                return [s.to];
            }
            const { c, r } = circle;
            const ang = (p: P2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
            const norm = (t: number) => ((t % TAU) + TAU) % TAU;
            const start = ang(from);
            let sweep = norm(ang(s.to) - start);
            if (norm(ang(s.through) - start) > sweep) {
                sweep -= TAU;
            }
            return Array.from({ length: steps }, (_, i) => {
                const t = start + (sweep * (i + 1)) / steps;
                return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as P2;
            });
        }
        case 'ellipse': {
            const e = ellipseAxes(s.center, s.major, s.minor);
            const { start, sweep } = ellipseSweep(e, from, s.to, s.ccw);
            const n = Math.max(steps, Math.ceil((Math.abs(sweep) / TAU) * 96));
            const out = Array.from({ length: n }, (_, i) => ellipseAt(e, start + (sweep * (i + 1)) / n));
            out[out.length - 1] = s.to;
            return out;
        }
        case 'spline': {
            const closed = dist(from, s.to) < 1e-9;
            const out = splinePoints([from, ...s.through, ...(closed ? [] : [s.to])], closed, Math.max(8, Math.ceil(steps / 2)), segmentShape(s));
            out[out.length - 1] = s.to;
            return out;
        }
        case 'bspline': {
            const poles = [from, ...s.poles, s.to];
            const n = Math.max(steps, poles.length * 12);
            const exact = (t: number) => (s.weights ? nurbsAt(poles, s.degree, t, s.knots, s.weights) : bsplineAt(poles, s.degree, t, s.knots));
            const out = Array.from({ length: n }, (_, i) => exact((i + 1) / n));
            out[out.length - 1] = s.to;
            return out;
        }
        case 'conic':
            return Array.from({ length: steps }, (_, i) => (i === steps - 1 ? s.to : conicAt(from, s.apex, s.to, s.rho, (i + 1) / steps)));
    }
}

/** The same segment run the other way: from its end back to `from`. */
export function reverseSegment(from: P2, s: SketchSegment): SketchSegment {
    switch (s.kind) {
        case 'line':
            return { kind: 'line', to: from };
        case 'arc':
            return { kind: 'arc', to: from, through: s.through };
        case 'ellipse':
            return { ...s, to: from, ccw: !s.ccw };
        case 'spline': {
            // Point i counts from the other end; each handle's sides swap, and a held curvature turns the other way.
            const closed = dist(from, s.to) < 1e-9;
            const n = s.through.length + (closed ? 1 : 2);
            const flip = (i: number) => (closed ? (n - i) % n : n - 1 - i);
            return {
                kind: 'spline', to: from, through: [...s.through].reverse(),
                ...(s.endHandle ? { startHandle: s.endHandle } : {}), ...(s.startHandle ? { endHandle: s.startHandle } : {}),
                ...(s.spacing ? { spacing: [...s.spacing].reverse() } : {}),
                ...(s.handles ? { handles: s.handles.map((k) => ({ at: flip(k.at), prev: k.next, next: k.prev })) } : {}),
                ...(s.curvature ? { curvature: s.curvature.map((k) => ({ at: flip(k.at), value: -k.value })) } : {}),
                ...(s.continuity ? { continuity: true } : {}),
            };
        }
        case 'bspline':
            return {
                ...s, to: from, poles: [...s.poles].reverse(),
                ...(s.knots ? { knots: [...s.knots].reverse().map((k) => 1 - k) } : {}),
                ...(s.weights ? { weights: [...s.weights].reverse() } : {}),
            };

        case 'conic':
            return { ...s, to: from };
    }
}

/** A point on a segment halfway along it (by parameter), e.g. to tell two curves between the same ends apart. */
export function segmentMiddle(from: P2, s: SketchSegment): P2 {
    switch (s.kind) {
        case 'line':
            return [(from[0] + s.to[0]) / 2, (from[1] + s.to[1]) / 2];
        case 'arc':
            return s.through;
        case 'conic':
            return conicAt(from, s.apex, s.to, s.rho, 0.5);
        default: {
            const pts = [from, ...segmentPoints(from, s, 64)];
            return pts[Math.floor(pts.length / 2)];
        }
    }
}

/** Outline of an ellipse profile (closed: the first point again at the end). */
export function ellipseProfilePoints(p: Extract<SketchProfile, { kind: 'ellipse' }>, steps = 96): P2[] {
    return ellipsePoints(ellipseAxes(p.center, p.major, p.minor), steps);
}
