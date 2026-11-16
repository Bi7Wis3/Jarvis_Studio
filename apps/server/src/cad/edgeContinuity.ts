// Edges flagged smooth where their faces really meet at an angle.
// An edge stores how smoothly its two faces join along it (BRep_Tool::Continuity). OpenCascade's fillet and chamfer
// builders refuse an edge whose flag is not C0 ("There are no suitable edges for chamfer or fillet"): they take its
// faces as tangent. Earlier steps can leave the flag on an edge that is a real corner; then no size works there. The
// flag cannot be cleared through this build's bindings (no BRep_Builder), so the body is written as B-rep text, the
// flags of those edges are set back to C0 there, and the body is read back unchanged otherwise.

import { cast, getOC, type Edge, type Shape3D } from 'replicad';

type V = [number, number, number];
/* eslint-disable @typescript-eslint/no-explicit-any */
type OC = any;

const dist = (a: V, b: V): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Faces meeting at more than this along an edge are a corner, whatever the edge's flag says (degrees). */
const CORNER = 0.5;

function vec(v: { x: number; y: number; z: number; delete(): void }): V {
    const out: V = [v.x, v.y, v.z];
    v.delete();
    return out;
}

function facesOf(oc: OC, shape: Shape3D, edge: Edge): OC[] {
    const out: OC[] = [];
    const ex = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) {
        const face = ex.Current();
        const ee = new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        let found = false;
        for (; ee.More() && !found; ee.Next()) {
            found = ee.Current().IsSame(edge.wrapped);
        }
        ee.delete();
        if (found && !out.some((f) => f.IsSame(face))) {
            out.push(oc.TopoDS.Face(face));
        }
    }
    ex.delete();
    return out;
}

/** The largest angle between the faces' normals along the edge (degrees), or null if it cannot be measured. */
export function faceAngleAlong(shape: Shape3D, edge: Edge): number | null {
    const oc = getOC() as OC;
    const faces = facesOf(oc, shape, edge);
    if (faces.length !== 2) {
        return null;
    }
    const wrapped = faces.map((f) => cast(f) as unknown as { normalAt(p: V): { x: number; y: number; z: number; delete(): void } });
    let worst = 0;
    for (const k of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
        try {
            const p = vec(edge.pointAt(k));
            const [a, b] = wrapped.map((f) => vec(f.normalAt(p)));
            const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
            worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI);
        } catch {
            // a degenerate point: skip it
        }
    }
    return worst;
}

/** The edges flagged as a smooth join (not C0) whose faces in fact meet at an angle. */
export function falselySmooth(shape: Shape3D, edges: Edge[]): Edge[] {
    const oc = getOC() as OC;
    return edges.filter((edge) => {
        // Most edges store no flag, or only C0: then there is nothing to look at (finding the faces costs more).
        if (!oc.BRep_Tool.HasContinuity(edge.wrapped) || oc.BRep_Tool.MaxContinuity(edge.wrapped) === oc.GeomAbs_Shape.GeomAbs_C0) {
            return false;
        }
        const faces = facesOf(oc, shape, edge);
        if (faces.length !== 2 || !oc.BRep_Tool.HasContinuity(edge.wrapped, faces[0], faces[1])) {
            return false;
        }
        if (oc.BRep_Tool.Continuity(edge.wrapped, faces[0], faces[1]) === oc.GeomAbs_Shape.GeomAbs_C0) {
            return false;
        }
        const angle = faceAngleAlong(shape, edge);
        return angle !== null && angle > CORNER;
    });
}

interface Block {
    type: string;
    /** Line indices of the block: from its type line to its line of sub-shapes (ending in '*'). */
    from: number;
    to: number;
}

/** The TShape blocks of B-rep text, in file order. */
function blocksOf(lines: string[]): Block[] | null {
    let i = lines.findIndex((l) => /^TShapes\s+\d+/.test(l));
    if (i < 0) {
        return null;
    }
    const count = Number(/\d+/.exec(lines[i])![0]);
    const out: Block[] = [];
    i++;
    while (out.length < count && i < lines.length) {
        const type = lines[i].trim();
        if (!/^(Ve|Ed|Wi|Fa|Sh|So|CS|Co)$/.test(type)) {
            return null;
        }
        let j = i + 1;
        while (j < lines.length && !/(^|\s)\*\s*$/.test(lines[j])) {
            j++;
        }
        if (j >= lines.length) {
            return null;
        }
        out.push({ type, from: i, to: j });
        i = j + 1;
    }
    return out.length === count ? out : null;
}

/**
 * The shapes of `shape` numbered as OpenCascade numbers them when writing B-rep text: each sub-shape after its own
 * sub-shapes, once (by its TShape); null for a shape kind not handled here.
 */
