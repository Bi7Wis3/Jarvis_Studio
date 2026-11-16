// IGES curves as evaluable curve segments in mm: circular arcs (100), composite curves (102), conic arcs (104),
// copious data (106), lines (110), parametric splines (112) and rational B-splines (126), each through its
// transformation matrix. Parameter-space curves (in a surface's (u, v)) are read the same way, with z = 0 and
// without the parent's 3D transformation. Also exact NURBS forms of the segments (for ruled surfaces, extrusions
// along composite curves and parameter-space curves).

import { CircleCurve, EllipseCurve, LineCurve, NurbsCurve, type Curve } from '../sldprt/geometry.js';
import {
    add, cross, dist, insertKnot, knotsWithMults, nurbsJoin, nurbsSegment, scale, sub, unit,
    type Nurbs, type V3,
} from '../sldprt/nurbs.js';
import { nurbsRecord } from '../sldprt/brep.js';
import { apply, frame, IgesGeometryError, int, num, point, scaleOf, type IgesModel, type Xf } from './model.js';
import type { IgesEntity } from './parse.js';

/** A piece of a curve between two of its parameters. */
export interface Seg {
    curve: Curve;
    first: number;
    last: number;
}

export const segStart = (s: Seg): V3 => s.curve.eval(s.first).p;
export const segEnd = (s: Seg): V3 => s.curve.eval(s.last).p;

/** Curve entity types the reader turns into segments. */
export const CURVE_TYPES = new Set([100, 102, 104, 106, 110, 112, 126]);

const TWO_PI = 2 * Math.PI;

/** The segments of a curve entity, in mm (or parameter space when `parent` is the identity of a 2D curve). */
export function curveSegments(m: IgesModel, e: IgesEntity, parent: Xf, depth = 0): Seg[] {
    const x = m.xf(e, parent);
    switch (e.type) {
        case 100:
            return [arc(e, x)];
        case 102: {
            if (depth > 16) {
                throw new IgesGeometryError('composite curves nest too deeply');
            }
            const n = int(e, 0);
            const out: Seg[] = [];
            for (let k = 1; k <= n; k++) {
                const c = m.entity(int(e, k));
                if (c && c.type !== 116) {
                    out.push(...curveSegments(m, c, x, depth + 1));
                }
            }
            return out;
        }
        case 104:
            return [conic(e, x)];
        case 106:
            return polyline(e, x);
        case 110: {
            const p0 = apply(x, point(e, 0));
            const p1 = apply(x, point(e, 3));
            const len = dist(p0, p1);
            if (len < 1e-12) {
                return [];
            }
            return [{ curve: new LineCurve(p0, unit(sub(p1, p0))), first: 0, last: len }];
        }
        case 112:
            return splineCurve(e, x);
        case 126:
            return [bspline(e, x)];
        case 130:
            throw new IgesGeometryError('offset curves (130) are not read');
        default:
            throw new IgesGeometryError(`entity type ${e.type} is not a curve the studio reads`);
    }
}

function arc(e: IgesEntity, x: Xf): Seg {
    const zt = num(e, 0);
    const c: V3 = [num(e, 1), num(e, 2), zt];
    const s: V3 = [num(e, 3), num(e, 4), zt];
    const t: V3 = [num(e, 5), num(e, 6), zt];
    const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
    if (!(r > 0)) {
        throw new IgesGeometryError('a circular arc of zero radius');
    }
    const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
    let a1 = Math.atan2(t[1] - c[1], t[0] - c[0]);
    if (Math.hypot(t[0] - s[0], t[1] - s[1]) < 1e-9 * Math.max(1, r)) {
        a1 = a0 + TWO_PI;
    } else {
        while (a1 <= a0) {
            a1 += TWO_PI;
        }
    }
    const f = frame(x);
    return { curve: new CircleCurve(apply(x, c), f.n, f.x, r * scaleOf(x)), first: a0, last: a1 };
}

