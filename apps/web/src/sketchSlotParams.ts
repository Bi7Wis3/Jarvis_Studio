// The Parameters of a slot (SolidWorks Slot PropertyManager): centre X and Y, width and length of every slot, and the
// radius and angle of an arc slot. Read from the slot's curves, and changed by placing all its points again (its own
// relations hold the shape; the sketcher's solve checks that nothing else holds the values).

import type { SketchGeometry } from '@jarvis/core';
import { curveOf, curveRadius, pointOf } from './solver';
import { arcSlotOf, slotOf, type ArcSlot, type Slot } from './sketchSlots';
import { curvePointIds } from './sketchCurves';
import { addConstraint, newId, removeItems } from './sketchGeometry';

type Pt = [number, number];

export type SlotFound = { kind: 'straight'; slot: Slot } | { kind: 'arc'; slot: ArcSlot };

export interface SlotParams {
    cx: number;
    cy: number;
    width: number;
    /** Straight: centre to centre, or overall; arc: along the arc from end centre to end centre. */
    length: number;
    /** Arc slots: the arc's radius and the angle it sweeps (degrees). */
    radius?: number;
    angle?: number;
}

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};
const TAU = 2 * Math.PI;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
const deg = (r: number) => (r * 180) / Math.PI;

/** The first slot (straight or arc) any of these curves belongs to. */
export function slotAmong(g: SketchGeometry, curves: string[]): SlotFound | null {
    for (const id of curves) {
        const straight = slotOf(g, id);
        if (straight) {
            return { kind: 'straight', slot: straight };
        }
        const arc = arcSlotOf(g, id);
        if (arc) {
            return { kind: 'arc', slot: arc };
        }
    }
    return null;
}

/** A straight slot's end arc centres, radius, the construction line between the centres and what sits on it. */
function straightFrame(g: SketchGeometry, s: Slot) {
    const [a, b] = s.arcs.map((id) => curveOf(g, id)!) as [Extract<SketchGeometry['curves'][number], { kind: 'arc' }>, Extract<SketchGeometry['curves'][number], { kind: 'arc' }>];
    const [ca, cb] = [P(g, a.center), P(g, b.center)];
    const length = Math.hypot(cb[0] - ca[0], cb[1] - ca[1]);
    const d: Pt = length > 1e-12 ? [(cb[0] - ca[0]) / length, (cb[1] - ca[1]) / length] : [1, 0];
    const axis = g.curves.find((c) => c.kind === 'line' && c.construction
        && ((c.a === a.center && c.b === b.center) || (c.a === b.center && c.b === a.center)));
    const extra = axis ? g.constraints.flatMap((k) => (k.kind === 'midpoint' && k.line === axis.id ? [k.point]
        : k.kind === 'pointOnCurve' && k.curve === axis.id ? [k.point] : [])) : [];
    const own = new Set([...[...s.lines, ...s.arcs].flatMap((id) => curvePointIds(curveOf(g, id)!)), ...extra]);
    return { centre: [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2] as Pt, d, length, r: curveRadius(g, a.id) ?? 0, points: [...own] };
}

/** An arc slot's construction arc: centre, radius, start direction and sweep; the end arcs' radius; its points. */
function arcFrame(g: SketchGeometry, s: ArcSlot) {
    const c = curveOf(g, s.centre) as Extract<SketchGeometry['curves'][number], { kind: 'arc' }>;
    const [m, st, en] = [P(g, c.center), P(g, c.start), P(g, c.end)];
    const from = Math.atan2(st[1] - m[1], st[0] - m[0]);
    const sweep = norm(Math.atan2(en[1] - m[1], en[0] - m[0]) - from) || TAU;
    const curves = [s.centre, s.outer, s.inner, ...s.caps];
    // The construction lines from the centre to the ends (Add dimensions) share the slot's points.
    const points = [...new Set(curves.flatMap((id) => curvePointIds(curveOf(g, id)!)))];
    return { m, radius: Math.hypot(st[0] - m[0], st[1] - m[1]), from, sweep, half: curveRadius(g, s.caps[0]) ?? 0, points };
}

