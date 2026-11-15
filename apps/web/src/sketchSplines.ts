// What the spline commands change in the sketch (SolidWorks Spline Tools and the Spline PropertyManager): spline
// handles at any point (direction and the weight of each side), curvature control, Reset and Relax, the control
// polygon of a spline through points, Convert spline types, and the exact pieces of any sketch curve that the
// curvature tools (combs, inflection points, minimum radius) measure. The curve maths is @jarvis/core/splines,
// which the kernel builds from too.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { conicWeight, ellipseParam, segmentShape } from '@jarvis/core/curves';
import {
    bsplineAsPieces, cubicPieces, elevateBezier, handleAt, innerKnots, knotMultiplicities, knotVector, nurbsPieces, pieceCurvature,
    pieceDerivatives, piecesLength, solveSpline, spacingFor, splineAsBSpline, splitPiece, type BezierPiece,
} from '@jarvis/core/splines';
import { curveOf, pointOf } from './solver';
import { closedSpline, curveSegment, ellipseOfCurve, isExtra, styleDegree } from './sketchCurves';
import { newId, removeItems } from './sketchGeometry';

type Pt = [number, number];
export type Spline = Extract<SketchCurve, { kind: 'spline' }>;
export type StyleSpline = Extract<SketchCurve, { kind: 'styleSpline' }>;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const dist = (a: Pt, b: Pt) => len(sub(a, b));
const P = (g: SketchGeometry, id: string): Pt | null => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : null;
};

function withCurve(g: SketchGeometry, c: SketchCurve): SketchGeometry {
    return { ...g, curves: g.curves.map((k) => (k.id === c.id ? c : k)) };
}

function addPoint(g: SketchGeometry, at: Pt, fixed = false): { g: SketchGeometry; id: string } {
    const id = newId('p', g);
    return { g: { ...g, points: [...g.points, { id, u: at[0] + 0, v: at[1] + 0, ...(fixed ? { fixed: true } : {}) }] }, id };
}

function movePoint(g: SketchGeometry, id: string, at: Pt): SketchGeometry {
    return { ...g, points: g.points.map((p) => (p.id === id ? { ...p, u: at[0] + 0, v: at[1] + 0 } : p)) };
}

/** The spline's distinct points (a closed one's first point once). */
export const splinePointIds = (c: Spline): string[] => (closedSpline(c) ? c.points.slice(0, -1) : c.points);

// ---- The solved shape ---------------------------------------------------------------------------------------------

export interface SolvedSpline {
    c: Spline;
    /** The distinct points, in order. */
    pts: Pt[];
    closed: boolean;
    /** Cubic Bezier pieces in a row, and the parameter span of each. */
    poles: Pt[];
    spans: number[];
    /** Points where a held curvature or the continuity has no free spline point to come from. */
    unmet: number[];
}

export function solvedSpline(g: SketchGeometry, c: Spline): SolvedSpline | null {
    const s = curveSegment(g, c);
    if (!s || s.seg.kind !== 'spline') {
        return null;
    }
    const closed = closedSpline(c);
    const pts = [s.from, ...s.seg.through, ...(closed ? [] : [s.seg.to])] as Pt[];
    const r = solveSpline(pts, closed, segmentShape(s.seg));
    return { c, pts, closed, poles: r.poles as Pt[], spans: r.spans, unmet: r.unmet };
}

// ---- Handles ------------------------------------------------------------------------------------------------------

export type HandleKind = 'start' | 'end' | 'inner';

export interface HandleInfo {
    index: number;
    point: string;
    kind: HandleKind;
    /** Active: it holds its direction and weights (SolidWorks: the handle was dragged or set; Tangent driving). */
    active: boolean;
    at: Pt;
    /** The control points either side of the point now (null where the spline has no side). */
    prev: Pt | null;
    next: Pt | null;
    /** The point an active handle is built on (the end of the side after it; at the end of a spline, before it). */
    handlePoint: string | null;
    /** The curvature held there (Add Curvature Control), if any. */
    curvature: number | null;
}

export function handleInfo(g: SketchGeometry, c: Spline, i: number, solved = solvedSpline(g, c)): HandleInfo | null {
    const ids = splinePointIds(c);
    if (!solved || i < 0 || i >= ids.length) {
        return null;
    }
    const point = ids[i];
    const closed = solved.closed;
    const kind: HandleKind = !closed && i === 0 ? 'start' : !closed && i === ids.length - 1 ? 'end' : 'inner';
    const inner = c.handles?.find((h) => h.point === point);
    const handlePoint = kind === 'start' ? c.startHandle ?? null : kind === 'end' ? c.endHandle ?? null : inner?.handle ?? null;
    const arms = handleAt(solved.poles, closed, i);
    return {
        index: i, point, kind, active: !!handlePoint, at: solved.pts[i], prev: arms.prev as Pt | null, next: arms.next as Pt | null,
        handlePoint, curvature: c.curvature?.find((k) => k.point === point)?.value ?? null,
    };
}

