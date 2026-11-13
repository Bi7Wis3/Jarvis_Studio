// Measurements of picked faces and edges, from the tessellated kernel mesh (see picking.ts for the ordinals):
// edge type (line, circle, arc), lengths, areas, minimum distances and angles. Plain arrays in, plain data out.
// Values that depend on the tessellation (curved areas, sampled distances) are flagged `approx`.

import { edgeSegments, faceArea, facePlane, faceTriangles, type P3 } from './picking';

export interface MeasureMesh {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
    triFace: ArrayLike<number>;
    /** Line segment pairs of the B-rep edges, six floats each. */
    edges: ArrayLike<number>;
    segEdge: ArrayLike<number>;
}

export interface MeasurePick {
    kind: 'face' | 'edge';
    index: number;
}

// ---- Vector helpers ----------------------------------------------------------------------------------------

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: P3, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: P3): number => Math.hypot(a[0], a[1], a[2]);
const dist = (a: P3, b: P3): number => len(sub(a, b));
const unit = (a: P3): P3 => {
    const l = len(a);
    return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
const at = (a: ArrayLike<number>, i: number): P3 => [a[i], a[i + 1], a[i + 2]];

/** Angle between two directions in degrees, 0..180. */
export function angleBetween(a: P3, b: P3): number {
    const c = dot(unit(a), unit(b));
    return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

/** Angle between two lines (directions without sign), 0..90 degrees. */
export function lineAngle(a: P3, b: P3): number {
    const angle = angleBetween(a, b);
    return angle > 90 ? 180 - angle : angle;
}

// ---- Edge polylines ---------------------------------------------------------------------------------------

/** Welded points of a segment list and the chain through them (ordered, open or closed). */
export function polyline(segments: ArrayLike<number>): { points: P3[]; closed: boolean } {
    const ids = new Map<string, number>();
    const points: P3[] = [];
    const key = (p: P3) => p.map((v) => Math.round(v * 1e4)).join(',');
    const id = (p: P3): number => {
        const k = key(p);
        let i = ids.get(k);
        if (i === undefined) {
            i = points.length;
            ids.set(k, i);
            points.push(p);
        }
        return i;
    };
    const links: number[][] = [];
    for (let s = 0; s + 5 < segments.length; s += 6) {
        const a = id(at(segments, s));
        const b = id(at(segments, s + 3));
        if (a === b) {
            continue;
        }
        (links[a] ??= []).push(b);
        (links[b] ??= []).push(a);
    }
    if (points.length === 0) {
        return { points: [], closed: false };
    }
    // Walk from an end (a point with one link) if there is one, else around the loop.
    let start = points.findIndex((_, i) => (links[i]?.length ?? 0) === 1);
    const closed = start < 0;
    start = Math.max(0, start);
    const order: number[] = [start];
    const seen = new Set(order);
    for (let current = start; ;) {
        const next = (links[current] ?? []).find((n) => !seen.has(n));
        if (next === undefined) {
            break;
        }
        order.push(next);
        seen.add(next);
        current = next;
    }
    // A branched or broken set of segments: keep every point, in the order found.
    points.forEach((_, i) => !seen.has(i) && order.push(i));
    return { points: order.map((i) => points[i]), closed };
}

/** Whether all points lie on the line through the first and last within `tolerance` (default relative). */
export function isStraight(points: P3[], tolerance?: number): boolean {
    if (points.length < 2) {
        return false;
    }
    const a = points[0];
    const b = points[points.length - 1];
    const span = dist(a, b);
    if (span < 1e-9) {
        return false;
    }
    const d = scale(sub(b, a), 1 / span);
    const tol = tolerance ?? Math.max(span * 1e-4, 5e-5);
    return points.every((p) => len(cross(sub(p, a), d)) <= tol);
}

/** Eigenvector of the smallest eigenvalue of a symmetric 3×3 matrix (Jacobi). */
function smallestAxis(m: number[][]): P3 {
    const a = m.map((r) => [...r]);
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 40; sweep++) {
        if (Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]) < 1e-14 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300)) {
            break;
        }
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (a[p][q] === 0) {
                continue;
            }
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let k = 0; k < 3; k++) {
                const [x, y] = [a[k][p], a[k][q]];
                a[k][p] = c * x - s * y;
                a[k][q] = s * x + c * y;
            }
            for (let k = 0; k < 3; k++) {
                const [x, y] = [a[p][k], a[q][k]];
                a[p][k] = c * x - s * y;
                a[q][k] = s * x + c * y;
            }
            for (let k = 0; k < 3; k++) {
                const [x, y] = [v[k][p], v[k][q]];
                v[k][p] = c * x - s * y;
                v[k][q] = s * x + c * y;
            }
        }
    }
    const i = [0, 1, 2].reduce((best, k) => (a[k][k] < a[best][best] ? k : best), 0);
    return unit([v[0][i], v[1][i], v[2][i]]);
}

