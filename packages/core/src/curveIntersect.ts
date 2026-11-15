// Where sketch curves meet, for the tools that cut and lengthen them (trim, split, extend). Every curve is taken
// with its own parameter (see CurveGeom), and the meeting points come with the parameter on each curve. Lines,
// circles, ellipses and conics have an implicit equation, so a crossing with any of them is a root of one
// polynomial (exact for two of them: at most a quartic); splines against splines are found by subdividing their
// Bezier pieces and finished with Newton steps. Coordinates are sketch (u, v) in mm.

import { ellipseParam, type EllipseAxes, type P2 } from './curves';

const TAU = 2 * Math.PI;

/** A curve with its own parameter t. */
export type CurveGeom =
    /** Line from a (t = 0) to b (t = 1); `infinite`: the whole line is the curve (the sketch axes). */
    | { kind: 'line'; a: P2; b: P2; infinite?: boolean }
    /** Circle, t its angle from +u; with `from` and `sweep` the counter-clockwise arc from angle `from`. */
    | { kind: 'circle'; c: P2; r: number; from?: number; sweep?: number }
    /** Ellipse, t its parameter angle (0 at the end of the major axis); with `from` and `sweep` a partial ellipse. */
    | { kind: 'ellipse'; e: EllipseAxes; from?: number; sweep?: number }
    /**
     * Conic arc (a parabola too) from p0 to p2, its end tangents meeting at p1, middle weight w. t is the homogeneous
     * angle: the point is (cos² t p0 + 2w cos t sin t p1 + sin² t p2) / (cos² t + 2w cos t sin t + sin² t), so the arc
     * is t from 0 to pi/2 and the rest of the conic lies beyond.
     */
    | { kind: 'conic'; p0: P2; p1: P2; p2: P2; w: number }
    /** Polynomial Bezier pieces end to end (splines and style splines); piece i covers t from t0 to t1. */
    | { kind: 'bezier'; pieces: BezierPiece[]; closed?: boolean };

export interface BezierPiece {
    poles: P2[];
    t0: number;
    t1: number;
}

/** One meeting point of curves a and b, with its parameter on each. */
export interface Crossing {
    at: P2;
    ta: number;
    tb: number;
}

const sub = (p: P2, q: P2): P2 => [p[0] - q[0], p[1] - q[1]];
const dot = (p: P2, q: P2): number => p[0] * q[0] + p[1] * q[1];
const cross = (p: P2, q: P2): number => p[0] * q[1] - p[1] * q[0];
const dist = (p: P2, q: P2): number => Math.hypot(q[0] - p[0], q[1] - p[1]);
const lerp = (p: P2, q: P2, t: number): P2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/** t moved by whole periods into [base, base + period). */
export function wrapParam(t: number, base: number, period: number): number {
    const k = Math.floor((t - base) / period);
    const out = t - k * period;
    return out >= base + period ? out - period : out;
}

// ---- Parameter ranges -------------------------------------------------------------------------------------

/** The curve's own extent [t0, t1]; `period` for curves that close on themselves (circles, ellipses, closed splines). */
export function domainOf(g: CurveGeom): { t0: number; t1: number; period?: number } {
    switch (g.kind) {
        case 'line':
            return g.infinite ? { t0: -Infinity, t1: Infinity } : { t0: 0, t1: 1 };
        case 'circle':
        case 'ellipse':
            return g.from === undefined || g.sweep === undefined ? { t0: 0, t1: TAU, period: TAU } : { t0: g.from, t1: g.from + g.sweep };
        case 'conic':
            return { t0: 0, t1: Math.PI / 2 };
        case 'bezier': {
            const t0 = g.pieces[0]?.t0 ?? 0;
            const t1 = g.pieces[g.pieces.length - 1]?.t1 ?? 0;
            return g.closed ? { t0, t1, period: t1 - t0 } : { t0, t1 };
        }
    }
}

/**
 * The natural path the curve lies on past its ends (what Extend and Corner run along): `period` when it closes
 * round (circles, ellipses, elliptic conics), else the open range lo..hi (a hyperbola runs off to infinity there).
 * Null for splines, which have no natural path past their ends.
 */
export function carrierOf(g: CurveGeom): { lo: number; hi: number; period?: number } | null {
    switch (g.kind) {
        case 'line':
            return { lo: -Infinity, hi: Infinity };
        case 'circle':
        case 'ellipse':
            return { lo: g.from ?? 0, hi: (g.from ?? 0) + TAU, period: TAU };
        case 'conic': {
            if (g.w < 1 - 1e-12) {
                return { lo: -Math.PI / 4, hi: (3 * Math.PI) / 4, period: Math.PI };
            }
            const half = Math.asin(Math.min(1, 1 / g.w)) / 2;
            return { lo: -half, hi: Math.PI / 2 + half };
        }
        case 'bezier':
            return null;
    }
}

// ---- Points and directions --------------------------------------------------------------------------------

