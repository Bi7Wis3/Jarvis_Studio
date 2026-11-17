// Applied features on RESOLVED entities (see refs.ts): fillet, chamfer, shell and draft of picked edges and faces.
// build.ts resolves the stored picks and calls these; each turns OpenCascade failures into a message with a hint.
//
// What OpenCascade (through replicad) can and cannot do here:
// - Fillet: constant radius, or a radius varying linearly from the edge's start to its end (BRepFilletAPI_MakeFillet
//   Add(R1, R2, E)); OC also takes a law or (parameter, radius) pairs per edge, not wrapped here. The cross-section is
//   always circular: ChFi3d_Rational / QuasiAngular / Polynomial only change how the circle is approximated, so
//   conic (rho) and curvature-continuous profiles, setbacks and overflow control are not available.
// - Chamfer: equal distance, two distances, distance + angle (both measured from a reference face of the edge).
// - An edge flagged as a smooth join of its faces where they really meet at an angle (left so by an earlier step) is
//   refused or skipped by OpenCascade's builder; such flags are cleared first (edgeContinuity.ts).
// - When OpenCascade's blend builder fails, constant fillets and chamfers are made another way where that applies:
//   along closed loops by rolling the blend section by section (loopBlend.ts: a hole leaving a curved surface at a
//   shallow angle), on straight edges between flat faces as a cut that runs out into an earlier blend
//   (runoutBlend.ts), and on any chain of edges from the blend's true sections, cut away or joined on
//   (sectionBlend.ts; where two chains meet at a vertex the corner is where their blends intersect). A failure says
//   where and why when it can tell, and calls the size too large only when OpenCascade does make the blend at a tenth
//   of it.
// - Shell: inward or outward walls with faces removed (MakeThickSolid); a closed hollow body is made by cutting the
//   offset body away (as build.ts does; MakeThickSolid with an empty face list is version dependent). One
//   thickness for all walls: per-face thickness would need BRepOffset_MakeOffset directly (not wrapped).
// - Draft: picked faces about a neutral plane, pull direction = the plane normal (BRepOffsetAPI_DraftAngle); faces
//   must meet the neutral plane or their neighbours cleanly, angles well under 45°.

import { cast, getOC, measureVolume, Plane, type ChamferRadius, type Edge, type Face, type Shape3D } from 'replicad';
import type { Vec3 } from '@jarvis/core';
import { faceAngleAlong, falselySmooth, withCornersReset } from './edgeContinuity.js';
import { blendLoop, closedLoops, LoopBlendError, type LoopBlend } from './loopBlend.js';
import { insideCorner, runoutBlend, type RunoutBlend } from './runoutBlend.js';
import { overflowsFace, sectionBlend, SectionBlendError, type SectionBlend } from './sectionBlend.js';

/** How a blend was made: OpenCascade's builder (after clearing false smooth flags), or a fallback. */
export type BlendWay = 'kernel' | 'kernel after flags' | 'loop' | 'runout' | 'sections';

/**
 * For measuring (tools/blendCorpus.ts): told how each fillet or chamfer was made; `old` leaves out the flag clearing
 * and the section blend.
 */
export const blendTap: { made: ((way: BlendWay) => void) | null; old: boolean } = { made: null, old: false };

/**
 * A fillet or chamfer that could not be made. `tooLarge`: OpenCascade does make it at a tenth of the size, so the size
 * is what stops it (build.ts may then suggest blending in another order).
 */
export class BlendError extends Error {
    constructor(message: string, readonly tooLarge: boolean) {
        super(message);
    }
}

export type FilletSpec =
    | { radius: number }
    /** Radius varying linearly along each edge: radii[0] at the end nearest `from` (else the edge's start). */
    | { radii: [number, number]; from?: Vec3 };

export type ChamferSpec =
    | { distance: number }
    /** distances[0] along the reference face, distances[1] along the other face. */
    | { distances: [number, number]; side?: Vec3 }
    /** `distance` along the reference face, `angle` (degrees) from it. */
    | { distance: number; angle: number; side?: Vec3 };

type V = [number, number, number];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: V, b: V): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function vecOf(v: { x: number; y: number; z: number; delete(): void }): V {
    const out: V = [v.x, v.y, v.z];
    v.delete();
    return out;
}

