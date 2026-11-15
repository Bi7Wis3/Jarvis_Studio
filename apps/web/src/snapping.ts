// Sketch snapping: where a cursor at raw (u, v) lands, and what the placed point is attached to.
// Order: sketch points, then intersections, midpoints, centres and quadrants, then onto a curve, then alignment
// with the last point or any sketch point, then the grid. All coordinates are sketch (u, v) in mm.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { ORIGIN, pointOf } from './solver';
import type { PointRef } from './sketchGeometry';
import { dist, entityPoints, mid, round, type Pt } from './sketchMath';
import { curveCentreIds, ellipseOfCurve, isExtra } from './sketchCurves';
import { broughtIn, geometryEntities } from './sketchGeometry';
import { endlessEnds } from './sketchInfinite';
import { ellipseAt } from '@jarvis/core/curves';

export type SnapKind =
    | 'point' | 'centre' | 'mid' | 'quadrant' | 'intersection' | 'curve' | 'horizontal' | 'vertical' | 'aligned' | 'grid'
    | 'tangent' | 'perpendicular' | 'parallel' | 'angle' | 'length' | null;

export interface Snap {
    p: Pt;
    kind: SnapKind;
    ref: PointRef;
    /** Points the cursor is lined up with (drawn as dashed guides). */
    guides: Pt[];
    /** Midpoints of the lines the cursor is over: shown so they can be aimed for, and easier to catch. */
    hints: Pt[];
}

export interface SnapOptions {
    enabled: boolean;
    /** Grid step in mm; 0 for none. */
    grid: number;
    /** Catch distance in mm (a few screen pixels). */
    tolerance: number;
    /** The previous point of the entity being drawn: alignment with it also infers a constraint. */
    last?: Pt;
    /** Quick snaps: a kind set to false is skipped (missing means on). */
    kinds?: Partial<Record<QuickSnap, boolean>>;
    /**
     * The part's other sketches on this plane (see sketchOthers.ts). Their points, midpoints, centres and curves
     * are snapped to like the sketch's own, but a point placed there is not tied to them.
     */
    others?: SketchGeometry;
    /** The point id the entity being drawn goes on from (its last point), for the directions it can take from there. */
    lastPoint?: string;
    /** Lines the pointer passed over lately ("woken" in SolidWorks): a new line can be made parallel or square to them. */
    woken?: string[];
    /** Angle snap step in degrees (System Options > Relations/Snaps > Snap angle); 0 or absent: none. */
    angleStep?: number;
    /** Length snap (Shift held): line lengths in steps of the grid. */
    lengthSnap?: boolean;
    /** A line is being drawn from `last`: the tangent, perpendicular, parallel, angle and length snaps apply. */
    drawsLine?: boolean;
}

/** Marks the id of a curve that belongs to another sketch. */
const OTHER = 'other:';

/** The snap kinds that can be switched off one by one; 'aligned' covers horizontal and vertical too. */
export type QuickSnap = 'point' | 'centre' | 'mid' | 'quadrant' | 'intersection' | 'curve' | 'aligned' | 'grid'
    | 'tangent' | 'perpendicular' | 'parallel' | 'angle' | 'length';

export const QUICK_SNAPS: { kind: QuickSnap; label: string }[] = [
    { kind: 'point', label: 'End points' },
    { kind: 'centre', label: 'Centres' },
    { kind: 'mid', label: 'Midpoints' },
    { kind: 'quadrant', label: 'Quadrants' },
    { kind: 'intersection', label: 'Intersections' },
    { kind: 'curve', label: 'On curve' },
    { kind: 'tangent', label: 'Tangent' },
    { kind: 'perpendicular', label: 'Perpendicular' },
    { kind: 'parallel', label: 'Parallel' },
    { kind: 'aligned', label: 'Alignment guides' },
    { kind: 'length', label: 'Length (hold Shift: steps of the grid)' },
    { kind: 'angle', label: 'Angle (steps of the snap angle)' },
    { kind: 'grid', label: 'Grid' },
];

/** A curve resolved to coordinates. */
type Shape =
    | { id: string; kind: 'line'; a: Pt; b: Pt }
    | { id: string; kind: 'circle'; c: Pt; r: number; from?: number; sweep?: number }
    /** Ellipses, splines, parabolas and conics, as a fine polyline. */
    | { id: string; kind: 'poly'; points: Pt[] };

const TAU = 2 * Math.PI;
const at = (g: SketchGeometry, id: string): Pt | null => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : null;
};

