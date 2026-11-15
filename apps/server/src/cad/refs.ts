// Picked references (edges, faces, vertices) stored as pick points in the part frame, resolved against the body as
// it is at a build step: the nearest entity within a tolerance, else a clear "pick it again" error. Kernel only.
//
// Integration (suggested; packages/core and build.ts are not edited here):
//
//   type FacePickRef = { at: Vec3; normal?: Vec3 };
//   fillet:  { op: 'fillet'; radius: number; edges?: EdgeSelect; at?: Vec3[]; faces?: FacePickRef[]; tangent?: boolean;
//              radius2?: number }                       // radius2: variable radius, start -> end of each edge
//   chamfer: { op: 'chamfer'; size: number; edges?: EdgeSelect; at?: Vec3[]; faces?: FacePickRef[]; tangent?: boolean;
//              distance2?: number; angle?: number; side?: Vec3 }
//   shell:   { op: 'shell'; thickness: number; open?: FaceSelect[]; remove?: FacePickRef[]; outward?: boolean }
//   draft:   { op: 'draft'; faces?: FaceSelect[]; picked?: FacePickRef[]; angle: number; neutral?: PlaneRef;
//              neutralFace?: FacePickRef; flip?: boolean; tangent?: boolean }
//
// build.ts, per case (picks win over the group/side selectors when present):
//
//   case 'fillet': if (f.at?.length || f.faces?.length) {
//       const edges = [...resolveEdges(shape, f.at ?? [], { tangent: f.tangent }),
//           ...resolveFaces(shape, f.faces ?? [], { tangent: f.tangent }).flatMap((face) => face.edges)];
//       return filletEdges(shape, edges, f.radius2 !== undefined ? { radii: [f.radius, f.radius2] } : { radius: f.radius });
//   }
//   case 'chamfer': same edges; spec = f.angle !== undefined ? { distance: f.size, angle: f.angle, side: f.side }
//       : f.distance2 !== undefined ? { distances: [f.size, f.distance2], side: f.side } : { distance: f.size };
//       return chamferEdges(shape, edges, spec);
//   case 'shell': if (f.remove || f.outward) return shellFaces(shape, f.thickness, resolveFaces(shape, f.remove ?? []),
//       { outward: f.outward });
//   draft: if (f.picked?.length) {
//       const faces = resolveFaces(shape, f.picked, { tangent: f.tangent });
//       const neutral = f.neutralFace
//           ? planeOfFace(resolveFaces(shape, [f.neutralFace])[0], f.neutralFace.at)
//           : resolvePlane(f.neutral, before(state), 'neutral plane');   // { origin, normal, ... }
//       return draftFaces(shape, faces, f.angle, neutral, { flip: f.flip });
//   }

import { getOC, iterTopo, makeVertex, Vertex, type Edge, type Face, type Shape3D } from 'replicad';
import type { Vec3 } from '@jarvis/core';

export interface FacePick {
    at: Vec3;
    /** Outward unit normal at `at` when picked; decides between equally near faces (a pick on a shared edge). */
    normal?: Vec3;
}

export interface ResolveOptions {
    /** Largest pick-to-entity distance in mm (default 0.5); capped at 5% of the body's diagonal. */
    tolerance?: number;
    /** Extend each result along its tangent chain (edges) or smoothly joined neighbours (faces). */
    tangent?: boolean;
}

const DEFAULT_TOLERANCE = 0.5;
/** Two picks closer than this to two faces count as equally near. */
const TIE = 1e-3;
/** Points closer than this are the same vertex. */
const SAME_POINT = 1e-3;
/** cos(1°): tangent directions / normals within a degree count as smooth. */
const SMOOTH_COS = Math.cos(Math.PI / 180);

