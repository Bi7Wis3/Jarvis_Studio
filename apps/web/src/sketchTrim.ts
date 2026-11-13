// The Trim tool's other modes, on top of trimAt (trim to closest): power trim along a dragged path, corner, and trim
// away inside / outside two boundaries.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf, pointOf } from './solver';
import { constraintRefs } from './sketchGeometry';
import { curvePoints, shapeOf, trimAt, type TrimOptions } from './sketchEdit';
import { dist, type Pt } from './sketchMath';
import { intersections } from './snapping';

export type TrimMode = 'power' | 'corner' | 'inside' | 'outside' | 'closest';

/** Trim's options: keep trimmed entities as construction geometry, and leave construction geometry alone. */
export interface TrimSettings {
    construction?: boolean;
    ignoreConstruction?: boolean;
}

type Line = Extract<SketchCurve, { kind: 'line' }>;

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** Whether the trim may touch this curve. */
export function trimmable(g: SketchGeometry, id: string, o: TrimSettings): boolean {
    const c = curveOf(g, id);
    return !!c && !(o.ignoreConstruction && c.construction);
}

/**
 * Power trim: every curve the pointer path from `from` to `to` crosses is trimmed at the crossing, back to its nearest
 * crossings with other curves (a curve nothing crosses goes). Crossings are taken in order along the path.
 */
export function powerTrim(g: SketchGeometry, from: Pt, to: Pt, o: TrimSettings = {}): { g: SketchGeometry; trimmed: number } {
    if (dist(from, to) < 1e-9) {
        return { g, trimmed: 0 };
    }
    const path = { id: 'path', kind: 'line' as const, a: from, b: to };
    const len2 = (to[0] - from[0]) ** 2 + (to[1] - from[1]) ** 2;
    const along = (p: Pt) => ((p[0] - from[0]) * (to[0] - from[0]) + (p[1] - from[1]) * (to[1] - from[1])) / len2;
    let out = g;
    let trimmed = 0;
    let done = -1;
    const opts: TrimOptions = { construction: o.construction };
    for (let i = 0; i < 64; i++) {
        let next: { id: string; at: Pt; t: number } | null = null;
        for (const c of out.curves) {
            if (!trimmable(out, c.id, o)) {
                continue;
            }
            for (const p of intersections(path, shapeOf(out, c))) {
                const t = along(p);
                if (t > done + 1e-9 && (!next || t < next.t)) {
                    next = { id: c.id, at: p, t };
                }
            }
        }
        if (!next) {
            break;
        }
        done = next.t;
        const plan = trimAt(out, next.id, next.at, opts);
        if (plan) {
            out = plan.g;
            trimmed += 1;
        }
    }
    return { g: out, trimmed };
}

/** Relations that would hold a moved end where it was (as Extend drops them), and a line's length and middle. */
function dropHolds(g: SketchGeometry, end: string, line: string): SketchGeometry {
    const holds = (k: SketchConstraint) => (k.kind === 'fix' && k.point === end)
        || (k.kind === 'distance' && (k.a === end || k.b === end))
        || (k.kind === 'pointOnCurve' && k.point === end)
        || (k.kind === 'coincident' && (k.a === end || k.b === end))
        || (k.kind === 'midpoint' && k.point === end)
        || (k.kind === 'symmetric' && (k.a === end || k.b === end))
        || (k.kind === 'length' && k.line === line) || (k.kind === 'midpoint' && k.line === line)
        || (k.kind === 'equal' && (k.a === line || k.b === line));
    return { ...g, constraints: g.constraints.filter((k) => !holds(k)) };
}

/**
 * Corner: trims or extends two lines until they meet. Each line keeps the side of the corner where it was clicked;
 * the other end moves to the corner, and the two lines share it.
 */
