// Picks stored on features (see apps/server/src/cad/refs.ts) from what is clicked on a kernel mesh, and back; plus
// the position a tool should take from a click (a hole's centre, a line's midpoint, a vertex). Plain arrays in,
// plain numbers out, all in the part's own frame. Edge and face ordinals as in picking.ts.

import { nearestEdge, type P3 } from './picking';

export interface FacePickRef {
    at: P3;
    normal?: P3;
}

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
const at3 = (a: ArrayLike<number>, i: number): P3 => [a[i], a[i + 1], a[i + 2]];

/** Points of an edge polyline closer than this are the same point. */
const SAME = 1e-4;

/**
 * The edge's segments chained into one ordered polyline (first point = last point for a closed edge), or [] when
 * the edge has no segments.
 */
export function edgePolyline(edges: ArrayLike<number>, segEdge: ArrayLike<number>, edge: number): P3[] {
    const segs: [P3, P3][] = [];
    for (let s = 0; s < segEdge.length; s++) {
        if (segEdge[s] === edge) {
            segs.push([at3(edges, s * 6), at3(edges, s * 6 + 3)]);
        }
    }
    if (segs.length === 0) {
        return [];
    }
    const key = (p: P3): string => p.map((v) => Math.round(v / SAME)).join(',');
    const touching = new Map<string, number[]>();
    segs.forEach(([a, b], i) => {
        for (const p of [a, b]) {
            const k = key(p);
            touching.set(k, [...(touching.get(k) ?? []), i]);
        }
    });
    // Start an open edge at an end (a point used once); a closed one anywhere.
    let start = segs[0][0];
    for (const [a, b] of segs) {
        if (touching.get(key(a))!.length === 1) {
            start = a;
            break;
        }
        if (touching.get(key(b))!.length === 1) {
            start = b;
            break;
        }
    }
    const used = new Set<number>();
    const out: P3[] = [start];
    let current = start;
    while (used.size < segs.length) {
        const next = (touching.get(key(current)) ?? []).find((i) => !used.has(i));
        if (next === undefined) {
            // Disconnected pieces (not expected for one B-rep edge): continue from any unused segment.
            const i = segs.findIndex((_, k) => !used.has(k));
            used.add(i);
            out.push(segs[i][0], segs[i][1]);
            current = segs[i][1];
            continue;
        }
        used.add(next);
        const [a, b] = segs[next];
        current = key(a) === key(current) ? b : a;
        out.push(current);
    }
    return out;
}

const isClosed = (points: P3[]): boolean => points.length > 2 && dist(points[0], points[points.length - 1]) < SAME;

function polylineLength(points: P3[]): number {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
        length += dist(points[i - 1], points[i]);
    }
    return length;
}

/** The point at `fraction` of the polyline's arc length. */
function pointAlong(points: P3[], fraction: number): P3 {
    let remaining = polylineLength(points) * fraction;
    for (let i = 1; i < points.length; i++) {
        const step = dist(points[i - 1], points[i]);
        if (remaining <= step && step > 0) {
            return add(points[i - 1], scale(sub(points[i], points[i - 1]), remaining / step));
        }
        remaining -= step;
    }
    return points[points.length - 1];
}

/** Closest point to p on segment a-b, and its parameter along it. */
function closestOnSegment(p: P3, a: P3, b: P3): { point: P3; t: number } {
    const d = sub(b, a);
    const l2 = dot(d, d);
    const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), d) / l2)) : 0;
    return { point: add(a, scale(d, t)), t };
}

// ---- Edges --------------------------------------------------------------------------------------------------

/** A point on the edge at half its arc length (the kernel resolves it back to the edge), or null for no edge. */
export function edgePick(edges: ArrayLike<number>, segEdge: ArrayLike<number>, edge: number): P3 | null {
    const points = edgePolyline(edges, segEdge, edge);
    return points.length > 0 ? pointAlong(points, 0.5) : null;
}

/** The edge of the current mesh that a stored edge pick refers to, or null. */
export function edgeOfPick(edges: ArrayLike<number>, segEdge: ArrayLike<number>, point: P3, tolerance: number): number | null {
    return nearestEdge(edges, segEdge, point, tolerance);
}

/** Tolerance for fitting a polyline of this size: tessellation points lie on the curve, up to float32 rounding. */
const fitTolerance = (extent: number): number => Math.max(1e-4, extent * 1e-3);

/**
 * If the edge is a circle or a circular arc (planar, all points at one distance from a fitted centre): its centre,
 * unit normal (by the polyline's direction of travel), radius and whether it is a full circle. Else null.
 */
