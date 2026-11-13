// Sketch editing tools as pure functions of the geometry: trim, extend, fillet, chamfer, offset, mirror, linear and
// circular patterns, and the centre-point arc and centre rectangle. Each returns the new geometry (to be solved and
// committed by the sketcher) or an error to show.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, pointOf } from './solver';
import { addConstraint, addRect, constraintRefs, newId, placePoint, type NewConstraint, type PointRef } from './sketchGeometry';
import { dist, type NewEntity, type Pt } from './sketchMath';
import { intersections } from './snapping';

/** A curve resolved to coordinates, as the snapping intersection maths takes it. */
type Shape = Parameters<typeof intersections>[0];

export type EditResult = { g: SketchGeometry } | { error: string };

const TAU = 2 * Math.PI;
/** Positions closer than this are the same point. */
const SAME = 1e-5;

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
const angleOf = (c: Pt, p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const polar = (c: Pt, r: number, a: number): Pt => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
const unit = (p: Pt, q: Pt): Pt => {
    const d = dist(p, q) || 1;
    return [(q[0] - p[0]) / d, (q[1] - p[1]) / d];
};

/** The points a curve is built on (same as in sketchGeometry, which does not export it). */
export function curvePoints(c: SketchCurve): string[] {
    return c.kind === 'line' ? [c.a, c.b] : c.kind === 'circle' ? [c.center] : [c.center, c.start, c.end];
}

/** The two end points of a line or arc; none for a circle. */
function endsOf(c: SketchCurve): string[] {
    return c.kind === 'line' ? [c.a, c.b] : c.kind === 'arc' ? [c.start, c.end] : [];
}

/** Coordinates of a curve (as in snapping, which does not export it). */
export function shapeOf(g: SketchGeometry, c: SketchCurve): Shape {
    if (c.kind === 'line') {
        return { id: c.id, kind: 'line', a: P(g, c.a), b: P(g, c.b) };
    }
    const centre = P(g, c.center);
    if (c.kind === 'circle') {
        return { id: c.id, kind: 'circle', c: centre, r: c.radius };
    }
    const s = P(g, c.start);
    const e = P(g, c.end);
    const from = angleOf(centre, s);
    return { id: c.id, kind: 'circle', c: centre, r: dist(s, centre), from, sweep: norm(angleOf(centre, e) - from) || TAU };
}

/** The drawable piece of a shape between two parameters (line: 0..1; circle and arc: angle from its start). */
function pieceOf(s: Shape, t0: number, t1: number): NewEntity {
    if (s.kind === 'line') {
        const at = (t: number): Pt => [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
        return { kind: 'line', a: at(t0), b: at(t1) };
    }
    const base = s.from ?? 0;
    return { kind: 'arc', a: polar(s.c, s.r, base + t0), b: polar(s.c, s.r, base + t1), m: polar(s.c, s.r, base + (t0 + t1) / 2) };
}

/** Where p lies along the shape: 0..1 along a line, or the angle from the arc's start (from +u on a circle). */
function paramOf(s: Shape, p: Pt): number {
    if (s.kind === 'line') {
        const d: Pt = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
        const l2 = d[0] * d[0] + d[1] * d[1] || 1;
        return ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]) / l2;
    }
    return norm(angleOf(s.c, p) - (s.from ?? 0));
}

/** Distance from p to the shape: its segment, circle, or arc (off the arc: its nearer end). */
function distanceTo(s: Shape, p: Pt): number {
    if (s.kind === 'circle') {
        if (s.sweep !== undefined && paramOf(s, p) > s.sweep) {
            const base = s.from ?? 0;
            return Math.min(dist(p, polar(s.c, s.r, base)), dist(p, polar(s.c, s.r, base + s.sweep)));
        }
        return Math.abs(dist(s.c, p) - s.r);
    }
    const t = Math.max(0, Math.min(1, paramOf(s, p)));
    return dist(p, [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]);
}

function withConstraints(g: SketchGeometry, list: NewConstraint[]): SketchGeometry {
    return list.reduce((out, c) => addConstraint(out, c).g, g);
}

function newPoint(g: SketchGeometry, at: Pt): { g: SketchGeometry; id: string } {
    const id = newId('p', g);
    return { g: { ...g, points: [...g.points, { id, u: at[0], v: at[1] }] }, id };
}

function putCurve(g: SketchGeometry, curve: SketchCurve): SketchGeometry {
    const exists = g.curves.some((c) => c.id === curve.id);
    return { ...g, curves: exists ? g.curves.map((c) => (c.id === curve.id ? curve : c)) : [...g.curves, curve] };
}

/** Removes these points if no curve uses them any more, with the constraints that refer to them. */
function dropUnused(g: SketchGeometry, ids: string[]): SketchGeometry {
    const used = new Set(g.curves.flatMap(curvePoints));
    const gone = new Set(ids.filter((id) => id !== ORIGIN && !used.has(id)));
    if (!gone.size) {
        return g;
    }
    return {
        points: g.points.filter((p) => !gone.has(p.id)),
        curves: g.curves,
        constraints: g.constraints.filter((c) => !constraintRefs(c).some((r) => gone.has(r))),
    };
}

function dropConstraints(g: SketchGeometry, drop: (c: SketchConstraint) => boolean): SketchGeometry {
    return { ...g, constraints: g.constraints.filter((c) => !drop(c)) };
}

/** A point on a curve that is also one of its end points needs no point-on-curve constraint. */
function dropOnOwnEnds(g: SketchGeometry, curveIds: string[]): SketchGeometry {
    const ends = new Map(curveIds.map((id) => {
        const c = curveOf(g, id);
        return [id, new Set(c ? endsOf(c) : [])];
    }));
    return dropConstraints(g, (c) => c.kind === 'pointOnCurve' && !!ends.get(c.curve)?.has(c.point));
}

// ---- Trim ---------------------------------------------------------------------------------------------

interface Cut {
    t: number;
    at: Pt;
    /** The curve that cuts here. */
    by: string;
    /** An existing point at the cut (an end of the cutting curve), shared instead of adding one. */
    point?: string;
}