function ellipseLocal(e: EllipseAxes, x: number, y: number): P2 {
    const [c, s] = [Math.cos(e.angle), Math.sin(e.angle)];
    return [e.center[0] + x * c - y * s, e.center[1] + x * s + y * c];
}

/** Homogeneous point of a conic at t and its derivative: [x w, y w, w]. */
function conicHom(g: Extract<CurveGeom, { kind: 'conic' }>, t: number): { n: number[]; d: number[] } {
    const [c, s] = [Math.cos(t), Math.sin(t)];
    const h = [[g.p0[0], g.p0[1], 1], [g.w * g.p1[0], g.w * g.p1[1], g.w], [g.p2[0], g.p2[1], 1]];
    const [k0, k1, k2] = [c * c, 2 * c * s, s * s];
    const [d0, d1, d2] = [-2 * c * s, 2 * (c * c - s * s), 2 * c * s];
    return {
        n: [0, 1, 2].map((i) => k0 * h[0][i] + k1 * h[1][i] + k2 * h[2][i]),
        d: [0, 1, 2].map((i) => d0 * h[0][i] + d1 * h[1][i] + d2 * h[2][i]),
    };
}

/** de Casteljau: the point at s of a Bezier curve and its derivative in s. */
export function bezierPoint(poles: P2[], s: number): { p: P2; d: P2 } {
    const n = poles.length - 1;
    if (n < 1) {
        return { p: poles[0] ?? [0, 0], d: [0, 0] };
    }
    let row = poles.map((q) => [q[0], q[1]] as P2);
    for (let r = n; r > 1; r--) {
        row = row.slice(0, r).map((q, i) => lerp(q, row[i + 1], s));
    }
    return { p: lerp(row[0], row[1], s), d: [n * (row[1][0] - row[0][0]), n * (row[1][1] - row[0][1])] };
}

/** The piece of a Bezier geom that holds t, and t's place on it (0 to 1). */
function pieceAt(g: Extract<CurveGeom, { kind: 'bezier' }>, t: number): { piece: BezierPiece; s: number } {
    const d = domainOf(g);
    const tt = d.period ? wrapParam(t, d.t0, d.period) : Math.max(d.t0, Math.min(d.t1, t));
    let piece = g.pieces[g.pieces.length - 1];
    for (const p of g.pieces) {
        if (tt <= p.t1) {
            piece = p;
            break;
        }
    }
    return { piece, s: piece.t1 > piece.t0 ? (tt - piece.t0) / (piece.t1 - piece.t0) : 0 };
}

/** The point of the curve at t (on its natural path when t is past its ends). */
export function pointAt(g: CurveGeom, t: number): P2 {
    return evalAt(g, t).p;
}

/** The derivative of the point in t: the curve's direction at t, the way t grows. */
export function directionAt(g: CurveGeom, t: number): P2 {
    return evalAt(g, t).d;
}

function evalAt(g: CurveGeom, t: number): { p: P2; d: P2 } {
    switch (g.kind) {
        case 'line':
            return { p: lerp(g.a, g.b, t), d: sub(g.b, g.a) };
        case 'circle':
            return { p: [g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)], d: [-g.r * Math.sin(t), g.r * Math.cos(t)] };
        case 'ellipse': {
            const e = g.e;
            const p = ellipseLocal(e, e.a * Math.cos(t), e.b * Math.sin(t));
            const [c, s] = [Math.cos(e.angle), Math.sin(e.angle)];
            const [x, y] = [-e.a * Math.sin(t), e.b * Math.cos(t)];
            return { p, d: [x * c - y * s, x * s + y * c] };
        }
        case 'conic': {
            const { n, d } = conicHom(g, t);
            const w = n[2] || 1e-300;
            return {
                p: [n[0] / w, n[1] / w],
                d: [(d[0] * n[2] - n[0] * d[2]) / (w * w), (d[1] * n[2] - n[1] * d[2]) / (w * w)],
            };
        }
        case 'bezier': {
            const { piece, s } = pieceAt(g, t);
            const r = bezierPoint(piece.poles, s);
            const k = piece.t1 > piece.t0 ? 1 / (piece.t1 - piece.t0) : 0;
            return { p: r.p, d: [r.d[0] * k, r.d[1] * k] };
        }
    }
}

/**
 * The parameter of a point on the curve or on its natural path (exact for lines, circles, ellipses and conics):
 * circles and ellipses give it from `from` (or 0) on round, a conic between its lo and lo + pi (NaN for a point on
 * the other branch of a hyperbola), a spline the nearest point's parameter.
 */
