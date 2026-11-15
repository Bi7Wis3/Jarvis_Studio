// Fit Spline (a chain of sketch curves, or model edges brought into the sketch, replaced by one spline within a
// tolerance; Constrained: the spline follows them when they change) and Simplify Spline (a spline with fewer points
// within a tolerance of the original), on the spline maths of @jarvis/core/curves through curveFit.

import type { SketchCurve, SketchGeometry, SketchPoint } from '@jarvis/core';
import { fitSpline, splineCurve, type FitResult, type ParamCurve } from '@jarvis/core/curveFit';
import { curveOf, pointOf } from './solver';
import { closedSpline, splineCoords, splineShapeOf } from './sketchCurves';
import { constraintRefs, newId, removeItemsKeepingPoints } from './sketchGeometry';
import { carryItems, ownerOf } from './sketchItems';
import { curvePieces } from './sketchSplines';
import { curvePointIds } from './sketchCurves';
import { afterSolveSteps } from './solverHooks';
import { pieceDerivatives, piecesLength } from '@jarvis/core/splines';

type Pt = [number, number];

export const MAX_FIT_POINTS = 300;

interface Piece {
    length: number;
    at: (s: number) => Pt;
    from: Pt;
    to: Pt;
}

/** A line or arc as a piece run by arc length, from its start (or reversed: from its end). */
function pieceOf(g: SketchGeometry, c: SketchCurve): Piece | null {
    const P = (id: string): Pt | null => {
        const p = pointOf(g, id);
        return p ? [p.u, p.v] : null;
    };
    if (c.kind === 'line') {
        const [a, b] = [P(c.a), P(c.b)];
        if (!a || !b) {
            return null;
        }
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return { length, from: a, to: b, at: (s) => [a[0] + ((b[0] - a[0]) * s) / length, a[1] + ((b[1] - a[1]) * s) / length] };
    }
    if (c.kind === 'arc') {
        const [o, s0, e0] = [P(c.center), P(c.start), P(c.end)];
        if (!o || !s0 || !e0) {
            return null;
        }
        const r = Math.hypot(s0[0] - o[0], s0[1] - o[1]);
        const a0 = Math.atan2(s0[1] - o[1], s0[0] - o[0]);
        const sweep = ((Math.atan2(e0[1] - o[1], e0[0] - o[0]) - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        return { length: r * sweep, from: s0, to: e0, at: (s) => [o[0] + r * Math.cos(a0 + s / r), o[1] + r * Math.sin(a0 + s / r)] };
    }
    // Any other curve by its exact pieces, each run through by its own parameter scaled to its length.
    const parts = curvePieces(g, c.id);
    if (!parts?.length) {
        return null;
    }
    const lengths = parts.map((k) => piecesLength([k]));
    const starts = [0];
    lengths.forEach((l) => starts.push(starts[starts.length - 1] + l));
    const length = starts[starts.length - 1];
    const at = (s: number): Pt => {
        let i = parts.length - 1;
        while (i > 0 && s < starts[i]) {
            i -= 1;
        }
        const t = lengths[i] > 0 ? Math.min(1, Math.max(0, (s - starts[i]) / lengths[i])) : 0;
        return pieceDerivatives(parts[i], t).at as Pt;
    };
    return { length, from: at(0), to: at(length), at };
}

const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
const flip = (p: Piece): Piece => ({ length: p.length, from: p.to, to: p.from, at: (s) => p.at(p.length - s) });

/** The lines and arcs as one chain by arc length, the ends where they join, and whether it closes on itself. */
export function chainCurve(g: SketchGeometry, ids: string[]): { f: ParamCurve; length: number; joints: number[]; closed: boolean } | string {
    if (!ids.length) {
        return 'Pick the sketch curves (or model edges) to fit.';
    }
    const pieces: Piece[] = [];
    for (const id of ids) {
        const c = curveOf(g, id);
        if (!c) {
            return 'A picked curve is not in the sketch any more.';
        }
        if (ownerOf(g, id)) {
            return 'Text, equation curves and blocks cannot be fitted.';
        }
        const p = pieceOf(g, c);
        if (!p || !(p.length > 0)) {
            return 'A picked entity has no length.';
        }
        pieces.push(p);
    }
    const rest = [...pieces];
    let chain = [rest.shift()!];
    while (rest.length) {
        const [first, last] = [chain[0], chain[chain.length - 1]];
        const k = rest.findIndex((p) => near(p.from, last.to) || near(p.to, last.to) || near(p.to, first.from) || near(p.from, first.from));
        if (k < 0) {
            return 'The entities must join end to end in one chain.';
        }
        const [p] = rest.splice(k, 1);
        if (near(p.from, last.to)) {
            chain = [...chain, p];
        } else if (near(p.to, last.to)) {
            chain = [...chain, flip(p)];
        } else if (near(p.to, first.from)) {
            chain = [p, ...chain];
        } else {
            chain = [flip(p), ...chain];
        }
    }
    const starts = [0];
    for (const p of chain) {
        starts.push(starts[starts.length - 1] + p.length);
    }
    const length = starts[starts.length - 1];
    const f: ParamCurve = (s) => {
        let i = chain.length - 1;
        while (i > 0 && s < starts[i]) {
            i -= 1;
        }
        return chain[i].at(Math.min(chain[i].length, Math.max(0, s - starts[i])));
    };
    return { f, length, joints: starts, closed: near(chain[0].from, chain[chain.length - 1].to) };
}

/** The fit of a chain: through its joints and as many more points as the tolerance needs. */
export function fitChain(g: SketchGeometry, ids: string[], tolerance: number): FitResult | string {
    const chain = chainCurve(g, ids);
    if (typeof chain === 'string') {
        return chain;
    }
    if (!(tolerance > 0)) {
        return 'The tolerance must be above zero.';
    }
    const params = [...new Set(chain.joints.flatMap((s, i) => (i ? [(chain.joints[i - 1] + s) / 2, s] : [s])))];
    return fitSpline(chain.f, 0, chain.length, { tolerance, maxPoints: MAX_FIT_POINTS, params });
}

export type FitKeep = 'delete' | 'constrained' | 'unconstrained' | 'fixed';

/**
 * The sketch with the fitted spline added: the originals deleted, or kept as construction (the spline then linked to
 * them, free, or fixed). Returns the new spline's id.
 */
export function applyFit(g: SketchGeometry, ids: string[], fit: FitResult, keep: FitKeep, tolerance = 0.01): { g: SketchGeometry; id: string } {
    // Constrained: its points are placed by the fit (fixed for the solver), fitted again when the curves change.
    const held = keep === 'fixed' || keep === 'constrained';
    // Deleted: with their relations and the points nothing else uses (the sketch's other items stay).
    let out: SketchGeometry = keep === 'delete'
        ? carryItems(g, removeItemsKeepingPoints(g, ids))
        : { ...g, curves: g.curves.map((c) => (ids.includes(c.id) ? { ...c, construction: true } : c)) };
    const pts = fit.closed ? fit.points.slice(0, -1) : fit.points;
    const points: SketchPoint[] = [];
    const ring: string[] = [];
    pts.forEach((p, i) => {
        // The chain's open ends, where something else still joins them, stay those points (and stay joined).
        const end = keep === 'delete' && !fit.closed && (i === 0 || i === pts.length - 1)
            ? out.points.find((q) => Math.hypot(q.u - p[0], q.v - p[1]) < 1e-9) : undefined;
        if (end) {
            ring.push(end.id);
            return;
        }
        const id = newId('p', { ...out, points: [...out.points, ...points] });
        points.push({ id, u: p[0], v: p[1], ...(held ? { fixed: true } : {}) });
        ring.push(id);
    });
    out = { ...out, points: [...out.points, ...points] };
    const handles: Partial<Record<'startHandle' | 'endHandle', string>> = {};
    for (const [key, at] of [['startHandle', fit.handles.start], ['endHandle', fit.handles.end]] as const) {
        if (at) {
            const id = newId('p', out);
            out = { ...out, points: [...out.points, { id, u: at[0], v: at[1], ...(held ? { fixed: true } : {}) }] };
            handles[key] = id;
        }
    }
    const id = newId('c', out);
    const link = keep === 'constrained' ? { fit: { curves: [...ids], tolerance } } : {};
    out = { ...out, curves: [...out.curves, { id, kind: 'spline', points: fit.closed ? [...ring, ring[0]] : ring, ...handles, ...link }] };
    linked.set(id, sourceKey(out, ids));
    return { g: out, id };
}

/** Where the curves a linked fit spline follows were when it was last fitted (by spline id). */
const linked = new Map<string, string>();

function sourceKey(g: SketchGeometry, ids: string[]): string {
    const points = new Set(ids.flatMap((id) => {
        const c = curveOf(g, id);
        return c ? curvePointIds(c) : [];
    }));
    return JSON.stringify([ids, g.points.filter((p) => points.has(p.id)).map((p) => [p.id, p.u, p.v])]);
}

/**
 * After a solve: each Constrained fit spline whose curves moved is fitted to them again (its points and end handles
 * placed by the new fit; the same points when it has as many, else new ones).
 */
export function holdFits(g: SketchGeometry): SketchGeometry {
    let out = g;
    for (const c of g.curves) {
        if (c.kind !== 'spline' || !c.fit || !c.fit.curves.every((id) => curveOf(out, id))) {
            continue;
        }
        const key = sourceKey(out, c.fit.curves);
        if (linked.get(c.id) === key) {
            continue;
        }
        linked.set(c.id, key);
        const fit = fitChain(out, c.fit.curves, c.fit.tolerance);
        if (typeof fit === 'string') {
            continue;
        }
        out = refitted(out, c, fit);
    }
    return out;
}

function refitted(g: SketchGeometry, c: Extract<SketchCurve, { kind: 'spline' }>, fit: FitResult): SketchGeometry {
    const pts = fit.closed ? fit.points.slice(0, -1) : fit.points;
    const ids = closedSpline(c) ? c.points.slice(0, -1) : c.points;
    let out = g;
    let ring = ids;
    if (ids.length === pts.length && closedSpline(c) === fit.closed) {
        const at = new Map(ids.map((id, i) => [id, pts[i]]));
        out = { ...out, points: out.points.map((p) => (at.has(p.id) ? { ...p, u: at.get(p.id)![0] + 0, v: at.get(p.id)![1] + 0 } : p)) };
    } else {
        // A different number of points: new ones in place of the old (nothing else holds a fit spline's points).
        const old = new Set(ids);
        out = { ...out, points: out.points.filter((p) => !old.has(p.id)) };
        ring = pts.map((p) => {
            const id = newId('p', out);
            out = { ...out, points: [...out.points, { id, u: p[0] + 0, v: p[1] + 0, fixed: true }] };
            return id;
        });
    }
    const curve: Extract<SketchCurve, { kind: 'spline' }> = { ...c, points: fit.closed ? [...ring, ring[0]] : ring };
    for (const [key, at] of [['startHandle', fit.handles.start], ['endHandle', fit.handles.end]] as const) {
        const has = curve[key];
        if (at && has) {
            out = { ...out, points: out.points.map((p) => (p.id === has ? { ...p, u: at[0] + 0, v: at[1] + 0 } : p)) };
        } else if (at) {
            const id = newId('p', out);
            out = { ...out, points: [...out.points, { id, u: at[0] + 0, v: at[1] + 0, fixed: true }] };
            curve[key] = id;
        } else if (has) {
            out = { ...out, points: out.points.filter((p) => p.id !== has) };
            delete curve[key];
        }
    }
    return { ...out, curves: out.curves.map((k) => (k.id === c.id ? curve : k)) };
}

afterSolveSteps.push(holdFits);

// ---- Simplify Spline ---------------------------------------------------------------------------------------------

/** A spline of the sketch as a curve, with its points and handles. */
export function splineOf(g: SketchGeometry, id: string): { f: ParamCurve; pieces: number; points: Pt[]; closed: boolean; handles: { start?: Pt; end?: Pt } } | string {
    const c = curveOf(g, id);
    if (c?.kind !== 'spline') {
        return 'Select a spline (Simplify spline works on splines through points).';
    }
    if (ownerOf(g, id)) {
        return 'This spline belongs to an equation curve or a block: edit that instead.';
    }
    const points = splineCoords(g, c);
    if (!points) {
        return 'The spline is missing points.';
    }
    const P = (pid?: string): Pt | undefined => {
        const p = pid ? pointOf(g, pid) : undefined;
        return p ? [p.u, p.v] : undefined;
    };
    const closed = closedSpline(c);
    const handles = { start: P(c.startHandle), end: P(c.endHandle) };
    const { f, pieces } = splineCurve(points, closed, splineShapeOf(g, c));
    return { f, pieces, points, closed, handles };
}

/** Fewer points within the tolerance of the original spline (ends kept, end slopes kept). */
export function simplifySpline(g: SketchGeometry, id: string, tolerance: number): FitResult | string {
    const s = splineOf(g, id);
    if (typeof s === 'string') {
        return s;
    }
    if (!(tolerance > 0)) {
        return 'The tolerance must be above zero.';
    }
    return fitSpline(s.f, 0, s.pieces, { tolerance, maxPoints: Math.max(2, s.points.length), start: s.closed ? 4 : 2 });
}

/** Smooth: every other inner point of the last result left out (down to the two ends), with the deviation. */
export function smoothStep(g: SketchGeometry, id: string, last: FitResult): FitResult | string {
    const s = splineOf(g, id);
    if (typeof s === 'string') {
        return s;
    }
    const keep = last.params.filter((_, i) => i === 0 || i === last.params.length - 1 || i % 2 === 0);
    const minimum = s.closed ? 4 : 2;
    if (keep.length < minimum || keep.length === last.params.length) {
        return 'The spline cannot be smoothed further.';
    }
    return fitSpline(s.f, 0, s.pieces, { tolerance: Infinity, params: keep, maxPoints: keep.length });
}

/** The spline replaced by the simplified one: the same curve id and end points, new points in between. */
export function applySimplify(g: SketchGeometry, id: string, fit: FitResult): SketchGeometry | string {
    const c = curveOf(g, id);
    if (c?.kind !== 'spline') {
        return 'The spline is gone.';
    }
    const fixed = c.points.every((pid) => pointOf(g, pid)?.fixed);
    const pts = fit.closed ? fit.points.slice(0, -1) : fit.points;
    const ends = new Set([c.points[0], c.points[c.points.length - 1]]);
    const old = new Set([...c.points.filter((p) => !ends.has(p)), ...(c.startHandle ? [c.startHandle] : []), ...(c.endHandle ? [c.endHandle] : []), ...(c.handles ?? []).map((h) => h.handle)]);
    let out: SketchGeometry = {
        ...g,
        points: g.points.filter((p) => !old.has(p.id)),
        constraints: g.constraints.filter((k) => !constraintRefs(k).some((r) => old.has(r))),
    };
    const ids: string[] = [];
    pts.forEach((p, i) => {
        if (i === 0) {
            ids.push(c.points[0]);
        } else if (!fit.closed && i === pts.length - 1) {
            ids.push(c.points[c.points.length - 1]);
        } else {
            const pid = newId('p', out);
            out = { ...out, points: [...out.points, { id: pid, u: p[0], v: p[1], ...(fixed ? { fixed: true } : {}) }] };
            ids.push(pid);
        }
    });
    const handles: Partial<Record<'startHandle' | 'endHandle', string>> = {};
    for (const [key, at] of [['startHandle', fit.handles.start], ['endHandle', fit.handles.end]] as const) {
        if (at) {
            const pid = newId('p', out);
            out = { ...out, points: [...out.points, { id: pid, u: at[0], v: at[1], ...(fixed ? { fixed: true } : {}) }] };
            handles[key] = pid;
        }
    }
    // The simplified spline is a new fit: the old handles, held curvatures and spacing do not apply to it.
    const { startHandle: _s, endHandle: _e, handles: _h, curvature: _k, spacing: _p, ...rest } = c;
    const next: SketchCurve = { ...rest, points: fit.closed ? [...ids, ids[0]] : ids, ...handles };
    return { ...out, curves: out.curves.map((k) => (k.id === id ? next : k)) };
}
