// Model geometry for a sketch: the body's edges projected onto a sketch plane as exact sketch curves (Convert
// Entities, snapping), where the plane cuts the body (Intersection Curve) and its outline seen along the plane
// normal (Silhouette Entities). Kernel only; the curve maths is shared in @jarvis/core/projection.

import { getOC, iterTopo, localGC, makePolygon, Edge, Face, Vertex, type Shape3D } from 'replicad';
import type { Vec3 } from '@jarvis/core';
import {
    heightAbove, joinCurves, KIND_TOLERANCE, projectConic, projectLine, projectPoint, projectSpline, spaceCircle, splineCurves, tidy,
    type ModelCurve, type ModelQuery, type ModelSketch, type P2, type PlaneFrame3, type Skipped, type TaggedCurve,
} from '@jarvis/core/projection';
import { resolveEdges, resolveFaces } from './refs.js';
import { errorMessage } from './build.js';

type OC = ReturnType<typeof getOC>;
type Pnt = { X(): number; Y(): number; Z(): number };
const xyz = (p: Pnt): Vec3 => [p.X(), p.Y(), p.Z()];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

const KIND_NAME: Record<string, string> = {
    GeomAbs_Hyperbola: 'hyperbola', GeomAbs_Parabola: 'parabola', GeomAbs_BezierCurve: 'Bezier curve',
    GeomAbs_BSplineCurve: 'spline', GeomAbs_OffsetCurve: 'offset curve', GeomAbs_OtherCurve: 'curve',
};

/** Seam edges (where a closed surface meets itself) and degenerate ones (a cone's apex): not real outlines. */
function hiddenEdges(shape: Shape3D): Edge[] {
    const oc = getOC();
    const out: Edge[] = [];
    for (const face of shape.faces) {
        for (const edge of face.edges) {
            if (oc.BRep_Tool.IsClosed(edge.wrapped, face.wrapped) || oc.BRep_Tool.Degenerated(edge.wrapped)) {
                out.push(edge);
            }
        }
    }
    return out;
}

/** The B-spline poles, weights and full knot sequence of any bounded curve between two parameters. */
function bsplineOf(oc: OC, adaptor: InstanceType<OC['BRepAdaptor_Curve']>, first: number, last: number): {
    poles: Vec3[]; weights: number[] | null; knots: number[]; degree: number;
} {
    const [r, gc] = localGC();
    try {
        const trsf = r(adaptor.Trsf());
        const trimmed = r(new oc.Geom_TrimmedCurve(adaptor.GeomCurve(), first, last, true, true));
        const bs = r(oc.GeomConvert.CurveToBSplineCurve(trimmed));
        if (bs.IsPeriodic()) {
            bs.SetNotPeriodic();
        }
        const poles: Vec3[] = [];
        const weights: number[] = [];
        for (let i = 1; i <= bs.NbPoles(); i++) {
            poles.push(xyz(r(r(bs.Pole(i)).Transformed(trsf))));
            weights.push(bs.Weight(i));
        }
        const knots: number[] = [];
        for (let i = 1; i <= bs.NbKnots(); i++) {
            for (let m = 0; m < bs.Multiplicity(i); m++) {
                knots.push(bs.Knot(i));
            }
        }
        return { poles, weights: bs.IsRational() ? weights : null, knots, degree: bs.Degree() };
    } finally {
        gc();
    }
}

/**
 * Deviation within which a spline edge counts as a line, circle or arc: the app's 1e-6 mm, or the edge's own
 * tolerance where the kernel made it less exactly than that (an intersection curve is approximated to its tolerance),
 * up to KIND_TOLERANCE_MAX.
 */
export const KIND_TOLERANCE_MAX = 1e-5;

export function kindTolerance(edge: Edge): number {
    return Math.min(KIND_TOLERANCE_MAX, Math.max(KIND_TOLERANCE, getOC().BRep_Tool.Tolerance(edge.wrapped)));
}

