// Curves cut where they meet, for the region finder (sketchRegions.ts): two curves that cross, or one that ends on
// another, meet at a point the graph of the sketch would otherwise not know, so the areas on either side of the
// crossing could not be told apart. Each curve is cut there into exact pieces of its own kind (a line's piece is a
// line, an arc's an arc on the same circle, a partial ellipse's on the same ellipse, a conic's a conic, a spline's
// its own Bezier spans), and the pieces meet at the crossing exactly. Closed curves (circles, ellipses, closed
// splines) need two cuts to open; with fewer they stay whole. Rational style splines are left as they are.

import type { SketchSegment } from '@jarvis/core';
import { conicWeight, ellipseAxes, ellipseSweep, segmentShape } from '@jarvis/core/curves';
import { boundsOf, closestParam, crossings, domainOf, pointAt, type CurveGeom } from '@jarvis/core/curveIntersect';
import { bezierRange, bsplineGeom, conicPiece, splineGeom } from '@jarvis/core/curveSplit';
import { circleThrough, curveEntity, dist, type Entity, type Pt } from './sketchMath';

const TAU = 2 * Math.PI;
/** As sketchRegions' MERGE: points closer than this are one vertex, so cuts closer than this are one cut. */
const NEAR = 1e-3;
/** An end this close to a curve lies on it (as Trim takes it, sketchCut.ts). */
const TOUCH = 1e-4;

/** A curve with its own parameter: the entity runs from t0 (its start) to t1 (its end), which may be the lower. */
interface Cuttable {
    geom: CurveGeom;
    t0: number;
    t1: number;
    /** Closed curves: the parameter runs once round from t0 to t1 = t0 + period. */
    closed: boolean;
    /** The piece from parameter ta to tb, running from p to q (in the entity's direction). */
    piece(ta: number, tb: number, p: Pt, q: Pt, id: string): Entity[];
}

const norm = (a: number) => ((a % TAU) + TAU) % TAU;

function circleCuttable(c: Pt, r: number, from: number, sweep: number, t0: number, t1: number, closed: boolean): Cuttable {
    const geom: CurveGeom = closed ? { kind: 'circle', c, r } : { kind: 'circle', c, r, from, sweep };
    return {
        geom, t0, t1, closed,
        piece: (ta, tb, p, q, id) => [{ id, kind: 'arc', a: p, b: q, m: pointAt(geom, (ta + tb) / 2) }],
    };
}

/** The arc from a through m to b. */
function arcCuttable(a: Pt, m: Pt, b: Pt): Cuttable | null {
    const circle = circleThrough(a, m, b);
    if (!circle) {
        return null;
    }
    const ang = (p: Pt) => Math.atan2(p[1] - circle.c[1], p[0] - circle.c[0]);
    // Counter-clockwise from a to b when m is right of the chord a→b.
    const ccw = (b[0] - a[0]) * (m[1] - a[1]) - (b[1] - a[1]) * (m[0] - a[0]) < 0;
    if (ccw) {
        const from = ang(a);
        const sweep = norm(ang(b) - from) || TAU;
        return circleCuttable(circle.c, circle.r, from, sweep, from, from + sweep, false);
    }
    const from = ang(b);
    const sweep = norm(ang(a) - from) || TAU;
    return circleCuttable(circle.c, circle.r, from, sweep, from + sweep, from, false);
}

/** Polynomial Bezier spans of a spline geom from ta to tb, in that direction (a closed one may run on past its start). */
function bezierSpans(g: Extract<CurveGeom, { kind: 'bezier' }>, ta: number, tb: number): Pt[][] {
    const [lo, hi] = ta <= tb ? [ta, tb] : [tb, ta];
    const d = domainOf(g);
    const out: Pt[][] = [];
    let t = lo;
    for (let guard = 0; t < hi - 1e-12 && guard < 100000; guard++) {
        const shift = d.period ? Math.floor((t - d.t0) / d.period + 1e-12) * d.period : 0;
        const local = t - shift;
        const piece = g.pieces.find((p) => local >= p.t0 - 1e-12 && local < p.t1 - 1e-12) ?? g.pieces[g.pieces.length - 1];
        const end = Math.min(hi, piece.t1 + shift);
        const len = piece.t1 - piece.t0;
        const s0 = Math.max(0, Math.min(1, (local - piece.t0) / len));
        const s1 = Math.max(0, Math.min(1, (end - shift - piece.t0) / len));
        if (s1 > s0 + 1e-15) {
            out.push(bezierRange(piece.poles, s0, s1));
        }
        if (end <= t) {
            break;
        }
        t = end;
    }
    return ta <= tb ? out : out.reverse().map((p) => [...p].reverse());
}