export function paramOf(g: CurveGeom, p: P2): number {
    switch (g.kind) {
        case 'line': {
            const d = sub(g.b, g.a);
            return dot(sub(p, g.a), d) / (dot(d, d) || 1);
        }
        case 'circle':
            return wrapParam(Math.atan2(p[1] - g.c[1], p[0] - g.c[0]), g.from ?? 0, TAU);
        case 'ellipse':
            return wrapParam(ellipseParam(g.e, p), g.from ?? 0, TAU);
        case 'conic': {
            const l = barycentric(g, p);
            if (!l) {
                return NaN;
            }
            const [l0, l1, l2] = l;
            // On the conic l0 = cos² t / D, l1 = 2w cos t sin t / D, l2 = sin² t / D; D < 0 is the other branch.
            if (l0 + l2 < -1e-12) {
                return NaN;
            }
            const u0 = Math.sqrt(Math.max(0, l0));
            const u1 = Math.sqrt(Math.max(0, l2)) * (l1 < 0 ? -1 : 1);
            const t = Math.atan2(u1, u0);
            const c = carrierOf(g)!;
            return c.period ? wrapParam(t, -Math.PI / 4, Math.PI) : t < c.lo ? t + Math.PI : t;
        }
        case 'bezier':
            return closestParam(g, p);
    }
}

/** Barycentric coordinates of p in the conic's control triangle (null when it is flat). */
function barycentric(g: Extract<CurveGeom, { kind: 'conic' }>, p: P2): [number, number, number] | null {
    const [e0, e2] = [sub(g.p0, g.p1), sub(g.p2, g.p1)];
    const det = cross(e0, e2);
    if (Math.abs(det) < 1e-300) {
        return null;
    }
    const q = sub(p, g.p1);
    const s = cross(q, e2) / det;
    const t = cross(e0, q) / det;
    return [s, 1 - s - t, t];
}

/** The parameter of the point of the curve nearest p, within its extent. */
export function closestParam(g: CurveGeom, p: P2): number {
    const d = domainOf(g);
    if (g.kind === 'line') {
        const t = paramOf(g, p);
        return g.infinite ? t : Math.max(0, Math.min(1, t));
    }
    if (g.kind === 'circle' && d.period) {
        return paramOf(g, p);
    }
    // Sampled, then narrowed by golden section around the best sample (a curve's distance is smooth there).
    const per = g.kind === 'bezier' ? 24 * g.pieces.length : 96;
    const span = d.t1 - d.t0;
    const f = (t: number) => {
        const q = pointAt(g, t);
        return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    };
    let best = 0;
    let bestF = Infinity;
    for (let i = 0; i <= per; i++) {
        const v = f(d.t0 + (span * i) / per);
        if (v < bestF) {
            bestF = v;
            best = i;
        }
    }
    let lo = d.t0 + (span * (best - 1)) / per;
    let hi = d.t0 + (span * (best + 1)) / per;
    if (!d.period) {
        lo = Math.max(d.t0, lo);
        hi = Math.min(d.t1, hi);
    }
    const k = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - k * (hi - lo);
    let x2 = lo + k * (hi - lo);
    let f1 = f(x1);
    let f2 = f(x2);
    for (let i = 0; i < 80 && hi - lo > 1e-14 * Math.max(1, Math.abs(hi)); i++) {
        if (f1 < f2) {
            hi = x2;
            x2 = x1;
            f2 = f1;
            x1 = hi - k * (hi - lo);
            f1 = f(x1);
        } else {
            lo = x1;
            x1 = x2;
            f1 = f2;
            x2 = lo + k * (hi - lo);
            f2 = f(x2);
        }
    }
    const t = (lo + hi) / 2;
    return d.period ? wrapParam(t, d.t0, d.period) : t;
}

// ---- Bernstein polynomials ------------------------------------------------------------------------------------

const BINOM: number[][] = [];
function binom(n: number, k: number): number {
    for (let i = BINOM.length; i <= n; i++) {
        BINOM[i] = [1];
        for (let j = 1; j <= i; j++) {
            BINOM[i][j] = (BINOM[i - 1][j - 1] ?? 0) + (BINOM[i - 1][j] ?? 0);
        }
    }
    return BINOM[n][k] ?? 0;
}

/** Product of two polynomials in Bernstein form (degrees m and n give m + n). */
function bmul(a: number[], b: number[]): number[] {
    const [m, n] = [a.length - 1, b.length - 1];
    const out = new Array(m + n + 1).fill(0);
    for (let i = 0; i <= m; i++) {
        for (let j = 0; j <= n; j++) {
            out[i + j] += (binom(m, i) * binom(n, j) * a[i] * b[j]) / binom(m + n, i + j);
        }
    }
    return out;
}

/** a x + b y + c w of Bernstein coefficient rows of one degree. */
function blin(x: number[], y: number[], w: number[], a: number, b: number, c: number): number[] {
    return x.map((xi, i) => a * xi + b * y[i] + c * w[i]);
}

const badd = (...rows: number[][]): number[] => rows[0].map((_, i) => rows.reduce((s, r) => s + r[i], 0));
const bscale = (r: number[], k: number): number[] => r.map((v) => v * k);