/** Readable message for a JS error or an OpenCascade (WebAssembly) exception. */
function ocMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    try {
        const [type, message] = (getOC() as unknown as { getExceptionMessage(e: unknown): [string, string] })
            .getExceptionMessage(error);
        return `OpenCascade ${type}${message ? `: ${message}` : ''}`;
    } catch {
        return String(error);
    }
}

function isValid(shape: Shape3D): boolean {
    const analyzer = new (getOC().BRepCheck_Analyzer)(shape.wrapped, true, false);
    const ok = analyzer.IsValid();
    analyzer.delete();
    return ok;
}

function solidOf(shape: unknown, what: string): Shape3D {
    const s = shape as Shape3D;
    if (!s || s.isNull || !s.solids || s.solids.length === 0) {
        throw new Error(`${what} produced no solid`);
    }
    return s.solids.length === 1 ? s.solids[0] : s;
}

const selects = (edges: Edge[]) => (edge: Edge): boolean => edges.some((e) => e.isSame(edge));

/** All edges of the faces, without duplicates (SolidWorks: picking a face rounds its edges). */
function edgesOfFaces(faces: Face[]): Edge[] {
    const out: Edge[] = [];
    for (const face of faces) {
        for (const edge of face.edges) {
            if (!out.some((e) => e.isSame(edge))) {
                out.push(edge);
            }
        }
    }
    return out;
}

/**
 * The body with the smooth-join flags of the edges cleared where their faces meet at an angle (OpenCascade refuses or
 * skips such edges), and the edges as found on it; the body unchanged when there are none.
 */
function withTrueCorners(shape: Shape3D, edges: Edge[]): { shape: Shape3D; edges: Edge[]; cleared: boolean } {
    if (!blendTap.old) {
        const wrong = falselySmooth(shape, edges);
        const reset = wrong.length ? withCornersReset(shape, wrong, edges) : null;
        if (reset) {
            return { ...reset, cleared: true };
        }
    }
    return { shape, edges, cleared: false };
}

function needEdges(edges: Edge[], what: string): void {
    if (edges.length === 0) {
        throw new Error(`${what}: no edges selected`);
    }
}

// ---- Fillet -------------------------------------------------------------------------------------------------

export function filletEdges(given: Shape3D, picked: Edge[], spec: FilletSpec): Shape3D {
    needEdges(picked, 'fillet');
    const { shape, edges, cleared } = withTrueCorners(given, picked);
    let radiusFor: (edge: Edge) => number | [number, number];
    let label: string;
    if ('radii' in spec) {
        const [r1, r2] = spec.radii;
        if (!(r1 > 0 && r2 > 0)) {
            throw new Error('fillet radii must be positive');
        }
        label = `variable fillet of ${r1} to ${r2} mm`;
        radiusFor = (edge) => {
            if (!spec.from) {
                return [r1, r2];
            }
            const from = [...spec.from] as V;
            const start = vecOf(edge.pointAt(0));
            const end = vecOf(edge.pointAt(1));
            return dist(start, from) <= dist(end, from) ? [r1, r2] : [r2, r1];
        };
    } else {
        if (!(spec.radius > 0)) {
            throw new Error('fillet radius must be positive');
        }
        label = `fillet of ${spec.radius} mm`;
        radiusFor = () => spec.radius;
    }
    const kernel = (body: Shape3D, on: Edge[], scale: number): Shape3D => {
        const chosen = selects(on);
        const result = solidOf(body.fillet((edge) => {
            if (!chosen(edge)) {
                return null;
            }
            const radius = radiusFor(edge);
            return typeof radius === 'number' ? radius * scale : [radius[0] * scale, radius[1] * scale];
        }), 'fillet');
        if (!isValid(result)) {
            throw new Error('the result is not a valid solid');
        }
        return result;
    };
    const constant = 'radius' in spec ? { kind: 'fillet' as const, radius: spec.radius } : null;
    return blendWithFallbacks(shape, edges, label, kernel, constant, constant, constant, cleared);
}

/** The angles between the faces along the edges (degrees, inside the material), for a failure message. */
function faceAngles(shape: Shape3D, edges: Edge[]): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (const edge of edges) {
        const faces = shape.faces.filter((f) => f.edges.some((e) => e.isSame(edge)));
        if (faces.length !== 2) {
            continue;
        }
        for (const k of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            try {
                const p = vecOf(edge.pointAt(k));
                const [a, b] = faces.map((f) => vecOf(f.normalAt(p)));
                const c = dot(a, b) / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
                const angle = 180 - Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
                lo = Math.min(lo, angle);
                hi = Math.max(hi, angle);
            } catch {
                // a degenerate point: skip it
            }
        }
    }
    return lo <= hi ? [lo, hi] : null;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Faces whose normals along an edge turn by less than this (degrees) join smoothly there: no corner to blend. */
