// Sketch snapping: where a cursor at raw (u, v) lands, and what the placed point is attached to.
// Order: sketch points, then intersections, midpoints, centres and quadrants, then onto a curve, then alignment
// with the last point or any sketch point, then the grid. All coordinates are sketch (u, v) in mm.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { ORIGIN, pointOf } from './solver';
import type { PointRef } from './sketchGeometry';
import { dist, mid, round, type Pt } from './sketchMath';

export type SnapKind =
    | 'point' | 'centre' | 'mid' | 'quadrant' | 'intersection' | 'curve' | 'horizontal' | 'vertical' | 'aligned' | 'grid' | null;

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
}

/** A curve resolved to coordinates. */
type Shape =
    | { id: string; kind: 'line'; a: Pt; b: Pt }
    | { id: string; kind: 'circle'; c: Pt; r: number; from?: number; sweep?: number };

const TAU = 2 * Math.PI;
const at = (g: SketchGeometry, id: string): Pt | null => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : null;
};

function shapeOf(g: SketchGeometry, c: SketchCurve): Shape | null {
    if (c.kind === 'line') {
        const a = at(g, c.a);
        const b = at(g, c.b);
        return a && b ? { id: c.id, kind: 'line', a, b } : null;
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

/** Where the cursor snaps to. */
export function snapCursor(g: SketchGeometry, raw: Pt, o: SnapOptions): Snap {
    if (!o.enabled) {
        return { p: raw, kind: null, ref: { at: raw }, guides: [], hints: [] };
    }
    const shapes = g.curves.map((c) => shapeOf(g, c)).filter((s): s is Shape => s !== null);
    const centres = new Set(g.curves.flatMap((c) => (c.kind === 'line' ? [] : [c.center])));
    const points: { p: Pt; id: string }[] = [{ p: [0, 0], id: ORIGIN }, ...g.points.filter((p) => p.id !== ORIGIN).map((p) => ({ p: [p.u, p.v] as Pt, id: p.id }))];

    // Lines under the cursor offer their midpoint.
    const over = new Set<string>();
    const hints: Pt[] = [];
    for (const s of shapes) {
        if (s.kind === 'line' && dist(raw, nearestOn(s, raw)!) < o.tolerance * 1.5) {
            over.add(s.id);
            hints.push(mid(s.a, s.b));
        }
    }

    // 1. Existing points win: placing there shares the point.
    let best: { d: number; snap: Snap } | null = null;
    const consider = (p: Pt, kind: SnapKind, ref: PointRef, reach = 1) => {
        const d = dist(raw, p);
        if (d < o.tolerance * reach && (!best || d < best.d - 1e-9)) {
            best = { d, snap: { p, kind, ref, guides: [], hints } };
        }
    };
    for (const { p, id } of points) {
        consider(p, centres.has(id) ? 'centre' : 'point', { at: p, point: id });
    }
    if (best) {
        return (best as { snap: Snap }).snap;
    }

    // 2. Derived points: intersections, line and arc midpoints, circle quadrants.
    for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
            for (const p of intersections(shapes[i], shapes[j])) {
                consider(p, 'intersection', { at: p, onCurves: [shapes[i].id, shapes[j].id] });
            }
        }
    }
    for (const s of shapes) {
        if (s.kind === 'line') {
            const m = mid(s.a, s.b);
            // Along the line the midpoint catches from twice as far.
            consider(m, 'mid', { at: m, midOf: s.id }, over.has(s.id) ? 2 : 1);
            continue;
        }
        if (s.sweep !== undefined && s.from !== undefined) {
            const t = s.from + s.sweep / 2;
            const m: Pt = [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
            consider(m, 'mid', { at: m, onCurves: [s.id] });
        }
        for (let k = 0; k < 4; k++) {
            const t = (k * Math.PI) / 2;
            if (onArc(s, t)) {
                const q: Pt = [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
                consider(q, 'quadrant', { at: q, onCurves: [s.id] });
            }
        }
    }
    if (best) {
        return (best as { snap: Snap }).snap;
    }

    // 3. Onto a curve.
    for (const s of shapes) {
        const p = nearestOn(s, raw);
        if (p) {
            consider(p, 'curve', { at: p, onCurves: [s.id] });
        }
    }
    if (best) {
        return (best as { snap: Snap }).snap;
    }

    // 4. The grid, then alignment per axis: with the last point first (that infers horizontal / vertical),
    // else with the nearest sketch point in line.
    const step = (n: number) => (o.grid > 0 ? round(Math.round(n / o.grid) * o.grid) : n);
    const p: Pt = [step(raw[0]), step(raw[1])];
    let kind: SnapKind = 'grid';
    const guides: Pt[] = [];
    const candidates = [...(o.last ? [o.last] : []), ...points.map((x) => x.p)];
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
        } else if (kind === 'grid') {
            kind = 'aligned';
        }
    }
    return { p, kind, ref: { at: p }, guides, hints };
}
