// Fully Define Sketch with its options (SolidWorks: Fully Define Sketch PropertyManager): all entities or the selected
// ones; which relations it may add; horizontal and vertical dimension schemes (Baseline, Ordinate or Chain) from a datum point
// or line (default the origin); where the dimensions are placed (above or below, right or left of the sketch).

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, measure, pointOf, solveGeometry, type SolveResult } from './solver';
import { addConstraint, type NewConstraint } from './sketchGeometry';
import { curvePointIds } from './sketchCurves';
import { unmetConstraints } from './sketchCheck';

export type FullyDefineRelation = 'horizontal' | 'vertical' | 'perpendicular' | 'parallel' | 'midpoint' | 'coincident' | 'tangent' | 'concentric' | 'equal';

export const FULLY_DEFINE_RELATIONS: { value: FullyDefineRelation; label: string }[] = [
    { value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }, { value: 'perpendicular', label: 'Perpendicular' },
    { value: 'parallel', label: 'Parallel' }, { value: 'midpoint', label: 'Midpoint' }, { value: 'coincident', label: 'Coincident' },
    { value: 'tangent', label: 'Tangent' }, { value: 'concentric', label: 'Concentric' }, { value: 'equal', label: 'Equal' },
];

/** Baseline: each from the datum, stacked; Ordinate: each from the datum, in one row of ordinates; Chain: point to point. */
export type FullyDefineScheme = 'baseline' | 'ordinate' | 'chain';

export interface FullyDefineOptions {
    /** The ids of the entities to define; absent: all of the sketch. */
    only?: string[];
    relations: FullyDefineRelation[];
    horizontal: FullyDefineScheme;
    vertical: FullyDefineScheme;
    /** Datum of the horizontal (and vertical) dimensions: a point or a line id; default the origin. */
    datumH?: string;
    datumV?: string;
    above: boolean;
    right: boolean;
}

export const DEFAULT_FULLY_DEFINE: FullyDefineOptions = {
    relations: FULLY_DEFINE_RELATIONS.map((r) => r.value), horizontal: 'baseline', vertical: 'baseline', above: true, right: true,
};

type Pt = [number, number];
const TOL = 1e-6;

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

const unit = (a: Pt, b: Pt): Pt | null => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return l > TOL ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
};

/** Relations the geometry already satisfies (within a hair), of the allowed kinds, among the entities to define. */
function relationCandidates(g: SketchGeometry, kinds: Set<FullyDefineRelation>, inScope: (id: string) => boolean): NewConstraint[] {
    const out: NewConstraint[] = [];
    const lines = g.curves.filter((c): c is Extract<typeof c, { kind: 'line' }> => c.kind === 'line' && inScope(c.id));
    const rounds = g.curves.filter((c): c is Extract<typeof c, { kind: 'circle' | 'arc' }> => (c.kind === 'circle' || c.kind === 'arc') && inScope(c.id));
    const dirs = new Map(lines.map((l) => [l.id, unit(P(g, l.a), P(g, l.b))]));
    for (const l of lines) {
        const d = dirs.get(l.id);
        if (d && kinds.has('horizontal') && Math.abs(d[1]) < TOL) {
            out.push({ kind: 'horizontal', line: l.id });
        } else if (d && kinds.has('vertical') && Math.abs(d[0]) < TOL) {
            out.push({ kind: 'vertical', line: l.id });
        }
    }
    for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            const [a, b] = [dirs.get(lines[i].id), dirs.get(lines[j].id)];
            if (!a || !b) {
                continue;
            }
            const cross = Math.abs(a[0] * b[1] - a[1] * b[0]);
            const dot = Math.abs(a[0] * b[0] + a[1] * b[1]);
            if (kinds.has('parallel') && cross < TOL) {
                out.push({ kind: 'parallel', a: lines[i].id, b: lines[j].id });
            } else if (kinds.has('perpendicular') && dot < TOL) {
                out.push({ kind: 'perpendicular', a: lines[i].id, b: lines[j].id });
            }
            const [la, lb] = [Math.hypot(...sub(P(g, lines[i].b), P(g, lines[i].a))), Math.hypot(...sub(P(g, lines[j].b), P(g, lines[j].a)))];
            if (kinds.has('equal') && Math.abs(la - lb) < TOL) {
                out.push({ kind: 'equal', a: lines[i].id, b: lines[j].id });
            }
        }
    }
    const points = g.points.filter((p) => p.id !== ORIGIN && inScope(p.id));
    if (kinds.has('midpoint')) {
        for (const p of points) {
            for (const l of lines) {
                const m: Pt = [(P(g, l.a)[0] + P(g, l.b)[0]) / 2, (P(g, l.a)[1] + P(g, l.b)[1]) / 2];
                if (l.a !== p.id && l.b !== p.id && Math.hypot(p.u - m[0], p.v - m[1]) < TOL) {
                    out.push({ kind: 'midpoint', point: p.id, line: l.id });
                }
            }
        }
    }
    if (kinds.has('coincident')) {
        for (let i = 0; i < points.length; i++) {
            for (let j = i + 1; j < points.length; j++) {
                if (Math.hypot(points[i].u - points[j].u, points[i].v - points[j].v) < TOL) {
                    out.push({ kind: 'coincident', a: points[i].id, b: points[j].id });
                }
            }
            if (Math.hypot(points[i].u, points[i].v) < TOL) {
                out.push({ kind: 'coincident', a: ORIGIN, b: points[i].id });
            }
        }
    }
    for (let i = 0; i < rounds.length; i++) {
        for (let j = i + 1; j < rounds.length; j++) {
            const [a, b] = [rounds[i], rounds[j]];
            if (kinds.has('concentric') && a.center !== b.center && Math.hypot(...sub(P(g, a.center), P(g, b.center))) < TOL) {
                out.push({ kind: 'concentric', a: a.id, b: b.id });
            }
            const [ra, rb] = [radiusOf(g, a.id), radiusOf(g, b.id)];
            if (kinds.has('equal') && ra !== null && rb !== null && Math.abs(ra - rb) < TOL) {
                out.push({ kind: 'equal', a: a.id, b: b.id });
            }
        }
    }
    if (kinds.has('tangent')) {
        for (const l of lines) {
            const d = dirs.get(l.id);
            for (const r of rounds) {
                const radius = radiusOf(g, r.id);
                if (!d || radius === null) {
                    continue;
                }
                const c = P(g, r.center);
                const a = P(g, l.a);
                const off = Math.abs((c[0] - a[0]) * d[1] - (c[1] - a[1]) * d[0]);
                if (Math.abs(off - radius) < TOL) {
                    out.push({ kind: 'tangent', a: l.id, b: r.id });
                }
            }
        }
    }
    return out;
}

