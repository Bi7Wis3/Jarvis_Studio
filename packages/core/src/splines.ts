// Splines beyond plain interpolation, shared by the sketcher and the CAD kernel so both build the same curve:
// - the spline through points with tangency handles at any point (direction and the weight of each side),
//   curvature held at points, curvature kept continuous across handles, and a stored parameterisation;
// - B-spline and rational (weighted) curves of control vertices with any clamped knots;
// - curvature: the comb, inflection points and the smallest radius of any curve given as rational Bezier pieces;
// - conversion between a spline through points and the B-spline of control vertices that is the same curve.
// Coordinates are sketch (u, v) in mm.

export type P2 = [number, number];

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const len = (a: P2) => Math.hypot(a[0], a[1]);
const dist = (a: P2, b: P2) => len(sub(a, b));
/** The unit vector a quarter turn left of a (zero for a zero vector). */
function leftNormal(a: P2): P2 {
    const l = len(a);
    return l > 0 ? [-a[1] / l, a[0] / l] : [0, 0];
}

// ---- The spline through points ------------------------------------------------------------------------------

/** Spline options: tangency handles at the ends, and per piece its parameter length as a multiple of its chord. */
export interface SplineOptions {
    /** Open splines: the control point after the start, and the one before the end. */
    start?: P2;
    end?: P2;
    /** Per piece, its parameter length as a multiple of its chord (absent: 1). */
    spacing?: number[];
}

/**
 * What shapes a spline through points besides the points. Each handle is given by the Bezier control points next to
 * its point, so it sets the direction there and how strongly the curve keeps it on each side (the weight).
 */
export interface SplineShape extends SplineOptions {
    /** Handles at other points (index into the points; any point of a closed spline): the control points before and after it. */
    inner?: { at: number; prev: P2; next: P2 }[];
    /** Curvature held at points that have a handle: signed, 1/mm, positive where the spline turns left as it runs. */
    curvature?: { at: number; value: number }[];
    /** Curvature continuous across the inner handles too (Maintain internal continuity). */
    continuity?: boolean;
}

export interface SplineSolution {
    /** Cubic Bezier pieces in a row: [p0, c, c, p1, c, c, p2, ...]. */
    poles: P2[];
    /** Parameter span of each piece. */
    spans: number[];
    /** Points where a held curvature or the continuity has no free spline point to come from (it does not hold there). */
    unmet: number[];
}

/** Parameter length of each piece of a spline through `pts` (closed: one more, back to the first). */
export function splineSpans(pts: P2[], closed: boolean, spacing?: number[]): number[] {
    const n = pts.length;
    const count = closed ? n : n - 1;
    const scale = spacing && spacing.length === count && spacing.every((f) => f > 0 && Number.isFinite(f)) ? spacing : null;
    return Array.from({ length: count }, (_, i) => Math.max(dist(pts[i], pts[(i + 1) % n]) * (scale ? scale[i] : 1), 1e-9));
}

/** The spacing (span over chord, per piece) that gives a spline through `pts` these spans; absent when all are 1. */
export function spacingFor(pts: P2[], closed: boolean, spans: number[]): number[] | undefined {
    const n = pts.length;
    const spacing = spans.map((h, i) => {
        const chord = dist(pts[i], pts[(i + 1) % n]);
        return chord > 1e-12 ? h / chord : 1;
    });
    return spacing.length === (closed ? n : n - 1) && spacing.some((f) => Math.abs(f - 1) > 1e-12) ? spacing : undefined;
}

/** Gauss elimination with partial pivoting; several right-hand sides as columns. */
export function solveLinear(m: number[][], rhs: number[][]): number[][] {
    const n = m.length;
    const a = m.map((row) => [...row]);
    const b = rhs.map((row) => [...row]);
    for (let k = 0; k < n; k++) {
        let p = k;
        for (let i = k + 1; i < n; i++) {
            if (Math.abs(a[i][k]) > Math.abs(a[p][k])) {
                p = i;
            }
        }
        [a[k], a[p]] = [a[p], a[k]];
        [b[k], b[p]] = [b[p], b[k]];
        const pivot = a[k][k] || 1e-300;
        for (let i = k + 1; i < n; i++) {
            const f = a[i][k] / pivot;
            if (f === 0) {
                continue;
            }
            for (let j = k; j < n; j++) {
                a[i][j] -= f * a[k][j];
            }
            for (let j = 0; j < b[i].length; j++) {
                b[i][j] -= f * b[k][j];
            }
        }
    }
    const x = b.map((row) => row.map(() => 0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = 0; j < b[i].length; j++) {
            let s = b[i][j];
            for (let k = i + 1; k < n; k++) {
                s -= a[i][k] * x[k][j];
            }
            x[i][j] = s / (a[i][i] || 1e-300);
        }
    }
    return x;
}

/**
 * Solves a tridiagonal system (closed: with the two corner entries of a periodic one, by Sherman-Morrison), read
 * from the full matrix; one right-hand side per column. The spline systems are diagonally dominant: no pivoting.
 */
