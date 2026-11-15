// Geometry of the dimension kinds and behaviours beyond plain Smart Dimension (SolidWorks: Ordinate and Angular
// Running dimensions kept aligned in their row or ring, Break Alignment, dragging the zero; dimensions to spline
// handles; zero and negative position dimensions; maintaining proportions with the first dimension; driven
// dimensions placed automatically). Pure: the sketcher state is used in sketchDimTools.ts.

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, handleEnd, isDimension, measure, pointOf, type SolveResult } from './solver';
import type { NewConstraint, Pick } from './sketchGeometry';

type Pt = [number, number];
type Distance = Extract<SketchConstraint, { kind: 'distance' }>;
type PointAngle = Extract<SketchConstraint, { kind: 'pointAngle' }>;

const P = (g: SketchGeometry, id: string): Pt | null => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : null;
};
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const unit = (d: Pt): Pt => {
    const l = Math.hypot(d[0], d[1]);
    return l > 1e-12 ? [d[0] / l, d[1] / l] : [1, 0];
};

/** The two points of a line or a sketch axis. */
function lineOf(g: SketchGeometry, id: string): [Pt, Pt] | null {
    if (id === AXIS_U || id === AXIS_V) {
        return [[0, 0], id === AXIS_U ? [1, 0] : [0, 1]];
    }
    const c = curveOf(g, id);
    const [a, b] = c?.kind === 'line' ? [P(g, c.a), P(g, c.b)] : [null, null];
    return a && b ? [a, b] : null;
}

const isLineId = (g: SketchGeometry, id: string) => id === AXIS_U || id === AXIS_V || curveOf(g, id)?.kind === 'line';

// ---- Ordinate rows ------------------------------------------------------------------------------------------

/**
 * An ordinate dimension's frame: the point measured, the zero (a point, or the first point of the zero line), the
 * direction the value is measured along (`n`), the direction its leader runs to the row (`d`, square to `n`), and the
 * key of its row: dimensions from the same zero along the same direction line up in one row.
 */
export interface OrdinateFrame {
    point: Pt;
    pointId: string;
    zero: Pt;
    zeroId: string;
    zeroIsLine: boolean;
    n: Pt;
    d: Pt;
    key: string;
    /** The sketch axis the value runs along, when it runs along one. */
    axis?: 'u' | 'v';
}

export function ordinateFrame(g: SketchGeometry, c: SketchConstraint): OrdinateFrame | null {
    if (c.kind !== 'distance' || !c.ordinate) {
        return null;
    }
    if (c.axis) {
        const [z, p] = [P(g, c.a), P(g, c.b)];
        if (!z || !p) {
            return null;
        }
        return {
            point: p, pointId: c.b, zero: z, zeroId: c.a, zeroIsLine: false, key: `${c.a}|${c.axis}`, axis: c.axis,
            n: c.axis === 'u' ? [1, 0] : [0, 1], d: c.axis === 'u' ? [0, 1] : [1, 0],
        };
    }
    const p = P(g, c.a);
    const line = lineOf(g, c.b);
    if (!p || !line) {
        return null;
    }
    // Along the zero line: the leaders run parallel to it, the values square to it (an ordinate along an edge).
    let d = unit([line[1][0] - line[0][0], line[1][1] - line[0][1]]);
    if (Math.abs(d[0]) > Math.abs(d[1]) ? d[0] < 0 : d[1] < 0) {
        d = [-d[0], -d[1]];
    }
    const axis = Math.abs(d[0]) < 1e-9 ? 'u' : Math.abs(d[1]) < 1e-9 ? 'v' : undefined;
    return { point: p, pointId: c.a, zero: line[0], zeroId: c.b, zeroIsLine: true, n: [d[1], -d[0]], d, key: `${c.b}|line`, ...(axis ? { axis } : {}) };
}

