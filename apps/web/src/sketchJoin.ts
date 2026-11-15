// Combining split entities (SolidWorks: select a split point and press Delete): the two pieces that meet at the
// point become one curve again when they are parts of one curve: lines in line, arcs on one circle, partial
// ellipses on one ellipse, parabolas on one focus and vertex, conics on one conic, splines and style splines that
// run smoothly through the point. The point itself goes.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { clampedKnots, type P2 } from '@jarvis/core/curves';
import { paramOf, pointAt } from '@jarvis/core/curveIntersect';
import { bezierOver, conicPiece } from '@jarvis/core/curveSplit';
import { curveOf, pointOf } from './solver';
import { constraintRefs, extentHeld, newId } from './sketchGeometry';
import { curveEndIds, curvePointIds, reversedSpline, styleDegree } from './sketchCurves';
import { dropUnusedPoints, geomOfCurve } from './sketchCut';

type Pt = [number, number];
const dist = (p: Pt, q: Pt): number => Math.hypot(q[0] - p[0], q[1] - p[1]);
const sub = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]];
const cross = (p: Pt, q: Pt): number => p[0] * q[1] - p[1] * q[0];
const dot = (p: Pt, q: Pt): number => p[0] * q[0] + p[1] * q[1];
const at = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** The curve run the other way (lines, parabolas, conics, splines and style splines; arcs and partial ellipses run counter-clockwise only). */
function reversed(c: SketchCurve): SketchCurve | null {
    switch (c.kind) {
        case 'line':
            return { ...c, a: c.b, b: c.a };
        case 'parabola':
        case 'conic':
            return { ...c, start: c.end, end: c.start };
        case 'spline':
            return reversedSpline(c);
        case 'styleSpline':
            return { ...c, points: [...c.points].reverse(), ...(c.knots ? { knots: c.knots.map((k) => 1 - k).reverse() } : {}) };
        default:
            return null;
    }
}

/** Whether a, p, b turn smoothly at p: a before it, b after it, on one line through it. */
function smooth(a: Pt, p: Pt, b: Pt): boolean {
    const [u, v] = [sub(p, a), sub(b, p)];
    const l = Math.hypot(...u) * Math.hypot(...v);
    return l > 0 && Math.abs(cross(u, v)) <= 1e-7 * l && dot(u, v) > 0;
}

/**
 * The one curve that pieces a (ending at p) and b (starting at p) make, under a's id, or null when they are not
 * parts of one curve. New points it needs (a joined style spline's control vertices) are added to g.
 */