export function solveBand(m: number[][], rhs: number[][], cyclic: boolean): number[][] {
    const n = m.length;
    const lo = Array.from({ length: n }, (_, i) => (i > 0 ? m[i][i - 1] : 0));
    const di = Array.from({ length: n }, (_, i) => m[i][i]);
    const up = Array.from({ length: n }, (_, i) => (i < n - 1 ? m[i][i + 1] : 0));
    return solveTridiagonal(lo, di, up, m[n - 1][0], m[0][n - 1], rhs, cyclic);
}

/** The same, from the band itself: below, on and above the diagonal, and the corners (bottom left, top right). */
export function solveTridiagonal(lo: number[], di: number[], up: number[], alpha: number, beta: number, rhs: number[][], cyclic: boolean): number[][] {
    const n = di.length;
    const thomas = (d: number[], b: number[][]): number[][] => {
        const c = new Array(n).fill(0);
        const x = b.map((row) => [...row]);
        let piv = d[0] || 1e-300;
        c[0] = up[0] / piv;
        x[0] = x[0].map((v) => v / piv);
        for (let i = 1; i < n; i++) {
            piv = d[i] - lo[i] * c[i - 1] || 1e-300;
            c[i] = up[i] / piv;
            x[i] = x[i].map((v, j) => (v - lo[i] * x[i - 1][j]) / piv);
        }
        for (let i = n - 2; i >= 0; i--) {
            x[i] = x[i].map((v, j) => v - c[i] * x[i + 1][j]);
        }
        return x;
    };
    if (!cyclic) {
        return thomas(di, rhs);
    }
    const gamma = -di[0];
    const d = [...di];
    d[0] -= gamma;
    d[n - 1] -= (alpha * beta) / gamma;
    const y = thomas(d, rhs);
    const u = Array.from({ length: n }, (_, i) => [i === 0 ? gamma : i === n - 1 ? alpha : 0]);
    const z = thomas(d, u).map((row) => row[0]);
    const vz = z[0] + (beta / gamma) * z[n - 1];
    return y.map((row, i) => row.map((v, j) => v - ((y[0][j] + (beta / gamma) * y[n - 1][j]) / (1 + vz)) * z[i]));
}

/** A vector expression in the unknown derivatives: sum of coef * D[point] plus a constant. */
interface VecExpr {
    terms: [number, number][];
    c: P2;
}

/**
 * The cubic spline through `points` (closed: periodic, the last point may repeat the first) with the handles,
 * curvatures and spans of `shape`. Between handles it is curvature continuous (C2 in its parameter); at a handle
 * the direction and the two weights are as given, and the curvature too where one is held. A held curvature (or
 * the continuity across a handle) needs a free spline point on that side; the free points then stay curvature
 * continuous but give way a little along the curve (least squares), the same to the eye; without one it is unmet.
 */
export function solveSpline(points: P2[], closed = false, shape: SplineShape = {}): SplineSolution {
    // Held curvatures and continuity take an iterated solve: the same spline asked for again (as the cut and offset
    // tools do, many times) comes from a small cache.
    const costly = !!shape.curvature?.length || (!!shape.continuity && !!shape.inner?.length);
    const key = costly ? JSON.stringify([points, closed, shape]) : '';
    const cached = costly ? solved.get(key) : undefined;
    if (cached) {
        return { poles: cached.poles.map((q) => [q[0], q[1]] as P2), spans: [...cached.spans], unmet: [...cached.unmet] };
    }
    const result = solveSplineNow(points, closed, shape);
    if (costly) {
        if (solved.size >= 64) {
            solved.delete(solved.keys().next().value!);
        }
        solved.set(key, result);
    }
    return result;
}

const solved = new Map<string, SplineSolution>();

