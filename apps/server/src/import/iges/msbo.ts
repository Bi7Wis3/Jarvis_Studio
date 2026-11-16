// Manifold solid B-rep objects (186): a closed shell (514) and any void shells, whose faces (510) lie on surfaces
// bounded by loops (508) of edges (504 edge lists, between vertices of 502 vertex lists). Each face is built on its
// surface from the edges' 3D curves, the faces are knitted, and the shells made one solid.

import { cast, getOC, localGC, type Shape3D } from 'replicad';
import { dist, type V3 } from '../sldprt/nurbs.js';
import { explore } from '../topology.js';
import { commonest, shellsOf, type Piece, type SolidItem } from './bodies.js';
import { curveSegments, segEnd, segStart, type Seg } from './curves.js';
import { faceFromLoops, loopEdges, type FaceContext, type LoopEdge, type TopoShape } from './faces.js';
import { apply, IgesGeometryError, int, point, type IgesModel, type Xf } from './model.js';
import type { IgesEntity } from './parse.js';

const hashOf = (shape: TopoShape): number =>
    (getOC() as unknown as { ReplicadShapeHasher: { HashCode(s: TopoShape, max: number): number } }).ReplicadShapeHasher.HashCode(shape, 2147483647);

/** Vertex `index` (1-based) of a vertex list (502). */
function vertexOf(m: IgesModel, list: IgesEntity | undefined, index: number, x: Xf): V3 | null {
    if (!list || list.type !== 502 || index < 1 || index > int(list, 0)) {
        return null;
    }
    return apply(m.xf(list, x), point(list, 1 + 3 * (index - 1)));
}

/** The segments of edge `index` (1-based) of an edge list (504), from its start vertex to its terminate vertex. */
function edgeSegments(m: IgesModel, list: IgesEntity, index: number, x: Xf): Seg[] {
    if (list.type !== 504 || index < 1 || index > int(list, 0)) {
        throw new IgesGeometryError('a loop refers to an edge that is not there');
    }
    const at = 1 + 5 * (index - 1);
    const lx = m.xf(list, x);
    const curve = m.need(list.params[at], 'the curve of an edge');
    const segs = curveSegments(m, curve, lx);
    const sv = vertexOf(m, m.entity(int(list, at + 1)), int(list, at + 2), x);
    const tv = vertexOf(m, m.entity(int(list, at + 3)), int(list, at + 4), x);
    if (segs.length === 1 && sv && tv) {
        // An edge on part of its curve (a closed curve, or a longer one): the piece between its vertices.
        const s = segs[0];
        const tol = 1e-6 * Math.max(1, dist(segStart(s), segEnd(s)));
        if (dist(segStart(s), sv) > tol || dist(segEnd(s), tv) > tol) {
            let t0 = s.curve.project(sv);
            let t1 = s.curve.project(tv);
            const P = s.curve.period;
            if (P) {
                while (t1 <= t0 + 1e-12) {
                    t1 += P;
                }
                if (dist(sv, tv) < tol) {
                    t1 = t0 + P;
                }
            } else if (t1 < t0) {
                [t0, t1] = [t1, t0];
            }
            return [{ curve: s.curve, first: t0, last: t1 }];
        }
    }
    return segs;
}

/** The loops of a face (510) as loop edges. */
function faceLoops(m: IgesModel, face: IgesEntity, x: Xf): LoopEdge[][] {
    const n = int(face, 1);
    const loops: LoopEdge[][] = [];
    for (let k = 0; k < n; k++) {
        const loop = m.entity(int(face, 3 + k));
        if (!loop || loop.type !== 508) {
            continue;
        }
        const edges: LoopEdge[] = [];
        let at = 1;
        for (let i = 0; i < int(loop, 0); i++) {
            const type = int(loop, at);
            const list = m.entity(int(loop, at + 1));
            const index = int(loop, at + 2);
            const agrees = int(loop, at + 3) !== 0;
            const count = int(loop, at + 4);
            at += 5 + 2 * count;
            if (type !== 0 || !list) {
                continue; // a vertex loop (an apex): ShapeFix adds the degenerate edge it needs
            }
            edges.push(...loopEdges(edgeSegments(m, list, index, m.xf(loop, x)), !agrees));
        }
        if (edges.length) {
            loops.push(edges);
        }
    }
    return loops;
}

/** The faces of a shell (514) as pieces to knit, with their colours. */
export function msboPieces(m: IgesModel, shell: IgesEntity, x: Xf, ctx: FaceContext): Piece[] {
    if (shell.type !== 514) {
        throw new IgesGeometryError(`a solid whose shell is entity type ${shell.type}`);
    }
    const sx = m.xf(shell, x);
    const pieces: Piece[] = [];
    let failed = 0;
    let reason: unknown;
    for (let i = 0; i < int(shell, 0); i++) {
        const face = m.entity(int(shell, 1 + 2 * i));
        if (!face || face.type !== 510) {
            continue;
        }
        try {
            const fx = m.xf(face, sx);
            const surface = m.need(face.params[0], 'the surface of a face');
            const colour = m.colourOf(face) ?? m.colourOf(surface) ?? m.colourOf(shell);
            for (const f of faceFromLoops(m, surface, fx, faceLoops(m, face, fx), ctx)) {
                pieces.push({ face: f, ...(colour ? { colour } : {}) });
            }
        } catch (error) {
            failed++;
            reason = error;
        }
    }
    if (failed) {
        pieces.forEach((p) => p.face.delete());
        const why = reason instanceof Error ? reason.message : 'an OpenCascade error';
        throw new IgesGeometryError(`${failed} of its faces could not be built (${why})`);
    }
    return pieces;
}

/** A manifold solid B-rep object as one solid (its void shells inside), or null when its faces do not close. */
export function msboSolid(m: IgesModel, e: IgesEntity, x: Xf, ctx: FaceContext, tolerance: number): SolidItem | null {
    const sx = m.xf(e, x);
    const shells = [m.need(e.params[0], 'the shell of a solid')];
    for (let i = 0; i < int(e, 2); i++) {
        const v = m.entity(int(e, 3 + 2 * i));
        if (v) {
            shells.push(v);
        }
    }
    const pieces = shells.flatMap((s) => msboPieces(m, s, sx, ctx));
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const sewing = r(new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false));
        pieces.forEach((p) => sewing.Add(p.face));
        sewing.Perform(r(new oc.Message_ProgressRange()));
        const sewn = r(sewing.SewedShape());
        const { closed } = shellsOf(sewn);
        if (!closed.length) {
            return null;
        }
        const maker = r(new oc.BRepBuilderAPI_MakeSolid());
        closed.forEach((s) => maker.Add(oc.TopoDS.Shell(s)));
        if (!maker.IsDone()) {
            return null;
        }
        const fix = r(new oc.ShapeFix_Solid(maker.Solid()));
        fix.Perform(r(new oc.Message_ProgressRange()));
        const solid = cast(fix.Solid()) as Shape3D;
        if (!solid.solids.length) {
            solid.delete();
            return null;
        }
        const colourOf = new Map<number, string>();
        for (const p of pieces) {
            if (p.colour) {
                colourOf.set(hashOf(sewing.IsModified(p.face) ? sewing.Modified(p.face) : p.face), p.colour);
            }
        }
        const colour = m.colourOf(e) ?? commonest(explore(oc, solid.wrapped, 'TopAbs_FACE').map((f) => colourOf.get(hashOf(f))))
            ?? commonest(pieces.map((p) => p.colour));
        return { shape: solid, ...(colour ? { colour } : {}) };
    } finally {
        pieces.forEach((p) => p.face.delete());
        gc();
    }
}
