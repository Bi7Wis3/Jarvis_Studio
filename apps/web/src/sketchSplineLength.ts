// Fixed spline length (SolidWorks: Smart Dimension on a spline): a length dimension (kind 'arcLength' on a spline)
// that holds the spline's length while its ends are dragged or its shape changes. The solver (PlaneGCS) has no
// spline length, so after each solve the spline's free shaping points (inner points and handles that nothing else
// holds) are stretched across the line between its ends until the length is the dimension's, to 0.000000001 mm.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { segmentPoints, segmentShape } from '@jarvis/core/curves';
import { cubicPieces, piecesLength, solveSpline } from '@jarvis/core/splines';
import { closedSpline, curveSegment } from './sketchCurves';

type Pt = [number, number];
type Spline = Extract<SketchCurve, { kind: 'spline' }>;
type LengthDim = Extract<SketchConstraint, { kind: 'arcLength' }>;

const pointAt = (g: SketchGeometry, id: string): Pt | null => {
    const p = id === 'origin' ? { u: 0, v: 0 } : g.points.find((q) => q.id === id);
    return p ? [p.u, p.v] : null;
};

/** A spline's length along it (mm), or null. */
export function splineLength(g: SketchGeometry, c: Spline): number | null {
    const s = curveSegment(g, c);
    if (!s || s.seg.kind !== 'spline') {
        return null;
    }
    const closed = closedSpline(c);
    const pts = [s.from, ...s.seg.through, ...(closed ? [] : [s.seg.to])];
    return piecesLength(cubicPieces(solveSpline(pts, closed, segmentShape(s.seg)).poles));
}

/** The spline a length dimension is on, if it is on one. */
function splineOf(g: SketchGeometry, c: SketchConstraint): Spline | null {
    if (c.kind !== 'arcLength') {
        return null;
    }
    const k = g.curves.find((x) => x.id === c.curve);
    return k?.kind === 'spline' ? k : null;
}

/** The current length of a spline's length dimension; undefined when the dimension is not on a spline. */
export function measureSplineLength(g: SketchGeometry, c: SketchConstraint): number | null | undefined {
    const k = splineOf(g, c);
    return k ? splineLength(g, k) : undefined;
}

/** The points a spline's length can be held by: inner points and handles that nothing else holds or shares. */
function freeShapingPoints(g: SketchGeometry, c: Spline, dim: string): { inner: string[]; handles: string[] } {
    const held = new Set<string>();
    for (const k of g.constraints) {
        if (k.id !== dim) {
            Object.values(k).forEach((v) => typeof v === 'string' && held.add(v));
        }
    }
    const others = new Set(g.curves.filter((k) => k.id !== c.id).flatMap((k) => Object.values(k).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []))));
    const free = (id: string | undefined): id is string => !!id && !held.has(id) && !others.has(id) && !g.points.find((p) => p.id === id)?.fixed;
    const ends = new Set([c.points[0], c.points[c.points.length - 1]]);
    const inner = [...new Set(c.points.filter((p) => !ends.has(p)))].filter(free);
    const handles = [c.startHandle, c.endHandle, ...(c.handles ?? []).map((h) => h.handle)].filter(free);
    return { inner, handles };
}

/**
 * The sketch with every driving spline length dimension met: the spline's free inner points and handles stretched
 * across the line between its ends (a closed spline: about its middle). Returns the dimensions that cannot be met.
 */
export function holdSplineLengths(g: SketchGeometry): { geometry: SketchGeometry; failed: string[] } {
    let out = g;
    const failed: string[] = [];
    for (const k of g.constraints) {
        if (k.kind !== 'arcLength' || k.driven || k.suppressed) {
            continue;
        }
        const c = splineOf(out, k);
        if (!c) {
            continue;
        }
        const now = splineLength(out, c);
        if (now === null || Math.abs(now - k.value) < 1e-9) {
            continue;
        }
        const r = stretchTo(out, c, k);
        if (r) {
            out = r;
        } else {
            failed.push(k.id);
        }
    }
    return { geometry: out, failed };
}