function solveSplineNow(points: P2[], closed: boolean, shape: SplineShape): SplineSolution {
    const pts = closed && points.length > 1 && dist(points[0], points[points.length - 1]) < 1e-12 ? points.slice(0, -1) : points;
    const n = pts.length;
    if (n < 2) {
        return { poles: [...pts], spans: [], unmet: [] };
    }
    const count = closed ? n : n - 1;
    const h = splineSpans(pts, closed, shape.spacing);
    const idx = (i: number) => ((i % n) + n) % n;
    const at = (i: number) => pts[idx(i)];
    const spanBefore = (i: number) => h[((idx(i) - 1) % count + count) % count];
    const spanAfter = (i: number) => h[idx(i) % count];
    const hasBefore = (i: number) => closed || i > 0;
    const hasAfter = (i: number) => closed || i < n - 1;
    // Known derivatives (per unit of parameter) on either side of a point.
    const before: (P2 | null)[] = new Array(n).fill(null);
    const after: (P2 | null)[] = new Array(n).fill(null);
    if (!closed && shape.start) {
        after[0] = mul(sub(shape.start, pts[0]), 3 / h[0]);
    }
    if (!closed && shape.end) {
        before[n - 1] = mul(sub(pts[n - 1], shape.end), 3 / h[n - 2]);
    }
    for (const k of shape.inner ?? []) {
        const i = k.at;
        if (!Number.isInteger(i) || i < 0 || i >= n) {
            continue;
        }
        if (hasBefore(i)) {
            before[i] = mul(sub(pts[i], k.prev), 3 / spanBefore(i));
        }
        if (hasAfter(i)) {
            after[i] = mul(sub(k.next, pts[i]), 3 / spanAfter(i));
        }
    }
    const held = (i: number) => (!hasBefore(i) || !!before[i]) && (!hasAfter(i) || !!after[i]);
    const free: number[] = [];
    const unknown = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
        if (!held(i)) {
            unknown[i] = free.length;
            free.push(i);
        }
    }
    const F = free.length;
    // The derivative before / after point i as an expression.
    const dBefore = (i: number): VecExpr => (before[idx(i)] ? { terms: [], c: before[idx(i)]! } : { terms: [[unknown[idx(i)], 1]], c: [0, 0] });
    const dAfter = (i: number): VecExpr => (after[idx(i)] ? { terms: [], c: after[idx(i)]! } : { terms: [[unknown[idx(i)], 1]], c: [0, 0] });
    const combine = (parts: [VecExpr, number][], c: P2): VecExpr => {
        const terms: [number, number][] = [];
        let k: P2 = c;
        for (const [e, f] of parts) {
            e.terms.forEach(([u, w]) => terms.push([u, w * f]));
            k = add(k, mul(e.c, f));
        }
        return { terms, c: k };
    };
    // Second derivatives at a point: at the start of the piece after it, and at the end of the piece before it.
    const accelAfter = (i: number): VecExpr => {
        const hh = spanAfter(i);
        return combine([[dAfter(i), -4 / hh], [dBefore(i + 1), -2 / hh]], mul(sub(at(i + 1), at(i)), 6 / (hh * hh)));
    };
    const accelBefore = (i: number): VecExpr => {
        const hh = spanBefore(i);
        return combine([[dAfter(i - 1), 2 / hh], [dBefore(i), 4 / hh]], mul(sub(at(i), at(i - 1)), -6 / (hh * hh)));
    };
    // What each free point keeps: C2 inside (equal second derivatives), or a natural end (none).
    const condition = (i: number): VecExpr => {
        if (!hasBefore(i)) {
            return accelAfter(i);
        }
        if (!hasAfter(i)) {
            return accelBefore(i);
        }
        return combine([[accelBefore(i), 1], [accelAfter(i), -1]], [0, 0]);
    };
    // Extra scalar rows: a held curvature on each side, or equal curvature across a handle. Each needs a relaxed point.
    interface Requirement {
        point: number;
        row: (dir: Map<number, P2>) => { coef: Map<string, number>; rhs: number };
    }
    const requirements: Requirement[] = [];
    const relaxed = new Map<number, number>();
    const unmet: number[] = [];
    const take = (i: number, side: -1 | 1): boolean => {
        for (let step = 1; step < n; step++) {
            if (!closed && (i + side * step < 0 || i + side * step > n - 1)) {
                return false;
            }
            const j = idx(i + side * step);
            if (j === i || held(j)) {
                return false;
            }
            if (!relaxed.has(j)) {
                relaxed.set(j, requirements.length);
                return true;
            }
        }
        return false;
    };
    // A scalar row n · e (+ scale), as coefficients on the unknown x / y components.
    const project = (e: VecExpr, nrm: P2, scale = 1) => {
        const coef = new Map<string, number>();
        for (const [u, w] of e.terms) {
            for (const [axis, comp] of [[0, nrm[0]], [1, nrm[1]]] as const) {
                const key = `${u}:${axis}`;
                coef.set(key, (coef.get(key) ?? 0) + w * comp * scale);
            }
        }
        return { coef, rhs: -dot(e.c, nrm) * scale };
    };
    const curvatureAt = new Map<number, number>();
    for (const k of shape.curvature ?? []) {
        if (Number.isInteger(k.at) && k.at >= 0 && k.at < n && Number.isFinite(k.value) && held(k.at)) {
            curvatureAt.set(k.at, k.value);
        }
    }
    for (let i = 0; i < n; i++) {
        if (!held(i)) {
            continue;
        }
        const dir = after[i] ?? before[i]!;
        const nrm = leftNormal(dir);
        const kappa = curvatureAt.get(i);
        if (kappa !== undefined) {
            for (const side of [-1, 1] as const) {
                const exists = side < 0 ? hasBefore(i) : hasAfter(i);
                if (!exists) {
                    continue;
                }
                if (!take(i, side)) {
                    unmet.push(i);
                    continue;
                }
                const d = side < 0 ? before[i]! : after[i]!;
                requirements.push({
                    point: i,
                    row: () => {
                        const r = project(side < 0 ? accelBefore(i) : accelAfter(i), nrm);
                        return { coef: r.coef, rhs: r.rhs + kappa * dot(d, d) };
                    },
                });
            }
        } else if (shape.continuity && hasBefore(i) && hasAfter(i)) {
            if (!take(i, -1) && !take(i, 1)) {
                unmet.push(i);
                continue;
            }
            const [wb, wa] = [dot(before[i]!, before[i]!), dot(after[i]!, after[i]!)];
            requirements.push({
                point: i,
                row: () => {
                    const l = project(accelBefore(i), nrm, 1 / (wb || 1));
                    const r = project(accelAfter(i), nrm, -1 / (wa || 1));
                    const coef = new Map(l.coef);
                    r.coef.forEach((v, key) => coef.set(key, (coef.get(key) ?? 0) + v));
                    return { coef, rhs: l.rhs + r.rhs };
                },
            });
        }
    }
    const derivs: P2[] = new Array(F).fill(null).map(() => [0, 0] as P2);
    if (F > 0) {
        // The plain system: each free point's two conditions, x and y apart (the same matrix for both). It is
        // tridiagonal (periodic when closed): long splines (fits, offsets, equation curves) solve it in linear time.
        const r = Array.from({ length: F }, () => [0, 0]);
        const rows = free.map((i, row) => {
            const e = condition(i);
            r[row] = [-e.c[0], -e.c[1]];
            return e.terms;
        });
        let x: number[][] | null = null;
        if (F > 12) {
            const [lo, di, up] = [new Array(F).fill(0), new Array(F).fill(0), new Array(F).fill(0)];
            let [alpha, beta] = [0, 0];
            let band = true;
            rows.forEach((terms, k) => terms.forEach(([u, w]) => {
                if (u === k) {
                    di[k] += w;
                } else if (u === k - 1) {
                    lo[k] += w;
                } else if (u === k + 1) {
                    up[k] += w;
                } else if (closed && k === 0 && u === F - 1) {
                    beta += w;
                } else if (closed && k === F - 1 && u === 0) {
                    alpha += w;
                } else {
                    band = false;
                }
            }));
            x = band ? solveTridiagonal(lo, di, up, alpha, beta, r, closed) : null;
        }
        if (!x) {
            const m = Array.from({ length: F }, () => new Array(F).fill(0));
            rows.forEach((terms, k) => terms.forEach(([u, w]) => {
                m[k][u] += w;
            }));
            x = solveLinear(m, r);
        }
        x.forEach((d, k) => {
            derivs[k] = [d[0], d[1]];
        });
    }
    if (F > 0 && requirements.length > 0) {
        // Every free point stays curvature continuous (its condition across its own direction holds); along its
        // direction the condition is kept as nearly as it can be (least squares), so a held curvature or continuity
        // takes its freedom from all the free points around it a little rather than from one a lot. The directions
        // come from the solution: solved again until they settle.
        const size = 2 * F;
        const dense = (r: { coef: Map<string, number> }) => {
            const v = new Array(size).fill(0);
            r.coef.forEach((value, key) => {
                const [u, axis] = key.split(':').map(Number);
                v[2 * u + axis] += value;
            });
            return v;
        };
        const plain = derivs.map((d) => [d[0], d[1]] as P2);
        for (let pass = 0; pass < 80; pass++) {
            const normals = free.map((i) => leftNormal(derivs[unknown[i]]));
            const hard: { coef: Map<string, number>; rhs: number }[] = [];
            const soft: { coef: Map<string, number>; rhs: number }[] = [];
            free.forEach((i, k) => {
                const e = condition(i);
                const nrm = normals[k];
                hard.push(project(e, nrm));
                soft.push(project(e, [nrm[1], -nrm[0]]));
            });
            requirements.forEach((q) => hard.push(q.row(new Map())));
            // The held rows exactly, the rest as nearly as they can be (least squares with the held rows as
            // constraints: its KKT system); a faint pull to the plain spline keeps it solvable.
            const [S, Hm] = [soft.map(dense), hard.map(dense)];
            const N = size + Hm.length;
            const m = Array.from({ length: N }, () => new Array(N).fill(0));
            const kkt = Array.from({ length: N }, () => [0]);
            for (let a = 0; a < size; a++) {
                for (let b = 0; b < size; b++) {
                    let sum = 0;
                    for (const row of S) {
                        sum += row[a] * row[b];
                    }
                    m[a][b] = sum + (a === b ? 1e-12 : 0);
                }
                kkt[a][0] = S.reduce((sum, row, r) => sum + row[a] * soft[r].rhs, 0) + 1e-12 * plain[a >> 1][a & 1];
            }
            Hm.forEach((row, h) => {
                for (let a = 0; a < size; a++) {
                    m[a][size + h] = row[a];
                    m[size + h][a] = row[a];
                }
                kkt[size + h][0] = hard[h].rhs;
            });
            const x = solveLinear(m, kkt).map((r) => r[0]);
            let change = 0;
            for (let k = 0; k < F; k++) {
                const d: P2 = [x[2 * k], x[2 * k + 1]];
                change = Math.max(change, dist(d, derivs[k]));
                derivs[k] = d;
            }
            const settled = free.every((i, k) => dist(leftNormal(derivs[unknown[i]]), normals[k]) < 1e-14);
            if (settled || change < 1e-15) {
                break;
            }
        }
        // A held curvature its neighbours cannot give without running away (far from where the spline would go):
        // it does not hold, and the spline stays as it would be without it.
        const known = [...before, ...after].filter((d): d is P2 => !!d).map((d) => Math.hypot(d[0], d[1]));
        const scale = Math.max(1, ...plain.map((d) => Math.hypot(d[0], d[1])), ...known);
        if (derivs.some((d) => !(Math.hypot(d[0], d[1]) <= 4 * scale))) {
            derivs.splice(0, derivs.length, ...plain);
            requirements.forEach((q) => unmet.push(q.point));
        }
    }
    const dB = (i: number): P2 => before[idx(i)] ?? derivs[unknown[idx(i)]];
    const dA = (i: number): P2 => after[idx(i)] ?? derivs[unknown[idx(i)]];
    const poles: P2[] = [pts[0]];
    for (let i = 0; i < count; i++) {
        const p = pts[i];
        const q = at(i + 1);
        poles.push(add(p, mul(dA(i), h[i] / 3)), sub(q, mul(dB(i + 1), h[i] / 3)), q);
    }
    return { poles, spans: h, unmet: [...new Set(unmet)] };
}