/** Where the leader from point `p` meets the row through `at`. */
export function ordinateFoot(f: OrdinateFrame, p: Pt, at: Pt): Pt {
    const t = dot([at[0] - p[0], at[1] - p[1]], f.d);
    return [p[0] + f.d[0] * t, p[1] + f.d[1] * t];
}

/** The label of point `p` in the row at row coordinate `row` (along the leader direction `d`), beside the point. */
export function ordinateLabel(d: Pt, p: Pt, row: number): Pt {
    const t = row - dot(p, d);
    return [p[0] + d[0] * t, p[1] + d[1] * t];
}

// ---- Angular running sets -----------------------------------------------------------------------------------

/** An angular running dimension's centre, zero point and the key of its set (one centre, one zero). */
export function runningFrame(g: SketchGeometry, c: SketchConstraint): { centre: Pt; zero: Pt; point: Pt; key: string } | null {
    if (c.kind !== 'pointAngle' || !c.running) {
        return null;
    }
    const [centre, zero, point] = [P(g, c.vertex), P(g, c.a), P(g, c.b)];
    return centre && zero && point ? { centre, zero, point, key: `${c.vertex}|${c.a}` } : null;
}

/** On the ring of radius `r` about `centre`, in the direction of `toward`. */
export function onRing(centre: Pt, toward: Pt, r: number): Pt {
    const d = unit([toward[0] - centre[0], toward[1] - centre[1]]);
    return [centre[0] + d[0] * r, centre[1] + d[1] * r];
}

const unaligned = (c: SketchConstraint) => (c.kind === 'distance' || c.kind === 'pointAngle') && !!c.unaligned;

/**
 * The labels with one moved to `at`: the other members of its ordinate row (or angular running ring) move with it,
 * as SolidWorks keeps the group aligned; one whose alignment was broken moves alone.
 */
export function alignedLabels(g: SketchGeometry, labels: Record<string, Pt>, anchor: (c: SketchConstraint) => Pt, id: string, at: Pt): Record<string, Pt> {
    const out = { ...labels, [id]: at };
    const c = g.constraints.find((k) => k.id === id);
    if (!c || unaligned(c)) {
        return out;
    }
    const f = ordinateFrame(g, c);
    if (f) {
        return moveRow(g, out, anchor, f.key, dot(at, f.d), id);
    }
    const r = runningFrame(g, c);
    if (r) {
        return moveRing(g, out, anchor, r.key, Math.hypot(at[0] - r.centre[0], at[1] - r.centre[1]), id);
    }
    return out;
}

/** Every aligned member of the ordinate row `key` to row coordinate `row` (but `skip`). */
export function moveRow(g: SketchGeometry, labels: Record<string, Pt>, anchor: (c: SketchConstraint) => Pt, key: string, row: number, skip?: string): Record<string, Pt> {
    const out = { ...labels };
    for (const k of g.constraints) {
        const kf = k.id === skip || unaligned(k) ? null : ordinateFrame(g, k);
        if (kf?.key === key) {
            const l = out[k.id] ?? anchor(k);
            const t = row - dot(l, kf.d);
            out[k.id] = [l[0] + kf.d[0] * t, l[1] + kf.d[1] * t];
        }
    }
    return out;
}

/** Every aligned member of the running set `key` to the ring of radius `radius` (but `skip`). */
export function moveRing(g: SketchGeometry, labels: Record<string, Pt>, anchor: (c: SketchConstraint) => Pt, key: string, radius: number, skip?: string): Record<string, Pt> {
    const out = { ...labels };
    for (const k of g.constraints) {
        const kr = k.id === skip || unaligned(k) ? null : runningFrame(g, k);
        if (kr?.key === key) {
            out[k.id] = onRing(kr.centre, out[k.id] ?? anchor(k), Math.max(radius, 1e-6));
        }
    }
    return out;
}