export function circleOfEdge(edges: ArrayLike<number>, segEdge: ArrayLike<number>, edge: number):
    { centre: P3; normal: P3; radius: number; full: boolean } | null {
    const polyline = edgePolyline(edges, segEdge, edge);
    const full = isClosed(polyline);
    const points = full ? polyline.slice(0, -1) : polyline;
    if (points.length < 3) {
        return null;
    }
    const centroid = scale(points.reduce(add, [0, 0, 0] as P3), 1 / points.length);
    const extent = Math.max(...points.map((p) => dist(p, centroid)));
    const tol = fitTolerance(extent);
    // Newell's normal of the polygon (closed by its chord): zero for collinear points.
    let n: P3 = [0, 0, 0];
    for (let i = 0; i < points.length; i++) {
        n = add(n, cross(sub(points[i], centroid), sub(points[(i + 1) % points.length], centroid)));
    }
    if (len(n) < tol * extent) {
        return null;
    }
    const normal = unit(n);
    if (points.some((p) => Math.abs(dot(sub(p, centroid), normal)) > tol)) {
        return null;
    }
    // Circle fit in the plane (Kasa: x² + y² + D x + E y + F = 0, least squares), coordinates about the centroid.
    const u = unit(sub(points.find((p) => dist(p, centroid) > tol) ?? points[0], centroid));
    const v = cross(normal, u);
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const r = [0, 0, 0];
    for (const p of points) {
        const x = dot(sub(p, centroid), u);
        const y = dot(sub(p, centroid), v);
        const row = [x, y, 1];
        const rhs = -(x * x + y * y);
        for (let i = 0; i < 3; i++) {
            r[i] += row[i] * rhs;
            for (let j = 0; j < 3; j++) {
                m[i][j] += row[i] * row[j];
            }
        }
    }
    const det3 = (a: number[][]): number => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const det = det3(m);
    if (Math.abs(det) < 1e-18) {
        return null;
    }
    const solve = (k: number): number => det3(m.map((row, i) => row.map((value, j) => (j === k ? r[i] : value)))) / det;
    const [D, E, F] = [solve(0), solve(1), solve(2)];
    const cx = -D / 2;
    const cy = -E / 2;
    const r2 = cx * cx + cy * cy - F;
    if (!(r2 > 0)) {
        return null;
    }
    const radius = Math.sqrt(r2);
    const centre = add(centroid, add(scale(u, cx), scale(v, cy)));
    if (points.some((p) => Math.abs(dist(p, centre) - radius) > fitTolerance(radius))) {
        return null;
    }
    return { centre, normal, radius, full };
}

/** If the edge is straight: its ends, midpoint and unit direction (a to b). Else null. */
export function lineOfEdge(edges: ArrayLike<number>, segEdge: ArrayLike<number>, edge: number):
    { a: P3; b: P3; mid: P3; direction: P3 } | null {
    const points = edgePolyline(edges, segEdge, edge);
    if (points.length < 2 || isClosed(points)) {
        return null;
    }
    const a = points[0];
    const b = points[points.length - 1];
    const length = dist(a, b);
    if (!(length > SAME)) {
        return null;
    }
    const tol = fitTolerance(length);
    if (points.some((p) => dist(p, closestOnSegment(p, a, b).point) > tol)) {
        return null;
    }
    return { a, b, mid: scale(add(a, b), 0.5), direction: unit(sub(b, a)) };
}

/** The edge's two end points, or null for a closed (or missing) edge. */
export function edgeEnds(edges: ArrayLike<number>, segEdge: ArrayLike<number>, edge: number): [P3, P3] | null {
    const points = edgePolyline(edges, segEdge, edge);
    if (points.length < 2 || isClosed(points)) {
        return null;
    }
    return [points[0], points[points.length - 1]];
}

/** The edge end point (a B-rep vertex) nearest to `point` within `tolerance`, or null. */
export function nearestVertex(edges: ArrayLike<number>, segEdge: ArrayLike<number>, point: P3, tolerance: number): P3 | null {
    const ordinals = new Set<number>();
    for (let s = 0; s < segEdge.length; s++) {
        ordinals.add(segEdge[s]);
    }
    let best: P3 | null = null;
    let nearest = tolerance;
    for (const edge of ordinals) {
        for (const end of edgeEnds(edges, segEdge, edge) ?? []) {
            const d = dist(end, point);
            if (d <= nearest) {
                nearest = d;
                best = end;
            }
        }
    }
    return best;
}

// ---- Faces --------------------------------------------------------------------------------------------------

/**
 * A point well inside the face (the centroid of its largest triangle) and the unit normal there (the vertex
 * normals interpolated, else the triangle's winding normal). Null when the face has no triangles.
 */