/** Q(x, y) = A x^2 + B x y + C y^2 + D x + E y + F. */
function conic(e: IgesEntity, x: Xf): Seg {
    const [A, B, C, D, E, F, zt] = [0, 1, 2, 3, 4, 5, 6].map((k) => num(e, k));
    const P0: [number, number] = [num(e, 7), num(e, 8)];
    const P2: [number, number] = [num(e, 9), num(e, 10)];
    const q = (px: number, py: number): number => A * px * px + B * px * py + C * py * py + D * px + E * py + F;
    const det = A * C - (B * B) / 4;
    const scaleQ = Math.max(Math.abs(A), Math.abs(B), Math.abs(C), 1e-300);
    if (det / (scaleQ * scaleQ) > 1e-12) {
        // Ellipse: centre, principal axes, semi-axes.
        const cx = (B * E - 2 * C * D) / (4 * A * C - B * B);
        const cy = (B * D - 2 * A * E) / (4 * A * C - B * B);
        const f = q(cx, cy);
        const theta = 0.5 * Math.atan2(B, A - C);
        const ct = Math.cos(theta);
        const st = Math.sin(theta);
        const l1 = A * ct * ct + B * ct * st + C * st * st;
        const l2 = A * st * st - B * ct * st + C * ct * ct;
        let ra = Math.sqrt(-f / l1);
        let rb = Math.sqrt(-f / l2);
        if (!(ra > 0 && rb > 0)) {
            throw new IgesGeometryError('a conic arc with no real points');
        }
        let ax: [number, number] = [ct, st];
        if (rb > ra) {
            [ra, rb] = [rb, ra];
            ax = [-st, ct];
        }
        const ay: [number, number] = [-ax[1], ax[0]];
        const angle = (p: [number, number]): number => Math.atan2(((p[0] - cx) * ay[0] + (p[1] - cy) * ay[1]) / rb, ((p[0] - cx) * ax[0] + (p[1] - cy) * ax[1]) / ra);
        const a0 = angle(P0);
        let a1 = angle(P2);
        if (Math.hypot(P2[0] - P0[0], P2[1] - P0[1]) < 1e-9 * ra) {
            a1 = a0 + TWO_PI;
        } else {
            while (a1 <= a0) {
                a1 += TWO_PI;
            }
        }
        const c3 = apply(x, [cx, cy, zt]);
        const xa = unit(sub(apply(x, [cx + ax[0], cy + ax[1], zt]), c3));
        const ya = unit(sub(apply(x, [cx + ay[0], cy + ay[1], zt]), c3));
        const s = scaleOf(x);
        return { curve: new EllipseCurve(c3, cross(xa, ya), xa, ra * s, rb * s), first: a0, last: a1 };
    }
    // Parabola or hyperbola: one rational quadratic Bezier between the ends (the arc turns less than half a turn).
    const grad = (p: [number, number]): [number, number] => [2 * A * p[0] + B * p[1] + D, B * p[0] + 2 * C * p[1] + E];
    const g0 = grad(P0);
    const g2 = grad(P2);
    const t0: [number, number] = [-g0[1], g0[0]];
    const t2: [number, number] = [-g2[1], g2[0]];
    // P0 + s t0 = P2 + r t2
    const den = t0[0] * -t2[1] - t0[1] * -t2[0];
    if (Math.abs(den) < 1e-300) {
        throw new IgesGeometryError('a conic arc whose end tangents are parallel');
    }
    const dx = P2[0] - P0[0];
    const dy = P2[1] - P0[1];
    const sParam = (dx * -t2[1] - dy * -t2[0]) / den;
    const P1: [number, number] = [P0[0] + sParam * t0[0], P0[1] + sParam * t0[1]];
    const S: [number, number] = [(P0[0] + P2[0]) / 2, (P0[1] + P2[1]) / 2];
    // Q(S + s (P1 - S)) = a s^2 + b s + c: the shoulder point.
    const d: [number, number] = [P1[0] - S[0], P1[1] - S[1]];
    const qa = A * d[0] * d[0] + B * d[0] * d[1] + C * d[1] * d[1];
    const gS = grad(S);
    const qb = gS[0] * d[0] + gS[1] * d[1];
    const qc = q(S[0], S[1]);
    let sh = 0.5;
    if (Math.abs(qa) > 1e-300) {
        const disc = Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc));
        const roots = [(-qb + disc) / (2 * qa), (-qb - disc) / (2 * qa)].filter((r) => r > 0 && r < 1);
        sh = roots.length ? roots[0] : 0.5;
    } else if (Math.abs(qb) > 1e-300) {
        sh = -qc / qb;
    }
    const w = sh / (1 - sh);
    const pts = [P0, P1, P2].map((p) => apply(x, [p[0], p[1], zt]));
    const nurbs: Nurbs = { degree: 2, knots: [0, 0, 0, 1, 1, 1], cw: [[...pts[0], 1], [...scale(pts[1], w), w], [...pts[2], 1]], rational: true };
    return { curve: new NurbsCurve(nurbs, false), first: 0, last: 1 };
}