export interface CircleFit {
    centre: P3;
    radius: number;
    /** Unit normal of the circle's plane. */
    normal: P3;
    /** Largest distance of a point from the circle, mm. */
    residual: number;
}

/**
 * Circle through points of a polyline, when they lie on one: best-fit plane, then an algebraic (Kåsa) fit in it.
 * Null when there are too few points, they are not planar, or they do not lie on a circle within the tolerance.
 */
export function fitCircle(points: P3[]): CircleFit | null {
    if (points.length < 3) {
        return null;
    }
    const n = points.length;
    const c = scale(points.reduce(add, [0, 0, 0] as P3), 1 / n);
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    let extent = 0;
    for (const p of points) {
        const d = sub(p, c);
        extent = Math.max(extent, len(d));
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                cov[i][j] += d[i] * d[j];
            }
        }
    }
    if (extent < 1e-9) {
        return null;
    }
    const normal = smallestAxis(cov);
    const tol = Math.max(extent * 2e-3, 2e-4);
    if (points.some((p) => Math.abs(dot(sub(p, c), normal)) > tol)) {
        return null;
    }
    // In-plane basis.
    const u = unit(cross(normal, Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const v = cross(normal, u);
    // Least squares for x² + y² + D x + E y + F = 0 (coordinates scaled by the extent for conditioning).
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const r = [0, 0, 0];
    for (const p of points) {
        const d = sub(p, c);
        const x = dot(d, u) / extent;
        const y = dot(d, v) / extent;
        const row = [x, y, 1];
        const rhs = -(x * x + y * y);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                m[i][j] += row[i] * row[j];
            }
            r[i] += row[i] * rhs;
        }
    }
    const solution = solve3(m, r);
    if (!solution) {
        return null;
    }
    const [D, E, F] = solution;
    const cx = -D / 2;
    const cy = -E / 2;
    const r2 = cx * cx + cy * cy - F;
    if (!(r2 > 0)) {
        return null;
    }
    const radius = Math.sqrt(r2) * extent;
    const centre = add(c, add(scale(u, cx * extent), scale(v, cy * extent)));
    let residual = 0;
    for (const p of points) {
        residual = Math.max(residual, Math.abs(dist(p, centre) - radius));
    }
    // A huge radius is a nearly straight line, not a circle worth naming.
    if (residual > Math.max(radius * 2e-3, 2e-4) || radius > extent * 1e3) {
        return null;
    }
    return { centre, radius, normal, residual };
}

function solve3(m: number[][], r: number[]): number[] | null {
    const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const d = det(m);
    if (Math.abs(d) < 1e-12) {
        return null;
    }
    return [0, 1, 2].map((k) => det(m.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)))) / d);
}

export type EdgeInfo =
    | { kind: 'line'; length: number; start: P3; end: P3; direction: P3 }
    | { kind: 'circle' | 'arc'; length: number; radius: number; centre: P3; normal: P3; /** degrees */ angle: number; start?: P3; end?: P3 }
    | { kind: 'curve'; length: number; closed: boolean; start?: P3; end?: P3 };

