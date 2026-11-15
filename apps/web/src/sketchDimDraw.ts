// Drawing of the dimension kinds beyond length, distance, angle, radius and diameter: arc length, the angle at a
// point, and distances to midpoints, to the near or far side of arcs and circles, and doubled across a centreline.
// Kept apart from SketchDrawing.tsx, which calls these first.

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, curveOf, distancePoints, handleEnd, pointOf } from './solver';
import { ordinateFoot, ordinateFrame } from './sketchDimGroups';
import { angleText, shownText } from './numberText';
import { arcMiddle } from './sketchGeometry';
import { dist, type Pt } from './sketchMath';
import { conicAt } from '@jarvis/core/curves';
import { splineLengthAnchor, splineLengthLeader } from './sketchSplineLength';

type V3 = [number, number, number];
const v3 = ([u, v]: Pt): V3 => [u, v, 0];

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

function arrow(tip: Pt, dir: Pt, size: number): V3[][] {
    const back: Pt = [tip[0] - dir[0] * size, tip[1] - dir[1] * size];
    const n: Pt = [-dir[1] * size * 0.35, dir[0] * size * 0.35];
    return [[v3([back[0] + n[0], back[1] + n[1]]), v3(tip), v3([back[0] - n[0], back[1] - n[1]])]];
}