function polyline(e: IgesEntity, x: Xf): Seg[] {
    const ip = int(e, 0);
    const n = int(e, 1);
    const pts: V3[] = [];
    if (ip === 1) {
        const zt = num(e, 2);
        for (let k = 0; k < n; k++) {
            pts.push(apply(x, [num(e, 3 + 2 * k), num(e, 4 + 2 * k), zt]));
        }
    } else {
        const stride = ip === 3 ? 6 : 3;
        for (let k = 0; k < n; k++) {
            pts.push(apply(x, point(e, 2 + stride * k)));
        }
    }
    const out: Seg[] = [];
    for (let k = 0; k + 1 < pts.length; k++) {
        const len = dist(pts[k], pts[k + 1]);
        if (len > 1e-12) {
            out.push({ curve: new LineCurve(pts[k], unit(sub(pts[k + 1], pts[k]))), first: 0, last: len });
        }
    }
    return out;
}

/** Cubic pieces in power form, each as a cubic Bezier segment over its break points (exact; pieces may meet at corners). */
function splineCurve(e: IgesEntity, x: Xf): Seg[] {
    const n = int(e, 3);
    const ndim = int(e, 2);
    if (n < 1) {
        throw new IgesGeometryError('a parametric spline curve without segments');
    }
    const T = Array.from({ length: n + 1 }, (_, k) => num(e, 4 + k));
    const at = 4 + n + 1;
    const out: Seg[] = [];
    for (let i = 0; i < n; i++) {
        const h = T[i + 1] - T[i];
        if (!(h > 0)) {
            continue;
        }
        const c = (axis: number, k: number): number => (axis === 2 && ndim === 2 ? 0 : num(e, at + 12 * i + axis * 4 + k));
        // Power form in u = s / h: a0 + a1 u + a2 u^2 + a3 u^3 per axis, then Bezier points.
        const bez: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let axis = 0; axis < 3; axis++) {
            const a0 = c(axis, 0);
            const a1 = c(axis, 1) * h;
            const a2 = c(axis, 2) * h * h;
            const a3 = c(axis, 3) * h * h * h;
            bez[0][axis] = a0;
            bez[1][axis] = a0 + a1 / 3;
            bez[2][axis] = a0 + (2 * a1) / 3 + a2 / 3;
            bez[3][axis] = a0 + a1 + a2 + a3;
        }
        const nurbs: Nurbs = {
            degree: 3, knots: [T[i], T[i], T[i], T[i], T[i + 1], T[i + 1], T[i + 1], T[i + 1]],
            cw: bez.map((p) => [...apply(x, p), 1]), rational: false,
        };
        out.push({ curve: new NurbsCurve(nurbs, false), first: T[i], last: T[i + 1] });
    }
    return out;
}

/** The B-spline of a 126 entity, homogeneous, through the transformation. */
export function nurbsOf126(e: IgesEntity, x: Xf): { nurbs: Nurbs; range: [number, number] } {
    const K = int(e, 0);
    const M = int(e, 1);
    const polynomial = int(e, 4) === 1;
    if (K < 1 || M < 1 || M > 25) {
        throw new IgesGeometryError(`a B-spline curve of degree ${M} with ${K + 1} poles`);
    }
    const nKnots = K + M + 2;
    const knots = Array.from({ length: nKnots }, (_, k) => num(e, 6 + k));
    const wAt = 6 + nKnots;
    const pAt = wAt + K + 1;
    const cw: number[][] = [];
    for (let i = 0; i <= K; i++) {
        const w = polynomial ? 1 : num(e, wAt + i, 1);
        if (!(w > 0)) {
            throw new IgesGeometryError('a B-spline curve with a weight that is not positive');
        }
        const p = apply(x, point(e, pAt + 3 * i));
        cw.push([p[0] * w, p[1] * w, p[2] * w, w]);
    }
    const vAt = pAt + 3 * (K + 1);
    const lo = knots[M];
    const hi = knots[K + 1];
    let v0 = num(e, vAt, lo);
    let v1 = num(e, vAt + 1, hi);
    if (!(v1 > v0)) {
        [v0, v1] = [lo, hi];
    }
    return { nurbs: { degree: M, knots, cw, rational: !polynomial }, range: [Math.max(lo, v0), Math.min(hi, v1)] };
}