function bernsteinAt(c: number[], s: number): number {
    let row = [...c];
    for (let r = row.length - 1; r > 0; r--) {
        for (let i = 0; i < r; i++) {
            row[i] = row[i] + (row[i + 1] - row[i]) * s;
        }
    }
    return row[0];
}

function bsplit(c: number[]): [number[], number[]] {
    const n = c.length - 1;
    const left: number[] = [];
    const right: number[] = [];
    let row = [...c];
    for (let r = 0; r <= n; r++) {
        left.push(row[0]);
        right.unshift(row[row.length - 1]);
        row = row.slice(1).map((v, i) => (row[i] + v) / 2);
    }
    return [left, right];
}

/** Roots in [0, 1] where the polynomial changes sign (subdivision with the convex hull and Descartes' rule, then bisection). */
function signRoots(c: number[]): number[] {
    const out: number[] = [];
    let budget = 6000;
    const walk = (k: number[], lo: number, hi: number) => {
        if (--budget < 0) {
            return;
        }
        let changes = 0;
        let last = 0;
        for (const v of k) {
            const sgn = v > 0 ? 1 : v < 0 ? -1 : 0;
            if (sgn && last && sgn !== last) {
                changes++;
            }
            if (sgn) {
                last = sgn;
            }
        }
        if (k[0] === 0) {
            out.push(lo);
        }
        if (changes === 0) {
            return;
        }
        if (changes === 1 && k[0] !== 0 && k[k.length - 1] !== 0) {
            // Exactly one root inside: bisection to full precision.
            let [a, b] = [0, 1];
            const fa = k[0];
            for (let i = 0; i < 64; i++) {
                const m = (a + b) / 2;
                const fm = bernsteinAt(k, m);
                if (fm === 0) {
                    a = b = m;
                    break;
                }
                if ((fm > 0) === (fa > 0)) {
                    a = m;
                } else {
                    b = m;
                }
            }
            out.push(lo + ((a + b) / 2) * (hi - lo));
            return;
        }
        if (hi - lo < 1e-15) {
            out.push((lo + hi) / 2);
            return;
        }
        const [l, r] = bsplit(k);
        const mid = (lo + hi) / 2;
        walk(l, lo, mid);
        // The middle point itself is counted by the right half (its first coefficient).
        walk(r, mid, hi);
    };
    walk(c, 0, 1);
    if (c[c.length - 1] === 0) {
        out.push(1);
    }
    return out;
}

/**
 * Roots of a Bernstein polynomial in [0, 1]: where it changes sign, and where it touches zero without crossing
 * (a curve that only touches the other one: the roots of its derivative where it is next to zero).
 */
function bernsteinRoots(c: number[]): number[] {
    const scale = Math.max(...c.map(Math.abs));
    if (!(scale > 0) || !Number.isFinite(scale)) {
        // Zero all along: the curves lie on each other there, which is no single point.
        return [];
    }
    const roots = signRoots(c);
    const n = c.length - 1;
    if (n >= 2) {
        const d = c.slice(1).map((v, i) => n * (v - c[i]));
        for (const s of signRoots(d)) {
            if (Math.abs(bernsteinAt(c, s)) <= scale * 1e-9) {
                roots.push(s);
            }
        }
    }
    return roots.sort((a, b) => a - b).filter((s, i, all) => i === 0 || s - all[i - 1] > 1e-12);
}

// ---- Implicit equations and rational pieces ------------------------------------------------------------------

/** A curve piece as rational Bernstein rows (x w, y w, w) over s in 0..1, and the curve's parameter at s. */
interface RationalPiece {
    x: number[];
    y: number[];
    w: number[];
    param: (s: number) => number;
}

/** The implicit equation of a line, circle, ellipse or conic, applied to homogeneous Bernstein rows; null for splines. */
function implicitOf(g: CurveGeom): ((x: number[], y: number[], w: number[]) => number[]) | null {
    switch (g.kind) {
        case 'line': {
            const d = sub(g.b, g.a);
            const l = Math.hypot(d[0], d[1]) || 1;
            const [nx, ny] = [-d[1] / l, d[0] / l];
            return (x, y, w) => blin(x, y, w, nx, ny, -(nx * g.a[0] + ny * g.a[1]));
        }
        case 'circle':
            return (x, y, w) => {
                const u = blin(x, y, w, 1 / g.r, 0, -g.c[0] / g.r);
                const v = blin(x, y, w, 0, 1 / g.r, -g.c[1] / g.r);
                return badd(bmul(u, u), bmul(v, v), bscale(bmul(w, w), -1));
            };
        case 'ellipse': {
            const e = g.e;
            const [c, s] = [Math.cos(e.angle), Math.sin(e.angle)];
            return (x, y, w) => {
                const u = blin(x, y, w, c / e.a, s / e.a, -(c * e.center[0] + s * e.center[1]) / e.a);
                const v = blin(x, y, w, -s / e.b, c / e.b, (s * e.center[0] - c * e.center[1]) / e.b);
                return badd(bmul(u, u), bmul(v, v), bscale(bmul(w, w), -1));
            };
        }
        case 'conic': {
            // In barycentric coordinates of the control triangle the conic is l1² = 4 w² l0 l2.
            const [e0, e2] = [sub(g.p0, g.p1), sub(g.p2, g.p1)];
            const det = cross(e0, e2);
            if (Math.abs(det) < 1e-300) {
                return null;
            }
            // l0 = cross(q, e2) / det, l2 = cross(e0, q) / det with q = p - p1; l1 = 1 - l0 - l2.
            const a0 = [e2[1] / det, -e2[0] / det];
            const a2 = [-e0[1] / det, e0[0] / det];
            const c0 = -(a0[0] * g.p1[0] + a0[1] * g.p1[1]);
            const c2 = -(a2[0] * g.p1[0] + a2[1] * g.p1[1]);
            const k = 4 * g.w * g.w;
            return (x, y, w) => {
                const l0 = blin(x, y, w, a0[0], a0[1], c0);
                const l2 = blin(x, y, w, a2[0], a2[1], c2);
                const l1 = blin(x, y, w, -a0[0] - a2[0], -a0[1] - a2[1], 1 - c0 - c2);
                return badd(bmul(l1, l1), bscale(bmul(l0, l2), -k));
            };
        }
        case 'bezier':
            return null;
    }
}

