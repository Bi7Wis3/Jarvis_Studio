// Infinite lines (SolidWorks Line > Infinite length): a line that runs on without end beyond one or both of its points
// (`endless`). It is drawn and picked as a very long line, is never part of a profile, and is trimmed into rays and
// pieces; a finite line can be made infinite, an infinite one cannot be made finite (trim it instead).

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { ORIGIN, curveOf, pointOf } from './solver';
import { curveEndIds, curvePointIds, holdsPoints } from './sketchCurves';
import { addConstraint, constraintRefs, extentHeld, newId } from './sketchGeometry';
import type { NewEntity, Pt } from './sketchMath';
import { crossings, type CurveGeom } from '@jarvis/core/curveIntersect';

type Line = Extract<SketchCurve, { kind: 'line' }>;
export type Endless = NonNullable<Line['endless']>;

/** How far an infinite line is drawn and intersected beyond its points, mm (a hundred metres). */
export const REACH = 1e5;
/** Positions closer than this are the same point. */
const SAME = 1e-5;

export const isEndless = (c: SketchCurve | undefined | null): c is Line & { endless: Endless } => c?.kind === 'line' && !!c.endless;

const runsA = (e: Line['endless']) => e === 'a' || e === 'both';
const runsB = (e: Line['endless']) => e === 'b' || e === 'both';

/** The two points an infinite line is drawn between: REACH beyond each endless side. */
export function endlessEnds(a: Pt, b: Pt, endless: Line['endless']): [Pt, Pt] {
    if (!endless) {
        return [a, b];
    }
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d: Pt = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    return [
        runsA(endless) ? [a[0] - d[0] * REACH, a[1] - d[1] * REACH] : a,
        runsB(endless) ? [b[0] + d[0] * REACH, b[1] + d[1] * REACH] : b,
    ];
}

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** Relations that hold how far a line reaches, which an infinite line does not have. */
function holdsExtent(k: SketchConstraint, line: string, lines: Set<string>): boolean {
    return (k.kind === 'length' && k.line === line) || (k.kind === 'midpoint' && k.line === line) || extentHeld(k, line)
        || (k.kind === 'equal' && (k.a === line || k.b === line) && lines.has(k.a) && lines.has(k.b))
        || (k.kind === 'pathLength' && k.curves.includes(line));
}

/** Line Properties > Infinite length: the line runs on without end both ways; what held its length goes. */
export function makeEndless(g: SketchGeometry, id: string): SketchGeometry | { error: string } {
    const c = curveOf(g, id);
    if (c?.kind !== 'line') {
        return { error: 'Infinite length is for lines.' };
    }
    if (c.endless === 'both') {
        return { error: 'That line is infinite already.' };
    }
    if (g.paths?.some((p) => p.curves.includes(id))) {
        return { error: 'A line of a path cannot be infinite: delete the path first.' };
    }
    const lines = new Set(g.curves.filter((k) => k.kind === 'line').map((k) => k.id));
    return {
        ...g,
        curves: g.curves.map((k) => (k.id === id ? { ...c, endless: 'both' } : k)),
        constraints: g.constraints.filter((k) => !holdsExtent(k, id, lines)),
    };
}

/** The lines a draw tool just made (in `after`, not in `before`) as infinite lines, without the lengths it gave them. */
export function markEndless(before: SketchGeometry, after: SketchGeometry): SketchGeometry {
    const old = new Set(before.curves.map((c) => c.id));
    const fresh = new Set(after.curves.filter((c) => c.kind === 'line' && !old.has(c.id)).map((c) => c.id));
    const lines = new Set(after.curves.filter((k) => k.kind === 'line').map((k) => k.id));
    return {
        ...after,
        curves: after.curves.map((c) => (fresh.has(c.id) && c.kind === 'line' ? { ...c, endless: 'both' as const } : c)),
        constraints: after.constraints.filter((k) => ![...fresh].some((id) => holdsExtent(k, id, lines))),
    };
}

// ---- Trimming ----------------------------------------------------------------------------------------------

export interface TrimTools {
    /** Other curves' exact shapes (sketchCut's geomOfCurve), which the line is met with. */
    geomOf: (g: SketchGeometry, c: SketchCurve) => CurveGeom | null;
}

