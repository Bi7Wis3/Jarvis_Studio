// The simplest exact sketch entity for a projected model curve. The kernel hands many edges over as B-splines (a loft
// makes every edge one, straight or round); seen on a sketch plane such a curve becomes a line where it is straight
// and a circle or arc where it is round, and stays a spline only where it is truly free-form (an edge that is a
// circle in space and is seen at a tilt is found in space and projected as the exact ellipse: projection.ts). Each fit
// is proved along the whole curve, not sampled: on every Bezier piece the distance to the fitted line or circle is
// bounded by the Bernstein coefficients of a polynomial (the convex hull property), the piece being halved until the
// bound proves the fit or the fit fails. Ellipses are not fitted to free-form curves: five free parameters fit a short
// piece of almost any smooth curve to well within the tolerance.

import type { ModelCurve, P2 } from './projection';

/** One polynomial or rational Bezier piece: poles and their weights (all 1 for a polynomial). */
export interface BezierPiece {
    poles: P2[];
    weights: number[];
}

/** Deviation within which a projected curve counts as the simpler entity, in mm (the app's finest value). */
export const KIND_TOLERANCE = 1e-6;

const TAU = 2 * Math.PI;
const tidy = (x: number): number => Math.round(x * 1e9) / 1e9 + 0;
const tidyP = (p: P2): P2 => [tidy(p[0]), tidy(p[1])];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0];
const len = (a: P2): number => Math.hypot(a[0], a[1]);
const near = (a: P2, b: P2, tol: number): boolean => len(sub(a, b)) <= tol;

const binomials: number[][] = [];
function binom(n: number, k: number): number {
    while (binomials.length <= n) {
        const m = binomials.length;
        const row = [1];
        for (let i = 1; i <= m; i++) {
            row.push(i === m ? 1 : binomials[m - 1][i - 1] + binomials[m - 1][i]);
        }
        binomials.push(row);
    }
    return binomials[n][k];
}

/** The point of a piece at t (de Casteljau on homogeneous poles). */
export function pieceAt(piece: BezierPiece, t: number): P2 {
    const n = piece.poles.length;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        w[i] = piece.weights[i];
        x[i] = piece.poles[i][0] * w[i];
        y[i] = piece.poles[i][1] * w[i];
    }
    for (let k = n - 1; k > 0; k--) {
        for (let i = 0; i < k; i++) {
            x[i] = (1 - t) * x[i] + t * x[i + 1];
            y[i] = (1 - t) * y[i] + t * y[i + 1];
            w[i] = (1 - t) * w[i] + t * w[i + 1];
        }
    }
    return [x[0] / w[0], y[0] / w[0]];
}

/** The two halves of a piece. */
function halves(piece: BezierPiece): [BezierPiece, BezierPiece] {
    const n = piece.poles.length;
    const x = piece.poles.map((p, i) => p[0] * piece.weights[i]);
    const y = piece.poles.map((p, i) => p[1] * piece.weights[i]);
    const w = [...piece.weights];
    const left: BezierPiece = { poles: [], weights: [] };
    const right: BezierPiece = { poles: [], weights: [] };
    const put = (into: BezierPiece, i: number) => {
        into.poles.push([x[i] / w[i], y[i] / w[i]]);
        into.weights.push(w[i]);
    };
    put(left, 0);
    put(right, n - 1);
    for (let k = n - 1; k > 0; k--) {
        for (let i = 0; i < k; i++) {
            x[i] = 0.5 * (x[i] + x[i + 1]);
            y[i] = 0.5 * (y[i] + y[i + 1]);
            w[i] = 0.5 * (w[i] + w[i + 1]);
        }
        put(left, 0);
        put(right, k - 1);
    }
    right.poles.reverse();
    right.weights.reverse();
    return [left, right];
}

/** Points along the pieces, `per` intervals each, ends included once. */
function samplesOf(pieces: BezierPiece[], per: number): P2[] {
    const out: P2[] = [];
    pieces.forEach((piece, k) => {
        for (let i = k === 0 ? 0 : 1; i <= per; i++) {
            out.push(i === 0 ? piece.poles[0] : i === per ? piece.poles[piece.poles.length - 1] : pieceAt(piece, i / per));
        }
    });
    return out;
}

const startOf = (pieces: BezierPiece[]): P2 => pieces[0].poles[0];
const endOf = (pieces: BezierPiece[]): P2 => pieces[pieces.length - 1].poles[pieces[pieces.length - 1].poles.length - 1];