/** A handle's direction (radians from +X) and weights: the lengths of its side before and after the point (mm). */
export function handleValues(h: HandleInfo): { angle: number; before: number | null; after: number | null } {
    const d = h.next ? sub(h.next, h.at) : h.prev ? sub(h.at, h.prev) : [1, 0] as Pt;
    return { angle: Math.atan2(d[1], d[0]), before: h.prev ? dist(h.at, h.prev) : null, after: h.next ? dist(h.next, h.at) : null };
}

/** The sketch with the handle at point i made active as the curve is now (its shape does not change). */
export function activateHandle(g: SketchGeometry, c: Spline, i: number): { g: SketchGeometry; c: Spline } {
    const h = handleInfo(g, c, i);
    if (!h || h.active) {
        return { g, c };
    }
    if (h.kind === 'start' && h.next) {
        const r = addPoint(g, h.next);
        const next: Spline = { ...c, startHandle: r.id };
        return { g: withCurve(r.g, next), c: next };
    }
    if (h.kind === 'end' && h.prev) {
        const r = addPoint(g, h.prev);
        const next: Spline = { ...c, endHandle: r.id };
        return { g: withCurve(r.g, next), c: next };
    }
    if (!h.prev || !h.next || !(dist(h.next, h.at) > 1e-12)) {
        return { g, c };
    }
    const r = addPoint(g, h.next);
    const next: Spline = { ...c, handles: [...(c.handles ?? []), { point: h.point, handle: r.id, back: dist(h.at, h.prev) / dist(h.next, h.at) }] };
    return { g: withCurve(r.g, next), c: next };
}

/**
 * The handle at point i set to a direction and weights (left out: as they are), made active first: where its point
 * goes, and the curve as it is then. Weights are the lengths of the sides before and after the point.
 */
export function handleEdit(g: SketchGeometry, c: Spline, i: number, v: { angle?: number; before?: number; after?: number }):
    { g: SketchGeometry; c: Spline; targets: { point: string; u: number; v: number }[] } | { error: string } {
    const active = activateHandle(g, c, i);
    const h = handleInfo(active.g, active.c, i);
    if (!h?.handlePoint) {
        return { error: 'This spline point has no handle to set.' };
    }
    const now = handleValues(h);
    const angle = v.angle ?? now.angle;
    const before = v.before ?? now.before ?? 0;
    const after = v.after ?? now.after ?? 0;
    if ((h.kind !== 'end' && !(after > 0)) || (h.kind === 'end' && !(before > 0)) || before < 0) {
        return { error: 'Tangent weighting must be above zero.' };
    }
    const d: Pt = [Math.cos(angle), Math.sin(angle)];
    if (h.kind === 'end') {
        return { g: active.g, c: active.c, targets: [{ point: h.handlePoint, u: h.at[0] - d[0] * before, v: h.at[1] - d[1] * before }] };
    }
    const next = add(h.at, mul(d, after));
    if (h.kind !== 'inner') {
        return { g: active.g, c: active.c, targets: [{ point: h.handlePoint, u: next[0], v: next[1] }] };
    }
    // An inner handle's point is the end of the side after the point (before it, on a spline that was reversed).
    const entry = active.c.handles!.find((k) => k.point === h.point)!;
    if (entry.before && !(before > 0)) {
        return { error: 'Tangent weighting must be above zero.' };
    }
    const prev = sub(h.at, mul(d, before));
    const curve: Spline = { ...active.c, handles: active.c.handles!.map((k) => (k === entry ? { ...k, back: entry.before ? after / before : before / after } : k)) };
    const at = entry.before ? prev : next;
    return { g: withCurve(active.g, curve), c: curve, targets: [{ point: h.handlePoint, u: at[0], v: at[1] }] };
}

/** Reset this handle: back to following the curve, its curvature control too. */
export function resetHandle(g: SketchGeometry, c: Spline, i: number): SketchGeometry {
    const h = handleInfo(g, c, i);
    if (!h) {
        return g;
    }
    const curve: Spline = { ...c, curvature: c.curvature?.filter((k) => k.point !== h.point) };
    const out = withCurve(g, curve);
    return h.handlePoint ? removeItems(out, [h.handlePoint]) : out;
}