const sub = (a: Pt, b: Pt): [number, number] => [a[0] - b[0], a[1] - b[1]];

function radiusOf(g: SketchGeometry, id: string): number | null {
    const c = curveOf(g, id);
    if (c?.kind === 'circle') {
        return c.radius;
    }
    if (c?.kind === 'arc') {
        return Math.hypot(...sub(P(g, c.start), P(g, c.center)));
    }
    return null;
}

/** Where a datum is along an axis (a point's coordinate, or a line through its first point). */
function datumAt(g: SketchGeometry, datum: string, axis: 0 | 1): number {
    if (datum === ORIGIN || datum === AXIS_U || datum === AXIS_V) {
        return 0;
    }
    const c = curveOf(g, datum);
    return c?.kind === 'line' ? P(g, c.a)[axis] : P(g, datum)[axis];
}

/** One horizontal (axis 'u') or vertical ('v') dimension from `from` (a point or a datum line) to point `to`. */
function positional(g: SketchGeometry, from: string, to: string, axis: 'u' | 'v', at: Pt): NewConstraint | null {
    const k = axis === 'u' ? 0 : 1;
    const line = curveOf(g, from);
    // A datum line across the measuring direction is measured to square; any other line by its first point.
    const d0 = line?.kind === 'line' ? unit(P(g, line.a), P(g, line.b)) : null;
    const across = from === (axis === 'u' ? AXIS_V : AXIS_U) || (!!d0 && Math.abs(d0[k]) < TOL);
    if (across) {
        const d = Math.abs(P(g, to)[k] - datumAt(g, from, k));
        return d > TOL ? { kind: 'distance', a: to, b: from, value: d, at } : null;
    }
    const point = line?.kind === 'line' ? line.a : from === AXIS_U || from === AXIS_V ? ORIGIN : from;
    if (point === to) {
        return null;
    }
    // In line with it: a zero distance (tried after everything else).
    return { kind: 'distance', a: point, b: to, axis, value: Math.abs(P(g, to)[k] - P(g, point)[k]), at };
}

/**
 * The dimensions to try, in order: radii and diameters, then every point's horizontal and vertical position by the
 * schemes (from the datum, or point to point in order), then line lengths for what is still free.
 */