// ---- Lines -------------------------------------------------------------------------------------------------

/** The chord, when every pole lies within tol of it and between its ends (the curve then covers exactly that). */
function asLine(pieces: BezierPiece[], tol: number): ModelCurve | null {
    const a = startOf(pieces);
    const b = endOf(pieces);
    const l = len(sub(b, a));
    if (!(l > tol)) {
        return null;
    }
    const d: P2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    for (const piece of pieces) {
        for (const p of piece.poles) {
            const r = sub(p, a);
            const along = dot(r, d);
            if (Math.abs(cross(d, r)) > tol || along < -tol || along > l + tol) {
                return null;
            }
        }
    }
    return { kind: 'line', a: tidyP(a), b: tidyP(b) };
}

// ---- Circles ------------------------------------------------------------------------------------------------

/**
 * An upper bound of | |C(t) - c| - r | over the piece, in the frame where the circle is (c, r): from the Bernstein
 * coefficients of |Y|^2 - r^2 W^2 (Y the homogeneous poles less c, W the weights).
 */
function radialBound(piece: BezierPiece, c: P2, r: number): number {
    const n = piece.poles.length - 1;
    const q = piece.poles.map((p, i) => [(p[0] - c[0]) * piece.weights[i], (p[1] - c[1]) * piece.weights[i]] as P2);
    const w = piece.weights;
    let worst = 0;
    for (let k = 0; k <= 2 * n; k++) {
        let sum = 0;
        for (let i = Math.max(0, k - n); i <= Math.min(n, k); i++) {
            const j = k - i;
            sum += (binom(n, i) * binom(n, j)) * (dot(q[i], q[j]) - r * r * w[i] * w[j]);
        }
        worst = Math.max(worst, Math.abs(sum / binom(2 * n, k)));
    }
    const wMin = Math.min(...w);
    // |C - c|^2 - r^2 is within F of 0, so |C - c| >= sqrt(r^2 - F), and | |C - c| - r | <= F / (|C - c| + r).
    const F = worst / (wMin * wMin);
    return F / (r + Math.sqrt(Math.max(0, r * r - F)));
}

/**
 * Whether the piece stays within tol of the circle: the parts whose bound is not yet tight enough are halved, level
 * by level (a point off the circle anywhere is found early), at most 2^7 parts deep.
 */
function provedOnCircle(piece: BezierPiece, c: P2, r: number, tol: number): boolean {
    let open = [piece];
    for (let depth = 0; open.length; depth++) {
        const loose = open.filter((p) => radialBound(p, c, r) > tol);
        if (loose.length && depth >= 7) {
            return false;
        }
        // Cheap refusal: the middle of a part already off by more than tol.
        if (loose.some((p) => Math.abs(len(sub(pieceAt(p, 0.5), c)) - r) > tol)) {
            return false;
        }
        open = loose.flatMap(halves);
    }
    return true;
}

/** Least squares circle through points (x^2 + y^2 + D x + E y + F = 0), with weights. */
function fitCircle(points: P2[], weights: number[]): { c: P2; r: number } | null {
    const o = points[0];
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const rhs = [0, 0, 0];
    points.forEach((p, i) => {
        const [x, y] = sub(p, o);
        const row = [x, y, 1];
        const z = -(x * x + y * y);
        const w = weights[i];
        for (let a = 0; a < 3; a++) {
            rhs[a] += w * row[a] * z;
            for (let b = 0; b < 3; b++) {
                m[a][b] += w * row[a] * row[b];
            }
        }
    });
    const s = solve(m, rhs);
    if (!s) {
        return null;
    }
    const c: P2 = [o[0] - s[0] / 2, o[1] - s[1] / 2];
    const r2 = (s[0] * s[0] + s[1] * s[1]) / 4 - s[2];
    return r2 > 0 ? { c, r: Math.sqrt(r2) } : null;
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solve(m: number[][], rhs: number[]): number[] | null {
    const n = rhs.length;
    const a = m.map((row, i) => [...row, rhs[i]]);
    const scale = Math.max(...a.flatMap((row) => row.slice(0, n).map(Math.abs))) || 1;
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) {
                pivot = r;
            }
        }
        if (Math.abs(a[pivot][col]) <= 1e-14 * scale) {
            return null;
        }
        [a[col], a[pivot]] = [a[pivot], a[col]];
        for (let r = 0; r < n; r++) {
            if (r !== col) {
                const f = a[r][col] / a[col][col];
                for (let k = col; k <= n; k++) {
                    a[r][k] -= f * a[col][k];
                }
            }
        }
    }
    return a.map((row, i) => row[n] / row[i]);
}