/** Where other curves cross or touch the curve, sorted along it; its own ends are left out. */
function cutsOn(g: SketchGeometry, c: SketchCurve): Cut[] {
    const s = shapeOf(g, c);
    const own = new Set(curvePoints(c));
    const ends = endsOf(c).map((id) => P(g, id));
    const cuts: Cut[] = [];
    const add = (cut: Cut) => {
        if (ends.some((e) => dist(e, cut.at) < SAME)) {
            return;
        }
        const same = cuts.findIndex((k) => dist(k.at, cut.at) < SAME);
        if (same < 0) {
            cuts.push(cut);
        } else if (cut.point && !cuts[same].point) {
            cuts[same] = cut;
        }
    };
    for (const other of g.curves) {
        if (other.id === c.id) {
            continue;
        }
        const os = shapeOf(g, other);
        for (const p of intersections(s, os)) {
            add({ t: paramOf(s, p), at: p, by: other.id });
        }
        // Ends of other curves lying on this one (a T): caught even when rounding puts them a hair off.
        for (const id of endsOf(other)) {
            const q = P(g, id);
            if (!own.has(id) && distanceTo(s, q) < 1e-4) {
                const t = paramOf(s, q);
                const inside = s.kind === 'line' ? t > 0 && t < 1 : s.sweep === undefined || t < s.sweep;
                if (inside) {
                    add({ t, at: q, by: other.id, point: id });
                }
            }
        }
    }
    return cuts.sort((a, b) => a.t - b.t);
}

export interface TrimPlan {
    /** The new geometry, before solving. */
    g: SketchGeometry;
    /** The piece that goes, to highlight. */
    removed: NewEntity;
}

/**
 * Trims the curve at the piece around `at`: the part between the nearest crossings with other curves (or the curve's
 * ends) is removed. A curve nothing crosses goes completely; a circle needs two crossings.
 */
export function trimAt(g: SketchGeometry, curveId: string, at: Pt): TrimPlan | null {
    const c = curveOf(g, curveId);
    if (!c) {
        return null;
    }
    const s = shapeOf(g, c);
    const cuts = cutsOn(g, c);
    const t0 = paramOf(s, at);
    const whole = (): TrimPlan => ({
        g: dropUnused(dropConstraints({ ...g, curves: g.curves.filter((k) => k.id !== c.id) }, (k) => constraintRefs(k).includes(c.id)), curvePoints(c)),
        removed: s.kind === 'line' ? { kind: 'line', a: s.a, b: s.b }
            : s.sweep === undefined ? { kind: 'circle', c: s.c, r: s.r } : pieceOf(s, 0, s.sweep),
    });
    let out = g;
    /** The point at a cut: the existing one there, or a new one held on the cutting curve. */
    const pointAt = (cut: Cut): string => {
        if (cut.point) {
            return cut.point;
        }
        const r = newPoint(out, cut.at);
        out = addConstraint(r.g, { kind: 'pointOnCurve', point: r.id, curve: cut.by }).g;
        return r.id;
    };

    if (c.kind === 'circle') {
        if (!cuts.length) {
            return whole();
        }
        if (cuts.length < 2) {
            return null;
        }
        // The cuts either side of the click, going round.
        const before = [...cuts].reverse().find((k) => k.t <= t0) ?? cuts[cuts.length - 1];
        const after = cuts.find((k) => k.t > t0) ?? cuts[0];
        const from = before.t;
        const to = after.t > from ? after.t : after.t + TAU;
        const start = pointAt(after);
        const end = pointAt(before);
        out = putCurve(out, { id: c.id, kind: 'arc', center: c.center, start, end, ...(c.construction ? { construction: true } : {}) });
        return { g: dropOnOwnEnds(out, [c.id]), removed: pieceOf(s, from, to) };
    }

    const span = s.kind === 'line' ? 1 : s.sweep!;
    const lower = [...cuts].reverse().find((k) => k.t < t0) ?? null;
    const upper = cuts.find((k) => k.t > t0) ?? null;
    if (!lower && !upper) {
        return whole();
    }
    const removed = pieceOf(s, lower?.t ?? 0, upper?.t ?? span);
    const [first, last] = endsOf(c);
    const lowerId = lower ? pointAt(lower) : null;
    const upperId = upper ? pointAt(upper) : null;
    const piece = (curve: SketchCurve, a: string, b: string): SketchCurve => (curve.kind === 'line' ? { ...curve, a, b }
        : curve.kind === 'arc' ? { ...curve, start: a, end: b } : curve);
    let second: string | null = null;
    if (lowerId && upperId) {
        // Cut in the middle: the curve keeps the first piece and a new curve takes the second.
        second = newId('c', out);
        out = putCurve(out, piece(c, first, lowerId));
        out = putCurve(out, { ...piece(c, upperId, last), id: second });
        if (c.kind === 'line') {
            // Collinear: both ends of the second piece stay on the (infinite) first line.
            const on = new Set(out.constraints.flatMap((k) => (k.kind === 'pointOnCurve' && k.curve === c.id ? [k.point] : [])));
            out = withConstraints(out, [upperId, last].filter((p) => !on.has(p)).map((p) => ({ kind: 'pointOnCurve', point: p, curve: c.id }) as NewConstraint));
        } else {
            out = addConstraint(out, { kind: 'equal', a: c.id, b: second }).g;
        }
    } else if (upperId) {
        out = putCurve(out, piece(c, upperId, last));
    } else {
        out = putCurve(out, piece(c, first, lowerId!));
    }
    // A line's length, middle and equal-length no longer hold; an arc keeps its radius relations.
    if (c.kind === 'line') {
        out = dropConstraints(out, (k) => (k.kind === 'length' && k.line === c.id) || (k.kind === 'midpoint' && k.line === c.id)
            || (k.kind === 'equal' && (k.a === c.id || k.b === c.id)));
    }
    out = dropOnOwnEnds(out, second ? [c.id, second] : [c.id]);
    return { g: dropUnused(out, [first, last]), removed };
}