/** A line along its own frame: s is the distance from point a toward b. */
function frame(g: SketchGeometry, c: Line) {
    const [a, b] = [P(g, c.a), P(g, c.b)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const s = (p: Pt) => (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1];
    const at = (t: number): Pt => [a[0] + d[0] * t, a[1] + d[1] * t];
    return { a, b, len, d, s, at, min: runsA(c.endless) ? -Infinity : 0, max: runsB(c.endless) ? Infinity : len };
}

interface Cut {
    s: number;
    at: Pt;
    by: string;
    point?: string;
}

/** Where other curves cross or touch the line (on its whole reach), sorted along it; its finite ends left out. */
function cutsOn(g: SketchGeometry, c: Line, tools: TrimTools): Cut[] {
    const f = frame(g, c);
    const [p, q] = endlessEnds(f.a, f.b, c.endless);
    const shape: CurveGeom = { kind: 'line', a: p, b: q };
    const cuts: Cut[] = [];
    const add = (cut: Cut) => {
        const atEnd = (Number.isFinite(f.min) && Math.abs(cut.s - f.min) < SAME) || (Number.isFinite(f.max) && Math.abs(cut.s - f.max) < SAME);
        if (atEnd || cut.s < f.min || cut.s > f.max) {
            return;
        }
        const same = cuts.findIndex((k) => Math.abs(k.s - cut.s) < SAME);
        if (same < 0) {
            cuts.push(cut);
        } else if (cut.point && !cuts[same].point) {
            cuts[same] = cut;
        }
    };
    const own = new Set(curvePointIds(c));
    for (const other of g.curves) {
        if (other.id === c.id) {
            continue;
        }
        const og = tools.geomOf(g, other);
        for (const x of og ? crossings(shape, og) : []) {
            add({ s: f.s(x.at), at: x.at, by: other.id });
        }
        for (const id of curveEndIds(other)) {
            const e = P(g, id);
            const t = f.s(e);
            const foot = f.at(t);
            if (!own.has(id) && Math.hypot(e[0] - foot[0], e[1] - foot[1]) < 1e-4) {
                add({ s: t, at: e, by: other.id, point: id });
            }
        }
    }
    return cuts.sort((x, y) => x.s - y.s);
}

/** Builds the pieces of an infinite (or finite) line between places along it, keeping what can be kept. */
function pieces(g0: SketchGeometry, c: Line) {
    let g = g0;
    const f = frame(g0, c);
    const point = (at: Pt): string => {
        const id = newId('p', g);
        g = { ...g, points: [...g.points, { id, u: at[0], v: at[1] }] };
        return id;
    };
    /** The line from `lo` to `hi` (null: no end that way), its finite ends given by their point ids. */
    const span = (lo: { s: number; id: string } | null, hi: { s: number; id: string } | null): Omit<Line, 'id' | 'kind'> => {
        const step = Math.max(f.len, 10);
        // A side without end needs a second point on the line: the line's own point when it is on this piece.
        const a = lo?.id ?? (f.min === -Infinity && hi && hi.s > SAME ? c.a : point(f.at((hi?.s ?? 0) - step)));
        const b = hi?.id ?? (lo && f.len > lo.s + SAME ? c.b : point(f.at((lo?.s ?? 0) + step)));
        const endless: Line['endless'] = !lo && !hi ? 'both' : !lo ? 'a' : !hi ? 'b' : undefined;
        return { a, b, ...(endless ? { endless } : {}), ...(c.construction ? { construction: true } : {}) };
    };
    return {
        get g() {
            return g;
        },
        set g(next: SketchGeometry) {
            g = next;
        },
        f,
        span,
    };
}

/** Removes the line's old points when nothing uses them any more, with what referred to them. */
function dropLoose(g: SketchGeometry, ids: string[]): SketchGeometry {
    const used = new Set(g.curves.flatMap(curvePointIds));
    const gone = new Set(ids.filter((id) => id !== ORIGIN && !used.has(id)));
    return gone.size ? {
        ...g,
        points: g.points.filter((p) => !gone.has(p.id)),
        constraints: g.constraints.filter((k) => !constraintRefs(k).some((r) => gone.has(r))),
    } : g;
}

/**
 * Trim to closest on an infinite line or ray: the piece round `at` between the nearest crossings goes; what is left
 * keeps running on without end where the line did. Nothing crossing it: the whole line goes. `construction` keeps the
 * removed piece as construction geometry.
 */
export function trimEndless(g: SketchGeometry, id: string, at: Pt, tools: TrimTools, construction = false): { g: SketchGeometry; removed: NewEntity } | null {
    const c = curveOf(g, id);
    if (c?.kind !== 'line') {
        return null;
    }
    const cuts = cutsOn(g, c, tools);
    const b = pieces(g, c);
    const f = b.f;
    const s0 = f.s(at);
    const lower = [...cuts].reverse().find((k) => k.s < s0) ?? null;
    const upper = cuts.find((k) => k.s > s0) ?? null;
    const reach = (s: number) => f.at(Math.max(-REACH, Math.min(REACH + f.len, s)));
    const removed: NewEntity = { kind: 'line', a: reach(lower?.s ?? f.min), b: reach(upper?.s ?? f.max) };
    const keep = construction && !c.construction;
    if (!lower && !upper) {
        const out = keep ? { ...g, curves: g.curves.map((k) => (k.id === id ? { ...c, construction: true } : k)) }
            : dropLoose({ ...g, curves: g.curves.filter((k) => k.id !== id), constraints: g.constraints.filter((k) => !constraintRefs(k).includes(id)) }, [c.a, c.b]);
        return { g: out, removed };
    }
    const pointAt = (cut: Cut): string => {
        if (cut.point) {
            return cut.point;
        }
        const pid = newId('p', b.g);
        let out: SketchGeometry = { ...b.g, points: [...b.g.points, { id: pid, u: cut.at[0], v: cut.at[1] }] };
        if (holdsPoints(out, cut.by)) {
            out = addConstraint(out, { kind: 'pointOnCurve', point: pid, curve: cut.by }).g;
        }
        b.g = out;
        return pid;
    };
    const lo = lower ? { s: lower.s, id: pointAt(lower) } : null;
    const hi = upper ? { s: upper.s, id: pointAt(upper) } : null;
    // The part before the removed piece (from the line's start, or without end) and the part after it.
    const before = lo ? b.span(Number.isFinite(f.min) ? { s: 0, id: c.a } : null, lo) : null;
    const after = hi ? b.span(hi, Number.isFinite(f.max) ? { s: f.len, id: c.b } : null) : null;
    const ghost = keep ? b.span(lo ?? (Number.isFinite(f.min) ? { s: 0, id: c.a } : null), hi ?? (Number.isFinite(f.max) ? { s: f.len, id: c.b } : null)) : null;
    let out = b.g;
    const put = (curve: Line) => {
        out = { ...out, curves: out.curves.some((k) => k.id === curve.id) ? out.curves.map((k) => (k.id === curve.id ? curve : k)) : [...out.curves, curve] };
    };
    const keepId = before ? id : null;
    if (before) {
        put({ id, kind: 'line', ...before });
    }
    if (after) {
        const second = keepId ? newId('c', out) : id;
        put({ id: second, kind: 'line', ...after });
        if (keepId) {
            // The second piece stays on the first one's line.
            const on = new Set(out.constraints.flatMap((k) => (k.kind === 'pointOnCurve' && k.curve === id ? [k.point] : [])));
            const first = curveOf(out, id) as Line;
            for (const p of [after.a, after.b].filter((p) => !on.has(p) && p !== first.a && p !== first.b)) {
                out = addConstraint(out, { kind: 'pointOnCurve', point: p, curve: id }).g;
            }
        }
    }
    if (ghost) {
        put({ id: newId('c', out), kind: 'line', ...ghost, construction: true });
    }
    // A point on the line that is now one of its own ends needs no point-on-curve relation.
    out = { ...out, constraints: out.constraints.filter((k) => !(k.kind === 'pointOnCurve' && k.curve === id && curveEndIds(curveOf(out, id)!).includes(k.point))) };
    return { g: dropLoose(out, [c.a, c.b]), removed };
}

/**
 * Trim to a corner where one or both lines run on without end: each keeps the side of the corner where it was
 * clicked (without end if it ran on that way), and both end at one shared corner point.
 */
export function cornerEndless(g: SketchGeometry, pa: { id: string; at: Pt }, pb: { id: string; at: Pt }): { g: SketchGeometry } | { error: string } {
    const [la, lb] = [curveOf(g, pa.id), curveOf(g, pb.id)];
    if (la?.kind !== 'line' || lb?.kind !== 'line' || pa.id === pb.id) {
        return { error: 'Corner works on two lines.' };
    }
    const [fa, fb] = [frame(g, la), frame(g, lb)];
    const den = fa.d[0] * fb.d[1] - fa.d[1] * fb.d[0];
    if (Math.abs(den) < 1e-12) {
        return { error: 'The lines are parallel; they have no corner.' };
    }
    const w: Pt = [fb.a[0] - fa.a[0], fb.a[1] - fa.a[1]];
    const x = fa.at((w[0] * fb.d[1] - w[1] * fb.d[0]) / den);
    let out = g;
    const corner = newId('p', out);
    out = { ...out, points: [...out.points, { id: corner, u: x[0], v: x[1] }] };
    const lines = new Set(g.curves.filter((k) => k.kind === 'line').map((k) => k.id));
    for (const [c, pick] of [[la, pa], [lb, pb]] as const) {
        const b = pieces(out, c);
        const f = b.f;
        const sx = f.s(x);
        // The clicked side of the corner stays.
        const ahead = f.s(pick.at) > sx;
        const span = ahead ? b.span({ s: sx, id: corner }, Number.isFinite(f.max) ? { s: f.len, id: c.b } : null)
            : b.span(Number.isFinite(f.min) ? { s: 0, id: c.a } : null, { s: sx, id: corner });
        out = b.g;
        out = { ...out, curves: out.curves.map((k) => (k.id === c.id ? { id: c.id, kind: 'line', ...span } : k)) };
        // What held the old ends or the length goes, as Extend drops it.
        out = { ...out, constraints: out.constraints.filter((k) => !holdsExtent(k, c.id, lines)) };
        out = dropLoose(out, [c.a, c.b]);
    }
    return { g: out };
}
