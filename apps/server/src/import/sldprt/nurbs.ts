// Vectors and NURBS for the SLDPRT reader: evaluation with first derivatives, knot insertion, and exact
// extraction of a parameter range (clamped, non-periodic), which is the form the B-rep text format takes.

export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const unit = (a: V3): V3 => {
    const n = norm(a);
    return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
};
export const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** a + b * s */
export const addScaled = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Any unit vector perpendicular to a unit vector. */
export function perpendicular(n: V3): V3 {
    const a: V3 = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : Math.abs(n[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
    return unit(cross(n, a));
}

/**
 * A NURBS curve in homogeneous form: `cw` holds (x w, y w, z w, w) per pole (z = 0 for 2D curves), knots
 * expanded (length poles + degree + 1). The valid range is [knots[degree], knots[poles]].
 */
export interface Nurbs {
    degree: number;
    knots: number[];
    cw: number[][];
    rational: boolean;
}

export function nurbsRange(c: Nurbs): [number, number] {
    return [c.knots[c.degree], c.knots[c.cw.length]];
}

function findSpan(knots: number[], degree: number, n: number, t: number): number {
    // n: number of poles; valid spans degree .. n - 1.
    if (t >= knots[n]) {
        let s = n - 1;
        while (s > degree && knots[s] >= knots[n]) {
            s--;
        }
        return s;
    }
    if (t <= knots[degree]) {
        let s = degree;
        while (s < n - 1 && knots[s + 1] <= knots[degree]) {
            s++;
        }
        return s;
    }
    let lo = degree;
    let hi = n;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (t < knots[mid]) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return lo;
}

const MAX_ORDER = 32;
// Scratch for basis(): evaluation is hot (projections run Newton on it), so nothing is allocated per call.
const ndu = new Float64Array(MAX_ORDER * MAX_ORDER);
const left = new Float64Array(MAX_ORDER);
const right = new Float64Array(MAX_ORDER);

/**
 * Basis functions and first derivatives at t in span s (Piegl and Tiller A2.3, first order), written into
 * n0 and n1 (length >= degree + 1).
 */
function basis(knots: number[], p: number, s: number, t: number, n0: Float64Array, n1: Float64Array): void {
    if (p + 1 > MAX_ORDER) {
        throw new Error(`B-spline degree ${p} is too high`);
    }
    const W = MAX_ORDER;
    ndu[0] = 1;
    for (let j = 1; j <= p; j++) {
        left[j] = t - knots[s + 1 - j];
        right[j] = knots[s + j] - t;
        let saved = 0;
        for (let r = 0; r < j; r++) {
            const den = right[r + 1] + left[j - r];
            ndu[j * W + r] = den;
            const temp = den !== 0 ? ndu[r * W + j - 1] / den : 0;
            ndu[r * W + j] = saved + right[r + 1] * temp;
            saved = left[j - r] * temp;
        }
        ndu[j * W + j] = saved;
    }
    for (let j = 0; j <= p; j++) {
        n0[j] = ndu[j * W + p];
    }
    if (p === 0) {
        n1[0] = 0;
        return;
    }
    for (let r = 0; r <= p; r++) {
        let d = 0;
        if (r >= 1) {
            const den = ndu[p * W + r - 1];
            d += den !== 0 ? ndu[(r - 1) * W + p - 1] / den : 0;
        }
        if (r <= p - 1) {
            const den = ndu[p * W + r];
            d -= den !== 0 ? ndu[r * W + p - 1] / den : 0;
        }
        n1[r] = p * d;
    }
}

const bu0 = new Float64Array(MAX_ORDER);
const bu1 = new Float64Array(MAX_ORDER);
const bv0 = new Float64Array(MAX_ORDER);
const bv1 = new Float64Array(MAX_ORDER);

/** Point and first derivative of a NURBS curve. */
export function nurbsEval(c: Nurbs, t: number): { p: V3; d: V3 } {
    const n = c.cw.length;
    const s = findSpan(c.knots, c.degree, n, t);
    basis(c.knots, c.degree, s, t, bu0, bu1);
    const n0 = bu0;
    const n1 = bu1;
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0;
    for (let j = 0; j <= c.degree; j++) {
        const pw = c.cw[s - c.degree + j];
        const b = n0[j];
        const db = n1[j];
        a0 += b * pw[0];
        a1 += b * pw[1];
        a2 += b * pw[2];
        a3 += b * pw[3];
        d0 += db * pw[0];
        d1 += db * pw[1];
        d2 += db * pw[2];
        d3 += db * pw[3];
    }
    const a = [a0, a1, a2, a3];
    const ad = [d0, d1, d2, d3];
    const w = a[3];
    const p: V3 = [a[0] / w, a[1] / w, a[2] / w];
    const d: V3 = [(ad[0] - ad[3] * p[0]) / w, (ad[1] - ad[3] * p[1]) / w, (ad[2] - ad[3] * p[2]) / w];
    return { p, d };
}

/** Inserts knot t `times` times (Boehm), in homogeneous form. */
export function insertKnot(c: Nurbs, t: number, times: number): Nurbs {
    let cur = c;
    for (let r = 0; r < times; r++) {
        const p = cur.degree;
        const n = cur.cw.length;
        const k = findSpan(cur.knots, p, n, t);
        const knots = [...cur.knots.slice(0, k + 1), t, ...cur.knots.slice(k + 1)];
        const cw: number[][] = [];
        for (let i = 0; i <= n; i++) {
            if (i <= k - p) {
                cw.push(cur.cw[i]);
            } else if (i > k) {
                cw.push(cur.cw[i - 1]);
            } else {
                const den = cur.knots[i + p] - cur.knots[i];
                const a = den !== 0 ? (t - cur.knots[i]) / den : 0;
                cw.push(cur.cw[i].map((v, j) => a * v + (1 - a) * cur.cw[i - 1][j]));
            }
        }
        cur = { degree: p, knots, cw, rational: cur.rational };
    }
    return cur;
}

const multiplicity = (knots: number[], t: number, eps: number): number => knots.filter((k) => Math.abs(k - t) <= eps).length;

/** The exact piece of a curve over [a, b] inside its valid range, clamped at both ends. */
export function nurbsSegment(c: Nurbs, a: number, b: number): Nurbs {
    const eps = 1e-12 * Math.max(1, Math.abs(c.knots[c.knots.length - 1] - c.knots[0]));
    const p = c.degree;
    let cur = c;
    for (const t of [a, b]) {
        const m = multiplicity(cur.knots, t, eps);
        if (m < p + 1) {
            cur = insertKnot(cur, t, p + 1 - m);
        }
    }
    // Snap knots equal to a or b within eps.
    const knots = cur.knots.map((k) => (Math.abs(k - a) <= eps ? a : Math.abs(k - b) <= eps ? b : k));
    const first = knots.findIndex((k) => k >= a);
    let last = knots.length - 1;
    while (knots[last] > b) {
        last--;
    }
    // first..first+p are a; last-p..last are b.
    const kn = knots.slice(first, last + 1);
    const cw = cur.cw.slice(first, last - p);
    return { degree: p, knots: kn, cw, rational: c.rational };
}

/** Joins b onto the end of a (b's knots shifted to continue a's), matching the joint weight. */
export function nurbsJoin(a: Nurbs, b: Nurbs): Nurbs {
    const p = a.degree;
    const endA = a.knots[a.knots.length - 1];
    const shift = endA - b.knots[0];
    const wa = a.cw[a.cw.length - 1][3];
    const wb = b.cw[0][3];
    const k = wa / wb;
    const cw = [...a.cw, ...b.cw.slice(1).map((pw) => pw.map((v) => v * k))];
    const knots = [...a.knots.slice(0, a.knots.length - 1), ...b.knots.slice(p + 1).map((t) => t + shift)];
    return { degree: p, knots, cw, rational: a.rational || b.rational || Math.abs(k - 1) > 1e-14 };
}

/** Distinct knots with multiplicities. */
export function knotsWithMults(knots: number[]): { values: number[]; mults: number[] } {
    const values: number[] = [];
    const mults: number[] = [];
    for (const k of knots) {
        if (values.length > 0 && k === values[values.length - 1]) {
            mults[mults.length - 1]++;
        } else {
            values.push(k);
            mults.push(1);
        }
    }
    return { values, mults };
}

/** Expanded knot vector from distinct knots and multiplicities. */
export function expandKnots(values: number[], mults: number[]): number[] {
    const out: number[] = [];
    values.forEach((v, i) => {
        for (let k = 0; k < mults[i]; k++) {
            out.push(v);
        }
    });
    return out;
}

// ---- Surfaces ------------------------------------------------------------------------------------------------

/** A NURBS surface, homogeneous poles cw[i][j] (i along u, j along v). */
export interface NurbsSurf {
    uDegree: number;
    vDegree: number;
    uKnots: number[];
    vKnots: number[];
    cw: number[][][];
    rational: boolean;
}

export function surfRange(s: NurbsSurf): [number, number, number, number] {
    return [s.uKnots[s.uDegree], s.uKnots[s.cw.length], s.vKnots[s.vDegree], s.vKnots[s.cw[0].length]];
}

/** Point and first partial derivatives of a NURBS surface. */
export function surfEval(s: NurbsSurf, u: number, v: number): { p: V3; du: V3; dv: V3 } {
    const nu = s.cw.length;
    const nv = s.cw[0].length;
    const su = findSpan(s.uKnots, s.uDegree, nu, u);
    const sv = findSpan(s.vKnots, s.vDegree, nv, v);
    basis(s.uKnots, s.uDegree, su, u, bu0, bu1);
    basis(s.vKnots, s.vDegree, sv, v, bv0, bv1);
    const a = [0, 0, 0, 0];
    const au = [0, 0, 0, 0];
    const av = [0, 0, 0, 0];
    for (let i = 0; i <= s.uDegree; i++) {
        const row = s.cw[su - s.uDegree + i];
        const bi = bu0[i];
        const bdi = bu1[i];
        for (let j = 0; j <= s.vDegree; j++) {
            const pw = row[sv - s.vDegree + j];
            const n = bi * bv0[j];
            const nU = bdi * bv0[j];
            const nV = bi * bv1[j];
            for (let k = 0; k < 4; k++) {
                a[k] += n * pw[k];
                au[k] += nU * pw[k];
                av[k] += nV * pw[k];
            }
        }
    }
    const w = a[3];
    const p: V3 = [a[0] / w, a[1] / w, a[2] / w];
    const du: V3 = [(au[0] - au[3] * p[0]) / w, (au[1] - au[3] * p[1]) / w, (au[2] - au[3] * p[2]) / w];
    const dv: V3 = [(av[0] - av[3] * p[0]) / w, (av[1] - av[3] * p[1]) / w, (av[2] - av[3] * p[2]) / w];
    return { p, du, dv };
}

/** The surface clamped to its valid range in both directions (exact). */
export function surfClamp(s: NurbsSurf): NurbsSurf {
    const [u0, u1, v0, v1] = surfRange(s);
    // Clamp along u: treat each column (fixed j) as a curve in u.
    const nv = s.cw[0].length;
    const cols: Nurbs[] = [];
    for (let j = 0; j < nv; j++) {
        cols.push(nurbsSegment({ degree: s.uDegree, knots: s.uKnots, cw: s.cw.map((row) => row[j]), rational: s.rational }, u0, u1));
    }
    const nu = cols[0].cw.length;
    const rows: Nurbs[] = [];
    for (let i = 0; i < nu; i++) {
        rows.push(nurbsSegment({ degree: s.vDegree, knots: s.vKnots, cw: cols.map((c) => c.cw[i]), rational: s.rational }, v0, v1));
    }
    return {
        uDegree: s.uDegree, vDegree: s.vDegree, uKnots: cols[0].knots, vKnots: rows[0].knots,
        cw: rows.map((r) => r.cw), rational: s.rational,
    };
}