function joined(g: SketchGeometry, a: SketchCurve, b: SketchCurve, p: string): { g: SketchGeometry; curve: SketchCurve } | null {
    const [a0] = curveEndIds(a);
    const b1 = curveEndIds(b)[1];
    const closes = a0 === b1;
    const keep = (curve: SketchCurve) => ({ g, curve: { ...curve, id: a.id } as SketchCurve });
    switch (a.kind) {
        case 'line': {
            if (b.kind !== 'line' || closes || !smooth(at(g, a0), at(g, p), at(g, b1))) {
                return null;
            }
            return keep({ ...a, a: a0, b: b1 });
        }
        case 'arc': {
            if (b.kind !== 'arc' || b.center !== a.center) {
                return null;
            }
            return keep(closes ? { id: a.id, kind: 'circle', center: a.center, radius: dist(at(g, a.center), at(g, p)), ...(a.construction ? { construction: true } : {}) }
                : { ...a, start: a0, end: b1 });
        }
        case 'ellipseArc': {
            if (b.kind !== 'ellipseArc' || b.center !== a.center || b.major !== a.major || b.minor !== a.minor) {
                return null;
            }
            return keep(closes ? { id: a.id, kind: 'ellipse', center: a.center, major: a.major, minor: a.minor, ...(a.construction ? { construction: true } : {}) }
                : { ...a, start: a0, end: b1 });
        }
        case 'parabola': {
            if (b.kind !== 'parabola' || b.focus !== a.focus || b.vertex !== a.vertex || closes) {
                return null;
            }
            return keep({ ...a, start: a0, end: b1 });
        }
        case 'conic': {
            const ga = geomOfCurve(g, a);
            if (b.kind !== 'conic' || closes || ga?.kind !== 'conic') {
                return null;
            }
            // b must lie on a's conic, running on from a's end.
            const gb = geomOfCurve(g, b);
            const far = at(g, b1);
            const t = paramOf(ga, far);
            if (!gb || !Number.isFinite(t) || [0.25, 0.5, 0.75].some((s) => {
                const q = pointAt(gb, (s * Math.PI) / 2);
                return dist(q, pointAt(ga, paramOf(ga, q))) > 1e-7;
            })) {
                return null;
            }
            const end = t > Math.PI / 2 ? t : t + Math.PI;
            const piece = conicPiece(ga, 0, end);
            if (!piece || dist(pointAt(ga, end), far) > 1e-7) {
                return null;
            }
            const out = { ...g, points: g.points.map((q) => (q.id === a.apex ? { ...q, u: piece.apex[0], v: piece.apex[1] } : q)) };
            return { g: out, curve: { ...a, start: a0, end: b1, rho: piece.rho } };
        }
        case 'spline': {
            if (b.kind !== 'spline' || !a.endHandle || !b.startHandle || !smooth(at(g, a.endHandle), at(g, p), at(g, b.startHandle))) {
                return null;
            }
            // The split point goes: the pieces either side of it become one again, their parameter lengths added.
            const spans = (c: Extract<SketchCurve, { kind: 'spline' }>) => {
                const f = c.spacing && c.spacing.length === c.points.length - 1 ? c.spacing : c.points.slice(1).map(() => 1);
                return f.map((k, i) => k * dist(at(g, c.points[i]), at(g, c.points[i + 1])));
            };
            const [lenA, lenB] = [spans(a), spans(b)];
            const points = [...a.points.slice(0, -1), ...b.points.slice(1)];
            if (closes && points.length < 4) {
                return null;
            }
            const lengths = [...lenA.slice(0, -1), lenA[lenA.length - 1] + lenB[0], ...lenB.slice(1)];
            const spacing = lengths.map((l, i) => {
                const chord = dist(at(g, points[i]), at(g, points[i + 1]));
                return chord > 1e-12 ? l / chord : 1;
            });
            const curve: Extract<SketchCurve, { kind: 'spline' }> = { id: a.id, kind: 'spline', points, ...(a.construction ? { construction: true } : {}) };
            if (!closes) {
                if (a.startHandle) {
                    curve.startHandle = a.startHandle;
                }
                if (b.endHandle) {
                    curve.endHandle = b.endHandle;
                }
            } else if (a.startHandle || b.endHandle) {
                // A closed spline runs smoothly through its first point and takes no handles there.
                return null;
            }
            if (spacing.some((f) => Math.abs(f - 1) > 1e-12)) {
                curve.spacing = spacing;
            }
            // Handles and held curvatures at the points that stay (sketchSplines.ts).
            const handles = [...(a.handles ?? []), ...(b.handles ?? [])].filter((h) => points.includes(h.point));
            const curvature = [...(a.curvature ?? []), ...(b.curvature ?? [])].filter((k) => points.includes(k.point));
            if (handles.length) {
                curve.handles = handles;
            }
            if (curvature.length) {
                curve.curvature = curvature;
            }
            if (a.continuity === false || b.continuity === false) {
                curve.continuity = false;
            }
            return keep(curve);
        }
        case 'styleSpline': {
            if (b.kind !== 'styleSpline' || closes || a.degree !== b.degree) {
                return null;
            }
            const [pa, pb] = [a.points.map((id) => at(g, id)), b.points.map((id) => at(g, id))];
            if (!smooth(pa[pa.length - 2], at(g, p), pb[1])) {
                return null;
            }
            const da = styleDegree(a);
            const db = styleDegree(b);
            let poles: P2[];
            let knots: number[] | undefined;
            if (da === pa.length - 1 && db === pb.length - 1) {
                // Two Bezier pieces of one Bezier curve cut at s: the curve is either piece taken on to the other's end.
                if (da !== db) {
                    return null;
                }
                const [la, lb] = [dist(pa[pa.length - 2], at(g, p)), dist(at(g, p), pb[1])];
                const s = la / (la + lb);
                poles = s >= 0.5 ? bezierOver(pa, 0, 1 / s) : bezierOver(pb, -s / (1 - s), 1);
                const check = s >= 0.5 ? bezierOver(poles, s, 1) : bezierOver(poles, 0, s);
                const other = s >= 0.5 ? pb : pa;
                if (check.some((q, i) => dist(q, other[i]) > 1e-7)) {
                    return null;
                }
            } else {
                // B-splines of one degree: end to end, their shared end a knot of full multiplicity (exactly both pieces).
                const deg = da;
                if (db !== deg || da === pa.length - 1 || db === pb.length - 1) {
                    return null;
                }
                const inner = (c: Extract<SketchCurve, { kind: 'styleSpline' }>, n: number) => clampedKnots(n, deg, c.knots).slice(deg + 1, n);
                const u = la(pa) / (la(pa) + la(pb));
                knots = [...inner(a, pa.length).map((k) => k * u), ...new Array(deg).fill(u), ...inner(b, pb.length).map((k) => u + k * (1 - u))];
                poles = [...pa, ...pb.slice(1)];
            }
            let out = g;
            const ids = poles.map((q, i) => {
                if (i === 0) {
                    return a0;
                }
                if (i === poles.length - 1) {
                    return b1;
                }
                const id = newId('p', out);
                out = { ...out, points: [...out.points, { id, u: q[0], v: q[1] }] };
                return id;
            });
            const curve: Extract<SketchCurve, { kind: 'styleSpline' }> = { id: a.id, kind: 'styleSpline', points: ids, ...(a.construction ? { construction: true } : {}) };
            if (a.degree) {
                curve.degree = a.degree;
            }
            if (knots) {
                curve.knots = knots;
            }
            return { g: out, curve };
        }
        default:
            return null;
    }
}

