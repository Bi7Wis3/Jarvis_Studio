// Sketch fillet and chamfer between any two curve kinds (SolidWorks Sketch Fillet and Sketch Chamfer): circles,
// ellipses, splines, parabolas and conics as well as lines and arcs. The curves meet as @jarvis/core/curveIntersect
// finds them, the tangent arc or the chamfer points are found on them by @jarvis/core/curveOffset, and each side is
// cut exactly where it touches by the cut tools' own pieces (sketchCut.ts putPiece): a circle becomes an arc, an
// ellipse a partial ellipse, a spline an exact spline piece. Corners of two lines or of lines and arcs meeting at an
// end are made by sketchFillet.ts as before.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { carrierOf, closestParam, crossings, domainOf, pointAt, type CurveGeom } from '@jarvis/core/curveIntersect';
import { cornerTurn, curveSize, filletFit, geomEval, pointAtDistance, rayHit, tangentAt, type CornerSide } from '@jarvis/core/curveOffset';
import { curveOf, pointOf } from './solver';
import { addConstraint, constraintRefs, extentHeld, newId, type NewConstraint } from './sketchGeometry';
import { curveEndIds, curvePointIds } from './sketchCurves';
import { dropUnusedPoints, geomOfCurve, putPiece } from './sketchCut';

type Pt = [number, number];

const dist = (p: Pt, q: Pt): number => Math.hypot(q[0] - p[0], q[1] - p[1]);
const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** One side of a general corner: where on the curve the corner is (its own parameter), and the end it keeps. */
export interface CurveSide {
    curve: SketchCurve;
    /** Parameter of the corner on the curve (at an end; past an end when the curves only meet extended). */
    corner: number;
    /** Parameter of the far end the side keeps (round a closed curve: the corner plus or minus its period). */
    far: number;
    /** The corner end's point id (a corner at an end) and the far end's (an open curve), else null. */
    near: string | null;
    farId: string | null;
}

export interface CurveCorner {
    at: Pt;
    /** The shared corner point, when the sides share one. */
    point: string | null;
    sides: [CurveSide, CurveSide];
}

/** Whether a corner of these two curves needs the general maths (anything beyond two lines, or lines and arcs at an end). */
export function needsCurveCorner(a: SketchCurve, b: SketchCurve, shared: boolean): boolean {
    const plain = (c: SketchCurve) => c.kind === 'line' || c.kind === 'arc';
    return !plain(a) || !plain(b) || (!shared && (a.kind !== 'line' || b.kind !== 'line'));
}

/** A side ending at the corner point. */
function endSide(g: SketchGeometry, c: SketchCurve, point: string): CurveSide | null {
    const geom = geomOfCurve(g, c);
    const [s, e] = curveEndIds(c);
    if (!geom || (s !== point && e !== point)) {
        return null;
    }
    const d = domainOf(geom);
    return s === point ? { curve: c, corner: d.t0, far: d.t1, near: point, farId: e } : { curve: c, corner: d.t1, far: d.t0, near: point, farId: s };
}

/** The corner where two curves end on one point. */
export function curveCornerAt(g: SketchGeometry, point: string, a: SketchCurve, b: SketchCurve): CurveCorner | { error: string } {
    const [sa, sb] = [endSide(g, a, point), endSide(g, b, point)];
    if (!sa || !sb) {
        return { error: 'Pick a corner where two curves end.' };
    }
    return { at: P(g, point), point, sides: [sa, sb] };
}

/** A parameter on a curve's natural path, taken round to where it is nearest the curve itself (an arc's corner just before its start). */
function nearDomain(geom: CurveGeom, t: number): number {
    const d = domainOf(geom);
    const period = carrierOf(geom)?.period;
    if (d.period || !period) {
        return t;
    }
    const off = (x: number) => (x < d.t0 ? d.t0 - x : x > d.t1 ? x - d.t1 : 0);
    return [t - period, t, t + period].reduce((best, x) => (off(x) < off(best) ? x : best));
}

/**
 * The corner of two picked curves that do not share an end: where they cross (or would, along their natural paths),
 * the crossing nearest the picks; each keeps the part the pick is on (an open curve without a pick: its end farther
 * from the corner; a closed curve: the way round its pick is nearer).
 */
