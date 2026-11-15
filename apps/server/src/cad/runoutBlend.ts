// Chamfers and fillets on straight edges between flat faces, cut as a solid that runs out past the edge's ends.
// OpenCascade's blend builder follows an edge round the tangent corner of an earlier fillet or chamfer it ends on, and
// fails there when the new blend is larger than the earlier one (the blend would have to fold inside the corner). Like
// SolidWorks, the blend is made instead along each straight edge and let run out into the earlier blend: a prism with
// the blend's cross-section, longer than the edge where the edge carries on round the corner, is cut from the body.
// Where two such prisms meet in a corner they leave a mitre, as two chamfers or rounds that run into each other do.

import { cast, getOC, localGC, type Edge, type Face, type Shape3D } from 'replicad';

export type RunoutBlend =
    | { kind: 'fillet'; radius: number }
    /** distances[0] on `reference`'s side (else on the first face of each edge). */
    | { kind: 'chamfer'; distances: [number, number]; reference?: (edge: Edge) => Face }
    /** `distance` on `reference`'s side, the chamfer face at `angle` degrees to that face. */
    | { kind: 'chamfer'; distance: number; angle: number; reference?: (edge: Edge) => Face };

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => mul(a, 1 / (len(a) || 1));

/* eslint-disable @typescript-eslint/no-explicit-any */
type OC = any;

const SAME_POINT = 1e-6;
const SMOOTH_COS = Math.cos(Math.PI / 180);

const vec = (v: { x: number; y: number; z: number; delete(): void }): V => {
    const out: V = [v.x, v.y, v.z];
    v.delete();
    return out;
};

interface Straight {
    edge: Edge;
    from: V;
    to: V;
    /** Faces on either side with their outward normals, and the directions from the edge into each face. */
    faces: [Face, Face];
    normals: [V, V];
    into: [V, V];
    /** Whether the blend carries on tangentially past each end (onto an earlier blend's edge). */
    carries: [boolean, boolean];
}

