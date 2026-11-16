// Walking an OpenCascade shape's topology without replicad's de-duplication (shape.faces, shape.edges), which
// compares every item with every other: seconds for an imported model of a few thousand faces, many minutes for an
// STL made solid with tens of thousands. The meshing in build.ts uses seamEdgeIds and bodyOrdinalsOf from here.

import { getOC, type Shape3D } from 'replicad';

type OC = ReturnType<typeof getOC>;
export type Raw = Shape3D['wrapped'];

/** replicad's hashCode of a shape (the ids the mesher gives faces and edges). */
const hashOf = (oc: OC, shape: Raw): number =>
    (oc as unknown as { ReplicadShapeHasher: { HashCode(s: Raw, max: number): number } }).ReplicadShapeHasher.HashCode(shape, 2147483647);

/** Hash codes of seam edges (where a closed surface meets itself), as build.ts once found them face by face. */
export function seamEdgeIds(shape: Shape3D): Set<number> {
    const oc = getOC();
    const seams = new Set<number>();
    for (const raw of explore(oc, shape.wrapped, 'TopAbs_FACE')) {
        const face = oc.TopoDS.Face(raw);
        for (const rawEdge of explore(oc, raw, 'TopAbs_EDGE')) {
            const edge = oc.TopoDS.Edge(rawEdge);
            if (oc.BRep_Tool.IsClosed(edge, face)) {
                seams.add(hashOf(oc, rawEdge));
            }
            edge.delete();
            rawEdge.delete();
        }
        face.delete();
        raw.delete();
    }
    return seams;
}

/**
 * Per face and per edge id of a mesh (`faceIds`, `edgeIds`: hash codes, in mesh order): the index of the solid of
 * `shape` it is on. The same answer as bodies.ts bodyOrdinals, in time linear in the size of the shape.
 */
export function bodyOrdinalsOf(shape: Shape3D, faceIds: number[], edgeIds: number[]): { faceBody: Uint32Array; edgeBody: Uint32Array } {
    const faceBody = new Uint32Array(faceIds.length);
    const edgeBody = new Uint32Array(edgeIds.length);
    const oc = getOC();
    const solids = explore(oc, shape.wrapped, 'TopAbs_SOLID');
    if (solids.length > 1) {
        const faceOf = new Map<number, number>();
        const edgeOf = new Map<number, number>();
        solids.forEach((solid, i) => {
            for (const [kind, map] of [['TopAbs_FACE', faceOf], ['TopAbs_EDGE', edgeOf]] as const) {
                for (const item of explore(oc, solid, kind)) {
                    const id = hashOf(oc, item);
                    if (!map.has(id)) {
                        map.set(id, i);
                    }
                    item.delete();
                }
            }
        });
        faceIds.forEach((id, k) => {
            faceBody[k] = faceOf.get(id) ?? 0;
        });
        edgeIds.forEach((id, k) => {
            edgeBody[k] = edgeOf.get(id) ?? 0;
        });
    }
    solids.forEach((s) => s.delete());
    return { faceBody, edgeBody };
}

/** Every sub-shape of a kind (TopAbs_SOLID, ...) that does not lie inside one of `avoid`, each occurrence once. */
export function explore(oc: OC, shape: Raw, find: string, avoid?: string): Raw[] {
    const kinds = oc.TopAbs_ShapeEnum as unknown as Record<string, unknown>;
    const explorer = new oc.TopExp_Explorer(shape, kinds[find] as never, kinds[avoid ?? 'TopAbs_SHAPE'] as never);
    const out: Raw[] = [];
    try {
        for (; explorer.More(); explorer.Next()) {
            out.push(explorer.Current());
        }
    } finally {
        explorer.delete();
    }
    return out;
}

export const countOf = (oc: OC, shape: Raw, find: string): number => {
    const kinds = oc.TopAbs_ShapeEnum as unknown as Record<string, unknown>;
    const explorer = new oc.TopExp_Explorer(shape, kinds[find] as never, kinds.TopAbs_SHAPE as never);
    let n = 0;
    try {
        for (; explorer.More(); explorer.Next()) {
            n++;
        }
    } finally {
        explorer.delete();
    }
    return n;
};