type V = [number, number, number];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V): V => {
    const l = Math.hypot(...a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const dist = (a: V, b: V): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (mm: number): string => (Number.isFinite(mm) ? `${Math.round(mm * 10) / 10} mm` : 'no entity');

/** The effective tolerance for a body: the requested one, but at most 5% of its diagonal. */
export function pickTolerance(shape: Shape3D, tolerance = DEFAULT_TOLERANCE): number {
    const box = shape.boundingBox;
    const [lo, hi] = box.bounds;
    box.delete();
    const diagonal = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    return Math.min(tolerance, Math.max(1e-3, diagonal * 0.05));
}

/** True distances from a point to each shape (BRepExtrema: to the bounded edge or face, not just its ends). */
function distancesTo(point: Vec3, shapes: { wrapped: unknown }[]): number[] {
    const oc = getOC();
    const vertex = makeVertex(point);
    const tool = new oc.BRepExtrema_DistShapeShape();
    try {
        tool.LoadS1(vertex.wrapped);
        return shapes.map((s) => {
            tool.LoadS2(s.wrapped as Parameters<typeof tool.LoadS2>[0]);
            return tool.Perform() && tool.IsDone() ? tool.Value() : Infinity;
        });
    } finally {
        tool.delete();
        vertex.delete();
    }
}

/** True distance from a point to a shape (0 on its surface; for a solid, to its boundary or inside). */
export function distanceToShape(point: Vec3, shape: { wrapped: unknown }): number {
    return distancesTo(point, [shape])[0];
}

function vecOf(v: { x: number; y: number; z: number; delete(): void }): V {
    const out: V = [v.x, v.y, v.z];
    v.delete();
    return out;
}

function uniqueBySame<T extends { isSame(other: never): boolean }>(items: T[]): T[] {
    const out: T[] = [];
    for (const item of items) {
        if (!out.some((o) => (o.isSame as (x: T) => boolean)(item))) {
            out.push(item);
        }
    }
    return out;
}

// ---- Edges --------------------------------------------------------------------------------------------------

interface EdgeEnd {
    point: V;
    /** Unit tangent pointing away from the edge at this end (outwards). */
    out: V;
}

function edgeEnds(edge: Edge): EdgeEnd[] | null {
    try {
        if (edge.isClosed) {
            return [];
        }
        const p0 = vecOf(edge.pointAt(0));
        const p1 = vecOf(edge.pointAt(1));
        const t0 = unit(vecOf(edge.tangentAt(0)));
        const t1 = unit(vecOf(edge.tangentAt(1)));
        return [{ point: p0, out: [-t0[0], -t0[1], -t0[2]] }, { point: p1, out: t1 }];
    } catch {
        return null; // degenerate edge (e.g. a sphere pole): never part of a chain
    }
}

/**
 * All edges joined to the seeds through vertices where the two edges continue in the same direction (within 1°) and
 * the faces along them carry on too: each face beside the one edge has a face beside the other with the same normal
 * at the vertex. An edge that only runs on in a straight line, like the outside edge of a boss carrying on from the
 * inside corner where the boss meets the body, is not part of the chain (a blend could not run on smoothly there).
 */
export function tangentChain(shape: Shape3D, all: Edge[], seeds: Edge[]): Edge[] {
    const ends = all.map(edgeEnds);
    const index = (edge: Edge): number => all.findIndex((e) => e.isSame(edge));
    const faces = shape.faces;
    const faceEdges: Edge[][] = [];
    const besides = new Map<number, Face[]>();
    const facesBeside = (i: number): Face[] => {
        let found = besides.get(i);
        if (!found) {
            found = faces.filter((face, k) => (faceEdges[k] ??= face.edges).some((e) => e.isSame(all[i])));
            besides.set(i, found);
        }
        return found;
    };
    const facesCarryOn = (i: number, j: number, at: V): boolean => {
        const [a, b] = [facesBeside(i), facesBeside(j)];
        if (a.length === 0 || b.length === 0) {
            return true;
        }
        const normals = (list: Face[]) => list.map((face) => normalOf(face, at)).filter((n): n is V => !!n);
        const [na, nb] = [normals(a), normals(b)];
        return na.every((n) => nb.some((m) => dot(n, m) >= SMOOTH_COS)) && nb.every((m) => na.some((n) => dot(n, m) >= SMOOTH_COS));
    };
    const inChain = new Set<number>(seeds.map(index).filter((i) => i >= 0));
    const queue = [...inChain];
    while (queue.length > 0) {
        const i = queue.pop()!;
        for (const a of ends[i] ?? []) {
            for (let j = 0; j < all.length; j++) {
                if (inChain.has(j)) {
                    continue;
                }
                // Smooth continuation: the other edge leaves the shared vertex opposite to how this one arrives.
                if ((ends[j] ?? []).some((b) => dist(a.point, b.point) < SAME_POINT && dot(a.out, b.out) <= -SMOOTH_COS)
                    && facesCarryOn(i, j, a.point)) {
                    inChain.add(j);
                    queue.push(j);
                }
            }
        }
    }
    return [...inChain].sort((x, y) => x - y).map((i) => all[i]);
}

/**
 * The edge nearest to each pick point (true distance to the edge curve), deduplicated, optionally extended along
 * tangent chains. Throws when a pick has no edge within the tolerance.
 */
export function resolveEdges(shape: Shape3D, picks: Vec3[], options: ResolveOptions = {}): Edge[] {
    if (picks.length === 0) {
        return [];
    }
    const tolerance = pickTolerance(shape, options.tolerance);
    const all = shape.edges;
    const found: Edge[] = [];
    picks.forEach((pick, i) => {
        const d = distancesTo(pick, all);
        let best = -1;
        for (let k = 0; k < d.length; k++) {
            if (best < 0 || d[k] < d[best]) {
                best = k;
            }
        }
        const nearest = best >= 0 ? d[best] : Infinity;
        if (!(nearest <= tolerance)) {
            throw new Error(`selected edge ${i + 1} no longer exists on the part (nearest edge is ${fmt(nearest)} away); `
                + 'pick it again');
        }
        found.push(all[best]);
    });
    const picked = uniqueBySame(found);
    return options.tangent ? tangentChain(shape, all, picked) : picked;
}

// ---- Faces --------------------------------------------------------------------------------------------------

function normalOf(face: Face, at: Vec3): V | null {
    try {
        return unit(vecOf(face.normalAt(at)));
    } catch {
        return null;
    }
}

/** Faces joined to the seeds along edges where both faces have the same normal (within 1°). */
function tangentFaces(all: Face[], seeds: Face[]): Face[] {
    const faceEdges = all.map((f) => f.edges);
    const index = (face: Face): number => all.findIndex((f) => f.isSame(face));
    const inSet = new Set<number>(seeds.map(index).filter((i) => i >= 0));
    const queue = [...inSet];
    while (queue.length > 0) {
        const i = queue.pop()!;
        for (const edge of faceEdges[i]) {
            let mid: V;
            try {
                mid = vecOf(edge.pointAt(0.5));
            } catch {
                continue;
            }
            for (let j = 0; j < all.length; j++) {
                if (inSet.has(j) || !faceEdges[j].some((e) => e.isSame(edge))) {
                    continue;
                }
                const a = normalOf(all[i], mid);
                const b = normalOf(all[j], mid);
                if (a && b && dot(a, b) >= SMOOTH_COS) {
                    inSet.add(j);
                    queue.push(j);
                }
            }
        }
    }
    return [...inSet].sort((x, y) => x - y).map((i) => all[i]);
}

/**
 * The face containing (nearest to) each pick point; when several are equally near (a pick on a shared edge), the
 * one whose normal is closest to the pick's normal. Deduplicated, optionally extended across smooth edges.
 */
export function resolveFaces(shape: Shape3D, picks: FacePick[], options: ResolveOptions = {}): Face[] {
    if (picks.length === 0) {
        return [];
    }
    const tolerance = pickTolerance(shape, options.tolerance);
    const all = shape.faces;
    const found: Face[] = [];
    picks.forEach((pick, i) => {
        const d = distancesTo(pick.at, all);
        const nearest = Math.min(Infinity, ...d);
        if (!(nearest <= tolerance)) {
            throw new Error(`selected face ${i + 1} no longer exists on the part (nearest face is ${fmt(nearest)} away); `
                + 'pick it again');
        }
        const candidates = all.map((_, k) => k).filter((k) => d[k] <= nearest + TIE);
        let best = candidates[0];
        if (candidates.length > 1 && pick.normal) {
            const wanted = unit([...pick.normal] as V);
            let score = -Infinity;
            for (const k of candidates) {
                const n = normalOf(all[k], pick.at);
                const s = n ? dot(n, wanted) : -Infinity;
                if (s > score) {
                    score = s;
                    best = k;
                }
            }
        }
        found.push(all[best]);
    });
    const picked = uniqueBySame(found);
    return options.tangent ? tangentFaces(all, picked) : picked;
}

// ---- Vertices -----------------------------------------------------------------------------------------------

/** The vertex of the shape nearest to the pick, within the tolerance. */
export function resolveVertex(shape: Shape3D, pick: Vec3, tolerance?: number): Vertex {
    const tol = pickTolerance(shape, tolerance);
    let best: Vertex | null = null;
    let nearest = Infinity;
    for (const v of iterTopo(shape.wrapped, 'vertex')) {
        const vertex = new Vertex(v);
        const d = dist(vertex.asTuple(), [...pick] as V);
        if (d < nearest) {
            best?.delete();
            best = vertex;
            nearest = d;
        } else {
            vertex.delete();
        }
    }
    if (!best || !(nearest <= tol)) {
        best?.delete();
        throw new Error(`selected vertex no longer exists on the part (nearest vertex is ${fmt(nearest)} away); pick it again`);
    }
    return best;
}

/** A neutral plane from a picked planar face: through the pick point, normal = the face's outward normal there. */
export function planeOfFace(face: Face, at: Vec3): { origin: Vec3; normal: Vec3 } {
    if (face.geomType !== 'PLANE') {
        throw new Error('the picked face is not flat, so it cannot be used as a plane');
    }
    const normal = normalOf(face, at);
    if (!normal) {
        throw new Error('could not find the normal of the picked face');
    }
    return { origin: at, normal };
}