function shapeOf(g: SketchGeometry, c: SketchCurve): Shape | null {
    if (isExtra(c)) {
        const e = geometryEntities({ ...g, curves: [c] })[0];
        return e ? { id: c.id, kind: 'poly', points: entityPoints(e) } : null;
    }
    if (c.kind === 'line') {
        const a = at(g, c.a);
        const b = at(g, c.b);
        // An infinite line snaps along its whole reach.
        const ends = a && b ? endlessEnds(a, b, c.endless) : null;
        return ends ? { id: c.id, kind: 'line', a: ends[0], b: ends[1] } : null;
    }
    const centre = at(g, c.center);
    if (!centre) {
        return null;
    }
    if (c.kind === 'circle') {
        return { id: c.id, kind: 'circle', c: centre, r: c.radius };
    }
    const s = at(g, c.start);
    const e = at(g, c.end);
    if (!s || !e) {
        return null;
    }
    const from = Math.atan2(s[1] - centre[1], s[0] - centre[0]);
    const to = Math.atan2(e[1] - centre[1], e[0] - centre[0]);
    return { id: c.id, kind: 'circle', c: centre, r: dist(s, centre), from, sweep: ((to - from) % TAU + TAU) % TAU || TAU };
}

/** Whether angle t lies on the (counter-clockwise) arc, or anywhere on a full circle. */
function onArc(s: Extract<Shape, { kind: 'circle' }>, t: number): boolean {
    if (s.from === undefined || s.sweep === undefined) {
        return true;
    }
    return ((t - s.from) % TAU + TAU) % TAU <= s.sweep + 1e-9;
}

/** Nearest point of the curve to p, or null when the nearest is off the end of an arc. */
function nearestOn(s: Shape, p: Pt): Pt | null {
    if (s.kind === 'poly') {
        let best: { d: number; q: Pt } | null = null;
        for (let i = 1; i < s.points.length; i++) {
            const q = nearestOn({ id: '', kind: 'line', a: s.points[i - 1], b: s.points[i] }, p)!;
            const d = dist(p, q);
            if (!best || d < best.d) {
                best = { d, q };
            }
        }
        return best?.q ?? null;
    }
    if (s.kind === 'line') {
        const d: Pt = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
        const l2 = d[0] * d[0] + d[1] * d[1];
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]) / l2)) : 0;
        return [s.a[0] + d[0] * t, s.a[1] + d[1] * t];
    }
    const t = Math.atan2(p[1] - s.c[1], p[0] - s.c[0]);
    return onArc(s, t) ? [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)] : null;
}

/** Points where two curves cross. */
export function intersections(a: Shape, b: Shape): Pt[] {
    if (a.kind === 'poly' || b.kind === 'poly') {
        // Piece by piece along the polyline(s), without repeats where two pieces meet.
        const pieces = (s: Shape): Shape[] => (s.kind === 'poly'
            ? s.points.slice(1).map((q, i): Shape => ({ id: s.id, kind: 'line', a: s.points[i], b: q })) : [s]);
        const out: Pt[] = [];
        for (const x of pieces(a)) {
            for (const y of pieces(b)) {
                for (const p of intersections(x, y)) {
                    if (!out.some((q) => dist(p, q) < 1e-6)) {
                        out.push(p);
                    }
                }
            }
        }
        return out;
    }
    if (a.kind === 'line' && b.kind === 'line') {
        const r: Pt = [a.b[0] - a.a[0], a.b[1] - a.a[1]];
        const s: Pt = [b.b[0] - b.a[0], b.b[1] - b.a[1]];
        const den = r[0] * s[1] - r[1] * s[0];
        if (Math.abs(den) < 1e-12) {
            return [];
        }
        const q: Pt = [b.a[0] - a.a[0], b.a[1] - a.a[1]];
        const t = (q[0] * s[1] - q[1] * s[0]) / den;
        const u = (q[0] * r[1] - q[1] * r[0]) / den;
        const eps = 1e-9;
        return t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps ? [[a.a[0] + r[0] * t, a.a[1] + r[1] * t]] : [];
    }
    if (a.kind === 'circle' && b.kind === 'line') {
        return intersections(b, a);
    }
    if (a.kind === 'line' && b.kind === 'circle') {
        const d: Pt = [a.b[0] - a.a[0], a.b[1] - a.a[1]];
        const f: Pt = [a.a[0] - b.c[0], a.a[1] - b.c[1]];
        const A = d[0] * d[0] + d[1] * d[1];
        const B = 2 * (f[0] * d[0] + f[1] * d[1]);
        const C = f[0] * f[0] + f[1] * f[1] - b.r * b.r;
        const disc = B * B - 4 * A * C;
        if (A === 0 || disc < 0) {
            return [];
        }
        const root = Math.sqrt(disc);
        const ts = disc === 0 ? [-B / (2 * A)] : [(-B - root) / (2 * A), (-B + root) / (2 * A)];
        return ts
            .filter((t) => t >= -1e-9 && t <= 1 + 1e-9)
            .map((t): Pt => [a.a[0] + d[0] * t, a.a[1] + d[1] * t])
            .filter((p) => onArc(b, Math.atan2(p[1] - b.c[1], p[0] - b.c[0])));
    }
    if (a.kind === 'circle' && b.kind === 'circle') {
        const d = dist(a.c, b.c);
        if (d < 1e-12 || d > a.r + b.r || d < Math.abs(a.r - b.r)) {
            return [];
        }
        const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
        const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
        const e: Pt = [(b.c[0] - a.c[0]) / d, (b.c[1] - a.c[1]) / d];
        const base: Pt = [a.c[0] + e[0] * x, a.c[1] + e[1] * x];
        const points: Pt[] = h < 1e-12 ? [base] : [[base[0] - e[1] * h, base[1] + e[0] * h], [base[0] + e[1] * h, base[1] - e[0] * h]];
        return points.filter((p) => onArc(a, Math.atan2(p[1] - a.c[1], p[0] - a.c[0])) && onArc(b, Math.atan2(p[1] - b.c[1], p[0] - b.c[0])));
    }
    return [];
}

