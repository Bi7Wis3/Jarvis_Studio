// Repair sketch (find and fix small gaps, overlapping duplicates, zero-length curves and relations to deleted
// geometry) and Fully define sketch (add the dimensions that take it to zero degrees of freedom). Pure functions of
// the geometry; the sketcher solves and commits what they return.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { ORIGIN, curveOf, measure, pointOf, solveGeometry, type SolveResult } from './solver';
import { addConstraint, constraintRefs, danglingConstraints, type NewConstraint } from './sketchGeometry';
import { chainOf, curvePoints } from './sketchEdit';
import { dist, round, type Pt } from './sketchMath';

/** End points closer than this (mm) that are not joined count as a gap. */
export const GAP = 0.5;
/** Positions closer than this are the same. */
const SAME = 1e-3;

export type ProblemKind = 'gap' | 'duplicate' | 'overlap' | 'zero' | 'dangling';

export interface Problem {
    /** Stable key: kind and the ids involved. */
    key: string;
    kind: ProblemKind;
    text: string;
    /** What the fix button says. */
    action: string;
    /** Geometry to highlight. */
    refs: string[];
}

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

const endsOf = (c: SketchCurve): string[] => (c.kind === 'line' ? [c.a, c.b] : c.kind === 'arc' ? [c.start, c.end] : []);

const NOUN: Record<SketchCurve['kind'], string> = { line: 'Line', circle: 'Circle', arc: 'Arc' };

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
    const d: Pt = [b[0] - a[0], b[1] - a[1]];
    const l2 = d[0] * d[0] + d[1] * d[1];
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2)) : 0;
    return dist(p, [a[0] + d[0] * t, a[1] + d[1] * t]);
}

function isZero(g: SketchGeometry, c: SketchCurve): boolean {
    if (c.kind === 'line') {
        return dist(P(g, c.a), P(g, c.b)) < SAME;
    }
    if (c.kind === 'circle') {
        return c.radius < SAME;
    }
    return dist(P(g, c.center), P(g, c.start)) < SAME || dist(P(g, c.start), P(g, c.end)) < SAME;
}

/** Whether `b` lies over `a` completely: on it end to end (a line), or the same circle or arc. */
function liesOn(g: SketchGeometry, b: SketchCurve, a: SketchCurve): boolean {
    if (a.kind === 'line' && b.kind === 'line') {
        const [p, q] = [P(g, a.a), P(g, a.b)];
        return segmentDistance(P(g, b.a), p, q) < SAME && segmentDistance(P(g, b.b), p, q) < SAME;
    }
    if (a.kind === 'circle' && b.kind === 'circle') {
        return dist(P(g, a.center), P(g, b.center)) < SAME && Math.abs(a.radius - b.radius) < SAME;
    }
    if (a.kind === 'arc' && b.kind === 'arc') {
        return dist(P(g, a.center), P(g, b.center)) < SAME && dist(P(g, a.start), P(g, b.start)) < SAME && dist(P(g, a.end), P(g, b.end)) < SAME;
    }
    return false;
}

function joined(g: SketchGeometry, a: string, b: string): boolean {
    return g.constraints.some((c) => c.kind === 'coincident' && ((c.a === a && c.b === b) || (c.a === b && c.b === a)));
}

