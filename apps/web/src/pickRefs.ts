// Picks stored on features (see apps/server/src/cad/refs.ts) from what is clicked on a kernel mesh, and back; plus
// the position a tool should take from a click (a hole's centre, a line's midpoint, a vertex). Plain arrays in,
// plain numbers out, all in the part's own frame. Edge and face ordinals as in picking.ts.

import type { ModelEntityPick } from '@jarvis/core';
import { facePlane, nearestEdge, type P3 } from './picking';

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

// ---- Reference geometry from a click: what the Plane, Axis and Point forms take from the model, by value -------

/**
 * The geometry of a picked entity as it is now: a flat face's plane (outward normal), a cylindrical or conical
 * face's axis (and a cylinder's radius), a straight edge's ends, a circular edge's circle (with the arc's ends), a
 * vertex. Other faces and curves are `surface` / `curve`: they have no plane or axis.
 */
export type ModelGeom =
    | { type: 'plane'; origin: P3; normal: P3 }
    | { type: 'cylinder'; point: P3; direction: P3; radius: number }
    | { type: 'cone'; point: P3; direction: P3 }
    | { type: 'surface' }
    | { type: 'line'; a: P3; b: P3 }
    | { type: 'circle'; centre: P3; normal: P3; radius: number; full: boolean; start: P3; end: P3 }
    | { type: 'curve' }
    | { type: 'vertex'; at: P3 };

export interface ModelPick {
    geom: ModelGeom;
    /** Where it was clicked (part frame). */
    click: P3;
    /** A face's centre: the area centroid of its triangles. */
    centre?: P3;
    /** An edge's or a vertex's faces (a point inside each, near it, and its outward normal), so the kernel can follow it. */
    faces?: FacePickRef[];
    /** A stored step's own pick, kept when the step is saved again without picking anew (see referenceDefs.ts). */
    pick?: ModelEntityPick;
    /** An older step's reference kept by value: it does not follow the model. */
    fixed?: boolean;
}

/**
 * Coordinates from the float32 mesh to 1e-5 mm, ten times finer than the finest value the app shows, so a face at
 * y = 10 gives 10 and not 9.9999995.
 */
const clean = (p: P3): P3 => p.map((c) => Math.round(c * 1e5) / 1e5 + 0) as P3;
const cleanLength = (l: number): number => Math.round(l * 1e5) / 1e5;
/** A unit direction with float noise on near-zero components removed (a face facing +Y gives exactly [0, 1, 0]). */
const cleanDir = (d: P3): P3 => unit(d.map((c) => (Math.abs(c) < 1e-6 ? 0 : c)) as P3);

function faceTriangleList(positions: ArrayLike<number>, indices: ArrayLike<number>, triFace: ArrayLike<number>, face: number): [P3, P3, P3][] {
    const out: [P3, P3, P3][] = [];
    for (let t = 0; t < triFace.length; t++) {
        if (triFace[t] === face) {
            out.push([0, 1, 2].map((k) => at3(positions, indices[t * 3 + k] * 3)) as [P3, P3, P3]);
        }
    }
    return out;
}

/** Area centroid of a face's triangles. */
export function faceCentre(positions: ArrayLike<number>, indices: ArrayLike<number>, triFace: ArrayLike<number>, face: number): P3 | null {
    let area = 0;
    let sum: P3 = [0, 0, 0];
    for (const [a, b, c] of faceTriangleList(positions, indices, triFace, face)) {
        const w = len(cross(sub(b, a), sub(c, a))) / 2;
        area += w;
        sum = add(sum, scale(add(add(a, b), c), w / 3));
    }
    return area > 0 ? scale(sum, 1 / area) : null;
}