const SMOOTH_JOIN = 1;

/**
 * OpenCascade's blend, else (constant size only) the loop blend, the run-out blend and the blend from sections, else
 * an error that says why. `kernel(body, edges, scale)` makes OpenCascade's blend at `scale` times the size.
 */
function blendWithFallbacks(shape: Shape3D, edges: Edge[], label: string, kernel: (body: Shape3D, on: Edge[], scale: number) => Shape3D,
    loop: LoopBlend | null, runout: RunoutBlend | null, section: SectionBlend | null, flagsCleared: boolean): Shape3D {
    const made = (way: BlendWay, out: Shape3D): Shape3D => {
        blendTap.made?.(way);
        return out;
    };
    const size = !section ? 0 : section.kind === 'fillet' ? section.radius
        : 'distances' in section ? Math.max(...section.distances) : section.distance;
    let first: unknown;
    try {
        const out = kernel(shape, edges, 1);
        if (blendGoesTheRightWay(shape, edges, out)) {
            return made(flagsCleared ? 'kernel after flags' : 'kernel', out);
        }
        first = new Error('OpenCascade made a blend that takes material away at inside corners, or adds it at outside edges');
    } catch (e) {
        first = e;
    }
    // Edges along which the faces join smoothly have no corner to blend (OpenCascade: "no suitable edges").
    const bends = edges.map((e) => faceAngleAlong(shape, e));
    if (bends.every((b) => b !== null && b < SMOOTH_JOIN)) {
        const most = Math.max(...bends.map((b) => b ?? 0));
        throw new BlendError(`${label} cannot be made on the selected edges: the faces on either side of them join smoothly `
            + `(they turn by ${round1(most) || '0'}° at most), so there is no corner to blend there. Such edges are usually the `
            + 'edges of an earlier fillet or a seam inside a smooth surface: pick the sharp edges instead, or change the '
            + 'earlier fillet', false);
    }
    // A blend that runs off a face beside the edges (across a side where no face carries on smoothly) cannot be made
    // any way: say so now rather than after trying them all (seconds each on a big body, and the size is often dragged).
    if (section && !blendTap.old) {
        const over = overflowsFace(shape, edges, section);
        if (over) {
            throw new BlendError(`${label} failed on the selected edges (${over}): it is too large for the faces next to `
                + 'them; try a smaller size or fewer edges', true);
        }
    }
    let reason: string | null = null;
    if (loop) {
        const loops = closedLoops(shape, edges);
        if (loops) {
            try {
                let out = shape;
                for (const l of loops) {
                    out = blendLoop(out, sameEdges(out, l), loop);
                }
                const stray = strays(shape, edges, out, size);
                if (!stray) {
                    return made('loop', out);
                }
                reason = `the blend along the loop ${stray}`;
            } catch (e) {
                reason = e instanceof LoopBlendError ? e.message : `the blend along the loop failed (${ocMessage(e)})`;
            }
        }
    }
    if (runout) {
        const out = runoutBlend(shape, edges, runout);
        if (out && !strays(shape, edges, out, size)) {
            return made('runout', out);
        }
    }
    let sectionReason: string | null = null;
    if (section && !blendTap.old) {
        try {
            const out = sectionBlend(shape, edges, section);
            const stray = strays(shape, edges, out, size);
            if (!stray) {
                return made('sections', out);
            }
            sectionReason = `the blend ${stray}`;
        } catch (e) {
            sectionReason = e instanceof SectionBlendError ? e.message : ocMessage(e);
        }
    }
    const also = sectionReason ? `; built from its sections it fails too: ${sectionReason}` : '';
    if (reason) {
        throw new BlendError(`${label} cannot be made on the selected edges: ${reason}${also}`, false);
    }
    // Is it the size? Only if OpenCascade does make a much smaller one.
    let smallerWorks = false;
    try {
        kernel(shape, edges, 0.1);
        smallerWorks = true;
    } catch {
        smallerWorks = false;
    }
    if (smallerWorks) {
        throw new BlendError(`${label} failed on the selected edges (${ocMessage(first)}${also}): it is too large for the `
            + 'faces next to them; try a smaller size or fewer edges', true);
    }
    const angles = faceAngles(shape, edges);
    const meet = angles ? ` (along these edges the faces meet at ${round1(angles[0])}° to ${round1(angles[1])}°)` : '';
    // Where the edge of another face ends on the selected edges, that is the likely cause: name the place.
    const crossings = faceEdgeEnds(shape, edges);
    if (crossings.length) {
        const at = crossings.slice(0, 2).map((p) => `(${p.map((x) => Math.round(x * 1000) / 1000).join(', ')})`).join(' and ');
        throw new BlendError(`${label} failed on the selected edges (${ocMessage(first)}${also}). The edge between two of the `
            + `faces beside them ends on them at ${at}, where the blend has to pass from one face to the next${meet}; it `
            + 'could not be carried across there, at a tenth of the size either. Try the edges on either side of that point '
            + 'as separate fillets, or a smaller size', false);
    }
    throw new BlendError(`${label} failed on the selected edges (${ocMessage(first)}${also}), and OpenCascade cannot make `
        + `it here at a tenth of the size either, so the size is not the cause${meet}. Blends where faces meet nearly `
        + 'tangentially or at a knife edge are the usual trouble; try picking fewer edges', false);
}