/** The zero ("0" or "0°") of an ordinate row or a running set: where it sits, and what it is. */
export interface GroupZero {
    key: string;
    kind: 'ordinate' | 'running';
    at: Pt;
    /** The zero entity: a point, or (ordinates) a line. */
    zeroId: string;
    /** The point (or line point) the zero leader starts from. */
    from: Pt;
    members: string[];
}

/** The zero dimension of each ordinate row and running set, placed in line with the first aligned member. */
export function groupZeros(g: SketchGeometry, labels: Record<string, Pt>, anchor: (c: SketchConstraint) => Pt): GroupZero[] {
    const out = new Map<string, GroupZero>();
    for (const c of g.constraints) {
        const f = ordinateFrame(g, c);
        if (f) {
            const zero = out.get(`o:${f.key}`);
            if (zero) {
                zero.members.push(c.id);
                continue;
            }
            const l = labels[c.id] ?? anchor(c);
            // A zero line: its zero is the point of the line in the row; a zero point: its foot in the row.
            const from = f.zeroIsLine ? ordinateLabel(f.d, f.zero, dot(l, f.d)) : f.zero;
            out.set(`o:${f.key}`, { key: f.key, kind: 'ordinate', at: ordinateLabel(f.d, f.zero, dot(l, f.d)), zeroId: f.zeroId, from, members: [c.id] });
            continue;
        }
        const r = runningFrame(g, c);
        if (r) {
            const zero = out.get(`r:${r.key}`);
            if (zero) {
                zero.members.push(c.id);
                continue;
            }
            const l = labels[c.id] ?? anchor(c);
            const radius = Math.hypot(l[0] - r.centre[0], l[1] - r.centre[1]);
            out.set(`r:${r.key}`, { key: r.key, kind: 'running', at: onRing(r.centre, r.zero, radius), zeroId: (c as PointAngle).a, from: r.centre, members: [c.id] });
        }
    }
    return [...out.values()];
}

/**
 * The ordinate row `key` measured from a new zero instead (the zero dimension dragged onto it): a point, when the row
 * runs along a sketch axis, or a line parallel to the row's leaders. Each dimension keeps the size the geometry has
 * from the new zero, so nothing moves. Null when the new zero cannot be the row's zero.
 */
export function rezeroed(g: SketchGeometry, key: string, zero: string): SketchGeometry | null {
    const members = g.constraints.flatMap((c) => {
        const f = ordinateFrame(g, c);
        return f?.key === key ? [{ c: c as Distance, f }] : [];
    });
    if (!members.length || members.some((m) => m.f.zeroId === zero)) {
        return null;
    }
    const { f } = members[0];
    const asPoint = zero === ORIGIN || !!pointOf(g, zero);
    const line = asPoint ? null : lineOf(g, zero);
    if (asPoint ? !f.axis : !line || Math.abs(dot(unit([line[1][0] - line[0][0], line[1][1] - line[0][1]]), f.n)) > 1e-9) {
        return null;
    }
    const next = new Map(members.map(({ c, f: mf }) => {
        if (mf.pointId === zero) {
            return [c.id, null] as const;
        }
        const { a: _a, b: _b, axis: _x, ...rest } = c;
        const base = (asPoint ? { ...rest, a: zero, b: mf.pointId, axis: f.axis! } : { ...rest, a: mf.pointId, b: zero }) as Distance;
        const value = measure(g, base) ?? c.value;
        return [c.id, { ...base, value }] as const;
    }));
    return {
        ...g,
        // A dimension of the new zero itself has nothing left to measure and goes.
        constraints: g.constraints.flatMap((c) => (next.has(c.id) ? (next.get(c.id) ? [next.get(c.id)!] : []) : [c])),
    };
}

// ---- Spline handles -----------------------------------------------------------------------------------------

/**
 * Smart Dimension on a spline's tangency handle (SolidWorks: dimensioning to spline handles): the handle alone gives
 * its length (Tangent Weighting), the handle and a line its angle to the line (Tangent Radial Direction). Undefined
 * when no handle is picked, null when the picks do not go together.
 */