/** Edges that run along the face's boundary (their ends and middle lie on its triangles). */
function boundaryEdges(tris: [P3, P3, P3][], edges: ArrayLike<number>, segEdge: ArrayLike<number>, tolerance: number): number[] {
    const onFace = (p: P3) => tris.some(([a, b, c]) => dist(p, closestOnTriangle(p, a, b, c)) <= tolerance);
    const ordinals = new Set<number>();
    for (let i = 0; i < segEdge.length; i++) {
        ordinals.add(segEdge[i]);
    }
    return [...ordinals].filter((edge) => {
        const points = edgePolyline(edges, segEdge, edge);
        return points.length > 1 && onFace(points[0]) && onFace(points[points.length - 1]) && onFace(pointAlong(points, 0.5));
    });
}

const det3 = (a: number[][]): number => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
    - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);

/** Solves the 3x3 system m x = r (Cramer), or null when singular. */
function solve3(m: number[][], r: number[]): P3 | null {
    const d = det3(m);
    if (!(Math.abs(d) > 1e-300)) {
        return null;
    }
    return [0, 1, 2].map((k) => det3(m.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)))) / d) as P3;
}

/** A cylinder fitted to vertices and their normals (all perpendicular to its axis); null when they do not say. */
function cylinderFromNormals(points: P3[], normals: P3[]): { point: P3; direction: P3 } | null {
    const ns = normals.map(unit);
    let seed: P3 = [0, 0, 0];
    for (const n of ns) {
        const c = cross(ns[0], n);
        if (len(c) > len(seed)) {
            seed = c;
        }
    }
    if (len(seed) < 1e-6) {
        return null;
    }
    // Smallest eigenvector of the normals' scatter, by inverse iteration from the cross product of two of them.
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const n of ns) {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                m[i][j] += n[i] * n[j] + (i === j ? 1e-12 : 0);
            }
        }
    }
    let direction = unit(seed);
    for (let k = 0; k < 4; k++) {
        const next = solve3(m, direction);
        if (!next) {
            break;
        }
        direction = unit(next);
    }
    // p = c + r n across the axis: unknowns c (two coordinates in u, v) and r, by least squares.
    const u = unit(Math.abs(direction[0]) < 0.9 ? cross(direction, [1, 0, 0]) : cross(direction, [0, 1, 0]));
    const v = cross(direction, u);
    const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    points.forEach((p, i) => {
        const rows = [[1, 0, dot(ns[i], u)], [0, 1, dot(ns[i], v)]];
        const rhs = [dot(p, u), dot(p, v)];
        rows.forEach((row, k) => {
            for (let r = 0; r < 3; r++) {
                b[r] += row[r] * rhs[k];
                for (let c = 0; c < 3; c++) {
                    a[r][c] += row[r] * row[c];
                }
            }
        });
    });
    const fit = solve3(a, b);
    return fit ? { point: add(scale(u, fit[0]), scale(v, fit[1])), direction } : null;
}

/**
 * The axis of a face of revolution: through the centres of its circular boundary edges (two distinct centres give
 * the direction, else the circle's normal); without circles, a cylinder fitted to the vertex normals. Then every
 * vertex is checked: a constant distance from the axis is a cylinder (radius given), one changing linearly along
 * it a cone (radius null). Null for any other face.
 */
