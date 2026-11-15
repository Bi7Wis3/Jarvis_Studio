// Trim, split, extend and corner on every kind of sketch curve: lines, circles, arcs, ellipses, partial ellipses,
// parabolas, conics, splines through points and style splines. The curves meet exactly (@jarvis/core/curveIntersect)
// and are cut into exact pieces of their own kind (@jarvis/core/curveSplit): a circle's piece is an arc on the same
// centre, an ellipse's a partial ellipse on the same axes, a parabola's a parabola on the same focus and vertex, a
// conic's a conic, a spline's a spline through the same points with handles at the cut, a style spline's a style
// spline of the same degree. sketchEdit.ts and sketchTrim.ts call these; all are pure functions of the geometry.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { conicWeight, ellipseParam } from '@jarvis/core/curves';
import { boundsOf, carrierOf, closestParam, crossings, domainOf, pointAt, wrapParam, type CurveGeom } from '@jarvis/core/curveIntersect';
import { bsplineGeom, bsplinePiece, conicPiece, splineGeom, splinePiece } from '@jarvis/core/curveSplit';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, pointOf } from './solver';
import { addConstraint, constraintRefs, extentHeld, geometryEntities, newId } from './sketchGeometry';
import { CURVE_NOUN, closedSpline, curveEndIds, curvePointIds, ellipseOfCurve, holdsPoints, parabolaFrame, parabolaSegment, splineShapeOf, styleDegree } from './sketchCurves';
import { cutPieceEnds, cutPieceHandles } from './sketchSplines';
import type { NewEntity, Pt } from './sketchMath';
import { endlessEnds } from './sketchInfinite';

const TAU = 2 * Math.PI;
/** Positions closer than this are the same point. */
const SAME = 1e-5;

const dist = (p: Pt, q: Pt): number => Math.hypot(q[0] - p[0], q[1] - p[1]);
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
const P = (g: SketchGeometry, id: string): Pt | null => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : null;
};
const at = (g: SketchGeometry, id: string): Pt => P(g, id) ?? [0, 0];

// ---- Curves with their parameter ------------------------------------------------------------------------------

/** A sketch curve (or one of the sketch axes) as the cut tools see it: its exact shape with its own parameter. */
export function geomOf(g: SketchGeometry, id: string): CurveGeom | null {
    if (id === AXIS_U) {
        return { kind: 'line', a: [0, 0], b: [1, 0], infinite: true };
    }
    if (id === AXIS_V) {
        return { kind: 'line', a: [0, 0], b: [0, 1], infinite: true };
    }
    const c = curveOf(g, id);
    return c ? geomOfCurve(g, c) : null;
}

/** The curve's exact shape: lines 0 to 1, circles and ellipses by angle, conics and parabolas as conics, splines piece by piece. */
export function geomOfCurve(g: SketchGeometry, c: SketchCurve): CurveGeom | null {
    switch (c.kind) {
        case 'line': {
            const [a, b] = [P(g, c.a), P(g, c.b)];
            if (!a || !b) {
                return null;
            }
            // An infinite line meets others along its whole reach (sketchInfinite.ts).
            const [p, q] = endlessEnds(a, b, c.endless);
            return { kind: 'line', a: p, b: q };
        }
        case 'circle': {
            const centre = P(g, c.center);
            return centre ? { kind: 'circle', c: centre, r: c.radius } : null;
        }
        case 'arc': {
            const [centre, s, e] = [P(g, c.center), P(g, c.start), P(g, c.end)];
            if (!centre || !s || !e) {
                return null;
            }
            const from = Math.atan2(s[1] - centre[1], s[0] - centre[0]);
            return { kind: 'circle', c: centre, r: dist(centre, s), from, sweep: norm(Math.atan2(e[1] - centre[1], e[0] - centre[0]) - from) || TAU };
        }
        case 'ellipse': {
            const e = ellipseOfCurve(g, c);
            return e ? { kind: 'ellipse', e } : null;
        }
        case 'ellipseArc': {
            const e = ellipseOfCurve(g, c);
            const [s, f] = [P(g, c.start), P(g, c.end)];
            if (!e || !s || !f) {
                return null;
            }
            const from = ellipseParam(e, s);
            return { kind: 'ellipse', e, from, sweep: norm(ellipseParam(e, f) - from) || TAU };
        }
        case 'parabola': {
            const [f, v, s, e] = [P(g, c.focus), P(g, c.vertex), P(g, c.start), P(g, c.end)];
            const pf = f && v ? parabolaFrame(f, v) : null;
            if (!pf || !s || !e) {
                return null;
            }
            const seg = parabolaSegment(pf, s, e);
            return seg.kind === 'conic' ? { kind: 'conic', p0: s, p1: seg.apex, p2: e, w: 1 } : null;
        }
        case 'conic': {
            const [s, e, apex] = [P(g, c.start), P(g, c.end), P(g, c.apex)];
            return s && e && apex ? { kind: 'conic', p0: s, p1: apex, p2: e, w: conicWeight(c.rho) } : null;
        }
        case 'spline': {
            const pts = c.points.map((id) => P(g, id));
            if (pts.some((p) => !p) || pts.length < 2) {
                return null;
            }
            // With its handles at every point, held curvatures and spacing (sketchSplines.ts).
            return splineGeom(pts as Pt[], closedSpline(c), splineShapeOf(g, c));
        }
        case 'styleSpline': {
            const pts = c.points.map((id) => P(g, id));
            // A rational style spline is not cut yet (its pieces would need their weights).
            if (pts.some((p) => !p) || pts.length < 2 || c.weights?.some((w) => w !== 1)) {
                return null;
            }
            return bsplineGeom(pts as Pt[], styleDegree(c), c.knots);
        }
    }
}