export function handleDimension(g: SketchGeometry, picks: Pick[]): NewConstraint | null | undefined {
    const handle = picks.find((p) => p.type === 'point' && handleEnd(g, p.id));
    if (!handle) {
        return undefined;
    }
    if (picks.length === 1) {
        return { kind: 'distance', a: handleEnd(g, handle.id)!, b: handle.id, value: 0 };
    }
    const other = picks.find((p) => p !== handle);
    if (picks.length === 2 && other?.type === 'curve' && isLineId(g, other.id)) {
        return { kind: 'angle', a: handle.id, b: other.id, value: 0 };
    }
    return undefined;
}

// ---- Zero and negative values -------------------------------------------------------------------------------

/**
 * A position dimension: a horizontal or vertical distance between two points, or a point's distance from a line.
 * Its value may be zero, and a negative value (or Reverse direction) puts the point on the other side.
 */
export function positionDimension(g: SketchGeometry, c: NewConstraint | SketchConstraint): boolean {
    if (c.kind !== 'distance' || c.doubled || c.aCond || c.bCond || c.aMid || c.bMid || !pointOf(g, c.a)) {
        return false;
    }
    return c.axis ? !!pointOf(g, c.b) : !pointOf(g, c.b) && isLineId(g, c.b);
}

/** What a typed value means for this dimension: the value to keep, whether it reverses, or why it cannot be. */
export function typedValue(g: SketchGeometry, c: NewConstraint | SketchConstraint, typed: number | null): { value: number; reverse: boolean } | { error: string } {
    const position = positionDimension(g, c);
    if (typed === null || !Number.isFinite(typed)) {
        return { error: position ? 'Type a value, e.g. 40, 0 or -12 (the other side)' : 'Type a positive value, e.g. 40 or 80/2' };
    }
    if (position) {
        return { value: Math.abs(typed), reverse: typed < 0 };
    }
    const angular = c.kind === 'angle' || c.kind === 'pointAngle';
    if (typed < 0 || (!angular && typed === 0)) {
        return { error: 'Type a positive value, e.g. 40 or 80/2 (only position dimensions take zero or a negative value)' };
    }
    if (c.kind === 'pointAngle' && c.running && !c.bidirectional ? typed > 360 : angular && typed > 180) {
        return { error: `An angle goes up to ${c.kind === 'pointAngle' && c.running && !c.bidirectional ? 360 : 180}°.` };
    }
    return { value: typed, reverse: false };
}

/** Where the dimensioned point goes to reverse a position dimension: mirrored about the zero point or the line. */
export function reverseTarget(g: SketchGeometry, c: NewConstraint | SketchConstraint): { point: string; u: number; v: number } | null {
    if (!positionDimension(g, c) || c.kind !== 'distance') {
        return null;
    }
    if (c.axis) {
        const [a, b] = [P(g, c.a)!, P(g, c.b)!];
        return c.axis === 'u' ? { point: c.b, u: 2 * a[0] - b[0], v: b[1] } : { point: c.b, u: b[0], v: 2 * a[1] - b[1] };
    }
    const line = lineOf(g, c.b)!;
    const p = P(g, c.a)!;
    const d = unit([line[1][0] - line[0][0], line[1][1] - line[0][1]]);
    const t = dot([p[0] - line[0][0], p[1] - line[0][1]], d);
    const foot: Pt = [line[0][0] + d[0] * t, line[0][1] + d[1] * t];
    return { point: c.a, u: 2 * foot[0] - p[0], v: 2 * foot[1] - p[1] };
}