/** Length of a line or arc. */
function lengthOf(g: SketchGeometry, c: SketchCurve): number {
    if (c.kind === 'line') {
        return dist(P(g, c.a), P(g, c.b));
    }
    if (c.kind === 'circle') {
        return 2 * Math.PI * c.radius;
    }
    const m = P(g, c.center);
    const [s, e] = [P(g, c.start), P(g, c.end)];
    const sweep = (((Math.atan2(e[1] - m[1], e[0] - m[0]) - Math.atan2(s[1] - m[1], s[0] - m[0])) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return dist(m, s) * sweep;
}

/** Two lines on one line that overlap in part (neither lies within the other): their span from end to end, as point ids. */
function overlapSpan(g: SketchGeometry, a: SketchCurve, b: SketchCurve): [string, string] | null {
    if (a.kind !== 'line' || b.kind !== 'line') {
        return null;
    }
    const [p, q] = [P(g, a.a), P(g, a.b)];
    const len = dist(p, q);
    if (len < SAME) {
        return null;
    }
    const u: Pt = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    const off = (x: Pt) => Math.abs((x[0] - p[0]) * u[1] - (x[1] - p[1]) * u[0]);
    if (off(P(g, b.a)) > SAME || off(P(g, b.b)) > SAME) {
        return null;
    }
    const t = (id: string) => { const x = P(g, id); return (x[0] - p[0]) * u[0] + (x[1] - p[1]) * u[1]; };
    const all = [a.a, a.b, b.a, b.b].map((id) => ({ id, t: t(id) })).sort((x, y) => x.t - y.t);
    const [b0, b1] = [Math.min(t(b.a), t(b.b)), Math.max(t(b.a), t(b.b))];
    // Overlapping by more than a point, and each sticking out past the other.
    const shared = Math.min(len, b1) - Math.max(0, b0);
    if (shared <= SAME || (b0 >= -SAME && b1 <= len + SAME) || (b0 <= SAME && b1 >= len - SAME)) {
        return null;
    }
    return [all[0].id, all[3].id];
}

/**
 * Everything Repair sketch would fix: zero-length and tiny pieces (a chain shorter than twice the gap size) first,
 * then duplicates and lines that overlap in part, gaps smaller than `gap`, and dangling relations.
 */
export function findProblems(g: SketchGeometry, gap = GAP): Problem[] {
    const out: Problem[] = [];
    const zero = new Set<string>();
    for (const c of g.curves) {
        if (isZero(g, c)) {
            zero.add(c.id);
            out.push({ key: `zero:${c.id}`, kind: 'zero', text: `${NOUN[c.kind]} ${c.id} has no length`, action: 'Remove', refs: [c.id, ...curvePoints(c)] });
        }
    }
    // Tiny: a whole chain shorter than twice the gap size (a stray scrap, not a short side of a bigger shape).
    for (const c of g.curves) {
        if (zero.has(c.id) || c.kind === 'circle') {
            continue;
        }
        const chain = chainOf(g, c.id).segments.map((s) => s.curve);
        if (chain.reduce((sum, k) => sum + lengthOf(g, k), 0) < 2 * gap) {
            zero.add(c.id);
            out.push({ key: `zero:${c.id}`, kind: 'zero', text: `${NOUN[c.kind]} ${c.id} is shorter than ${round(2 * gap, 0.001)} mm`, action: 'Remove', refs: [c.id, ...curvePoints(c)] });
        }
    }
    const curves = g.curves.filter((c) => !zero.has(c.id));
    const duplicate = new Set<string>();
    for (let i = 0; i < curves.length; i++) {
        for (let j = i + 1; j < curves.length; j++) {
            const [a, b] = [curves[i], curves[j]];
            if (!!a.construction !== !!b.construction || duplicate.has(a.id) || duplicate.has(b.id)) {
                continue;
            }
            // The later one goes when they are the same; else the one that lies within the other.
            const [extra, kept] = liesOn(g, b, a) ? [b, a] : liesOn(g, a, b) ? [a, b] : [null, null];
            if (extra && kept) {
                duplicate.add(extra.id);
                const text = a.kind === 'line' ? `Line ${extra.id} lies on line ${kept.id}` : `${NOUN[extra.kind]} ${extra.id} is the same as ${kept.id}`;
                out.push({ key: `duplicate:${extra.id}`, kind: 'duplicate', text, action: 'Remove duplicate', refs: [extra.id, kept.id] });
                continue;
            }
            if (overlapSpan(g, a, b)) {
                duplicate.add(b.id);
                out.push({ key: `overlap:${a.id}:${b.id}`, kind: 'overlap', text: `Lines ${a.id} and ${b.id} overlap`, action: 'Merge', refs: [a.id, b.id] });
            }
        }
    }
    // Gaps: free end points of different curves close together, not the same point and not held coincident.
    const ends = [...new Set(curves.flatMap(endsOf))];
    // Ends of the same curve (a zero-length one too) are not a gap.
    const owners = (id: string) => new Set(g.curves.filter((c) => curvePoints(c).includes(id)).map((c) => c.id));
    for (let i = 0; i < ends.length; i++) {
        for (let j = i + 1; j < ends.length; j++) {
            const [a, b] = [ends[i], ends[j]];
            const d = dist(P(g, a), P(g, b));
            if (d >= gap || joined(g, a, b)) {
                continue;
            }
            const oa = owners(a);
            if ([...owners(b)].some((id) => oa.has(id))) {
                continue;
            }
            out.push({
                key: `gap:${a}:${b}`, kind: 'gap', action: 'Close gap', refs: [a, b, ...oa, ...owners(b)],
                text: d < 1e-6 ? `End points ${a} and ${b} sit together but are not joined` : `Gap of ${round(d, 0.001)} mm between ${a} and ${b}`,
            });
        }
    }
    for (const id of danglingConstraints(g)) {
        const c = g.constraints.find((k) => k.id === id)!;
        out.push({ key: `dangling:${id}`, kind: 'dangling', text: `${c.kind} ${id} refers to deleted geometry`, action: 'Remove', refs: [id] });
    }
    return out;
}

/** Whether a constraint says nothing once two of its points are the same one. */
function degenerate(g: SketchGeometry, c: SketchConstraint): boolean {
    switch (c.kind) {
        case 'coincident':
        case 'distance':
        case 'symmetric':
            return c.a === c.b;
        case 'pointOnCurve': {
            const curve = curveOf(g, c.curve);
            return !!curve && curvePoints(curve).includes(c.point);
        }
        case 'midpoint': {
            const line = curveOf(g, c.line);
            return line?.kind === 'line' && (line.a === c.point || line.b === c.point);
        }
        default:
            return false;
    }
}

/** Merges point `drop` into `keep`: curves and constraints use `keep`, and constraints that say nothing any more go. */
export function mergePoints(g: SketchGeometry, keep: string, drop: string): SketchGeometry {
    if (drop === ORIGIN) {
        [keep, drop] = [drop, keep];
    }
    if (keep === drop) {
        return g;
    }
    const r = (id: string) => (id === drop ? keep : id);
    const curves = g.curves.map((c): SketchCurve => (c.kind === 'line' ? { ...c, a: r(c.a), b: r(c.b) }
        : c.kind === 'circle' ? { ...c, center: r(c.center) } : { ...c, center: r(c.center), start: r(c.start), end: r(c.end) }));
    let points = g.points.filter((p) => p.id !== drop);
    if (keep === ORIGIN && !points.some((p) => p.id === ORIGIN)) {
        points = [...points, { id: ORIGIN, u: 0, v: 0, fixed: true }];
    }
    const out: SketchGeometry = { points, curves, constraints: [] };
    const seen = new Set<string>();
    for (const c of g.constraints) {
        const next = Object.fromEntries(Object.entries(c).map(([key, v]) => [key, typeof v === 'string' && key !== 'id' && key !== 'kind' && key !== 'axis' ? r(v) : v])) as SketchConstraint;
        const { id: _id, ...rest } = next;
        const sig = JSON.stringify(rest);
        if (degenerate(out, next) || seen.has(sig)) {
            continue;
        }
        seen.add(sig);
        out.constraints.push(next);
    }
    return out;
}

/** Removes one curve, the points nothing else uses any more, and the constraints on either; nothing else. */
function removeCurve(g: SketchGeometry, id: string): SketchGeometry {
    const curve = curveOf(g, id);
    if (!curve) {
        return g;
    }
    const curves = g.curves.filter((c) => c.id !== id);
    const used = new Set(curves.flatMap(curvePoints));
    const gone = new Set([id, ...curvePoints(curve).filter((p) => p !== ORIGIN && !used.has(p))]);
    return {
        points: g.points.filter((p) => !gone.has(p.id)),
        curves,
        constraints: g.constraints.filter((c) => !constraintRefs(c).some((r) => gone.has(r))),
    };
}

/** Applies the fix of one problem. */
export function fixProblem(g: SketchGeometry, problem: Problem): SketchGeometry {
    const [kind, ...ids] = problem.key.split(':');
    switch (kind as ProblemKind) {
        case 'gap':
            return mergePoints(g, ids[0], ids[1]);
        case 'duplicate':
            return removeCurve(g, ids[0]);
        case 'overlap': {
            // The first line takes the whole span; the second goes.
            const [a, b] = [curveOf(g, ids[0]), curveOf(g, ids[1])];
            const span = a && b ? overlapSpan(g, a, b) : null;
            if (!span || a?.kind !== 'line') {
                return g;
            }
            const merged = { ...g, curves: g.curves.map((c) => (c.id === a.id ? { ...a, a: span[0], b: span[1] } : c)) };
            // Its length and middle no longer hold.
            const out = removeCurve(merged, ids[1]);
            const used = new Set(out.curves.flatMap(curvePoints));
            const gone = new Set([a.a, a.b].filter((p) => !used.has(p) && p !== ORIGIN));
            return {
                points: out.points.filter((p) => !gone.has(p.id)),
                curves: out.curves,
                constraints: out.constraints.filter((k) => !constraintRefs(k).some((r) => gone.has(r))
                    && !((k.kind === 'length' || k.kind === 'midpoint') && k.line === a.id)),
            };
        }
        case 'zero': {
            const c = curveOf(g, ids[0]);
            if (!c) {
                return g;
            }
            // Its ends become one point, so the curves on either side stay joined.
            const ends = endsOf(c);
            const merged = ends.length === 2 ? mergePoints(g, ends[0], ends[1]) : g;
            return removeCurve(merged, c.id);
        }
        case 'dangling':
            return { ...g, constraints: g.constraints.filter((c) => c.id !== ids[0]) };
    }
}

/** Fixes everything found, one problem at a time (each fix can change what is left). */
export function fixAll(g: SketchGeometry, gap = GAP): { g: SketchGeometry; fixed: number } {
    let out = g;
    let fixed = 0;
    const tried = new Set<string>();
    for (let i = 0; i < 1000; i++) {
        const next = findProblems(out, gap).find((p) => !tried.has(p.key));
        if (!next) {
            break;
        }
        tried.add(next.key);
        out = fixProblem(out, next);
        fixed += 1;
    }
    return { g: out, fixed };
}

// ---- Fully define ---------------------------------------------------------------------------------------

/** Dimensions to try, in order: the sketch's place (from the origin), then sizes, then every point's position. */
function candidates(g: SketchGeometry): NewConstraint[] {
    const used = new Set(g.curves.flatMap(curvePoints));
    const drawn = [...g.curves.filter((c) => !c.construction), ...g.curves.filter((c) => c.construction)];
    const first = drawn[0] ? curvePoints(drawn[0]).find((id) => id !== ORIGIN) : g.points.find((p) => p.id !== ORIGIN)?.id;
    // Held at the origin already: no anchor needed.
    const anchor = used.has(ORIGIN) ? null : first ?? null;
    const base = anchor ?? ORIGIN;
    const zero: NewConstraint[] = [];
    const along = (a: string, b: string, axis: 'u' | 'v', keepZero: boolean): NewConstraint[] => {
        const [pa, pb] = [P(g, a), P(g, b)];
        const d = Math.abs(axis === 'u' ? pb[0] - pa[0] : pb[1] - pa[1]);
        if (d > 1e-6) {
            return [{ kind: 'distance', a, b, axis, value: d }];
        }
        // In line with the origin: on the axis; with another point: a zero distance, tried last.
        if (a === ORIGIN) {
            return [{ kind: 'pointOnCurve', point: b, curve: axis === 'u' ? 'axis-v' : 'axis-u' }];
        }
        if (keepZero) {
            zero.push({ kind: 'distance', a, b, axis, value: 0 });
        }
        return [];
    };
    const out: NewConstraint[] = [];
    if (anchor) {
        out.push(...along(ORIGIN, anchor, 'u', false), ...along(ORIGIN, anchor, 'v', false));
    }
    for (const c of drawn) {
        if (c.kind === 'line') {
            out.push({ kind: 'length', line: c.id, value: dist(P(g, c.a), P(g, c.b)) });
        } else {
            out.push({ kind: c.kind === 'circle' ? 'diameter' : 'radius', curve: c.id, value: 0 });
        }
    }
    const points = [...new Set([...drawn.flatMap(curvePoints), ...g.points.map((p) => p.id)])].filter((id) => id !== ORIGIN && id !== base);
    for (const id of points) {
        out.push(...along(base, id, 'u', true), ...along(base, id, 'v', true));
    }
    return [...out, ...zero];
}

/**
 * Adds dimensions until the sketch has no degrees of freedom left: each is kept only when the solver's count drops
 * and it reports no conflict or redundancy. Stops at zero, or when nothing more helps.
 */
export function fullyDefine(g: SketchGeometry, solve: (g: SketchGeometry) => SolveResult = solveGeometry): { g: SketchGeometry; added: number; dof: number } | { error: string } {
    const start = solve(g);
    if (!start.ok) {
        return { error: 'The sketch is over-constrained; fix that first.' };
    }
    let current = start.geometry;
    let dof = start.dof;
    let added = 0;
    for (const candidate of candidates(current)) {
        if (dof <= 0) {
            break;
        }
        // Sizes are measured on the sketch as it is now.
        const value = 'value' in candidate && candidate.kind !== 'distance'
            ? measure(current, { ...candidate, id: 'measuring' } as SketchConstraint) : null;
        const c = value !== null && 'value' in candidate ? { ...candidate, value } as NewConstraint : candidate;
        if ('value' in c && c.kind !== 'distance' && !(c.value > 1e-6)) {
            continue;
        }
        const r = solve(addConstraint(current, c).g);
        if (r.ok && !r.redundant.length && !r.conflicting.length && r.dof < dof) {
            current = r.geometry;
            dof = r.dof;
            added += 1;
        }
    }
    return { g: current, added, dof };
}
