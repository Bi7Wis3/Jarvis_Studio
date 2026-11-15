// Checks that a solved sketch really satisfies its relations and dimensions. The solver can report success on a
// system it could not satisfy (seen with a point held on two curves that do not meet where it is); the sketcher
// refuses such a result instead of showing geometry that breaks its own relations.

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, curveOf, curveRadius, measure, pointOf } from './solver';
import type { Pt } from './sketchMath';

/** How far off (mm, or degrees for angles) a relation may be and still count as holding. */
export const RESIDUAL_TOLERANCE = 1e-3;

type Line = { a: Pt; b: Pt };

const pt = (g: SketchGeometry, id: string): Pt | null => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : null;
};

function lineOf(g: SketchGeometry, id: string): Line | null {
    if (id === AXIS_U) {
        return { a: [0, 0], b: [1, 0] };
    }
    if (id === AXIS_V) {
        return { a: [0, 0], b: [0, 1] };
    }
    const c = curveOf(g, id);
    if (c?.kind !== 'line') {
        return null;
    }
    const a = pt(g, c.a);
    const b = pt(g, c.b);
    return a && b ? { a, b } : null;
}

const dir = (l: Line): Pt => {
    const d = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]) || 1;
    return [(l.b[0] - l.a[0]) / d, (l.b[1] - l.a[1]) / d];
};

/** Distance from p to the infinite line. */
function toLine(p: Pt, l: Line): number {
    const u = dir(l);
    return Math.abs((p[0] - l.a[0]) * u[1] - (p[1] - l.a[1]) * u[0]);
}

/** Centre and radius of a circle or arc. */
function roundOf(g: SketchGeometry, id: string): { c: Pt; r: number } | null {
    const curve = curveOf(g, id);
    if (!curve || (curve.kind !== 'circle' && curve.kind !== 'arc')) {
        return null;
    }
    const c = pt(g, curve.center);
    const r = curveRadius(g, id);
    return c && r !== null ? { c, r } : null;
}