// ---- Extend -------------------------------------------------------------------------------------------

export interface ExtendPlan {
    g: SketchGeometry;
    /** The piece that gets added, to highlight. */
    added: NewEntity;
}

/** Lengthens the line or arc at its end nearer `at` to the next curve it meets. */
export function extendAt(g: SketchGeometry, curveId: string, at: Pt): ExtendPlan | null {
    const c = curveOf(g, curveId);
    if (!c || c.kind === 'circle') {
        return null;
    }
    const [first, last] = endsOf(c);
    const end = dist(P(g, first), at) <= dist(P(g, last), at) ? first : last;
    // An end that other curves share cannot move away from them.
    if (g.curves.some((k) => k.id !== c.id && curvePoints(k).includes(end))) {
        return null;
    }
    const others = g.curves.filter((k) => k.id !== c.id).map((k) => shapeOf(g, k));
    const from = P(g, end);
    let hit: { at: Pt; by: string; d: number } | null = null;
    let added: NewEntity | null = null;
    if (c.kind === 'line') {
        const dir = unit(P(g, end === c.a ? c.b : c.a), from);
        const ray: Shape = { id: 'ray', kind: 'line', a: [from[0] + dir[0] * 1e-6, from[1] + dir[1] * 1e-6], b: [from[0] + dir[0] * 1e6, from[1] + dir[1] * 1e6] };
        for (const o of others) {
            for (const p of intersections(ray, o)) {
                const d = dist(from, p);
                if (d > SAME && (!hit || d < hit.d)) {
                    hit = { at: p, by: o.id, d };
                }
            }
        }
        if (hit) {
            added = { kind: 'line', a: from, b: hit.at };
        }
    } else {
        const s = shapeOf(g, c) as Extract<Shape, { kind: 'circle' }>;
        const circle: Shape = { id: 'circle', kind: 'circle', c: s.c, r: s.r };
        const gap = TAU - s.sweep!;
        const a0 = angleOf(s.c, from);
        for (const o of others) {
            for (const p of intersections(circle, o)) {
                const a = angleOf(s.c, p);
                // Going on past the end (counter-clockwise), or back past the start (clockwise), but not round into itself.
                const d = end === c.end ? norm(a - a0) : norm(a0 - a);
                if (d > 1e-6 && d < gap - 1e-6 && (!hit || d < hit.d)) {
                    hit = { at: p, by: o.id, d };
                }
            }
        }
        if (hit) {
            const a1 = angleOf(s.c, hit.at);
            const [x, y] = end === c.end ? [a0, a0 + hit.d] : [a1, a1 + hit.d];
            added = { kind: 'arc', a: polar(s.c, s.r, x), b: polar(s.c, s.r, y), m: polar(s.c, s.r, (x + y) / 2) };
        }
    }
    if (!hit || !added) {
        return null;
    }
    const target = hit;
    let out: SketchGeometry = { ...g, points: g.points.map((p) => (p.id === end ? { ...p, u: target.at[0], v: target.at[1] } : p)) };
    // Its length and the dimensions and locks on the moved end would pull it back.
    out = dropConstraints(out, (k) => (k.kind === 'length' && k.line === c.id) || (k.kind === 'fix' && k.point === end)
        || (k.kind === 'distance' && (k.a === end || k.b === end)));
    out = addConstraint(out, { kind: 'pointOnCurve', point: end, curve: target.by }).g;
    return { g: out, added };
}

// ---- Fillet and chamfer -------------------------------------------------------------------------------

type Line = Extract<SketchCurve, { kind: 'line' }>;

/** The corner of two lines: where they meet (or would), the end of each that moves, and its far end. */
interface Corner {
    at: Pt;
    /** The existing corner point when the lines share one. */
    point: string | null;
    lines: { line: Line; near: string; far: Pt }[];
}

function cornerAtPoint(g: SketchGeometry, point: string): Corner | { error: string } {
    const users = g.curves.filter((c) => curvePoints(c).includes(point));
    const lines = users.filter((c): c is Line => c.kind === 'line');
    if (users.length !== 2 || lines.length !== 2) {
        return { error: 'Pick a corner where exactly two lines meet.' };
    }
    return {
        at: P(g, point),
        point,
        lines: lines.map((line) => ({ line, near: point, far: P(g, line.a === point ? line.b : line.a) })),
    };
}