/** Reset all handles: every handle and curvature control of the spline goes. */
export function resetAllHandles(g: SketchGeometry, c: Spline): SketchGeometry {
    const points = [c.startHandle, c.endHandle, ...(c.handles ?? []).map((h) => h.handle)].filter((p): p is string => !!p);
    const out = withCurve(g, { ...c, curvature: undefined });
    return points.length ? removeItems(out, points) : out;
}

/** The curvature on either side of point i now. */
export function curvatureAtPoint(solved: SolvedSpline, i: number): { before: number | null; after: number | null } {
    const pieces = cubicPieces(solved.poles);
    const count = pieces.length;
    const beforePiece = i > 0 ? i - 1 : solved.closed ? count - 1 : -1;
    const afterPiece = i < count ? i : solved.closed ? 0 : -1;
    return {
        before: beforePiece >= 0 ? pieceCurvature(pieces[beforePiece], 1) : null,
        after: afterPiece >= 0 && afterPiece < count ? pieceCurvature(pieces[afterPiece], 0) : null,
    };
}

/** Curvature control at point i (its handle made active), held at `value` (1/mm); null takes it away. */
export function setCurvature(g: SketchGeometry, c: Spline, i: number, value: number | null): { g: SketchGeometry; c: Spline } {
    const active = value === null ? { g, c } : activateHandle(g, c, i);
    const point = splinePointIds(active.c)[i];
    const rest = (active.c.curvature ?? []).filter((k) => k.point !== point);
    const curve: Spline = { ...active.c, curvature: value === null ? (rest.length ? rest : undefined) : [...rest, { point, value }] };
    return { g: withCurve(active.g, curve), c: curve };
}

// ---- A point added on the curve, the curve kept ------------------------------------------------------------------

/** Where on the solved spline a point is nearest: piece and parameter. */
export function nearestOnSpline(solved: SolvedSpline, at: Pt): { piece: number; t: number; at: Pt; d: number } {
    const pieces = cubicPieces(solved.poles);
    let best = { piece: 0, t: 0, at: solved.pts[0], d: Infinity };
    pieces.forEach((p, k) => {
        for (let s = 0; s <= 48; s++) {
            const q = pieceDerivatives(p, s / 48).at as Pt;
            const d = dist(q, at);
            if (d < best.d) {
                best = { piece: k, t: s / 48, at: q, d };
            }
        }
    });
    // Newton's method on the distance, inside the piece.
    const p = pieces[best.piece];
    let t = best.t;
    for (let it = 0; it < 30; it++) {
        const { at: q, d1, d2 } = pieceDerivatives(p, t);
        const r = sub(q as Pt, at);
        const gr = r[0] * d1[0] + r[1] * d1[1];
        const h = d1[0] * d1[0] + d1[1] * d1[1] + r[0] * d2[0] + r[1] * d2[1];
        if (!(h > 0)) {
            break;
        }
        const next = Math.min(1, Math.max(0, t - gr / h));
        if (Math.abs(next - t) < 1e-15) {
            break;
        }
        t = next;
    }
    const q = pieceDerivatives(p, t).at as Pt;
    return dist(q, at) <= best.d ? { piece: best.piece, t, at: q, d: dist(q, at) } : best;
}

/**
 * A spline point added where the curve passes nearest `at`, the curve kept exactly as it is (its piece split there,
 * the spans stored); with an active handle there (Add Tangency Control) and a held curvature (Add Curvature
 * Control) when asked. Near an existing point, that point takes the handle or curvature instead.
 */
