// Constrained sketch geometry helpers: converting between SketchGeometry (points, curves, constraints) and the
// drawable entities / solved profiles, building geometry from the drawing tools, and picking.

import type { SketchConstraint, SketchCurve, SketchGeometry, SketchPoint, SketchProfile } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, pointOf } from './solver';
import { arcPoints, circleThrough, curveEntity, dist, entityDistance, mid, type Entity, type Pt } from './sketchMath';
import { openChains, regionProfiles } from './sketchRegions';
import { curveCentreIds, curveEndIds, curvePointIds, curveSegment, holdsPoints, isExtra, splineAfterRemoval } from './sketchCurves';

import { addCurveFromProfile } from './sketchConics';
import { equalSlotRelations, fixSlotRelations } from './sketchSlots';
import { isModelLock, sketchLockSource } from './sketchModel';
import { handleDimension } from './sketchDimGroups';
import { endlessEnds } from './sketchInfinite';
import { pathRelationFor } from './sketchPathModel';

/** A constraint before it gets its id. */
export type NewConstraint = SketchConstraint extends infer C ? (C extends SketchConstraint ? Omit<C, 'id'> : never) : never;

export const EMPTY_GEOMETRY: SketchGeometry = { points: [], curves: [], constraints: [] };

let counter = 1;
/** Unique ids for new points (p), curves (c) and constraints (k) within a sketch session. */
export function newId(prefix: 'p' | 'c' | 'k', g: SketchGeometry): string {
    const used = new Set([...g.points.map((p) => p.id), ...g.curves.map((c) => c.id), ...g.constraints.map((c) => c.id)]);
    let id = `${prefix}${counter++}`;
    while (used.has(id)) {
        id = `${prefix}${counter++}`;
    }
    return id;
}

const at = (p: SketchPoint): Pt => [p.u, p.v];

/** Angle-wise middle of a counter-clockwise arc, used as its "through" point. */
export function arcMiddle(c: Pt, s: Pt, e: Pt): Pt {
    const r = dist(c, s);
    const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
    let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
    while (a1 <= a0) {
        a1 += 2 * Math.PI;
    }
    const m = (a0 + a1) / 2;
    return [c[0] + r * Math.cos(m), c[1] + r * Math.sin(m)];
}

/** Drawable entities for the curves (ids are the curve ids). */
export function geometryEntities(g: SketchGeometry, includeConstruction = true): (Entity & { construction?: boolean })[] {
    const out: (Entity & { construction?: boolean })[] = [];
    for (const curve of g.curves) {
        if (!includeConstruction && curve.construction) {
            continue;
        }
        if (curve.kind === 'line') {
            const a = pointOf(g, curve.a);
            const b = pointOf(g, curve.b);
            // An infinite line is drawn far beyond its points, and is never part of a profile.
            if (curve.endless && !includeConstruction) {
                continue;
            }
            if (a && b) {
                const [p, q] = endlessEnds(at(a), at(b), curve.endless);
                out.push({ id: curve.id, kind: 'line', a: p, b: q, construction: curve.construction });
            }
        } else if (curve.kind === 'circle') {
            const c = pointOf(g, curve.center);
            if (c) {
                out.push({ id: curve.id, kind: 'circle', c: at(c), r: curve.radius, construction: curve.construction });
            }
        } else if (curve.kind === 'ellipse') {
            const [c, major, minor] = [curve.center, curve.major, curve.minor].map((id) => pointOf(g, id));
            if (c && major && minor) {
                out.push({ id: curve.id, kind: 'ellipse', c: at(c), major: at(major), minor: dist(at(c), at(minor)), construction: curve.construction });
            }
        } else if (isExtra(curve)) {
            const s = curveSegment(g, curve);
            if (s) {
                out.push({ ...curveEntity(curve.id, s.from, s.seg), construction: curve.construction });
            }
        } else {
            const c = pointOf(g, curve.center);
            const s = pointOf(g, curve.start);
            const e = pointOf(g, curve.end);
            if (c && s && e) {
                out.push({ id: curve.id, kind: 'arc', a: at(s), b: at(e), m: arcMiddle(at(c), at(s), at(e)), construction: curve.construction });
            }
        }
    }
    return out;
}

/** The solved closed profiles the kernel builds from (construction curves left out). */
export function geometryProfiles(g: SketchGeometry): { profiles: SketchProfile[]; open: number } {
    return regionProfiles(geometryEntities(g, false), curveEnds(g));
}

/** The open chains (construction curves left out) as open `path` profiles: what a sweep can use as its path. */
export function geometryOpenChains(g: SketchGeometry): SketchProfile[] {
    return openChains(geometryEntities(g, false), curveEnds(g));
}

/** Sketch point ids at the ends of each line and arc, so curves sharing a point share a graph vertex. */
function curveEnds(g: SketchGeometry): Map<string, [string, string]> {
    const ends = new Map<string, [string, string]>();
    for (const c of g.curves) {
        const e = curveEndIds(c);
        if (e.length === 2) {
            ends.set(c.id, [e[0], e[1]]);
        }
    }
    return ends;
}

// ---- Old sketches (profiles only) to editable geometry ------------------------------------------------

/** Converts profile-only sketches (written by Jarvis or older versions) into points, curves and constraints. */
export function profilesToGeometry(profiles: SketchProfile[]): SketchGeometry {
    let g: SketchGeometry = { points: [], curves: [], constraints: [] };
    for (const p of profiles) {
        switch (p.kind) {
            case 'rect':
                g = addRect(g, [p.center[0] - p.width / 2, p.center[1] - p.height / 2], [p.center[0] + p.width / 2, p.center[1] + p.height / 2]).g;
                break;
            case 'circle':
                g = addCircle(g, { at: p.center }, p.radius).g;
                break;
            case 'slot':
                g = addSlot(g, p.from, p.to, p.radius).g;
                break;
            case 'polygon':
                g = addLoop(g, p.points.map((q) => ({ kind: 'line' as const, to: q })), p.points[p.points.length - 1]);
                break;
            case 'ellipse':
                g = addCurveFromProfile(g, p);
                break;
            case 'path': {
                if (p.segments.some((s) => s.kind !== 'line' && s.kind !== 'arc')) {
                    g = addCurveFromProfile(g, p);
                    break;
                }
                const segments = p.segments.map((s) => (s.kind === 'arc' ? { kind: 'arc' as const, to: s.to, through: s.through } : { kind: 'line' as const, to: s.to }));
                g = addLoop(g, segments, p.start);
                break;
            }
        }
    }
    return g;
}

/** A closed loop from `start` through segments (lines and 3-point arcs), with shared corner points. */
function addLoop(g: SketchGeometry, segments: ({ kind: 'line'; to: Pt } | { kind: 'arc'; to: Pt; through: Pt })[], start: Pt): SketchGeometry {
    const out: SketchGeometry = { points: [...g.points], curves: [...g.curves], constraints: [...g.constraints] };
    const pointAt = (q: Pt): string => {
        const found = out.points.find((p) => Math.abs(p.u - q[0]) < 1e-6 && Math.abs(p.v - q[1]) < 1e-6 && p.id !== ORIGIN);
        if (found) {
            return found.id;
        }
        const id = newId('p', out);
        out.points.push({ id, u: q[0], v: q[1] });
        return id;
    };
    const first = pointAt(start);
    let from = first;
    let fromAt = start;
    segments.forEach((s, i) => {
        const closing = i === segments.length - 1 && Math.abs(s.to[0] - start[0]) < 1e-6 && Math.abs(s.to[1] - start[1]) < 1e-6;
        const to = closing ? first : pointAt(s.to);
        if (to === from) {
            return;
        }
        if (s.kind === 'line') {
            out.curves.push({ id: newId('c', out), kind: 'line', a: from, b: to });
        } else {
            const arc = arcFromThree(out, fromAt, s.through, s.to, from, to);
            out.points.push(...arc.points);
            out.curves.push(arc.curve);
        }
        from = to;
        fromAt = s.to;
    });
    if (from !== first) {
        out.curves.push({ id: newId('c', out), kind: 'line', a: from, b: first });
    }
    return out;
}