export function revolutionOfFace(positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>,
    triFace: ArrayLike<number>, face: number, edges: ArrayLike<number>, segEdge: ArrayLike<number>):
    { point: P3; direction: P3; radius: number | null } | null {
    const used = new Set<number>();
    for (let t = 0; t < triFace.length; t++) {
        if (triFace[t] === face) {
            for (let k = 0; k < 3; k++) {
                used.add(indices[t * 3 + k]);
            }
        }
    }
    const vertices = [...used].map((i) => at3(positions, i * 3));
    if (vertices.length < 4) {
        return null;
    }
    const centroid = scale(vertices.reduce(add, [0, 0, 0] as P3), 1 / vertices.length);
    const tol = fitTolerance(Math.max(...vertices.map((p) => dist(p, centroid))));
    const tris = faceTriangleList(positions, indices, triFace, face);
    const circles = boundaryEdges(tris, edges, segEdge, tol)
        .map((e) => circleOfEdge(edges, segEdge, e)).filter((c): c is NonNullable<typeof c> => !!c);
    let axis: { point: P3; direction: P3 } | null;
    if (circles.length > 0) {
        const point = circles[0].centre;
        const other = circles.find((c) => dist(c.centre, point) > tol);
        axis = { point, direction: other ? unit(sub(other.centre, point)) : circles[0].normal };
    } else {
        axis = cylinderFromNormals(vertices, [...used].map((i) => at3(normals, i * 3)));
    }
    if (!axis) {
        return null;
    }
    const { point, direction } = axis;
    const samples = vertices.map((p) => {
        const rel = sub(p, point);
        const h = dot(rel, direction);
        return { h, r: len(sub(rel, scale(direction, h))) };
    });
    const mean = samples.reduce((s, q) => s + q.r, 0) / samples.length;
    if (mean > tol && samples.every((q) => Math.abs(q.r - mean) <= fitTolerance(mean))) {
        return { point, direction, radius: mean };
    }
    const low = samples.reduce((m, q) => (q.h < m.h ? q : m));
    const high = samples.reduce((m, q) => (q.h > m.h ? q : m));
    if (high.h - low.h > tol) {
        const slope = (high.r - low.r) / (high.h - low.h);
        if (Math.abs(slope) > 1e-3 && samples.every((q) => Math.abs(low.r + slope * (q.h - low.h) - q.r) <= tol)) {
            return { point, direction, radius: null };
        }
    }
    return null;
}

/** The mesh arrays modelPick reads (as pickField's PickMesh). */
interface MeshArrays {
    positions: ArrayLike<number>;
    normals: ArrayLike<number>;
    indices: ArrayLike<number>;
    triFace: ArrayLike<number>;
    edges: ArrayLike<number>;
    segEdge: ArrayLike<number>;
}

/**
 * The faces that meet at the given points (all of them on each face's triangles): for each, a point inside it on the
 * triangle nearest the points' middle, and its outward normal there. How the kernel finds an edge or a vertex again
 * when it has moved with its faces.
 */
export function facesAt(mesh: MeshArrays, points: P3[]): FacePickRef[] {
    const { positions, normals, indices, triFace } = mesh;
    if (points.length === 0) {
        return [];
    }
    const middle = scale(points.reduce(add, [0, 0, 0] as P3), 1 / points.length);
    const size = Math.max(1, ...points.map((p) => len(p)));
    const tol = Math.max(1e-3, size * 1e-5);
    // Per face: whether each point lies on it, and its triangle nearest the middle.
    const faces = new Map<number, { on: boolean[]; best: number; d: number }>();
    for (let t = 0; t < triFace.length; t++) {
        const [a, b, c] = [0, 1, 2].map((k) => at3(positions, indices[t * 3 + k] * 3));
        const face = triFace[t];
        let entry = faces.get(face);
        const hits = points.map((p) => dist(p, closestOnTriangle(p, a, b, c)) <= tol);
        if (!entry && !hits.some(Boolean)) {
            continue;
        }
        if (!entry) {
            entry = { on: points.map(() => false), best: -1, d: Infinity };
            faces.set(face, entry);
        }
        hits.forEach((hit, i) => {
            entry!.on[i] ||= hit;
        });
        const d = dist(middle, closestOnTriangle(middle, a, b, c));
        if (d < entry.d) {
            entry.d = d;
            entry.best = t;
        }
    }
    const out: FacePickRef[] = [];
    for (const entry of faces.values()) {
        if (!entry.on.every(Boolean) || entry.best < 0) {
            continue;
        }
        const corners = [0, 1, 2].map((k) => indices[entry.best * 3 + k] * 3);
        const [a, b, c] = corners.map((i) => at3(positions, i));
        const winding = unit(cross(sub(b, a), sub(c, a)));
        const smooth = unit(corners.map((i) => at3(normals, i)).reduce(add, [0, 0, 0] as P3));
        const normal = len(smooth) > 0 ? smooth : winding;
        out.push({ at: clean(scale(add(add(a, b), c), 1 / 3)), normal: cleanDir(normal) });
    }
    return out;
}