/**
 * An edge projected onto the plane as the simplest exact sketch curves: a spline edge that is straight or round (a
 * loft makes every edge a spline) as a line, circle or arc, or as the exact ellipse of a circle seen at a tilt
 * (@jarvis/core/curveKinds); [] when it is seen end-on; a reason when it has none.
 */
export function edgeCurves(edge: Edge, f: PlaneFrame3): ModelCurve[] | { why: string } {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const a = r(new oc.BRepAdaptor_Curve(edge.wrapped));
        const type = a.GetType() as string;
        const [t0, t1] = [a.FirstParameter(), a.LastParameter()];
        if (type === 'GeomAbs_Line') {
            const line = projectLine(f, xyz(r(a.Value(t0))), xyz(r(a.Value(t1))));
            return line ? [line] : [];
        }
        if (type === 'GeomAbs_Circle' || type === 'GeomAbs_Ellipse') {
            const conic = type === 'GeomAbs_Circle' ? r(a.Circle()) : r(a.Ellipse());
            const [r1, r2] = type === 'GeomAbs_Circle'
                ? [(conic as InstanceType<OC['gp_Circ']>).Radius(), (conic as InstanceType<OC['gp_Circ']>).Radius()]
                : [(conic as InstanceType<OC['gp_Elips']>).MajorRadius(), (conic as InstanceType<OC['gp_Elips']>).MinorRadius()];
            const centre = xyz(r(conic.Location()));
            const X = scale(xyz(r(r(conic.XAxis()).Direction())), r1);
            const Y = scale(xyz(r(r(conic.YAxis()).Direction())), r2);
            const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9;
            const curve = projectConic(f, centre, X, Y, t0, t1, full);
            return curve ? [curve] : [];
        }
        if (type === 'GeomAbs_OffsetCurve' || type === 'GeomAbs_OtherCurve') {
            return { why: `an ${KIND_NAME[type]} has no exact sketch curve` };
        }
        const s = bsplineOf(oc, a, t0, t1);
        const tolerance = kindTolerance(edge);
        const round = spaceCircle(s.poles, s.weights, s.knots, s.degree, tolerance);
        if (round) {
            const conic = projectConic(f, round.centre, round.X, round.Y, 0, round.sweep, round.full);
            return conic ? [conic] : [];
        }
        const curves = splineCurves(projectSpline(f, s.poles, s.weights, s.knots, s.degree), tolerance);
        return curves ?? { why: `a rational ${KIND_NAME[type] ?? 'curve'} of degree ${s.degree} has no exact sketch curve` };
    } catch (e) {
        return { why: `could not be read (${e instanceof Error ? e.message : String(e)})` };
    } finally {
        gc();
    }
}

const edgeName = (index: number, what?: string): string => `edge ${index + 1}${what ? ` of ${what}` : ''}`;

function pushEdge(out: ModelSketch, edge: Edge, index: number, f: PlaneFrame3, tag: { face?: number; loop?: number }, what?: string): void {
    const curves = edgeCurves(edge, f);
    if ('why' in curves) {
        out.skipped.push({ what: edgeName(index, what), why: curves.why });
        return;
    }
    out.curves.push(...curves.map((c) => ({ ...c, ...tag, edge: index }) as TaggedCurve));
}

/**
 * Joins the curves of each loop (or section) that continue one another into one line, arc or circle: a circle the
 * kernel split into arcs, a straight side split where the faces beside it change.
 */
function joinLoops(out: ModelSketch, from: number, tolerance: number): void {
    const joined = joinCurves(out.curves.slice(from), tolerance, (c) => `${c.face ?? ''} ${c.loop ?? ''}`);
    out.curves.splice(from, out.curves.length - from, ...joined);
}