/** The angle the samples turn through about c in a frame (unwrapped), or null when they go back on themselves. */
function sweepOf(points: P2[], angle: (p: P2) => number): number | null {
    let total = 0;
    let last = angle(points[0]);
    let sign = 0;
    for (const p of points.slice(1)) {
        const a = angle(p);
        const step = Math.atan2(Math.sin(a - last), Math.cos(a - last));
        last = a;
        if (Math.abs(step) < 1e-12) {
            continue;
        }
        const s = Math.sign(step);
        if (sign && s !== sign) {
            return null;
        }
        sign = s;
        total += step;
    }
    return total;
}

/** Samples per Bezier piece for fitting and for the turning sense: enough for any degree the kernel gives. */
const perPiece = (pieces: BezierPiece[]): number => Math.max(8, 2 * Math.max(...pieces.map((p) => p.poles.length)));

/** The chain of pieces as one circle, or one counter-clockwise arc, within tol; null when it is not one. */
export function asCircular(pieces: BezierPiece[], tol: number): ModelCurve | null {
    const pts = samplesOf(pieces, perPiece(pieces));
    const a = startOf(pieces);
    const b = endOf(pieces);
    const closed = near(a, b, tol);
    // The ends weigh heavily, so the circle runs through them; the centre then goes onto their bisector exactly.
    const fit = fitCircle(pts, pts.map((_, i) => (i === 0 || i === pts.length - 1 ? 1e6 : 1)));
    if (!fit) {
        return null;
    }
    let c = fit.c;
    if (!closed) {
        const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const chord = sub(b, a);
        const l = len(chord);
        const n: P2 = [-chord[1] / l, chord[0] / l];
        c = [m[0] + n[0] * dot(sub(c, m), n), m[1] + n[1] * dot(sub(c, m), n)];
    }
    const r = closed ? fit.r : len(sub(a, c));
    // Cheap refusals first: a sample off the circle, or more than once round; only then the proof.
    if (!(r > tol) || pts.some((p) => Math.abs(len(sub(p, c)) - r) > tol)) {
        return null;
    }
    const sweep = sweepOf(pts, (p) => Math.atan2(p[1] - c[1], p[0] - c[0]));
    if (sweep === null || Math.abs(sweep) > TAU + 1e-9 || !pieces.every((piece) => provedOnCircle(piece, c, r, tol))) {
        return null;
    }
    if (closed && Math.abs(Math.abs(sweep) - TAU) < 1e-6) {
        return { kind: 'circle', center: tidyP(c), radius: tidy(r) };
    }
    if (closed) {
        return null;
    }
    const [start, end] = sweep > 0 ? [a, b] : [b, a];
    return { kind: 'arc', center: tidyP(c), start: tidyP(start), end: tidyP(end) };
}

// ---- Putting it together -------------------------------------------------------------------------------------

/** The chain of pieces as one line, circle or arc within tol, or null. */
export function oneSimpleCurve(pieces: BezierPiece[], tol = KIND_TOLERANCE): ModelCurve | null {
    if (!pieces.length || pieces.some((p) => p.poles.length < 2 || p.weights.some((w) => !(w > 0)))) {
        return null;
    }
    return asLine(pieces, tol) ?? asCircular(pieces, tol);
}

const flat = (w: number[]): boolean => w.every((x) => Math.abs(x - w[0]) <= 1e-12 * Math.abs(w[0]));

/** One piece as it is: a line (two poles), a Bezier (polynomial), a conic (rational quadratic), else null. */
function exactPiece(piece: BezierPiece): ModelCurve | null {
    const w = piece.weights;
    if (piece.poles.length === 2) {
        return { kind: 'line', a: tidyP(piece.poles[0]), b: tidyP(piece.poles[1]) };
    }
    if (flat(w)) {
        return { kind: 'bezier', poles: piece.poles.map(tidyP) };
    }
    if (piece.poles.length === 3 && w.every((x) => x > 0)) {
        // Weights (w0, w1, w2) give the same curve as (1, w1 / sqrt(w0 w2), 1); Rho = w / (1 + w).
        const k = w[1] / Math.sqrt(w[0] * w[2]);
        const [start, apex, end] = piece.poles.map(tidyP);
        return { kind: 'conic', start, apex, end, rho: k / (1 + k) };
    }
    return null;
}