function orientationIn(oc: OC, face: Face, edge: Edge): string | null {
    const ex = new oc.TopExp_Explorer(face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    try {
        for (; ex.More(); ex.Next()) {
            if (ex.Current().IsSame(edge.wrapped)) {
                return ex.Current().Orientation();
            }
        }
        return null;
    } finally {
        ex.delete();
    }
}

function planeNormal(face: Face, at: V): V {
    return unit(vec(face.normalAt(at)));
}

/** The edges plus the edges that continue them tangentially (as OpenCascade takes them). */
function tangentChain(shape: Shape3D, edges: Edge[]): Edge[] {
    const all = shape.edges;
    const ends = all.map((e) => {
        if (e.isClosed) {
            return null;
        }
        try {
            const t0 = unit(vec(e.tangentAt(0)));
            const t1 = unit(vec(e.tangentAt(1)));
            return [{ p: vec(e.pointAt(0)), out: mul(t0, -1) }, { p: vec(e.pointAt(1)), out: t1 }];
        } catch {
            return null;
        }
    });
    const chosen = new Set(edges.map((e) => all.findIndex((x) => x.isSame(e))).filter((i) => i >= 0));
    const queue = [...chosen];
    while (queue.length) {
        const i = queue.pop()!;
        for (const a of ends[i] ?? []) {
            all.forEach((_, j) => {
                if (!chosen.has(j) && (ends[j] ?? []).some((b) => len(sub(a.p, b.p)) < SAME_POINT && dot(a.out, b.out) <= -SMOOTH_COS)) {
                    chosen.add(j);
                    queue.push(j);
                }
            });
        }
    }
    return [...chosen].map((i) => all[i]);
}

/**
 * The body with the blend cut along the straight edges of the chain and run out past their ends, or null when this
 * way does not apply: an edge of the chain is curved and not the tangent corner of an earlier blend between straight
 * edges, or not between two flat faces, or the edge is concave.
 */
export function runoutBlend(shape: Shape3D, edges: Edge[], blend: RunoutBlend): Shape3D | null {
    const oc = getOC() as OC;
    const chain = tangentChain(shape, edges);
    const straights: Straight[] = [];
    const curved: Edge[] = [];
    for (const edge of chain) {
        if (edge.geomType !== 'LINE') {
            curved.push(edge);
            continue;
        }
        const faces = shape.faces.filter((f) => f.edges.some((e) => e.isSame(edge)));
        if (faces.length !== 2 || faces.some((f) => f.geomType !== 'PLANE')) {
            return null;
        }
        const from = vec(edge.pointAt(0));
        const to = vec(edge.pointAt(1));
        const t = unit(sub(to, from));
        const mid = mul(add(from, to), 0.5);
        const normals = faces.map((f) => planeNormal(f, mid)) as [V, V];
        // A face lies to the left of its edges as oriented in it, seen from outside: into = n x t (edge forward).
        const into = faces.map((f, k) => {
            const forward = orientationIn(oc, f, edge) === oc.TopAbs_Orientation.TopAbs_FORWARD;
            return unit(mul(cross(normals[k], t), forward ? 1 : -1));
        }) as [V, V];
        if (!(dot(into[0], normals[1]) < -1e-9)) {
            return null; // concave or flat: not a cut
        }
        straights.push({ edge, from, to, faces: faces as [Face, Face], normals, into, carries: [false, false] });
    }
    if (!straights.length) {
        return null;
    }
    // Curved edges must be corners joining the chain's straight edges, which then carry on through them.
    const ends = (e: Edge): [V, V] => [vec(e.pointAt(0)), vec(e.pointAt(1))];
    const touching = (p: V): Straight[] => straights.filter((s) => len(sub(s.from, p)) < SAME_POINT || len(sub(s.to, p)) < SAME_POINT);
    for (const c of curved) {
        const [p0, p1] = ends(c);
        const linked = (p: V): boolean => touching(p).length > 0
            || curved.some((o) => o !== c && ends(o).some((q) => len(sub(q, p)) < SAME_POINT));
        if (!linked(p0) || !linked(p1)) {
            return null;
        }
        for (const p of [p0, p1]) {
            for (const s of touching(p)) {
                s.carries[len(sub(s.from, p)) < SAME_POINT ? 0 : 1] = true;
            }
        }
    }
    // An end where the other faces all fall away from the edge (an earlier chamfer, or the end of the part) is run out
    // too; an end against a face that rises across the edge's path (a wall) is not.
    for (const s of straights) {
        const t = unit(sub(s.to, s.from));
        ([[s.from, mul(t, -1)], [s.to, t]] as [V, V][]).forEach(([p, out], k) => {
            if (s.carries[k]) {
                return;
            }
            const at = shape.faces.filter((f) => !f.isSame(s.faces[0]) && !f.isSame(s.faces[1])
                && f.edges.some((e) => ends(e).some((q) => len(sub(q, p)) < SAME_POINT)));
            s.carries[k] = at.length > 0 && at.every((f) => {
                try {
                    return dot(unit(vec(f.normalAt(p))), out) > 0.01;
                } catch {
                    return false;
                }
            });
        });
    }
    const [r, gc] = localGC();
    try {
        const tools: Shape3D[] = straights.map((s) => prism(oc, r as <T>(x: T) => T, s, blend, curved));
        let cut = shape;
        let tool = tools[0];
        for (const t of tools.slice(1)) {
            tool = tool.fuse(t) as Shape3D;
        }
        cut = shape.cut(tool) as Shape3D;
        const solids = cut.solids ?? [];
        if (solids.length !== 1) {
            return null;
        }
        const out = solids[0];
        const check = new oc.BRepCheck_Analyzer(out.wrapped, true, false);
        const ok = check.IsValid();
        check.delete();
        return ok ? out : null;
    } catch {
        return null;
    } finally {
        gc();
    }
}

/** The cutting prism of one straight edge: the blend's cross-section, closed outside the body, along the edge. */
function prism(oc: OC, r: <T>(x: T) => T, s: Straight, blend: RunoutBlend, corners: Edge[]): Shape3D {
    const t = unit(sub(s.to, s.from));
    const [n1, n2] = s.normals;
    const [m1, m2] = s.into;
    let refIs0 = true;
    if (blend.kind === 'chamfer' && blend.reference) {
        refIs0 = blend.reference(s.edge).isSame(s.faces[0]);
    }
    // The size reached across the corner, to run the prism out past a carried-on end.
    let reach: number;
    // The cross-section, in the plane across the edge at its start.
    const P = s.from;
    const outward = unit(add(n1, n2));
    let section: OC;
    // The blend's two edges, at a and b in the start section, must lie on the faces along the edge (else it is larger
    // than a face beside the edge, and does not fit).
    const fits = (a: V, b: V): void => {
        const along = sub(s.to, s.from);
        for (const k of [0.25, 0.5, 0.75]) {
            for (const [p, face] of [[add(a, mul(along, k)), s.faces[0]], [add(b, mul(along, k)), s.faces[1]]] as [V, Face][]) {
                const v = r(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, r, p))).Vertex();
                const dss = r(new oc.BRepExtrema_DistShapeShape());
                dss.LoadS1(v);
                dss.LoadS2(face.wrapped);
                dss.Perform(r(new oc.Message_ProgressRange()));
                if (!dss.IsDone() || dss.Value() > 1e-6) {
                    throw new Error('the blend is larger than a face beside the edge');
                }
            }
        }
    };
    if (blend.kind === 'fillet') {
        const rad = blend.radius;
        const c = sub(P, mul(add(n1, n2), rad / (1 + dot(n1, n2))));
        const a = add(c, mul(n1, rad));
        const b = add(c, mul(n2, rad));
        fits(a, b);
        reach = len(sub(a, P)) + rad;
        // A and B go out along the faces' normals, round the outside, and the arc closes it past the corner.
        const aOut = add(a, mul(n1, rad));
        const bOut = add(b, mul(n2, rad));
        const far = add(P, mul(outward, 2 * reach));
        const mid = add(c, mul(unit(sub(P, c)), rad));
        const arc = r(new oc.GC_MakeArcOfCircle(pnt(oc, r, a), pnt(oc, r, mid), pnt(oc, r, b))).Value();
        const wire = r(new oc.BRepBuilderAPI_MakeWire());
        wire.Add(r(new oc.BRepBuilderAPI_MakeEdge(arc)).Edge());
        for (const [p, q] of [[b, bOut], [bOut, far], [far, aOut], [aOut, a]] as [V, V][]) {
            wire.Add(r(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, r, p), pnt(oc, r, q))).Edge());
        }
        section = wire.Wire();
    } else {
        let first: number;
        let second: number;
        if ('distances' in blend) {
            [first, second] = refIs0 ? blend.distances : [blend.distances[1], blend.distances[0]];
        } else {
            const between = Math.acos(Math.max(-1, Math.min(1, dot(m1, m2))));
            const third = Math.PI - between - blend.angle * Math.PI / 180;
            if (!(third > 1e-3)) {
                throw new Error('the chamfer does not reach the other face');
            }
            const other = blend.distance * Math.sin(blend.angle * Math.PI / 180) / Math.sin(third);
            [first, second] = refIs0 ? [blend.distance, other] : [other, blend.distance];
        }
        const a = add(P, mul(m1, first));
        const b = add(P, mul(m2, second));
        fits(a, b);
        reach = Math.max(first, second);
        const ab = unit(sub(b, a));
        const aOut = sub(a, mul(ab, 0.25 * reach));
        const bOut = add(b, mul(ab, 0.25 * reach));
        const far = add(P, mul(outward, 2 * reach));
        const wire = r(new oc.BRepBuilderAPI_MakeWire());
        for (const [p, q] of [[aOut, bOut], [bOut, far], [far, aOut]] as [V, V][]) {
            wire.Add(r(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, r, p), pnt(oc, r, q))).Edge());
        }
        section = wire.Wire();
    }
    // Run out past ends that carry on into an earlier blend: far enough to clear it (it is smaller than this blend, or
    // OpenCascade would have made this one).
    const cornerSize = Math.max(0, ...corners.map((c) => c.length));
    const runout = 4 * reach + cornerSize;
    const start = s.carries[0] ? -runout : 0;
    const length = len(sub(s.to, s.from)) + (s.carries[0] ? runout : 0) + (s.carries[1] ? runout : 0);
    const face = r(new oc.BRepBuilderAPI_MakeFace(section, true)).Face();
    const move = r(new oc.gp_Trsf());
    move.SetTranslation(r(new oc.gp_Vec(...mul(t, start))));
    const placed = r(new oc.BRepBuilderAPI_Transform(face, move, true, false)).Shape();
    const made = r(new oc.BRepPrimAPI_MakePrism(placed, r(new oc.gp_Vec(...mul(t, length))), false, true)).Shape();
    return cast(made) as Shape3D;
}

function pnt(oc: OC, r: <T>(x: T) => T, p: V): OC {
    return r(new oc.gp_Pnt(p[0], p[1], p[2]));
}