/** What an edge is (line, circle, arc or other curve) and its sizes. Curve lengths are chord sums (approximate). */
export function analyseEdge(segments: ArrayLike<number>): EdgeInfo | null {
    const { points, closed } = polyline(segments);
    if (points.length < 2) {
        return null;
    }
    let chord = 0;
    for (let s = 0; s + 5 < segments.length; s += 6) {
        chord += dist(at(segments, s), at(segments, s + 3));
    }
    const ends = closed ? {} : { start: points[0], end: points[points.length - 1] };
    if (!closed && isStraight(points)) {
        const [start, end] = [points[0], points[points.length - 1]];
        return { kind: 'line', length: dist(start, end), start, end, direction: unit(sub(end, start)) };
    }
    const circle = fitCircle(points);
    if (circle) {
        // Sweep: the angles the chain turns through about the centre.
        let sweep = 0;
        const loop = closed ? [...points, points[0]] : points;
        for (let i = 1; i < loop.length; i++) {
            sweep += angleBetween(sub(loop[i - 1], circle.centre), sub(loop[i], circle.centre));
        }
        const angle = closed ? 360 : Math.min(360, sweep);
        return {
            kind: closed ? 'circle' : 'arc', length: (circle.radius * angle * Math.PI) / 180, radius: circle.radius,
            centre: circle.centre, normal: circle.normal, angle, ...ends,
        };
    }
    return { kind: 'curve', length: chord, closed, ...ends };
}

// ---- Faces -------------------------------------------------------------------------------------------------

export interface FaceInfo {
    area: number;
    planar: boolean;
    normal: P3 | null;
    /** Area-weighted centre of the face's triangles. */
    centroid: P3;
    perimeter: number;
    /** Whether the perimeter is a chord sum along curved boundaries (else exact for straight edges and arcs). */
    perimeterApprox: boolean;
    /** B-rep edges that bound the face (ordinals), when they could be matched. */
    edges: number[];
}

