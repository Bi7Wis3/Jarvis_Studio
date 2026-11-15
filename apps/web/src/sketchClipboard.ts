// Copy and paste of sketch entities (SolidWorks: Ctrl+C, then click in the view and Ctrl+V: the centre of the copied
// entities goes where the pointer is). A copied piece keeps the relations and dimensions among its own entities; it
// can be pasted into the same sketch or another one opened later in the session.

import type { SketchConstraint, SketchCurve, SketchGeometry, SketchPoint } from '@jarvis/core';
import { ORIGIN, curveOf } from './solver';
import { constraintRefs, newId } from './sketchGeometry';
import { curvePoints } from './sketchEdit';
import type { Pt } from './sketchMath';

/** A self-contained piece of a sketch. */
export interface SketchFragment {
    points: SketchPoint[];
    curves: SketchCurve[];
    constraints: SketchConstraint[];
    /** Middle of its bounding box: what lands at the pointer. */
    centre: Pt;
}

/** Points that bound a curve (a circle by its extremes). */
function extent(g: SketchGeometry, c: SketchCurve): Pt[] {
    const P = (id: string): Pt | null => {
        const p = g.points.find((q) => q.id === id);
        return p ? [p.u, p.v] : null;
    };
    if (c.kind === 'circle') {
        const m = P(c.center);
        return m ? [[m[0] - c.radius, m[1] - c.radius], [m[0] + c.radius, m[1] + c.radius]] : [];
    }
    return curvePoints(c).map(P).filter((p): p is Pt => !!p);
}

/** The selected curves and points with the points they need and the relations among them; null when nothing is. */
export function fragmentOf(g: SketchGeometry, ids: string[]): SketchFragment | null {
    const curves = ids.map((id) => curveOf(g, id)).filter((c): c is SketchCurve => !!c);
    const pointIds = new Set([...curves.flatMap(curvePoints), ...ids.filter((id) => g.points.some((p) => p.id === id))]);
    pointIds.delete(ORIGIN);
    const points = g.points.filter((p) => pointIds.has(p.id));
    if (!curves.length && !points.length) {
        return null;
    }
    const own = new Set([...curves.map((c) => c.id), ...pointIds]);
    // Relations to the origin, the axes or the rest of the sketch, and locks, stay behind.
    const constraints = g.constraints.filter((k) => k.kind !== 'fix' && constraintRefs(k).every((r) => own.has(r)));
    const corners = [...curves.flatMap((c) => extent(g, c)), ...points.map((p): Pt => [p.u, p.v])];
    const lo: Pt = [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1]))];
    const hi: Pt = [Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))];
    return {
        points: points.map((p) => ({ ...p, fixed: undefined })),
        curves,
        constraints: constraints.map((k) => {
            const { at: _at, ...rest } = k as SketchConstraint & { at?: Pt };
            return rest as SketchConstraint;
        }),
        centre: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2],
    };
}

/** Adds a copy of the fragment with its centre at `at`; returns the new curves and points (for the selection). */
export function pasteFragment(g: SketchGeometry, f: SketchFragment, at: Pt): { g: SketchGeometry; created: { type: 'point' | 'curve'; id: string }[] } {
    const by: Pt = [at[0] - f.centre[0], at[1] - f.centre[1]];
    const map = new Map<string, string>();
    let out: SketchGeometry = { points: [...g.points], curves: [...g.curves], constraints: [...g.constraints] };
    for (const p of f.points) {
        const id = newId('p', out);
        map.set(p.id, id);
        const { fixed: _fixed, ...rest } = p;
        out = { ...out, points: [...out.points, { ...rest, id, u: p.u + by[0], v: p.v + by[1] }] };
    }
    const r = (id: string) => map.get(id) ?? id;
    for (const c of f.curves) {
        const id = newId('c', out);
        map.set(c.id, id);
        const copy: SketchCurve = c.kind === 'line' ? { ...c, id, a: r(c.a), b: r(c.b) }
            : c.kind === 'circle' ? { ...c, id, center: r(c.center) }
                : c.kind === 'arc' ? { ...c, id, center: r(c.center), start: r(c.start), end: r(c.end) }
                    : renameCurve(c, id, r);
        out = { ...out, curves: [...out.curves, copy] };
    }
    for (const k of f.constraints) {
        const id = newId('k', out);
        const copy = Object.fromEntries(Object.entries(k).map(([key, v]) => [key, typeof v === 'string' && key !== 'kind' && key !== 'axis' ? r(v) : v]));
        out = { ...out, constraints: [...out.constraints, { ...copy, id } as SketchConstraint] };
    }
    const created = [
        ...f.curves.map((c) => ({ type: 'curve' as const, id: map.get(c.id)! })),
        ...f.points.filter((p) => !f.curves.some((c) => curvePoints(c).includes(p.id))).map((p) => ({ type: 'point' as const, id: map.get(p.id)! })),
    ];
    return { g: out, created };
}

/** Any other curve kind: every string field that names a copied point is renamed. */
function renameCurve(c: SketchCurve, id: string, r: (id: string) => string): SketchCurve {
    return Object.fromEntries(Object.entries(c).map(([key, v]) => [key, key === 'id' ? id
        : typeof v === 'string' && key !== 'kind' ? r(v)
            : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? r(x) : x)) : v])) as SketchCurve;
}

let clipboard: SketchFragment | null = null;

/** Keeps a fragment for pasting (in this browser tab, across sketches). */
export function setClipboard(f: SketchFragment | null): void {
    clipboard = f;
}

export function getClipboard(): SketchFragment | null {
    return clipboard;
}