function dimensionCandidates(g: SketchGeometry, o: FullyDefineOptions, inScope: (id: string) => boolean): NewConstraint[] {
    const scoped = g.curves.filter((c) => inScope(c.id));
    const pts = [...new Set([...scoped.flatMap(curvePointIds), ...g.points.filter((p) => inScope(p.id)).map((p) => p.id)])]
        .filter((id) => id !== ORIGIN && pointOf(g, id));
    const all = g.points.map((p) => [p.u, p.v] as Pt);
    const box = all.length ? all.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity])
        : [0, 0, 0, 0];
    const gap = Math.max(5, (box[2] - box[0] + box[3] - box[1]) * 0.08);
    const out: NewConstraint[] = [];
    for (const c of scoped) {
        if ((c.kind === 'circle' || c.kind === 'arc') && !c.construction) {
            out.push({ kind: c.kind === 'circle' ? 'diameter' : 'radius', curve: c.id, value: radiusOf(g, c.id)! * (c.kind === 'circle' ? 2 : 1) });
        }
    }
    let row = 0;
    const scheme = (axis: 'u' | 'v', kind: FullyDefineScheme, datum: string) => {
        const k = axis === 'u' ? 0 : 1;
        const sorted = [...pts].sort((a, b) => P(g, a)[k] - P(g, b)[k]);
        let prev = datum;
        for (const id of sorted) {
            // Stacked rows above or below the sketch (horizontal), or right or left (vertical); ordinates in one row,
            // each label in line with its point.
            row += 1;
            const level = kind === 'baseline' ? row : 1;
            const along = kind === 'ordinate' ? P(g, id)[k] : (P(g, id)[k] + datumAt(g, prev, k)) / 2;
            const at: Pt = axis === 'u'
                ? [along, o.above ? box[3] + gap * level : box[1] - gap * level]
                : [o.right ? box[2] + gap * level : box[0] - gap * level, along];
            const c = positional(g, kind === 'chain' ? prev : datum, id, axis, at);
            if (c) {
                out.push(kind === 'ordinate' && c.kind === 'distance' ? { ...c, ordinate: true } : c);
            }
            if (kind === 'chain') {
                prev = id;
            }
        }
        row = 0;
    };
    scheme('u', o.horizontal, o.datumH ?? ORIGIN);
    scheme('v', o.vertical, o.datumV ?? ORIGIN);
    for (const c of scoped) {
        if (c.kind === 'line' && !c.construction) {
            out.push({ kind: 'length', line: c.id, value: Math.hypot(...sub(P(g, c.b), P(g, c.a))) });
        }
    }
    // In line with the origin: on the axis through it, when nothing else held the point.
    for (const id of pts) {
        for (const [axis, line] of [[0, AXIS_V], [1, AXIS_U]] as const) {
            if (Math.abs(P(g, id)[axis]) < TOL) {
                out.push({ kind: 'pointOnCurve', point: id, curve: line });
            }
        }
    }
    // Zero distances last: a relation is the better hold for points in line, when relations are allowed.
    const zero = (c: NewConstraint) => c.kind === 'distance' && !!c.axis && !(c.value > TOL);
    return [...out.filter((c) => !zero(c)), ...out.filter(zero)];
}

/**
 * Adds relations, then dimensions, until the entities to define have no freedom left: each is kept only when the
 * solver's count drops and it adds no conflict or redundancy. Returns how many of each were added.
 */
export function fullyDefineWith(g: SketchGeometry, o: FullyDefineOptions, solve: (g: SketchGeometry) => SolveResult = solveGeometry):
    { g: SketchGeometry; relations: number; dimensions: number; dof: number } | { error: string } {
    const start = solve(g);
    if (!start.ok) {
        return { error: 'The sketch is over-constrained; fix that first (SketchXpert).' };
    }
    let current = start.geometry;
    let dof = start.dof;
    const scope = o.only ? new Set([...o.only, ...o.only.flatMap((id) => {
        const c = curveOf(g, id);
        return c ? curvePointIds(c) : [];
    })]) : null;
    const inScope = (id: string) => !scope || scope.has(id);
    let relations = 0;
    let dimensions = 0;
    const repeats = start.redundant.length;
    const tryAdd = (c: NewConstraint): boolean => {
        const r = solve(addConstraint(current, c).g);
        if (r.ok && r.redundant.length <= repeats && !r.conflicting.length && r.dof < dof && !unmetConstraints(r.geometry).length) {
            current = r.geometry;
            dof = r.dof;
            return true;
        }
        return false;
    };
    for (const c of relationCandidates(current, new Set(o.relations), inScope)) {
        if (dof <= 0) {
            break;
        }
        relations += tryAdd(c) ? 1 : 0;
    }
    for (const candidate of dimensionCandidates(current, o, inScope)) {
        if (dof <= 0) {
            break;
        }
        // Sizes are measured on the sketch as it is now (earlier additions may have moved nothing, but be sure).
        const value = 'value' in candidate ? measure(current, { ...candidate, id: 'measuring' } as SketchConstraint) : null;
        const c = value !== null && 'value' in candidate ? { ...candidate, value } as NewConstraint : candidate;
        if ('value' in c && !(c.value > TOL) && !(c.kind === 'distance' && c.axis)) {
            continue;
        }
        dimensions += tryAdd(c) ? 1 : 0;
    }
    return { g: current, relations, dimensions, dof };
}