function cornerOfLines(g: SketchGeometry, a: string, b: string): Corner | { error: string } {
    const la = curveOf(g, a);
    const lb = curveOf(g, b);
    if (la?.kind !== 'line' || lb?.kind !== 'line' || a === b) {
        return { error: 'Pick two lines.' };
    }
    const shared = [la.a, la.b].find((p) => p === lb.a || p === lb.b);
    if (shared) {
        return cornerAtPoint(g, shared);
    }
    const [p1, p2, p3, p4] = [P(g, la.a), P(g, la.b), P(g, lb.a), P(g, lb.b)];
    const den = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if (Math.abs(den) < 1e-9) {
        return { error: 'The lines are parallel.' };
    }
    const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / den;
    const x: Pt = [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
    // Each line keeps its end farther from the corner; the nearer one moves.
    const side = (line: Line, a: Pt, b: Pt) => (dist(a, x) <= dist(b, x) ? { line, near: line.a, far: b } : { line, near: line.b, far: a });
    return { at: x, point: null, lines: [side(la, p1, p2), side(lb, p3, p4)] };
}

/** Corner by a point or by two lines. */
export function cornerOf(g: SketchGeometry, pick: { point: string } | { lines: [string, string] }): Corner | { error: string } {
    return 'point' in pick ? cornerAtPoint(g, pick.point) : cornerOfLines(g, pick.lines[0], pick.lines[1]);
}

/** Moves each line's near end to a new point at `ends[i]`; the old ends go if nothing else uses them. */
function cutBack(g: SketchGeometry, corner: Corner, ends: Pt[]): { g: SketchGeometry; ids: string[] } {
    let out = g;
    const ids: string[] = [];
    corner.lines.forEach(({ line, near }, i) => {
        const r = newPoint(out, ends[i]);
        out = putCurve(r.g, line.a === near ? { ...line, a: r.id } : { ...line, b: r.id });
        ids.push(r.id);
    });
    const lineIds = corner.lines.map((l) => l.line.id);
    // Their lengths, middles and equal lengths change.
    out = dropConstraints(out, (k) => ((k.kind === 'length' || k.kind === 'midpoint') && lineIds.includes(k.line))
        || (k.kind === 'equal' && (lineIds.includes(k.a) || lineIds.includes(k.b))));
    return { g: out, ids };
}

/** Directions from the corner along each line, and the angle between them; null when the lines are in line. */
function spread(corner: Corner): { dirs: [Pt, Pt]; angle: number } | null {
    const dirs = corner.lines.map((l) => unit(corner.at, l.far)) as [Pt, Pt];
    const angle = Math.acos(Math.max(-1, Math.min(1, dirs[0][0] * dirs[1][0] + dirs[0][1] * dirs[1][1])));
    return angle < 1e-3 || angle > Math.PI - 1e-3 ? null : { dirs, angle };
}

/**
 * Rounds the corner with a tangent arc of `radius`, with a radius dimension. The tangency is held by a construction
 * radius to each end, perpendicular to its line: the solver's line-arc tangent is degenerate where the two share a
 * point (it reports it redundant and then refuses a new radius).
 */
export function filletCorner(g: SketchGeometry, corner: Corner, radius: number): EditResult & { arc?: string } {
    if (!(radius > 0)) {
        return { error: 'Type a radius above zero.' };
    }
    const s = spread(corner);
    if (!s) {
        return { error: 'The lines are in line; there is no corner to round.' };
    }
    const back = radius / Math.tan(s.angle / 2);
    if (corner.lines.some((l) => back >= dist(corner.at, l.far) - 1e-6)) {
        return { error: 'The radius is too big for these lines.' };
    }
    const ends = s.dirs.map((d): Pt => [corner.at[0] + d[0] * back, corner.at[1] + d[1] * back]);
    const bis = unit([0, 0], [s.dirs[0][0] + s.dirs[1][0], s.dirs[0][1] + s.dirs[1][1]]);
    const h = radius / Math.sin(s.angle / 2);
    const centre: Pt = [corner.at[0] + bis[0] * h, corner.at[1] + bis[1] * h];
    const cut = cutBack(g, corner, ends);
    const c = newPoint(cut.g, centre);
    let out = c.g;
    const ccw = (ends[0][0] - centre[0]) * (ends[1][1] - centre[1]) - (ends[0][1] - centre[1]) * (ends[1][0] - centre[0]) > 0;
    const arc = newId('c', out);
    out = putCurve(out, { id: arc, kind: 'arc', center: c.id, start: cut.ids[ccw ? 0 : 1], end: cut.ids[ccw ? 1 : 0] });
    const extra: NewConstraint[] = [{ kind: 'radius', curve: arc, value: radius }];
    corner.lines.forEach(({ line }, i) => {
        const spoke = newId('c', out);
        out = putCurve(out, { id: spoke, kind: 'line', a: c.id, b: cut.ids[i], construction: true });
        extra.push({ kind: 'perpendicular', a: spoke, b: line.id });
    });
    return { g: dropUnused(withConstraints(out, extra), corner.lines.map((l) => l.near)), arc };
}

/**
 * Cuts the corner with a straight line `distance` back along each line. The corner stays as a construction point
 * on both lines, joined to the cut by two equal construction lines, the first dimensioned.
 */
export function chamferCorner(g: SketchGeometry, corner: Corner, distance: number): EditResult {
    if (!(distance > 0)) {
        return { error: 'Type a distance above zero.' };
    }
    const s = spread(corner);
    if (!s) {
        return { error: 'The lines are in line; there is no corner to cut.' };
    }
    if (corner.lines.some((l) => distance >= dist(corner.at, l.far) - 1e-6)) {
        return { error: 'The distance is too big for these lines.' };
    }
    const ends = s.dirs.map((d): Pt => [corner.at[0] + d[0] * distance, corner.at[1] + d[1] * distance]);
    const cut = cutBack(g, corner, ends);
    let out = cut.g;
    let sharp = corner.point;
    if (!sharp) {
        const r = newPoint(out, corner.at);
        out = r.g;
        sharp = r.id;
    }
    const chamfer = newId('c', out);
    out = putCurve(out, { id: chamfer, kind: 'line', a: cut.ids[0], b: cut.ids[1] });
    const legs = cut.ids.map((id) => {
        const leg = newId('c', out);
        out = putCurve(out, { id: leg, kind: 'line', a: id, b: sharp!, construction: true });
        return leg;
    });
    out = withConstraints(out, [
        { kind: 'pointOnCurve', point: sharp, curve: corner.lines[0].line.id },
        { kind: 'pointOnCurve', point: sharp, curve: corner.lines[1].line.id },
        { kind: 'equal', a: legs[0], b: legs[1] },
        { kind: 'length', line: legs[0], value: distance },
    ]);
    return { g: out };
}

// ---- Offset -------------------------------------------------------------------------------------------

/** One curve of a chain, in the direction the chain runs (from → to); a circle runs counter-clockwise. */
export interface Segment {
    curve: SketchCurve;
    from: string;
    to: string;
}

/** The chain of lines and arcs joined end to end through `curveId` (a circle alone), and whether it closes. */
export function chainOf(g: SketchGeometry, curveId: string): { segments: Segment[]; closed: boolean } {
    const start = curveOf(g, curveId);
    if (!start) {
        return { segments: [], closed: false };
    }
    if (start.kind === 'circle') {
        return { segments: [{ curve: start, from: '', to: '' }], closed: true };
    }
    const pool = g.curves.filter((c) => c.kind !== 'circle' && !!c.construction === !!start.construction);
    const users = (point: string) => pool.filter((c) => endsOf(c).includes(point));
    const [a, b] = endsOf(start);
    const segments: Segment[] = [{ curve: start, from: a, to: b }];
    const seen = new Set([start.id]);
    // Forward from the end, then backward from the start; only through points where exactly two curves meet.
    let at = b;
    for (;;) {
        const here = users(at);
        const next = here.length === 2 ? here.find((c) => c.id !== segments[segments.length - 1].curve.id) : undefined;
        if (!next) {
            break;
        }
        if (seen.has(next.id)) {
            return { segments, closed: next.id === start.id };
        }
        const [x, y] = endsOf(next);
        segments.push({ curve: next, from: at, to: x === at ? y : x });
        seen.add(next.id);
        at = segments[segments.length - 1].to;
    }
    at = a;
    for (;;) {
        const here = users(at);
        const prev = here.length === 2 ? here.find((c) => c.id !== segments[0].curve.id) : undefined;
        if (!prev || seen.has(prev.id)) {
            break;
        }
        const [x, y] = endsOf(prev);
        segments.unshift({ curve: prev, from: x === at ? y : x, to: at });
        seen.add(prev.id);
        at = segments[0].from;
    }
    return { segments, closed: false };
}

/** A segment moved sideways: a line, or a circle piece about the same centre. */
type Moved =
    | { kind: 'line'; a: Pt; b: Pt }
    | { kind: 'circle'; c: Pt; r: number; a: Pt; b: Pt };

/** Signed distance of p from the chain: positive on the left of the way it runs (inside a counter-clockwise loop). */
export function sideDistance(g: SketchGeometry, curveId: string, p: Pt): number {
    const { segments } = chainOf(g, curveId);
    let best: { d: number; signed: number } | null = null;
    for (const s of segments) {
        const shape = shapeOf(g, s.curve);
        const d = distanceTo(shape, p);
        let signed: number;
        if (shape.kind === 'line') {
            const [f, t] = [P(g, s.from), P(g, s.to)];
            const l = dist(f, t) || 1;
            const cross = ((t[0] - f[0]) * (p[1] - f[1]) - (t[1] - f[1]) * (p[0] - f[0])) / l;
            signed = Math.sign(cross) * d;
        } else {
            const ccw = s.curve.kind === 'circle' || (s.curve.kind === 'arc' && s.from === s.curve.start);
            signed = (dist(shape.c, p) < shape.r ? 1 : -1) * (ccw ? 1 : -1) * d;
        }
        if (!best || d < best.d) {
            best = { d, signed };
        }
    }
    return best?.signed ?? 0;
}

/** The chain offset by d (left of its direction): its moved segments and the joints between them. */
function offsetShapes(g: SketchGeometry, curveId: string, d: number): { segments: Segment[]; closed: boolean; moved: Moved[] } | { error: string } {
    const { segments, closed } = chainOf(g, curveId);
    if (!segments.length) {
        return { error: 'Pick a line, arc or circle.' };
    }
    const moved: Moved[] = [];
    for (const s of segments) {
        if (s.curve.kind === 'line') {
            const [f, t] = [P(g, s.from), P(g, s.to)];
            const u = unit(f, t);
            const n: Pt = [-u[1] * d, u[0] * d];
            moved.push({ kind: 'line', a: [f[0] + n[0], f[1] + n[1]], b: [t[0] + n[0], t[1] + n[1]] });
            continue;
        }
        const shape = shapeOf(g, s.curve) as Extract<Shape, { kind: 'circle' }>;
        const ccw = s.curve.kind === 'circle' || s.from === (s.curve as { start: string }).start;
        const r = ccw ? shape.r - d : shape.r + d;
        if (r <= 1e-6) {
            return { error: 'That distance is more than the radius of an arc in the chain.' };
        }
        const at = (id: string) => polar(shape.c, r, angleOf(shape.c, P(g, id)));
        moved.push({ kind: 'circle', c: shape.c, r, a: s.curve.kind === 'circle' ? [0, 0] : at(s.from), b: s.curve.kind === 'circle' ? [0, 0] : at(s.to) });
    }
    // Joints: where neighbouring moved segments meet (the line intersection gives a sharp corner).
    const count = closed ? moved.length : moved.length - 1;
    for (let i = 0; i < count && segments[0].curve.kind !== 'circle'; i++) {
        const x = moved[i];
        const y = moved[(i + 1) % moved.length];
        const joint = jointOf(x, y);
        x.b = joint;
        y.a = joint;
    }
    return { segments, closed, moved };
}

function jointOf(x: Moved, y: Moved): Pt {
    const guess: Pt = [(x.b[0] + y.a[0]) / 2, (x.b[1] + y.a[1]) / 2];
    if (dist(x.b, y.a) < 1e-9) {
        return x.b;
    }
    if (x.kind === 'line' && y.kind === 'line') {
        const [p1, p2, p3, p4] = [x.a, x.b, y.a, y.b];
        const den = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
        if (Math.abs(den) < 1e-12) {
            return guess;
        }
        const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / den;
        return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
    }
    // With an arc: the crossing of the full line / circles nearest the two moved ends.
    const full = (m: Moved): Shape => {
        if (m.kind === 'circle') {
            return { id: 'c', kind: 'circle', c: m.c, r: m.r };
        }
        const u = unit(m.a, m.b);
        return { id: 'l', kind: 'line', a: [m.a[0] - u[0] * 1e5, m.a[1] - u[1] * 1e5], b: [m.b[0] + u[0] * 1e5, m.b[1] + u[1] * 1e5] };
    };
    const hits = intersections(full(x), full(y));
    return hits.length ? hits.reduce((best, p) => (dist(p, guess) < dist(best, guess) ? p : best)) : guess;
}

/** What the offset would draw, for the preview. */
export function offsetPreview(g: SketchGeometry, curveId: string, d: number): NewEntity[] {
    const r = offsetShapes(g, curveId, d);
    if ('error' in r) {
        return [];
    }
    return r.moved.map((m, i): NewEntity => {
        if (m.kind === 'line') {
            return { kind: 'line', a: m.a, b: m.b };
        }
        const curve = r.segments[i].curve;
        if (curve.kind === 'circle') {
            return { kind: 'circle', c: m.c, r: m.r };
        }
        const ccw = r.segments[i].from === (curve as { start: string }).start;
        const [s, e] = ccw ? [m.a, m.b] : [m.b, m.a];
        const a0 = angleOf(m.c, s);
        const sweep = norm(angleOf(m.c, e) - a0) || TAU;
        return { kind: 'arc', a: s, b: e, m: polar(m.c, m.r, a0 + sweep / 2) };
    });
}

/**
 * Offsets the chain through `curveId` by d (positive to the left of its direction, see sideDistance). Lines stay
 * parallel at a dimensioned distance and arcs and circles share the original centre. Smooth joints start tangent but
 * get no tangent constraint (degenerate in the solver where the curves share a point, see filletCorner).
 */
export function offsetChain(g: SketchGeometry, curveId: string, d: number): EditResult {
    if (Math.abs(d) < 1e-6) {
        return { error: 'Type a distance above zero.' };
    }
    const r = offsetShapes(g, curveId, d);
    if ('error' in r) {
        return r;
    }
    const { segments, closed, moved } = r;
    let out = g;
    if (segments[0].curve.kind === 'circle') {
        const circle = segments[0].curve;
        const m = moved[0] as Extract<Moved, { kind: 'circle' }>;
        const id = newId('c', out);
        out = putCurve(out, { id, kind: 'circle', center: circle.center, radius: m.r, ...(circle.construction ? { construction: true } : {}) });
        return { g: out };
    }
    // One point per joint (shared by neighbours), plus the two free ends of an open chain.
    const starts: string[] = [];
    const ends: string[] = [];
    for (let i = 0; i < moved.length; i++) {
        if (i === 0 && closed) {
            continue;
        }
        const p = newPoint(out, moved[i].a);
        out = p.g;
        starts[i] = p.id;
        if (i > 0) {
            ends[i - 1] = p.id;
        }
    }
    if (closed) {
        const p = newPoint(out, moved[moved.length - 1].b);
        out = p.g;
        ends[moved.length - 1] = p.id;
        starts[0] = p.id;
    } else {
        const p = newPoint(out, moved[moved.length - 1].b);
        out = p.g;
        ends[moved.length - 1] = p.id;
    }
    const extra: NewConstraint[] = [];
    segments.forEach((s, i) => {
        const id = newId('c', out);
        const construction = s.curve.construction ? { construction: true } : {};
        if (s.curve.kind === 'line') {
            out = putCurve(out, { id, kind: 'line', a: starts[i], b: ends[i], ...construction });
            extra.push({ kind: 'parallel', a: id, b: s.curve.id }, { kind: 'distance', a: starts[i], b: s.curve.id, value: Math.abs(d) });
        } else if (s.curve.kind === 'arc') {
            const ccw = s.from === s.curve.start;
            out = putCurve(out, { id, kind: 'arc', center: s.curve.center, start: ccw ? starts[i] : ends[i], end: ccw ? ends[i] : starts[i], ...construction });
        }
    });
    return { g: withConstraints(out, extra) };
}

// ---- Mirror -------------------------------------------------------------------------------------------

/** The two points of a mirror line: a drawn line or one of the sketch axes. */
function mirrorLine(g: SketchGeometry, about: string): [Pt, Pt] | null {
    if (about === AXIS_U) {
        return [[0, 0], [1, 0]];
    }
    if (about === AXIS_V) {
        return [[0, 0], [0, 1]];
    }
    const line = curveOf(g, about);
    return line?.kind === 'line' ? [P(g, line.a), P(g, line.b)] : null;
}

function reflect(p: Pt, [a, b]: [Pt, Pt]): Pt {
    const u = unit(a, b);
    const t = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
    const foot: Pt = [a[0] + u[0] * t, a[1] + u[1] * t];
    return [2 * foot[0] - p[0], 2 * foot[1] - p[1]];
}

/** Mirror copies of the curves about a line or axis, each point held symmetric to its original. */
export function mirrorCurves(g: SketchGeometry, curveIds: string[], about: string): EditResult & { created?: string[] } {
    const axis = mirrorLine(g, about);
    if (!axis) {
        return { error: 'Mirror about a line or one of the sketch axes.' };
    }
    const curves = curveIds.filter((id) => id !== about).map((id) => curveOf(g, id)).filter((c): c is SketchCurve => !!c);
    if (!curves.length) {
        return { error: 'Pick the curves to mirror first.' };
    }
    let out = g;
    const map = new Map<string, string>();
    const extra: NewConstraint[] = [];
    const image = (id: string): string => {
        const known = map.get(id);
        if (known) {
            return known;
        }
        const p = P(g, id);
        const q = reflect(p, axis);
        // Points on the mirror line are their own image.
        if (dist(p, q) < SAME) {
            map.set(id, id);
            return id;
        }
        const r = newPoint(out, q);
        out = r.g;
        map.set(id, r.id);
        extra.push({ kind: 'symmetric', a: id, b: r.id, about });
        return r.id;
    };
    const created: string[] = [];
    for (const c of curves) {
        const construction = c.construction ? { construction: true } : {};
        // Images first: they add points to `out`.
        let copy: SketchCurve;
        if (c.kind === 'line') {
            const [a, b] = [image(c.a), image(c.b)];
            copy = { id: newId('c', out), kind: 'line', a, b, ...construction };
        } else if (c.kind === 'circle') {
            const center = image(c.center);
            copy = { id: newId('c', out), kind: 'circle', center, radius: c.radius, ...construction };
            extra.push({ kind: 'equal', a: c.id, b: copy.id });
        } else {
            // A reflection turns the arc round: its start's image is the new end.
            const [center, end, start] = [image(c.center), image(c.start), image(c.end)];
            copy = { id: newId('c', out), kind: 'arc', center, start, end, ...construction };
        }
        out = putCurve(out, copy);
        created.push(copy.id);
    }
    return { g: withConstraints(out, extra), created };
}

// ---- Patterns -----------------------------------------------------------------------------------------

/** Constraints that a copy keeps among its own curves and points (horizontal and vertical only when not rotated). */
const COPIED = new Set<SketchConstraint['kind']>([
    'coincident', 'parallel', 'perpendicular', 'tangent', 'equal', 'pointOnCurve', 'midpoint', 'length', 'radius', 'diameter',
    'horizontal', 'vertical',
]);

/** Copies of the curves, each placed by `place(k)` for k = 1..count-1. */
function copies(g: SketchGeometry, curveIds: string[], count: number, place: (k: number, p: Pt) => Pt, rotated: boolean): EditResult & { created?: string[] } {
    const curves = curveIds.map((id) => curveOf(g, id)).filter((c): c is SketchCurve => !!c);
    if (!curves.length) {
        return { error: 'Select the curves to pattern first.' };
    }
    if (!(count >= 2)) {
        return { error: 'The count must be 2 or more.' };
    }
    const inSet = new Set([...curves.map((c) => c.id), ...curves.flatMap(curvePoints)]);
    const kept = g.constraints.filter((c) => COPIED.has(c.kind) && !(rotated && (c.kind === 'horizontal' || c.kind === 'vertical'))
        && constraintRefs(c).every((r) => inSet.has(r)));
    let out = g;
    const created: string[] = [];
    for (let k = 1; k < count; k++) {
        const map = new Map<string, string>();
        const image = (id: string) => {
            let to = map.get(id);
            if (!to) {
                const r = newPoint(out, place(k, P(g, id)));
                out = r.g;
                to = r.id;
                map.set(id, to);
            }
            return to;
        };
        for (const c of curves) {
            const id = newId('c', out);
            map.set(c.id, id);
            const copy: SketchCurve = c.kind === 'line' ? { ...c, id, a: image(c.a), b: image(c.b) }
                : c.kind === 'circle' ? { ...c, id, center: image(c.center) }
                    : { ...c, id, center: image(c.center), start: image(c.start), end: image(c.end) };
            out = putCurve(out, copy);
            created.push(id);
        }
        const rename = (id: string) => map.get(id) ?? id;
        for (const c of kept) {
            const copy = Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'id' && key !== 'at')
                .map(([key, v]) => [key, typeof v === 'string' && key !== 'kind' && key !== 'axis' ? rename(v) : v])) as NewConstraint;
            out = addConstraint(out, copy).g;
        }
    }
    return { g: out, created };
}