export function splitSplineAt(g: SketchGeometry, c: Spline, at: Pt, o: { handle?: boolean; curvature?: boolean } = {}):
    { g: SketchGeometry; c: Spline; index: number; point: string } | { error: string } {
    const solved = solvedSpline(g, c);
    if (!solved) {
        return { error: 'The spline is missing points.' };
    }
    const near = nearestOnSpline(solved, at);
    const ids = splinePointIds(c);
    const count = solved.spans.length;
    // On a point (or very near it): that point.
    const onPoint = near.t < 1e-6 ? near.piece : near.t > 1 - 1e-6 ? (near.piece + 1) % (solved.closed ? count : count + 1) : -1;
    if (onPoint >= 0) {
        let r = o.handle || o.curvature ? activateHandle(g, c, onPoint) : { g, c };
        if (o.curvature) {
            const k = curvatureAtPoint(solved, onPoint);
            r = setCurvature(r.g, r.c, onPoint, k.after ?? k.before ?? 0);
        }
        return { ...r, index: onPoint, point: ids[onPoint] };
    }
    const k = near.piece;
    const t = near.t;
    const [left, right] = splitPiece({ poles: solved.poles.slice(3 * k, 3 * k + 4) }, t);
    let out = g;
    const added = addPoint(out, left.poles[3] as Pt);
    out = added.g;
    const spans = [...solved.spans.slice(0, k), solved.spans[k] * t, solved.spans[k] * (1 - t), ...solved.spans.slice(k + 1)];
    // Handles either side of the split piece keep the curve's derivative: their side on this piece shrinks with it.
    const [a, b] = [ids[k], ids[(k + 1) % ids.length]];
    const [pa, pb] = [solved.pts[k], solved.pts[(k + 1) % solved.pts.length]];
    let handles = c.handles ? [...c.handles] : undefined;
    const ha = handles?.find((h) => h.point === a);
    if (ha?.before) {
        handles = handles!.map((h) => (h === ha ? { ...h, back: (h.back ?? 1) * t } : h));
    } else if (ha) {
        const q = P(out, ha.handle);
        if (q) {
            out = movePoint(out, ha.handle, add(pa, mul(sub(q, pa), t)));
            handles = handles!.map((h) => (h === ha ? { ...h, back: (h.back ?? 1) / t } : h));
        }
    } else if (k === 0 && !solved.closed && c.startHandle) {
        const q = P(out, c.startHandle);
        if (q) {
            out = movePoint(out, c.startHandle, add(pa, mul(sub(q, pa), t)));
        }
    }
    const hb = handles?.find((h) => h.point === b);
    if (hb?.before) {
        const q = P(out, hb.handle);
        if (q) {
            out = movePoint(out, hb.handle, add(pb, mul(sub(q, pb), 1 - t)));
            handles = handles!.map((h) => (h === hb ? { ...h, back: (h.back ?? 1) / (1 - t) } : h));
        }
    } else if (hb) {
        handles = handles!.map((h) => (h === hb ? { ...h, back: (h.back ?? 1) * (1 - t) } : h));
    } else if (!solved.closed && k === count - 1 && c.endHandle) {
        const q = P(out, c.endHandle);
        if (q) {
            out = movePoint(out, c.endHandle, add(pb, mul(sub(q, pb), 1 - t)));
        }
    }
    const points = [...c.points.slice(0, k + 1), added.id, ...c.points.slice(k + 1)];
    // The pieces keep their parameter spans: as a spacing over the new chords.
    const newPts = [...solved.pts.slice(0, k + 1), left.poles[3] as Pt, ...solved.pts.slice(k + 1)];
    let curve: Spline = { ...c, points, spacing: spacingFor(newPts, solved.closed, spans), ...(handles ? { handles } : {}) };
    out = withCurve(out, curve);
    if (o.handle || o.curvature) {
        const r = addPoint(out, right.poles[1] as Pt);
        out = r.g;
        const mid = left.poles[3] as Pt;
        const back = dist(left.poles[2] as Pt, mid) / (dist(right.poles[1] as Pt, mid) || 1);
        curve = { ...curve, handles: [...(curve.handles ?? []), { point: added.id, handle: r.id, back }] };
        if (o.curvature) {
            curve = { ...curve, curvature: [...(curve.curvature ?? []), { point: added.id, value: pieceCurvature(right, 0) }] };
        }
        out = withCurve(out, curve);
    }
    return { g: out, c: curve, index: k + 1, point: added.id };
}

/** Whether a spline's pieces (with these spans) join C2 at point i: the same first and second derivative either side. */
export function isC2At(poles: Pt[], spans: number[], closed: boolean, i: number): boolean {
    const { prev: l, next: r } = handleAt(poles, closed, i);
    if (!l || !r) {
        return true;
    }
    const pieces = cubicPieces(poles);
    const at = poles[3 * i] ?? poles[0];
    const before = i > 0 ? i - 1 : pieces.length - 1;
    const hl = spans[before];
    const hr = spans[i % spans.length];
    const dl = mul(sub(at, l as Pt), 3 / hl);
    const dr = mul(sub(r as Pt, at), 3 / hr);
    const al = mul(pieceDerivatives(pieces[before], 1).d2 as Pt, 1 / (hl * hl));
    const ar = mul(pieceDerivatives(pieces[i % pieces.length], 0).d2 as Pt, 1 / (hr * hr));
    const size = Math.max(1, ...poles.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1]))));
    return dist(dl, dr) < 1e-9 * size && dist(al, ar) < 1e-9 * size;
}

