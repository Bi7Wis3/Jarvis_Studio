// Making and editing paths (SolidWorks Make Path, Path PropertyManager) and belts (Belt/Chain): a path is a chain of
// lines and arcs treated as one; a belt is the path of lines and arcs round its pulleys, tangent to each, built here
// and rebuilt when its pulleys, sides, thickness or length change.

import type { SketchBelt, SketchGeometry, SketchPath } from '@jarvis/core';
import { curveOf, curveRadius, pointOf } from './solver';
import { addConstraint, newId, removeItems } from './sketchGeometry';
import { orderChain, pathOf } from './sketchPathModel';
import { pieceLength } from './solverExtras';
import type { NewEntity, Pt } from './sketchMath';

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** A new path id. */
function pathId(g: SketchGeometry): string {
    const used = new Set((g.paths ?? []).map((p) => p.id));
    let n = used.size + 1;
    while (used.has(`path${n}`)) {
        n += 1;
    }
    return `path${n}`;
}

/** The parts of a sketch beyond points, curves and constraints (removeItems leaves them out). */
function carried(g: SketchGeometry): Partial<SketchGeometry> {
    const { points: _p, curves: _c, constraints: _k, ...rest } = g;
    return rest;
}

/**
 * Make Path: the curves, in order along their chain, become one path (`id` given: that path takes them instead).
 * A curve belongs to one path only.
 */
export function makePath(g: SketchGeometry, curves: string[], id?: string): { g: SketchGeometry; id: string } | { error: string } {
    const order = orderChain(g, curves);
    if ('error' in order) {
        return order;
    }
    const taken = order.map((c) => pathOf(g, c)).find((p) => p && p.id !== id);
    if (taken) {
        return { error: 'A curve can belong to one path only: that one is in another path already.' };
    }
    const own = id ?? pathId(g);
    const path: SketchPath = { ...(g.paths?.find((p) => p.id === id) ?? {}), id: own, curves: order };
    const paths = id ? (g.paths ?? []).map((p) => (p.id === id ? path : p)) : [...(g.paths ?? []), path];
    return { g: { ...g, paths }, id: own };
}

/** The path goes (its curves stay as they are, and so does a belt's), with its path relations. */
export function removePath(g: SketchGeometry, id: string): SketchGeometry {
    return {
        ...g,
        paths: (g.paths ?? []).filter((p) => p.id !== id),
        constraints: g.constraints.filter((k) => !(k.kind === 'pathTangent' && k.path === id)),
    };
}

/** The total length of a path's lines and arcs. */
export function pathLength(g: SketchGeometry, path: SketchPath): number {
    return path.curves.reduce((sum, id) => sum + (pieceLength(g, id) ?? 0), 0);
}

// ---- Belt / chain -----------------------------------------------------------------------------------------------

interface Pulley {
    id: string;
    centre: string;
    c: Pt;
    r: number;
    /** +1: the belt runs counter-clockwise round it; -1: clockwise. */
    turn: number;
}

/** The pulleys of a belt, each with the way the belt runs round it. */
function pulleysOf(g: SketchGeometry, belt: SketchBelt): Pulley[] | { error: string } {
    const out: Pulley[] = [];
    for (const id of belt.pulleys) {
        const c = curveOf(g, id);
        const r = curveRadius(g, id);
        if ((c?.kind !== 'circle' && c?.kind !== 'arc') || r === null) {
            return { error: 'Belt members are circles and arcs.' };
        }
        out.push({ id, centre: c.center, c: P(g, c.center), r: r + (belt.thickness ?? 0), turn: 1 });
    }
    if (out.length < 2) {
        return { error: 'A belt needs two or more circles or arcs.' };
    }
    if (new Set(out.map((p) => p.centre)).size !== out.length) {
        return { error: 'Two belt members share a centre: pick each pulley once.' };
    }
    // Round the pulleys in the order picked: the belt turns the way that order goes round (as a band would).
    let area = 0;
    for (let i = 0; i < out.length; i++) {
        const [a, b] = [out[i].c, out[(i + 1) % out.length].c];
        area += a[0] * b[1] - b[0] * a[1];
    }
    const way = area < 0 ? -1 : 1;
    belt.flip.forEach((f, i) => {
        if (out[i]) {
            out[i].turn = f ? -way : way;
        }
    });
    for (let i = belt.flip.length; i < out.length; i++) {
        out[i].turn = way;
    }
    return out;
}

/** The straight run from pulley p to pulley q: where it leaves p and where it meets q. */
function run(p: Pulley, q: Pulley): { from: Pt; to: Pt } | null {
    const d: Pt = [q.c[0] - p.c[0], q.c[1] - p.c[1]];
    const l = Math.hypot(d[0], d[1]);
    const delta = q.turn * q.r - p.turn * p.r;
    if (l < 1e-9 || Math.abs(delta) >= l) {
        return null;
    }
    // Travelling along u, each pulley's centre is on the left of the belt when it turns counter-clockwise.
    const angle = Math.atan2(d[1], d[0]) - Math.asin(delta / l);
    const left: Pt = [-Math.sin(angle), Math.cos(angle)];
    return {
        from: [p.c[0] - p.turn * p.r * left[0], p.c[1] - p.turn * p.r * left[1]],
        to: [q.c[0] - q.turn * q.r * left[0], q.c[1] - q.turn * q.r * left[1]],
    };
}