/** `count` copies in all (the original included), each `step` further on. */
export function linearPattern(g: SketchGeometry, curveIds: string[], count: number, step: Pt): EditResult & { created?: string[] } {
    if (Math.hypot(step[0], step[1]) < 1e-9) {
        return { error: 'The spacing cannot be zero.' };
    }
    return copies(g, curveIds, count, (k, p) => [p[0] + step[0] * k, p[1] + step[1] * k], false);
}

/** `count` copies in all about `centre`, spread over `angle` degrees (360: evenly round). */
export function circularPattern(g: SketchGeometry, curveIds: string[], count: number, angle: number, centre: Pt): EditResult & { created?: string[] } {
    if (Math.abs(angle) < 1e-9) {
        return { error: 'The angle cannot be zero.' };
    }
    const full = Math.abs(Math.abs(angle) - 360) < 1e-9;
    const step = ((angle * Math.PI) / 180) / (full ? count : Math.max(1, count - 1));
    return copies(g, curveIds, count, (k, p) => {
        const a = step * k;
        const [x, y] = [p[0] - centre[0], p[1] - centre[1]];
        return [centre[0] + x * Math.cos(a) - y * Math.sin(a), centre[1] + x * Math.sin(a) + y * Math.cos(a)];
    }, true);
}

// ---- Move, copy, rotate, scale ----------------------------------------------------------------------