/** The quarter-or-less rational quadratic pieces of a circle or ellipse arc from angle a0 to a1. */
function ovalPieces(g: Extract<CurveGeom, { kind: 'circle' | 'ellipse' }>, a0: number, a1: number): RationalPiece[] {
    const n = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2) - 1e-9));
    const map = (x: number, y: number): P2 => (g.kind === 'circle' ? [g.c[0] + g.r * x, g.c[1] + g.r * y] : ellipseLocal(g.e, g.e.a * x, g.e.b * y));
    const out: RationalPiece[] = [];
    for (let i = 0; i < n; i++) {
        const [t0, t1] = [a0 + ((a1 - a0) * i) / n, a0 + ((a1 - a0) * (i + 1)) / n];
        const half = (t1 - t0) / 2;
        const w = Math.cos(half);
        const m = (t0 + t1) / 2;
        const p0 = map(Math.cos(t0), Math.sin(t0));
        const p1 = map(Math.cos(m) / w, Math.sin(m) / w);
        const p2 = map(Math.cos(t1), Math.sin(t1));
        out.push({
            x: [p0[0], w * p1[0], p2[0]], y: [p0[1], w * p1[1], p2[1]], w: [1, w, 1],
            // The angle of the point, counted from this piece's start.
            param: (s) => {
                const q = rationalAt({ x: [p0[0], w * p1[0], p2[0]], y: [p0[1], w * p1[1], p2[1]], w: [1, w, 1] }, s);
                return wrapParam(paramOf(g, q), t0 - 1e-9, TAU);
            },
        });
    }
    return out;
}

function rationalAt(r: { x: number[]; y: number[]; w: number[] }, s: number): P2 {
    const w = bernsteinAt(r.w, s);
    return [bernsteinAt(r.x, s) / w, bernsteinAt(r.y, s) / w];
}

/** A conic between parameters a and b (less than pi apart) as one rational quadratic, by blossoming. */
function conicRange(g: Extract<CurveGeom, { kind: 'conic' }>, a: number, b: number): RationalPiece {
    const h = conicBlossom(g, a, b);
    const [ua, ub] = [[Math.cos(a), Math.sin(a)], [Math.cos(b), Math.sin(b)]];
    return {
        x: [h[0][0], h[1][0], h[2][0]], y: [h[0][1], h[1][1], h[2][1]], w: [h[0][2], h[1][2], h[2][2]],
        param: (s) => {
            const t = Math.atan2((1 - s) * ua[1] + s * ub[1], (1 - s) * ua[0] + s * ub[0]);
            return a + wrapParam(t - a, -1e-9, Math.PI);
        },
    };
}

/** Homogeneous control points [x w, y w, w] of the conic between parameters a and b. */
export function conicBlossom(g: Extract<CurveGeom, { kind: 'conic' }>, a: number, b: number): number[][] {
    const h = [[g.p0[0], g.p0[1], 1], [g.w * g.p1[0], g.w * g.p1[1], g.w], [g.p2[0], g.p2[1], 1]];
    const blossom = (x: number[], y: number[]) => [0, 1, 2].map((i) => x[0] * y[0] * h[0][i] + (x[0] * y[1] + x[1] * y[0]) * h[1][i] + x[1] * y[1] * h[2][i]);
    const [ua, ub] = [[Math.cos(a), Math.sin(a)], [Math.cos(b), Math.sin(b)]];
    return [blossom(ua, ua), blossom(ua, ub), blossom(ub, ub)];
}

