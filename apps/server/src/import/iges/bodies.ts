// Faces knitted into shells and closed shells made solids, keeping track of the faces' colours; solids moved to
// where a subfigure instance places them.

import { cast, getOC, localGC, type Shape3D } from 'replicad';
import { shellSolid } from '../solids.js';
import { explore } from '../topology.js';
import type { TopoShape } from './faces.js';
import type { Xf } from './model.js';

export interface Piece {
    face: TopoShape;
    colour?: string;
}

export interface SolidItem {
    shape: Shape3D;
    colour?: string;
    name?: string;
}

export interface Knitted {
    solids: SolidItem[];
    /** Shells that stayed open, and faces that joined no shell. */
    open: number;
}

const hashOf = (shape: TopoShape): number =>
    (getOC() as unknown as { ReplicadShapeHasher: { HashCode(s: TopoShape, max: number): number } }).ReplicadShapeHasher.HashCode(shape, 2147483647);

/** The most common of some colours. */
export function commonest(colours: (string | undefined)[]): string | undefined {
    const counts = new Map<string, number>();
    for (const c of colours) {
        if (c) {
            counts.set(c, (counts.get(c) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The closed shells of a sewn shape (a face closed on itself, a sphere or a torus, is a shell of its own), and the
 * number of open shells and loose faces.
 */
export function shellsOf(sewn: TopoShape): { closed: TopoShape[]; open: number } {
    const oc = getOC();
    const closed: TopoShape[] = [];
    let open = 0;
    for (const shell of explore(oc, sewn, 'TopAbs_SHELL')) {
        if (oc.BRep_Tool.IsClosed(shell)) {
            closed.push(shell);
        } else {
            open++;
        }
    }
    for (const face of explore(oc, sewn, 'TopAbs_FACE', 'TopAbs_SHELL')) {
        const shell = new oc.TopoDS_Shell();
        const builder = new oc.TopoDS_Builder();
        builder.MakeShell(shell);
        builder.Add(shell, face);
        builder.delete();
        if (oc.BRep_Tool.IsClosed(shell)) {
            closed.push(shell);
        } else {
            shell.delete();
            open++;
        }
    }
    return { closed, open };
}

/** Knits faces at a tolerance (mm); each closed shell becomes a solid with its faces' most common colour. */
export function knitFaces(pieces: Piece[], tolerance: number): Knitted {
    if (!pieces.length) {
        return { solids: [], open: 0 };
    }
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const sewing = r(new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false));
        for (const p of pieces) {
            sewing.Add(p.face);
        }
        sewing.Perform(r(new oc.Message_ProgressRange()));
        const sewn = r(sewing.SewedShape());
        const colourOf = new Map<number, string>();
        for (const p of pieces) {
            if (p.colour) {
                const face = sewing.IsModified(p.face) ? sewing.Modified(p.face) : p.face;
                colourOf.set(hashOf(face), p.colour);
            }
        }
        const fallback = commonest(pieces.map((p) => p.colour));
        const solids: SolidItem[] = [];
        const { closed, open } = shellsOf(sewn);
        for (const shell of closed) {
            const solid = shellSolid(shell);
            if (!solid) {
                continue;
            }
            const colour = commonest(explore(oc, solid.wrapped, 'TopAbs_FACE').map((f) => colourOf.get(hashOf(f)))) ?? fallback;
            solids.push({ shape: solid, ...(colour ? { colour } : {}) });
        }
        return { solids, open };
    } finally {
        gc();
    }
}

/** A copy of a solid moved by an affine map (a rotation or reflection with a uniform scale, and a translation). */
export function placed(shape: Shape3D, x: Xf): Shape3D {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const trsf = r(new oc.gp_Trsf());
        const m = x.r;
        trsf.SetValues(m[0], m[1], m[2], x.t[0], m[3], m[4], m[5], x.t[1], m[6], m[7], m[8], x.t[2]);
        const moved = r(new oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, true, false));
        // A mirror keeps the solid outward-facing: the transformation reverses its faces itself.
        return cast(moved.ModifiedShape(shape.wrapped)) as Shape3D;
    } finally {
        gc();
    }
}