function stretchTo(g: SketchGeometry, c: Spline, k: LengthDim): SketchGeometry | null {
    const { inner, handles } = freeShapingPoints(g, c, k.id);
    const moving = [...inner, ...handles];
    if (!moving.length) {
        return null;
    }
    const a = pointAt(g, c.points[0]);
    const b = pointAt(g, c.points[c.points.length - 1]);
    if (!a || !b) {
        return null;
    }
    const closed = closedSpline(c);
    // Stretch across the chord (open), or about the middle of the points (closed).
    const ids = c.points.map((id) => pointAt(g, id)).filter((p): p is Pt => !!p);
    const centre: Pt = [ids.reduce((s, p) => s + p[0], 0) / ids.length, ids.reduce((s, p) => s + p[1], 0) / ids.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: Pt = l > 1e-12 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : [1, 0];
    const start = new Map(moving.map((id) => [id, pointAt(g, id)!]));
    const map = (p: Pt, f: number): Pt => {
        if (closed || l < 1e-12) {
            return [centre[0] + (p[0] - centre[0]) * f, centre[1] + (p[1] - centre[1]) * f];
        }
        const along = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
        const foot: Pt = [a[0] + u[0] * along, a[1] + u[1] * along];
        return [foot[0] + (p[0] - foot[0]) * f, foot[1] + (p[1] - foot[1]) * f];
    };
    const at = (f: number): SketchGeometry => ({
        ...g,
        points: g.points.map((p) => {
            const s = start.get(p.id);
            if (!s) {
                return p;
            }
            const q = map(s, f);
            return { ...p, u: q[0] + 0, v: q[1] + 0 };
        }),
    });
    const lengthAt = (f: number) => splineLength(at(f), c) ?? NaN;
    // The length grows with the stretch: bracket the wanted length, then halve the bracket.
    let lo = 0;
    let hi = 1;
    if (lengthAt(1) < k.value) {
        while (lengthAt(hi) < k.value) {
            lo = hi;
            hi *= 2;
            if (hi > 1e6) {
                return null;
            }
        }
    } else if (!(lengthAt(0) <= k.value)) {
        // Shorter than the spline can be with these ends.
        return null;
    } else {
        hi = 1;
    }
    for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
        const m = (lo + hi) / 2;
        if (lengthAt(m) < k.value) {
            lo = m;
        } else {
            hi = m;
        }
    }
    const result = at((lo + hi) / 2);
    const got = splineLength(result, c);
    return got !== null && Math.abs(got - k.value) < 1e-9 ? result : null;
}

/** Where a spline's length dimension sits by default: off the middle of the spline. */
export function splineLengthAnchor(g: SketchGeometry, c: SketchConstraint): Pt | null {
    const k = splineOf(g, c);
    const s = k ? curveSegment(g, k) : null;
    if (!s) {
        return null;
    }
    const pts = [s.from, ...segmentPoints(s.from, s.seg, 32)] as Pt[];
    const m = pts[Math.floor(pts.length / 2)];
    const n = pts[Math.floor(pts.length / 2) + 1] ?? m;
    const d = Math.hypot(n[0] - m[0], n[1] - m[1]) || 1;
    const size = Math.max(...pts.map((p) => Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]))) * 0.12 || 5;
    return [m[0] - ((n[1] - m[1]) / d) * size, m[1] + ((n[0] - m[0]) / d) * size];
}

/** The leader of a spline's length dimension: from its label to the nearest place on the spline. */
export function splineLengthLeader(g: SketchGeometry, c: SketchConstraint, at: Pt): [Pt, Pt] | null {
    const k = splineOf(g, c);
    const s = k ? curveSegment(g, k) : null;
    if (!s) {
        return null;
    }
    const pts = [s.from, ...segmentPoints(s.from, s.seg, 96)] as Pt[];
    const near = pts.reduce((best, p) => (Math.hypot(p[0] - at[0], p[1] - at[1]) < Math.hypot(best[0] - at[0], best[1] - at[1]) ? p : best));
    return [at, near];
}
