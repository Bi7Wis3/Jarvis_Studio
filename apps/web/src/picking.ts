// Faces and edges of a kernel mesh, for picking: plain arrays in, plain data out (no three.js scene access).
// A face is the ordinal in `triFace` (one entry per triangle); an edge the ordinal in `segEdge` (one per segment
// of the edge line list, six floats each). Ordinals are only valid for the mesh they came from.

export type P3 = [number, number, number];

export interface PickedEntity {
    partId: string;
    kind: 'face' | 'edge';
    index: number;
}

/** Index triples of the triangles of one face, as a new array. */
export function faceTriangles(indices: ArrayLike<number>, triFace: ArrayLike<number>, face: number): Uint32Array {
    let count = 0;
    for (let t = 0; t < triFace.length; t++) {
        if (triFace[t] === face) {
            count++;
        }
    }
    const out = new Uint32Array(count * 3);
    let o = 0;
    for (let t = 0; t < triFace.length; t++) {
        if (triFace[t] === face) {
            out[o++] = indices[t * 3];
            out[o++] = indices[t * 3 + 1];
            out[o++] = indices[t * 3 + 2];
        }
    }
    return out;
}

/** The face's triangles as a flat, unindexed position list (nine floats per triangle), e.g. for an overlay. */
export function faceSoup(positions: ArrayLike<number>, indices: ArrayLike<number>, triFace: ArrayLike<number>, face: number): Float32Array {
    const tris = faceTriangles(indices, triFace, face);
    const out = new Float32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
        const v = tris[i] * 3;
        out[i * 3] = positions[v];
        out[i * 3 + 1] = positions[v + 1];
        out[i * 3 + 2] = positions[v + 2];
    }
    return out;
}

/** Segments of one edge (x,y,z,x,y,z each), as a new array. */
export function edgeSegments(edges: ArrayLike<number>, segEdge: ArrayLike<number>, edge: number): Float32Array {
    let count = 0;
    for (let s = 0; s < segEdge.length; s++) {
        if (segEdge[s] === edge) {
            count++;
        }
    }
    const out = new Float32Array(count * 6);
    let o = 0;
    for (let s = 0; s < segEdge.length; s++) {
        if (segEdge[s] === edge) {
            for (let k = 0; k < 6; k++) {
                out[o++] = edges[s * 6 + k];
            }
        }
    }
    return out;
}

/** Squared distance from p to the segment a-b. */
function segmentDistanceSq(p: P3, e: ArrayLike<number>, at: number): number {
    const ax = e[at], ay = e[at + 1], az = e[at + 2];
    const dx = e[at + 3] - ax, dy = e[at + 4] - ay, dz = e[at + 5] - az;
    const px = p[0] - ax, py = p[1] - ay, pz = p[2] - az;
    const len = dx * dx + dy * dy + dz * dz;
    const t = len > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) / len)) : 0;
    const qx = px - t * dx, qy = py - t * dy, qz = pz - t * dz;
    return qx * qx + qy * qy + qz * qz;
}

/** The edge closest to `point` if it is within `tolerance`, else null. */
export function nearestEdge(edges: ArrayLike<number>, segEdge: ArrayLike<number>, point: P3, tolerance: number): number | null {
    let best = tolerance * tolerance;
    let found: number | null = null;
    for (let s = 0; s < segEdge.length; s++) {
        const d = segmentDistanceSq(point, edges, s * 6);
        if (d <= best) {
            best = d;
            found = segEdge[s];
        }
    }
    return found;
}

/** Cross product of a triangle's sides (length = twice its area), from three vertex indices. */
function triangleCross(positions: ArrayLike<number>, a: number, b: number, c: number): P3 {
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Surface area of a face: the sum of its triangles' areas. */
export function faceArea(positions: ArrayLike<number>, indices: ArrayLike<number>, triFace: ArrayLike<number>, face: number): number {
    let area = 0;
    for (let t = 0; t < triFace.length; t++) {
        if (triFace[t] === face) {
            area += Math.hypot(...triangleCross(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2])) / 2;
        }
    }
    return area;
}

/** cos(0.5°): triangle normals closer than this count as the same direction. */
const PLANAR_COS = Math.cos((0.5 * Math.PI) / 180);

/**
 * Whether a face is planar (all its triangle normals agree within half a degree) and, if so, its unit normal
 * (the triangles' winding direction). Zero-area triangles are ignored.
 */
export function facePlane(
    positions: ArrayLike<number>, indices: ArrayLike<number>, triFace: ArrayLike<number>, face: number,
): { planar: boolean; normal: P3 | null } {
    const normals: P3[] = [];
    const sum: P3 = [0, 0, 0];
    for (let t = 0; t < triFace.length; t++) {
        if (triFace[t] !== face) {
            continue;
        }
        const n = triangleCross(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
        const length = Math.hypot(...n);
        if (length > 1e-12) {
            normals.push([n[0] / length, n[1] / length, n[2] / length]);
            sum[0] += n[0];
            sum[1] += n[1];
            sum[2] += n[2];
        }
    }
    const length = Math.hypot(...sum);
    if (normals.length === 0 || length === 0) {
        return { planar: false, normal: null };
    }
    const normal: P3 = [sum[0] / length, sum[1] / length, sum[2] / length];
    const planar = normals.every((n) => n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2] >= PLANAR_COS);
    return { planar, normal: planar ? normal : null };
}

/** Length of an edge: the sum of its segments. */
export function edgeLength(edges: ArrayLike<number>, segEdge: ArrayLike<number>, edge: number): number {
    let length = 0;
    for (let s = 0; s < segEdge.length; s++) {
        if (segEdge[s] === edge) {
            const at = s * 6;
            length += Math.hypot(edges[at + 3] - edges[at], edges[at + 4] - edges[at + 1], edges[at + 5] - edges[at + 2]);
        }
    }
    return length;
}

/** A measure for the readout: whole numbers from 100 up, else one decimal; thousands split by a thin space. */
export function formatMeasure(value: number): string {
    const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    const [whole, fraction] = String(rounded + 0).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return fraction ? `${grouped}.${fraction}` : grouped;
}

/** "3 faces, 2 edges" for a multiple pick (singular forms for one). */
export function countLabel(picked: readonly { kind: 'face' | 'edge' }[]): string {
    const faces = picked.filter((p) => p.kind === 'face').length;
    const edges = picked.length - faces;
    const part = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    return [faces ? part(faces, 'face') : '', edges ? part(edges, 'edge') : ''].filter(Boolean).join(', ');
}

/** Adds an entity to a pick list, or with `additive` toggles it; a plain pick replaces the list. */
export function togglePick(picked: readonly PickedEntity[], entity: PickedEntity, additive: boolean): PickedEntity[] {
    const same = (p: PickedEntity) => p.partId === entity.partId && p.kind === entity.kind && p.index === entity.index;
    if (!additive) {
        return [entity];
    }
    return picked.some(same) ? picked.filter((p) => !same(p)) : [...picked, entity];
}

/** What the size of a screen pixel depends on, for perspective (fov in degrees) and orthographic cameras. */
export type PixelCamera =
    | { kind: 'perspective'; fov: number; zoom: number }
    | { kind: 'orthographic'; top: number; bottom: number; zoom: number };

/** World size of one screen pixel at `depth` (distance along the view direction) in a viewport `height` px tall. */
export function pixelSize(camera: PixelCamera, depth: number, height: number): number {
    const view = camera.kind === 'perspective'
        ? (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / camera.zoom
        : (camera.top - camera.bottom) / camera.zoom;
    return view / Math.max(1, height);
}