/** The handle a spline would have at a point as it is now (its control points either side), from solved poles. */
export function handleAt(poles: P2[], closed: boolean, i: number): { prev: P2 | null; next: P2 | null } {
    const pieces = (poles.length - 1) / 3;
    const prev = i > 0 ? poles[3 * i - 1] : closed ? poles[3 * pieces - 1] : null;
    const next = i < pieces ? poles[3 * i + 1] : closed ? poles[1] : null;
    return { prev: prev ?? null, next: next ?? null };
}

// ---- Rational Bezier pieces and their curvature --------------------------------------------------------------

/** A Bezier piece of any degree (control points), rational when it has weights. */
export interface BezierPiece {
    poles: P2[];
    weights?: number[];
}

/** Point, first and second derivative of a piece at t (0 to 1). */
export function pieceDerivatives(piece: BezierPiece, t: number): { at: P2; d1: P2; d2: P2 } {
    const d = piece.poles.length - 1;
    const w = piece.weights && piece.weights.length === piece.poles.length ? piece.weights : null;
    // Homogeneous control points (x w, y w, w).
    const q = piece.poles.map((p, k) => {
        const wk = w ? w[k] : 1;
        return [p[0] * wk, p[1] * wk, wk];
    });
    const evaluate = (pts: number[][], degree: number): number[] => {
        if (degree < 0 || !pts.length) {
            return [0, 0, 0];
        }
        let level = pts.map((p) => [...p]);
        for (let r = 0; r < degree; r++) {
            level = level.slice(0, -1).map((p, k) => p.map((v, j) => (1 - t) * v + t * level[k + 1][j]));
        }
        return level[0];
    };
    const diff = (pts: number[][], scale: number) => pts.slice(0, -1).map((p, k) => p.map((v, j) => (pts[k + 1][j] - v) * scale));
    const q1 = d >= 1 ? diff(q, d) : [];
    const q2 = d >= 2 ? diff(q1, d - 1) : [];
    const A = evaluate(q, d);
    const A1 = d >= 1 ? evaluate(q1, d - 1) : [0, 0, 0];
    const A2 = d >= 2 ? evaluate(q2, d - 2) : [0, 0, 0];
    const wt = A[2] || 1e-300;
    const at: P2 = [A[0] / wt, A[1] / wt];
    const d1: P2 = [(A1[0] - A1[2] * at[0]) / wt, (A1[1] - A1[2] * at[1]) / wt];
    const d2: P2 = [(A2[0] - 2 * A1[2] * d1[0] - A2[2] * at[0]) / wt, (A2[1] - 2 * A1[2] * d1[1] - A2[2] * at[1]) / wt];
    return { at, d1, d2 };
}