/** How selected geometry is moved: by an offset, turned about a centre (degrees, counter-clockwise), or scaled. */
export type Transform =
    | { kind: 'move'; by: Pt }
    | { kind: 'rotate'; centre: Pt; angle: number }
    | { kind: 'scale'; centre: Pt; factor: number };

export function transformPoint(t: Transform, p: Pt): Pt {
    if (t.kind === 'move') {
        return [p[0] + t.by[0], p[1] + t.by[1]];
    }
    const [x, y] = [p[0] - t.centre[0], p[1] - t.centre[1]];
    if (t.kind === 'scale') {
        return [t.centre[0] + x * t.factor, t.centre[1] + y * t.factor];
    }
    const a = (t.angle * Math.PI) / 180;
    return [t.centre[0] + x * Math.cos(a) - y * Math.sin(a), t.centre[1] + x * Math.sin(a) + y * Math.cos(a)];
}

/** Whole quarter turns of the transform (0..3), or null for any other angle. */
function quarterTurns(t: Transform): number | null {
    if (t.kind !== 'rotate') {
        return 0;
    }
    const q = t.angle / 90;
    return Math.abs(q - Math.round(q)) < 1e-9 ? ((Math.round(q) % 4) + 4) % 4 : null;
}

/** A constraint carried along with the transformed geometry: scaled, turned, or null when it no longer holds. */
function carried(c: NewConstraint, t: Transform): NewConstraint | null {
    const q = quarterTurns(t);
    if (c.kind === 'horizontal' || c.kind === 'vertical') {
        if (q === null) {
            return null;
        }
        return q % 2 ? { ...c, kind: c.kind === 'horizontal' ? 'vertical' : 'horizontal' } : c;
    }
    // Relations and angles hold under any of these transforms.
    if (!('value' in c) || c.kind === 'angle') {
        return c;
    }
    const f = t.kind === 'scale' ? t.factor : 1;
    if (c.kind === 'distance' && c.axis) {
        if (q === null) {
            return null;
        }
        return { ...c, value: c.value * f, ...(q % 2 ? { axis: c.axis === 'u' ? 'v' : 'u' } : {}) };
    }
    return { ...c, value: c.value * f } as NewConstraint;
}