function bezierCuttable(geom: Extract<CurveGeom, { kind: 'bezier' }>): Cuttable {
    const d = domainOf(geom);
    return {
        geom, t0: d.t0, t1: d.t1, closed: !!d.period,
        piece: (ta, tb, p, q, id) => {
            const spans = bezierSpans(geom, ta, tb);
            return spans.map((poles, j) => {
                const from = j === 0 ? p : poles[0];
                const to = j === spans.length - 1 ? q : poles[poles.length - 1];
                const seg: SketchSegment = { kind: 'bspline', to, poles: poles.slice(1, -1), degree: poles.length - 1 };
                return curveEntity(spans.length === 1 ? id : `${id}.${j}`, from, seg);
            });
        },
    };
}

function segmentCuttable(a: Pt, seg: SketchSegment): Cuttable | null {
    switch (seg.kind) {
        case 'line':
            return lineCuttable(a, seg.to);
        case 'arc':
            return arcCuttable(a, seg.through, seg.to);
        case 'ellipse': {
            const e = ellipseAxes(seg.center, seg.major, seg.minor);
            if (!(e.a > 0 && e.b > 0)) {
                return null;
            }
            const { start, sweep } = ellipseSweep(e, a, seg.to, seg.ccw);
            const geom: CurveGeom = { kind: 'ellipse', e, from: Math.min(start, start + sweep), sweep: Math.abs(sweep) };
            return {
                geom, t0: start, t1: start + sweep, closed: false,
                piece: (_ta, _tb, p, q, id) => [curveEntity(id, p, { ...seg, to: q })],
            };
        }
        case 'conic': {
            const geom: Extract<CurveGeom, { kind: 'conic' }> = { kind: 'conic', p0: a, p1: seg.apex, p2: seg.to, w: conicWeight(seg.rho) };
            return {
                geom, t0: 0, t1: Math.PI / 2, closed: false,
                piece: (ta, tb, p, q, id) => {
                    const part = conicPiece(geom, Math.min(ta, tb), Math.max(ta, tb));
                    return part ? [curveEntity(id, p, { kind: 'conic', to: q, apex: part.apex, rho: part.rho })] : [];
                },
            };
        }
        case 'spline': {
            const closed = dist(a, seg.to) < 1e-9;
            const points = [a, ...seg.through, ...(closed ? [] : [seg.to])];
            return points.length < 2 ? null : bezierCuttable(splineGeom(points, closed, segmentShape(seg)));
        }
        case 'bspline':
            // A rational one is not cut (its pieces would need their weights).
            return seg.weights?.some((w) => w !== 1) ? null : bezierCuttable(bsplineGeom([a, ...seg.poles, seg.to], seg.degree, seg.knots));
    }
}

function lineCuttable(a: Pt, b: Pt): Cuttable | null {
    return dist(a, b) < 1e-12 ? null : {
        geom: { kind: 'line', a, b }, t0: 0, t1: 1, closed: false,
        piece: (_ta, _tb, p, q, id) => [{ id, kind: 'line', a: p, b: q }],
    };
}

