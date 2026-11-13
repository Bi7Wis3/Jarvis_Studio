// Applied features on RESOLVED entities (see refs.ts): fillet, chamfer, shell and draft of picked edges and faces.
// build.ts resolves the stored picks and calls these; each turns OpenCascade failures into a message with a hint.
//
// What OpenCascade (through replicad) can and cannot do here:
// - Fillet: constant radius, or a radius varying linearly from the edge's start to its end (BRepFilletAPI_MakeFillet
//   Add(R1, R2, E)); OC also takes a law or (parameter, radius) pairs per edge, not wrapped here. The cross-section is
//   always circular: ChFi3d_Rational / QuasiAngular / Polynomial only change how the circle is approximated, so
//   conic (rho) and curvature-continuous profiles, setbacks and overflow control are not available.
// - Chamfer: equal distance, two distances, distance + angle (both measured from a reference face of the edge).
// - Shell: inward or outward walls with faces removed (MakeThickSolid); a closed hollow body is made by cutting the
//   offset body away (as build.ts does; MakeThickSolid with an empty face list is version dependent). One
//   thickness for all walls: per-face thickness would need BRepOffset_MakeOffset directly (not wrapped).
// - Draft: picked faces about a neutral plane, pull direction = the plane normal (BRepOffsetAPI_DraftAngle); faces
//   must meet the neutral plane or their neighbours cleanly, angles well under 45°.

import { cast, getOC, measureVolume, Plane, type ChamferRadius, type Edge, type Face, type Shape3D } from 'replicad';
import type { Vec3 } from '@jarvis/core';

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

function needEdges(edges: Edge[], what: string): void {
    if (edges.length === 0) {
        throw new Error(`${what}: no edges selected`);
    }
}

// ---- Fillet -------------------------------------------------------------------------------------------------

export function filletEdges(shape: Shape3D, edges: Edge[], spec: FilletSpec): Shape3D {
    needEdges(edges, 'fillet');
    const picked = selects(edges);
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
    let result: Shape3D;
    try {
        result = solidOf(shape.fillet((edge) => (picked(edge) ? radiusFor(edge) : null)), 'fillet');
    } catch (e) {
        throw new Error(`${label} failed on the selected edges (${ocMessage(e)}): the radius is probably too large for `
            + 'the faces next to them; try a smaller radius or fewer edges');
    }
    if (!isValid(result)) {
        throw new Error(`${label} is too large for the selected edges (the faces next to them are too small)`);
    }
    return result;
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

export function chamferEdges(shape: Shape3D, edges: Edge[], spec: ChamferSpec): Shape3D {
    needEdges(edges, 'chamfer');
    const picked = selects(edges);
    let label: string;
    let config: (edge: Edge) => ChamferRadius;
    if ('angle' in spec) {
        if (!(spec.distance > 0 && spec.angle > 0 && spec.angle < 90)) {
            throw new Error('chamfer needs a positive distance and an angle between 0 and 90 degrees');
        }
        label = `chamfer of ${spec.distance} mm at ${spec.angle}°`;
        config = (edge) => {
            const face = chamferReferenceFace(shape, edge, spec.side);
            return { distance: spec.distance, angle: spec.angle, selectedFace: (f) => f.inList([face]) };
        };
    } else if ('distances' in spec) {
        const [d1, d2] = spec.distances;
        if (!(d1 > 0 && d2 > 0)) {
            throw new Error('chamfer distances must be positive');
        }
        label = `chamfer of ${d1} x ${d2} mm`;
        config = (edge) => {
            const face = chamferReferenceFace(shape, edge, spec.side);
            return { distances: [d1, d2], selectedFace: (f) => f.inList([face]) };
        };
    } else {
        if (!(spec.distance > 0)) {
            throw new Error('chamfer distance must be positive');
        }
        label = `chamfer of ${spec.distance} mm`;
        config = () => spec.distance;
    }
    let result: Shape3D;
    try {
        result = solidOf(shape.chamfer((edge) => (picked(edge) ? config(edge) : null)), 'chamfer');
    } catch (e) {
        throw new Error(`${label} failed on the selected edges (${ocMessage(e)}): the distances are probably too large `
            + 'for the faces next to them; try smaller ones');
    }
    if (!isValid(result)) {
        throw new Error(`${label} is too large for the selected edges (the faces next to them are too small)`);
    }
    return result;
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