/**
 * Points where two of the edges meet and the edge of another face ends too (the faces beside the edges change there),
 * found by where the edges' ends lie.
 */
function faceEdgeEnds(shape: Shape3D, edges: Edge[]): V[] {
    const ends = (e: Edge): V[] => [vecOf(e.pointAt(0)), vecOf(e.pointAt(1))];
    const picked = edges.flatMap(ends);
    const out: V[] = [];
    for (const p of picked) {
        if (out.some((q) => dist(p, q) < 1e-6) || picked.filter((q) => dist(p, q) < 1e-6).length !== 2) {
            continue;
        }
        const others = shape.edges.filter((e) => !edges.some((x) => x.isSame(e)) && ends(e).some((q) => dist(p, q) < 1e-6));
        // A seam of one face (both sides the same face) does not count.
        if (others.some((e) => shape.faces.filter((f) => f.edges.some((x) => x.isSame(e))).length === 2)) {
            out.push(p);
        }
    }
    return out;
}

/**
 * Whether a blend made another way than by OpenCascade's builder goes where it may not: at outside edges it may only
 * take material away (every new face of the result lies within the body as it was), at inside corners only add it
 * (every face of the body it changed lies within the result). Null when it stays; else what it did. A pick of both
 * kinds, or of an edge that is neither, is not judged. The tolerance goes with the blend's size, not the body's.
 *
 * Judged on points of the faces, not by the volume of a boolean difference: the two bodies touch tangentially along
 * the blend's edges, where OpenCascade's booleans give wrong volumes (thousands of mm³ for a correct blend).
 */
export function strays(shape: Shape3D, edges: Edge[], out: Shape3D, size: number): string | null {
    const kinds = edges.map((e) => insideCorner(shape, e));
    if (kinds.some((k) => k === null) || (kinds.some((k) => k) && kinds.some((k) => !k))) {
        return null;
    }
    const inside = kinds[0];
    // Outside edge: the result's own faces against the body. Inside corner: the body's changed faces against the result.
    const [moved, within] = inside ? [shape, out] : [out, shape];
    const kept = (inside ? out : shape).faces;
    const tolerance = Math.max(2e-4, 1e-3 * size);
    let worst = 0;
    try {
        const points = moved.faces.filter((face) => !kept.some((f) => f.isSame(face))).flatMap(facePoints);
        const judge = outsideOf(within, points, 2 * size + 1);
        for (const p of points) {
            worst = Math.max(worst, judge(p));
        }
    } catch {
        return 'could not be checked against the body';
    }
    if (worst > tolerance) {
        const by = Math.round(worst * 1000) / 1000;
        return inside ? `takes material away from the body at an inside corner (by ${by} mm)` : `runs ${by} mm outside the body`;
    }
    return null;
}