/** How far the constraint is from holding on this geometry; null when it cannot be measured (dangling refs). */
export function residual(g: SketchGeometry, k: SketchConstraint): number | null {
    // Suppressed relations and driven dimensions hold nothing.
    if (k.suppressed || ('driven' in k && k.driven)) {
        return null;
    }
    switch (k.kind) {
        case 'coincident': {
            const a = pt(g, k.a);
            const b = pt(g, k.b);
            return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null;
        }
        case 'horizontal':
        case 'vertical': {
            const l = lineOf(g, k.line);
            return l ? Math.abs(k.kind === 'horizontal' ? l.b[1] - l.a[1] : l.b[0] - l.a[0]) : null;
        }
        case 'parallel':
        case 'perpendicular': {
            const [la, lb] = [lineOf(g, k.a), lineOf(g, k.b)];
            if (!la || !lb) {
                return null;
            }
            const [u, v] = [dir(la), dir(lb)];
            // Measured as an angle in degrees.
            const s = k.kind === 'parallel' ? Math.abs(u[0] * v[1] - u[1] * v[0]) : Math.abs(u[0] * v[0] + u[1] * v[1]);
            return (Math.asin(Math.min(1, s)) * 180) / Math.PI;
        }
        case 'equal': {
            const [la, lb] = [lineOf(g, k.a), lineOf(g, k.b)];
            if (la && lb) {
                return Math.abs(Math.hypot(la.b[0] - la.a[0], la.b[1] - la.a[1]) - Math.hypot(lb.b[0] - lb.a[0], lb.b[1] - lb.a[1]));
            }
            const [ra, rb] = [curveRadius(g, k.a), curveRadius(g, k.b)];
            return ra !== null && rb !== null ? Math.abs(ra - rb) : null;
        }
        case 'tangent': {
            const [la, lb] = [lineOf(g, k.a), lineOf(g, k.b)];
            const [ca, cb] = [roundOf(g, k.a), roundOf(g, k.b)];
            const line = la ?? lb;
            const round = ca ?? cb;
            if (line && round) {
                return Math.abs(toLine(round.c, line) - round.r);
            }
            if (ca && cb) {
                const d = Math.hypot(ca.c[0] - cb.c[0], ca.c[1] - cb.c[1]);
                return Math.min(Math.abs(d - (ca.r + cb.r)), Math.abs(d - Math.abs(ca.r - cb.r)));
            }
            return null;
        }
        case 'pointOnCurve': {
            const p = pt(g, k.point);
            if (!p) {
                return null;
            }
            const l = lineOf(g, k.curve);
            if (l) {
                return toLine(p, l);
            }
            const r = roundOf(g, k.curve);
            return r ? Math.abs(Math.hypot(p[0] - r.c[0], p[1] - r.c[1]) - r.r) : null;
        }
        case 'intersection': {
            const p = pt(g, k.point);
            const [la, lb] = [lineOf(g, k.a), lineOf(g, k.b)];
            return p && la && lb ? Math.max(toLine(p, la), toLine(p, lb)) : null;
        }
        case 'midpoint': {
            const p = pt(g, k.point);
            const l = lineOf(g, k.line);
            return p && l ? Math.hypot(p[0] - (l.a[0] + l.b[0]) / 2, p[1] - (l.a[1] + l.b[1]) / 2) : null;
        }
        case 'symmetric': {
            const a = pt(g, k.a);
            const b = pt(g, k.b);
            const l = lineOf(g, k.about);
            if (!a || !b || !l) {
                return null;
            }
            // The middle lies on the line and a-b is square to it.
            const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            const u = dir(l);
            const square = Math.abs((b[0] - a[0]) * u[0] + (b[1] - a[1]) * u[1]);
            return k.part === 'perpendicular' ? square : k.part === 'midpoint' ? toLine(m, l) : toLine(m, l) + square;
        }
        case 'horizontalPoints':
        case 'verticalPoints': {
            const a = pt(g, k.a);
            const b = pt(g, k.b);
            return a && b ? Math.abs(k.kind === 'horizontalPoints' ? b[1] - a[1] : b[0] - a[0]) : null;
        }
        case 'concentric':
        case 'coradial': {
            const [ca, cb] = [roundOf(g, k.a), roundOf(g, k.b)];
            if (!ca || !cb) {
                return null;
            }
            const apart = Math.hypot(ca.c[0] - cb.c[0], ca.c[1] - cb.c[1]);
            return k.kind === 'coradial' ? apart + Math.abs(ca.r - cb.r) : apart;
        }
        case 'collinear': {
            const [la, lb] = [lineOf(g, k.a), lineOf(g, k.b)];
            // Both ends of the second line lie on the first.
            return la && lb ? Math.max(toLine(lb.a, la), toLine(lb.b, la)) : null;
        }
        case 'pathTangent':
            // Held by whichever member touches the follower at the time.
            return null;
        case 'equalSweep': {
            const sweep = (id: string) => {
                const c = curveOf(g, id);
                const [m, s, e] = c?.kind === 'arc' ? [pt(g, c.center), pt(g, c.start), pt(g, c.end)] : [null, null, null];
                if (!m || !s || !e) {
                    return null;
                }
                const a = Math.atan2(e[1] - m[1], e[0] - m[0]) - Math.atan2(s[1] - m[1], s[0] - m[0]);
                return ((((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) || 2 * Math.PI) * 180 / Math.PI;
            };
            const [a, b] = [sweep(k.a), sweep(k.b)];
            return a !== null && b !== null ? Math.abs(a - b) : null;
        }
        case 'fix':
        case 'fixRadius':
            // A lock holds the point or size where it is; nothing to compare against.
            return null;
        case 'distance':
        case 'length':
        case 'angle':
        case 'radius':
        case 'diameter':
        case 'arcLength':
        case 'pointAngle':
        case 'pathLength':
        case 'rho': {
            const now = measure(g, k);
            return now === null ? null : Math.abs(now - k.value);
        }
    }
}

/** Arcs whose start and end are not at the same distance from the centre. */
function brokenArcs(g: SketchGeometry): string[] {
    return g.curves.flatMap((c) => {
        if (c.kind !== 'arc') {
            return [];
        }
        const [m, s, e] = [pt(g, c.center), pt(g, c.start), pt(g, c.end)];
        if (!m || !s || !e) {
            return [];
        }
        const off = Math.abs(Math.hypot(s[0] - m[0], s[1] - m[1]) - Math.hypot(e[0] - m[0], e[1] - m[1]));
        return off > RESIDUAL_TOLERANCE ? [c.id] : [];
    });
}

/** Below this a line's length, or a circle's, arc's or ellipse's radius, counts as shrunk to nothing. */
const COLLAPSED = 1e-7;

/** Lines of no length and circles, arcs and ellipses of no radius, by curve id. */
export function collapsedCurves(g: SketchGeometry): string[] {
    const gap = (a: string, b: string) => {
        const [p, q] = [pt(g, a), pt(g, b)];
        return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1]) : Infinity;
    };
    return g.curves.flatMap((c) => {
        const small = c.kind === 'line' ? gap(c.a, c.b) < COLLAPSED
            : c.kind === 'circle' ? (curveRadius(g, c.id) ?? Infinity) < COLLAPSED
                : c.kind === 'arc' ? gap(c.center, c.start) < COLLAPSED
                    : c.kind === 'ellipse' || c.kind === 'ellipseArc' ? gap(c.center, c.major) < COLLAPSED || gap(c.center, c.minor) < COLLAPSED
                        : false;
        return small ? [c.id] : [];
    });
}

/** The relations and dimensions that do not hold on this (solved) geometry, by id; arcs that came apart by curve id. */
export function unmetConstraints(g: SketchGeometry): string[] {
    const bad = g.constraints.filter((k) => {
        const r = residual(g, k);
        return r !== null && Number.isFinite(r) && r > RESIDUAL_TOLERANCE;
    }).map((k) => k.id);
    return [...bad, ...brokenArcs(g)];
}