// ---- Building geometry from the drawing tools ---------------------------------------------------------

/** Where a placed point comes from: an existing point (shared), the middle of a line, or free. */
export interface PointRef {
    at: Pt;
    point?: string;
    midOf?: string;
    /** Curves the point lies on (two at an intersection). */
    onCurves?: string[];
    /** A relation the line ending here takes on (inferred while drawing): parallel or square to a line, tangent to a curve. */
    infer?: { kind: 'parallel' | 'perpendicular' | 'tangent'; to: string };
}

/** Uses an existing point or adds one (with a midpoint / point-on-curve constraint when snapped to one). */
export function placePoint(g: SketchGeometry, ref: PointRef): { g: SketchGeometry; id: string } {
    if (ref.point) {
        if (ref.point === ORIGIN && !g.points.some((p) => p.id === ORIGIN)) {
            return { g: { ...g, points: [...g.points, { id: ORIGIN, u: 0, v: 0, fixed: true }] }, id: ORIGIN };
        }
        return { g, id: ref.point };
    }
    const id = newId('p', g);
    const out: SketchGeometry = { ...g, points: [...g.points, { id, u: ref.at[0], v: ref.at[1] }] };
    if (ref.midOf) {
        out.constraints = [...out.constraints, { id: newId('k', out), kind: 'midpoint', point: id, line: ref.midOf }];
    }
    for (const curve of (ref.onCurves ?? []).filter((c) => holdsPoints(g, c))) {
        out.constraints = [...out.constraints, { id: newId('k', out), kind: 'pointOnCurve', point: id, curve }];
    }
    return { g: out, id };
}

export function addConstraint(g: SketchGeometry, c: NewConstraint): { g: SketchGeometry; id: string } {
    const id = newId('k', g);
    return { g: { ...g, constraints: [...g.constraints, { ...c, id } as SketchConstraint] }, id };
}

/** A line between two placed points; `infer` adds a horizontal or vertical constraint. */
export function addLine(g: SketchGeometry, a: PointRef, b: PointRef, infer?: 'horizontal' | 'vertical' | null): { g: SketchGeometry; id: string; b: string } {
    let r = placePoint(g, a);
    const pa = r.id;
    r = placePoint(r.g, b);
    const pb = r.id;
    const id = newId('c', r.g);
    let out: SketchGeometry = { ...r.g, curves: [...r.g.curves, { id, kind: 'line', a: pa, b: pb }] };
    if (infer) {
        out = addConstraint(out, { kind: infer, line: id }).g;
    }
    return { g: out, id, b: pb };
}

/** Rectangle from two opposite corners: 4 lines sharing corners, two horizontal and two vertical. */
export function addRect(g: SketchGeometry, a: Pt | PointRef, b: Pt | PointRef): { g: SketchGeometry; lines: string[] } {
    const ra = Array.isArray(a) ? { at: a } : a;
    const rb = Array.isArray(b) ? { at: b } : b;
    let r = placePoint(g, ra);
    const p1 = r.id;
    r = placePoint(r.g, { at: [rb.at[0], ra.at[1]] });
    const p2 = r.id;
    r = placePoint(r.g, rb);
    const p3 = r.id;
    r = placePoint(r.g, { at: [ra.at[0], rb.at[1]] });
    const p4 = r.id;
    let out = r.g;
    const lines: string[] = [];
    for (const [pa, pb] of [[p1, p2], [p2, p3], [p3, p4], [p4, p1]]) {
        const id = newId('c', out);
        out = { ...out, curves: [...out.curves, { id, kind: 'line', a: pa, b: pb }] };
        lines.push(id);
    }
    out = addConstraint(out, { kind: 'horizontal', line: lines[0] }).g;
    out = addConstraint(out, { kind: 'horizontal', line: lines[2] }).g;
    out = addConstraint(out, { kind: 'vertical', line: lines[1] }).g;
    out = addConstraint(out, { kind: 'vertical', line: lines[3] }).g;
    return { g: out, lines };
}

export function addCircle(g: SketchGeometry, center: PointRef, radius: number, construction = false): { g: SketchGeometry; id: string; center: string } {
    const r = placePoint(g, center);
    const id = newId('c', r.g);
    return {
        g: { ...r.g, curves: [...r.g.curves, { id, kind: 'circle', center: r.id, radius, ...(construction ? { construction } : {}) }] },
        id,
        center: r.id,
    };
}

/** The centre point and curve of a counter-clockwise arc through three points (start and end swapped if needed). */
function arcFromThree(g: SketchGeometry, s: Pt, m: Pt, e: Pt, sid: string, eid: string): { points: SketchPoint[]; curve: SketchCurve } {
    const through = arcPoints(s, m, e, 2);
    const c = circleCentre(s, m, e) ?? mid(s, e);
    const center = newId('p', g);
    // arcPoints runs from s to e through m; if that is clockwise the CCW arc runs from e to s.
    const ccw = ((through[1][0] - s[0]) * (e[1] - s[1]) - (through[1][1] - s[1]) * (e[0] - s[0])) > 0;
    return {
        points: [{ id: center, u: c[0], v: c[1] }],
        curve: { id: `${newId('c', g)}`, kind: 'arc', center, start: ccw ? sid : eid, end: ccw ? eid : sid },
    };
}