/**
 * The pieces of one curve as the fewest simplest entities: the whole as one line or circle when it is one; else each
 * run of consecutive pieces that is one line or arc as that, and every other piece as it is (a Bezier or a conic).
 * Null: a rational piece of degree three or more that is none of these.
 */
export function simplestPieces(pieces: BezierPiece[], tol = KIND_TOLERANCE, wholeTried = false): ModelCurve[] | null {
    const whole = wholeTried ? null : oneSimpleCurve(pieces, tol);
    if (whole) {
        return [whole];
    }
    const out: ModelCurve[] = [];
    for (let i = 0; i < pieces.length;) {
        const first = oneSimpleCurve([pieces[i]], tol);
        if (!first) {
            const exact = exactPiece(pieces[i]);
            if (!exact) {
                return null;
            }
            out.push(exact);
            i++;
            continue;
        }
        // The run: the pieces after it on the same line or circle (each checked alone, so a long run stays cheap; a
        // circle no further than once round), then fitted as one, shortened from its end in the rare case it is not.
        let j = i + 1;
        if (first.kind === 'line') {
            while (j < pieces.length && onLine(pieces[j], first.a, first.b, tol)) {
                j++;
            }
        } else if (first.kind === 'arc') {
            const r = len(sub(first.start, first.center));
            let turned = pieceSweep(pieces[i], first.center) ?? TAU;
            while (j < pieces.length && provedOnCircle(pieces[j], first.center, r, tol)) {
                const more = pieceSweep(pieces[j], first.center);
                if (more === null || Math.sign(more) !== Math.sign(turned) || Math.abs(turned + more) > TAU) {
                    break;
                }
                turned += more;
                j++;
            }
        }
        let best: ModelCurve | null = first;
        while (j > i + 1) {
            best = oneSimpleCurve(pieces.slice(i, j), tol);
            if (best?.kind === first.kind || (first.kind === 'arc' && best?.kind === 'circle')) {
                break;
            }
            best = first;
            j--;
        }
        out.push(best!);
        i = j;
    }
    // Runs that stopped short of each other on one line or circle.
    return joinCurves(out, tol);
}

/** Whether every pole of the piece lies within tol of the line through a and b. */
function onLine(piece: BezierPiece, a: P2, b: P2, tol: number): boolean {
    const l = len(sub(b, a));
    const d: P2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    return piece.poles.every((p) => Math.abs(cross(d, sub(p, a))) <= tol);
}

/** The angle a piece turns through about c, or null when it goes back on itself. */
function pieceSweep(piece: BezierPiece, c: P2): number | null {
    return sweepOf(samplesOf([piece], perPiece([piece])), (p) => Math.atan2(p[1] - c[1], p[0] - c[0]));
}

// ---- Joining curves of a loop --------------------------------------------------------------------------------

const endsOf = (c: ModelCurve): P2[] => (c.kind === 'line' ? [c.a, c.b] : c.kind === 'arc' || c.kind === 'ellipseArc' ? [c.start, c.end] : []);