/** The belt as drawn entities (for its preview), or why it cannot run round the pulleys. */
export function beltPreview(g: SketchGeometry, belt: SketchBelt): NewEntity[] | { error: string } {
    const layout = beltLayout(g, belt);
    if ('error' in layout) {
        return layout;
    }
    const out: NewEntity[] = [];
    layout.runs.forEach((r, i) => {
        out.push({ kind: 'line', a: r.from, b: r.to });
        const q = layout.pulleys[(i + 1) % layout.pulleys.length];
        const next = layout.runs[(i + 1) % layout.runs.length];
        const [s, e] = q.turn > 0 ? [r.to, next.from] : [next.from, r.to];
        const a0 = Math.atan2(s[1] - q.c[1], s[0] - q.c[0]);
        let a1 = Math.atan2(e[1] - q.c[1], e[0] - q.c[0]);
        while (a1 <= a0) {
            a1 += 2 * Math.PI;
        }
        const m = (a0 + a1) / 2;
        out.push({ kind: 'arc', a: s, b: e, m: [q.c[0] + q.r * Math.cos(m), q.c[1] + q.r * Math.sin(m)] });
    });
    return out;
}

function beltLayout(g: SketchGeometry, belt: SketchBelt): { pulleys: Pulley[]; runs: { from: Pt; to: Pt }[] } | { error: string } {
    const pulleys = pulleysOf(g, belt);
    if ('error' in pulleys) {
        return pulleys;
    }
    const runs: { from: Pt; to: Pt }[] = [];
    for (let i = 0; i < pulleys.length; i++) {
        const r = run(pulleys[i], pulleys[(i + 1) % pulleys.length]);
        if (!r) {
            return { error: 'The belt cannot pass between two of the pulleys: they overlap too far (or the belt crosses through one). Move them apart or flip the belt side.' };
        }
        runs.push(r);
    }
    return { pulleys, runs };
}

/**
 * The belt built round its pulleys: a line for each run, tangent to an arc on each pulley (about the pulley's own
 * centre point), all one closed path. `id` given: that belt's path is built again in place of what it had.
 */
export function buildBelt(g0: SketchGeometry, belt: SketchBelt, id?: string): { g: SketchGeometry; id: string } | { error: string } {
    let g = g0;
    if (id) {
        const old = g.paths?.find((p) => p.id === id);
        if (old) {
            // The old belt's curves go (their relations with them); the pulleys stay.
            g = { ...removeItems(g, old.curves), ...carried(g) };
            g = { ...g, paths: (g.paths ?? []).filter((p) => p.id !== id) };
        }
    }
    const layout = beltLayout(g, belt);
    if ('error' in layout) {
        return layout;
    }
    const { pulleys, runs } = layout;
    let out = g;
    const point = (at: Pt) => {
        const pid = newId('p', out);
        out = { ...out, points: [...out.points, { id: pid, u: at[0], v: at[1] }] };
        return pid;
    };
    const ends = runs.map((r) => ({ from: point(r.from), to: point(r.to) }));
    const curves: string[] = [];
    const lines: string[] = [];
    const arcs: string[] = [];
    for (let i = 0; i < pulleys.length; i++) {
        const line = newId('c', out);
        out = { ...out, curves: [...out.curves, { id: line, kind: 'line', a: ends[i].from, b: ends[i].to }] };
        lines.push(line);
        // Round the next pulley: from where this run meets it to where the next run leaves it.
        const j = (i + 1) % pulleys.length;
        const q = pulleys[j];
        const [start, end] = q.turn > 0 ? [ends[i].to, ends[j].from] : [ends[j].from, ends[i].to];
        const arc = newId('c', out);
        out = { ...out, curves: [...out.curves, { id: arc, kind: 'arc', center: q.centre, start, end }] };
        arcs.push(arc);
        curves.push(line, arc);
    }
    for (let i = 0; i < pulleys.length; i++) {
        // Each run is tangent to the arc it leaves and the arc it meets.
        out = addConstraint(out, { kind: 'tangent', a: lines[i], b: arcs[(i + pulleys.length - 1) % pulleys.length] }).g;
        out = addConstraint(out, { kind: 'tangent', a: lines[i], b: arcs[i] }).g;
    }
    const own = id ?? pathId(out);
    const kept: SketchBelt = {
        pulleys: [...belt.pulleys], flip: belt.pulleys.map((_, i) => !!belt.flip[i]),
        ...(belt.thickness ? { thickness: belt.thickness } : {}), ...(belt.length !== undefined ? { length: belt.length } : {}),
    };
    return { g: { ...out, paths: [...(out.paths ?? []), { id: own, curves, belt: kept }] }, id: own };
}