export function curveCornerOf(g: SketchGeometry, a: SketchCurve, b: SketchCurve, picks: [Pt | null, Pt | null] = [null, null]): CurveCorner | { error: string } {
    const shared = curveEndIds(a).find((p) => curveEndIds(b).includes(p));
    if (shared) {
        return curveCornerAt(g, shared, a, b);
    }
    const [ga, gb] = [geomOfCurve(g, a), geomOfCurve(g, b)];
    if (!ga || !gb) {
        return { error: 'Pick two curves.' };
    }
    const hits = crossings(ga, gb, { carrierA: true, carrierB: true });
    if (!hits.length) {
        return { error: 'The curves do not meet, even extended.' };
    }
    const score = (h: { at: Pt }) => (picks[0] ? dist(picks[0], h.at) : 0) + (picks[1] ? dist(picks[1], h.at) : 0);
    const hit = hits.reduce((best, h) => (score(h) < score(best) ? h : best));
    const side = (c: SketchCurve, geom: CurveGeom, t0: number, pick: Pt | null): CurveSide => {
        const d = domainOf(geom);
        const t = nearDomain(geom, t0);
        if (d.period) {
            const pt = pick ? closestParam(geom, pick) : t + d.period / 4;
            const ahead = (((pt - t) % d.period) + d.period) % d.period;
            return { curve: c, corner: t, far: ahead < d.period / 2 ? t + d.period : t - d.period, near: null, farId: null };
        }
        const [s, e] = curveEndIds(c);
        const pt = pick ? closestParam(geom, pick) : null;
        const far = pt !== null && Math.abs(pt - t) > 1e-9 ? (pt > t ? d.t1 : d.t0) : Math.abs(d.t1 - t) >= Math.abs(t - d.t0) ? d.t1 : d.t0;
        // A crossing right at an end: that end is the corner's.
        const near = Math.abs(t - d.t0) < 1e-9 ? s : Math.abs(t - d.t1) < 1e-9 ? e : null;
        return { curve: c, corner: t, far, near, farId: far === d.t1 ? e : s };
    };
    return { at: hit.at, point: null, sides: [side(a, ga, hit.ta, picks[0]), side(b, gb, hit.tb, picks[1])] };
}

/** Side relations of a line that stop holding once it is cut back: its length, middle and equal length. */
const sideRelation = (k: SketchConstraint, line: string) => (k.kind === 'length' && k.line === line) || (k.kind === 'midpoint' && k.line === line)
    || (k.kind === 'equal' && (k.a === line || k.b === line)) || extentHeld(k, line);

interface Cut {
    g: SketchGeometry;
    /** The new point ids where each side now ends at the fillet or chamfer. */
    ends: [string, string];
    sharp: string | null;
    dropped: number;
}

/**
 * Cuts both sides back to the parameters t (keeping from t to the far end), the cut ends at new points. With `keep`,
 * relations on a line's length move to a construction line from the sharp corner, and the corner point stays as the
 * sharp when anything holds it; `needSharp` makes the sharp in any case (a chamfer).
 */
function cutSides(g: SketchGeometry, corner: CurveCorner, t: [number, number], keep: boolean, needSharp: boolean): Cut | { error: string } {
    let out = g;
    const before = g.constraints.length;
    let sharp: string | null = null;
    const point = (at: Pt) => {
        const id = newId('p', out);
        out = { ...out, points: [...out.points, { id, u: at[0] + 0, v: at[1] + 0 }] };
        return id;
    };
    const makeSharp = (): string => {
        sharp ??= corner.point ?? point(corner.at);
        return sharp;
    };
    const tied = corner.point !== null && g.constraints.some((k) => constraintRefs(k).includes(corner.point!));
    if (needSharp || (keep && tied)) {
        makeSharp();
    }
    const ends: string[] = [];
    const old = corner.sides.flatMap((s) => curvePointIds(s.curve));
    for (let i = 0; i < 2; i++) {
        const side = corner.sides[i];
        const c = curveOf(out, side.curve.id)!;
        const geom = geomOfCurve(out, c);
        if (!geom) {
            return { error: 'A curve of the corner is missing a point.' };
        }
        const d = domainOf(geom);
        const forward = t[i] < side.far;
        const [lo, hi] = forward ? [t[i], side.far] : [side.far, t[i]];
        // A spline has no path past its ends: it is only cut, never lengthened.
        if (geom.kind === 'bezier' && !d.period && (lo < d.t0 - 1e-9 || hi > d.t1 + 1e-9)) {
            return { error: 'A spline cannot be lengthened to meet the other curve: pick curves that meet.' };
        }
        // The kept far end: the curve's own end point, or (round a closed curve) the corner: the sharp, or a new point.
        const farEnd = side.farId ?? (sharp && d.period ? sharp : point(pointAt(geom, side.far)));
        const touch = point(pointAt(geom, t[i]));
        const next = putPiece(out, out, c, geom, lo, hi, forward ? touch : farEnd, forward ? farEnd : touch, c.id, !!c.construction);
        if (!next) {
            return { error: 'That conic cannot be extended so far.' };
        }
        out = next;
        ends.push(touch);
        if (c.kind === 'line' && out.constraints.some((k) => sideRelation(k, c.id))) {
            if (keep || needSharp) {
                // The line's dimensions and relations move to a construction line from the sharp to its far end.
                const id = newId('c', out);
                const far = side.farId ?? makeSharp();
                out = { ...out, curves: [...out.curves, { id, kind: 'line', a: makeSharp(), b: far, construction: true }] };
                out = {
                    ...out,
                    constraints: out.constraints.map((k) => (!sideRelation(k, c.id) ? k
                        : k.kind === 'equal' || k.kind === 'distance' ? { ...k, a: k.a === c.id ? id : k.a, b: k.b === c.id ? id : k.b }
                            : { ...k, line: id } as SketchConstraint)),
                };
            } else {
                out = { ...out, constraints: out.constraints.filter((k) => !sideRelation(k, c.id)) };
            }
        }
        if (c.kind !== 'line') {
            // A cut-back arc no longer has its arc length.
            out = { ...out, constraints: out.constraints.filter((k) => !extentHeld(k, c.id)) };
        }
    }
    // The old corner point, near ends and points inside the cut-off parts: gone when nothing uses them any more.
    out = dropUnusedPoints(out, [...old, ...(corner.point ? [corner.point] : [])].filter((id) => id !== sharp));
    return { g: out, ends: [ends[0], ends[1]], sharp, dropped: Math.max(0, before - out.constraints.length) };
}