function writtenOrder(oc: OC, shape: OC): { size: number; indexOf(s: OC): number } | null {
    const E = oc.TopAbs_ShapeEnum;
    const below = new Map<unknown, unknown>([[E.TopAbs_COMPSOLID, E.TopAbs_SOLID], [E.TopAbs_SOLID, E.TopAbs_SHELL],
        [E.TopAbs_SHELL, E.TopAbs_FACE], [E.TopAbs_FACE, E.TopAbs_WIRE], [E.TopAbs_WIRE, E.TopAbs_EDGE], [E.TopAbs_EDGE, E.TopAbs_VERTEX]]);
    // Shapes by hash, each with its number (1-based, as OpenCascade counts them).
    const buckets = new Map<number, { shape: OC; index: number }[]>();
    const hash = (s: OC): number => oc.ReplicadShapeHasher.HashCode(s, 2147483647);
    const find = (s: OC): number => (buckets.get(hash(s)) ?? []).find((e) => e.shape.IsPartner(s))?.index ?? 0;
    let size = 0;
    const here = new oc.TopLoc_Location();
    let ok = true;
    const add = (s: OC): void => {
        const plain = s.Located(here, false);
        if (find(plain)) {
            return;
        }
        const type = plain.ShapeType();
        if (type !== E.TopAbs_VERTEX) {
            const child = below.get(type);
            if (child === undefined) {
                ok = false;
                return;
            }
            const ex = new oc.TopExp_Explorer(plain, child, E.TopAbs_SHAPE);
            for (; ex.More() && ok; ex.Next()) {
                add(ex.Current());
            }
            ex.delete();
        }
        const h = hash(plain);
        buckets.set(h, [...(buckets.get(h) ?? []), { shape: plain, index: ++size }]);
    };
    add(shape);
    here.delete();
    if (!ok) {
        return null;
    }
    const indexOf = (s: OC): number => {
        const at = new oc.TopLoc_Location();
        try {
            return find(s.Located(at, false));
        } finally {
            at.delete();
        }
    };
    return { size, indexOf };
}

/** The body with the continuity flags of the given edges set to C0 (see withJoinFlags). */
export function withCornersReset(shape: Shape3D, wrong: Edge[], picked: Edge[]): { shape: Shape3D; edges: Edge[] } | null {
    return withJoinFlags(shape, wrong, 'C0', picked);
}

/**
 * The body with the continuity flags of the given edges set to `flag`, and the picked edges found again on it; null
 * when the text could not be edited or read back, or nothing changed.
 */
export function withJoinFlags(shape: Shape3D, edges: Edge[], flag: 'C0' | 'G1', picked: Edge[]): { shape: Shape3D; edges: Edge[] } | null {
    const oc = getOC() as OC;
    let text: string;
    try {
        text = oc.BRepToolsWrapper.Write(shape.wrapped);
    } catch {
        return null;
    }
    const lines = text.split('\n');
    const blocks = blocksOf(lines);
    const order = blocks && writtenOrder(oc, shape.wrapped);
    if (!blocks || !order || order.size !== blocks.length) {
        return null;
    }
    let changed = 0;
    const here = new oc.TopLoc_Location();
    const inserts: { at: number; line: string }[] = [];
    for (const edge of edges) {
        const index = order.indexOf(edge.wrapped);
        const b = blocks[index - 1];
        if (!b || b.type !== 'Ed') {
            continue;
        }
        let found = false;
        const onSurfaces: string[] = [];
        let end = -1;
        for (let i = b.from + 2; i < b.to; i++) {
            const m = /^4\s+(C0|G1|C1|G2|C2|C3|CN)\s+(.*)$/.exec(lines[i]);
            if (m) {
                found = true;
                if (m[1] !== flag) {
                    lines[i] = `4 ${flag} ${m[2]}`;
                    changed++;
                }
            }
            const c = /^2\s+\d+\s+(\d+)\s+(\d+)\s/.exec(lines[i]);
            if (c) {
                onSurfaces.push(`${c[1]} ${c[2]}`);
            }
            if (end < 0 && lines[i].trim() === '0') {
                end = i;
            }
        }
        // No flag stored (C0): one is added between the edge's two faces.
        if (!found && flag !== 'C0' && onSurfaces.length === 2 && end > 0) {
            inserts.push({ at: end, line: `4 ${flag} ${onSurfaces[0]} ${onSurfaces[1]}` });
            changed++;
        }
    }
    for (const { at, line } of inserts.sort((x, y) => y.at - x.at)) {
        lines.splice(at, 0, line);
    }
    here.delete();
    if (!changed) {
        return null;
    }
    let read: Shape3D;
    try {
        read = cast(oc.BRepToolsWrapper.Read(lines.join('\n'))) as Shape3D;
    } catch {
        return null;
    }
    const solids = read.solids ?? [];
    if (solids.length !== 1) {
        return null;
    }
    const body = solids[0];
    const all = body.edges;
    const found: Edge[] = [];
    for (const edge of picked) {
        const pts = [0, 0.5, 1].map((k) => vec(edge.pointAt(k)));
        const same = all.find((e) => {
            const own = [0, 0.5, 1].map((k) => vec(e.pointAt(k)));
            return own.every((p, i) => dist(p, pts[i]) < 1e-7) || own.every((p, i) => dist(p, pts[2 - i]) < 1e-7);
        });
        if (!same) {
            return null;
        }
        found.push(same);
    }
    return { shape: body, edges: found };
}