/** Signed curvature (1/mm, positive turning left) of a piece at t. */
export function pieceCurvature(piece: BezierPiece, t: number): number {
    const { d1, d2 } = pieceDerivatives(piece, t);
    const l = len(d1);
    return l > 1e-300 ? cross(d1, d2) / (l * l * l) : 0;
}

/** A sample of a curve: where, its unit left normal and its signed curvature; `piece` and `t` say where on it. */
export interface CurvatureSample {
    at: P2;
    normal: P2;
    curvature: number;
    piece: number;
    t: number;
}

export function curvatureSample(pieces: BezierPiece[], piece: number, t: number): CurvatureSample {
    const { at, d1, d2 } = pieceDerivatives(pieces[piece], t);
    const l = len(d1);
    return { at, normal: leftNormal(d1), curvature: l > 1e-300 ? cross(d1, d2) / (l * l * l) : 0, piece, t };
}

/** `count` samples spread evenly over the pieces' parameter (the ends included). */
export function curvatureSamples(pieces: BezierPiece[], count: number): CurvatureSample[] {
    const n = Math.max(2, Math.round(count));
    const total = pieces.length;
    return Array.from({ length: n }, (_, k) => {
        const u = (k / (n - 1)) * total;
        const piece = Math.min(total - 1, Math.floor(u));
        return curvatureSample(pieces, piece, Math.min(1, u - piece));
    });
}

/**
 * The comb: a tooth at each sample, drawn away from the centre of curvature, `scale` mm long per 1/mm of
 * curvature; and the tips, which make the bounding curve.
 */
