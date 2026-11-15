// Offsets of sketch curves, and the arcs and lines that round or cut a corner between any two of them (Offset
// Entities, Sketch Fillet, Sketch Chamfer). Curves are taken as @jarvis/core/curveIntersect sees them (CurveGeom,
// each with its own parameter) and cut with @jarvis/core/curveSplit; this module adds what those tools need on top:
// second derivatives, the curve moved sideways, a spline fitted to that offset within a tolerance, where offset
// curves cross, the tangent arc of a radius and points at a distance. Coordinates are sketch (u, v) in mm.

import type { SketchSegment } from './index';
import { splineBezier, type P2 } from './curves';
import { pieceDeviations } from './curveFit';
import { bezierPoint, directionAt, domainOf, pointAt, type CurveGeom } from './curveIntersect';

const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const dot = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0];
const len = (a: P2): number => Math.hypot(a[0], a[1]);
const dist = (a: P2, b: P2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const normalize = (a: P2): P2 => {
    const l = len(a);
    return l > 0 ? [a[0] / l, a[1] / l] : [0, 0];
};

/** A curve with position, first and second derivative by its parameter, over its extent t0..t1. */
export interface CurveEval {
    t0: number;
    t1: number;
    /** Closed curves run round with this period. */
    period?: number;
    /** Parameters inside where its polynomial pieces meet (spline points, knots). */
    breaks: number[];
    at(t: number): P2;
    d1(t: number): P2;
    d2(t: number): P2;
}

/** A curve as a function of one parameter: position and first derivative (an offset curve, a ray). */
export interface Param2 {
    at(t: number): P2;
    d1(t: number): P2;
}

/**
 * A CurveGeom prepared for the maths here. Splines run on past their ends along their end pieces (only the offset
 * of a chain uses that, to meet a neighbour's offset; nothing is cut there).
 */
export function geomEval(g: CurveGeom): CurveEval {
    const d = domainOf(g);
    const span = Number.isFinite(d.t1 - d.t0) ? d.t1 - d.t0 : 1;
    let at = (t: number) => pointAt(g, t);
    let d1 = (t: number) => directionAt(g, t);
    if (g.kind === 'bezier' && !g.closed && g.pieces.length) {
        const [first, last] = [g.pieces[0], g.pieces[g.pieces.length - 1]];
        const past = (t: number) => (t < d.t0 ? first : t > d.t1 ? last : null);
        const local = (p: (typeof g.pieces)[number], t: number) => bezierPoint(p.poles, (t - p.t0) / (p.t1 - p.t0));
        at = (t) => {
            const p = past(t);
            return p ? local(p, t).p : pointAt(g, t);
        };
        d1 = (t) => {
            const p = past(t);
            return p ? mul(local(p, t).d, 1 / (p.t1 - p.t0)) : directionAt(g, t);
        };
    }
    // The second derivative by central differences of the first (on one side at a piece's end).
    const h = span * 1e-6;
    const d2 = (t: number): P2 => mul(sub(d1(t + h), d1(t - h)), 1 / (2 * h));
    const breaks = g.kind === 'bezier' ? g.pieces.slice(1).map((p) => p.t0) : [];
    return { t0: d.t0, t1: d.t1, ...(d.period ? { period: d.period } : {}), breaks, at, d1, d2 };
}

/** The same curve run the other way: its parameter t0 + t1 - t (a chain that runs it backward). */
export function reversedEval(ev: CurveEval): CurveEval {
    const flip = (t: number) => ev.t0 + ev.t1 - t;
    return {
        ...ev,
        breaks: ev.breaks.map(flip).reverse(),
        at: (t) => ev.at(flip(t)),
        d1: (t) => mul(ev.d1(flip(t)), -1),
        d2: (t) => ev.d2(flip(t)),
    };
}

/** Unit tangent at t, the way t runs. */
export function tangentAt(ev: Param2, t: number): P2 {
    const d = normalize(ev.d1(t));
    return d[0] === 0 && d[1] === 0 ? [1, 0] : d;
}

/** Signed curvature at t: positive where the curve turns left. */
export function curvatureAt(ev: CurveEval, t: number): number {
    const [c1, c2] = [ev.d1(t), ev.d2(t)];
    const s = len(c1);
    return s > 0 ? cross(c1, c2) / (s * s * s) : 0;
}

/** The curve moved sideways by d (left of the way it runs), and its derivative. */
export function offsetEval(ev: CurveEval, d: number): Param2 {
    return {
        at: (t) => {
            const u = tangentAt(ev, t);
            return add(ev.at(t), [-u[1] * d, u[0] * d]);
        },
        d1: (t) => {
            const [c1, c2] = [ev.d1(t), ev.d2(t)];
            const l = len(c1) || 1e-300;
            // n = rot(c1) / |c1|; n' = rot(c2) / |c1| - rot(c1) (c1 . c2) / |c1|³
            const n1: P2 = sub(mul([-c2[1], c2[0]], 1 / l), mul([-c1[1], c1[0]], dot(c1, c2) / (l * l * l)));
            return add(c1, mul(n1, d));
        },
    };
}

/** Newton's method on a(s) = b(u) from (s, u). */
export function refineCrossing(a: Param2, b: Param2, s0: number, u0: number): { s: number; u: number; at: P2 } | null {
    let [s, u] = [s0, u0];
    for (let k = 0; k < 60; k++) {
        const f = sub(a.at(s), b.at(u));
        if (len(f) < 1e-13) {
            break;
        }
        const [da, db] = [a.d1(s), b.d1(u)];
        const det = cross(da, mul(db, -1));
        if (Math.abs(det) < 1e-300) {
            return null;
        }
        s += cross(mul(f, -1), mul(db, -1)) / det;
        u += cross(da, mul(f, -1)) / det;
        if (!Number.isFinite(s) || !Number.isFinite(u)) {
            return null;
        }
    }
    const at = a.at(s);
    return dist(at, b.at(u)) < 1e-9 ? { s, u, at } : null;
}

/**
 * Where two parametric curves cross (offset curves, rays: what curveIntersect does not take) for s in ra and u in
 * rb: sampled, then refined by Newton's method to the exact crossing.
 */
export function paramCrossings(a: Param2, ra: [number, number], b: Param2, rb: [number, number], samples = 256): { s: number; u: number; at: P2 }[] {
    const pa = Array.from({ length: samples + 1 }, (_, i) => ra[0] + ((ra[1] - ra[0]) * i) / samples);
    const pb = Array.from({ length: samples + 1 }, (_, i) => rb[0] + ((rb[1] - rb[0]) * i) / samples);
    const [qa, qb] = [pa.map((t) => a.at(t)), pb.map((t) => b.at(t))];
    const slackA = Math.abs(ra[1] - ra[0]) * 1e-9;
    const slackB = Math.abs(rb[1] - rb[0]) * 1e-9;
    const inside = (x: number, r: [number, number], slack: number) => x >= Math.min(r[0], r[1]) - slack && x <= Math.max(r[0], r[1]) + slack;
    const out: { s: number; u: number; at: P2 }[] = [];
    for (let i = 0; i < samples; i++) {
        const [p1, p2] = [qa[i], qa[i + 1]];
        for (let j = 0; j < samples; j++) {
            const [p3, p4] = [qb[j], qb[j + 1]];
            if (Math.max(p3[0], p4[0]) < Math.min(p1[0], p2[0]) || Math.min(p3[0], p4[0]) > Math.max(p1[0], p2[0])
                || Math.max(p3[1], p4[1]) < Math.min(p1[1], p2[1]) || Math.min(p3[1], p4[1]) > Math.max(p1[1], p2[1])) {
                continue;
            }
            const den = cross(sub(p2, p1), sub(p4, p3));
            if (Math.abs(den) < 1e-300) {
                continue;
            }
            const x = cross(sub(p3, p1), sub(p4, p3)) / den;
            const y = cross(sub(p3, p1), sub(p2, p1)) / den;
            if (x < -1e-9 || x > 1 + 1e-9 || y < -1e-9 || y > 1 + 1e-9) {
                continue;
            }
            const hit = refineCrossing(a, b, pa[i] + (pa[i + 1] - pa[i]) * x, pb[j] + (pb[j + 1] - pb[j]) * y);
            if (hit && inside(hit.s, ra, slackA) && inside(hit.u, rb, slackB) && !out.some((o) => dist(o.at, hit.at) < 1e-9)) {
                out.push(hit);
            }
        }
    }
    return out;
}

// ---- Offsets --------------------------------------------------------------------------------------------------

/** An offset piece: a line or circle piece stays exact; every other kind is a spline through points of the offset. */
export type OffsetPiece =
    | { kind: 'line'; a: P2; b: P2 }
    | { kind: 'arc'; c: P2; r: number; a: P2; b: P2; ccw: boolean }
    | { kind: 'spline'; points: P2[]; closed: boolean; start?: P2; end?: P2 };

export interface OffsetFit {
    piece: OffsetPiece;
    /** Largest distance between the spline and the true offset, mm (0 when exact). */
    deviation: number;
    within: boolean;
}

/**
 * Curve `g` (as `ev` runs it, maybe backward) offset by d between t0 and t1: a line or circle piece stays one, every
 * other kind is a spline through points of the true offset that keeps within `tolerance` of it (points added where it
 * strays, up to `maxPoints`, starting from the curve's own piece ends). `measure` false skips the final two-way
 * measurement (a preview: the deviation is then the refinement's own estimate). Null when a circle would turn inside out.
 */
export function offsetCurve(g: CurveGeom, ev: CurveEval, d: number, t0: number, t1: number,
    o: { tolerance?: number; maxPoints?: number; measure?: boolean } = {}): OffsetFit | null {
    const f = offsetEval(ev, d);
    if (g.kind === 'line') {
        return { piece: { kind: 'line', a: f.at(t0), b: f.at(t1) }, deviation: 0, within: true };
    }
    if (g.kind === 'circle') {
        const [a, b] = [f.at(t0), f.at(t1)];
        const r = dist(a, g.c);
        if (!(r > 1e-9) || dot(sub(a, g.c), sub(ev.at(t0), g.c)) <= 0) {
            return null;
        }
        return { piece: { kind: 'arc', c: g.c, r, a, b, ccw: cross(sub(ev.at(t0), g.c), ev.d1(t0)) > 0 }, deviation: 0, within: true };
    }
    const tolerance = o.tolerance ?? 1e-6;
    const maxPoints = Math.max(4, o.maxPoints ?? 400);
    const closed = !!ev.period && Math.abs(t1 - t0 - ev.period) < 1e-12;
    const stops = [t0, ...ev.breaks.filter((x) => x > t0 + 1e-9 && x < t1 - 1e-9), t1];
    let params: number[] = [t0];
    const each = Math.max(1, Math.ceil((closed ? 16 : 8) / (stops.length - 1)));
    for (let i = 0; i + 1 < stops.length; i++) {
        for (let k = 1; k <= each; k++) {
            params.push(stops[i] + ((stops[i + 1] - stops[i]) * k) / each);
        }
    }
    const pointsOf = (ps: number[]): P2[] => {
        const pts = ps.map((t) => f.at(t));
        if (closed) {
            pts[pts.length - 1] = pts[0];
        }
        return pts;
    };
    // An open offset leaves its ends the way the true offset does (handles a third of the first chord out).
    const handlesOf = (pts: P2[]): { start?: P2; end?: P2 } => {
        if (closed || pts.length < 3) {
            return {};
        }
        const n = pts.length;
        const [u0, u1] = [normalize(f.d1(params[0])), normalize(f.d1(params[n - 1]))];
        return { start: add(pts[0], mul(u0, dist(pts[0], pts[1]) / 3)), end: sub(pts[n - 1], mul(u1, dist(pts[n - 1], pts[n - 2]) / 3)) };
    };
    /** Each piece's distance from the true offset: three points of it, each projected onto the offset. */
    const estimate = (pts: P2[], handles: { start?: P2; end?: P2 }): number[] => {
        const poles = splineBezier(pts, closed, handles);
        return params.slice(0, -1).map((a, i) => {
            const b = params[i + 1];
            const piece = poles.slice(3 * i, 3 * i + 4);
            let worst = 0;
            for (const u of [0.25, 0.5, 0.75]) {
                const q = bezierPoint(piece, u).p;
                let t = a + (b - a) * u;
                for (let k = 0; k < 8; k++) {
                    const r = sub(f.at(t), q);
                    const gr = f.d1(t);
                    const step = dot(r, gr) / (dot(gr, gr) || 1e-300);
                    t = Math.min(b, Math.max(a, t - step));
                    if (Math.abs(step) < 1e-15) {
                        break;
                    }
                }
                worst = Math.max(worst, dist(f.at(t), q));
            }
            return worst;
        });
    };
    let pts = pointsOf(params);
    let handles = handlesOf(pts);
    let deviation = 0;
    for (let round = 0; round < 64; round++) {
        const devs = estimate(pts, handles);
        const bad = devs.map((x, i) => (x > tolerance * 0.5 ? i : -1)).filter((i) => i >= 0);
        if (!bad.length || params.length >= maxPoints) {
            deviation = Math.max(0, ...devs);
            if (o.measure !== false) {
                const fine = pieceDeviations((t) => f.at(t), params, pts, closed, 8, handles);
                deviation = Math.max(deviation, ...fine);
                if (deviation > tolerance && params.length < maxPoints) {
                    // A worse spot the estimate missed: split there and go on.
                    const worst = fine.indexOf(Math.max(...fine));
                    params = [...params.slice(0, worst + 1), (params[worst] + params[worst + 1]) / 2, ...params.slice(worst + 1)];
                    pts = pointsOf(params);
                    handles = handlesOf(pts);
                    continue;
                }
            }
            break;
        }
        const split = new Set([...bad].sort((x, y) => devs[y] - devs[x]).slice(0, maxPoints - params.length));
        const next: number[] = [];
        params.forEach((t, i) => {
            next.push(t);
            if (split.has(i)) {
                next.push((t + params[i + 1]) / 2);
            }
        });
        params = next;
        pts = pointsOf(params);
        handles = handlesOf(pts);
    }
    return { piece: { kind: 'spline', points: pts, closed, ...handles }, deviation, within: deviation <= tolerance };
}

/** An offset piece as a path segment from its start (a closed spline ends where it starts). */
export function offsetSegment(p: OffsetPiece): { from: P2; seg: SketchSegment } {
    switch (p.kind) {
        case 'line':
            return { from: p.a, seg: { kind: 'line', to: p.b } };
        case 'arc': {
            const a0 = Math.atan2(p.a[1] - p.c[1], p.a[0] - p.c[0]);
            let sweep = Math.atan2(p.b[1] - p.c[1], p.b[0] - p.c[0]) - a0;
            if (p.ccw) {
                while (sweep <= 0) sweep += 2 * Math.PI;
            } else {
                while (sweep >= 0) sweep -= 2 * Math.PI;
            }
            const m = a0 + sweep / 2;
            return { from: p.a, seg: { kind: 'arc', through: [p.c[0] + p.r * Math.cos(m), p.c[1] + p.r * Math.sin(m)], to: p.b } };
        }
        case 'spline':
            return {
                from: p.points[0],
                seg: {
                    kind: 'spline', to: p.points[p.points.length - 1], through: p.points.slice(1, -1),
                    ...(p.start ? { startHandle: p.start } : {}), ...(p.end ? { endHandle: p.end } : {}),
                },
            };
    }
}

// ---- Fillets and chamfers ------------------------------------------------------------------------------------

/** One side of a corner: its curve, the parameter at the corner and at its far end (the part that is kept). */
export interface CornerSide {
    ev: CurveEval;
    /** Parameter where the side meets the corner (past an end for a corner the curves only meet extended). */
    corner: number;
    /** Parameter of the far end: a fillet or chamfer eats from the corner toward it. */
    far: number;
}

const between = (t: number, a: number, b: number, eps: number) => (a < b ? t > a + eps && t < b - eps : t < a - eps && t > b + eps);

export interface FilletFit {
    centre: P2;
    /** Parameters of the touch points on each side, and the points. */
    t: [number, number];
    touch: [P2, P2];
    /** The fillet arc runs counter-clockwise from the first touch point to the second. */
    ccw: boolean;
}

/**
 * The tangent arc of radius r that rounds the corner of two sides: its centre is r from both (where the sides moved by
 * r cross), its touch points lie between the corner and the far ends, and it turns from the first side into the
 * second; the one nearest the corner point. Null when there is none.
 */
export function filletFit(a: CornerSide, b: CornerSide, r: number, corner: P2): FilletFit | null {
    let best: (FilletFit & { score: number }) | null = null;
    const eps = (s: CornerSide) => Math.abs(s.far - s.corner) * 1e-9;
    for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
            const [oa, ob] = [offsetEval(a.ev, sa * r), offsetEval(b.ev, sb * r)];
            for (const hit of paramCrossings(oa, [a.corner, a.far], ob, [b.corner, b.far], 192)) {
                const [ta, tb] = [hit.s, hit.u];
                if (!between(ta, a.corner, a.far, eps(a)) || !between(tb, b.corner, b.far, eps(b))) {
                    continue;
                }
                const [pa, pb] = [a.ev.at(ta), b.ev.at(tb)];
                const c = hit.at;
                // The first side runs toward the corner into the arc, the arc runs out along the second side.
                const inA = mul(tangentAt(a.ev, ta), a.far > a.corner ? -1 : 1);
                const outB = mul(tangentAt(b.ev, tb), b.far > b.corner ? 1 : -1);
                const ccw = cross(sub(pa, c), inA) > 0;
                const leave: P2 = ccw ? [-(pb[1] - c[1]), pb[0] - c[0]] : [pb[1] - c[1], -(pb[0] - c[0])];
                if (dot(leave, outB) <= 0) {
                    continue;
                }
                const score = dist(pa, corner) + dist(pb, corner);
                if (!best || score < best.score) {
                    best = { centre: c, t: [ta, tb], touch: [pa, pb], ccw, score };
                }
            }
        }
    }
    if (!best) {
        return null;
    }
    const { score: _s, ...out } = best;
    return out;
}