/** The projected vertices of a shape, each once. */
function vertexPoints(shape: { wrapped: unknown }, f: PlaneFrame3): P2[] {
    const out: P2[] = [];
    for (const v of iterTopo(shape.wrapped as never, 'vertex')) {
        const vertex = new Vertex(v);
        const [u, w] = projectPoint(f, vertex.asTuple());
        vertex.delete();
        const p: P2 = [tidy(u), tidy(w)];
        if (!out.some((q) => Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9)) {
            out.push(p);
        }
    }
    return out;
}

/** Every edge and vertex of the body, projected (snapping, and the edges Convert Entities can pick). */
export function projectEdges(shape: Shape3D, f: PlaneFrame3): ModelSketch {
    const out: ModelSketch = { curves: [], points: vertexPoints(shape, f), skipped: [] };
    const hidden = hiddenEdges(shape);
    shape.edges.forEach((edge, index) => {
        if (!hidden.some((h) => h.isSame(edge))) {
            pushEdge(out, edge, index, f, {});
        }
    });
    return out;
}

/** The picked edges and the loops of the picked faces (loop 0 the outer one), projected. */
export function convertPicks(shape: Shape3D, f: PlaneFrame3, edges: Vec3[], faces: { at: Vec3; normal?: Vec3 }[]): ModelSketch {
    const out: ModelSketch = { curves: [], points: [], skipped: [], loops: [] };
    const all = shape.edges;
    const indexOf = (e: Edge): number => all.findIndex((x) => x.isSame(e));
    const hidden = hiddenEdges(shape);
    for (const edge of resolveEdges(shape, edges)) {
        pushEdge(out, edge, indexOf(edge), f, {});
    }
    // Picked edges stay one entity each; a face's loops join where their edges continue one another.
    const from = out.curves.length;
    let tolerance = KIND_TOLERANCE;
    resolveFaces(shape, faces).forEach((face, k) => {
        const loops = [face.clone().outerWire(), ...face.clone().innerWires()];
        out.loops!.push(loops.length);
        loops.forEach((wire, j) => {
            for (const edge of wire.edges) {
                if (!hidden.some((h) => h.isSame(edge))) {
                    tolerance = Math.max(tolerance, kindTolerance(edge));
                    pushEdge(out, edge, indexOf(edge), f, { face: k, loop: j }, j === 0 ? `the outer loop of face ${k + 1}` : `inner loop ${j} of face ${k + 1}`);
                }
            }
        });
    });
    joinLoops(out, from, tolerance);
    return out;
}

function planeOf(oc: OC, f: PlaneFrame3): InstanceType<OC['gp_Pln']> {
    const [r, gc] = localGC();
    try {
        return new oc.gp_Pln(r(new oc.gp_Pnt(...f.origin)), r(new oc.gp_Dir(...f.n)));
    } finally {
        gc();
    }
}

/** Edges of a compound or any shape. */
function edgesOf(shape: unknown): Edge[] {
    return Array.from(iterTopo(shape as never, 'edge'), (e) => new Edge(e));
}

/** Where the sketch plane cuts the picked faces, or the whole body (Intersection Curve). */
export function sectionCurves(shape: Shape3D, f: PlaneFrame3, faces: { at: Vec3; normal?: Vec3 }[]): ModelSketch {
    const oc = getOC();
    const [r, gc] = localGC();
    const out: ModelSketch = { curves: [], points: [], skipped: [] };
    let tolerance = KIND_TOLERANCE;
    try {
        const targets = faces.length ? resolveFaces(shape, faces) : [shape];
        const plane = r(planeOf(oc, f));
        targets.forEach((target, k) => {
            const section = r(new oc.BRepAlgoAPI_Section(target.wrapped, plane, false));
            section.Approximation(true);
            section.Build(r(new oc.Message_ProgressRange()));
            if (!section.IsDone()) {
                out.skipped.push({ what: faces.length ? `face ${k + 1}` : 'the body', why: 'the section could not be computed' });
                return;
            }
            edgesOf(section.Shape()).forEach((edge, i) => {
                const curves = edgeCurves(edge, f);
                tolerance = Math.max(tolerance, kindTolerance(edge));
                if ('why' in curves) {
                    out.skipped.push({ what: `section curve ${i + 1}${faces.length ? ` of face ${k + 1}` : ''}`, why: curves.why });
                } else {
                    out.curves.push(...curves.map((c) => (faces.length ? { ...c, face: k } : c) as TaggedCurve));
                }
            });
        });
        joinLoops(out, 0, tolerance);
        return out;
    } finally {
        gc();
    }
}