/** The sides as the maths takes them. */
function cornerSides(g: SketchGeometry, corner: CurveCorner): [CornerSide, CornerSide] | null {
    const geoms = corner.sides.map((s) => geomOfCurve(g, s.curve));
    if (!geoms[0] || !geoms[1]) {
        return null;
    }
    return [0, 1].map((i) => ({ ev: geomEval(geoms[i]!), corner: corner.sides[i].corner, far: corner.sides[i].far })) as [CornerSide, CornerSide];
}

/** Whether the sides run on in line at the corner (no corner to round or cut). */
function inLine(sides: [CornerSide, CornerSide]): boolean {
    const turn = cornerTurn(sides[0], sides[1]);
    return turn < 1e-3 || turn > Math.PI - 1e-3;
}

/** The solver's hold of a fillet arc tangent to a side at their shared point. */
function tangency(out: SketchGeometry, arc: string, centre: string, end: string, side: SketchCurve): { g: SketchGeometry; extra: NewConstraint[] } {
    if (side.kind === 'line' || side.kind === 'arc') {
        // A construction spoke from the fillet's centre: square to a line, through an arc's centre (the solver's own
        // tangent relation is degenerate where the curves share a point).
        const spoke = newId('c', out);
        const g = { ...out, curves: [...out.curves, { id: spoke, kind: 'line' as const, a: centre, b: end, construction: true }] };
        return { g, extra: [side.kind === 'line' ? { kind: 'perpendicular', a: spoke, b: side.id } : { kind: 'pointOnCurve', point: side.center, curve: spoke }] };
    }
    return { g: out, extra: [{ kind: 'tangent', a: arc, b: side.id }] };
}

/**
 * The sharp held on each side's curve. Round a closed curve the cut piece already ends at the sharp (its end lies on
 * the curve by itself), and a second hold there would over define the sketch.
 */
function sharpOn(out: SketchGeometry, corner: CurveCorner, sharp: string): NewConstraint[] {
    return corner.sides.filter((s) => !curveEndIds(curveOf(out, s.curve.id) ?? s.curve).includes(sharp))
        .map((s): NewConstraint => ({ kind: 'pointOnCurve', point: sharp, curve: s.curve.id }));
}

export interface CurveFilletResult {
    g: SketchGeometry;
    arc: string;
    dropped: number;
    kept: boolean;
}

/**
 * Rounds the corner of any two curves with a tangent arc of `radius` (see filletSides for the options): the arc found
 * on the exact curves, each side cut exactly where the arc touches it and held tangent to it.
 */
export function filletCurves(g: SketchGeometry, corner: CurveCorner, radius: number, o: { keepCorners?: boolean; equalTo?: string | null } = {}): CurveFilletResult | { error: string } {
    if (!(radius > 0)) {
        return { error: 'Type a radius above zero.' };
    }
    const sides = cornerSides(g, corner);
    if (!sides) {
        return { error: 'A curve of the corner is missing a point.' };
    }
    if (inLine(sides)) {
        return { error: 'The curves run on in line there; there is no corner to round.' };
    }
    const fit = filletFit(sides[0], sides[1], radius, corner.at);
    if (!fit) {
        return { error: 'The radius is too big for these curves.' };
    }
    const keep = o.keepCorners !== false;
    const cut = cutSides(g, corner, fit.t, keep, false);
    if ('error' in cut) {
        return cut;
    }
    let out = cut.g;
    // The touch points sit exactly where the arc meets each side.
    const centre = newId('p', out);
    out = { ...out, points: [...out.points, { id: centre, u: fit.centre[0] + 0, v: fit.centre[1] + 0 }] };
    const arc = newId('c', out);
    const [e1, e2] = cut.ends;
    out = { ...out, curves: [...out.curves, { id: arc, kind: 'arc', center: centre, start: fit.ccw ? e1 : e2, end: fit.ccw ? e2 : e1 }] };
    const extra: NewConstraint[] = [o.equalTo && curveOf(out, o.equalTo) ? { kind: 'equal', a: arc, b: o.equalTo } : { kind: 'radius', curve: arc, value: radius }];
    corner.sides.forEach((side, i) => {
        const r = tangency(out, arc, centre, cut.ends[i], curveOf(out, side.curve.id)!);
        out = r.g;
        extra.push(...r.extra);
    });
    if (cut.sharp) {
        extra.push(...sharpOn(out, corner, cut.sharp));
    }
    for (const c of extra) {
        out = addConstraint(out, c).g;
    }
    return { g: out, arc, dropped: cut.dropped, kept: !!cut.sharp };
}