/** A constraint without its id (and label position), with its references renamed. */
function renamed(c: SketchConstraint, rename: (id: string) => string): NewConstraint {
    return Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'id' && key !== 'at')
        .map(([key, v]) => [key, typeof v === 'string' && key !== 'kind' && key !== 'axis' ? rename(v) : v])) as NewConstraint;
}

export interface TransformResult {
    g: SketchGeometry;
    /** Copy: the new curves and points; move: the same ids as given. */
    created: string[];
    /** Move: relations and dimensions to geometry that stays put, removed so they do not pull it back. */
    dropped: number;
}

/**
 * Moves, turns or scales the curves and points `ids` (with the points the curves are built on), or copies them with
 * `copy`. Relations among them go along (scaled with a scale; turned with a quarter turn); a move drops the ones that
 * tie them to the rest of the sketch, and points shared with curves that stay are split off, so nothing pulls back.
 */
export function transformEntities(g: SketchGeometry, ids: string[], t: Transform, copy: boolean): TransformResult | { error: string } {
    const curves = ids.map((id) => curveOf(g, id)).filter((c): c is SketchCurve => !!c);
    const loose = ids.filter((id) => id !== ORIGIN && g.points.some((p) => p.id === id));
    if (!curves.length && !loose.length) {
        return { error: 'Select the curves or points first.' };
    }
    if (t.kind === 'scale' && !(t.factor > 0)) {
        return { error: 'The scale factor must be above zero.' };
    }
    const curveSet = new Set(curves.map((c) => c.id));
    const pointSet = new Set([...curves.flatMap(curvePoints), ...loose]);
    const f = t.kind === 'scale' ? t.factor : 1;
    // Points that must split off: copies get all new points; a move splits those that stay with other curves.
    const split = new Set([...pointSet].filter((id) => copy || id === ORIGIN || g.curves.some((c) => !curveSet.has(c.id) && curvePoints(c).includes(id))));
    let out = g;
    const map = new Map<string, string>();
    for (const id of pointSet) {
        if (split.has(id)) {
            const r = newPoint(out, transformPoint(t, P(g, id)));
            out = r.g;
            map.set(id, r.id);
        }
    }
    const moved = new Set([...pointSet].filter((id) => !split.has(id)));
    out = { ...out, points: out.points.map((p) => {
        if (!moved.has(p.id)) {
            return p;
        }
        const [u, v] = transformPoint(t, [p.u, p.v]);
        return { ...p, u, v };
    }) };
    const created: string[] = [];
    for (const c of curves) {
        const id = copy ? newId('c', out) : c.id;
        map.set(c.id, id);
        const p = (x: string) => map.get(x) ?? x;
        const next: SketchCurve = c.kind === 'line' ? { ...c, id, a: p(c.a), b: p(c.b) }
            : c.kind === 'circle' ? { ...c, id, center: p(c.center), radius: c.radius * f }
                : { ...c, id, center: p(c.center), start: p(c.start), end: p(c.end) };
        out = putCurve(out, next);
        created.push(id);
    }
    if (!curves.length || copy) {
        created.push(...loose.map((id) => map.get(id) ?? id));
    }
    const rename = (id: string) => map.get(id) ?? id;
    const inSet = (id: string) => curveSet.has(id) || pointSet.has(id);
    let dropped = 0;
    if (copy) {
        // The copy keeps the relations among its own geometry (a lock would pin it where it is made: left out).
        for (const c of g.constraints) {
            const refs = constraintRefs(c);
            if (c.kind !== 'fix' && refs.every(inSet)) {
                const next = carried(renamed(c, rename), t);
                out = next ? addConstraint(out, next).g : out;
            }
        }
        return { g: out, created: created.filter((id, i) => created.indexOf(id) === i), dropped: 0 };
    }
    const constraints: SketchConstraint[] = [];
    for (const c of out.constraints) {
        const refs = constraintRefs(c);
        const moving = refs.some((r) => curveSet.has(r) || moved.has(r));
        const staying = refs.some((r) => !inSet(r));
        if (!moving) {
            constraints.push(c);
        } else if (staying) {
            dropped += 1;
        } else {
            const next = carried(renamed(c, rename), t);
            if (next) {
                constraints.push({ ...next, id: c.id, ...('at' in c && c.at ? { at: c.at } : {}) } as SketchConstraint);
            } else {
                dropped += 1;
            }
        }
    }
    return { g: { ...out, constraints }, created, dropped };
}

