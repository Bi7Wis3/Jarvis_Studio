// Constrained sketch geometry helpers: converting between SketchGeometry (points, curves, constraints) and the
// drawable entities / solved profiles, building geometry from the drawing tools, and picking.

import type { SketchConstraint, SketchCurve, SketchGeometry, SketchPoint, SketchProfile } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, pointOf } from './solver';
import { arcPoints, circleThrough, dist, entityDistance, mid, type Entity, type Pt } from './sketchMath';
import { openChains, regionProfiles } from './sketchRegions';

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
            if (a && b) {
                out.push({ id: curve.id, kind: 'line', a: at(a), b: at(b), construction: curve.construction });
            }
        } else if (curve.kind === 'circle') {
            const c = pointOf(g, curve.center);
            if (c) {
                out.push({ id: curve.id, kind: 'circle', c: at(c), r: curve.radius, construction: curve.construction });
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
        if (c.kind === 'line') {
            ends.set(c.id, [c.a, c.b]);
        } else if (c.kind === 'arc') {
            ends.set(c.id, [c.start, c.end]);
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
            case 'path': {
                const segments = p.segments.map((s) => (s.kind === 'line' ? { kind: 'line' as const, to: s.to } : { kind: 'arc' as const, to: s.to, through: s.through }));
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
    for (const curve of ref.onCurves ?? []) {
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
            return [c.curve];
        case 'symmetric':
            return [c.a, c.b, c.about];
        default:
            return [c.a, c.b];
    }
}

function curvePoints(c: SketchCurve): string[] {
    return c.kind === 'line' ? [c.a, c.b] : c.kind === 'circle' ? [c.center] : [c.center, c.start, c.end];
}

/** Removes points, curves or constraints, with everything that depends on them; orphan points go too. */
export function removeItems(g: SketchGeometry, ids: string[]): SketchGeometry {
    const gone = new Set(ids);
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

export type Pick = { type: 'point'; id: string } | { type: 'curve'; id: string };

/** The point or curve under the cursor (points win), including the origin and the two axes. */
export function pickAt(g: SketchGeometry, p: Pt, tolerance: number): Pick | null {
    let best: { pick: Pick; d: number } | null = null;
    const consider = (pick: Pick, d: number, limit: number) => {
        if (d < limit && (!best || d < best.d)) {
            best = { pick, d };
        }
    };
    consider({ type: 'point', id: ORIGIN }, dist(p, [0, 0]), tolerance * 1.2);
    for (const q of g.points) {
        consider({ type: 'point', id: q.id }, dist(p, [q.u, q.v]), tolerance * 1.2);
    }
    return best ? (best as { pick: Pick }).pick : curveAt(g, p, tolerance);
}

/** The curve nearest the cursor within `tolerance`; the sketch axes (within `axes`) only when no drawn curve is. */
export function curveAt(g: SketchGeometry, p: Pt, tolerance: number, axes = tolerance * 0.8): Pick | null {
    let best: { pick: Pick; d: number } | null = null;
    const consider = (pick: Pick, d: number, limit: number) => {
        if (d < limit && (!best || d < best.d)) {
            best = { pick, d };
        }
    };
    for (const e of geometryEntities(g)) {
        consider({ type: 'curve', id: e.id }, entityDistance(e, p), tolerance);
    }
    if (best) {
        return (best as { pick: Pick }).pick;
    }
    consider({ type: 'curve', id: AXIS_U }, Math.abs(p[1]), axes);
    consider({ type: 'curve', id: AXIS_V }, Math.abs(p[0]), axes);
    return best ? (best as { pick: Pick }).pick : null;
}

export function kindOf(g: SketchGeometry, pick: Pick): 'point' | 'line' | 'circle' | 'arc' {
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
    | 'concentric' | 'collinear' | 'coradial' | 'merge';

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
    const curves = [...lines, ...rounds];
    const only = (...groups: string[][]) => groups.reduce((n, list) => n + list.length, 0) === picks.length;
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
    concentric: 2, collinear: 2, coradial: 2, merge: 2,
};

/** Where a dimension's value applies, from the picks and the placement point (Fusion style). */
export function dimensionFromPicks(g: SketchGeometry, picks: Pick[], place: Pt): NewConstraint | null {
    const kinds = picks.map((p) => kindOf(g, p));
    if (picks.length === 1) {
        if (kinds[0] === 'line' && picks[0].id !== AXIS_U && picks[0].id !== AXIS_V) {
            return { kind: 'length', line: picks[0].id, value: 0 };
        }
        if (kinds[0] === 'circle') {
            return { kind: 'diameter', curve: picks[0].id, value: 0 };
        }
        if (kinds[0] === 'arc') {
            return { kind: 'radius', curve: picks[0].id, value: 0 };
        }
        return null;
    }
    // An arc or circle measures from its centre (SolidWorks' default), so it stands for its centre point.
    const centred = picks.map((pick, i): Pick => {
        const curve = kinds[i] === 'circle' || kinds[i] === 'arc' ? curveOf(g, pick.id) : null;
        return curve && curve.kind !== 'line' ? { type: 'point', id: curve.center } : pick;
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
        const drawn = [a, b].find((pick) => curveOf(g, pick.id)?.kind === 'line');
        if (da && db && drawn && Math.abs(da[0] * db[1] - da[1] * db[0]) < Math.sin((0.5 * Math.PI) / 180)) {
            const line = curveOf(g, drawn.id);
            const other = drawn === a ? b : a;
            if (line?.kind === 'line') {
                return { kind: 'distance', a: line.a, b: other.id, value: 0 };
            }
        }
        return da && db ? angleBetween(a.id, b.id, da, db, lineThrough(g, a.id), lineThrough(g, b.id), place) : { kind: 'angle', a: a.id, b: b.id, value: 0 };
    }
    const pi = kinds.indexOf('point');
    if (pi >= 0 && kinds[1 - pi] === 'line') {
        return { kind: 'distance', a: picks[pi].id, b: picks[1 - pi].id, value: 0 };
    }
    return null;
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
