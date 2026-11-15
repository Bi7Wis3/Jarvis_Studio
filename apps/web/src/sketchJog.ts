// Jog Line (SolidWorks Tools > Sketch Tools > Jog Line): click a line where the jog starts, move the pointer to set
// the jog's width (along the line) and depth (across it), click again to place it. The jog's sides stay
// perpendicular to the line and its middle parallel; the two pieces of the line stay in line. The width and depth
// stay free, to drag or dimension.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf, pointOf } from './solver';
import { addConstraint, newId, type NewConstraint } from './sketchGeometry';
import type { NewEntity, Pt } from './sketchMath';

interface JogPlan {
    /** Along the line: where the jog starts and ends (0 at a, 1 at b), in order. */
    t1: number;
    t2: number;
    depth: number;
    corners: [Pt, Pt, Pt, Pt];
}

function planOf(g: SketchGeometry, lineId: string, from: Pt, to: Pt): JogPlan | { error: string } {
    const line = curveOf(g, lineId);
    const pa = line?.kind === 'line' ? pointOf(g, line.a) : undefined;
    const pb = line?.kind === 'line' ? pointOf(g, line.b) : undefined;
    if (!pa || !pb) {
        return { error: 'Click a line to jog.' };
    }
    const a: Pt = [pa.u, pa.v];
    const d: Pt = [pb.u - pa.u, pb.v - pa.v];
    const len = Math.hypot(d[0], d[1]);
    if (len < 1e-9) {
        return { error: 'The line has no length.' };
    }
    const u: Pt = [d[0] / len, d[1] / len];
    const n: Pt = [-u[1], u[0]];
    const along = (p: Pt) => ((p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1]) / len;
    const clamp = (t: number) => Math.min(1, Math.max(0, t));
    const [s, e] = [clamp(along(from)), clamp(along(to))];
    const [t1, t2] = s <= e ? [s, e] : [e, s];
    const depth = (to[0] - a[0]) * n[0] + (to[1] - a[1]) * n[1];
    if ((t2 - t1) * len < 1e-6 || t1 * len < 1e-6 || (1 - t2) * len < 1e-6) {
        return { error: 'Move the pointer along the line to give the jog a width, inside the line.' };
    }
    if (Math.abs(depth) < 1e-6) {
        return { error: 'Move the pointer off the line to give the jog a depth.' };
    }
    const on = (t: number): Pt => [a[0] + d[0] * t, a[1] + d[1] * t];
    const up = (p: Pt): Pt => [p[0] + n[0] * depth, p[1] + n[1] * depth];
    const [j1, j2] = [on(t1), on(t2)];
    return { t1, t2, depth, corners: [j1, up(j1), up(j2), j2] };
}

/** The jog as it would be drawn: the three jog lines. */
export function jogPreview(g: SketchGeometry, lineId: string, from: Pt, to: Pt): NewEntity[] {
    const plan = planOf(g, lineId, from, to);
    if ('error' in plan) {
        return [];
    }
    const [j1, k1, k2, j2] = plan.corners;
    return [{ kind: 'line', a: j1, b: k1 }, { kind: 'line', a: k1, b: k2 }, { kind: 'line', a: k2, b: j2 }];
}

/**
 * Jogs `lineId`: it keeps its id up to the jog, a new line goes on after it, and three lines make the jog. Its length,
 * middle and equal length no longer hold and go (`dropped`).
 */
export function jogLine(g: SketchGeometry, lineId: string, from: Pt, to: Pt): { g: SketchGeometry; lines: string[]; dropped: number } | { error: string } {
    const plan = planOf(g, lineId, from, to);
    if ('error' in plan) {
        return plan;
    }
    const line = curveOf(g, lineId) as Extract<SketchCurve, { kind: 'line' }>;
    let out = g;
    const ids: string[] = [];
    for (const p of plan.corners) {
        const id = newId('p', out);
        out = { ...out, points: [...out.points, { id, u: p[0], v: p[1] }] };
        ids.push(id);
    }
    const [j1, k1, k2, j2] = ids;
    const before = out.constraints.length;
    out = { ...out, constraints: out.constraints.filter((k) => !wholeLine(k, lineId)) };
    const dropped = before - out.constraints.length;
    const construction = line.construction ? { construction: true } : {};
    out = { ...out, curves: out.curves.map((c) => (c.id === lineId ? { ...line, b: j1 } : c)) };
    const lines: string[] = [];
    for (const [a, b] of [[j1, k1], [k1, k2], [k2, j2], [j2, line.b]]) {
        const id = newId('c', out);
        out = { ...out, curves: [...out.curves, { id, kind: 'line', a, b, ...construction }] };
        lines.push(id);
    }
    const [side1, top, side2, rest] = lines;
    const relations: NewConstraint[] = [
        { kind: 'pointOnCurve', point: j2, curve: lineId },
        { kind: 'pointOnCurve', point: line.b, curve: lineId },
        { kind: 'perpendicular', a: lineId, b: side1 },
        { kind: 'parallel', a: lineId, b: top },
        { kind: 'perpendicular', a: lineId, b: side2 },
    ];
    out = relations.reduce((x, k) => addConstraint(x, k).g, out);
    return { g: out, lines: [lineId, side1, top, side2, rest], dropped };
}

/** Relations of the whole line that its first piece does not keep. */
function wholeLine(k: SketchConstraint, line: string): boolean {
    return (k.kind === 'length' && k.line === line) || (k.kind === 'midpoint' && k.line === line) || (k.kind === 'equal' && (k.a === line || k.b === line));
}
