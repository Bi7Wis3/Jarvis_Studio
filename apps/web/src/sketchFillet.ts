// Sketch fillet on lines and arcs (other curve kinds: sketchCurveFillet.ts), as in SolidWorks: the corner is rounded by a tangent arc; with Keep constrained
// corners the sharp corner stays as a point on both curves (a virtual sharp) holding its relations and dimensions, and
// the dimensions of the sides go to construction lines from the sharp; with Dimension each fillet off, the fillet is
// equal to the first one instead of getting its own radius dimension.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf, pointOf } from './solver';
import { addConstraint, constraintRefs, extentHeld, newId, type NewConstraint } from './sketchGeometry';
import { curvePoints, notForCurve, shapeOf } from './sketchEdit';
import { curveEndIds } from './sketchCurves';
import { chamferCurves, curveCornerAt, curveCornerOf, filletCurves, needsCurveCorner, type CurveCorner } from './sketchCurveFillet';
import { dist, type Pt } from './sketchMath';
import { intersections } from './snapping';
import { isEndless } from './sketchInfinite';

type Shape = ReturnType<typeof shapeOf>;

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};
const unit = (p: Pt, q: Pt): Pt => {
    const d = dist(p, q) || 1;
    return [(q[0] - p[0]) / d, (q[1] - p[1]) / d];
};

/** One side of the corner: the curve, its end at the corner (that moves) and its other end. */
interface Side {
    curve: SketchCurve;
    near: string;
    far: string;
}

export interface FilletCorner {
    /** Where the sides meet (or would). */
    at: Pt;
    /** The shared corner point, when the sides share one. */
    point: string | null;
    sides: [Side, Side];
    /** A corner beyond two lines, or lines and arcs at an end: made on the exact curves (sketchCurveFillet.ts). */
    curves?: CurveCorner;
}

/** Where each curve was clicked for a corner of two curves (which part of each the fillet keeps). */
const pickedAt = new Map<string, Pt>();
export function notePick(curve: string, at: Pt): void {
    pickedAt.clear();
    pickedAt.set(curve, at);
}
export const pickPosition = (curve: string): Pt | null => pickedAt.get(curve) ?? null;

function general(cc: CurveCorner | { error: string }): FilletCorner | { error: string } {
    if ('error' in cc) {
        return cc;
    }
    const side = (s: CurveCorner['sides'][number]): Side => ({ curve: s.curve, near: s.near ?? '', far: s.farId ?? '' });
    return { at: cc.at, point: cc.point, sides: [side(cc.sides[0]), side(cc.sides[1])], curves: cc };
}

const endsOf = (c: SketchCurve): string[] => curveEndIds(c);

/** The corner at a point: the two drawn lines or arcs that end there (construction curves through it do not count). */
export function filletCornerAt(g: SketchGeometry, point: string): FilletCorner | { error: string } {
    const users = g.curves.filter((c) => endsOf(c).includes(point));
    const drawn = users.filter((c) => !c.construction);
    const pair = drawn.length === 2 ? drawn : users.length === 2 ? users : null;
    const odd = pair?.find((c) => isEndless(c));
    if (odd) {
        return { error: notForCurve('Fillet and chamfer', odd)!.replace('does not work', 'do not work') };
    }
    if (!pair || g.curves.some((c) => (c.kind === 'arc' || c.kind === 'ellipseArc') && c.center === point && pair.includes(c))) {
        return { error: 'Pick a corner where two curves meet.' };
    }
    if (needsCurveCorner(pair[0], pair[1], true)) {
        return general(curveCornerAt(g, point, pair[0], pair[1]));
    }
    const side = (c: SketchCurve): Side => ({ curve: c, near: point, far: endsOf(c).find((p) => p !== point) ?? point });
    return { at: P(g, point), point, sides: [side(pair[0]), side(pair[1])] };
}