/** Points spread over a face (on a grid of its parameters, those inside the face). */
function facePoints(face: Face): V[] {
    const oc = getOC();
    const b = oc.BRepTools.UVBounds(face.wrapped, 0, 0, 0, 0);
    const surface = oc.BRep_Tool.Surface(face.wrapped);
    const out: V[] = [];
    for (let i = 0; i <= 4; i++) {
        for (let j = 0; j <= 4; j++) {
            const p = surface.Value(b.UMin + (b.UMax - b.UMin) * i / 4, b.VMin + (b.VMax - b.VMin) * j / 4);
            const q: V = [p.X(), p.Y(), p.Z()];
            p.delete();
            if (nearest(face.wrapped, q).distance < 1e-7) {
                out.push(q);
            }
        }
    }
    return out;
}

/** Distance from a point to a shape, the nearest point and what it lies on (face, edge or vertex). */
function nearest(shape: unknown, p: V): { distance: number; at: V; support: { IsSame(o: unknown): boolean } } {
    const oc = getOC();
    const vertex = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(p[0], p[1], p[2]));
    const dss = new oc.BRepExtrema_DistShapeShape();
    try {
        dss.LoadS1(vertex.Vertex());
        dss.LoadS2(shape as never);
        dss.Perform(new oc.Message_ProgressRange());
        if (!dss.IsDone() || dss.NbSolution() < 1) {
            throw new Error('no distance');
        }
        const q = dss.PointOnShape2(1);
        const at: V = [q.X(), q.Y(), q.Z()];
        q.delete();
        return { distance: dss.Value(), at, support: dss.SupportOnShape2(1) as never };
    } finally {
        dss.delete();
        vertex.delete();
    }
}

/**
 * How far points lie outside a solid (0 inside or on it), judged by the outward normal at each point's nearest point on
 * the solid's faces (at an edge or vertex, the mean of the normals of the faces that meet there). Only faces within
 * `reach` of the points are looked at.
 */
function outsideOf(solid: Shape3D, points: V[], reach: number): (p: V) => number {
    const oc = getOC();
    if (!points.length) {
        return () => 0;
    }
    const lo = [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k])) - reach);
    const hi = [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k])) + reach);
    const faces = solid.faces.filter((f) => {
        const box = f.boundingBox;
        const [a, b] = box.bounds;
        box.delete();
        return [0, 1, 2].every((k) => a[k] <= hi[k] && b[k] >= lo[k]);
    }).map((f) => ({
        face: f,
        parts: [f.wrapped, ...f.edges.map((e) => e.wrapped), ...vertexShapes(f.wrapped)] as { IsSame(o: unknown): boolean }[],
    }));
    const builder = new oc.TopoDS_Builder();
    const near = new oc.TopoDS_Compound();
    builder.MakeCompound(near);
    faces.forEach((f) => builder.Add(near, f.face.wrapped));
    builder.delete();
    return (p) => {
        const { distance, at, support } = nearest(near, p);
        if (distance < 1e-9) {
            return 0;
        }
        let n: V = [0, 0, 0];
        for (const f of faces.filter((x) => x.parts.some((part) => part.IsSame(support)))) {
            const m = vecOf(f.face.normalAt(at));
            const l = Math.hypot(...m) || 1;
            n = [n[0] + m[0] / l, n[1] + m[1] / l, n[2] + m[2] / l];
        }
        return dot([p[0] - at[0], p[1] - at[1], p[2] - at[2]], n) > 0 ? distance : 0;
    };
}

function vertexShapes(shape: unknown): unknown[] {
    const oc = getOC();
    const out: unknown[] = [];
    const ex = new oc.TopExp_Explorer(shape as never, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) {
        out.push(ex.Current());
    }
    ex.delete();
    return out;
}

/**
 * A blend only adds material at inside corners and only removes it at outside edges. OpenCascade sometimes returns a
 * valid solid that does the opposite (a round in an inside corner that cuts into the body); such a result is refused.
 * Edges of both kinds together are not judged.
 */
function blendGoesTheRightWay(shape: Shape3D, edges: Edge[], made: Shape3D): boolean {
    const kinds = edges.map((e) => insideCorner(shape, e));
    if (kinds.some((k) => k === null) || (kinds.some((k) => k) && kinds.some((k) => !k))) {
        return true;
    }
    const change = measureVolume(made) - measureVolume(shape);
    return kinds[0] ? change > 0 : change < 0;
}

/** The edges of `shape` at the same places as `edges` (after an earlier loop's blend rebuilt the body). */
function sameEdges(shape: Shape3D, edges: Edge[]): Edge[] {
    return edges.map((edge) => {
        const found = shape.edges.find((e) => e.isSame(edge))
            ?? shape.edges.find((e) => [0, 0.5, 1].every((k) => dist(vecOf(e.pointAt(k)), vecOf(edge.pointAt(k))) < 1e-6));
        if (!found) {
            throw new LoopBlendError('a selected edge was changed by the blend of another loop');
        }
        return found;
    });
}