/** Which side of the zero the dimensioned point is on now (+1 / -1; 0 on it), to tell that a reverse took. */
export function sideOf(g: SketchGeometry, c: NewConstraint | SketchConstraint): number {
    if (!positionDimension(g, c) || c.kind !== 'distance') {
        return 0;
    }
    if (c.axis) {
        const k = c.axis === 'u' ? 0 : 1;
        return Math.sign(P(g, c.b)![k] - P(g, c.a)![k]);
    }
    const line = lineOf(g, c.b)!;
    const p = P(g, c.a)!;
    return Math.sign((line[1][0] - line[0][0]) * (p[1] - line[0][1]) - (line[1][1] - line[0][1]) * (p[0] - line[0][0]));
}

// ---- Maintain proportions -----------------------------------------------------------------------------------

const SCALES = new Set<SketchConstraint['kind']>(['length', 'distance', 'radius', 'diameter', 'arcLength', 'pathLength']);

/**
 * The first dimension of a sketch scales the whole sketch about its origin so that it gets its value (SolidWorks:
 * maintaining proportions in a sketch profile; not for angles). Null when it does not apply: the sketch has
 * dimensions already, holds locked or fixed geometry, or the size does not change.
 */
export function firstDimensionScale(g: SketchGeometry, c: NewConstraint, value: number): SketchGeometry | null {
    if (!SCALES.has(c.kind) || g.constraints.some(isDimension) || g.constraints.some((k) => k.kind === 'fix' || k.kind === 'fixRadius')) {
        return null;
    }
    if (g.points.some((p) => p.fixed && p.id !== ORIGIN) || g.texts?.length || g.pictures?.length || g.equations?.length || g.inserts?.length) {
        return null;
    }
    const now = measure(g, { ...c, id: '__first' } as SketchConstraint);
    if (now === null || !(now > 1e-9) || !(value > 0) || Math.abs(value - now) < 1e-12) {
        return null;
    }
    const k = value / now;
    return {
        ...g,
        points: g.points.map((p) => (p.id === ORIGIN ? p : { ...p, u: p.u * k, v: p.v * k })),
        curves: g.curves.map((cu) => (cu.kind === 'circle' ? { ...cu, radius: cu.radius * k } : cu)),
    };
}

// ---- Driven dimensions placed automatically -----------------------------------------------------------------

/**
 * Dimensions an entity was drawn with (Add dimensions, or a typed size): driven when "Sketch dimension driven" is on;
 * otherwise the ones that would over define the sketch become driven (SolidWorks: the last entity of a closed
 * profile may clash with inferred relations, and its dimension is changed to driven).
 */
export function drawnDimensions(before: SketchGeometry, next: SketchGeometry, allDriven: boolean, solve: ((g: SketchGeometry) => SolveResult) | null): SketchGeometry {
    const old = new Set(before.constraints.map((c) => c.id));
    const fresh = next.constraints.filter((c) => !old.has(c.id) && isDimension(c) && !c.driven).map((c) => c.id);
    if (!fresh.length) {
        return next;
    }
    const drive = (g: SketchGeometry, ids: Set<string>): SketchGeometry => ({
        ...g,
        constraints: g.constraints.map((c) => (ids.has(c.id) && isDimension(c) ? { ...c, driven: true, value: measure(g, c) ?? c.value } as SketchConstraint : c)),
    });
    if (allDriven) {
        return drive(next, new Set(fresh));
    }
    if (!solve) {
        return next;
    }
    const was = solve(before);
    if (!was.ok) {
        return next;
    }
    const clean = (r: SolveResult) => r.ok && r.redundant.length <= was.redundant.length;
    let out = next;
    let r = solve(out);
    if (clean(r)) {
        return next;
    }
    // The ones the solver names first, then the newest one by one, until the sketch is no more over defined than it was.
    const named = new Set(fresh.filter((id) => r.redundant.includes(id) || r.conflicting.includes(id)));
    if (named.size) {
        out = drive(out, named);
        r = solve(out);
    }
    for (const id of [...fresh].reverse()) {
        if (clean(r)) {
            break;
        }
        if (!named.has(id)) {
            out = drive(out, new Set([id]));
            r = solve(out);
        }
    }
    return clean(r) ? out : next;
}