/**
 * For a piece cut out of a spline (its points: indices of the spline's points it keeps, or new positions; its
 * spacing as the cut gives it), the handles its inner points need to stay exactly the same curve: the spline's own
 * handles there, and a new one wherever it is not curvature continuous at a kept point (next to a held curvature or
 * a handle with continuity). A side on a piece that was cut short shrinks with it. `own`: the handle point to reuse.
 */
export function cutPieceHandles(g: SketchGeometry, c: Spline, piecePoints: (number | Pt)[], pieceSpacing?: number[]):
    { point: string; at: Pt; back: number; before?: true; own?: string }[] {
    const solved = solvedSpline(g, c);
    if (!solved) {
        return [];
    }
    const ids = splinePointIds(c);
    const count = solved.spans.length;
    const iterated = !!c.curvature?.length || (c.continuity !== false && !!c.handles?.length);
    const pts = piecePoints.map((p) => (typeof p === 'number' ? solved.pts[p] : p));
    const spans = pts.slice(1).map((q, i) => dist(pts[i], q) * (pieceSpacing?.length === pts.length - 1 ? pieceSpacing[i] : 1));
    const out: { point: string; at: Pt; back: number; before?: true; own?: string }[] = [];
    piecePoints.forEach((p, j) => {
        if (typeof p !== 'number' || j === 0 || j === piecePoints.length - 1) {
            return;
        }
        const point = ids[p];
        const own = c.handles?.find((h) => h.point === point);
        // With held curvatures or continuity every free point gave way a little: each keeps its shape by a handle.
        if (!own && !iterated && isC2At(solved.poles, solved.spans, solved.closed, p)) {
            return;
        }
        const arms = handleAt(solved.poles, solved.closed, p);
        if (!arms.prev || !arms.next) {
            return;
        }
        const at = solved.pts[p];
        const fPrev = spans[j - 1] / solved.spans[((p - 1) % count + count) % count];
        const fNext = spans[j] / solved.spans[p % count];
        const prev = add(at, mul(sub(arms.prev as Pt, at), fPrev));
        const next = add(at, mul(sub(arms.next as Pt, at), fNext));
        const before = !!own?.before;
        const [handle, other] = before ? [prev, next] : [next, prev];
        out.push({ point, at: handle, back: dist(other, at) / (dist(handle, at) || 1), ...(before ? { before: true as const } : {}), ...(own ? { own: own.handle } : {}) });
    });
    return out;
}

/**
 * For a piece that starts or ends at a free end of the spline: the end handle it needs to stay the same curve, when
 * that end of the spline is not a plain free end (a held curvature or continuity nearby bends it there).
 */
export function cutPieceEnds(g: SketchGeometry, c: Spline, piecePoints: (number | Pt)[], pieceSpacing?: number[]): { start?: Pt; end?: Pt } {
    const solved = solvedSpline(g, c);
    if (!solved || solved.closed || piecePoints.length < 2) {
        return {};
    }
    const pieces = cubicPieces(solved.poles);
    const last = solved.pts.length - 1;
    const pts = piecePoints.map((q) => (typeof q === 'number' ? solved.pts[q] : q));
    const spanOf = (j: number) => dist(pts[j], pts[j + 1]) * (pieceSpacing?.length === pts.length - 1 ? pieceSpacing[j] : 1);
    const size = Math.max(1, ...solved.poles.map((q) => Math.max(Math.abs(q[0]), Math.abs(q[1]))));
    const bent = (piece: number, t: number) => len(pieceDerivatives(pieces[piece], t).d2 as Pt) > 1e-9 * size;
    const out: { start?: Pt; end?: Pt } = {};
    if (piecePoints[0] === 0 && !c.startHandle && bent(0, 0)) {
        const f = spanOf(0) / solved.spans[0];
        out.start = add(solved.pts[0], mul(sub(solved.poles[1], solved.pts[0]), f));
    }
    if (piecePoints[piecePoints.length - 1] === last && !c.endHandle && bent(pieces.length - 1, 1)) {
        const f = spanOf(pts.length - 2) / solved.spans[solved.spans.length - 1];
        out.end = add(solved.pts[last], mul(sub(solved.poles[solved.poles.length - 2], solved.pts[last]), f));
    }
    return out;
}

// ---- The control polygon of a spline through points ---------------------------------------------------------------

/** The control polygon of a spline through points: the control vertices of the cubic B-spline that is the curve. */
export function splinePolygon(solved: SolvedSpline): Pt[] {
    return splineAsBSpline(solved.poles, solved.spans).poles as Pt[];
}