function cuttableOf(e: Entity): Cuttable | null {
    switch (e.kind) {
        case 'line':
            return lineCuttable(e.a, e.b);
        case 'arc':
            return arcCuttable(e.a, e.m, e.b);
        case 'circle':
            return e.r > 0 ? circleCuttable(e.c, e.r, 0, TAU, 0, TAU, true) : null;
        case 'ellipse': {
            const ax = ellipseAxes(e.c, e.major, e.minor);
            if (!(ax.a > 0 && ax.b > 0)) {
                return null;
            }
            const geom: CurveGeom = { kind: 'ellipse', e: ax };
            return {
                geom, t0: 0, t1: TAU, closed: true,
                piece: (ta, tb, p, q, id) => [curveEntity(id, p, { kind: 'ellipse', to: q, center: e.c, major: e.major, minor: e.minor, ccw: tb > ta })],
            };
        }
        case 'curve':
            return segmentCuttable(e.a, e.seg);
        default:
            // Rectangles, slots and polygons only come from sketches written as profiles: they stay whole.
            return null;
    }
}

/** A cut of one curve: where along it (0 at its start, 1 at its end), the point, and the vertex id it takes. */
interface Cut {
    s: number;
    t: number;
    at: Pt;
    vertex: string;
}

/** Crossings worked out per pair of curves, by their values: a drag changes a few curves and the rest are found here again. */
const MAX_KEPT = 20000;
const crossingsKept = new Map<string, { ta: number; tb: number; at: Pt }[]>();

/** Forgets what was kept (for tests). */
export function clearCrossingStore(): void {
    crossingsKept.clear();
}

function crossingsOf(keyA: string, keyB: string, a: CurveGeom, b: CurveGeom): { ta: number; tb: number; at: Pt }[] {
    const key = `${keyA}|${keyB}`;
    let found = crossingsKept.get(key);
    if (!found) {
        found = crossings(a, b).map((h) => ({ ta: h.ta, tb: h.tb, at: h.at as Pt }));
        if (crossingsKept.size >= MAX_KEPT) {
            crossingsKept.delete(crossingsKept.keys().next().value!);
        }
        crossingsKept.set(key, found);
    }
    return found;
}

const valueKey = (e: Entity): string => JSON.stringify(e, (k, v) => (k === 'id' ? undefined : v));

/**
 * The entities with every curve cut where another crosses it or ends on it, and the end vertex ids of the pieces
 * (`ends` as sketchRegions takes it: start and end point id per curve). Curves nothing cuts come back as they are.
 */
export function splitAtCrossings(entities: Entity[], ends: Map<string, [string, string]>): { entities: Entity[]; ends: Map<string, [string, string]> } {
    const items = entities.map((e, i) => {
        const c = cuttableOf(e);
        const box = c ? boundsOf(c.geom) : null;
        return { e, i, c, box, key: c ? valueKey(e) : '', cuts: [] as Cut[] };
    });
    const live = items.filter((x) => x.c && x.box);
    if (live.length < 2) {
        return { entities, ends };
    }
    const along = (x: (typeof items)[number], t: number): number => {
        const c = x.c!;
        const s = (t - c.t0) / (c.t1 - c.t0);
        return c.closed ? ((s % 1) + 1) % 1 : s;
    };
    const endPoints = (x: (typeof items)[number]): [Pt, Pt] | null => (x.c!.closed ? null
        : x.e.kind === 'line' || x.e.kind === 'arc' || x.e.kind === 'curve' ? [x.e.a, x.e.b] : null);
    let next = 0;
    // Pairs whose boxes overlap: swept along u.
    const order = [...live].sort((p, q) => p.box![0] - q.box![0]);
    const active: typeof live = [];
    for (const x of order) {
        const [u0, v0, u1, v1] = x.box!;
        for (let k = active.length - 1; k >= 0; k--) {
            if (active[k].box![2] < u0 - NEAR) {
                active.splice(k, 1);
            }
        }
        for (const y of active) {
            const [, w0, , w1] = y.box!;
            if (w1 < v0 - NEAR || w0 > v1 + NEAR) {
                continue;
            }
            const [a, b] = x.i < y.i ? [x, y] : [y, x];
            for (const h of crossingsOf(a.key, b.key, a.c!.geom, b.c!.geom)) {
                const vertex = `x:${next++}`;
                a.cuts.push({ s: along(a, h.ta), t: h.ta, at: h.at, vertex });
                b.cuts.push({ s: along(b, h.tb), t: h.tb, at: h.at, vertex });
            }
            // An end of one lying on the other (a T), caught even when rounding puts it a hair off.
            for (const [p, q] of [[a, b], [b, a]] as const) {
                const own = endPoints(p);
                if (!own) {
                    continue;
                }
                own.forEach((end, k) => {
                    const [bu0, bv0, bu1, bv1] = q.box!;
                    if (end[0] < bu0 - NEAR || end[0] > bu1 + NEAR || end[1] < bv0 - NEAR || end[1] > bv1 + NEAR) {
                        return;
                    }
                    const t = closestParam(q.c!.geom, end);
                    if (dist(pointAt(q.c!.geom, t), end) < TOUCH) {
                        const id = ends.get(p.e.id)?.[k];
                        q.cuts.push({ s: along(q, t), t, at: end, vertex: id ?? `x:${next++}` });
                    }
                });
            }
        }
        active.push(x);
    }
    const out: Entity[] = [];
    const outEnds = new Map(ends);
    for (const x of items) {
        const pieces = x.c && x.cuts.length ? cutInPieces(x.e, x.c, x.cuts, ends.get(x.e.id)) : null;
        if (!pieces) {
            out.push(x.e);
            continue;
        }
        for (const p of pieces) {
            out.push(p.entity);
            outEnds.set(p.entity.id, p.ends);
        }
    }
    return { entities: out, ends: outEnds };
}