/** A linear dimension between a and b with its line through `at` (along an axis, or square to a-b). */
export function linearLines(a: Pt, b: Pt, at: Pt, size: number, axis?: 'u' | 'v'): V3[][] {
    let p: Pt;
    let q: Pt;
    if (axis === 'u') {
        p = [a[0], at[1]];
        q = [b[0], at[1]];
    } else if (axis === 'v') {
        p = [at[0], a[1]];
        q = [at[0], b[1]];
    } else {
        const l = dist(a, b) || 1;
        const n: Pt = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
        const d = (at[0] - a[0]) * n[0] + (at[1] - a[1]) * n[1];
        p = [a[0] + n[0] * d, a[1] + n[1] * d];
        q = [b[0] + n[0] * d, b[1] + n[1] * d];
    }
    const l = dist(p, q) || 1;
    const dir: Pt = [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
    return [[v3(a), v3(p)], [v3(b), v3(q)], [v3(p), v3(q)], ...arrow(q, dir, size), ...arrow(p, [-dir[0], -dir[1]], size)];
}

/** An arc of radius `radius` about o from angle a0 to a1 (the shorter way), with rays out to it. */
function angleArc(o: Pt, a0: number, a1: number, radius: number, size: number): V3[][] {
    let end = a1;
    while (end - a0 > Math.PI) {
        end -= 2 * Math.PI;
    }
    while (a0 - end > Math.PI) {
        end += 2 * Math.PI;
    }
    const arc: V3[] = [];
    for (let i = 0; i <= 24; i++) {
        const a = a0 + ((end - a0) * i) / 24;
        arc.push(v3([o[0] + radius * Math.cos(a), o[1] + radius * Math.sin(a)]));
    }
    const ray = (a: number): V3[] => [v3(o), v3([o[0] + (radius + size) * Math.cos(a), o[1] + (radius + size) * Math.sin(a)])];
    return [arc, ray(a0), ray(end)];
}

/** Leader lines of the further dimension kinds; null for the others (SketchDrawing draws those). */
export function moreDimensionLines(g: SketchGeometry, c: SketchConstraint, at: Pt, size: number): V3[][] | null {
    // A spline's length: a leader from the label to the spline (sketchSplineLength.ts).
    const leader = splineLengthLeader(g, c, at);
    if (leader) {
        return [leader.map((p) => v3(p))];
    }
    if (c.kind === 'arcLength') {
        const arc = curveOf(g, c.curve);
        if (arc?.kind !== 'arc') {
            return [];
        }
        const [m, s, e] = [P(g, arc.center), P(g, arc.start), P(g, arc.end)];
        // A concentric arc through the label, with extension lines out from the arc's ends.
        const r = Math.max(dist(m, at), size);
        const a0 = Math.atan2(s[1] - m[1], s[0] - m[0]);
        let a1 = Math.atan2(e[1] - m[1], e[0] - m[0]);
        while (a1 <= a0) {
            a1 += 2 * Math.PI;
        }
        const line: V3[] = [];
        for (let i = 0; i <= 32; i++) {
            const a = a0 + ((a1 - a0) * i) / 32;
            line.push(v3([m[0] + r * Math.cos(a), m[1] + r * Math.sin(a)]));
        }
        const out = (a: number): Pt => [m[0] + r * Math.cos(a), m[1] + r * Math.sin(a)];
        const tangent = (a: number, sign: number): Pt => [-Math.sin(a) * sign, Math.cos(a) * sign];
        return [line, [v3(s), v3(out(a0))], [v3(e), v3(out(a1))], ...arrow(out(a1), tangent(a1, 1), size), ...arrow(out(a0), tangent(a0, -1), size)];
    }
    if (c.kind === 'pointAngle' && c.running && !c.bidirectional) {
        // Angular running: along the ring anticlockwise from the zero to the point, with an extension line out to it.
        const [o, a, b] = [P(g, c.vertex), P(g, c.a), P(g, c.b)];
        const radius = Math.max(dist(o, at), size * 2);
        const a0 = Math.atan2(a[1] - o[1], a[0] - o[0]);
        let a1 = Math.atan2(b[1] - o[1], b[0] - o[0]);
        while (a1 < a0) {
            a1 += 2 * Math.PI;
        }
        const ring: V3[] = [];
        const steps = Math.max(8, Math.ceil(((a1 - a0) * 48) / (2 * Math.PI)));
        for (let i = 0; i <= steps; i++) {
            const t = a0 + ((a1 - a0) * i) / steps;
            ring.push(v3([o[0] + radius * Math.cos(t), o[1] + radius * Math.sin(t)]));
        }
        const tip: Pt = [o[0] + radius * Math.cos(a1), o[1] + radius * Math.sin(a1)];
        const out: Pt = [o[0] + (radius + size) * Math.cos(a1), o[1] + (radius + size) * Math.sin(a1)];
        return [ring, [v3(b), v3(out)], ...arrow(tip, [-Math.sin(a1), Math.cos(a1)], size)];
    }
    if (c.kind === 'angle' && (handleEnd(g, c.a) || handleEnd(g, c.b))) {
        return handleAngleLines(g, c, at, size);
    }
    if (c.kind === 'pointAngle') {
        const [o, a, b] = [P(g, c.vertex), P(g, c.a), P(g, c.b)];
        const radius = Math.max(dist(o, at), size * 2);
        const lines = angleArc(o, Math.atan2(a[1] - o[1], a[0] - o[0]), Math.atan2(b[1] - o[1], b[0] - o[0]), radius, size);
        return [[v3(o), v3(a)], [v3(o), v3(b)], ...lines];
    }
    if (c.kind === 'rho') {
        // A leader from the label to the conic's shoulder.
        const h = shoulderOf(g, c.curve);
        return h ? [[v3(at), v3(h)], ...arrow(h, unitOr([h[0] - at[0], h[1] - at[1]]), size)] : [];
    }
    if (c.kind === 'pathLength') {
        // A leader from the label to the middle of the chain.
        const mid = chainMiddle(g, c.curves);
        return mid ? [[v3(at), v3(mid)], ...arrow(mid, unitOr([mid[0] - at[0], mid[1] - at[1]]), size)] : [];
    }
    if (c.kind === 'distance' && c.ordinate) {
        const f = ordinateFrame(g, c);
        // From the point along the leader direction to the row through the label, then a jog to the label (the zero
        // dimension of the row draws the zero's leader; see sketchDimExtrasDrawing.tsx).
        return f ? [[v3(f.point), v3(ordinateFoot(f, f.point, at)), v3(at)]] : [];
    }
    const ends = distancePoints(g, c);
    if (!ends) {
        return null;
    }
    return linearLines(ends[0], ends[1], at, size, c.kind === 'distance' ? c.axis : undefined);
}

/** An angle between a spline's tangency handle and a line (or two handles): an arc at the spline's end. */
function handleAngleLines(g: SketchGeometry, c: Extract<SketchConstraint, { kind: 'angle' }>, at: Pt, size: number): V3[][] {
    const along = (id: string): { from: Pt; dir: Pt } | null => {
        const end = handleEnd(g, id);
        if (end) {
            const [p, q] = [P(g, end), P(g, id)];
            return { from: p, dir: unitOr([q[0] - p[0], q[1] - p[1]]) };
        }
        if (id === AXIS_U || id === AXIS_V) {
            return { from: [0, 0], dir: id === AXIS_U ? [1, 0] : [0, 1] };
        }
        const line = curveOf(g, id);
        if (line?.kind !== 'line') {
            return null;
        }
        const [p, q] = [P(g, line.a), P(g, line.b)];
        return { from: p, dir: unitOr([q[0] - p[0], q[1] - p[1]]) };
    };
    const [da, db] = [along(c.a), along(c.b)];
    if (!da || !db) {
        return [];
    }
    const o = handleEnd(g, c.a) ? da.from : db.from;
    const radius = Math.max(dist(o, at), size * 2);
    const label = Math.atan2(at[1] - o[1], at[0] - o[0]);
    // A handle has a direction; a line either way, on the label's side.
    const angleOf = (d: { dir: Pt }, id: string) => {
        const t = Math.atan2(d.dir[1], d.dir[0]);
        return handleEnd(g, id) || Math.cos(t - label) >= 0 ? t : t + Math.PI;
    };
    return [[v3(o), v3([o[0] + db.dir[0] * radius, o[1] + db.dir[1] * radius])], ...angleArc(o, angleOf(da, c.a), angleOf(db, c.b), radius, size)];
}

/** The shoulder of a conic (its point at the middle parameter, where Rho is measured). */
function shoulderOf(g: SketchGeometry, id: string): Pt | null {
    const c = curveOf(g, id);
    return c?.kind === 'conic' && pointOf(g, c.start) && pointOf(g, c.end) && pointOf(g, c.apex)
        ? conicAt(P(g, c.start), P(g, c.apex), P(g, c.end), c.rho, 0.5) : null;
}

const unitOr = (d: Pt): Pt => {
    const l = Math.hypot(d[0], d[1]);
    return l > 1e-12 ? [d[0] / l, d[1] / l] : [1, 0];
};

/** The middle of a chain of curves: the middle of its middle curve. */
function chainMiddle(g: SketchGeometry, curves: string[]): Pt | null {
    const c = curveOf(g, curves[Math.floor(curves.length / 2)] ?? '');
    if (c?.kind === 'line') {
        const [a, b] = [P(g, c.a), P(g, c.b)];
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
    if (c?.kind === 'arc') {
        return arcMiddle(P(g, c.center), P(g, c.start), P(g, c.end));
    }
    return null;
}

/** The label text of the further kinds (and of doubled distances, shown as a diameter); null for the others. */
export function moreDimensionText(c: SketchConstraint): string | null {
    if (c.kind === 'arcLength') {
        return `⌒${shownText(c.value)}`;
    }
    if (c.kind === 'pointAngle') {
        return angleText(c.value);
    }
    if (c.kind === 'distance' && c.doubled) {
        return `Ø${shownText(c.value)}`;
    }
    if (c.kind === 'pathLength') {
        return `Path ${shownText(c.value)}`;
    }
    if (c.kind === 'rho') {
        return `Rho ${shownText(c.value)}`;
    }
    return null;
}

/** Where the line and arc midpoints among these pick ids (`mid:<curve>`) are, to mark them while dimensioning. */
export function midMarkers(g: SketchGeometry, ids: Iterable<string>): Pt[] {
    const out: Pt[] = [];
    for (const id of ids) {
        const line = id.startsWith('mid:') ? curveOf(g, id.slice(4)) : undefined;
        if (line?.kind === 'arc') {
            out.push(arcMiddle(P(g, line.center), P(g, line.start), P(g, line.end)));
        } else if (line?.kind === 'line') {
            const [a, b] = [P(g, line.a), P(g, line.b)];
            out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        }
    }
    return out;
}

/** Default place for the label of the further kinds; null for the others. */
export function moreDimensionAnchor(g: SketchGeometry, c: SketchConstraint): Pt | null {
    const spline = splineLengthAnchor(g, c);
    if (spline) {
        return spline;
    }
    if (c.kind === 'arcLength') {
        const arc = curveOf(g, c.curve);
        if (arc?.kind !== 'arc') {
            return [0, 0];
        }
        const m = P(g, arc.center);
        const mid = arcMiddle(m, P(g, arc.start), P(g, arc.end));
        return [m[0] + (mid[0] - m[0]) * 1.25, m[1] + (mid[1] - m[1]) * 1.25];
    }
    if (c.kind === 'pointAngle') {
        const [o, a, b] = [P(g, c.vertex), P(g, c.a), P(g, c.b)];
        const r = Math.max(4, Math.min(dist(o, a), dist(o, b)) * 0.4);
        const da = Math.atan2(a[1] - o[1], a[0] - o[0]);
        const db = Math.atan2(b[1] - o[1], b[0] - o[0]);
        const mid = da + Math.atan2(Math.sin(db - da), Math.cos(db - da)) / 2;
        return [o[0] + r * Math.cos(mid), o[1] + r * Math.sin(mid)];
    }
    if (c.kind === 'pathLength') {
        const mid = chainMiddle(g, c.curves);
        return mid ? [mid[0] + 5, mid[1] + 5] : [0, 0];
    }
    if (c.kind === 'rho') {
        // Beyond the shoulder, away from the top vertex.
        const conic = curveOf(g, c.curve);
        const h = shoulderOf(g, c.curve);
        if (!h || conic?.kind !== 'conic') {
            return [0, 0];
        }
        const t = P(g, conic.apex);
        const d = unitOr([h[0] - t[0], h[1] - t[1]]);
        return [h[0] + d[0] * 6, h[1] + d[1] * 6];
    }
    const ends = distancePoints(g, c);
    return ends ? [(ends[0][0] + ends[1][0]) / 2 + 3, (ends[0][1] + ends[1][1]) / 2 + 3] : null;
}