function bspline(e: IgesEntity, x: Xf): Seg {
    const { nurbs, range } = nurbsOf126(e, x);
    return { curve: new NurbsCurve(nurbs, false), first: range[0], last: range[1] };
}

// ---- Records ----------------------------------------------------------------------------------------------

const fmt = (v: number): string => (v === 0 ? '0' : String(v));
const v3 = (v: V3): string => `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`;

/** A segment as a B-rep text curve record, with the record's parameter range. */
export function curveRecord(s: Seg): { rec: string; first: number; last: number } {
    const c = s.curve;
    if (c instanceof LineCurve) {
        return { rec: `1 ${v3(c.p0)} ${v3(c.dir)}`, first: s.first, last: s.last };
    }
    if (c instanceof CircleCurve) {
        return { rec: `2 ${v3(c.c)} ${v3(c.n)} ${v3(c.x)} ${v3(c.y)} ${fmt(c.r)}`, first: s.first, last: s.last };
    }
    // Ellipses go as their exact rational B-splines: OpenCascade's sewing does not match closed elliptic edges.
    const n = segNurbs(s);
    return { rec: nurbsRecord(n), first: n.knots[0], last: n.knots[n.knots.length - 1] };
}

/** A whole curve (the profile of a swept or spun surface) as a record, for its full parameter range. */
export function wholeCurveRecord(s: Seg): string {
    const c = s.curve;
    if (c instanceof LineCurve || c instanceof CircleCurve || c instanceof EllipseCurve) {
        return curveRecord(s).rec;
    }
    return nurbsRecord(segNurbs(s));
}

// ---- Exact NURBS forms ------------------------------------------------------------------------------------

/** Rational quadratic arcs of the unit circle from a0 to a1, as (cos, sin, weight) poles with knots. */
function unitArc(a0: number, a1: number): { poles: [number, number, number][]; knots: number[] } {
    const sweep = a1 - a0;
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / n;
    const w = Math.cos(step / 2);
    const poles: [number, number, number][] = [[Math.cos(a0), Math.sin(a0), 1]];
    const knots = [a0, a0, a0];
    for (let i = 0; i < n; i++) {
        const s = a0 + step * i;
        const mid = s + step / 2;
        const e = s + step;
        poles.push([Math.cos(mid) / w, Math.sin(mid) / w, w], [Math.cos(e), Math.sin(e), 1]);
        knots.push(...(i === n - 1 ? [e, e, e] : [e, e]));
    }
    return { poles, knots };
}

/** A segment as an exact NURBS over [first, last] (lines degree 1, circles and ellipses rational quadratic). */
export function segNurbs(s: Seg): Nurbs {
    const c = s.curve;
    if (c instanceof LineCurve) {
        const p0 = c.eval(s.first).p;
        const p1 = c.eval(s.last).p;
        return { degree: 1, knots: [s.first, s.first, s.last, s.last], cw: [[...p0, 1], [...p1, 1]], rational: false };
    }
    if (c instanceof CircleCurve || c instanceof EllipseCurve) {
        const [ra, rb] = c instanceof CircleCurve ? [c.r, c.r] : [c.a, c.b];
        const { poles, knots } = unitArc(s.first, s.last);
        const cw = poles.map(([cs, sn, w]) => {
            const p = add(c.c, add(scale(c.x, ra * cs), scale(c.y, rb * sn)));
            return [p[0] * w, p[1] * w, p[2] * w, w];
        });
        return { degree: 2, knots, cw, rational: true };
    }
    if (c instanceof NurbsCurve) {
        const [a, b] = c.range;
        const f = Math.max(a, s.first);
        const l = Math.min(b, s.last);
        return nurbsSegment(c.nurbs, f, l);
    }
    throw new IgesGeometryError(`a ${c.kind} curve cannot be made a B-spline`);
}