/** Whether the straight line through sketch point p along the plane normal meets the body. */
function lineHitsBody(shape: Shape3D, f: PlaneFrame3, p: P2, reach: number): boolean {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const at = (h: number): Vec3 => [0, 1, 2].map((i) => f.origin[i] + f.u[i] * p[0] + f.v[i] * p[1] + f.n[i] * h) as Vec3;
        const a = at(-reach);
        const b = at(reach);
        const edge = r(new oc.BRepBuilderAPI_MakeEdge(r(new oc.gp_Pnt(...a)), r(new oc.gp_Pnt(...b)))).Edge();
        const tool = r(new oc.BRepExtrema_DistShapeShape());
        tool.LoadS1(edge);
        tool.LoadS2(shape.wrapped);
        return tool.Perform(r(new oc.Message_ProgressRange())) && tool.IsDone() && tool.Value() < 1e-7;
    } finally {
        gc();
    }
}

/** A point well inside a planar face: the centroid of its largest mesh triangle. */
function insidePoint(face: Face, f: PlaneFrame3): P2 | null {
    const mesh = face.triangulation(0);
    if (!mesh || mesh.trianglesIndexes.length < 3) {
        return null;
    }
    let best: P2 | null = null;
    let area = -1;
    const v = mesh.vertices;
    for (let t = 0; t + 2 < mesh.trianglesIndexes.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => projectPoint(f, [v[mesh.trianglesIndexes[t + k] * 3], v[mesh.trianglesIndexes[t + k] * 3 + 1], v[mesh.trianglesIndexes[t + k] * 3 + 2]]));
        const s = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
        if (s > area) {
            area = s;
            best = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
        }
    }
    return best;
}

/**
 * The outline of the body seen along the plane normal (Silhouette Entities). The hidden-line algorithm gives every
 * sharp edge and outline seen that way; they cut a large face on the sketch plane into regions, the regions the body
 * covers are joined, and the boundary of what they cover is the silhouette (external: its outer loops only).
 */