/** The corner of two picked curves: their shared end, or (two lines) where they would meet. */
export function filletCornerOf(g: SketchGeometry, a: string, b: string, picks?: [Pt | null, Pt | null]): FilletCorner | { error: string } {
    const ca = curveOf(g, a);
    const cb = curveOf(g, b);
    if (isEndless(ca) || isEndless(cb)) {
        return { error: notForCurve('Fillet and chamfer', isEndless(ca) ? ca : cb)!.replace('does not work', 'do not work') };
    }
    if (!ca || !cb || a === b) {
        return { error: 'Pick two curves.' };
    }
    const meet = endsOf(ca).some((p) => endsOf(cb).includes(p));
    if (needsCurveCorner(ca, cb, meet)) {
        return general(curveCornerOf(g, ca, cb, picks ?? [pickPosition(a), pickPosition(b)]));
    }

    const shared = endsOf(ca).find((p) => endsOf(cb).includes(p));
    if (shared) {
        const users = g.curves.filter((c) => endsOf(c).includes(shared) && !c.construction);
        if (users.length !== 2) {
            return { error: 'More than two curves meet there.' };
        }
        return { at: P(g, shared), point: shared, sides: [{ curve: ca, near: shared, far: endsOf(ca).find((p) => p !== shared)! }, { curve: cb, near: shared, far: endsOf(cb).find((p) => p !== shared)! }] };
    }
    if (ca.kind !== 'line' || cb.kind !== 'line') {
        return { error: 'An arc can be filleted where it meets the other curve.' };
    }
    const [p1, p2, p3, p4] = [P(g, ca.a), P(g, ca.b), P(g, cb.a), P(g, cb.b)];
    const den = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if (Math.abs(den) < 1e-9) {
        return { error: 'The lines are parallel.' };
    }
    const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / den;
    const x: Pt = [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
    const side = (c: Extract<SketchCurve, { kind: 'line' }>, s: Pt, e: Pt): Side => (dist(s, x) <= dist(e, x) ? { curve: c, near: c.a, far: c.b } : { curve: c, near: c.b, far: c.a });
    return { at: x, point: null, sides: [side(ca, p1, p2), side(cb, p3, p4)] };
}

/** A side as an unbounded shape, for the fillet centre: a long line, or the arc's whole circle. */
function full(s: Shape): Shape {
    if (s.kind === 'line') {
        const u = unit(s.a, s.b);
        return { id: s.id, kind: 'line', a: [s.a[0] - u[0] * 1e5, s.a[1] - u[1] * 1e5], b: [s.b[0] + u[0] * 1e5, s.b[1] + u[1] * 1e5] };
    }
    return { id: s.id, kind: 'circle', c: s.c, r: s.r };
}

/** The side moved by r either way: two parallel lines, or the circles r larger and smaller. */
function offsets(s: Shape, r: number): Shape[] {
    if (s.kind === 'line') {
        const u = unit(s.a, s.b);
        const n: Pt = [-u[1] * r, u[0] * r];
        return [1, -1].map((k) => full({ ...s, a: [s.a[0] + n[0] * k, s.a[1] + n[1] * k], b: [s.b[0] + n[0] * k, s.b[1] + n[1] * k] }));
    }
    return [s.r + r, s.r - r].filter((x) => x > 1e-9).map((x) => ({ id: s.id, kind: 'circle' as const, c: s.c, r: x }));
}

/** Where a circle about c touches the side. */
function touch(s: Shape, c: Pt): Pt {
    if (s.kind === 'line') {
        const d: Pt = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
        const t = ((c[0] - s.a[0]) * d[0] + (c[1] - s.a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1);
        return [s.a[0] + d[0] * t, s.a[1] + d[1] * t];
    }
    const u = unit(s.c, c);
    return [s.c[0] + u[0] * s.r, s.c[1] + u[1] * s.r];
}

/** Whether p lies on the side between its corner end and its far end (the part the fillet may eat into). */
function within(g: SketchGeometry, side: Side, at: Pt, p: Pt): boolean {
    const s = shapeOf(g, side.curve);
    const far = P(g, side.far);
    if (s.kind === 'line') {
        const d: Pt = [far[0] - at[0], far[1] - at[1]];
        const t = ((p[0] - at[0]) * d[0] + (p[1] - at[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1);
        return t > 1e-9 && t < 1 - 1e-9;
    }
    // On an arc: between the corner and the far end, going the arc's way.
    const ang = (q: Pt) => Math.atan2(q[1] - s.c[1], q[0] - s.c[0]);
    const tau = 2 * Math.PI;
    const norm = (a: number) => ((a % tau) + tau) % tau;
    const fromCorner = side.near === (side.curve as { start: string }).start;
    const span = fromCorner ? norm(ang(far) - ang(at)) : norm(ang(at) - ang(far));
    const t = fromCorner ? norm(ang(p) - ang(at)) : norm(ang(at) - ang(p));
    return t > 1e-9 && t < span - 1e-9;
}

export interface FilletOptions {
    /** Keep constrained corners: the corner stays as a point on both sides with its relations and dimensions. */
    keepCorners?: boolean;
    /** Instead of a radius dimension, an equal relation to this fillet arc (Dimension each fillet off). */
    equalTo?: string | null;
}

export interface FilletResult {
    g: SketchGeometry;
    arc: string;
    /** Relations and dimensions removed (only without Keep constrained corners). */
    dropped: number;
    /** The sharp corner was kept as a point. */
    kept: boolean;
}

/** Side relations of a line that stop holding once it is cut back: its length, middle and equal length. */
const sideRelation = (k: SketchConstraint, line: string) => (k.kind === 'length' && k.line === line) || (k.kind === 'midpoint' && k.line === line)
    || (k.kind === 'equal' && (k.a === line || k.b === line)) || extentHeld(k, line);

/**
 * Rounds the corner with a tangent arc of `radius`. Tangency is held by construction spokes from the fillet's centre:
 * square to a line, and through the centre of an arc (the solver's tangent relation is degenerate where the curves
 * share a point).
 */
export function filletSides(g: SketchGeometry, corner: FilletCorner, radius: number, o: FilletOptions = {}): FilletResult | { error: string } {
    if (corner.curves) {
        return filletCurves(g, corner.curves, radius, o);
    }
    if (!(radius > 0)) {
        return { error: 'Type a radius above zero.' };
    }
    const [s1, s2] = corner.sides;
    const shapes = [shapeOf(g, s1.curve), shapeOf(g, s2.curve)];
    // Candidate centres: where the sides moved by the radius cross; the one whose touching points lie on both sides,
    // nearest the corner.
    let best: { c: Pt; t: [Pt, Pt]; d: number } | null = null;
    for (const x of offsets(shapes[0], radius)) {
        for (const y of offsets(shapes[1], radius)) {
            for (const c of intersections(x, y)) {
                const t: [Pt, Pt] = [touch(shapes[0], c), touch(shapes[1], c)];
                if (!within(g, s1, corner.at, t[0]) || !within(g, s2, corner.at, t[1])) {
                    continue;
                }
                const d = dist(t[0], corner.at) + dist(t[1], corner.at);
                if (!best || d < best.d) {
                    best = { c, t, d };
                }
            }
        }
    }
    if (!best) {
        return { error: 'The radius is too big for these curves, or they are in line.' };
    }
    let out = g;
    const point = (at: Pt) => {
        const id = newId('p', out);
        out = { ...out, points: [...out.points, { id, u: at[0], v: at[1] }] };
        return id;
    };
    const putCurve = (c: SketchCurve) => {
        out = { ...out, curves: out.curves.some((k) => k.id === c.id) ? out.curves.map((k) => (k.id === c.id ? c : k)) : [...out.curves, c] };
    };
    const extra: NewConstraint[] = [];
    const keep = o.keepCorners !== false;
    const before = g.constraints.length;
    // The sharp: the corner point (or a new one where two lines would meet) when anything is tied to it.
    let sharp: string | null = null;
    const needSharp = (): string => {
        sharp ??= corner.point ?? point(corner.at);
        return sharp;
    };
    const ends = [s1, s2].map((side, i) => {
        const t = point(best!.t[i]);
        const c = side.curve;
        putCurve(c.kind === 'line' ? (c.a === side.near ? { ...c, a: t } : { ...c, b: t }) : c.kind === 'arc' ? (c.start === side.near ? { ...c, start: t } : { ...c, end: t }) : c);
        if (c.kind === 'line' && out.constraints.some((k) => sideRelation(k, c.id))) {
            if (keep) {
                // The side's dimensions and relations move to a construction line from the sharp to its far end.
                const id = newId('c', out);
                putCurve({ id, kind: 'line', a: needSharp(), b: side.far, construction: true });
                out = {
                    ...out,
                    constraints: out.constraints.map((k) => (!sideRelation(k, c.id) ? k
                        : k.kind === 'equal' || k.kind === 'distance' ? { ...k, a: k.a === c.id ? id : k.a, b: k.b === c.id ? id : k.b }
                            : { ...k, line: id } as SketchConstraint)),
                };
            } else {
                out = { ...out, constraints: out.constraints.filter((k) => !sideRelation(k, c.id)) };
            }
        }
        if (c.kind === 'arc') {
            // A cut-back arc no longer has its arc length.
            out = { ...out, constraints: out.constraints.filter((k) => !extentHeld(k, c.id)) };
        }
        return t;
    });
    // The old corner point: kept as the sharp when something holds it, else removed.
    const stillUsed = corner.point && out.curves.some((c) => curvePoints(c).includes(corner.point!));
    const tied = corner.point && out.constraints.some((k) => constraintRefs(k).includes(corner.point!));
    if (corner.point && (stillUsed || (tied && keep))) {
        needSharp();
    } else if (corner.point && !stillUsed) {
        const gone = corner.point;
        out = { ...out, points: out.points.filter((p) => p.id !== gone), constraints: out.constraints.filter((k) => !constraintRefs(k).includes(gone)) };
    }
    if (sharp) {
        extra.push({ kind: 'pointOnCurve', point: sharp, curve: s1.curve.id }, { kind: 'pointOnCurve', point: sharp, curve: s2.curve.id });
    }
    // Lines whose far ends lose them (two lines that did not meet): their old near ends go if nothing uses them.
    for (const side of [s1, s2]) {
        if (side.near !== corner.point && !out.curves.some((c) => curvePoints(c).includes(side.near))) {
            out = { ...out, points: out.points.filter((p) => p.id !== side.near), constraints: out.constraints.filter((k) => !constraintRefs(k).includes(side.near)) };
        }
    }
    const dropped = before - out.constraints.length;
    const centre = point(best.c);
    const [e1, e2] = [best.t[0], best.t[1]];
    const ccw = (e1[0] - best.c[0]) * (e2[1] - best.c[1]) - (e1[1] - best.c[1]) * (e2[0] - best.c[0]) > 0;
    const arc = newId('c', out);
    putCurve({ id: arc, kind: 'arc', center: centre, start: ends[ccw ? 0 : 1], end: ends[ccw ? 1 : 0] });
    extra.push(o.equalTo && curveOf(out, o.equalTo) ? { kind: 'equal', a: arc, b: o.equalTo } : { kind: 'radius', curve: arc, value: radius });
    [s1, s2].forEach((side, i) => {
        const spoke = newId('c', out);
        putCurve({ id: spoke, kind: 'line', a: centre, b: ends[i], construction: true });
        extra.push(side.curve.kind === 'line' ? { kind: 'perpendicular', a: spoke, b: side.curve.id }
            : { kind: 'pointOnCurve', point: (side.curve as { center: string }).center, curve: spoke });
    });
    for (const c of extra) {
        out = addConstraint(out, c).g;
    }
    return { g: out, arc, dropped: Math.max(0, dropped), kept: !!sharp };
}

export interface ChamferOptions {
    /** Distance-distance (with `distance2`, or equal when absent) or angle-distance (with `angle`, degrees). */
    type: 'distance' | 'angle';
    distance: number;
    distance2?: number;
    angle?: number;
}

/**
 * Cuts the corner of two lines with a straight line: Distance 1 back along the first, and Distance 2 (or the same) back
 * along the second, or at an angle from the first. The corner stays as a sharp point on both lines, joined to the cut
 * by construction legs that carry the dimensions; the lines' own dimensions move to construction lines from the sharp.
 */
export function chamferSides(g: SketchGeometry, corner: FilletCorner, o: ChamferOptions): { g: SketchGeometry } | { error: string } {
    const [s1, s2] = corner.sides;
    if (corner.curves || s1.curve.kind !== 'line' || s2.curve.kind !== 'line') {
        // Anything but two lines: on the exact curves (an arc meeting a line at an end too).
        const cc = corner.curves ?? (corner.point ? curveCornerAt(g, corner.point, s1.curve, s2.curve) : null);
        if (!cc || 'error' in cc) {
            return cc ?? { error: 'Pick a corner, or two curves.' };
        }
        return chamferCurves(g, cc, o);
    }
    if (!(o.distance > 0)) {
        return { error: 'Type a distance above zero.' };
    }
    const u1 = unit(corner.at, P(g, s1.far));
    const u2 = unit(corner.at, P(g, s2.far));
    const phi = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (phi < 1e-3 || phi > Math.PI - 1e-3) {
        return { error: 'The lines are in line; there is no corner to cut.' };
    }
    const d1 = o.distance;
    let d2 = o.distance;
    if (o.type === 'angle') {
        const theta = ((o.angle ?? 45) * Math.PI) / 180;
        if (!(theta > 0) || theta + phi >= Math.PI - 1e-6) {
            return { error: 'That angle does not meet the second line.' };
        }
        d2 = (d1 * Math.sin(theta)) / Math.sin(Math.PI - theta - phi);
    } else if (o.distance2 !== undefined) {
        d2 = o.distance2;
        if (!(d2 > 0)) {
            return { error: 'Type a distance above zero.' };
        }
    }
    if (d1 >= dist(corner.at, P(g, s1.far)) - 1e-6 || d2 >= dist(corner.at, P(g, s2.far)) - 1e-6) {
        return { error: 'The distance is too big for these lines.' };
    }
    let out = g;
    const point = (at: Pt) => {
        const id = newId('p', out);
        out = { ...out, points: [...out.points, { id, u: at[0], v: at[1] }] };
        return id;
    };
    const putCurve = (c: SketchCurve) => {
        out = { ...out, curves: out.curves.some((k) => k.id === c.id) ? out.curves.map((k) => (k.id === c.id ? c : k)) : [...out.curves, c] };
        return c.id;
    };
    const sharp = corner.point ?? point(corner.at);
    const sides: [Side, number, Pt][] = [[s1, d1, u1], [s2, d2, u2]];
    const ends = sides.map(([side, d, u]) => {
        const c = side.curve as Extract<SketchCurve, { kind: 'line' }>;
        const t = point([corner.at[0] + u[0] * d, corner.at[1] + u[1] * d]);
        putCurve(c.a === side.near ? { ...c, a: t } : { ...c, b: t });
        if (out.constraints.some((k) => sideRelation(k, c.id))) {
            // The line's dimensions and relations move to a construction line from the sharp to its far end.
            const id = putCurve({ id: newId('c', out), kind: 'line', a: sharp, b: side.far, construction: true });
            out = {
                ...out,
                constraints: out.constraints.map((k) => (!sideRelation(k, c.id) ? k
                    : k.kind === 'equal' ? { ...k, a: k.a === c.id ? id : k.a, b: k.b === c.id ? id : k.b }
                        : { ...k, line: id } as SketchConstraint)),
            };
        }
        return t;
    });
    // Two lines that did not meet: their old near ends go if nothing uses them.
    for (const side of [s1, s2]) {
        if (side.near !== corner.point && !out.curves.some((c) => curvePoints(c).includes(side.near))) {
            out = { ...out, points: out.points.filter((p) => p.id !== side.near), constraints: out.constraints.filter((k) => !constraintRefs(k).includes(side.near)) };
        }
    }
    const cut = putCurve({ id: newId('c', out), kind: 'line', a: ends[0], b: ends[1] });
    const legs = ends.map((id) => putCurve({ id: newId('c', out), kind: 'line', a: id, b: sharp, construction: true }));
    const extra: NewConstraint[] = [
        { kind: 'pointOnCurve', point: sharp, curve: s1.curve.id },
        { kind: 'pointOnCurve', point: sharp, curve: s2.curve.id },
        { kind: 'length', line: legs[0], value: d1 },
    ];
    if (o.type === 'angle') {
        extra.push({ kind: 'angle', a: s1.curve.id, b: cut, value: o.angle ?? 45 });
    } else if (o.distance2 === undefined) {
        extra.push({ kind: 'equal', a: legs[0], b: legs[1] });
    } else {
        extra.push({ kind: 'length', line: legs[1], value: d2 });
    }
    for (const c of extra) {
        out = addConstraint(out, c).g;
    }
    return { g: out };
}