export function facePick(positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>,
    triFace: ArrayLike<number>, face: number): FacePickRef | null {
    let best = -1;
    let bestArea = -1;
    for (let t = 0; t < triFace.length; t++) {
        if (triFace[t] !== face) {
            continue;
        }
        const [a, b, c] = [0, 1, 2].map((k) => at3(positions, indices[t * 3 + k] * 3));
        const area = len(cross(sub(b, a), sub(c, a)));
        if (area > bestArea) {
            bestArea = area;
            best = t;
        }
    }
    if (best < 0) {
        return null;
    }
    const corners = [0, 1, 2].map((k) => indices[best * 3 + k] * 3);
    const [a, b, c] = corners.map((i) => at3(positions, i));
    const at = scale(add(add(a, b), c), 1 / 3);
    let normal = unit(corners.map((i) => at3(normals, i)).reduce(add, [0, 0, 0] as P3));
    if (len(normal) === 0) {
        normal = unit(cross(sub(b, a), sub(c, a)));
    }
    return { at, normal };
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: P3, a: P3, b: P3, c: P3): P3 {
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = sub(p, b);
    const d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
    const cp = sub(p, c);
    const d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
    }
    const denom = 1 / (va + vb + vc);
    return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

/**
 * The face of the current mesh that a stored face pick refers to: the face of the nearest triangle within
 * `tolerance`; between equally near faces (a pick on a shared edge) the one whose normal matches the pick's.
 */
export function faceOfPick(positions: ArrayLike<number>, indices: ArrayLike<number>, triFace: ArrayLike<number>,
    pick: FacePickRef, tolerance: number): number | null {
    const found: { t: number; d: number }[] = [];
    let nearest = Infinity;
    for (let t = 0; t < triFace.length; t++) {
        const [a, b, c] = [0, 1, 2].map((k) => at3(positions, indices[t * 3 + k] * 3));
        const d = dist(pick.at, closestOnTriangle(pick.at, a, b, c));
        if (d <= tolerance) {
            found.push({ t, d });
            nearest = Math.min(nearest, d);
        }
    }
    const tie = Math.max(1e-4, tolerance * 1e-3);
    const candidates = found.filter((f) => f.d <= nearest + tie);
    if (candidates.length === 0) {
        return null;
    }
    if (!pick.normal) {
        return triFace[candidates[0].t];
    }
    const wanted = unit(pick.normal);
    let best = candidates[0].t;
    let score = -Infinity;
    for (const { t } of candidates) {
        const [a, b, c] = [0, 1, 2].map((k) => at3(positions, indices[t * 3 + k] * 3));
        const s = dot(unit(cross(sub(b, a), sub(c, a))), wanted);
        if (s > score) {
            score = s;
            best = t;
        }
    }
    return triFace[best];
}

// ---- Positions from a click ---------------------------------------------------------------------------------

export interface PickPosition {
    position: P3;
    normal?: P3;
    radius?: number;
}

/**
 * Where a tool should go for what was clicked: a vertex at itself; a circle or arc at its centre (with its normal
 * and radius); a straight edge at its midpoint when the click is within 10% of the length from the middle, else
 * at the click projected onto it; another curve at its nearest point to the click; a face at the click (with the
 * face normal).
 */
export function positionFromPick(kind: 'vertex', data: { point: P3 }): PickPosition;
export function positionFromPick(kind: 'edge',
    data: { edges: ArrayLike<number>; segEdge: ArrayLike<number>; edge: number; point: P3 }): PickPosition;
export function positionFromPick(kind: 'face', data: { point: P3; normal?: P3 }): PickPosition;
export function positionFromPick(kind: 'vertex' | 'edge' | 'face', data: {
    point: P3; normal?: P3; edges?: ArrayLike<number>; segEdge?: ArrayLike<number>; edge?: number;
}): PickPosition {
    const { point } = data;
    if (kind === 'vertex') {
        return { position: point };
    }
    if (kind === 'face') {
        return data.normal ? { position: point, normal: unit(data.normal) } : { position: point };
    }
    const edges = data.edges!;
    const segEdge = data.segEdge!;
    const edge = data.edge!;
    const circle = circleOfEdge(edges, segEdge, edge);
    if (circle) {
        return { position: circle.centre, normal: circle.normal, radius: circle.radius };
    }
    const line = lineOfEdge(edges, segEdge, edge);
    if (line) {
        const { point: projected, t } = closestOnSegment(point, line.a, line.b);
        return { position: Math.abs(t - 0.5) <= 0.1 ? line.mid : projected };
    }
    const polyline = edgePolyline(edges, segEdge, edge);
    let best = point;
    let nearest = Infinity;
    for (let i = 1; i < polyline.length; i++) {
        const q = closestOnSegment(point, polyline[i - 1], polyline[i]).point;
        const d = dist(q, point);
        if (d < nearest) {
            nearest = d;
            best = q;
        }
    }
    return { position: best };
}