export function slotParams(g: SketchGeometry, found: SlotFound, overall = false): SlotParams {
    if (found.kind === 'straight') {
        const f = straightFrame(g, found.slot);
        return { cx: f.centre[0], cy: f.centre[1], width: 2 * f.r, length: f.length + (overall ? 2 * f.r : 0) };
    }
    const f = arcFrame(g, found.slot);
    return { cx: f.m[0], cy: f.m[1], width: 2 * f.half, length: f.radius * f.sweep, radius: f.radius, angle: deg(f.sweep) };
}

/** The slot with new parameters (before solving), or why it cannot have them. */
export function editSlot(g: SketchGeometry, found: SlotFound, next: SlotParams, overall = false): SketchGeometry | string {
    const now = slotParams(g, found, overall);
    const to = new Map<string, Pt>();
    if (!(next.width > 0)) {
        return 'The width must be above zero.';
    }
    if (found.kind === 'straight') {
        const f = straightFrame(g, found.slot);
        const r = next.width / 2;
        const length = overall ? next.length - 2 * r : next.length;
        if (!(length > 0)) {
            return overall ? 'The overall length must be more than the width.' : 'The length must be above zero.';
        }
        const n: Pt = [-f.d[1], f.d[0]];
        for (const id of f.points) {
            const p = P(g, id);
            const v: Pt = [p[0] - f.centre[0], p[1] - f.centre[1]];
            const x = v[0] * f.d[0] + v[1] * f.d[1];
            const y = v[0] * n[0] + v[1] * n[1];
            // Along: the half length plus so many radii beyond it; across: so many radii.
            const side = Math.abs(x) < 1e-9 * Math.max(1, f.length) ? 0 : Math.sign(x);
            const beyond = f.r > 0 ? (Math.abs(x) - f.length / 2) / f.r : 0;
            const nx = side * (length / 2 + beyond * r);
            const ny = f.r > 0 ? (y / f.r) * r : y;
            to.set(id, [next.cx + f.d[0] * nx + n[0] * ny, next.cy + f.d[1] * nx + n[1] * ny]);
        }
    } else {
        const f = arcFrame(g, found.slot);
        const radius = next.radius ?? f.radius;
        // A new length sweeps the arc that far; a new angle (or both) sets the sweep directly.
        const sweep = next.angle !== undefined && Math.abs(next.angle - (now.angle ?? 0)) > 1e-12 ? (next.angle * Math.PI) / 180
            : Math.abs(next.length - now.length) > 1e-12 ? next.length / radius : ((next.angle ?? deg(f.sweep)) * Math.PI) / 180;
        const half = next.width / 2;
        if (!(radius > 0)) {
            return 'The radius must be above zero.';
        }
        if (!(sweep > 0 && sweep < TAU)) {
            return 'The angle must be between 0° and 360°.';
        }
        if (half >= radius) {
            return 'The slot is wider than its arc: make it narrower or the radius larger.';
        }
        for (const id of f.points) {
            const p = P(g, id);
            const v: Pt = [p[0] - f.m[0], p[1] - f.m[1]];
            const d = Math.hypot(v[0], v[1]);
            if (d < 1e-9 * Math.max(1, f.radius)) {
                to.set(id, [next.cx, next.cy]);
                continue;
            }
            // At the start or the end of the arc; so many end-arc radii out from it.
            const a = norm(Math.atan2(v[1], v[0]) - f.from);
            const atEnd = Math.abs(a - f.sweep) < Math.min(a, TAU - a) ? 1 : 0;
            const angle = f.from + atEnd * sweep;
            const k = f.half > 0 ? (d - f.radius) / f.half : 0;
            const r = radius + k * half;
            to.set(id, [next.cx + r * Math.cos(angle), next.cy + r * Math.sin(angle)]);
        }
    }
    return { ...g, points: g.points.map((p) => (to.has(p.id) && p.id !== 'origin' ? { ...p, u: to.get(p.id)![0] + 0, v: to.get(p.id)![1] + 0 } : p)) };
}