/** Whether the curve closes on itself (circle, ellipse, closed spline): it takes two cuts to open it. */
export function closesOnItself(c: SketchCurve | undefined): boolean {
    return !!c && (c.kind === 'circle' || c.kind === 'ellipse' || (c.kind === 'spline' && closedSpline(c)));
}

/** What Split says after the first click on a closed curve. */
export function secondSplitPrompt(c: SketchCurve | undefined): string {
    return `Click the second split point on the ${c ? CURVE_NOUN[c.kind] : 'curve'}.`;
}

// ---- Where other curves cut a curve --------------------------------------------------------------------------

export interface Cut {
    /** The curve's own parameter there (see geomOfCurve). */
    t: number;
    at: Pt;
    /** The curve that cuts here. */
    by: string;
    /** An existing point at the cut (an end of the cutting curve), shared instead of adding one. */
    point?: string;
}

/** Where other curves cross or touch curve c, in order along it; its own ends are left out. `by`: only these cut. */
export function cutsAlong(g: SketchGeometry, c: SketchCurve, by?: readonly string[]): Cut[] {
    const geom = geomOfCurve(g, c);
    if (!geom) {
        return [];
    }
    const dom = domainOf(geom);
    const box = boundsOf(geom);
    const ownEnds = new Set(curveEndIds(c));
    const ends = [...ownEnds].map((id) => P(g, id)).filter((p): p is Pt => !!p);
    const cuts: Cut[] = [];
    const add = (cut: Cut) => {
        if (ends.some((e) => dist(e, cut.at) < SAME)) {
            return;
        }
        const same = cuts.findIndex((k) => dist(k.at, cut.at) < SAME);
        if (same < 0) {
            cuts.push(cut);
        } else if (cut.point && !cuts[same].point) {
            cuts[same] = cut;
        }
    };
    for (const other of g.curves) {
        if (other.id === c.id || (by && !by.includes(other.id))) {
            continue;
        }
        const og = geomOfCurve(g, other);
        if (!og) {
            continue;
        }
        for (const h of crossings(geom, og)) {
            add({ t: h.ta, at: h.at, by: other.id });
        }
        // Ends of other curves lying on this one (a T): caught even when rounding puts them a hair off.
        for (const id of curveEndIds(other)) {
            const q = P(g, id);
            if (!q || ownEnds.has(id) || (box && (q[0] < box[0] - 1e-3 || q[0] > box[2] + 1e-3 || q[1] < box[1] - 1e-3 || q[1] > box[3] + 1e-3))) {
                continue;
            }
            const t = closestParam(geom, q);
            if (dist(pointAt(geom, t), q) < 1e-4 && (dom.period || (t > dom.t0 && t < dom.t1))) {
                add({ t, at: q, by: other.id, point: id });
            }
        }
    }
    return cuts.sort((a, b) => a.t - b.t);
}

// ---- Building pieces ------------------------------------------------------------------------------------------

function newPoint(g: SketchGeometry, p: Pt): { g: SketchGeometry; id: string } {
    const id = newId('p', g);
    return { g: { ...g, points: [...g.points, { id, u: p[0], v: p[1] }] }, id };
}

function putCurve(g: SketchGeometry, curve: SketchCurve): SketchGeometry {
    const exists = g.curves.some((c) => c.id === curve.id);
    return { ...g, curves: exists ? g.curves.map((c) => (c.id === curve.id ? curve : c)) : [...g.curves, curve] };
}

/** Relations and dimensions that would hold a point where it was. */
const holdsPoint = (k: SketchConstraint, p: string): boolean => (k.kind === 'fix' && k.point === p)
    || (k.kind === 'distance' && (k.a === p || k.b === p))
    || (k.kind === 'pointOnCurve' && k.point === p)
    || (k.kind === 'coincident' && (k.a === p || k.b === p))
    || (k.kind === 'midpoint' && k.point === p)
    || (k.kind === 'symmetric' && (k.a === p || k.b === p))
    || ((k.kind === 'horizontalPoints' || k.kind === 'verticalPoints') && (k.a === p || k.b === p));