/** Length of a control polygon. */
function la(pts: P2[]): number {
    return pts.slice(1).reduce((s, q, i) => s + dist(pts[i], q), 0);
}

/**
 * Combines the two pieces that meet at a split point into one curve, under the first piece's id; the point and
 * what referred to it go, the second piece's relations move to the joined curve. Null when the point is not
 * where exactly two parts of one curve meet.
 */
export function joinAtPoint(g: SketchGeometry, point: string): SketchGeometry | null {
    const users = g.curves.filter((c) => curvePointIds(c).includes(point));
    const ending = users.filter((c) => curveEndIds(c).includes(point));
    if (users.length !== 2 || ending.length !== 2 || ending[0].kind !== ending[1].kind || !!ending[0].construction !== !!ending[1].construction) {
        return null;
    }
    // a ends at the point and b starts there; a curve that runs one way only is taken as it is.
    let [a, b] = ending;
    const endsAt = (c: SketchCurve) => curveEndIds(c)[1] === point;
    const startsAt = (c: SketchCurve) => curveEndIds(c)[0] === point;
    if (!(endsAt(a) && startsAt(b))) {
        if (endsAt(b) && startsAt(a)) {
            [a, b] = [b, a];
        } else {
            const flipA = reversed(a);
            const flipB = reversed(b);
            if (startsAt(a) && startsAt(b) && flipA) {
                a = flipA;
            } else if (endsAt(a) && endsAt(b) && flipB) {
                b = flipB;
            } else {
                return null;
            }
        }
    }
    if (curveEndIds(a)[0] === point || curveEndIds(b)[1] === point) {
        return null;
    }
    const r = joined(g, a, b, point);
    if (!r) {
        return null;
    }
    // The first of the two keeps its id (as Split gave the first piece the curve's id).
    const keepId = ending[0].id;
    const gone = ending[1].id;
    const curve = { ...r.curve, id: keepId };
    const drop = (k: SketchConstraint) => constraintRefs(k).includes(point) || extentHeld(k, keepId) || extentHeld(k, gone)
        || (k.kind === 'length' && (k.line === keepId || k.line === gone))
        || (k.kind === 'midpoint' && (k.line === keepId || k.line === gone));
    const rename = (id: string) => (id === gone ? keepId : id);
    const moved = new Set(r.g.constraints.filter((k) => constraintRefs(k).includes(gone)).map((k) => k.id));
    let constraints = r.g.constraints.filter((k) => !drop(k)).map((k) => retarget(k, rename));
    // What became a relation of the curve to itself, of its end to itself, or a repeat of one it has, goes.
    const ownEnds = new Set(curveEndIds(curve));
    const key = (k: SketchConstraint) => `${k.kind}:${[...constraintRefs(k)].sort().join(',')}:${'axis' in k ? k.axis ?? '' : ''}`;
    const held = new Set(constraints.filter((k) => !moved.has(k.id)).map(key));
    constraints = constraints.filter((k) => {
        const refs = constraintRefs(k);
        if (refs.length >= 2 && refs.every((x) => x === keepId)) {
            return false;
        }
        if (k.kind === 'pointOnCurve' && k.curve === keepId && ownEnds.has(k.point)) {
            return false;
        }
        return !moved.has(k.id) || !held.has(key(k));
    });
    const out: SketchGeometry = {
        ...r.g,
        curves: r.g.curves.filter((c) => c.id !== gone).map((c) => (c.id === keepId ? curve : c)),
        points: r.g.points.filter((p) => p.id !== point),
        constraints,
    };
    return dropUnusedPoints(out, [...curvePointIds(a), ...curvePointIds(b)]);
}

/** A constraint with its curve ids renamed. */
function retarget(k: SketchConstraint, f: (id: string) => string): SketchConstraint {
    const out = { ...k } as Record<string, unknown>;
    for (const key of ['a', 'b', 'curve', 'line', 'about'] as const) {
        if (typeof out[key] === 'string') {
            out[key] = f(out[key] as string);
        }
    }
    if (k.kind === 'pathLength') {
        out.curves = [...new Set(k.curves.map(f))];
    }
    return out as SketchConstraint;
}

/** Deleting points: each split point where two parts of one curve meet combines them instead; the rest are left to delete. */
export function joinSplitPoints(g: SketchGeometry, ids: string[]): { g: SketchGeometry; joined: string[] } {
    let out = g;
    const joinedIds: string[] = [];
    for (const id of ids) {
        if (!out.points.some((p) => p.id === id) || curveOf(out, id)) {
            continue;
        }
        const next = joinAtPoint(out, id);
        if (next) {
            out = next;
            joinedIds.push(id);
        }
    }
    return { g: out, joined: joinedIds };
}