// The curves as shapes, and where the sketch's own curves cross, do not change while the pointer moves: they are
// worked out once per geometry (the crossings are a pass over every pair of curves).
const shapesMemo = new WeakMap<SketchGeometry, Shape[]>();
const outsideMemo = new WeakMap<SketchGeometry, Shape[]>();
const crossingsMemo = new WeakMap<SketchGeometry, { p: Pt; on: [string, string] }[]>();

function shapesOf(g: SketchGeometry): Shape[] {
    let shapes = shapesMemo.get(g);
    if (!shapes) {
        shapes = g.curves.map((c) => shapeOf(g, c)).filter((s): s is Shape => s !== null);
        shapesMemo.set(g, shapes);
    }
    return shapes;
}

/** The curves of other sketches, their ids marked as such. */
function outsideOf(others: SketchGeometry): Shape[] {
    let shapes = outsideMemo.get(others);
    if (!shapes) {
        shapes = shapesOf(others).map((s) => ({ ...s, id: OTHER + s.id }));
        outsideMemo.set(others, shapes);
    }
    return shapes;
}

/** Where each pair of the sketch's own curves crosses, pair by pair in curve order. */
function crossingsOf(g: SketchGeometry): { p: Pt; on: [string, string] }[] {
    let out = crossingsMemo.get(g);
    if (!out) {
        const shapes = shapesOf(g);
        out = [];
        for (let i = 0; i < shapes.length; i++) {
            for (let j = i + 1; j < shapes.length; j++) {
                for (const p of intersections(shapes[i], shapes[j])) {
                    out.push({ p, on: [shapes[i].id, shapes[j].id] });
                }
            }
        }
        crossingsMemo.set(g, out);
    }
    return out;
}