/** Moves a point; what held it where it was goes when it really moves. */
function movePoint(g: SketchGeometry, id: string, to: Pt): SketchGeometry {
    const from = P(g, id);
    if (from && dist(from, to) < 1e-12) {
        return g;
    }
    return {
        ...g,
        points: g.points.map((p) => (p.id === id ? { ...p, u: to[0], v: to[1] } : p)),
        constraints: g.constraints.filter((k) => !holdsPoint(k, id)),
    };
}

/** Removes these points if no curve uses them any more, with the constraints that refer to them. */
export function dropUnusedPoints(g: SketchGeometry, ids: string[]): SketchGeometry {
    const used = new Set(g.curves.flatMap(curvePointIds));
    const gone = new Set(ids.filter((id) => id !== ORIGIN && !used.has(id)));
    if (!gone.size) {
        return g;
    }
    return {
        ...g,
        points: g.points.filter((p) => !gone.has(p.id)),
        constraints: g.constraints.filter((c) => !constraintRefs(c).some((r) => gone.has(r))),
    };
}

/**
 * Writes the part of curve c from parameter t0 to t1 (on `geom`, c's shape in `src`) as curve `id`, of c's own kind
 * (a circle's part is an arc, an ellipse's a partial ellipse, a closed spline's an open one), from point `start` to
 * point `end`, which already lie at those ends. Points inside the part are new: a conic's top vertex (moved instead
 * on c's own id), a spline's handles at a cut (its own end handles stay with the part that keeps that end), a style
 * spline's control vertices. Null when the part cannot be one curve (a conic part turning half a turn or more).
 */
export function putPiece(src: SketchGeometry, out0: SketchGeometry, c: SketchCurve, geom: CurveGeom, t0: number, t1: number,
    start: string, end: string, id: string, construction: boolean): SketchGeometry | null {
    let out = out0;
    const flag = construction ? { construction: true as const } : {};
    const dom = domainOf(geom);
    const point = (p: Pt): string => {
        const r = newPoint(out, p);
        out = r.g;
        return r.id;
    };
    switch (c.kind) {
        case 'line':
            return putCurve(out, { id, kind: 'line', a: start, b: end, ...flag });
        case 'circle':
        case 'arc':
            return putCurve(out, { id, kind: 'arc', center: c.center, start, end, ...flag });
        case 'ellipse':
        case 'ellipseArc':
            return putCurve(out, { id, kind: 'ellipseArc', center: c.center, major: c.major, minor: c.minor, start, end, ...flag });
        case 'parabola':
            return putCurve(out, { id, kind: 'parabola', focus: c.focus, vertex: c.vertex, start, end, ...flag });
        case 'conic': {
            if (geom.kind !== 'conic') {
                return null;
            }
            const piece = conicPiece(geom, t0, t1);
            if (!piece) {
                return null;
            }
            let apex: string;
            if (id === c.id) {
                out = movePoint(out, c.apex, piece.apex);
                apex = c.apex;
            } else {
                apex = point(piece.apex);
            }
            return putCurve(out, { id, kind: 'conic', start, end, apex, rho: piece.rho, ...flag });
        }
        case 'spline': {
            const coords = c.points.map((p) => at(src, p));
            const closed = closedSpline(c);
            const handles = splineShapeOf(src, c);
            const piece = splinePiece(coords, closed, handles, t0, t1);
            const inner = piece.points.slice(1, -1).map((p) => (typeof p === 'number' ? c.points[p] : point(p)));
            const curve: Extract<SketchCurve, { kind: 'spline' }> = { id, kind: 'spline', points: [start, ...inner, end], ...flag };
            // The spline's own end handle goes with the part that keeps that end of it.
            const handle = (pos: Pt | undefined, own: string | undefined, keepsEnd: boolean): string | undefined => {
                if (!pos) {
                    return undefined;
                }
                if (own && keepsEnd) {
                    out = movePoint(out, own, pos);
                    return own;
                }
                return point(pos);
            };
            const startHandle = handle(piece.startHandle, c.startHandle, !closed && t0 <= dom.t0 + 1e-12);
            const endHandle = handle(piece.endHandle, c.endHandle, !closed && t1 >= dom.t1 - 1e-12);
            if (startHandle) {
                curve.startHandle = startHandle;
            }
            if (endHandle) {
                curve.endHandle = endHandle;
            }
            if (piece.spacing) {
                curve.spacing = piece.spacing;
            }
            // Its inner points keep their handles (and those where the spline was not curvature continuous take one).
            const kept = cutPieceHandles(src, c, piece.points, piece.spacing);
            if (kept.length) {
                curve.handles = kept.map((h) => {
                    if (h.own) {
                        out = movePoint(out, h.own, h.at);
                    }
                    return { point: h.point, handle: h.own ?? point(h.at), back: h.back, ...(h.before ? { before: true as const } : {}) };
                });
                curve.continuity = false;
            }
            // A free end of the spline bent by a held curvature nearby keeps its shape through an end handle.
            const ends = cutPieceEnds(src, c, piece.points, piece.spacing);
            if (ends.start && !curve.startHandle) {
                curve.startHandle = point(ends.start);
            }
            if (ends.end && !curve.endHandle) {
                curve.endHandle = point(ends.end);
            }
            return putCurve(out, curve);
        }
        case 'styleSpline': {
            const coords = c.points.map((p) => at(src, p));
            const piece = bsplinePiece(coords, styleDegree(c), c.knots, t0, t1);
            const inner = piece.poles.slice(1, -1).map(point);
            const points = [start, ...inner, end];
            const curve: Extract<SketchCurve, { kind: 'styleSpline' }> = { id, kind: 'styleSpline', points, ...flag };
            if (c.degree && points.length > c.degree) {
                curve.degree = c.degree;
                if (piece.knots) {
                    curve.knots = piece.knots;
                }
            }
            return putCurve(out, curve);
        }
    }
}