/** The curve (or its natural path) as rational pieces; null where that is endless (a line, a hyperbola's path). */
function piecesOf(g: CurveGeom, carrier: boolean): RationalPiece[] | null {
    switch (g.kind) {
        case 'line':
            if (g.infinite || carrier) {
                return null;
            }
            return [{ x: [g.a[0], g.b[0]], y: [g.a[1], g.b[1]], w: [1, 1], param: (s) => s }];
        case 'circle':
        case 'ellipse': {
            const d = domainOf(g);
            const [a0, a1] = carrier || d.period ? [g.from ?? 0, (g.from ?? 0) + TAU] : [d.t0, d.t1];
            return ovalPieces(g, a0, a1);
        }
        case 'conic': {
            if (!carrier) {
                return [conicRange(g, 0, Math.PI / 2)];
            }
            const c = carrierOf(g)!;
            const [lo, hi] = c.period ? [-Math.PI / 4, (3 * Math.PI) / 4] : [c.lo + 1e-4, c.hi - 1e-4];
            const n = Math.max(1, Math.ceil((hi - lo) / (Math.PI / 4)));
            return Array.from({ length: n }, (_, i) => conicRange(g, lo + ((hi - lo) * i) / n, lo + ((hi - lo) * (i + 1)) / n));
        }
        case 'bezier':
            return g.pieces.map((p) => ({
                x: p.poles.map((q) => q[0]), y: p.poles.map((q) => q[1]), w: p.poles.map(() => 1),
                param: (s) => p.t0 + s * (p.t1 - p.t0),
            }));
    }
}

function boxOf(pts: P2[]): [number, number, number, number] {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of pts) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
    }
    return [x0, y0, x1, y1];
}

const overlap = (a: number[], b: number[], pad: number) => a[0] <= b[2] + pad && b[0] <= a[2] + pad && a[1] <= b[3] + pad && b[1] <= a[3] + pad;

/** Control points of a rational piece (its convex hull holds the piece while the weights are positive). */
function piecePoints(r: RationalPiece): P2[] | null {
    if (r.w.some((w) => !(w > 0))) {
        return null;
    }
    return r.w.map((w, i) => [r.x[i] / w, r.y[i] / w] as P2);
}

// ---- Crossings ---------------------------------------------------------------------------------------------

/** Whether t lies on the curve's extent (or on its natural path), with a little slack at the ends. */
function onRange(g: CurveGeom, t: number, carrier: boolean): boolean {
    if (!Number.isFinite(t)) {
        return false;
    }
    const eps = 1e-9;
    if (carrier) {
        const c = carrierOf(g);
        if (c) {
            return c.period ? true : t > c.lo && t < c.hi;
        }
    }
    const d = domainOf(g);
    if (d.period) {
        return true;
    }
    if (g.kind === 'circle' || g.kind === 'ellipse') {
        const w = wrapParam(t, d.t0 - eps, TAU);
        return w <= d.t1 + eps;
    }
    return t >= d.t0 - eps && t <= d.t1 + eps;
}

/** The parameter as the curve reports it: wrapped round from its start on closed and periodic paths. */
function normal(g: CurveGeom, t: number, carrier: boolean): number {
    const d = domainOf(g);
    if (d.period) {
        return wrapParam(t, d.t0, d.period);
    }
    if (g.kind === 'circle' || g.kind === 'ellipse') {
        // An arc: from its start round; just before the start counts as the start.
        const w = wrapParam(t, d.t0 - 1e-9, TAU);
        return carrier ? wrapParam(t, d.t0, TAU) : w;
    }
    if (g.kind === 'conic' && carrier) {
        const c = carrierOf(g)!;
        return c.period ? wrapParam(t, -Math.PI / 4, Math.PI) : t;
    }
    return t;
}

/** Newton steps on a(ta) = b(tb); the pair as it ends (unchanged where the curves are tangent there). */
function refine(a: CurveGeom, ta: number, b: CurveGeom, tb: number): { ta: number; tb: number; gap: number } {
    let best = { ta, tb, gap: dist(pointAt(a, ta), pointAt(b, tb)) };
    let [x, y] = [ta, tb];
    for (let i = 0; i < 12 && best.gap > 1e-13; i++) {
        const ea = evalAt(a, x);
        const eb = evalAt(b, y);
        const f = sub(ea.p, eb.p);
        const det = -ea.d[0] * eb.d[1] + ea.d[1] * eb.d[0];
        if (Math.abs(det) < 1e-14 * (Math.hypot(...ea.d) * Math.hypot(...eb.d) || 1)) {
            break;
        }
        // [da, -db] [dx, dy]^T = -f
        const dx = (-f[0] * -eb.d[1] - -eb.d[0] * -f[1]) / det;
        const dy = (ea.d[0] * -f[1] - ea.d[1] * -f[0]) / det;
        x += dx;
        y += dy;
        const gap = dist(pointAt(a, x), pointAt(b, y));
        if (!(gap < best.gap)) {
            break;
        }
        best = { ta: x, tb: y, gap };
    }
    return best;
}