/** Where the cursor snaps to. */
export function snapCursor(g: SketchGeometry, raw: Pt, o: SnapOptions): Snap {
    if (!o.enabled) {
        return { p: raw, kind: null, ref: { at: raw }, guides: [], hints: [] };
    }
    const shapes = shapesOf(g);
    const outside = o.others ? outsideOf(o.others) : [];
    const all = [...shapes, ...outside];
    const outsideCentres = new Set((o.others?.curves ?? []).flatMap((c) => curveCentreIds(c)));
    const outsidePoints = (o.others?.points ?? []).map((p) => ({ p: [p.u, p.v] as Pt, id: p.id }));
    /** What a point placed at p is attached to: nothing when a curve of another sketch is involved. */
    const tie = (p: Pt, extra: Omit<PointRef, 'at'>, ...ids: string[]): PointRef => (ids.some((id) => id.startsWith(OTHER)) ? { at: p } : { at: p, ...extra });
    const centres = new Set(g.curves.flatMap(curveCentreIds));
    const hidden = broughtIn(g).handles;
    const points: { p: Pt; id: string }[] = [{ p: [0, 0], id: ORIGIN }, ...g.points.filter((p) => p.id !== ORIGIN && !hidden.has(p.id)).map((p) => ({ p: [p.u, p.v] as Pt, id: p.id }))];

    const on = (kind: QuickSnap) => o.kinds?.[kind] !== false;

    // Lines under the cursor offer their midpoint.
    const over = new Set<string>();
    const hints: Pt[] = [];
    for (const s of all) {
        // An infinite line has no middle.
        const endless = g.curves.some((c) => c.id === s.id && c.kind === 'line' && !!c.endless);
        if (on('mid') && s.kind === 'line' && !endless && dist(raw, nearestOn(s, raw)!) < o.tolerance * 1.5) {
            over.add(s.id);
            hints.push(mid(s.a, s.b));
        }
    }

    // 1. Existing points win: placing there shares the point.
    let best: { d: number; snap: Snap } | null = null;
    // `ref` may be given as a function: what the point is attached to is only worked out for a point within reach.
    const consider = (p: Pt, kind: SnapKind, ref: PointRef | (() => PointRef), reach = 1) => {
        if (!on(kind as QuickSnap)) {
            return;
        }
        const d = dist(raw, p);
        if (d < o.tolerance * reach && (!best || d < best.d - 1e-9)) {
            best = { d, snap: { p, kind, ref: typeof ref === 'function' ? ref() : ref, guides: [], hints } };
        }
    };
    for (const { p, id } of points) {
        consider(p, centres.has(id) ? 'centre' : 'point', { at: p, point: id });
    }
    // A point of the sketch itself wins over one of another sketch at the same spot.
    for (const { p, id } of outsidePoints) {
        consider(p, outsideCentres.has(id) ? 'centre' : 'point', { at: p });
    }
    if (best) {
        return (best as { snap: Snap }).snap;
    }

    // 2. Derived points: intersections, line and arc midpoints, circle quadrants.
    for (const x of crossingsOf(g)) {
        // Only those within reach can be taken (the test consider makes first).
        if (dist(raw, x.p) < o.tolerance) {
            const p: Pt = [x.p[0], x.p[1]];
            consider(p, 'intersection', { at: p, onCurves: [x.on[0], x.on[1]] });
        }
    }
    // Crossings with or between the other sketches' curves: only those the cursor is near, there can be many.
    const reach = (s: Shape) => {
        const p = nearestOn(s, raw);
        return p !== null && dist(raw, p) < o.tolerance * 2;
    };
    const nearOutside = outside.filter(reach);
    const nearAll = nearOutside.length ? [...shapes.filter(reach), ...nearOutside] : [];
    for (let i = 0; i < nearOutside.length; i++) {
        for (const other of nearAll) {
            if (other !== nearOutside[i] && (!other.id.startsWith(OTHER) || nearOutside.indexOf(other) > i)) {
                for (const p of intersections(nearOutside[i], other)) {
                    consider(p, 'intersection', { at: p });
                }
            }
        }
    }
    for (const c of g.curves) {
        // The ellipse's quadrants: the two axis ends that are not points of their own.
        const e = (c.kind === 'ellipse' || c.kind === 'ellipseArc') ? ellipseOfCurve(g, c) : null;
        if (e && c.kind === 'ellipse') {
            for (let k = 0; k < 4; k++) {
                const q = ellipseAt(e, (k * Math.PI) / 2);
                consider(q, 'quadrant', { at: q, onCurves: [c.id] });
            }
        }
    }
    for (const s of all) {
        if (s.kind === 'poly') {
            continue;
        }
        if (s.kind === 'line') {
            const m = mid(s.a, s.b);

            // Along the line the midpoint catches from twice as far (an infinite line has none).
            if (!g.curves.some((c) => c.id === s.id && c.kind === 'line' && !!c.endless)) {
                consider(m, 'mid', () => tie(m, { midOf: s.id }, s.id), over.has(s.id) ? 2 : 1);
            }
            continue;
        }
        if (s.sweep !== undefined && s.from !== undefined) {
            const t = s.from + s.sweep / 2;
            const m: Pt = [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
            consider(m, 'mid', () => tie(m, { onCurves: [s.id] }, s.id));
        }
        for (let k = 0; k < 4; k++) {
            const t = (k * Math.PI) / 2;
            if (onArc(s, t)) {
                const q: Pt = [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
                consider(q, 'quadrant', () => tie(q, { onCurves: [s.id] }, s.id));
            }
        }
    }
    // From the last point: where a line would touch a circle or arc (tangent), or meet a line square (perpendicular).
    if (o.last && o.drawsLine) {
        const last = o.last;
        for (const s of all) {
            if (s.kind === 'circle') {
                for (const q of tangentPoints(last, s)) {
                    consider(q, 'tangent', () => tie(q, { onCurves: [s.id], infer: { kind: 'tangent', to: s.id } }, s.id));
                }
            } else if (s.kind === 'line') {
                const d: Pt = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
                const l2 = d[0] * d[0] + d[1] * d[1];
                const t = l2 > 0 ? ((last[0] - s.a[0]) * d[0] + (last[1] - s.a[1]) * d[1]) / l2 : -1;
                const foot: Pt = [s.a[0] + d[0] * t, s.a[1] + d[1] * t];
                if (t > 1e-6 && t < 1 - 1e-6 && dist(foot, last) > 1e-6) {
                    consider(foot, 'perpendicular', () => tie(foot, { onCurves: [s.id], infer: { kind: 'perpendicular', to: s.id } }, s.id));
                }
            }
        }
    }
    if (best) {
        return (best as { snap: Snap }).snap;
    }

    // 3. Onto a curve.
    for (const s of all) {
        const p = nearestOn(s, raw);
        if (p) {
            consider(p, 'curve', () => tie(p, { onCurves: [s.id] }, s.id));
        }
    }
    if (best) {
        return (best as { snap: Snap }).snap;
    }

    // 4. The grid, then alignment per axis: with the last point first (that infers horizontal / vertical),
    // else with the nearest sketch point in line.
    const step = (n: number) => (o.grid > 0 ? round(Math.round(n / o.grid) * o.grid) : n);
    const p: Pt = on('grid') ? [step(raw[0]), step(raw[1])] : [raw[0], raw[1]];
    let kind: SnapKind = on('grid') ? 'grid' : null;
    const guides: Pt[] = [];
    const candidates = on('aligned') ? [...(o.last ? [o.last] : []), ...points.map((x) => x.p), ...outsidePoints.map((x) => x.p)] : [];
    for (const axis of [0, 1] as const) {
        let near: { d: number; q: Pt } | null = null;
        for (const q of candidates) {
            const d = Math.abs(raw[axis] - q[axis]);
            if (d < o.tolerance && (!near || d < near.d - 1e-9)) {
                near = { d, q };
            }
        }
        if (!near) {
            continue;
        }
        const q = (near as { q: Pt }).q;
        p[axis] = q[axis];
        guides.push(q);
        const withLast = o.last !== undefined && q === o.last;
        // Same u as the last point: a vertical line; same v: horizontal. The last point's alignment wins the label.
        if (withLast && kind !== 'vertical' && kind !== 'horizontal') {
            kind = axis === 0 ? 'vertical' : 'horizontal';
        } else if (kind === 'grid' || kind === null) {
            kind = 'aligned';
        }
    }
    let out: Snap = { p, kind, ref: { at: p }, guides, hints };
    if (!o.last || !o.drawsLine) {
        return out;
    }
    // 5. Directions from the last point: parallel or square to a line, tangent off an arc's end, or an angle step.
    const last = o.last;
    const level = kind === 'horizontal' || kind === 'vertical' ? Math.abs(raw[kind === 'horizontal' ? 1 : 0] - last[kind === 'horizontal' ? 1 : 0]) : Infinity;
    const turn = directionSnap(g, raw, last, o, on);
    if (turn && turn.off < level) {
        out = { p: turn.p, kind: turn.kind, ref: { at: turn.p, infer: { kind: turn.kind, to: turn.to } }, guides: [], hints };
    } else if (level === Infinity && on('angle') && (o.angleStep ?? 0) > 0) {
        const v: Pt = [raw[0] - last[0], raw[1] - last[1]];
        const r = Math.hypot(v[0], v[1]);
        const step = ((o.angleStep ?? 0) * Math.PI) / 180;
        const a = Math.round(Math.atan2(v[1], v[0]) / step) * step;
        const q: Pt = [last[0] + r * Math.cos(a), last[1] + r * Math.sin(a)];
        if (r > o.tolerance * 2 && dist(q, raw) < o.tolerance) {
            out = { p: q, kind: 'angle', ref: { at: q }, guides: [], hints };
        }
    }
    // Length snap (Shift held): the line's length in whole grid steps, along the direction found.
    if (o.lengthSnap && on('length') && o.grid > 0) {
        const v: Pt = [out.p[0] - last[0], out.p[1] - last[1]];
        const r = Math.hypot(v[0], v[1]);
        const n = Math.round(r / o.grid) * o.grid;
        if (r > 1e-9 && n > 0) {
            const q: Pt = [last[0] + (v[0] / r) * n, last[1] + (v[1] / r) * n];
            out = { ...out, p: q, kind: out.kind === 'grid' || out.kind === 'aligned' || out.kind === null ? 'length' : out.kind, ref: { ...out.ref, at: q } };
        }
    }
    return out;
}

/** The points where a line from `from` touches the circle or arc. */
function tangentPoints(from: Pt, s: Extract<Shape, { kind: 'circle' }>): Pt[] {
    const d = dist(from, s.c);
    if (d <= s.r + 1e-9) {
        return [];
    }
    const base = Math.atan2(from[1] - s.c[1], from[0] - s.c[0]);
    const spread = Math.acos(s.r / d);
    return [base + spread, base - spread]
        .filter((t) => onArc(s, t))
        .map((t): Pt => [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]);
}

/**
 * Inferred directions for a line from `last`: square to a line ending there or woken, parallel to a woken line,
 * tangent to an arc ending there. The nearest within reach of the cursor wins.
 */
function directionSnap(g: SketchGeometry, raw: Pt, last: Pt, o: SnapOptions, on: (k: QuickSnap) => boolean):
    { p: Pt; kind: 'parallel' | 'perpendicular' | 'tangent'; to: string; off: number } | null {
    const v: Pt = [raw[0] - last[0], raw[1] - last[1]];
    if (Math.hypot(v[0], v[1]) < o.tolerance * 2) {
        return null;
    }
    const candidates: { d: Pt; kind: 'parallel' | 'perpendicular' | 'tangent'; to: string }[] = [];
    const lineDir = (id: string): Pt | null => {
        const c = g.curves.find((k) => k.id === id);
        const [a, b] = c?.kind === 'line' ? [pointOf(g, c.a), pointOf(g, c.b)] : [];
        const l = a && b ? Math.hypot(b.u - a.u, b.v - a.v) : 0;
        return a && b && l > 1e-9 ? [(b.u - a.u) / l, (b.v - a.v) / l] : null;
    };
    const attached = o.lastPoint ? g.curves.filter((c) => (c.kind === 'line' && (c.a === o.lastPoint || c.b === o.lastPoint))
        || (c.kind === 'arc' && (c.start === o.lastPoint || c.end === o.lastPoint))) : [];
    for (const c of attached) {
        if (c.kind === 'line') {
            const d = lineDir(c.id);
            if (d && on('perpendicular')) {
                candidates.push({ d: [-d[1], d[0]], kind: 'perpendicular', to: c.id });
            }
        } else if (c.kind === 'arc' && on('tangent')) {
            const m = pointOf(g, c.center);
            if (m) {
                const r: Pt = [last[0] - m.u, last[1] - m.v];
                const l = Math.hypot(r[0], r[1]);
                if (l > 1e-9) {
                    candidates.push({ d: [-r[1] / l, r[0] / l], kind: 'tangent', to: c.id });
                }
            }
        }
    }
    for (const id of o.woken ?? []) {
        const d = lineDir(id);
        if (!d || attached.some((c) => c.id === id)) {
            continue;
        }
        if (on('parallel')) {
            candidates.push({ d, kind: 'parallel', to: id });
        }
        if (on('perpendicular')) {
            candidates.push({ d: [-d[1], d[0]], kind: 'perpendicular', to: id });
        }
    }
    let best: { p: Pt; kind: 'parallel' | 'perpendicular' | 'tangent'; to: string; off: number } | null = null;
    for (const c of candidates) {
        // Either way along the direction.
        const t = v[0] * c.d[0] + v[1] * c.d[1];
        const off = Math.abs(v[0] * c.d[1] - v[1] * c.d[0]);
        // Directions that are level or upright are the horizontal and vertical inference's.
        const axisLike = on('aligned') && (Math.abs(c.d[0]) < 1e-9 || Math.abs(c.d[1]) < 1e-9);
        if (off < o.tolerance && !axisLike && (!best || off < best.off)) {
            best = { p: [last[0] + c.d[0] * t, last[1] + c.d[1] * t], kind: c.kind, to: c.to, off };
        }
    }
    return best;
}