/** What a part of curve c from t0 to t1 looks like, to highlight (nothing changes). */
function piecePreview(g: SketchGeometry, c: SketchCurve, geom: CurveGeom, t0: number, t1: number): NewEntity | null {
    let scratch = g;
    const a = newPoint(scratch, pointAt(geom, t0));
    scratch = a.g;
    const b = newPoint(scratch, pointAt(geom, t1));
    scratch = b.g;
    const id = newId('c', scratch);
    const built = putPiece(g, scratch, c, geom, t0, t1, a.id, b.id, id, false);
    if (!built) {
        return null;
    }
    return entityOf(built, id);
}

function entityOf(g: SketchGeometry, id: string): NewEntity | null {
    const curve = curveOf(g, id);
    const e = curve ? geometryEntities({ ...g, curves: [{ ...curve, construction: false }] })[0] : undefined;
    if (!e) {
        return null;
    }
    const { id: _id, construction: _c, ...rest } = e as typeof e & { construction?: boolean };
    return rest as NewEntity;
}

/** The point at a cut: the existing one there, or a new one held on the cutting curve where the solver can. */
function cutPoint(g: SketchGeometry, cut: Cut): { g: SketchGeometry; id: string } {
    if (cut.point) {
        return { g, id: cut.point };
    }
    const r = newPoint(g, cut.at);
    return { g: holdsPoints(r.g, cut.by) ? addConstraint(r.g, { kind: 'pointOnCurve', point: r.id, curve: cut.by }).g : r.g, id: r.id };
}

/**
 * After a curve was cut into pieces: what held its extent goes (arc length, distances to its middle), an end held
 * on its own curve needs no relation, and a tangency at the far end moves to the piece that now has that end.
 */
function tidy(g: SketchGeometry, c: SketchCurve, pieces: string[], oldPoints: string[]): { g: SketchGeometry; dropped: number } {
    const before = g.constraints.length;
    let out: SketchGeometry = { ...g, constraints: g.constraints.filter((k) => !extentHeld(k, c.id)) };
    const dropped = before - out.constraints.length;
    const endsOf = (id: string) => {
        const k = curveOf(out, id);
        return new Set(k ? curveEndIds(k) : []);
    };
    const ends = new Map(pieces.map((id) => [id, endsOf(id)]));
    out = { ...out, constraints: out.constraints.filter((k) => !(k.kind === 'pointOnCurve' && ends.get(k.curve)?.has(k.point))) };
    if (pieces.length > 1) {
        out = {
            ...out,
            constraints: out.constraints.map((k) => {
                if (k.kind !== 'tangent' || (k.a !== c.id && k.b !== c.id)) {
                    return k;
                }
                const other = curveOf(out, k.a === c.id ? k.b : k.a);
                const touches = (id: string) => !!other && curveEndIds(other).some((p) => ends.get(id)?.has(p));
                const to = pieces.find((id) => id !== c.id && touches(id));
                if (!to || touches(c.id)) {
                    return k;
                }
                return k.a === c.id ? { ...k, a: to } : { ...k, b: to };
            }),
        };
    }
    return { g: dropUnusedPoints(out, oldPoints), dropped };
}

// ---- Trim -----------------------------------------------------------------------------------------------------