/** Candidates from putting curve a's pieces into b's equation: points with a's parameter. */
function substituted(a: CurveGeom, b: CurveGeom, carrierA: boolean): { at: P2; ta: number }[] {
    const f = implicitOf(b);
    const pieces = piecesOf(a, carrierA);
    if (!f || !pieces) {
        return [];
    }
    const out: { at: P2; ta: number }[] = [];
    const bBox = boundsOf(b);
    for (const piece of pieces) {
        const pts = piecePoints(piece);
        if (pts && bBox && !overlap(boxOf(pts), bBox, 1e-6)) {
            continue;
        }
        for (const s of bernsteinRoots(f(piece.x, piece.y, piece.w))) {
            out.push({ at: rationalAt(piece, s), ta: piece.param(s) });
        }
    }
    return out;
}

/** A box round the curve's extent [u0, v0, u1, v1], or null for an endless line. */
export function boundsOf(g: CurveGeom): number[] | null {
    if (g.kind === 'line') {
        return g.infinite ? null : boxOf([g.a, g.b]);
    }
    if (g.kind === 'circle') {
        return [g.c[0] - g.r, g.c[1] - g.r, g.c[0] + g.r, g.c[1] + g.r];
    }
    if (g.kind === 'ellipse') {
        return [g.e.center[0] - g.e.a, g.e.center[1] - g.e.a, g.e.center[0] + g.e.a, g.e.center[1] + g.e.a];
    }
    if (g.kind === 'conic') {
        return boxOf([g.p0, g.p1, g.p2]);
    }
    return boxOf(g.pieces.flatMap((p) => p.poles));
}

/** A line (its extent, or the whole line) against a curve with an equation: a quadratic (or linear) in the line's t. */
function lineWith(line: Extract<CurveGeom, { kind: 'line' }>, b: CurveGeom, whole: boolean): { at: P2; ta: number }[] {
    const f = implicitOf(b)!;
    // The line from t = 0 to t = 1 in Bernstein form, turned into power form c0 + c1 t + c2 t².
    const k = f([line.a[0], line.b[0]], [line.a[1], line.b[1]], [1, 1]);
    const [c0, c1, c2] = k.length === 2 ? [k[0], k[1] - k[0], 0] : [k[0], 2 * (k[1] - k[0]), k[0] - 2 * k[1] + k[2]];
    const scale = Math.max(Math.abs(c0), Math.abs(c1), Math.abs(c2));
    if (!(scale > 0)) {
        return [];
    }
    let ts: number[] = [];
    if (Math.abs(c2) <= scale * 1e-14) {
        if (Math.abs(c1) > scale * 1e-14) {
            ts = [-c0 / c1];
        }
    } else {
        const disc = c1 * c1 - 4 * c2 * c0;
        const tiny = 1e-12 * Math.max(c1 * c1, Math.abs(4 * c2 * c0));
        if (disc < -tiny) {
            ts = [];
        } else if (disc <= tiny) {
            ts = [-c1 / (2 * c2)];
        } else {
            // The numerically stable pair of roots.
            const q = -(c1 + Math.sign(c1 || 1) * Math.sqrt(disc)) / 2;
            ts = [q / c2, c0 / q].filter(Number.isFinite);
        }
    }
    return ts.filter((t) => whole || (t >= -1e-9 && t <= 1 + 1e-9)).map((t) => ({ at: lerp(line.a, line.b, t), ta: t }));
}

/** Two lines (each its extent or the whole line): the one crossing, unless they are parallel. */
function lineLine(a: Extract<CurveGeom, { kind: 'line' }>, b: Extract<CurveGeom, { kind: 'line' }>, wholeA: boolean, wholeB: boolean): Crossing[] {
    const r = sub(a.b, a.a);
    const s = sub(b.b, b.a);
    const den = cross(r, s);
    if (Math.abs(den) < 1e-12 * (Math.hypot(r[0], r[1]) * Math.hypot(s[0], s[1]) || 1)) {
        return [];
    }
    const q = sub(b.a, a.a);
    const ta = cross(q, s) / den;
    const tb = cross(q, r) / den;
    const eps = 1e-9;
    if ((!wholeA && (ta < -eps || ta > 1 + eps)) || (!wholeB && (tb < -eps || tb > 1 + eps))) {
        return [];
    }
    return [{ at: [a.a[0] + r[0] * ta, a.a[1] + r[1] * ta], ta, tb }];
}