// ---- Drawing: centre-point arc and centre rectangle -----------------------------------------------------

/** Arc about `center` from `start` round to the direction of `toward`, counter-clockwise when `ccw`. */
export function addCentreArc(g: SketchGeometry, center: PointRef, start: PointRef, toward: Pt, ccw: boolean): { g: SketchGeometry; id: string } {
    let r = placePoint(g, center);
    const cid = r.id;
    r = placePoint(r.g, start);
    const sid = r.id;
    const c = P(r.g, cid);
    const radius = dist(c, P(r.g, sid));
    const e = newPoint(r.g, polar(c, radius, angleOf(c, toward)));
    const id = newId('c', e.g);
    const curve: SketchCurve = { id, kind: 'arc', center: cid, start: ccw ? sid : e.id, end: ccw ? e.id : sid };
    return { g: putCurve(e.g, curve), id };
}

/** Rectangle about its centre: the opposite corner mirrors `corner`, held there by a construction diagonal. */
export function addCentreRect(g: SketchGeometry, center: PointRef, corner: PointRef): { g: SketchGeometry; lines: string[] } {
    const opposite: Pt = [2 * center.at[0] - corner.at[0], 2 * center.at[1] - corner.at[1]];
    const rect = addRect(g, { at: opposite }, corner);
    const [l0, l1] = rect.lines.map((id) => curveOf(rect.g, id) as Line);
    const diagonal = newId('c', rect.g);
    let out = putCurve(rect.g, { id: diagonal, kind: 'line', a: l0.a, b: l1.b, construction: true });
    const c = placePoint(out, center);
    out = addConstraint(c.g, { kind: 'midpoint', point: c.id, line: diagonal }).g;
    return { g: out, lines: rect.lines };
}