export interface CutTrimOptions {
    /** Only crossings with these curves cut (trim away inside / outside: the two boundaries). */
    by?: string[];
    /** Keep the removed piece as construction geometry. */
    construction?: boolean;
}

/**
 * Trims an ellipse, partial ellipse, parabola, conic or spline at the piece around `at`: the part between the
 * nearest crossings with other curves (or its ends) goes. A curve nothing crosses goes completely; a closed one
 * (an ellipse, a closed spline) needs two crossings and becomes the open piece that is left.
 */
export function trimCurve(g: SketchGeometry, c: SketchCurve, near: Pt, opts: CutTrimOptions = {}): { g: SketchGeometry; removed: NewEntity } | null {
    const geom = geomOfCurve(g, c);
    if (!geom) {
        return null;
    }
    const dom = domainOf(geom);
    const cuts = cutsAlong(g, c, opts.by);
    const tc = closestParam(geom, near);
    const keep = !!opts.construction && !c.construction;
    const oldPoints = curvePointIds(c);
    const own = !!c.construction;
    if (!cuts.length) {
        const removed = entityOf(g, c.id);
        const gone = keep ? { ...g, curves: g.curves.map((k) => (k.id === c.id ? { ...k, construction: true } : k)) }
            : dropUnusedPoints({ ...g, curves: g.curves.filter((k) => k.id !== c.id), constraints: g.constraints.filter((k) => !constraintRefs(k).includes(c.id)) }, oldPoints);
        return removed ? { g: gone, removed } : null;
    }
    let out = g;
    const place = (cut: Cut): string => {
        const r = cutPoint(out, cut);
        out = r.g;
        return r.id;
    };
    const pieces = [c.id];
    let removed: NewEntity | null;
    if (dom.period) {
        if (cuts.length < 2) {
            return null;
        }
        const period = dom.period;
        const before = [...cuts].reverse().find((k) => k.t <= tc) ?? cuts[cuts.length - 1];
        const after = cuts.find((k) => k.t > tc) ?? cuts[0];
        // What is left runs from the cut after the click round to the one before it.
        const k0 = after.t;
        const k1 = before.t > after.t ? before.t : before.t + period;
        removed = piecePreview(g, c, geom, k1, k0 + period);
        const start = place(after);
        const end = place(before);
        const built = putPiece(g, out, c, geom, k0, k1, start, end, c.id, own);
        if (!built) {
            return null;
        }
        out = built;
        if (keep) {
            const ghost = putPiece(g, out, c, geom, k1, k0 + period, end, start, newId('c', out), true);
            out = ghost ?? out;
        }
    } else {
        const lower = [...cuts].reverse().find((k) => k.t < tc) ?? null;
        const upper = cuts.find((k) => k.t > tc) ?? null;
        const [first, last] = curveEndIds(c);
        removed = piecePreview(g, c, geom, lower?.t ?? dom.t0, upper?.t ?? dom.t1);
        const lowerId = lower ? place(lower) : null;
        const upperId = upper ? place(upper) : null;
        const steps: [number, number, string, string, string][] = [];
        if (lower && lowerId) {
            steps.push([dom.t0, lower.t, first, lowerId, c.id]);
        }
        if (upper && upperId) {
            steps.push([upper.t, dom.t1, upperId, last, lower ? '' : c.id]);
        }
        for (const [a, b, s, e, id0] of steps) {
            const id = id0 || newId('c', out);
            const built = putPiece(g, out, c, geom, a, b, s, e, id, own);
            if (!built) {
                return null;
            }
            out = built;
            if (id !== c.id) {
                pieces.push(id);
            }
        }
        if (keep) {
            const ghost = putPiece(g, out, c, geom, lower?.t ?? dom.t0, upper?.t ?? dom.t1, lowerId ?? first, upperId ?? last, newId('c', out), true);
            out = ghost ?? out;
        }
    }
    if (!removed) {
        return null;
    }
    return { g: tidy(out, c, pieces, oldPoints).g, removed };
}

// ---- Split -----------------------------------------------------------------------------------------------------

/**
 * Splits a curve in two at the point of it nearest `near`, with a split point both pieces share; a circle, an
 * ellipse or a closed spline takes two split points (`near2`) and becomes two pieces. `dropped` counts the
 * dimensions of the whole curve's extent that no longer hold.
 */