/** Two splines: their Bezier pieces subdivided until flat, the chords crossed, then Newton on the curves. */
function bezierPairs(a: Extract<CurveGeom, { kind: 'bezier' }>, b: Extract<CurveGeom, { kind: 'bezier' }>): { ta: number; tb: number }[] {
    const out: { ta: number; tb: number }[] = [];
    let budget = 20000;
    const size = (p: P2[]) => {
        const bx = boxOf(p);
        return Math.hypot(bx[2] - bx[0], bx[3] - bx[1]);
    };
    const flat = (p: P2[]) => {
        const [s, e] = [p[0], p[p.length - 1]];
        const l = dist(s, e);
        return p.every((q) => (l > 1e-12 ? Math.abs(cross(sub(e, s), sub(q, s))) / l : dist(q, s)) < 1e-7);
    };
    const halves = (p: P2[]): [P2[], P2[]] => {
        const left: P2[] = [];
        const right: P2[] = [];
        let row = p;
        while (row.length) {
            left.push(row[0]);
            right.unshift(row[row.length - 1]);
            row = row.slice(1).map((q, i) => lerp(row[i], q, 0.5));
        }
        return [left, right];
    };
    const walk = (p: P2[], p0: number, p1: number, q: P2[], q0: number, q1: number, depth: number) => {
        if (--budget < 0 || !overlap(boxOf(p), boxOf(q), 1e-9)) {
            return;
        }
        if ((flat(p) && flat(q)) || depth > 48) {
            const [r, s] = [sub(p[p.length - 1], p[0]), sub(q[q.length - 1], q[0])];
            const den = cross(r, s);
            if (Math.abs(den) < 1e-18) {
                return;
            }
            const d = sub(q[0], p[0]);
            const u = cross(d, s) / den;
            const v = cross(d, r) / den;
            if (u >= -1e-6 && u <= 1 + 1e-6 && v >= -1e-6 && v <= 1 + 1e-6) {
                out.push({ ta: p0 + u * (p1 - p0), tb: q0 + v * (q1 - q0) });
            }
            return;
        }
        if (size(p) >= size(q)) {
            const [l, r] = halves(p);
            const m = (p0 + p1) / 2;
            walk(l, p0, m, q, q0, q1, depth + 1);
            walk(r, m, p1, q, q0, q1, depth + 1);
        } else {
            const [l, r] = halves(q);
            const m = (q0 + q1) / 2;
            walk(p, p0, p1, l, q0, m, depth + 1);
            walk(p, p0, p1, r, m, q1, depth + 1);
        }
    };
    for (const pa of a.pieces) {
        for (const pb of b.pieces) {
            walk(pa.poles, pa.t0, pa.t1, pb.poles, pb.t0, pb.t1, 0);
        }
    }
    return out;
}

/**
 * Where curves a and b meet, each point with its parameter on a and on b, in order along a. `carrierA` /
 * `carrierB`: that curve counts with its natural path past its ends (a line endless, an arc its whole circle).
 * Curves that lie on each other give no points there.
 */
export function crossings(a: CurveGeom, b: CurveGeom, o: { carrierA?: boolean; carrierB?: boolean } = {}): Crossing[] {
    const ca = !!o.carrierA;
    const cb = !!o.carrierB;
    if (a.kind === 'line' && b.kind === 'line') {
        return lineLine(a, b, ca || !!a.infinite, cb || !!b.infinite);
    }
    const [boxA, boxB] = [ca ? null : boundsOf(a), cb ? null : boundsOf(b)];
    if (boxA && boxB && !overlap(boxA, boxB, 1e-6)) {
        return [];
    }
    let found: { at: P2; ta?: number; tb?: number }[] = [];
    if (a.kind === 'line' && b.kind !== 'bezier' && implicitOf(b)) {
        found = lineWith(a, b, ca || !!a.infinite).map((h) => ({ at: h.at, ta: h.ta }));
    } else if (b.kind === 'line' && a.kind !== 'bezier' && implicitOf(a)) {
        found = lineWith(b, a, cb || !!b.infinite).map((h) => ({ at: h.at, tb: h.ta }));
    } else if (a.kind === 'bezier' && b.kind === 'bezier') {
        found = bezierPairs(a, b).map((h) => ({ at: pointAt(a, h.ta), ta: h.ta, tb: h.tb }));
    } else if (implicitOf(b) && piecesOf(a, ca)) {
        found = substituted(a, b, ca);
    } else if (implicitOf(a) && piecesOf(b, cb)) {
        found = substituted(b, a, cb).map((h) => ({ at: h.at, tb: h.ta }));
    }
    const out: Crossing[] = [];
    for (const h of found) {
        let ta = h.ta ?? paramOf(a, h.at);
        let tb = h.tb ?? paramOf(b, h.at);
        if (!Number.isFinite(ta) || !Number.isFinite(tb)) {
            continue;
        }
        const r = refine(a, ta, b, tb);
        if (r.gap > 1e-6) {
            continue;
        }
        ta = normal(a, r.ta, ca);
        tb = normal(b, r.tb, cb);
        if (!onRange(a, ta, ca || (a.kind === 'line' && !!a.infinite)) || !onRange(b, tb, cb || (b.kind === 'line' && !!b.infinite))) {
            continue;
        }
        const at = pointAt(a, ta);
        if (!out.some((k) => dist(k.at, at) < 1e-7)) {
            out.push({ at, ta, tb });
        }
    }
    return out.sort((x, y) => x.ta - y.ta);
}