export function filletFaces(shape: Shape3D, faces: Face[], radius: number): Shape3D {
    return filletEdges(shape, edgesOfFaces(faces), { radius });
}

// ---- Chamfer ------------------------------------------------------------------------------------------------

/**
 * The reference face of an edge for asymmetric chamfers: of the faces of `shape` bounded by the edge, the one whose
 * normal at the edge's midpoint is closest to `side`; without `side`, the first of them in the shape's face order.
 */
export function chamferReferenceFace(shape: Shape3D, edge: Edge, side?: Vec3): Face {
    const faces = shape.faces.filter((f) => f.edges.some((e) => e.isSame(edge)));
    if (faces.length === 0) {
        throw new Error('chamfer: the edge is not on the body');
    }
    if (!side || faces.length === 1) {
        return faces[0];
    }
    const mid = vecOf(edge.pointAt(0.5));
    let best = faces[0];
    let score = -Infinity;
    for (const face of faces) {
        const n = vecOf(face.normalAt(mid));
        const s = dot(n, [...side] as V) / (Math.hypot(...n) || 1);
        if (s > score) {
            score = s;
            best = face;
        }
    }
    return best;
}

export function chamferEdges(given: Shape3D, picked: Edge[], spec: ChamferSpec): Shape3D {
    needEdges(picked, 'chamfer');
    const { shape, edges, cleared } = withTrueCorners(given, picked);
    let label: string;
    let config: (body: Shape3D, edge: Edge, scale: number) => ChamferRadius;
    let loop: LoopBlend;
    let runout: RunoutBlend;
    const side = 'side' in spec ? spec.side : undefined;
    const referenceOf = (edge: Edge, body: Shape3D = shape): Face => chamferReferenceFace(body, edge, side);
    if ('angle' in spec) {
        if (!(spec.distance > 0 && spec.angle > 0 && spec.angle < 90)) {
            throw new Error('chamfer needs a positive distance and an angle between 0 and 90 degrees');
        }
        label = `chamfer of ${spec.distance} mm at ${spec.angle}°`;
        config = (body, edge, k) => {
            const face = referenceOf(edge, body);
            return { distance: spec.distance * k, angle: spec.angle, selectedFace: (f) => f.inList([face]) };
        };
        loop = { kind: 'chamfer', distance: spec.distance, angle: spec.angle, reference: referenceOf(edges[0]) };
        runout = { kind: 'chamfer', distance: spec.distance, angle: spec.angle, reference: referenceOf };
    } else if ('distances' in spec) {
        const [d1, d2] = spec.distances;
        if (!(d1 > 0 && d2 > 0)) {
            throw new Error('chamfer distances must be positive');
        }
        label = `chamfer of ${d1} x ${d2} mm`;
        config = (body, edge, k) => {
            const face = referenceOf(edge, body);
            return { distances: [d1 * k, d2 * k], selectedFace: (f) => f.inList([face]) };
        };
        loop = { kind: 'chamfer', distances: [d1, d2], reference: referenceOf(edges[0]) };
        runout = { kind: 'chamfer', distances: [d1, d2], reference: referenceOf };
    } else {
        if (!(spec.distance > 0)) {
            throw new Error('chamfer distance must be positive');
        }
        label = `chamfer of ${spec.distance} mm`;
        config = (_, __, k) => spec.distance * k;
        loop = { kind: 'chamfer', distances: [spec.distance, spec.distance] };
        runout = { kind: 'chamfer', distances: [spec.distance, spec.distance] };
    }
    const kernel = (body: Shape3D, on: Edge[], scale: number): Shape3D => {
        const chosen = selects(on);
        const result = solidOf(body.chamfer((edge) => (chosen(edge) ? config(body, edge, scale) : null)), 'chamfer');
        if (!isValid(result)) {
            throw new Error('the result is not a valid solid');
        }
        return result;
    };
    return blendWithFallbacks(shape, edges, label, kernel, loop, runout, runout, cleared);
}

export function chamferFaces(shape: Shape3D, faces: Face[], spec: ChamferSpec): Shape3D {
    return chamferEdges(shape, edgesOfFaces(faces), spec);
}