export function splitCurve(g: SketchGeometry, c: SketchCurve, near: Pt, near2?: Pt): { g: SketchGeometry; point: string; dropped: number } | { error: string } {
    const geom = geomOfCurve(g, c);
    if (!geom) {
        return { error: 'Pick a curve.' };
    }
    const dom = domainOf(geom);
    const oldPoints = curvePointIds(c);
    const own = !!c.construction;
    let out = g;
    const place = (t: number): string => {
        const r = newPoint(out, pointAt(geom, t));
        out = r.g;
        return r.id;
    };
    const noun = CURVE_NOUN[c.kind];
    if (dom.period) {
        if (!near2) {
            return { error: `${/^[aeiou]/.test(noun) ? 'An' : 'A'} ${noun} is split at two points: click the second.` };
        }
        const t1 = closestParam(geom, near);
        let t2 = closestParam(geom, near2);
        if (dist(pointAt(geom, t1), pointAt(geom, t2)) < 1e-6) {
            return { error: 'Click a second point away from the first.' };
        }
        if (t2 < t1) {
            t2 += dom.period;
        }
        const a = place(t1);
        const b = place(t2);
        const second = newId('c', out);
        const first = putPiece(g, out, c, geom, t1, t2, a, b, c.id, own);
        const next = first && putPiece(g, first, c, geom, t2, t1 + dom.period, b, a, second, own);
        if (!next) {
            return { error: `That ${noun} cannot be split there.` };
        }
        const r = tidy(next, c, [c.id, second], oldPoints);
        return { g: r.g, point: a, dropped: r.dropped };
    }
    const t = closestParam(geom, near);
    const [s, e] = [pointAt(geom, dom.t0), pointAt(geom, dom.t1)];
    const p = pointAt(geom, t);
    if (t <= dom.t0 + 1e-9 || t >= dom.t1 - 1e-9 || dist(p, s) < 1e-6 || dist(p, e) < 1e-6) {
        return { error: 'Click inside the curve, away from its ends.' };
    }
    const [firstEnd, lastEnd] = curveEndIds(c);
    const mid = place(t);
    const second = newId('c', out);
    const first = putPiece(g, out, c, geom, dom.t0, t, firstEnd, mid, c.id, own);
    const next = first && putPiece(g, first, c, geom, t, dom.t1, mid, lastEnd, second, own);
    if (!next) {
        return { error: `That ${noun} cannot be split there.` };
    }
    const r = tidy(next, c, [c.id, second], oldPoints);
    return { g: r.g, point: mid, dropped: r.dropped };
}

// ---- Extend ------------------------------------------------------------------------------------------------------

/** Relations of an end that moves away (as Extend and Corner drop them), and a line's length, middle and equal length. */
function dropHolds(g: SketchGeometry, end: string, curve: SketchCurve): SketchGeometry {
    const line = curve.kind === 'line' ? curve.id : null;
    return {
        ...g,
        constraints: g.constraints.filter((k) => !(holdsPoint(k, end)
            || (line !== null && ((k.kind === 'length' && k.line === line) || (k.kind === 'midpoint' && k.line === line)
                || (k.kind === 'equal' && (k.a === line || k.b === line))))
            || extentHeld(k, curve.id))),
    };
}

/** Why Extend leaves this curve alone, or null: splines have no natural path past their ends to follow. */
export function extendRefusal(c: SketchCurve | undefined): string | null {
    if (c?.kind === 'line' && c.endless) {
        return 'Extend does not work on infinite lines: trim them to a length first.';
    }
    if (c?.kind === 'spline' || c?.kind === 'styleSpline') {
        return `Extend does not lengthen ${CURVE_NOUN[c.kind]}s: they have no natural path past their ends (SolidWorks extends lines, arcs and the curves that run on).`;
    }
    return null;
}

/**
 * Lengthens a line, arc, partial ellipse, parabola or conic at its end nearer `near`, along its own natural path
 * (the line on, the arc round its circle, the partial ellipse round its ellipse, the parabola or conic along
 * itself), to the next curve it meets. Splines are not extended; a conic goes no further than its end tangents
 * can still meet ahead of it.
 */