/**
 * Control polygon vertex k moved to `to`: the spline becomes the B-spline with that vertex moved, kept exact as a
 * spline through points (the points where the curve now passes, the spans stored, active handles at the ends and
 * wherever the curve is not curvature continuous).
 */
export function movePolygonVertex(g: SketchGeometry, c: Spline, k: number, to: Pt): { g: SketchGeometry; targets: { point: string; u: number; v: number }[] } | { error: string } {
    const solved = solvedSpline(g, c);
    if (!solved) {
        return { error: 'The spline is missing points.' };
    }
    if (c.curvature?.length) {
        return { error: 'This spline has curvature controls: drag its points or handles, or reset its handles first.' };
    }
    const b = splineAsBSpline(solved.poles, solved.spans);
    if (k < 0 || k >= b.poles.length) {
        return { error: 'There is no such control polygon vertex.' };
    }
    // A closed spline's polygon starts and ends on its first point: those two vertices are one.
    const last = b.poles.length - 1;
    const same = solved.closed && (k === 0 || k === last) ? [0, last] : [k];
    const moved = b.poles.map((p, i) => (same.includes(i) ? to : p));
    const poles = bsplineAsPieces(moved, b.knots, b.mults) as Pt[];
    const ids = splinePointIds(c);
    const targets = ids.map((id, i) => ({ point: id, u: poles[3 * i][0], v: poles[3 * i][1] }));
    let out = g;
    // The same parameter spans over the chords where the points go.
    let curve: Spline = { ...c, spacing: spacingFor(ids.map((_, i) => poles[3 * i]), solved.closed, solved.spans) };
    const arm = (i: number) => handleAt(poles, solved.closed, i);
    const setPoint = (id: string, at: Pt) => {
        targets.push({ point: id, u: at[0], v: at[1] });
    };
    if (!solved.closed) {
        const [s, e] = [arm(0).next as Pt, arm(ids.length - 1).prev as Pt];
        if (curve.startHandle) {
            setPoint(curve.startHandle, s);
        } else {
            const r = addPoint(out, s);
            out = r.g;
            curve = { ...curve, startHandle: r.id };
        }
        if (curve.endHandle) {
            setPoint(curve.endHandle, e);
        } else {
            const r = addPoint(out, e);
            out = r.g;
            curve = { ...curve, endHandle: r.id };
        }
    }
    // Joins that are no longer curvature continuous take a handle (a closed spline's first point counts too).
    const smooth = (i: number) => isC2At(poles, solved.spans, solved.closed, i);
    let rough = false;
    const handles = [...(curve.handles ?? [])];
    for (let i = solved.closed ? 0 : 1; i < (solved.closed ? ids.length : ids.length - 1); i++) {
        const has = handles.findIndex((h) => h.point === ids[i]);
        if (has < 0 && smooth(i)) {
            continue;
        }
        rough = rough || !smooth(i);
        const [l, r] = [arm(i).prev as Pt, arm(i).next as Pt];
        const at = poles[3 * i];
        const back = dist(l, at) / (dist(r, at) || 1);
        if (has >= 0 && handles[has].before) {
            setPoint(handles[has].handle, l);
            handles[has] = { ...handles[has], back: dist(r, at) / (dist(l, at) || 1) };
        } else if (has >= 0) {
            setPoint(handles[has].handle, r);
            handles[has] = { ...handles[has], back };
        } else {
            const pr = addPoint(out, r);
            out = pr.g;
            handles.push({ point: ids[i], handle: pr.id, back });
        }
    }
    curve = { ...curve, ...(handles.length ? { handles } : {}), ...(rough ? { continuity: false as const } : {}) };
    return { g: withCurve(out, curve), targets };
}

// ---- Convert spline types ------------------------------------------------------------------------------------------

/** Removes the old curve's points that the new one does not use, with their relations. */
function dropPoints(g: SketchGeometry, ids: string[]): SketchGeometry {
    return ids.length ? removeItems(g, ids) : g;
}

/**
 * Convert to style spline: the spline through points becomes the style spline of the same curve (the cubic B-spline
 * of its control polygon; one piece: a Bezier curve). Its end points stay, with their relations; the inner points
 * and handles go.
 */