/** The curve with its knots mapped linearly onto [a, b]. */
export function reparam(c: Nurbs, a: number, b: number): Nurbs {
    const k0 = c.knots[0];
    const k1 = c.knots[c.knots.length - 1];
    const f = (b - a) / (k1 - k0);
    return { ...c, knots: c.knots.map((k) => a + (k - k0) * f) };
}

/** The curve run backwards over the same knot range. */
export function reverseNurbs(c: Nurbs): Nurbs {
    const k0 = c.knots[0];
    const k1 = c.knots[c.knots.length - 1];
    return { ...c, knots: c.knots.map((k) => k0 + k1 - k).reverse(), cw: c.cw.slice().reverse() };
}

/** Raises the degree by one: per Bezier piece, then the pieces joined with knots of full multiplicity (exact). */
function elevateOnce(c: Nurbs): Nurbs {
    const p = c.degree;
    const { values } = knotsWithMults(c.knots);
    let cur = c;
    for (const v of values.slice(1, -1)) {
        const m = cur.knots.filter((k) => k === v).length;
        if (m < p) {
            cur = insertKnot(cur, v, p - m);
        }
    }
    // Clamped with every inner knot of multiplicity p: Bezier pieces of p + 1 poles sharing their ends.
    const pieces = values.length - 1;
    const cw: number[][] = [];
    for (let s = 0; s < pieces; s++) {
        const b = cur.cw.slice(s * p, s * p + p + 1);
        const e: number[][] = [];
        for (let i = 0; i <= p + 1; i++) {
            const a = i / (p + 1);
            e.push(b[0].map((_, k) => (i > 0 ? a * b[i - 1][k] : 0) + (i <= p ? (1 - a) * b[i][k] : 0)));
        }
        cw.push(...(s === 0 ? e : e.slice(1)));
    }
    const knots: number[] = [];
    values.forEach((v, i) => {
        const mult = i === 0 || i === values.length - 1 ? p + 2 : p + 1;
        for (let k = 0; k < mult; k++) {
            knots.push(v);
        }
    });
    return { degree: p + 1, knots, cw, rational: c.rational };
}

export function elevate(c: Nurbs, degree: number): Nurbs {
    let cur = c;
    while (cur.degree < degree) {
        cur = elevateOnce(cur);
    }
    return cur;
}

/** Segments joined end to end into one NURBS (degrees raised to the highest), parameter running on. */
export function joinNurbs(parts: Nurbs[]): Nurbs {
    const degree = Math.max(...parts.map((p) => p.degree));
    let out = elevate(parts[0], degree);
    for (const part of parts.slice(1)) {
        out = nurbsJoin(out, elevate(part, degree));
    }
    return out;
}

/** Two curves on [0, 1] with the same degree and knots (for a ruled surface between them). */
export function compatible(a: Nurbs, b: Nurbs): [Nurbs, Nurbs] {
    const degree = Math.max(a.degree, b.degree);
    let ca = elevate(reparam(a, 0, 1), degree);
    let cb = elevate(reparam(b, 0, 1), degree);
    const eps = 1e-12;
    const refine = (c: Nurbs, from: Nurbs): Nurbs => {
        let cur = c;
        const { values, mults } = knotsWithMults(from.knots);
        values.forEach((v, i) => {
            if (i === 0 || i === values.length - 1) {
                return;
            }
            const have = cur.knots.filter((k) => Math.abs(k - v) <= eps).length;
            if (have < mults[i]) {
                cur = insertKnot(cur, v, mults[i] - have);
            }
        });
        return cur;
    };
    ca = refine(ca, cb);
    cb = refine(cb, ca);
    if (ca.knots.length !== cb.knots.length) {
        throw new IgesGeometryError('the curves of a ruled surface could not be matched');
    }
    // Knots that differ by rounding only are made equal.
    return [ca, { ...cb, knots: ca.knots.slice() }];
}