export function extendCurve(g: SketchGeometry, c: SketchCurve, near: Pt): { g: SketchGeometry; added: NewEntity; dropped: number } | null {
    const geom = geomOfCurve(g, c);
    const carrier = geom && carrierOf(geom);
    if (!geom || !carrier || extendRefusal(c)) {
        return null;
    }
    const dom = domainOf(geom);
    if (dom.period) {
        return null;
    }
    const [first, last] = curveEndIds(c);
    const end = dist(at(g, first), near) <= dist(at(g, last), near) ? first : last;
    // An end that other curves share cannot move away from them.
    if (g.curves.some((k) => k.id !== c.id && curvePointIds(k).includes(end))) {
        return null;
    }
    const forward = end === last;
    const from = at(g, end);
    const room = carrier.period ? carrier.period - (dom.t1 - dom.t0) : Infinity;
    let hit: { t: number; d: number; at: Pt; by: string } | null = null;
    for (const o of g.curves) {
        const og = o.id === c.id ? null : geomOfCurve(g, o);
        if (!og) {
            continue;
        }
        for (const h of crossings(geom, og, { carrierA: true })) {
            const raw = forward ? h.ta - dom.t1 : dom.t0 - h.ta;
            const d = carrier.period ? wrapParam(raw, 0, carrier.period) : raw;
            // Going on past the end, but not round into the curve itself.
            if (d > 1e-9 && d < room - 1e-9 && dist(h.at, from) > SAME && (!hit || d < hit.d)) {
                hit = { t: forward ? dom.t1 + d : dom.t0 - d, d, at: h.at, by: o.id };
            }
        }
    }
    if (!hit) {
        return null;
    }
    const target = hit;
    const [n0, n1] = forward ? [dom.t0, target.t] : [target.t, dom.t1];
    const added = piecePreview(g, c, geom, forward ? dom.t1 : target.t, forward ? target.t : dom.t0);
    if (!added) {
        return null;
    }
    const before = g.constraints.length;
    let out = dropHolds(g, end, c);
    const dropped = before - out.constraints.length;
    out = { ...out, points: out.points.map((p) => (p.id === end ? { ...p, u: target.at[0], v: target.at[1] } : p)) };
    if (c.kind === 'conic') {
        const built = putPiece(g, out, c, geom, n0, n1, c.start, c.end, c.id, !!c.construction);
        if (!built) {
            return null;
        }
        out = built;
    }
    if (holdsPoints(out, target.by)) {
        out = addConstraint(out, { kind: 'pointOnCurve', point: end, curve: target.by }).g;
    }
    return { g: out, added, dropped };
}

// ---- Corner ------------------------------------------------------------------------------------------------------

/** The new extent of a curve whose clicked side stays and whose other end goes to the corner at tx; null if it cannot reach. */
function resize(geom: CurveGeom, tc: number, tx: number): { range: [number, number]; moving: 'start' | 'end' } | null {
    const d = domainOf(geom);
    const carrier = carrierOf(geom);
    let out: { range: [number, number]; moving: 'start' | 'end' };
    if (carrier?.period) {
        const u = wrapParam(tx, d.t0, carrier.period);
        if (u <= d.t1 + 1e-12) {
            out = tc > u ? { range: [u, d.t1], moving: 'start' } : { range: [d.t0, u], moving: 'end' };
        } else {
            // Off the curve: the end farther from the click goes round to the corner.
            out = tc - d.t0 < d.t1 - tc ? { range: [d.t0, u], moving: 'end' } : { range: [u - carrier.period, d.t1], moving: 'start' };
        }
    } else {
        if (!carrier && (tx < d.t0 - 1e-9 || tx > d.t1 + 1e-9)) {
            return null;
        }
        out = tc > tx ? { range: [tx, d.t1], moving: 'start' } : { range: [d.t0, tx], moving: 'end' };
    }
    return out.range[1] - out.range[0] > 1e-9 ? out : null;
}

/**
 * Corner: trims or extends two curves until they meet. Each keeps the side where it was clicked; its other end
 * moves to the corner along the curve's natural path (splines only shorten), and the two share that point.
 */