export function splineToStyle(g: SketchGeometry, id: string): SketchGeometry | string {
    const c = curveOf(g, id);
    if (c?.kind !== 'spline') {
        return 'Select a spline.';
    }
    const solved = solvedSpline(g, c);
    if (!solved) {
        return 'The spline is missing points.';
    }
    if (solved.closed) {
        return 'A closed spline cannot become a style spline: a style spline has two ends.';
    }
    const b = splineAsBSpline(solved.poles, solved.spans);
    const ids = splinePointIds(c);
    const [first, last] = [ids[0], ids[ids.length - 1]];
    let out = g;
    const vertices: string[] = [first];
    for (const p of b.poles.slice(1, -1)) {
        const r = addPoint(out, p as Pt);
        out = r.g;
        vertices.push(r.id);
    }
    vertices.push(last);
    const inner = innerKnots(b.knots, b.mults, 3);
    const style: StyleSpline = {
        id, kind: 'styleSpline', points: vertices, ...(c.construction ? { construction: true } : {}),
        ...(vertices.length > 4 ? { degree: 3 as const, knots: inner } : {}),
    };
    out = withCurve(out, style);
    const gone = [...ids.slice(1, -1), c.startHandle, c.endHandle, ...(c.handles ?? []).map((h) => h.handle)].filter((p): p is string => !!p);
    return dropPoints(out, gone);
}

/**
 * Convert to spline: a style spline that is a cubic (a Bezier curve of up to 4 control vertices, or a B-spline of
 * degree 3) becomes the spline through points of the same curve: through the curve's knots, with handles at the
 * ends (and where the curve is not curvature continuous) and its spans stored.
 */
export function styleToSpline(g: SketchGeometry, id: string): SketchGeometry | string {
    const c = curveOf(g, id);
    if (c?.kind !== 'styleSpline') {
        return 'Select a style spline.';
    }
    const cv = c.points.map((p) => P(g, p));
    if (!cv.every(Boolean)) {
        return 'The style spline is missing control vertices.';
    }
    const poles = cv as Pt[];
    if (c.weights?.some((w) => w !== 1)) {
        return 'A rational style spline (with control vertex weights) is not a cubic spline through points: make it non-rational first.';
    }
    const degree = styleDegree(c);
    let pieces: Pt[];
    let spans: number[];
    // Multiplicity of each join: above 1 the B-spline is not C2 there.
    let joins: number[] = [];
    if (degree === poles.length - 1) {
        if (degree > 3) {
            return `A Bezier curve of ${poles.length} control vertices (degree ${degree}) is not a cubic spline: it cannot become a spline through points exactly.`;
        }
        let bez = poles;
        while (bez.length < 4) {
            bez = elevateBezier(bez) as Pt[];
        }
        pieces = bez;
        spans = [dist(bez[0], bez[3]) || 1];
    } else {
        if (degree !== 3) {
            return `A B-spline of degree ${degree} is not a cubic spline: only degree 3 becomes a spline through points exactly.`;
        }
        const U = knotVector(poles.length, 3, c.knots);
        const { knots, mults } = knotMultiplicities(U);
        pieces = bsplineAsPieces(poles, knots, mults) as Pt[];
        const length = piecesLength(cubicPieces(pieces));
        spans = knots.slice(1).map((k, i) => (k - knots[i]) * (length || 1));
        joins = mults.slice(1, -1);
    }
    const count = (pieces.length - 1) / 3;
    const first = c.points[0];
    const last = c.points[c.points.length - 1];
    let out = g;
    const through: string[] = [first];
    for (let i = 1; i < count; i++) {
        const r = addPoint(out, pieces[3 * i]);
        out = r.g;
        through.push(r.id);
    }
    through.push(last);
    const handle = (at: Pt) => {
        const r = addPoint(out, at);
        out = r.g;
        return r.id;
    };
    const startHandle = handle(pieces[1]);
    const endHandle = handle(pieces[pieces.length - 2]);
    // Joins where the B-spline is not C2 (a repeated knot) keep their shape through a handle.
    const handles: NonNullable<Spline['handles']> = [];
    for (let i = 1; i < count; i++) {
        if ((joins[i - 1] ?? 1) > 1) {
            const [l, r, at] = [pieces[3 * i - 1], pieces[3 * i + 1], pieces[3 * i]];
            const [u, w] = [sub(at, l), sub(r, at)];
            if (Math.abs(u[0] * w[1] - u[1] * w[0]) > 1e-9 * (len(u) * len(w) || 1) || u[0] * w[0] + u[1] * w[1] <= 0) {
                return 'This style spline has a corner (a knot repeated three times): a spline through points runs smoothly through every point.';
            }
            handles.push({ point: through[i], handle: handle(r), back: dist(l, at) / (dist(r, at) || 1) });
        }
    }
    const spline: Spline = {
        id, kind: 'spline', points: through, startHandle, endHandle, spacing: spacingFor(Array.from({ length: count + 1 }, (_, i) => pieces[3 * i]), false, spans),
        ...(c.construction ? { construction: true } : {}),
        ...(handles.length ? { handles, continuity: false as const } : {}),
    };
    out = withCurve(out, spline);
    return dropPoints(out, c.points.slice(1, -1));
}