/** Points along an edge that tell its faces apart from others: its ends and middle (a third and two thirds round a closed one). */
function edgeSamples(points: P3[]): P3[] {
    if (points.length < 2) {
        return points;
    }
    return isClosed(points) ? [pointAlong(points, 0), pointAlong(points, 1 / 3), pointAlong(points, 2 / 3)]
        : [points[0], pointAlong(points, 0.5), points[points.length - 1]];
}

/** What a click on a face, an edge or a vertex (`at`: its position) gives the reference forms. */
export function modelPick(mesh: MeshArrays, entity: { kind: 'edge' | 'face'; index: number } | { kind: 'vertex'; at: P3 }, click: P3): ModelPick | null {
    const { positions, normals, indices, triFace, edges, segEdge } = mesh;
    if (entity.kind === 'vertex') {
        return { geom: { type: 'vertex', at: clean(entity.at) }, click, faces: facesAt(mesh, [entity.at]) };
    }
    if (entity.kind === 'edge') {
        const points = edgePolyline(edges, segEdge, entity.index);
        const faces = facesAt(mesh, edgeSamples(points));
        const circle = circleOfEdge(edges, segEdge, entity.index);
        if (circle) {
            return {
                geom: {
                    type: 'circle', centre: clean(circle.centre), normal: cleanDir(circle.normal), radius: cleanLength(circle.radius),
                    full: circle.full, start: clean(points[0]), end: clean(points[points.length - 1]),
                },
                click,
                faces,
            };
        }
        const line = lineOfEdge(edges, segEdge, entity.index);
        return { geom: line ? { type: 'line', a: clean(line.a), b: clean(line.b) } : { type: 'curve' }, click, faces };
    }
    const centre = faceCentre(positions, indices, triFace, entity.index);
    if (!centre) {
        return null;
    }
    const flat = facePlane(positions, indices, triFace, entity.index);
    if (flat.planar && flat.normal) {
        // Outward as the vertex normals say (the winding normal normally agrees).
        const ref = facePick(positions, normals, indices, triFace, entity.index);
        const normal = ref?.normal && dot(ref.normal, flat.normal) < 0 ? scale(flat.normal, -1) : flat.normal;
        return { geom: { type: 'plane', origin: clean(centre), normal: cleanDir(normal) }, click, centre: clean(centre) };
    }
    const axis = revolutionOfFace(positions, normals, indices, triFace, entity.index, edges, segEdge);
    if (!axis) {
        return { geom: { type: 'surface' }, click, centre: clean(centre) };
    }
    // The axis point level with the face centre, so the axis is drawn by the face.
    const point = clean(add(axis.point, scale(axis.direction, dot(sub(centre, axis.point), axis.direction))));
    const direction = cleanDir(axis.direction);
    return {
        geom: axis.radius === null ? { type: 'cone', point, direction } : { type: 'cylinder', point, direction, radius: cleanLength(axis.radius) },
        click,
        centre: clean(centre),
    };
}

/** The end of an edge within `tolerance` of the click, or null: a click there picks the vertex. */
export function vertexAtClick(edges: ArrayLike<number>, segEdge: ArrayLike<number>, edge: number, click: P3, tolerance: number): P3 | null {
    const ends = edgeEnds(edges, segEdge, edge);
    if (!ends) {
        return null;
    }
    const [a, b] = ends;
    const da = dist(a, click);
    const db = dist(b, click);
    return Math.min(da, db) <= tolerance ? (da <= db ? a : b) : null;
}