function circleCentre(a: Pt, m: Pt, b: Pt): Pt | null {
    const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    if (Math.abs(d) < 1e-9) {
        return null;
    }
    const a2 = a[0] ** 2 + a[1] ** 2;
    const m2 = m[0] ** 2 + m[1] ** 2;
    const b2 = b[0] ** 2 + b[1] ** 2;
    return [
        (a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d,
        (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d,
    ];
}

/** 3-point arc: start and end (shared when snapped), and a point it passes through. */
export function addArc(g: SketchGeometry, s: PointRef, e: PointRef, m: Pt): { g: SketchGeometry; id: string } {
    let r = placePoint(g, s);
    const sid = r.id;
    r = placePoint(r.g, e);
    const eid = r.id;
    const arc = arcFromThree(r.g, s.at, m, e.at, sid, eid);
    // Ids must not collide with the centre point just reserved.
    const out: SketchGeometry = { ...r.g, points: [...r.g.points, ...arc.points] };
    const curve = { ...arc.curve, id: newId('c', out) } as SketchCurve;
    return { g: { ...out, curves: [...out.curves, curve] }, id: curve.id };
}

/**
 * Slot around the centre line a→b: two lines and two end arcs, tangent, with equal radii. Centres given as point
 * refs use what they snapped to (an existing point, the origin, a curve).
 */
export function addSlot(g: SketchGeometry, ra: Pt | PointRef, rb: Pt | PointRef, radius: number): { g: SketchGeometry; lines: string[]; arcs: string[] } {
    const [a, b] = [ra, rb].map((r) => (Array.isArray(r) ? r : r.at));
    const length = dist(a, b) || 1;
    const n: Pt = [-(b[1] - a[1]) / length * radius, (b[0] - a[0]) / length * radius];
    let out: SketchGeometry = { points: [...g.points], curves: [...g.curves], constraints: [...g.constraints] };
    const point = (q: Pt) => {
        const id = newId('p', out);
        out = { ...out, points: [...out.points, { id, u: q[0], v: q[1] }] };
        return id;
    };
    const centre = (r: Pt | PointRef) => {
        if (Array.isArray(r)) {
            return point(r);
        }
        const placed = placePoint(out, r);
        out = placed.g;
        return placed.id;
    };
    const ca = centre(ra);
    const cb = centre(rb);
    const a1 = point([a[0] + n[0], a[1] + n[1]]);
    const a2 = point([a[0] - n[0], a[1] - n[1]]);
    const b1 = point([b[0] + n[0], b[1] + n[1]]);
    const b2 = point([b[0] - n[0], b[1] - n[1]]);
    const curve = (c: SketchCurve) => {
        out = { ...out, curves: [...out.curves, c] };
        return c.id;
    };
    const l1 = curve({ id: newId('c', out), kind: 'line', a: a2, b: b2 });
    const l2 = curve({ id: newId('c', out), kind: 'line', a: b1, b: a1 });
    // CCW: the arc at b runs from b2 round to b1, the arc at a from a1 round to a2.
    const arcB = curve({ id: newId('c', out), kind: 'arc', center: cb, start: b2, end: b1 });
    const arcA = curve({ id: newId('c', out), kind: 'arc', center: ca, start: a1, end: a2 });
    for (const [x, y] of [[l1, arcA], [l1, arcB], [l2, arcA], [l2, arcB]]) {
        out = addConstraint(out, { kind: 'tangent', a: x, b: y }).g;
    }
    out = addConstraint(out, { kind: 'equal', a: arcA, b: arcB }).g;
    return { g: out, lines: [l1, l2], arcs: [arcA, arcB] };
}

/** Regular polygon: corners on a construction circle, sides of equal length. */
export function addPolygon(g: SketchGeometry, center: PointRef, corner: Pt, sides: number): { g: SketchGeometry; circle: string } {
    const r0 = placePoint(g, center);
    const c = r0.g.points.find((p) => p.id === r0.id) ?? { u: 0, v: 0 };
    const radius = dist([c.u, c.v], corner);
    const circle = addCircle(r0.g, { at: [c.u, c.v], point: r0.id }, radius, true);
    let out = circle.g;
    const start = Math.atan2(corner[1] - c.v, corner[0] - c.u);
    const ids: string[] = [];
    for (let i = 0; i < sides; i++) {
        const t = start + (i / sides) * 2 * Math.PI;
        const id = newId('p', out);
        out = { ...out, points: [...out.points, { id, u: c.u + radius * Math.cos(t), v: c.v + radius * Math.sin(t) }] };
        out = addConstraint(out, { kind: 'pointOnCurve', point: id, curve: circle.id }).g;
        ids.push(id);
    }
    const lines: string[] = [];
    for (let i = 0; i < sides; i++) {
        const id = newId('c', out);
        out = { ...out, curves: [...out.curves, { id, kind: 'line', a: ids[i], b: ids[(i + 1) % sides] }] };
        lines.push(id);
    }
    for (let i = 1; i < sides; i++) {
        out = addConstraint(out, { kind: 'equal', a: lines[0], b: lines[i] }).g;
    }
    return { g: out, circle: circle.id };
}

/** Perimeter circle through three clicked points; those snapped to existing points stay on it. */
export function addPerimeterCircle(g: SketchGeometry, refs: PointRef[]): { g: SketchGeometry; id: string } | null {
    const [a, b, c] = refs.map((r) => r.at);
    const circle = circleThrough(a, b, c);
    if (!circle) {
        return null;
    }
    const r = addCircle(g, { at: circle.c }, circle.r);
    let out = r.g;
    for (const ref of refs) {
        if (ref.point) {
            out = placePoint(out, ref).g;
            out = addConstraint(out, { kind: 'pointOnCurve', point: ref.point, curve: r.id }).g;
        }
    }
    return { g: out, id: r.id };
}

/** The four corners of a 3-point corner rectangle: the first side a→b, then as wide as `c` is from that side. */
export function rectCorners3(a: Pt, b: Pt, c: Pt): [Pt, Pt, Pt, Pt] | null {
    const l = dist(a, b);
    if (l < 1e-9) {
        return null;
    }
    const n: Pt = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    const h = (c[0] - b[0]) * n[0] + (c[1] - b[1]) * n[1];
    if (Math.abs(h) < 1e-9) {
        return null;
    }
    return [a, b, [b[0] + n[0] * h, b[1] + n[1] * h], [a[0] + n[0] * h, a[1] + n[1] * h]];
}

/** 3-point corner rectangle at any angle: opposite sides parallel and one corner square. */
export function addRect3(g: SketchGeometry, a: PointRef, b: PointRef, c: Pt): { g: SketchGeometry; lines: string[] } | null {
    const corners = rectCorners3(a.at, b.at, c);
    if (!corners) {
        return null;
    }
    let r = placePoint(g, a);
    const ids = [r.id];
    r = placePoint(r.g, b);
    ids.push(r.id);
    for (const q of corners.slice(2)) {
        r = placePoint(r.g, { at: q });
        ids.push(r.id);
    }
    let out = r.g;
    const lines: string[] = [];
    for (let i = 0; i < 4; i++) {
        const id = newId('c', out);
        out = { ...out, curves: [...out.curves, { id, kind: 'line', a: ids[i], b: ids[(i + 1) % 4] }] };
        lines.push(id);
    }
    out = addConstraint(out, { kind: 'parallel', a: lines[0], b: lines[2] }).g;
    out = addConstraint(out, { kind: 'parallel', a: lines[1], b: lines[3] }).g;
    out = addConstraint(out, { kind: 'perpendicular', a: lines[0], b: lines[1] }).g;
    return { g: out, lines };
}

/** Direction leaving the end point `point` of a line or arc, along the curve (the way a tangent arc goes on). */
export function tangentAt(g: SketchGeometry, point: string): { curve: string; dir: Pt } | null {
    for (const c of [...g.curves].reverse()) {
        const P = (id: string): Pt | null => {
            const q = pointOf(g, id);
            return q ? [q.u, q.v] : null;
        };
        let dir: Pt | null = null;
        if (c.kind === 'line' && (c.a === point || c.b === point)) {
            const [from, to] = c.b === point ? [P(c.a), P(c.b)] : [P(c.b), P(c.a)];
            dir = from && to ? [to[0] - from[0], to[1] - from[1]] : null;
        } else if (c.kind === 'arc' && (c.start === point || c.end === point)) {
            const centre = P(c.center);
            const end = P(point);
            if (centre && end) {
                const r: Pt = [end[0] - centre[0], end[1] - centre[1]];
                // Counter-clockwise arcs leave their end turning left, and their start the other way.
                dir = c.end === point ? [-r[1], r[0]] : [r[1], -r[0]];
            }
        } else if (c.kind === 'conic' || c.kind === 'styleSpline' || c.kind === 'spline') {
            // These leave an end towards a control point (the top vertex, the next control vertex, a spline's
            // tangency handle), which is what holds a tangent there; a spline without a handle at that end has none.
            const ends = curveEndIds(c);
            const atStart = ends[0] === point && ends[1] !== point;
            const atEnd = ends[1] === point && ends[0] !== point;
            const toward = !atStart && !atEnd ? undefined : c.kind === 'conic' ? c.apex
                : c.kind === 'styleSpline' ? c.points[atStart ? 1 : c.points.length - 2] : atStart ? c.startHandle : c.endHandle;
            const [from, to] = toward ? [P(toward), P(point)] : [null, null];
            dir = from && to ? [to[0] - from[0], to[1] - from[1]] : null;
        }
        const l = dir ? Math.hypot(dir[0], dir[1]) : 0;
        if (dir && l > 1e-9) {
            return { curve: c.id, dir: [dir[0] / l, dir[1] / l] };
        }
    }
    return null;
}

/** The arc leaving `s` along `dir` and ending at `e`: its centre and whether it turns left (counter-clockwise). */
export function tangentArcThrough(s: Pt, dir: Pt, e: Pt): { c: Pt; ccw: boolean; m: Pt } | null {
    const n: Pt = [-dir[1], dir[0]];
    const d: Pt = [e[0] - s[0], e[1] - s[1]];
    const across = d[0] * n[0] + d[1] * n[1];
    if (Math.abs(across) < 1e-9) {
        return null;
    }
    // Signed radius: the centre is on the left of the direction when positive.
    const r = (d[0] ** 2 + d[1] ** 2) / (2 * across);
    const c: Pt = [s[0] + n[0] * r, s[1] + n[1] * r];
    const ccw = r > 0;
    const [from, to] = ccw ? [s, e] : [e, s];
    return { c, ccw, m: arcMiddle(c, from, to) };
}

/** Tangent arc from the end of a line or arc (`start`, an existing point) to `end`, tangent to that curve. */
export function addTangentArc(g: SketchGeometry, start: string, end: PointRef): { g: SketchGeometry; id: string; end: string } | { error: string } {
    const from = tangentAt(g, start);
    const s = pointOf(g, start);
    if (!from || !s) {
        return { error: 'Start a tangent arc on the end of a line or arc.' };
    }
    const arc = tangentArcThrough([s.u, s.v], from.dir, end.at);
    if (!arc) {
        return { error: 'That end is straight ahead: draw a line there instead.' };
    }
    const r = placePoint(g, end);
    const eid = r.id;
    if (eid === start) {
        return { error: 'Pick an end away from the start.' };
    }
    const centre = newId('p', r.g);
    let out: SketchGeometry = { ...r.g, points: [...r.g.points, { id: centre, u: arc.c[0], v: arc.c[1] }] };
    const id = newId('c', out);
    out = { ...out, curves: [...out.curves, { id, kind: 'arc', center: centre, start: arc.ccw ? start : eid, end: arc.ccw ? eid : start }] };
    out = addConstraint(out, { kind: 'tangent', a: from.curve, b: id }).g;
    return { g: out, id, end: eid };
}

// ---- Editing ------------------------------------------------------------------------------------------

/** What a constraint refers to (points and curves). */
export function constraintRefs(c: SketchConstraint): string[] {
    switch (c.kind) {
        case 'horizontal':
        case 'vertical':
        case 'length':
            return [c.line];
        case 'midpoint':
            return [c.point, c.line];
        case 'pointOnCurve':
            return [c.point, c.curve];
        case 'fix':
            return [c.point];
        case 'fixRadius':
            return [c.curve];
        case 'radius':
        case 'diameter':
        case 'arcLength':
            return [c.curve];
        case 'pointAngle':
            return [c.vertex, c.a, c.b];
        case 'intersection':
            return [c.point, c.a, c.b];
        case 'pathLength':
            return c.curves;
        case 'pathTangent':
            return [...c.curves, c.curve];
        case 'rho':
            return [c.curve];
        case 'symmetric':
            return [c.a, c.b, c.about];
        default:
            return [c.a, c.b];
    }
}

const curvePoints = (c: SketchCurve): string[] => curvePointIds(c);

/**
 * Dimensions that hold how far a curve reaches (not its direction or radius): an arc's length, and distances to a
 * line's midpoint. Trimming, splitting, extending or filleting the curve drops them, as it drops a line's length.
 */
export function extentHeld(k: SketchConstraint, curve: string): boolean {
    return (k.kind === 'arcLength' && k.curve === curve) || (k.kind === 'distance' && ((!!k.aMid && k.a === curve) || (!!k.bMid && k.b === curve)));
}

/** Removes points, curves or constraints, with everything that depends on them; orphan points go too. */
export function removeItems(g0: SketchGeometry, ids: string[]): SketchGeometry {
    const gone = new Set(ids);
    // A spline loses a deleted handle or point (as SolidWorks deletes a spline point), and goes only below two points.
    const g: SketchGeometry = {
        ...g0,
        curves: g0.curves.map((c) => {
            if (c.kind !== 'spline' && c.kind !== 'styleSpline') {
                return c;
            }
            if (gone.has(c.id)) {
                return c;
            }
            const out = { ...c, points: c.points.filter((p) => !gone.has(p)) } as typeof c;
            const wasClosed = c.kind === 'spline' && c.points.length > 2 && c.points[0] === c.points[c.points.length - 1];
            if (wasClosed && out.points.length > 1 && out.points[0] !== out.points[out.points.length - 1]) {
                out.points = [...out.points, out.points[0]];
            }
            if (out.kind === 'spline') {
                Object.assign(out, splineAfterRemoval(g0, c as Extract<SketchCurve, { kind: 'spline' }>, out.points, gone));
                for (const key of ['startHandle', 'endHandle'] as const) {
                    if (out[key] && gone.has(out[key]!)) {
                        delete out[key];
                    }
                }
                if (out.points.length < 2 || (wasClosed && out.points.length < 4)) {
                    return c;
                }
            } else if (out.points.length < 2) {
                return c;
            }
            if (out.kind === 'styleSpline' && out.degree && out.points.length <= out.degree) {
                delete out.degree;
            }
            return out;
        }),
    };

    // Curves that use a removed point go with it.
    for (const c of g.curves) {
        if (curvePoints(c).some((p) => gone.has(p))) {
            gone.add(c.id);
        }
    }
    const curves = g.curves.filter((c) => !gone.has(c.id));
    const used = new Set(curves.flatMap(curvePoints));
    const points = g.points.filter((p) => !gone.has(p.id) && (used.has(p.id) || p.id === ORIGIN));
    const alive = new Set([...points.map((p) => p.id), ...curves.map((c) => c.id), ORIGIN, AXIS_U, AXIS_V]);
    const constraints = g.constraints.filter((c) => !gone.has(c.id) && constraintRefs(c).every((r) => alive.has(r)));
    return { points, curves, constraints };
}

/**
 * Like removeItems, but points that stand alone (sketch points no curve uses) stay unless they are removed
 * themselves: only the points the removed curves leave unused go.
 */
export function removeItemsKeepingPoints(g: SketchGeometry, ids: string[]): SketchGeometry {
    const usedBefore = new Set(g.curves.flatMap(curvePoints));
    const gone = new Set(ids);
    const loose = g.points.filter((p) => !usedBefore.has(p.id) && !gone.has(p.id)).map((p) => p.id);
    const out = removeItems(g, ids);
    if (!loose.length) {
        return out;
    }
    // Put the loose points back, with the constraints that only fell because those points were missing.
    const kept = new Set(loose);
    const points = g.points.filter((p) => kept.has(p.id) || out.points.some((q) => q.id === p.id));
    const alive = new Set([...points.map((p) => p.id), ...out.curves.map((c) => c.id), ORIGIN, AXIS_U, AXIS_V]);
    const constraints = g.constraints.filter((c) => !gone.has(c.id) && constraintRefs(c).every((r) => alive.has(r)));
    return { points, curves: out.curves, constraints };
}

/** Ids a constraint may refer to that exist: the sketch's points and curves, the origin and the axes. */
export function liveIds(g: SketchGeometry): Set<string> {
    return new Set([...g.points.map((p) => p.id), ...g.curves.map((c) => c.id), ORIGIN, AXIS_U, AXIS_V]);
}

/** Constraints that refer to geometry that is not there any more. */
export function danglingConstraints(g: SketchGeometry): string[] {
    const alive = liveIds(g);
    return g.constraints.filter((c) => constraintRefs(c).some((r) => !alive.has(r))).map((c) => c.id);
}

export function toggleConstruction(g: SketchGeometry, ids: string[]): SketchGeometry {
    return { ...g, curves: g.curves.map((c) => (ids.includes(c.id) ? { ...c, construction: !c.construction } : c)) };
}

// ---- Picking ------------------------------------------------------------------------------------------

/**
 * What a click picked. The dimension tool also picks a line's midpoint (a point pick with id `mid:<line>`) and the
 * edge of an arc or circle (a curve pick with `edge`: measured to its nearest side, not its centre).
 */
export type Pick = { type: 'point'; id: string } | { type: 'curve'; id: string; edge?: boolean };

const MID = 'mid:';
/** The line a midpoint pick stands for, or null for any other pick. */
export const midOfPick = (pick: Pick): string | null => (pick.type === 'point' && pick.id.startsWith(MID) ? pick.id.slice(MID.length) : null);
export const midPick = (line: string): Pick => ({ type: 'point', id: `${MID}${line}` });

/** The point or curve under the cursor (points win), including the origin and the two axes. */
/** Geometry copied in from the model or another sketch, locked where it is (sketchModel.ts). */
export interface BroughtIn {
    /** The locks that hold it (fix and fixRadius relations). */
    locks: Set<string>;
    /** Curves that came in whole: each of their points is held by such a lock. */
    curves: Set<string>;
    /**
     * Their shaping points (a spline's control vertices, a conic's apex, an ellipse's axis ends). They cannot move and
     * nothing is drawn on them, so they are neither shown nor picked: such a curve is one quiet curve with its ends.
     */
    handles: Set<string>;
    /** The brought-in curves on each point. */
    on: Map<string, string[]>;
}

const broughtCache = new WeakMap<SketchGeometry, BroughtIn>();

export function broughtIn(g: SketchGeometry): BroughtIn {
    const cached = broughtCache.get(g);
    if (cached) {
        return cached;
    }
    const out: BroughtIn = { locks: new Set(), curves: new Set(), handles: new Set(), on: new Map() };
    const held = new Set<string>();
    for (const c of g.constraints) {
        if ((c.kind === 'fix' || c.kind === 'fixRadius') && (isModelLock(c) || sketchLockSource(c))) {
            out.locks.add(c.id);
            if (c.kind === 'fix') {
                held.add(c.point);
            }
        }
    }
    const kept = new Set<string>();
    for (const c of held.size ? g.curves : []) {
        const ids = curvePointIds(c);
        if (!ids.length || !ids.every((id) => held.has(id))) {
            // A curve drawn on a brought-in point: that point stays a point.
            ids.forEach((id) => kept.add(id));
            continue;
        }
        out.curves.add(c.id);
        [...curveEndIds(c), ...curveCentreIds(c)].forEach((id) => kept.add(id));
        for (const id of ids) {
            out.on.set(id, [...(out.on.get(id) ?? []), c.id]);
            out.handles.add(id);
        }
    }
    kept.forEach((id) => out.handles.delete(id));
    broughtCache.set(g, out);
    return out;
}

/** Entities of hidden block instances: not picked. */
function hiddenBlockIds(g: SketchGeometry): Set<string> {
    return new Set((g.inserts ?? []).filter((i) => i.hidden).flatMap((i) => [...i.curves, ...i.points]));
}

export function pickAt(g: SketchGeometry, p: Pt, tolerance: number): Pick | null {
    let best: { pick: Pick; d: number } | null = null;
    const consider = (pick: Pick, d: number, limit: number) => {
        if (d < limit && (!best || d < best.d)) {
            best = { pick, d };
        }
    };
    consider({ type: 'point', id: ORIGIN }, dist(p, [0, 0]), tolerance * 1.2);
    const hidden = broughtIn(g).handles;
    const hiddenBlocks = hiddenBlockIds(g);
    for (const q of g.points) {
        if (hidden.has(q.id) || hiddenBlocks.has(q.id)) {
            continue;
        }
        consider({ type: 'point', id: q.id }, dist(p, [q.u, q.v]), tolerance * 1.2);
    }
    return best ? (best as { pick: Pick }).pick : curveAt(g, p, tolerance);
}

/** The drawable entities of a geometry for picking, kept while it is the same (pointer moves pick on every move). */
const pickEntities = new WeakMap<SketchGeometry, ReturnType<typeof geometryEntities>>();

/** The curve nearest the cursor within `tolerance`; the sketch axes (within `axes`) only when no drawn curve is. */
export function curveAt(g: SketchGeometry, p: Pt, tolerance: number, axes = tolerance * 0.8): Pick | null {
    let best: { pick: Pick; d: number } | null = null;
    const consider = (pick: Pick, d: number, limit: number) => {
        if (d < limit && (!best || d < best.d)) {
            best = { pick, d };
        }
    };
    let entities = pickEntities.get(g);
    if (!entities) {
        entities = geometryEntities(g);
        pickEntities.set(g, entities);
    }
    const hiddenBlocks = hiddenBlockIds(g);
    for (const e of entities) {
        if (!hiddenBlocks.has(e.id)) {
            consider({ type: 'curve', id: e.id }, entityDistance(e, p), tolerance);
        }
    }
    if (best) {
        return (best as { pick: Pick }).pick;
    }
    consider({ type: 'curve', id: AXIS_U }, Math.abs(p[1]), axes);
    consider({ type: 'curve', id: AXIS_V }, Math.abs(p[0]), axes);
    return best ? (best as { pick: Pick }).pick : null;
}

export function kindOf(g: SketchGeometry, pick: Pick): 'point' | SketchCurve['kind'] {

    if (pick.type === 'point') {
        return 'point';
    }
    if (pick.id === AXIS_U || pick.id === AXIS_V) {
        return 'line';
    }
    return curveOf(g, pick.id)?.kind ?? 'line';
}

export type ConstraintTool =
    | 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'equal' | 'midpoint' | 'symmetric' | 'fix'
    | 'concentric' | 'collinear' | 'coradial' | 'merge' | 'intersection' | 'equalSlots' | 'fixSlot';

const isAxisId = (id: string) => id === AXIS_U || id === AXIS_V;

/**
 * The relations a tool adds for the picked geometry, as the SolidWorks relation table describes it: horizontal and
 * vertical take one or more lines (each one) or two or more points; parallel, collinear, equal, concentric and
 * coradial take two or more (each related to the first); the rest take a fixed set. Merge gives the coincidences
 * that merging the points means. Says what is needed when the picks do not fit.
 */
export function relationsFromPicks(g: SketchGeometry, tool: ConstraintTool, picks: Pick[]): NewConstraint[] | { need: string } {
    const kinds = picks.map((p) => kindOf(g, p));
    const ids = picks.map((p) => p.id);
    const points = ids.filter((_, i) => kinds[i] === 'point');
    const lines = ids.filter((_, i) => kinds[i] === 'line');
    const drawnLines = lines.filter((id) => !isAxisId(id));
    const rounds = ids.filter((_, i) => kinds[i] === 'circle' || kinds[i] === 'arc');
    const only = (...groups: string[][]) => groups.reduce((n, list) => n + list.length, 0) === picks.length;
    // Ellipses, partial ellipses and parabolas take a point on them and a tangent line; splines and conics not yet.
    const conics = ids.filter((_, i) => kinds[i] === 'ellipse' || kinds[i] === 'ellipseArc' || kinds[i] === 'parabola');
    const unheld = ids.filter((_, i) => kinds[i] === 'spline' || kinds[i] === 'styleSpline' || kinds[i] === 'conic');
    // Tangent to a path: held by whichever of its curves touches (sketchPathModel.ts).
    const viaPath = pathRelationFor(g, tool, picks);
    if (viaPath) {
        return viaPath;
    }
    // A point on a conic (held as the rational curve it is: solverExtras.ts).
    const conicPicks = ids.filter((_, i) => kinds[i] === 'conic');
    if (tool === 'coincident' && conicPicks.length === 1 && points.length >= 1 && only(points, conicPicks)) {
        return points.map((point) => ({ kind: 'pointOnCurve', point, curve: conicPicks[0] }));
    }
    if (unheld.length && tool !== 'fix') {
        const kind = kinds[ids.indexOf(unheld[0])];
        const what = kind === 'spline' ? 'splines' : kind === 'styleSpline' ? 'style splines' : 'conics';
        // Tangent at a joined end: a line or arc that ends where the curve does, held by the curve's control point there
        // (a conic's top vertex, a style spline's next control vertex, a spline's tangency handle).
        const curve = curveOf(g, unheld[0]);
        const other = ids.find((id) => id !== unheld[0]);
        const otherCurve = other ? curveOf(g, other) : undefined;
        const ends = curve ? curveEndIds(curve) : [];
        const otherEnds = otherCurve ? curveEndIds(otherCurve) : [];
        const joint = ends.find((p) => otherEnds.includes(p));
        const handle = curve?.kind !== 'spline' || (joint === ends[0] ? !!curve.startHandle : !!curve.endHandle);
        const atEnd = tool === 'tangent' && picks.length === 2 && (otherCurve?.kind === 'line' || otherCurve?.kind === 'arc') && !!joint && handle;
        if (!atEnd) {
            return {
                need: tool === 'tangent' && kind === 'spline' && joint
                    ? 'Give the spline a tangency handle at that end first (in its PropertyManager)'
                    : tool === 'tangent' ? `Pick a line or arc that ends where the ${what.slice(0, -1)} ends`
                        : `Relations to ${what} are not available yet: drag their points, or relate and dimension those points instead`,
            };
        }
        return [{ kind: 'tangent', a: other!, b: unheld[0] }];
    }

    if (conics.length) {
        if (tool === 'coincident' && points.length >= 1 && conics.length === 1 && only(points, conics)) {
            return points.map((point) => ({ kind: 'pointOnCurve', point, curve: conics[0] }));
        }
        if (tool === 'tangent' && picks.length === 2 && conics.length === 1 && (drawnLines.length === 1 || rounds.length === 1)) {
            return [{ kind: 'tangent', a: ids[0], b: ids[1] }];
        }
        // Equal ellipses (full or partial): the same two radii.
        const ovals = ids.filter((_, i) => kinds[i] === 'ellipse' || kinds[i] === 'ellipseArc');
        if (tool === 'equal' && ovals.length >= 2 && new Set(ovals).size === ovals.length && only(ovals)) {
            return ovals.slice(1).map((b) => ({ kind: 'equal', a: ovals[0], b }));
        }
        if (tool !== 'fix') {
            return { need: tool === 'coincident' ? 'Pick a point and the ellipse or parabola' : tool === 'tangent' ? 'Pick a line and the ellipse or parabola'
                : 'This relation does not take ellipses or parabolas: relate their points (centre, axis ends, focus, vertex) instead' };
        }
    }
    const curves = [...lines, ...rounds];

    // An axis goes first, so the others are related to it.
    const axisFirst = (list: string[]) => [...list.filter(isAxisId), ...list.filter((id) => !isAxisId(id))];
    const pairs = <K extends 'coincident' | 'parallel' | 'equal' | 'concentric' | 'coradial' | 'collinear' | 'horizontalPoints' | 'verticalPoints'>(
        kind: K, list: string[]) => list.slice(1).map((b) => ({ kind, a: list[0], b }) as NewConstraint);
    switch (tool) {
        case 'coincident':
            if (points.length === 1 && curves.length >= 1 && only(points, curves)) {
                return curves.map((curve) => ({ kind: 'pointOnCurve', point: points[0], curve }));
            }
            if (points.length >= 2 && curves.length === 1) {
                return points.map((point) => ({ kind: 'pointOnCurve', point, curve: curves[0] }));
            }
            if (points.length >= 2 && only(points)) {
                return pairs('coincident', points);
            }
            return { need: 'Pick two points, or a point and a curve' };
        case 'merge':
            return points.length >= 2 && only(points) ? pairs('coincident', points) : { need: 'Pick two or more points to merge' };
        case 'horizontal':
        case 'vertical':
            if (drawnLines.length && only(drawnLines)) {
                return drawnLines.map((line) => ({ kind: tool, line }));
            }
            if (points.length >= 2 && only(points)) {
                return pairs(tool === 'horizontal' ? 'horizontalPoints' : 'verticalPoints', points);
            }
            return { need: 'Pick one or more lines, or two or more points' };
        case 'parallel':
            return lines.length >= 2 && drawnLines.length >= 1 && only(lines) ? pairs('parallel', axisFirst(lines)) : { need: 'Pick two or more lines' };
        case 'collinear':
            return lines.length >= 2 && drawnLines.length >= lines.length - 1 && only(lines)
                ? pairs('collinear', axisFirst(lines)) : { need: 'Pick two or more lines' };
        case 'perpendicular':
            return lines.length === 2 && drawnLines.length >= 1 && only(lines)
                ? [{ kind: 'perpendicular', a: lines[0], b: lines[1] }] : { need: 'Pick two lines' };
        case 'tangent':
            return curves.length === 2 && rounds.length >= 1 && drawnLines.length === lines.length && only(curves)
                ? [{ kind: 'tangent', a: ids[0], b: ids[1] }] : { need: 'Pick a line and an arc or circle, or two arcs/circles' };
        case 'equal':
            if (drawnLines.length >= 2 && only(drawnLines)) {
                return pairs('equal', drawnLines);
            }
            return rounds.length >= 2 && only(rounds) ? pairs('equal', rounds) : { need: 'Pick two or more lines, or two or more arcs/circles' };
        case 'concentric':
            return rounds.length >= 1 && points.length <= 1 && rounds.length + points.length >= 2 && only(rounds, points)
                ? pairs('concentric', [...rounds, ...points]) : { need: 'Pick two or more arcs/circles, or a point and an arc/circle' };
        case 'coradial':
            return rounds.length >= 2 && only(rounds) ? pairs('coradial', rounds) : { need: 'Pick two or more arcs/circles' };
        case 'midpoint':
            return points.length === 1 && drawnLines.length === 1 && only(points, drawnLines)
                ? [{ kind: 'midpoint', point: points[0], line: drawnLines[0] }] : { need: 'Pick a point and a line' };
        case 'symmetric':
            return points.length === 2 && lines.length === 1 && only(points, lines)
                ? [{ kind: 'symmetric', a: points[0], b: points[1], about: lines[0] }] : { need: 'Pick two points and a line to mirror them about' };
        case 'fix':
            return points.length ? points.map((point) => ({ kind: 'fix', point })) : { need: 'Pick a point' };
        case 'intersection':
            return points.length === 1 && lines.length === 2 && drawnLines.length >= 1 && only(points, lines)
                ? [{ kind: 'intersection', point: points[0], a: lines[0], b: lines[1] }] : { need: 'Pick two lines and a point' };
        case 'equalSlots':
            // Equal lengths and radii (arc slots: radius, width and angle), each slot against the first.
            return picks.every((p) => p.type === 'curve') ? equalSlotRelations(g, ids) : { need: 'Pick a curve of each of two or more slots' };
        case 'fixSlot':
            // Size and place fixed: every point of the slot locked (the sketcher leaves out what the slot's own
            // relations already hold).
            return picks.every((p) => p.type === 'curve') ? fixSlotRelations(g, ids) : { need: 'Pick a curve of a slot' };
    }
}

/** The first relation `relationsFromPicks` gives, or what is still needed. */
export function constraintFromPicks(g: SketchGeometry, tool: ConstraintTool, picks: Pick[]): NewConstraint | { need: string } {
    const result = relationsFromPicks(g, tool, picks);
    return 'need' in result ? result : result[0];
}

/** How many picks a constraint tool needs at least (picked in the view, it applies as soon as it has a valid set). */
export const PICKS_NEEDED: Record<ConstraintTool, number> = {
    coincident: 2, horizontal: 1, vertical: 1, parallel: 2, perpendicular: 2, tangent: 2, equal: 2, midpoint: 2, symmetric: 3, fix: 1,
    concentric: 2, collinear: 2, coradial: 2, merge: 2, intersection: 3, equalSlots: 2, fixSlot: 1,
};

/**
 * A centreline: a construction line, or a sketch axis. A model edge or another sketch's line brought in (a locked
 * construction line) is not one: distances to it are plain distances.
 */
function isCentreline(g: SketchGeometry, id: string): boolean {
    const c = curveOf(g, id);
    if (id === AXIS_U || id === AXIS_V) {
        return true;
    }
    if (c?.kind !== 'line' || !c.construction) {
        return false;
    }
    const broughtIn = (p: string) => g.constraints.some((k) => k.kind === 'fix' && k.point === p && (isModelLock(k) || !!sketchLockSource(k)));
    return !(broughtIn(c.a) && broughtIn(c.b));
}

/** Where a picked point (or line midpoint) is. */
function pickedAt(g: SketchGeometry, pick: Pick): Pt | null {
    const line = midOfPick(pick);
    if (line) {
        const c = curveOf(g, line);
        if (c?.kind === 'arc') {
            // An arc's midpoint (Smart Dimension picks it like a line's).
            const [m, s, e] = [c.center, c.start, c.end].map((id) => pointOf(g, id));
            return m && s && e ? arcMiddle([m.u, m.v], [s.u, s.v], [e.u, e.v]) : null;
        }
        const [a, b] = c?.kind === 'line' ? [pointOf(g, c.a), pointOf(g, c.b)] : [];
        return a && b ? [(a.u + b.u) / 2, (a.v + b.v) / 2] : null;
    }
    const p = pointOf(g, pick.id);
    return p ? [p.u, p.v] : null;
}

/** Placed above or below two points: a horizontal measure; to the left or right: a vertical one; between: aligned. */
function axisFor(pa: Pt, pb: Pt, place: Pt): 'u' | 'v' | undefined {
    const outsideU = place[0] < Math.min(pa[0], pb[0]) || place[0] > Math.max(pa[0], pb[0]);
    const outsideV = place[1] < Math.min(pa[1], pb[1]) || place[1] > Math.max(pa[1], pb[1]);
    return outsideV && !outsideU ? 'u' : outsideU && !outsideV ? 'v' : undefined;
}

/**
 * The Smart Dimension cases beyond one or two plain picks: arc length (an arc, then its two end points), the angle at
 * the first of three points, distances with a line's midpoint, and distances to the edge of an arc or circle. Null:
 * not one of these (the plain cases apply); false: these picks cannot be dimensioned together.
 */
function furtherDimension(g: SketchGeometry, picks: Pick[], place: Pt, lock: 'u' | 'v' | null): NewConstraint | null | false {
    if (picks.length === 3) {
        const arc = curveOf(g, midOfPick(picks[0]) ?? picks[0].id);
        const [p, q] = [picks[1], picks[2]];
        if (arc?.kind === 'arc' && !lock) {
            const ends = [arc.start, arc.end];
            return p.type === 'point' && q.type === 'point' && p.id !== q.id && ends.includes(p.id) && ends.includes(q.id)
                ? { kind: 'arcLength', curve: arc.id, value: 0 } : false;
        }
        const points = picks.every((x) => x.type === 'point' && !midOfPick(x) && pointOf(g, x.id));
        return points && !lock && new Set(picks.map((x) => x.id)).size === 3 ? { kind: 'pointAngle', vertex: picks[0].id, a: p.id, b: q.id, value: 0 } : false;
    }
    const mids = picks.map(midOfPick);
    if (picks.length === 1 && mids[0]) {
        // A line picked at its midpoint and placed on its own is that line's length; an arc's, its radius.
        const line = curveOf(g, mids[0]);
        if (line?.kind === 'arc') {
            return lock ? false : { kind: 'radius', curve: line.id, value: 0 };
        }
        return line?.kind !== 'line' ? false : lock ? { kind: 'distance', a: line.a, b: line.b, value: 0, axis: lock } : { kind: 'length', line: line.id, value: 0 };
    }
    if (picks.length !== 2) {
        return null;
    }
    const isRound = (pick: Pick) => {
        const k = kindOf(g, pick);
        return pick.type === 'curve' && (k === 'circle' || k === 'arc');
    };
    const edges = picks.map((pick) => pick.type === 'curve' && !!pick.edge && isRound(pick));
    if (!mids.some(Boolean) && !edges.some(Boolean)) {
        return null;
    }
    // Each end as the distance stores it: a point, a midpoint (its line, flagged), a line, or an arc edge.
    type End = { id: string; mid?: boolean; cond?: 'min'; line?: boolean; at: Pt | null };
    const ends: End[] = picks.map((pick, i) => {
        if (mids[i]) {
            return { id: mids[i]!, mid: true, at: pickedAt(g, pick) };
        }
        if (edges[i]) {
            return { id: pick.id, cond: 'min', at: null };
        }
        const curve = curveOf(g, pick.id);
        if (curve && (curve.kind === 'circle' || curve.kind === 'arc')) {
            return { id: curve.center, at: pickedAt(g, { type: 'point', id: curve.center }) };
        }
        if (pick.type === 'curve') {
            return kindOf(g, pick) === 'line' ? { id: pick.id, line: true, at: null } : { id: '', at: null };
        }
        return { id: pick.id, at: pickedAt(g, pick) };
    });
    if (ends.some((e) => !e.id) || (ends[0].line && ends[1].line) || ends[0].id === ends[1].id) {
        return false;
    }
    // A line goes second.
    const [a, b] = ends[0].line ? [ends[1], ends[0]] : ends;
    if (b.line && (lock || (a.mid && a.id === b.id))) {
        return false;
    }
    const axis = lock ?? (a.at && b.at && !a.cond && !b.cond ? axisFor(a.at, b.at, place) : undefined);
    return {
        kind: 'distance', a: a.id, b: b.id, value: 0,
        ...(a.mid ? { aMid: true } : {}), ...(b.mid ? { bMid: true } : {}),
        ...(a.cond ? { aCond: a.cond } : {}), ...(b.cond ? { bCond: b.cond } : {}),
        ...(axis && !b.line ? { axis } : {}),
    };
}

/**
 * Where a dimension's value applies, from the picks and the placement point (Fusion style). `lock` is the
 * Horizontal or Vertical Dimension tool: the distance is measured along that axis only.
 */
export function dimensionFromPicks(g: SketchGeometry, picks: Pick[], place: Pt, lock: 'u' | 'v' | null = null): NewConstraint | null {
    // A spline's tangency handle: its length, or its angle to a line (sketchDimGroups.ts).
    const handle = lock ? undefined : handleDimension(g, picks);
    if (handle !== undefined) {
        return handle;
    }
    const further = furtherDimension(g, picks, place, lock);
    if (further !== null) {
        return further || null;
    }
    const kinds = picks.map((p) => kindOf(g, p));
    if (lock) {
        return lockedDimension(g, picks, kinds, lock);
    }
    if (picks.length === 1) {
        if (kinds[0] === 'line' && picks[0].id !== AXIS_U && picks[0].id !== AXIS_V) {
            // An infinite line has no length.
            const line = curveOf(g, picks[0].id);
            return line?.kind === 'line' && line.endless ? null : { kind: 'length', line: picks[0].id, value: 0 };
        }
        if (kinds[0] === 'conic') {
            // A conic's dimension is its Rho.
            return { kind: 'rho', curve: picks[0].id, value: 0 };
        }
        if (kinds[0] === 'circle') {
            return { kind: 'diameter', curve: picks[0].id, value: 0 };
        }
        if (kinds[0] === 'arc') {
            return { kind: 'radius', curve: picks[0].id, value: 0 };
        }
        if (kinds[0] === 'spline' && picks[0].type === 'curve') {
            // SolidWorks: a spline dimensioned on its own holds its length (sketchSplineLength.ts).
            return { kind: 'arcLength', curve: picks[0].id, value: 0 };
        }
        return null;
    }
    // An arc or circle measures from its centre (SolidWorks' default), so it stands for its centre point.
    const centred = picks.map((pick, i): Pick => {
        const curve = kinds[i] === 'circle' || kinds[i] === 'arc' ? curveOf(g, pick.id) : null;
        return curve && (curve.kind === 'circle' || curve.kind === 'arc') ? { type: 'point', id: curve.center } : pick;
    });
    if (centred.some((pick, i) => pick !== picks[i])) {
        const [a, b] = centred;
        if (a.id === b.id || kinds.filter((k) => k === 'line').length > 1) {
            return null;
        }
        return dimensionFromPicks(g, centred, place);
    }
    const [a, b] = picks;
    if (kinds[0] === 'point' && kinds[1] === 'point') {
        const pa = pointOf(g, a.id)!;
        const pb = pointOf(g, b.id)!;
        const [u0, u1] = [Math.min(pa.u, pb.u), Math.max(pa.u, pb.u)];
        const [v0, v1] = [Math.min(pa.v, pb.v), Math.max(pa.v, pb.v)];
        const outsideU = place[0] < u0 || place[0] > u1;
        const outsideV = place[1] < v0 || place[1] > v1;
        // Placed above or below: a horizontal measure; to the left or right: a vertical one; between: aligned.
        const axis = outsideV && !outsideU ? 'u' : outsideU && !outsideV ? 'v' : undefined;
        return { kind: 'distance', a: a.id, b: b.id, value: 0, ...(axis ? { axis } : {}) };
    }
    if (kinds[0] === 'line' && kinds[1] === 'line') {
        // Parallel lines have no angle to set: dimension the distance between them, from an end of one to the other.
        const direction = (id: string): Pt | null => {
            if (id === AXIS_U || id === AXIS_V) {
                return id === AXIS_U ? [1, 0] : [0, 1];
            }
            const line = curveOf(g, id);
            const p = line?.kind === 'line' ? pointOf(g, line.a) : null;
            const q = line?.kind === 'line' ? pointOf(g, line.b) : null;
            const length = p && q ? Math.hypot(q.u - p.u, q.v - p.v) : 0;
            return p && q && length > 0 ? [(q.u - p.u) / length, (q.v - p.v) / length] : null;
        };
        const da = direction(a.id);
        const db = direction(b.id);
        // Measured from an end of the profile line to the other line (a centreline when there is one: doubled across it).
        const drawn = [a, b].find((pick) => curveOf(g, pick.id)?.kind === 'line' && !isCentreline(g, pick.id))
            ?? [a, b].find((pick) => curveOf(g, pick.id)?.kind === 'line');
        if (da && db && drawn && Math.abs(da[0] * db[1] - da[1] * db[0]) < Math.sin((0.5 * Math.PI) / 180)) {
            const line = curveOf(g, drawn.id);
            const other = drawn === a ? b : a;
            if (line?.kind === 'line') {
                return withDoubled(g, { kind: 'distance', a: line.a, b: other.id, value: 0 }, place);
            }
        }
        return da && db ? angleBetween(a.id, b.id, da, db, lineThrough(g, a.id), lineThrough(g, b.id), place) : { kind: 'angle', a: a.id, b: b.id, value: 0 };
    }
    const pi = kinds.indexOf('point');
    if (pi >= 0 && kinds[1 - pi] === 'line') {
        return withDoubled(g, { kind: 'distance', a: picks[pi].id, b: picks[1 - pi].id, value: 0 }, place);
    }
    return null;
}

/**
 * A distance from a point to a centreline, placed on the far side of the centreline, is doubled: it dimensions the
 * diameter a revolve about that centreline makes (SolidWorks: near side radius, far side diameter).
 */
function withDoubled(g: SketchGeometry, c: Extract<NewConstraint, { kind: 'distance' }>, place: Pt): NewConstraint {
    const p = pointOf(g, c.a);
    if (!p || !isCentreline(g, c.b)) {
        return c;
    }
    const line = curveOf(g, c.b);
    const [s, e]: Pt[] = line?.kind === 'line'
        ? [pointOf(g, line.a), pointOf(g, line.b)].map((q) => (q ? [q.u, q.v] as Pt : [0, 0] as Pt))
        : c.b === AXIS_U ? [[0, 0], [1, 0]] : [[0, 0], [0, 1]];
    const side = (q: Pt) => (e[0] - s[0]) * (q[1] - s[1]) - (e[1] - s[1]) * (q[0] - s[0]);
    const [sp, sq] = [side([p.u, p.v]), side(place)];
    return Math.abs(sp) > 1e-9 && sp * sq < 0 ? { ...c, doubled: true } : c;
}

/** The Horizontal and Vertical Dimension tools: two points (or centres), a line's two ends, or a point and the axis across. */
function lockedDimension(g: SketchGeometry, picks: Pick[], kinds: string[], axis: 'u' | 'v'): NewConstraint | null {
    if (picks.length === 1) {
        const line = curveOf(g, picks[0].id);
        return line?.kind === 'line' ? { kind: 'distance', a: line.a, b: line.b, value: 0, axis } : null;
    }
    if (picks.length !== 2) {
        return null;
    }
    const ids = picks.map((pick, i) => {
        const curve = kinds[i] === 'circle' || kinds[i] === 'arc' ? curveOf(g, pick.id) : null;
        return curve && (curve.kind === 'circle' || curve.kind === 'arc') ? { point: curve.center } : kinds[i] === 'point' ? { point: pick.id } : { line: pick.id };
    });
    const [a, b] = ids;
    if (a.point && b.point) {
        return a.point === b.point ? null : { kind: 'distance', a: a.point, b: b.point, value: 0, axis };
    }
    // Along u to the vertical axis (or along v to the horizontal one) is the distance square to it.
    const across = axis === 'u' ? AXIS_V : AXIS_U;
    const point = a.point ?? b.point;
    const line = a.line ?? b.line;
    return point && line === across ? { kind: 'distance', a: point, b: line, value: 0 } : null;
}

/** A point on a line (an end, or the origin for an axis). */
function lineThrough(g: SketchGeometry, id: string): Pt {
    const line = curveOf(g, id);
    const p = line?.kind === 'line' ? pointOf(g, line.a) : null;
    return p ? [p.u, p.v] : [0, 0];
}

/**
 * The angle dimension between two lines for a label placed at `place`: of the four angles at their crossing, the
 * one the label sits in, given by which way along each line it is measured.
 */
function angleBetween(a: string, b: string, da: Pt, db: Pt, pa: Pt, pb: Pt, place: Pt): NewConstraint {
    const den = da[0] * db[1] - da[1] * db[0];
    const t = ((pb[0] - pa[0]) * db[1] - (pb[1] - pa[1]) * db[0]) / den;
    const o: Pt = [pa[0] + da[0] * t, pa[1] + da[1] * t];
    const label = Math.atan2(place[1] - o[1], place[0] - o[0]);
    const angleOf = (d: Pt, reverse: boolean) => Math.atan2(reverse ? -d[1] : d[1], reverse ? -d[0] : d[0]);
    const gap = (x: number, y: number) => Math.abs(Math.atan2(Math.sin(y - x), Math.cos(y - x)));
    let best: { reverseA: boolean; reverseB: boolean; miss: number } | null = null;
    for (const reverseA of [false, true]) {
        for (const reverseB of [false, true]) {
            const x = angleOf(da, reverseA);
            const y = angleOf(db, reverseB);
            // Inside the angle from x to y the label's gaps to both sides add up to the angle itself.
            const miss = gap(x, label) + gap(label, y) - gap(x, y);
            if (!best || miss < best.miss) {
                best = { reverseA, reverseB, miss };
            }
        }
    }
    return { kind: 'angle', a, b, value: 0, reverseA: best!.reverseA, reverseB: best!.reverseB };
}

/** Evaluates a typed value: numbers with + - * / and parentheses, e.g. "40/2" or "25.4*2". */
export function evaluate(text: string): number | null {
    const source = text.replace(/,/g, '.').replace(/\s+/g, '');
    if (!/^[0-9.+\-*/()]+$/.test(source)) {
        return null;
    }
    let i = 0;
    const peek = () => source[i];
    const number = (): number => {
        if (peek() === '(') {
            i += 1;
            const v = expr();
            i += 1;
            return v;
        }
        if (peek() === '-') {
            i += 1;
            return -number();
        }
        const m = /^\d*\.?\d+(?:e[+-]?\d+)?|^\d+\.?/.exec(source.slice(i));
        if (!m) {
            throw new Error('number');
        }
        i += m[0].length;
        return Number(m[0]);
    };
    const term = (): number => {
        let v = number();
        while (peek() === '*' || peek() === '/') {
            const op = source[i++];
            const r = number();
            v = op === '*' ? v * r : v / r;
        }
        return v;
    };
    const expr = (): number => {
        let v = term();
        while (peek() === '+' || peek() === '-') {
            const op = source[i++];
            const r = term();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    };
    try {
        const v = expr();
        return i === source.length && Number.isFinite(v) ? v : null;
    } catch {
        return null;
    }
}