// ---- Shell --------------------------------------------------------------------------------------------------

/** The body offset by `distance` (negative: inwards), arcs at convex edges. */
function offsetBody(shape: Shape3D, distance: number): Shape3D {
    const oc = getOC();
    const builder = new oc.BRepOffsetAPI_MakeOffsetShape();
    try {
        builder.PerformByJoin(shape.wrapped, distance, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
            oc.GeomAbs_JoinType.GeomAbs_Arc, false);
        return cast(builder.Shape()) as Shape3D;
    } finally {
        builder.delete();
    }
}

/**
 * Hollows the body to walls of `thickness`, removing the picked faces. With no faces, a closed hollow body (the
 * offset body cut away). `outward`: the walls grow outside the original surface, which becomes the inside.
 */
export function shellFaces(shape: Shape3D, thickness: number, facesToRemove: Face[],
    options: { outward?: boolean } = {}): Shape3D {
    if (!(thickness > 0)) {
        throw new Error('shell thickness must be positive');
    }
    const outward = options.outward ?? false;
    const what = `shell of ${thickness} mm${outward ? ' outward' : ''}`;
    let result: Shape3D;
    try {
        if (facesToRemove.length === 0) {
            result = outward ? offsetBody(shape, thickness).cut(shape) : shape.cut(offsetBody(shape, -thickness));
        } else {
            const oc = getOC();
            const list = new oc.NCollection_List_TopoDS_Shape();
            const builder = new oc.BRepOffsetAPI_MakeThickSolid();
            try {
                for (const face of facesToRemove) {
                    list.Append(face.wrapped);
                }
                builder.MakeThickSolidByJoin(shape.wrapped, list, outward ? thickness : -thickness, 1e-3,
                    oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
                result = cast(builder.Shape()) as Shape3D;
            } finally {
                builder.delete();
                list.delete();
            }
        }
        result = solidOf(result, 'shell');
    } catch (e) {
        throw new Error(`${what} failed (${ocMessage(e)}): fillets or curved faces smaller than the wall thickness `
            + 'usually cause this; try a thinner wall, or shell first and fillet after');
    }
    if (!isValid(result)) {
        throw new Error(`walls of ${thickness} mm do not fit this shape (try a thinner wall)`);
    }
    const before = measureVolume(shape);
    const after = measureVolume(result);
    if (!(after > 1e-6) || (!outward && !(after < before - 1e-6))) {
        throw new Error(`${what} did not hollow the solid`);
    }
    return result;
}

// ---- Draft --------------------------------------------------------------------------------------------------

/**
 * Tilts the picked faces by `angle` degrees about their intersection with the neutral plane, pull direction = the
 * plane normal: a positive angle narrows the body going along the normal (the mould opens that way). `flip`
 * reverses the pull direction.
 */
export function draftFaces(shape: Shape3D, faces: Face[], angle: number, neutral: { origin: Vec3; normal: Vec3 },
    options: { flip?: boolean } = {}): Shape3D {
    if (!(Math.abs(angle) > 1e-6 && Math.abs(angle) < 45)) {
        throw new Error('draft angle must be between 0 and 45 degrees');
    }
    if (faces.length === 0) {
        throw new Error('draft: no faces selected');
    }
    const [nx, ny, nz] = neutral.normal;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 1e-9)) {
        throw new Error('draft: the neutral plane has no direction');
    }
    const sign = options.flip ? -1 : 1;
    const normal: Vec3 = [(sign * nx) / length, (sign * ny) / length, (sign * nz) / length];
    const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const k = seed[0] * normal[0] + seed[1] * normal[1] + seed[2] * normal[2];
    const xDir: Vec3 = [seed[0] - k * normal[0], seed[1] - k * normal[1], seed[2] - k * normal[2]];
    const plane = new Plane(neutral.origin, xDir, normal);
    let result: Shape3D;
    try {
        result = solidOf(shape.draft(angle, (finder) => finder.inList(faces), plane), 'draft');
    } catch (e) {
        throw new Error(`could not draft the selected faces by ${angle}° (${ocMessage(e)}): each face must cross or `
            + 'touch the neutral plane, or meet faces that can follow it; try a smaller angle or another neutral plane');
    } finally {
        plane.delete();
    }
    if (!isValid(result)) {
        throw new Error('the drafted faces do not meet their neighbours cleanly (try a smaller angle)');
    }
    return result;
}