export function cornerCurves(g: SketchGeometry, a: { id: string; at: Pt }, b: { id: string; at: Pt }): { g: SketchGeometry } | { error: string } {
    const [ca, cb] = [curveOf(g, a.id), curveOf(g, b.id)];
    if (!ca || !cb || a.id === b.id) {
        return { error: 'Corner works on two curves.' };
    }
    if (closesOnItself(ca) || closesOnItself(cb)) {
        return { error: 'Corner works on open curves: a circle, an ellipse or a closed spline has no end to move.' };
    }
    const [ga, gb] = [geomOfCurve(g, ca), geomOfCurve(g, cb)];
    if (!ga || !gb) {
        return { error: 'Corner works on two curves.' };
    }
    const lines = ca.kind === 'line' && cb.kind === 'line';
    const hits = crossings(ga, gb, { carrierA: !!carrierOf(ga), carrierB: !!carrierOf(gb) });
    if (!hits.length) {
        return { error: lines ? 'The lines are parallel; they have no corner.' : 'These curves do not meet, even extended along themselves.' };
    }
    const [tca, tcb] = [closestParam(ga, a.at), closestParam(gb, b.at)];
    const endOf = (c: SketchCurve, m: 'start' | 'end') => curveEndIds(c)[m === 'start' ? 0 : 1];
    let best: { x: Pt; ra: ReturnType<typeof resize> & object; rb: ReturnType<typeof resize> & object; score: number } | null = null;
    for (const h of hits) {
        const ra = resize(ga, tca, h.ta);
        const rb = resize(gb, tcb, h.tb);
        if (!ra || !rb) {
            continue;
        }
        if (ca.kind === 'conic' && ga.kind === 'conic' && !conicPiece(ga, ...ra.range)) {
            continue;
        }
        if (cb.kind === 'conic' && gb.kind === 'conic' && !conicPiece(gb, ...rb.range)) {
            continue;
        }
        const score = dist(at(g, endOf(ca, ra.moving)), h.at) + dist(at(g, endOf(cb, rb.moving)), h.at);
        if (!best || score < best.score) {
            best = { x: h.at, ra, rb, score };
        }
    }
    if (!best) {
        return { error: 'These curves cannot be trimmed or extended to meet.' };
    }
    const { x, ra, rb } = best;
    const ea = endOf(ca, ra.moving);
    const eb = endOf(cb, rb.moving);
    if (ea === eb) {
        return { error: lines ? 'The lines already meet there.' : 'The curves already meet there.' };
    }
    const shared = (id: string, own: string) => g.curves.some((k) => k.id !== own && curvePointIds(k).includes(id));
    if (shared(ea, ca.id) || shared(eb, cb.id)) {
        return { error: 'An end that other curves share cannot move to the corner.' };
    }
    let out = dropHolds(dropHolds(g, ea, ca), eb, cb);
    out = { ...out, points: out.points.map((p) => (p.id === ea ? { ...p, u: x[0], v: x[1] } : p)) };
    // Each curve on its new extent; the second takes the first's corner point in place of its moved end.
    const ends = (c: SketchCurve, moving: string, to: string): [string, string] => {
        const [s, e] = curveEndIds(c);
        return [s === moving ? to : s, e === moving ? to : e];
    };
    const remake = (c: SketchCurve, geom: CurveGeom, range: [number, number], moving: string, to: string): boolean => {
        const [s, e] = ends(c, moving, to);
        if (c.kind === 'conic' || c.kind === 'spline' || c.kind === 'styleSpline') {
            const built = putPiece(g, out, c, geom, range[0], range[1], s, e, c.id, !!c.construction);
            if (!built) {
                return false;
            }
            out = built;
            return true;
        }
        out = { ...out, curves: out.curves.map((k) => (k.id === c.id ? renameEnd(k, moving, to) : k)) };
        return true;
    };
    if (!remake(ca, ga, ra.range, ea, ea) || !remake(cb, gb, rb.range, eb, ea)) {
        return { error: 'These curves cannot be trimmed or extended to meet.' };
    }
    const oldPoints = [...curvePointIds(ca), ...curvePointIds(cb)];
    out = { ...out, points: out.points.filter((p) => p.id !== eb), constraints: out.constraints.filter((k) => !constraintRefs(k).includes(eb)) };
    return { g: dropUnusedPoints(out, oldPoints) };
}

/** The curve with its end point `from` replaced by `to`. */
function renameEnd(c: SketchCurve, from: string, to: string): SketchCurve {
    switch (c.kind) {
        case 'line':
            return { ...c, a: c.a === from ? to : c.a, b: c.b === from ? to : c.b };
        case 'spline':
        case 'styleSpline':
            return { ...c, points: c.points.map((p) => (p === from ? to : p)) };
        case 'circle':
        case 'ellipse':
            return c;
        default:
            return { ...c, start: c.start === from ? to : c.start, end: c.end === from ? to : c.end };
    }
}

// ---- Boundaries (trim away inside / outside) and the power trim path ----------------------------------------------

/** Where the curve crosses each boundary, in order along it: null unless it crosses each exactly once. */
export function boundaryParams(g: SketchGeometry, c: SketchCurve, bounds: [string, string]): [number, number] | null {
    const geom = geomOfCurve(g, c);
    if (!geom) {
        return null;
    }
    const ts: number[] = [];
    for (const id of bounds) {
        const other = geomOf(g, id);
        const hits = other ? crossings(geom, other) : [];
        if (hits.length !== 1) {
            return null;
        }
        ts.push(hits[0].ta);
    }
    return ts[0] < ts[1] ? [ts[0], ts[1]] : [ts[1], ts[0]];
}

/** The point at parameter t of the curve (see geomOfCurve), and its extent. */
export function curvePointAt(g: SketchGeometry, c: SketchCurve, t: number): Pt | null {
    const geom = geomOfCurve(g, c);
    return geom ? pointAt(geom, t) : null;
}

export function curveExtent(g: SketchGeometry, c: SketchCurve): { t0: number; t1: number } | null {
    const geom = geomOfCurve(g, c);
    return geom ? domainOf(geom) : null;
}

/** Where the straight path from `from` to `to` crosses the curve, as fractions along the path. */
export function pathCrossings(g: SketchGeometry, c: SketchCurve, from: Pt, to: Pt): { at: Pt; t: number }[] {
    const geom = geomOfCurve(g, c);
    if (!geom) {
        return [];
    }
    return crossings({ kind: 'line', a: from, b: to }, geom).map((h) => ({ at: h.at, t: h.ta }));
}