export function silhouetteCurves(shape: Shape3D, f: PlaneFrame3, external: boolean): ModelSketch {
    const oc = getOC();
    const [r, gc] = localGC();
    const out: ModelSketch = { curves: [], points: [], skipped: [] };
    let stage = 'the hidden lines';
    try {
        const box = shape.boundingBox;
        const [lo, hi] = box.bounds;
        box.delete();
        const reach = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + Math.abs(heightAbove(f, lo)) + Math.abs(heightAbove(f, hi)) + 1;
        // The projector looks down the normal; its x and y are the sketch u and v.
        const ax2 = r(new oc.gp_Ax2(r(new oc.gp_Pnt(...f.origin)), r(new oc.gp_Dir(...f.n)), r(new oc.gp_Dir(...f.u))));
        const projector = r(new oc.HLRAlgo_Projector(ax2));
        const algo = r(new oc.HLRBRep_Algo());
        algo.Add(shape.wrapped, 0);
        algo.Projector(projector);
        algo.Update();
        algo.Hide();
        const hlr = r(new oc.HLRBRep_HLRToShape(algo));
        // Projected edges come in the projector's own (x, y) plane; place them on the sketch plane.
        const place = r(new oc.gp_Trsf());
        place.SetTransformation(r(new oc.gp_Ax3(ax2)), r(new oc.gp_Ax3()));
        stage = 'placing the outline';
        const flat: Edge[] = [];
        for (const part of [hlr.VCompound(), hlr.HCompound(), hlr.OutLineVCompound(), hlr.OutLineHCompound(), hlr.Rg1LineVCompound(), hlr.Rg1LineHCompound()]) {
            if (!part || part.IsNull()) {
                continue;
            }
            // The hidden-line edges are 2D curves on the projection plane: give them 3D curves (exact on a plane).
            oc.BRepLib.BuildCurves3d(part);
            const moved = r(new oc.BRepBuilderAPI_Transform(part, place, true, false)).Shape();
            flat.push(...edgesOf(moved));
        }
        if (!flat.length) {
            return out;
        }
        stage = 'cutting the plane into regions';
        // A face on the sketch plane well past the outline, cut by the projected edges into regions.
        const big = reach * 4;
        const corners: Vec3[] = [[-big, -big], [big, -big], [big, big], [-big, big]].map(([u, v]) =>
            [0, 1, 2].map((i) => f.origin[i] + f.u[i] * u + f.v[i] * v) as Vec3);
        const sheet = r(makePolygon(corners)).wrapped;
        const objects = r(new oc.NCollection_List_TopoDS_Shape());
        objects.Append(sheet);
        const tools = r(new oc.NCollection_List_TopoDS_Shape());
        for (const e of flat) {
            tools.Append(e.wrapped);
        }
        const splitter = r(new oc.BRepAlgoAPI_Splitter());
        splitter.SetArguments(objects);
        splitter.SetTools(tools);
        splitter.Build(r(new oc.Message_ProgressRange()));
        if (!splitter.IsDone()) {
            out.skipped.push({ what: 'the silhouette', why: 'the outline could not be cut into regions' });
            return out;
        }
        stage = 'finding the covered regions';
        const regions = Array.from(iterTopo(splitter.Shape(), 'face'), (x) => new Face(x));
        getOC().BRepTools.Clean(splitter.Shape(), true);
        r(new oc.BRepMesh_IncrementalMesh(splitter.Shape(), Math.max(1e-3, reach * 1e-3), false, 0.5, false));
        const covered = regions.filter((face) => {
            const p = insidePoint(face, f);
            return !!p && lineHitsBody(shape, f, p, reach);
        });
        if (!covered.length) {
            return out;
        }
        stage = 'joining the regions';
        // Join the covered regions and keep the boundary of the union.
        let joined = covered[0].wrapped as unknown;
        for (const face of covered.slice(1)) {
            const fuse = r(new oc.BRepAlgoAPI_Fuse(joined as never, face.wrapped, r(new oc.Message_ProgressRange())));
            joined = fuse.Shape();
        }
        const unify = r(new oc.ShapeUpgrade_UnifySameDomain(joined as never, true, true, false));
        unify.Build();
        const result = Array.from(iterTopo(unify.Shape(), 'face'), (x) => new Face(x));
        let tolerance = KIND_TOLERANCE;
        result.forEach((face, k) => {
            const loops = external ? [face.clone().outerWire()] : [face.clone().outerWire(), ...face.clone().innerWires()];
            loops.forEach((wire, j) => {
                wire.edges.forEach((edge, i) => {
                    const curves = edgeCurves(edge, f);
                    tolerance = Math.max(tolerance, kindTolerance(edge));
                    if ('why' in curves) {
                        out.skipped.push({ what: `outline piece ${i + 1}${j ? ` of inner loop ${j}` : ''}`, why: curves.why });
                    } else {
                        out.curves.push(...curves.map((c) => ({ ...c, face: k, loop: j }) as TaggedCurve));
                    }
                });
            });
        });
        joinLoops(out, 0, tolerance);
        return out;
    } catch (e) {
        out.skipped.push({ what: 'the silhouette', why: `${stage} failed (${errorMessage(e)})` });
        return out;
    } finally {
        gc();
    }
}