// ---- Exact pieces of any sketch curve (curvature tools) -------------------------------------------------------------

/** A circular or elliptical arc from parameter a0 to a1 as rational quadratic pieces of at most a quarter turn. */
function ovalPieces(at: (phi: number) => Pt, centre: Pt, a0: number, a1: number): BezierPiece[] {
    const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
    const out: BezierPiece[] = [];
    for (let k = 0; k < n; k++) {
        const [s, e] = [a0 + ((a1 - a0) * k) / n, a0 + ((a1 - a0) * (k + 1)) / n];
        const half = (e - s) / 2;
        const m = at((s + e) / 2);
        // The middle control point: on the ray from the centre through the arc's middle, 1 / cos(half) as far.
        const mid = add(centre, mul(sub(m, centre), 1 / Math.cos(half)));
        out.push({ poles: [at(s), mid, at(e)], weights: [1, Math.cos(half), 1] });
    }
    return out;
}

/** The curve as exact rational Bezier pieces (lines, arcs, ellipses, splines, style splines, parabolas, conics). */
export function curvePieces(g: SketchGeometry, id: string): BezierPiece[] | null {
    const c = curveOf(g, id);
    if (!c) {
        return null;
    }
    if (c.kind === 'line') {
        const [a, b] = [P(g, c.a), P(g, c.b)];
        return a && b ? [{ poles: [a, b] }] : null;
    }
    if (c.kind === 'circle' || c.kind === 'arc') {
        const o = P(g, c.center);
        if (!o) {
            return null;
        }
        const s = c.kind === 'arc' ? P(g, c.start) : null;
        const e = c.kind === 'arc' ? P(g, c.end) : null;
        const r = c.kind === 'circle' ? c.radius : s ? dist(o, s) : 0;
        const at = (phi: number): Pt => [o[0] + r * Math.cos(phi), o[1] + r * Math.sin(phi)];
        if (c.kind === 'circle') {
            return ovalPieces(at, o, 0, 2 * Math.PI);
        }
        if (!s || !e) {
            return null;
        }
        const a0 = Math.atan2(s[1] - o[1], s[0] - o[0]);
        let a1 = Math.atan2(e[1] - o[1], e[0] - o[0]);
        while (a1 <= a0) {
            a1 += 2 * Math.PI;
        }
        return ovalPieces(at, o, a0, a1);
    }
    if (c.kind === 'ellipse' || c.kind === 'ellipseArc') {
        const e = ellipseOfCurve(g, c);
        if (!e) {
            return null;
        }
        const [cs, sn] = [Math.cos(e.angle), Math.sin(e.angle)];
        const at = (phi: number): Pt => {
            const [x, y] = [e.a * Math.cos(phi), e.b * Math.sin(phi)];
            return [e.center[0] + x * cs - y * sn, e.center[1] + x * sn + y * cs];
        };
        if (c.kind === 'ellipse') {
            return ovalPieces(at, e.center, 0, 2 * Math.PI);
        }
        const [s, t] = [P(g, c.start), P(g, c.end)];
        if (!s || !t) {
            return null;
        }
        const a0 = ellipseParam(e, s);
        let a1 = ellipseParam(e, t);
        while (a1 <= a0) {
            a1 += 2 * Math.PI;
        }
        return ovalPieces(at, e.center, a0, a1);
    }
    if (c.kind === 'spline') {
        const solved = solvedSpline(g, c);
        return solved ? cubicPieces(solved.poles) : null;
    }
    if (!isExtra(c)) {
        return null;
    }
    const s = curveSegment(g, c);
    if (!s) {
        return null;
    }
    if (s.seg.kind === 'bspline') {
        const poles = [s.from, ...s.seg.poles, s.seg.to] as Pt[];
        return nurbsPieces(poles, s.seg.degree, s.seg.knots, s.seg.weights).pieces;
    }
    if (s.seg.kind === 'conic') {
        return [{ poles: [s.from, s.seg.apex, s.seg.to] as Pt[], weights: [1, conicWeight(s.seg.rho), 1] }];
    }
    return null;
}

/** The length of a curve along it (mm), or null. */
export function curveLength(g: SketchGeometry, id: string): number | null {
    const pieces = curvePieces(g, id);
    return pieces ? piecesLength(pieces) : null;
}