/**
 * The point of a side at straight distance d from `from` (the corner), the first one going from the corner toward
 * the far end; its parameter. Null when the side is not that long.
 */
export function pointAtDistance(s: CornerSide, from: P2, d: number, samples = 400): number | null {
    const g = (t: number) => dist(s.ev.at(t), from) - d;
    let prev = s.corner;
    let gp = g(prev);
    for (let i = 1; i <= samples; i++) {
        const t = s.corner + ((s.far - s.corner) * i) / samples;
        const gt = g(t);
        if (gp < 0 && gt >= 0) {
            let [lo, hi] = [prev, t];
            for (let k = 0; k < 200 && Math.abs(hi - lo) > 1e-16 * Math.max(1, Math.abs(hi)); k++) {
                const m = (lo + hi) / 2;
                if (g(m) < 0) {
                    lo = m;
                } else {
                    hi = m;
                }
            }
            return (lo + hi) / 2;
        }
        prev = t;
        gp = gt;
    }
    return null;
}

/** Where the line from p in direction dir (forward only) first meets a side between its corner and far end. */
export function rayHit(s: CornerSide, p: P2, dir: P2, reach: number): number | null {
    const ray: Param2 = { at: (l) => add(p, mul(dir, l)), d1: () => dir };
    const eps = Math.abs(s.far - s.corner) * 1e-9;
    const hits = paramCrossings(ray, [0, reach], s.ev, [s.corner, s.far], 256)
        .filter((h) => h.s > 1e-9 && between(h.u, s.corner, s.far, eps))
        .sort((x, y) => x.s - y.s);
    return hits.length ? hits[0].u : null;
}

/** Turning angle between the sides' directions away from the corner (0 or pi: they run on in line). */
export function cornerTurn(a: CornerSide, b: CornerSide): number {
    const da = mul(tangentAt(a.ev, a.corner), a.far > a.corner ? 1 : -1);
    const db = mul(tangentAt(b.ev, b.corner), b.far > b.corner ? 1 : -1);
    return Math.acos(Math.max(-1, Math.min(1, dot(da, db))));
}

/** Rough size of a curve between two parameters (its sampled extent), for how far to look. */
export function curveSize(ev: Param2, lo: number, hi: number): number {
    const pts = Array.from({ length: 33 }, (_, i) => ev.at(lo + ((hi - lo) * i) / 32));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}