export function curvatureComb(pieces: BezierPiece[], count: number, scale: number): { teeth: [P2, P2][]; tips: P2[] } {
    const teeth = curvatureSamples(pieces, count).map((s): [P2, P2] => [s.at, sub(s.at, mul(s.normal, s.curvature * scale))]);
    return { teeth, tips: teeth.map((t) => t[1]) };
}

/** Where the curve's curvature changes sign: inside pieces, and at joins where it flips. */
export function inflectionPoints(pieces: BezierPiece[]): CurvatureSample[] {
    const out: CurvatureSample[] = [];
    // A curvature this small (against the largest) counts as none: a straight piece has no inflection.
    let largest = 0;
    const steps = 64;
    const values = pieces.map((p) => Array.from({ length: steps + 1 }, (_, k) => {
        const v = pieceCurvature(p, k / steps);
        largest = Math.max(largest, Math.abs(v));
        return v;
    }));
    const zero = largest * 1e-9;
    const sign = (v: number) => (Math.abs(v) <= zero ? 0 : Math.sign(v));
    let last = 0;
    pieces.forEach((p, i) => {
        const vals = values[i];
        for (let k = 0; k <= steps; k++) {
            const s = sign(vals[k]);
            if (s === 0) {
                continue;
            }
            if (last !== 0 && s !== last) {
                if (k === 0) {
                    // Flips at the join with the piece before.
                    out.push(curvatureSample(pieces, i, 0));
                } else {
                    let [lo, hi] = [(k - 1) / steps, k / steps];
                    // A stretch of zero before k: the inflection is in it, between the last signed sample and here.
                    let j = k - 1;
                    while (j > 0 && sign(vals[j]) === 0) {
                        j--;
                    }
                    lo = j / steps;
                    const f = (t: number) => pieceCurvature(p, t);
                    const fl = sign(f(lo));
                    for (let it = 0; it < 80 && hi - lo > 1e-15; it++) {
                        const mid = (lo + hi) / 2;
                        if (sign(f(mid)) === fl) {
                            lo = mid;
                        } else {
                            hi = mid;
                        }
                    }
                    out.push(curvatureSample(pieces, i, (lo + hi) / 2));
                }
            }
            last = s;
        }
    });
    return out;
}

/** The tightest place of the curve: the largest curvature, its radius and centre; null for a straight curve. */
export function minimumRadius(pieces: BezierPiece[]): (CurvatureSample & { radius: number; centre: P2 }) | null {
    const steps = 128;
    let best: { piece: number; t: number; k: number } | null = null;
    pieces.forEach((p, i) => {
        for (let s = 0; s <= steps; s++) {
            const k = Math.abs(pieceCurvature(p, s / steps));
            if (!best || k > best.k) {
                best = { piece: i, t: s / steps, k };
            }
        }
    });
    if (!best) {
        return null;
    }
    const b = best as { piece: number; t: number; k: number };
    // Golden section search for the peak next to the best sample.
    const p = pieces[b.piece];
    let lo = Math.max(0, b.t - 1 / steps);
    let hi = Math.min(1, b.t + 1 / steps);
    const g = (Math.sqrt(5) - 1) / 2;
    const f = (t: number) => Math.abs(pieceCurvature(p, t));
    let x1 = hi - g * (hi - lo);
    let x2 = lo + g * (hi - lo);
    let [f1, f2] = [f(x1), f(x2)];
    for (let it = 0; it < 100 && hi - lo > 1e-14; it++) {
        if (f1 > f2) {
            hi = x2;
            x2 = x1;
            f2 = f1;
            x1 = hi - g * (hi - lo);
            f1 = f(x1);
        } else {
            lo = x1;
            x1 = x2;
            f1 = f2;
            x2 = lo + g * (hi - lo);
            f2 = f(x2);
        }
    }
    const candidates = [b.t, (lo + hi) / 2];
    const t = candidates.reduce((a, c) => (f(c) > f(a) ? c : a));
    const s = curvatureSample(pieces, b.piece, t);
    if (!(Math.abs(s.curvature) > 1e-12)) {
        return null;
    }
    const radius = 1 / Math.abs(s.curvature);
    return { ...s, radius, centre: add(s.at, mul(s.normal, 1 / s.curvature)) };
}

/** The cubic pieces of a spline's poles ([p0, c, c, p1, ...]). */
export function cubicPieces(poles: P2[]): BezierPiece[] {
    const out: BezierPiece[] = [];
    for (let i = 0; i + 3 < poles.length; i += 3) {
        out.push({ poles: poles.slice(i, i + 4) });
    }
    return out;
}

/** A piece split at t into two that are the same curve (de Casteljau). */
export function splitPiece(piece: BezierPiece, t: number): [BezierPiece, BezierPiece] {
    const w = piece.weights && piece.weights.length === piece.poles.length ? piece.weights : null;
    const q = piece.poles.map((p, k) => [p[0] * (w ? w[k] : 1), p[1] * (w ? w[k] : 1), w ? w[k] : 1]);
    const left: number[][] = [q[0]];
    const right: number[][] = [q[q.length - 1]];
    let level = q;
    while (level.length > 1) {
        level = level.slice(0, -1).map((p, k) => p.map((v, j) => (1 - t) * v + t * level[k + 1][j]));
        left.push(level[0]);
        right.unshift(level[level.length - 1]);
    }
    const back = (pts: number[][]): BezierPiece => ({
        poles: pts.map((p) => [p[0] / p[2], p[1] / p[2]] as P2),
        ...(w ? { weights: pts.map((p) => p[2]) } : {}),
    });
    return [back(left), back(right)];
}

