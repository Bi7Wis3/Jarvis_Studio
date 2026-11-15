// Line geometry for the display styles (displayStyle.ts): the distance along each model edge (for dashed hidden
// edges) and the mesh edges inside curved faces that can be a face's outline as seen (a cylinder's sides), which a
// shader keeps only where the view grazes the surface.

import { BufferAttribute, BufferGeometry } from 'three';

/**
 * For line segment pairs (x,y,z,x,y,z per segment, as the kernel sends edges): the distance along the edge at each
 * end, from where the edge's polyline starts. A segment continues the one before when it starts where that one ended
 * and belongs to the same edge (`segEdge`, when given).
 */
export function lineDistances(edges: ArrayLike<number>, segEdge?: ArrayLike<number>): Float32Array {
    const segments = Math.floor(edges.length / 6);
    const out = new Float32Array(segments * 2);
    let run = 0;
    for (let s = 0; s < segments; s++) {
        const o = s * 6;
        const continues = s > 0 && (!segEdge || segEdge[s] === segEdge[s - 1])
            && edges[o] === edges[o - 3] && edges[o + 1] === edges[o - 2] && edges[o + 2] === edges[o - 1];
        if (!continues) {
            run = 0;
        }
        out[s * 2] = run;
        run += Math.hypot(edges[o + 3] - edges[o], edges[o + 4] - edges[o + 1], edges[o + 5] - edges[o + 2]);
        out[s * 2 + 1] = run;
    }
    return out;
}

/** Mesh edges that can be an outline: per edge its two ends, the normals of its two triangles and its midpoint. */
export interface OutlineCandidates {
    /** Two points per edge. */
    positions: Float32Array;
    /** The unit normal of one triangle and of the other, repeated at both ends. */
    normalA: Float32Array;
    normalB: Float32Array;
    /** The edge's midpoint at both ends, so both ends decide alike. */
    centre: Float32Array;
}

/** Below this angle between two triangles they are taken as one flat piece (no outline between them). */
const FLAT_COS = Math.cos((0.05 * Math.PI) / 180);

/**
 * The edges shared by two triangles of an indexed mesh that are not coplanar. The kernel shares vertices only within a
 * face, so these lie inside curved faces; edges between faces are the model's own edges, drawn anyway.
 */
export function outlineCandidates(positions: ArrayLike<number>, indices: ArrayLike<number>): OutlineCandidates {
    const triangles = Math.floor(indices.length / 3);
    const normals = new Float32Array(triangles * 3);
    for (let t = 0; t < triangles; t++) {
        const [a, b, c] = [indices[t * 3] * 3, indices[t * 3 + 1] * 3, indices[t * 3 + 2] * 3];
        const ux = positions[b] - positions[a];
        const uy = positions[b + 1] - positions[a + 1];
        const uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a];
        const vy = positions[c + 1] - positions[a + 1];
        const vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l > 0) {
            normals.set([nx / l, ny / l, nz / l], t * 3);
        }
    }
    const vertexCount = Math.floor(positions.length / 3);
    const first = new Map<number, number>();
    const pairs: [number, number, number, number][] = [];
    for (let t = 0; t < triangles; t++) {
        if (normals[t * 3] === 0 && normals[t * 3 + 1] === 0 && normals[t * 3 + 2] === 0) {
            continue;
        }
        for (let k = 0; k < 3; k++) {
            const v = indices[t * 3 + k];
            const w = indices[t * 3 + ((k + 1) % 3)];
            const key = v < w ? v * vertexCount + w : w * vertexCount + v;
            const other = first.get(key);
            if (other === undefined) {
                first.set(key, t);
            } else if (other >= 0) {
                first.set(key, -1);
                const dot = normals[t * 3] * normals[other * 3] + normals[t * 3 + 1] * normals[other * 3 + 1] + normals[t * 3 + 2] * normals[other * 3 + 2];
                if (dot < FLAT_COS) {
                    pairs.push([v, w, other, t]);
                }
            }
        }
    }
    const out: OutlineCandidates = {
        positions: new Float32Array(pairs.length * 6),
        normalA: new Float32Array(pairs.length * 6),
        normalB: new Float32Array(pairs.length * 6),
        centre: new Float32Array(pairs.length * 6),
    };
    pairs.forEach(([v, w, ta, tb], i) => {
        for (let c = 0; c < 3; c++) {
            const p = positions[v * 3 + c];
            const q = positions[w * 3 + c];
            out.positions[i * 6 + c] = p;
            out.positions[i * 6 + 3 + c] = q;
            out.centre[i * 6 + c] = out.centre[i * 6 + 3 + c] = (p + q) / 2;
            out.normalA[i * 6 + c] = out.normalA[i * 6 + 3 + c] = normals[ta * 3 + c];
            out.normalB[i * 6 + c] = out.normalB[i * 6 + 3 + c] = normals[tb * 3 + c];
        }
    });
    return out;
}

const outlines = new WeakMap<BufferGeometry, BufferGeometry>();
const dashed = new WeakMap<BufferGeometry, BufferGeometry>();

/** The outline candidates of a kernel surface as line geometry for the outline shader (built once per mesh). */
export function outlineGeometry(surface: BufferGeometry): BufferGeometry {
    let geometry = outlines.get(surface);
    if (!geometry) {
        const position = surface.getAttribute('position');
        const index = surface.getIndex();
        const found = outlineCandidates(position.array, index ? index.array : Array.from({ length: position.count }, (_, i) => i));
        geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(found.positions, 3));
        geometry.setAttribute('normalA', new BufferAttribute(found.normalA, 3));
        geometry.setAttribute('normalB', new BufferAttribute(found.normalB, 3));
        geometry.setAttribute('centre', new BufferAttribute(found.centre, 3));
        geometry.setAttribute('lineDistance', new BufferAttribute(lineDistances(found.positions), 1));
        outlines.set(surface, geometry);
    }
    return geometry;
}

/** The model's edges with the distance along each edge, for dashed lines (built once per edges geometry). */
export function edgesWithDistance(edges: BufferGeometry, segEdge?: ArrayLike<number>): BufferGeometry {
    let geometry = dashed.get(edges);
    if (!geometry) {
        const position = edges.getAttribute('position');
        geometry = new BufferGeometry();
        geometry.setAttribute('position', position);
        geometry.setAttribute('lineDistance', new BufferAttribute(lineDistances(position.array, segEdge), 1));
        dashed.set(edges, geometry);
    }
    return geometry;
}