/** Where the picked edges pass through the sketch plane (Pierce): the crossing points, in (u, v). */
export function piercePoints(shape: Shape3D, f: PlaneFrame3, picks: Vec3[]): ModelSketch {
    const oc = getOC();
    const [r, gc] = localGC();
    const out: ModelSketch = { curves: [], points: [], skipped: [] };
    try {
        const plane = r(planeOf(oc, f));
        const all = shape.edges;
        for (const edge of resolveEdges(shape, picks)) {
            const index = all.findIndex((x) => x.isSame(edge));
            const section = r(new oc.BRepAlgoAPI_Section(edge.wrapped, plane, false));
            section.Build(r(new oc.Message_ProgressRange()));
            const found = section.IsDone() ? vertexPoints({ wrapped: section.Shape() }, f) : [];
            if (edgesOf(section.Shape()).length) {
                out.skipped.push({ what: edgeName(index), why: 'it lies in the sketch plane, so it does not pierce it' });
                continue;
            }
            if (!found.length) {
                out.skipped.push({ what: edgeName(index), why: 'it does not pass through the sketch plane' });
            }
            for (const p of found) {
                if (!out.points.some((q) => Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9)) {
                    out.points.push(p);
                }
            }
        }
        return out;
    } finally {
        gc();
    }
}

/** Answers a model query for the body as built so far (null: no body yet). */
export function modelSketch(shape: Shape3D | null, f: PlaneFrame3, query: ModelQuery): ModelSketch {
    if (!shape) {
        return { curves: [], points: [], skipped: [] };
    }
    switch (query.kind) {
        case 'edges':
            return projectEdges(shape, f);
        case 'convert':
            return convertPicks(shape, f, query.edges, query.faces);
        case 'section':
            return sectionCurves(shape, f, query.faces);
        case 'silhouette':
            return silhouetteCurves(shape, f, query.external);
        case 'pierce':
            return piercePoints(shape, f, query.edges);
        case 'planeFaces':
            return planeFaceLoops(shape, f);
    }
}

/** Distance (mm) within which a face counts as lying in the sketch plane. */
const ON_PLANE = 1e-6;

/** The loops of the flat faces that lie in the sketch plane, each tagged with its face and loop (loop 0 outer). */
export function planeFaceLoops(shape: Shape3D, f: PlaneFrame3): ModelSketch {
    const out: ModelSketch = { curves: [], points: [], skipped: [], loops: [] };
    const all = shape.edges;
    const indexOf = (e: Edge): number => all.findIndex((x) => x.isSame(e));
    const hidden = hiddenEdges(shape);
    let k = 0;
    for (const face of shape.faces) {
        if (face.geomType !== 'PLANE') {
            continue;
        }
        const n = face.normalAt();
        const along = Math.abs(n.x * f.n[0] + n.y * f.n[1] + n.z * f.n[2]);
        const centre = face.center;
        n.delete();
        const at: Vec3 = [centre.x, centre.y, centre.z];
        centre.delete();
        const corners = Array.from(iterTopo(face.wrapped as never, 'vertex'), (v) => {
            const vertex = new Vertex(v);
            const p = vertex.asTuple();
            vertex.delete();
            return p;
        });
        if (along < 1 - 1e-9 || [at, ...corners].some((p) => Math.abs(heightAbove(f, p)) > ON_PLANE)) {
            continue;
        }
        const loops = [face.clone().outerWire(), ...face.clone().innerWires()];
        out.loops!.push(loops.length);
        loops.forEach((wire, j) => {
            for (const edge of wire.edges) {
                if (!hidden.some((h) => h.isSame(edge))) {
                    pushEdge(out, edge, indexOf(edge), f, { face: k, loop: j }, j === 0 ? `the outer loop of face ${k + 1}` : `inner loop ${j} of face ${k + 1}`);
                }
            }
        });
        k += 1;
    }
    return out;
}

export type { Skipped };