export function trimCorner(g: SketchGeometry, a: { id: string; at: Pt }, b: { id: string; at: Pt }): { g: SketchGeometry } | { error: string } {
    const la = curveOf(g, a.id);
    const lb = curveOf(g, b.id);
    if (la?.kind !== 'line' || lb?.kind !== 'line' || a.id === b.id) {
        return { error: 'Corner works on two lines.' };
    }
    const [p1, p2, p3, p4] = [P(g, la.a), P(g, la.b), P(g, lb.a), P(g, lb.b)];
    const den = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if (Math.abs(den) < 1e-9) {
        return { error: 'The lines are parallel; they have no corner.' };
    }
    const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / den;
    const x: Pt = [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
    const param = (line: Line, p: Pt) => {
        const [s, e] = [P(g, line.a), P(g, line.b)];
        const l2 = (e[0] - s[0]) ** 2 + (e[1] - s[1]) ** 2 || 1;
        return ((p[0] - s[0]) * (e[0] - s[0]) + (p[1] - s[1]) * (e[1] - s[1])) / l2;
    };
    // The end on the far side of the corner from the click moves; with the corner at an end, that end.
    const moving = (line: Line, click: Pt) => (param(line, click) > param(line, x) ? line.a : line.b);
    const ea = moving(la, a.at);
    const eb = moving(lb, b.at);
    if (ea === eb) {
        return { error: 'The lines already meet there.' };
    }
    const shared = (id: string, own: string) => g.curves.some((k) => k.id !== own && curvePoints(k).includes(id));
    if (shared(ea, la.id) || shared(eb, lb.id)) {
        return { error: 'An end that other curves share cannot move to the corner.' };
    }
    let out: SketchGeometry = { ...g, points: g.points.map((p) => (p.id === ea ? { ...p, u: x[0], v: x[1] } : p)) };
    out = dropHolds(dropHolds(out, ea, la.id), eb, lb.id);
    out = { ...out, curves: out.curves.map((k) => (k.id === lb.id ? { ...lb, ...(lb.a === eb ? { a: ea } : { b: ea }) } : k)) };
    // The old end of the second line goes, with what referred to it.
    return {
        g: {
            points: out.points.filter((p) => p.id !== eb),
            curves: out.curves,
            constraints: out.constraints.filter((k) => !constraintRefs(k).includes(eb)),
        },
    };
}

/** The point at parameter t along a line (0..1) or round an arc (angle from its start). */
function pointAt(g: SketchGeometry, c: SketchCurve, t: number): Pt {
    const s = shapeOf(g, c);
    if (s.kind === 'line') {
        return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
    }
    const a = (s.from ?? 0) + t;
    return [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)];
}

/** Where the curve crosses each boundary, in order along it (null unless it crosses each exactly once). */
function boundaryCuts(g: SketchGeometry, c: SketchCurve, bounds: [string, string]): [number, number] | null {
    const s = shapeOf(g, c);
    const ts: number[] = [];
    for (const b of bounds) {
        const other = curveOf(g, b);
        if (!other) {
            return null;
        }
        const hits = intersections(s, shapeOf(g, other));
        if (hits.length !== 1) {
            return null;
        }
        const p = hits[0];
        if (s.kind === 'line') {
            const l2 = (s.b[0] - s.a[0]) ** 2 + (s.b[1] - s.a[1]) ** 2 || 1;
            ts.push(((p[0] - s.a[0]) * (s.b[0] - s.a[0]) + (p[1] - s.a[1]) * (s.b[1] - s.a[1])) / l2);
        } else {
            const a = Math.atan2(p[1] - s.c[1], p[0] - s.c[0]) - (s.from ?? 0);
            ts.push(((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
        }
    }
    const [x, y] = ts;
    return x < y ? [x, y] : [y, x];
}

/**
 * Trim away inside: the piece of the curve between the two boundaries goes. Trim away outside: the pieces beyond them
 * go and the piece between stays. The curve must be a line or an arc crossing each boundary once.
 */
export function trimBetween(g: SketchGeometry, curveId: string, bounds: [string, string], mode: 'inside' | 'outside',
    o: TrimSettings = {}): { g: SketchGeometry } | { error: string } {
    const c = curveOf(g, curveId);
    if (!c || c.kind === 'circle') {
        return { error: 'Pick a line or an arc that crosses both boundaries.' };
    }
    if (bounds.includes(curveId)) {
        return { error: 'That is one of the boundaries.' };
    }
    const cuts = boundaryCuts(g, c, bounds);
    if (!cuts) {
        return { error: 'That curve does not cross each boundary once.' };
    }
    const opts: TrimOptions = { by: bounds, construction: o.construction };
    const shape = shapeOf(g, c);
    const span = shape.kind === 'line' ? 1 : shape.sweep ?? 2 * Math.PI;
    if (mode === 'inside') {
        const plan = trimAt(g, curveId, pointAt(g, c, (cuts[0] + cuts[1]) / 2), opts);
        return plan ? { g: plan.g } : { error: 'Nothing to trim there.' };
    }
    // Outside: both ends go, each from the curve's end to the nearer boundary (absolute points, as the curve changes).
    const before = pointAt(g, c, cuts[0] / 2);
    const after = pointAt(g, c, (cuts[1] + span) / 2);
    const first = trimAt(g, curveId, before, opts);
    if (!first) {
        return { error: 'Nothing to trim there.' };
    }
    const second = trimAt(first.g, curveId, after, opts);
    return { g: (second ?? first).g };
}