/** The pieces of one curve between its cuts, or null when none cuts it inside (a closed curve: fewer than two). */
function cutInPieces(e: Entity, c: Cuttable, all: Cut[], own: [string, string] | undefined): { entity: Entity; ends: [string, string] }[] | null {
    const start = e.kind === 'line' || e.kind === 'arc' || e.kind === 'curve' ? e.a : pointAt(c.geom, c.t0) as Pt;
    const end = e.kind === 'line' || e.kind === 'arc' || e.kind === 'curve' ? e.b : start;
    // Cuts at the curve's own ends need nothing (the ends are vertices already); cuts at one place are one cut.
    const cuts: Cut[] = [];
    for (const k of [...all].sort((p, q) => p.s - q.s)) {
        if (!c.closed && (k.s <= 0 || k.s >= 1 || dist(k.at, start) < NEAR || dist(k.at, end) < NEAR)) {
            continue;
        }
        const last = cuts[cuts.length - 1];
        if (last && dist(last.at, k.at) < NEAR) {
            // A sketch point there (the end of the curve that touches it) is the vertex to share.
            if (last.vertex.startsWith('x:') && !k.vertex.startsWith('x:')) {
                cuts[cuts.length - 1] = k;
            }
            continue;
        }
        cuts.push(k);
    }
    if (c.closed && cuts.length > 1 && dist(cuts[0].at, cuts[cuts.length - 1].at) < NEAR) {
        cuts.pop();
    }
    if (cuts.length < (c.closed ? 2 : 1)) {
        return null;
    }
    const span = c.t1 - c.t0;
    const stops: { s: number; at: Pt; vertex: string }[] = c.closed
        ? [...cuts, { ...cuts[0], s: cuts[0].s + 1 }]
        : [{ s: 0, at: start, vertex: own?.[0] ?? `${e.id}:a` }, ...cuts, { s: 1, at: end, vertex: own?.[1] ?? `${e.id}:b` }];
    const out: { entity: Entity; ends: [string, string] }[] = [];
    for (let k = 0; k + 1 < stops.length; k++) {
        const [p, q] = [stops[k], stops[k + 1]];
        const id = `${e.id}~${k}`;
        const made = c.piece(c.t0 + p.s * span, c.t0 + q.s * span, p.at, q.at, id);
        made.forEach((m, j) => {
            const a = j === 0 ? p.vertex : `${id}^${j}`;
            const b = j === made.length - 1 ? q.vertex : `${id}^${j + 1}`;
            out.push({ entity: m, ends: [a, b] });
        });
    }
    return out;
}