/**
 * Cuts the corner of any two curves with a straight line: Distance 1 from the corner on the first and Distance 2 (or
 * the same) on the second, measured straight from the corner, or Distance 1 and an angle from the first leg. The
 * corner stays as a sharp point on both curves, joined to the cut by construction legs that carry the dimensions.
 */
export function chamferCurves(g: SketchGeometry, corner: CurveCorner, o: { type: 'distance' | 'angle'; distance: number; distance2?: number; angle?: number }): { g: SketchGeometry } | { error: string } {
    if (!(o.distance > 0) || (o.type === 'distance' && o.distance2 !== undefined && !(o.distance2 > 0))) {
        return { error: 'Type a distance above zero.' };
    }
    const sides = cornerSides(g, corner);
    if (!sides) {
        return { error: 'A curve of the corner is missing a point.' };
    }
    if (inLine(sides)) {
        return { error: 'The curves run on in line there; there is no corner to cut.' };
    }
    const t1 = pointAtDistance(sides[0], corner.at, o.distance);
    if (t1 === null) {
        return { error: 'The distance is too big for these curves.' };
    }
    let t2: number | null;
    if (o.type === 'angle') {
        const theta = ((o.angle ?? 45) * Math.PI) / 180;
        if (!(theta > 0 && theta < Math.PI)) {
            return { error: 'That angle does not meet the second curve.' };
        }
        const p1 = sides[0].ev.at(t1);
        const leg: Pt = [(corner.at[0] - p1[0]) / o.distance, (corner.at[1] - p1[1]) / o.distance];
        // Turned from the leg toward the second curve.
        const away = tangentAt(sides[1].ev, sides[1].corner);
        const outward: Pt = sides[1].far > sides[1].corner ? away : [-away[0], -away[1]];
        const sign = leg[0] * outward[1] - leg[1] * outward[0] >= 0 ? 1 : -1;
        const a = sign * theta;
        const dir: Pt = [leg[0] * Math.cos(a) - leg[1] * Math.sin(a), leg[0] * Math.sin(a) + leg[1] * Math.cos(a)];
        const size = Math.max(curveSize(sides[0].ev, Math.min(sides[0].corner, sides[0].far), Math.max(sides[0].corner, sides[0].far)),
            curveSize(sides[1].ev, Math.min(sides[1].corner, sides[1].far), Math.max(sides[1].corner, sides[1].far)), o.distance);
        t2 = rayHit(sides[1], p1, dir, size * 4);
        if (t2 === null) {
            return { error: 'That angle does not meet the second curve.' };
        }
    } else {
        t2 = pointAtDistance(sides[1], corner.at, o.distance2 ?? o.distance);
        if (t2 === null) {
            return { error: 'The distance is too big for these curves.' };
        }
    }
    const cut = cutSides(g, corner, [t1, t2], true, true);
    if ('error' in cut) {
        return cut;
    }
    let out = cut.g;
    const sharp = cut.sharp!;
    const line = (a: string, b: string, construction = false) => {
        const id = newId('c', out);
        out = { ...out, curves: [...out.curves, { id, kind: 'line', a, b, ...(construction ? { construction: true } : {}) }] };
        return id;
    };
    const chamfer = line(cut.ends[0], cut.ends[1]);
    const legs = cut.ends.map((id) => line(id, sharp, true));
    const d2 = o.type === 'angle' ? null : o.distance2;
    const extra: NewConstraint[] = [
        ...sharpOn(out, corner, sharp),
        { kind: 'length', line: legs[0], value: o.distance },
        o.type === 'angle' ? { kind: 'angle', a: legs[0], b: chamfer, value: o.angle ?? 45 }
            : d2 === undefined || d2 === null ? { kind: 'equal', a: legs[0], b: legs[1] } : { kind: 'length', line: legs[1], value: d2 },
    ];
    for (const c of extra) {
        out = addConstraint(out, c).g;
    }
    return { g: out };
}