/** Two curves that meet at one end as one line, arc, circle, elliptical arc or ellipse, or null. */
function joined(p: ModelCurve, q: ModelCurve, tol: number): ModelCurve | null {
    if (p.kind === 'line' && q.kind === 'line') {
        // Meeting end to end, the far ends on the line through the two and on either side of the meeting point.
        for (const [a, m, m2, b] of [[p.a, p.b, q.a, q.b], [p.a, p.b, q.b, q.a], [p.b, p.a, q.a, q.b], [p.b, p.a, q.b, q.a]]) {
            if (!near(m, m2, tol)) {
                continue;
            }
            const l = len(sub(b, a));
            if (!(l > tol)) {
                return null;
            }
            const d: P2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
            const r = sub(m, a);
            const along = dot(r, d);
            return Math.abs(cross(d, r)) <= tol && along > tol && along < l - tol ? { kind: 'line', a, b } : null;
        }
        return null;
    }
    if (p.kind === 'arc' && q.kind === 'arc') {
        const rp = len(sub(p.start, p.center));
        const rq = len(sub(q.start, q.center));
        if (len(sub(p.center, q.center)) + Math.abs(rp - rq) > tol) {
            return null;
        }
        // Counter-clockwise both: one's end is the other's start.
        const [first, second] = near(p.end, q.start, tol) ? [p, q] : near(q.end, p.start, tol) ? [q, p] : [null, null];
        if (!first || !second) {
            return null;
        }
        const c: P2 = [(p.center[0] + q.center[0]) / 2, (p.center[1] + q.center[1]) / 2];
        if (near(second.end, first.start, tol)) {
            return { kind: 'circle', center: tidyP(c), radius: tidy((rp + rq) / 2) };
        }
        const sweep = (x: Extract<ModelCurve, { kind: 'arc' }>) => {
            let s = Math.atan2(x.end[1] - x.center[1], x.end[0] - x.center[0]) - Math.atan2(x.start[1] - x.center[1], x.start[0] - x.center[0]);
            while (s <= 0) {
                s += TAU;
            }
            return s;
        };
        if (sweep(first) + sweep(second) >= TAU) {
            return null;
        }
        // The centre on the new ends' bisector, so both lie on the circle exactly.
        const [a, b] = [first.start, second.end];
        const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const chord = sub(b, a);
        const l = len(chord);
        const n: P2 = [-chord[1] / l, chord[0] / l];
        const centre: P2 = [m[0] + n[0] * dot(sub(c, m), n), m[1] + n[1] * dot(sub(c, m), n)];
        return { kind: 'arc', center: tidyP(centre), start: a, end: b };
    }
    if (p.kind === 'ellipseArc' && q.kind === 'ellipseArc') {
        if (len(sub(p.center, q.center)) + len(sub(p.major, q.major)) + Math.abs(p.minor - q.minor) > tol) {
            // The major point may be either end of the axis.
            const flipped: P2 = [2 * q.center[0] - q.major[0], 2 * q.center[1] - q.major[1]];
            if (len(sub(p.center, q.center)) + len(sub(p.major, flipped)) + Math.abs(p.minor - q.minor) > tol) {
                return null;
            }
        }
        const [first, second] = near(p.end, q.start, tol) ? [p, q] : near(q.end, p.start, tol) ? [q, p] : [null, null];
        if (!first || !second) {
            return null;
        }
        if (near(second.end, first.start, tol)) {
            return { kind: 'ellipse', center: p.center, major: p.major, minor: p.minor };
        }
        const ax = sub(p.major, p.center);
        const ang = (x: P2) => Math.atan2(cross(ax, sub(x, p.center)) / p.minor, dot(ax, sub(x, p.center)) / len(ax));
        let s1 = ang(first.end) - ang(first.start);
        let s2 = ang(second.end) - ang(second.start);
        while (s1 <= 0) {
            s1 += TAU;
        }
        while (s2 <= 0) {
            s2 += TAU;
        }
        return s1 + s2 < TAU ? { ...p, start: first.start, end: second.end } : null;
    }
    return null;
}

/**
 * Joins curves that continue one another (two lines of one line, two arcs of one circle, two elliptical arcs of
 * one ellipse) where they meet end to end and nothing else meets there. `group` keeps curves of different loops
 * apart. The order of what is left is kept.
 */
export function joinCurves<T extends ModelCurve>(curves: T[], tol = KIND_TOLERANCE, group: (c: T) => string = () => ''): T[] {
    const out = [...curves];
    // Curves of the same loop that end at p.
    const users = (p: P2, key: string): number => out.reduce((n, c) => n + (group(c) === key ? endsOf(c).filter((q) => near(p, q, tol)).length : 0), 0);
    for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
            if (group(out[i]) !== group(out[j])) {
                continue;
            }
            const shared = endsOf(out[i]).find((p) => endsOf(out[j]).some((q) => near(p, q, tol)));
            if (!shared || users(shared, group(out[i])) !== 2) {
                continue;
            }
            const both = joined(out[i], out[j], tol);
            if (both) {
                // Keep the first one's tags (edge, face, loop).
                const { kind: _k, ...tags } = out[i] as ModelCurve & Record<string, unknown>;
                const keep = Object.fromEntries(Object.entries(tags).filter(([k]) => k === 'edge' || k === 'face' || k === 'loop'));
                out[i] = { ...both, ...keep } as T;
                out.splice(j, 1);
                j = i;
            }
        }
    }
    return out;
}