/** Area, planarity, normal, centroid and perimeter of a face. */
export function analyseFace(mesh: MeasureMesh, face: number): FaceInfo {
    const tris = faceTriangles(mesh.indices, mesh.triFace, face);
    const area = faceArea(mesh.positions, mesh.indices, mesh.triFace, face);
    const { planar, normal } = facePlane(mesh.positions, mesh.indices, mesh.triFace, face);
    let centroid: P3 = [0, 0, 0];
    let weight = 0;
    // Boundary: triangle sides used once, after welding by position (seams of closed surfaces are used twice).
    const key = (p: P3) => p.map((v) => Math.round(v * 1e3)).join(',');
    const sides = new Map<string, { a: P3; b: P3; count: number }>();
    for (let t = 0; t < tris.length; t += 3) {
        const p = [0, 1, 2].map((k) => at(mesh.positions, tris[t + k] * 3)) as [P3, P3, P3];
        const w = len(cross(sub(p[1], p[0]), sub(p[2], p[0]))) / 2;
        centroid = add(centroid, scale(add(add(p[0], p[1]), p[2]), w / 3));
        weight += w;
        for (let k = 0; k < 3; k++) {
            const a = p[k];
            const b = p[(k + 1) % 3];
            const [ka, kb] = [key(a), key(b)];
            if (ka === kb) {
                continue;
            }
            const sideKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            const side = sides.get(sideKey);
            if (side) {
                side.count++;
            } else {
                sides.set(sideKey, { a, b, count: 1 });
            }
        }
    }
    centroid = weight > 0 ? scale(centroid, 1 / weight) : centroid;
    let chord = 0;
    const boundary = new Set<string>();
    for (const [k, side] of sides) {
        if (side.count === 1) {
            chord += dist(side.a, side.b);
            boundary.add(k);
        }
    }
    // Match B-rep edges whose segments all lie on the boundary, to measure arcs exactly.
    const byEdge = new Map<number, { on: number; total: number }>();
    for (let s = 0; s < mesh.segEdge.length; s++) {
        const [ka, kb] = [key(at(mesh.edges, s * 6)), key(at(mesh.edges, s * 6 + 3))];
        const entry = byEdge.get(mesh.segEdge[s]) ?? { on: 0, total: 0 };
        entry.total++;
        if (boundary.has(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`)) {
            entry.on++;
        }
        byEdge.set(mesh.segEdge[s], entry);
    }
    const edges = [...byEdge].filter(([, e]) => e.on === e.total).map(([edge]) => edge).sort((a, b) => a - b);
    const infos = edges.map((e) => analyseEdge(edgeSegments(mesh.edges, mesh.segEdge, e)));
    const matched = edges.reduce((s, edge) => s + chordOf(mesh, edge), 0);
    let perimeter = chord;
    let perimeterApprox = true;
    if (edges.length && Math.abs(matched - chord) <= Math.max(chord * 1e-3, 1e-4)) {
        perimeter = infos.reduce((s, info) => s + (info?.length ?? 0), 0);
        perimeterApprox = infos.some((info) => !info || info.kind === 'curve');
    }
    return { area, planar, normal, centroid, perimeter, perimeterApprox, edges };
}

function chordOf(mesh: MeasureMesh, edge: number): number {
    const segs = edgeSegments(mesh.edges, mesh.segEdge, edge);
    let total = 0;
    for (let s = 0; s + 5 < segs.length; s += 6) {
        total += dist(at(segs, s), at(segs, s + 3));
    }
    return total;
}

// ---- Minimum distance ----------------------------------------------------------------------------------------

/** Closest points between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function closestSegmentSegment(p1: P3, q1: P3, p2: P3, q2: P3): [P3, P3] {
    const d1 = sub(q1, p1);
    const d2 = sub(q2, p2);
    const r = sub(p1, p2);
    const a = dot(d1, d1);
    const e = dot(d2, d2);
    const f = dot(d2, r);
    let s: number;
    let t: number;
    if (a <= 1e-18 && e <= 1e-18) {
        return [p1, p2];
    }
    if (a <= 1e-18) {
        s = 0;
        t = clamp01(f / e);
    } else {
        const c = dot(d1, r);
        if (e <= 1e-18) {
            t = 0;
            s = clamp01(-c / a);
        } else {
            const b = dot(d1, d2);
            const denom = a * e - b * b;
            s = denom > 1e-18 * a * e ? clamp01((b * f - c * e) / denom) : 0;
            t = (b * s + f) / e;
            if (t < 0) {
                t = 0;
                s = clamp01(-c / a);
            } else if (t > 1) {
                t = 1;
                s = clamp01((b - c) / a);
            }
        }
    }
    return [add(p1, scale(d1, s)), add(p2, scale(d2, t))];
}

/** Closest point of triangle a-b-c to p (Ericson 5.1.5). */
export function closestPointTriangle(p: P3, a: P3, b: P3, c: P3): P3 {
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub(p, a);
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
    const cp = sub(p, c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
    const denom = 1 / (va + vb + vc);
    return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

/** Where segment p-q crosses triangle a-b-c, or null. */
function segmentHitsTriangle(p: P3, q: P3, a: P3, b: P3, c: P3): P3 | null {
    const d = sub(q, p);
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const h = cross(d, e2);
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-14) {
        return null;
    }
    const s = sub(p, a);
    const u = dot(s, h) / det;
    if (u < 0 || u > 1) return null;
    const qv = cross(s, e1);
    const v = dot(d, qv) / det;
    if (v < 0 || u + v > 1) return null;
    const t = dot(e2, qv) / det;
    return t >= 0 && t <= 1 ? add(p, scale(d, t)) : null;
}

/** A segment (two points) or a triangle (three). */
type Primitive = P3[];

function closestPrimitives(x: Primitive, y: Primitive): [P3, P3] {
    let best: [P3, P3] | null = null;
    let bestD = Infinity;
    const consider = (pair: [P3, P3]) => {
        const d = dist(pair[0], pair[1]);
        if (d < bestD) {
            bestD = d;
            best = pair;
        }
    };
    const sides = (prim: Primitive): [P3, P3][] => (prim.length === 2 ? [[prim[0], prim[1]]] : [[prim[0], prim[1]], [prim[1], prim[2]], [prim[2], prim[0]]]);
    // Crossings first: a side of one through the other triangle touches at distance 0.
    if (y.length === 3) {
        for (const [p, q] of sides(x)) {
            const hit = segmentHitsTriangle(p, q, y[0], y[1], y[2]);
            if (hit) return [hit, hit];
        }
    }
    if (x.length === 3) {
        for (const [p, q] of sides(y)) {
            const hit = segmentHitsTriangle(p, q, x[0], x[1], x[2]);
            if (hit) return [hit, hit];
        }
    }
    for (const s of sides(x)) {
        for (const t of sides(y)) {
            consider(closestSegmentSegment(s[0], s[1], t[0], t[1]));
        }
    }
    if (y.length === 3) {
        for (const p of x) consider([p, closestPointTriangle(p, y[0], y[1], y[2])]);
    }
    if (x.length === 3) {
        for (const p of y) consider([closestPointTriangle(p, x[0], x[1], x[2]), p]);
    }
    return best!;
}

function primitives(mesh: MeasureMesh, pick: MeasurePick): Primitive[] {
    if (pick.kind === 'edge') {
        const segs = edgeSegments(mesh.edges, mesh.segEdge, pick.index);
        const out: Primitive[] = [];
        for (let s = 0; s + 5 < segs.length; s += 6) {
            out.push([at(segs, s), at(segs, s + 3)]);
        }
        return out;
    }
    const tris = faceTriangles(mesh.indices, mesh.triFace, pick.index);
    const out: Primitive[] = [];
    for (let t = 0; t < tris.length; t += 3) {
        out.push([at(mesh.positions, tris[t] * 3), at(mesh.positions, tris[t + 1] * 3), at(mesh.positions, tris[t + 2] * 3)]);
    }
    return out;
}

/** Pair tests allowed before large sets are sampled. */
export const PAIR_BUDGET = 40_000;

export interface Separation {
    distance: number;
    /** Closest points on the first and second pick. */
    from: P3;
    to: P3;
    /** to - from. */
    delta: P3;
    /** The sets were sampled (large faces): close to, but not guaranteed to be, the minimum. */
    approx: boolean;
}

/**
 * Minimum distance between two sets of segments/triangles: brute force, or within `budget` pair tests by sampling
 * both sets evenly and then refining around the best pair with each full set.
 */
export function minimumDistance(a: Primitive[], b: Primitive[], budget = PAIR_BUDGET): Separation | null {
    if (!a.length || !b.length) {
        return null;
    }
    const sample = (list: Primitive[], n: number) => {
        if (list.length <= n) return list.map((_, i) => i);
        return Array.from({ length: n }, (_, k) => Math.floor((k * list.length) / n));
    };
    const sampled = a.length * b.length > budget;
    let na = Math.min(a.length, Math.max(1, Math.floor(Math.sqrt(budget))));
    const nb = Math.min(b.length, Math.max(1, Math.floor(budget / na)));
    na = Math.min(a.length, Math.max(na, Math.floor(budget / nb)));
    const ia = sample(a, na);
    const ib = sample(b, nb);
    let best = { i: ia[0], j: ib[0], pair: closestPrimitives(a[ia[0]], b[ib[0]]) };
    let bestD = dist(best.pair[0], best.pair[1]);
    const tryPair = (i: number, j: number) => {
        const pair = closestPrimitives(a[i], b[j]);
        const d = dist(pair[0], pair[1]);
        if (d < bestD) {
            bestD = d;
            best = { i, j, pair };
        }
    };
    for (const i of ia) {
        for (const j of ib) {
            tryPair(i, j);
        }
    }
    if (sampled) {
        // Refine: every primitive of A against the best of B, then every one of B against the new best of A.
        for (let round = 0; round < 2; round++) {
            const j = best.j;
            for (let i = 0; i < a.length; i++) tryPair(i, j);
            const i = best.i;
            for (let k = 0; k < b.length; k++) tryPair(i, k);
        }
    }
    const [from, to] = best.pair;
    return { distance: bestD, from, to, delta: sub(to, from), approx: sampled };
}

// ---- Measuring picks --------------------------------------------------------------------------------------------

export type Analysed =
    | { pick: MeasurePick; kind: 'edge'; edge: EdgeInfo }
    | { pick: MeasurePick; kind: 'face'; face: FaceInfo };

export interface PairMeasure {
    separation: Separation | null;
    /** Both picks are circles or arcs: distance between their centres. */
    centres?: { distance: number; delta: P3 };
    /** Degrees, 0..90, with what it is between. */
    angle?: { degrees: number; between: 'lines' | 'planes' | 'line and plane' };
    /** Both planar faces and parallel: the distance between their planes. */
    planeDistance?: number;
}

export function analysePick(mesh: MeasureMesh, pick: MeasurePick): Analysed | null {
    if (pick.kind === 'edge') {
        const edge = analyseEdge(edgeSegments(mesh.edges, mesh.segEdge, pick.index));
        return edge ? { pick, kind: 'edge', edge } : null;
    }
    const face = analyseFace(mesh, pick.index);
    return face.area > 0 ? { pick, kind: 'face', face } : null;
}

const PARALLEL_DEGREES = 0.05;

/** Distances and angle between two analysed picks. */
export function measurePair(mesh: MeasureMesh, a: Analysed, b: Analysed, budget = PAIR_BUDGET): PairMeasure {
    const out: PairMeasure = { separation: minimumDistance(primitives(mesh, a.pick), primitives(mesh, b.pick), budget) };
    const circle = (x: Analysed) => (x.kind === 'edge' && (x.edge.kind === 'circle' || x.edge.kind === 'arc') ? x.edge : null);
    const ca = circle(a);
    const cb = circle(b);
    if (ca && cb) {
        const delta = sub(cb.centre, ca.centre);
        out.centres = { distance: len(delta), delta };
    }
    const line = (x: Analysed) => (x.kind === 'edge' && x.edge.kind === 'line' ? x.edge.direction : null);
    const plane = (x: Analysed) => (x.kind === 'face' && x.face.planar ? x.face.normal : null);
    const [la, lb, pa, pb] = [line(a), line(b), plane(a), plane(b)];
    if (la && lb) {
        out.angle = { degrees: lineAngle(la, lb), between: 'lines' };
    } else if (pa && pb) {
        const degrees = lineAngle(pa, pb);
        out.angle = { degrees, between: 'planes' };
        if (degrees < PARALLEL_DEGREES && a.kind === 'face' && b.kind === 'face') {
            out.planeDistance = Math.abs(dot(sub(b.face.centroid, a.face.centroid), pa));
        }
    } else if ((la && pb) || (lb && pa)) {
        out.angle = { degrees: 90 - lineAngle((la ?? lb)!, (pb ?? pa)!), between: 'line and plane' };
    }
    return out;
}

// ---- Readout ------------------------------------------------------------------------------------------------

/** Up to three decimals, trailing zeros dropped; "-0" shown as 0. */
export function num(n: number, decimals = 3): string {
    const r = Number(n.toFixed(decimals));
    return String(Object.is(r, -0) ? 0 : r);
}

const mm = (n: number, approx = false) => `${approx ? '≈ ' : ''}${num(n)} mm`;
const point = (p: P3) => `${num(p[0])}, ${num(p[1])}, ${num(p[2])}`;
const direction = (p: P3) => `${num(p[0], 4)}, ${num(p[1], 4)}, ${num(p[2], 4)}`;

export interface MeasureSection {
    title: string;
    rows: [string, string][];
}

/** Display name of a pick, e.g. "Edge 3 · arc". */
export function pickTitle(item: Analysed): string {
    if (item.kind === 'edge') {
        return `Edge ${item.pick.index + 1} · ${item.edge.kind === 'curve' ? 'curve' : item.edge.kind}`;
    }
    return `Face ${item.pick.index + 1} · ${item.face.planar ? 'planar' : 'curved'}`;
}

function itemRows(item: Analysed): [string, string][] {
    if (item.kind === 'edge') {
        const e = item.edge;
        if (e.kind === 'line') {
            return [['Length', mm(e.length)], ['Direction', direction(e.direction)], ['Start', point(e.start)], ['End', point(e.end)]];
        }
        if (e.kind === 'curve') {
            return [['Length', mm(e.length, true)], ...(e.start && e.end ? [['Start', point(e.start)], ['End', point(e.end)]] as [string, string][] : [])];
        }
        return [
            ['Length', mm(e.length)],
            ['Radius', mm(e.radius)],
            ['Diameter', mm(e.radius * 2)],
            ['Centre', point(e.centre)],
            ['Axis', direction(e.normal)],
            ...(e.kind === 'arc' ? [['Arc angle', `${num(e.angle, 2)}°`]] as [string, string][] : []),
        ];
    }
    const f = item.face;
    return [
        ['Area', `${f.planar ? '' : '≈ '}${num(f.area, 2)} mm²`],
        ['Perimeter', mm(f.perimeter, f.perimeterApprox)],
        ...(f.normal ? [['Normal', direction(f.normal)]] as [string, string][] : []),
    ];
}

/** Readout sections for the picks: each pick, then the pair (two picks) or totals (more). */
export function measureSections(mesh: MeasureMesh, picks: MeasurePick[], budget = PAIR_BUDGET): MeasureSection[] {
    const items = picks.map((p) => analysePick(mesh, p)).filter((x): x is Analysed => !!x);
    const sections: MeasureSection[] = items.map((item) => ({ title: pickTitle(item), rows: itemRows(item) }));
    if (items.length === 2) {
        const pair = measurePair(mesh, items[0], items[1], budget);
        const rows: [string, string][] = [];
        const s = pair.separation;
        if (s) {
            rows.push(['Minimum distance', mm(s.distance, s.approx)]);
            rows.push(['dX, dY, dZ', `${num(s.delta[0])}, ${num(s.delta[1])}, ${num(s.delta[2])} mm`]);
        }
        if (pair.centres) {
            rows.push(['Centre to centre', mm(pair.centres.distance)]);
            rows.push(['Centres dX, dY, dZ', `${num(pair.centres.delta[0])}, ${num(pair.centres.delta[1])}, ${num(pair.centres.delta[2])} mm`]);
        }
        if (pair.planeDistance !== undefined) {
            rows.push(['Parallel planes, apart', mm(pair.planeDistance)]);
        }
        if (pair.angle) {
            rows.push([`Angle between ${pair.angle.between}`, `${num(pair.angle.degrees, 2)}°`]);
        }
        sections.push({ title: 'Between the two', rows });
    } else if (items.length > 2) {
        const edges = items.filter((i) => i.kind === 'edge') as Extract<Analysed, { kind: 'edge' }>[];
        const faces = items.filter((i) => i.kind === 'face') as Extract<Analysed, { kind: 'face' }>[];
        const rows: [string, string][] = [];
        if (edges.length) {
            rows.push([`Total length (${edges.length} edges)`, mm(edges.reduce((t, e) => t + e.edge.length, 0), edges.some((e) => e.edge.kind === 'curve'))]);
        }
        if (faces.length) {
            rows.push([`Total area (${faces.length} faces)`, `${faces.some((f) => !f.face.planar) ? '≈ ' : ''}${num(faces.reduce((t, f) => t + f.face.area, 0), 2)} mm²`]);
        }
        rows.push(['Distances', 'pick two items']);
        sections.push({ title: 'Totals', rows });
    }
    return sections;
}

/** The readout as plain text, for the clipboard. */
export function sectionsText(sections: MeasureSection[]): string {
    return sections.map((s) => [s.title, ...s.rows.map(([k, v]) => `  ${k}: ${v}`)].join('\n')).join('\n');
}