// ---- Curves of control vertices: clamped B-splines, rational or not ---------------------------------------------

/**
 * The full clamped knot vector of `count` control vertices of `degree` over 0 to 1: `inner` are the knots inside
 * (count - degree - 1 of them, repeats allowed up to the degree); without them they are evenly spaced.
 */
export function knotVector(count: number, degree: number, inner?: number[]): number[] {
    const spans = count - degree;
    const want = Math.max(0, spans - 1);
    const valid = inner && inner.length === want && inner.every((k, i) => k > 0 && k < 1 && (i === 0 || k >= inner[i - 1]));
    const middle = valid ? inner! : Array.from({ length: want }, (_, i) => (i + 1) / spans);
    return [...new Array(degree + 1).fill(0), ...middle, ...new Array(degree + 1).fill(1)];
}

/** Point at t (0 to 1) of the clamped B-spline (rational with weights) of these control vertices. */
export function nurbsAt(poles: P2[], degree: number, t: number, inner?: number[], weights?: number[]): P2 {
    const p = Math.min(degree, poles.length - 1);
    const U = knotVector(poles.length, p, inner);
    const w = weights && weights.length === poles.length ? weights : null;
    let k = p;
    while (k < poles.length - 1 && t >= U[k + 1]) {
        k++;
    }
    const d = Array.from({ length: p + 1 }, (_, j) => {
        const q = poles[j + k - p];
        const wj = w ? w[j + k - p] : 1;
        return [q[0] * wj, q[1] * wj, wj];
    });
    for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
            const i = j + k - p;
            const den = U[i + p - r + 1] - U[i];
            const a = den > 0 ? (t - U[i]) / den : 0;
            d[j] = d[j].map((v, c) => (1 - a) * d[j - 1][c] + a * v);
        }
    }
    return [d[p][0] / d[p][2], d[p][1] / d[p][2]];
}

/** The B-spline's Bezier pieces (each knot span one piece; the knot values of the spans are returned too). */
export function nurbsPieces(poles: P2[], degree: number, inner?: number[], weights?: number[]): { pieces: BezierPiece[]; breaks: number[] } {
    const p = Math.min(degree, poles.length - 1);
    let U = knotVector(poles.length, p, inner);
    const w = weights && weights.length === poles.length ? weights : null;
    let Q = poles.map((q, i) => [q[0] * (w ? w[i] : 1), q[1] * (w ? w[i] : 1), w ? w[i] : 1]);
    // Boehm's knot insertion until every inner knot is repeated `degree` times.
    const distinct = [...new Set(U.slice(p + 1, U.length - p - 1))];
    for (const u of distinct) {
        let mult = U.filter((x) => x === u).length;
        while (mult < p) {
            let k = 0;
            while (k + 1 < U.length && U[k + 1] <= u) {
                k++;
            }
            const next: number[][] = [];
            for (let i = 0; i <= Q.length; i++) {
                if (i <= k - p) {
                    next.push(Q[i]);
                } else if (i > k) {
                    next.push(Q[i - 1]);
                } else {
                    const a = (u - U[i]) / (U[i + p] - U[i]);
                    next.push(Q[i].map((v, c) => (1 - a) * Q[i - 1][c] + a * v));
                }
            }
            Q = next;
            U = [...U.slice(0, k + 1), u, ...U.slice(k + 1)];
            mult++;
        }
    }
    const breaks = [0, ...distinct, 1];
    const pieces: BezierPiece[] = [];
    for (let s = 0; s + 1 < breaks.length; s++) {
        const pts = Q.slice(s * p, s * p + p + 1);
        pieces.push({ poles: pts.map((q) => [q[0] / q[2], q[1] / q[2]] as P2), ...(w ? { weights: pts.map((q) => q[2]) } : {}) });
    }
    return { pieces, breaks };
}

// ---- A spline through points as a B-spline, and back --------------------------------------------------------

/** The blossom (polar form) of a cubic piece over [a, b] at three parameter values. */
function blossom(piece: P2[], a: number, b: number, args: [number, number, number]): P2 {
    let level = piece;
    for (const x of args) {
        const s = (x - a) / (b - a);
        level = level.slice(0, -1).map((p, k) => [(1 - s) * p[0] + s * level[k + 1][0], (1 - s) * p[1] + s * level[k + 1][1]] as P2);
    }
    return level[0];
}

/**
 * The cubic B-spline that is the same curve as a spline's Bezier pieces (with these spans): each join is a single
 * knot where the curve is C2 there, double where C1, triple otherwise. Knots run from 0 to 1.
 */
