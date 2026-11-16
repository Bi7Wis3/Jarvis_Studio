// A closed, consistently wound triangle mesh as an OpenCascade solid, built face by face on shared vertices and edges
// (one planar face per facet), so nothing has to be knitted or reoriented afterwards: linear in the facet count,
// where reading the STL with StlAPI_Reader, knitting and ShapeFix_Solid take minutes on large meshes.

import { cast, getOC, measureVolume, type Shape3D } from 'replicad';

type OC = ReturnType<typeof getOC>;

/** `positions`: three corners per facet; `corners`: per corner its welded vertex. Null when OpenCascade refuses it. */
export function solidFromFacets(positions: Float32Array, corners: Uint32Array, vertexCount: number): Shape3D | null {
    const oc: OC = getOC();
    const owned: { delete(): void }[] = [];
    const keep = <T extends { delete(): void }>(o: T): T => {
        owned.push(o);
        return o;
    };
    try {
        const vertices: unknown[] = new Array(vertexCount);
        const vertex = (id: number, at: number) => {
            if (!vertices[id]) {
                const point = keep(new oc.gp_Pnt(positions[at], positions[at + 1], positions[at + 2]));
                const make = keep(new oc.BRepBuilderAPI_MakeVertex(point));
                vertices[id] = keep(make.Vertex());
            }
            return vertices[id] as never;
        };
        const edges = new Map<number, ReturnType<typeof oc.TopoDS.Edge>>();
        const edge = (a: number, b: number) => {
            const key = Math.min(a, b) * vertexCount + Math.max(a, b);
            let found = edges.get(key);
            if (!found) {
                const make = keep(new oc.BRepBuilderAPI_MakeEdge(vertices[Math.min(a, b)] as never, vertices[Math.max(a, b)] as never));
                if (!make.IsDone()) {
                    throw new Error('edge');
                }
                found = keep(make.Edge());
                edges.set(key, found);
            }
            // Edges run from the lower vertex id to the higher; a facet going the other way uses it reversed.
            return a < b ? found : keep(found.Reversed());
        };
        const builder = keep(new oc.TopoDS_Builder());
        const shell = keep(new oc.TopoDS_Shell());
        builder.MakeShell(shell);
        const facets = corners.length / 3;
        for (let t = 0; t < facets; t++) {
            const ids = [corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]];
            ids.forEach((id, c) => vertex(id, t * 9 + c * 3));
            const p = positions.subarray(t * 9, t * 9 + 9);
            const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
            const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            if (!(Math.hypot(nx, ny, nz) > 0)) {
                return null;
            }
            const wire = keep(new oc.TopoDS_Wire());
            builder.MakeWire(wire);
            builder.Add(wire, edge(ids[0], ids[1]));
            builder.Add(wire, edge(ids[1], ids[2]));
            builder.Add(wire, edge(ids[2], ids[0]));
            wire.Closed(true);
            const origin = keep(new oc.gp_Pnt(p[0], p[1], p[2]));
            const normal = keep(new oc.gp_Dir(nx, ny, nz));
            const plane = keep(new oc.gp_Pln(origin, normal));
            const face = keep(new oc.BRepBuilderAPI_MakeFace(plane, wire, true));
            if (!face.IsDone()) {
                return null;
            }
            builder.Add(shell, keep(face.Face()));
        }
        shell.Closed(true);
        const make = keep(new oc.BRepBuilderAPI_MakeSolid(shell));
        if (!make.IsDone()) {
            return null;
        }
        let solid = cast(make.Solid()) as Shape3D;
        // Facets wound clockwise (inward) give a solid inside out: turn it.
        if (measureVolume(solid) < 0) {
            const turned = cast(solid.wrapped.Reversed()) as Shape3D;
            solid.delete();
            solid = turned;
        }
        return solid;
    } catch {
        return null;
    } finally {
        owned.forEach((o) => o.delete());
    }
}