/** The straight slot's own length dimension: centre to centre (on its centreline) or overall (between two points on it). */
function lengthDimension(g: SketchGeometry, s: Slot): { kind: 'centre' | 'overall'; id: string; points: string[] } | null {
    const [a, b] = s.arcs.map((id) => curveOf(g, id)) as Extract<SketchGeometry['curves'][number], { kind: 'arc' }>[];
    const axis = g.curves.find((c) => c.kind === 'line' && c.construction && ((c.a === a.center && c.b === b.center) || (c.a === b.center && c.b === a.center)));
    if (!axis) {
        return null;
    }
    const centre = g.constraints.find((k) => k.kind === 'length' && k.line === axis.id && !k.driven);
    if (centre) {
        return { kind: 'centre', id: centre.id, points: [] };
    }
    const on = new Set(g.constraints.flatMap((k) => (k.kind === 'pointOnCurve' && k.curve === axis.id ? [k.point] : [])));
    const overall = g.constraints.find((k) => k.kind === 'distance' && !k.axis && on.has(k.a) && on.has(k.b) && !k.driven);
    return overall && overall.kind === 'distance' ? { kind: 'overall', id: overall.id, points: [overall.a, overall.b] } : null;
}

/**
 * Center to Center or Overall Length for a straight slot that is there: its own length dimension (from Add dimensions)
 * changes to the other kind, keeping the length. Unchanged when it has none or has that kind already.
 */
export function setSlotLengthKind(g: SketchGeometry, found: SlotFound, overall: boolean): SketchGeometry {
    if (found.kind !== 'straight') {
        return g;
    }
    const dim = lengthDimension(g, found.slot);
    if (!dim || (dim.kind === 'overall') === overall) {
        return g;
    }
    const f = straightFrame(g, found.slot);
    const [a, b] = found.slot.arcs.map((id) => curveOf(g, id)) as Extract<SketchGeometry['curves'][number], { kind: 'arc' }>[];
    const axis = g.curves.find((c) => c.kind === 'line' && c.construction && ((c.a === a.center && c.b === b.center) || (c.a === b.center && c.b === a.center)))!;
    if (!overall) {
        const out = removeItems(g, dim.points);
        return addConstraint({ ...out, ...carried(g) }, { kind: 'length', line: axis.id, value: f.length }).g;
    }
    let out: SketchGeometry = { ...g, constraints: g.constraints.filter((k) => k.id !== dim.id) };
    const [pa, pb] = [P(g, a.center), P(g, b.center)];
    const u: Pt = [(pb[0] - pa[0]) / (f.length || 1), (pb[1] - pa[1]) / (f.length || 1)];
    const ends: string[] = [];
    for (const [arc, from, sign] of [[a, pa, -1], [b, pb, 1]] as const) {
        const id = newId('p', out);
        out = { ...out, points: [...out.points, { id, u: from[0] + u[0] * f.r * sign, v: from[1] + u[1] * f.r * sign }] };
        out = addConstraint(out, { kind: 'pointOnCurve', point: id, curve: arc.id }).g;
        out = addConstraint(out, { kind: 'pointOnCurve', point: id, curve: axis.id }).g;
        ends.push(id);
    }
    return addConstraint(out, { kind: 'distance', a: ends[0], b: ends[1], value: f.length + 2 * f.r }).g;
}

/** The parts of a sketch beyond points, curves and constraints (removeItems leaves them out). */
const carried = (g: SketchGeometry): Partial<SketchGeometry> => {
    const { points: _p, curves: _c, constraints: _k, ...rest } = g;
    return rest;
};

/** Every curve of the slot (an arc slot's construction arc too). */
export function slotCurveIds(found: SlotFound): string[] {
    return found.kind === 'straight' ? [...found.slot.lines, ...found.slot.arcs]
        : [found.slot.centre, found.slot.outer, found.slot.inner, ...found.slot.caps];
}