export function splineAsBSpline(poles: P2[], spans: number[]): { poles: P2[]; knots: number[]; mults: number[] } {
    const pieces = (poles.length - 1) / 3;
    const total = spans.reduce((a, b) => a + b, 0) || 1;
    const t = [0];
    spans.forEach((s) => t.push(t[t.length - 1] + s / total));
    t[t.length - 1] = 1;
    const mults = [4];
    const size = Math.max(...poles.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1]))), 1);
    const tol = 1e-9 * size;
    for (let j = 1; j < pieces; j++) {
        const [hl, hr] = [spans[j - 1], spans[j]];
        const [b1, b2, p, c1, c2] = [poles[3 * j - 2], poles[3 * j - 1], poles[3 * j], poles[3 * j + 1], poles[3 * j + 2]];
        const dl = mul(sub(p, b2), 3 / hl);
        const dr = mul(sub(c1, p), 3 / hr);
        if (dist(dl, dr) * Math.min(hl, hr) > tol) {
            mults.push(3);
            continue;
        }
        const al = mul(add(sub(p, mul(b2, 2)), b1), 6 / (hl * hl));
        const ar = mul(add(sub(c2, mul(c1, 2)), p), 6 / (hr * hr));
        mults.push(dist(al, ar) * Math.min(hl, hr) ** 2 > tol ? 2 : 1);
    }
    mults.push(4);
    const U: number[] = [];
    t.forEach((x, i) => U.push(...new Array(mults[i]).fill(x)));
    const count = U.length - 4;
    const out: P2[] = [];
    for (let k = 0; k < count; k++) {
        // Control point k is the blossom at its three middle knots, from a piece whose span it touches.
        const args: [number, number, number] = [U[k + 1], U[k + 2], U[k + 3]];
        let piece = -1;
        for (let j = k; j <= k + 3 && piece < 0; j++) {
            if (U[j + 1] > U[j]) {
                piece = t.findIndex((x) => x === U[j]);
            }
        }
        piece = Math.max(0, Math.min(pieces - 1, piece));
        out.push(blossom(poles.slice(3 * piece, 3 * piece + 4), t[piece], t[piece + 1], args));
    }
    return { poles: out, knots: t, mults };
}

/** The cubic Bezier pieces of a cubic B-spline given by distinct knots and multiplicities (as splineAsBSpline gives). */
export function bsplineAsPieces(poles: P2[], knots: number[], mults: number[]): P2[] {
    const U: number[] = [];
    knots.forEach((x, i) => U.push(...new Array(mults[i]).fill(x)));
    const inner = U.slice(4, U.length - 4);
    const { pieces } = nurbsPieces(poles, 3, inner);
    const out: P2[] = [pieces[0].poles[0]];
    pieces.forEach((p) => out.push(p.poles[1], p.poles[2], p.poles[3]));
    return out;
}

/** The inner knots (with repeats) of a B-spline given by distinct knots and multiplicities. */
export function innerKnots(knots: number[], mults: number[], degree: number): number[] {
    const U: number[] = [];
    knots.forEach((x, i) => U.push(...new Array(mults[i]).fill(x)));
    return U.slice(degree + 1, U.length - degree - 1);
}

/** Distinct knots and multiplicities of a clamped knot vector. */
export function knotMultiplicities(U: number[]): { knots: number[]; mults: number[] } {
    const knots: number[] = [];
    const mults: number[] = [];
    for (const u of U) {
        if (knots.length && u === knots[knots.length - 1]) {
            mults[mults.length - 1]++;
        } else {
            knots.push(u);
            mults.push(1);
        }
    }
    return { knots, mults };
}

/** Degree elevation of a Bezier curve by one (the same curve). */
export function elevateBezier(poles: P2[]): P2[] {
    const n = poles.length - 1;
    const out: P2[] = [poles[0]];
    for (let i = 1; i <= n; i++) {
        const a = i / (n + 1);
        out.push(add(mul(poles[i - 1], a), mul(poles[i], 1 - a)));
    }
    out.push(poles[n]);
    return out;
}

/** Length of a curve given as pieces (Gauss-Legendre on each piece, split until it settles). */
export function piecesLength(pieces: BezierPiece[]): number {
    const xs = [-0.9739065285171717, -0.8650633666889845, -0.6794095682990244, -0.4333953941292472, -0.1488743389816312,
        0.1488743389816312, 0.4333953941292472, 0.6794095682990244, 0.8650633666889845, 0.9739065285171717];
    const ws = [0.0666713443086881, 0.1494513491505806, 0.2190863625159820, 0.2692667193099963, 0.2955242247147529,
        0.2955242247147529, 0.2692667193099963, 0.2190863625159820, 0.1494513491505806, 0.0666713443086881];
    let total = 0;
    for (const p of pieces) {
        const parts = 16;
        for (let s = 0; s < parts; s++) {
            const [a, b] = [s / parts, (s + 1) / parts];
            let sum = 0;
            xs.forEach((x, i) => {
                sum += ws[i] * len(pieceDerivatives(p, (a + b) / 2 + ((b - a) / 2) * x).d1);
            });
            total += (sum * (b - a)) / 2;
        }
    }
    return total;
}
