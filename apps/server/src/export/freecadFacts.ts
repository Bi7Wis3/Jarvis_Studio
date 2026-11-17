// What the FreeCAD history macro needs to know from the CAD kernel: the body after each step (to check the rebuilt
// one against), the edges and faces a step picked, and solids for steps FreeCAD cannot express. Points are in
// FreeCAD's frame (Z up): app (x, y, z) is FreeCAD (x, -z, y).

import { deflateSync } from 'node:zlib';
import { getOC, makePolygon, measureArea, measureDistanceBetween, measureVolume, type Edge, type Face, type Shape3D } from 'replicad';
import type { EdgeSelect, FacePickRef, FaceSelect, Feature, PrintSettings, Shape, Sketch, Vec3 } from '@jarvis/core';
import { extrudeSketch, sketchFrame } from '../cad/sketch.js';
import { buildPartial, buildShape, threadEdge, type PartSpec } from '../cad/build.js';
import type { CombineContext } from '../cad/context.js';
import { distanceToShape, resolveEdges, resolveFaces } from '../cad/refs.js';

/** App part frame to FreeCAD (Y up to Z up). */
export const toFc = (p: readonly number[]): Vec3 => [p[0], -p[2], p[1]];

export interface Measure {
    volume: number;
    /** Bounding box, FreeCAD frame: [xmin, ymin, zmin, xmax, ymax, zmax]. */
    box: [number, number, number, number, number, number];
}

const REFERENCE_OPS = new Set(['sketch', 'plane', 'axis', 'point', 'helix']);
const EPS = 1e-3;

function bounds(shape: Shape3D): [Vec3, Vec3] {
    const box = shape.boundingBox;
    const b = box.bounds as [Vec3, Vec3];
    box.delete();
    return b;
}

const tuple = (v: { x: number; y: number; z: number; delete(): void }): Vec3 => {
    const out: Vec3 = [v.x, v.y, v.z];
    v.delete();
    return out;
};

/** The body of a part step by step, built through the kernel's step cache (each step is built once). */
export class PartFacts {
    private readonly shapes = new Map<number, { shape: Shape3D | null; error: string | null; followed?: Record<string, Feature> }>();
    private readonly history: boolean;

    constructor(readonly part: PartSpec, readonly print: PrintSettings, readonly context?: CombineContext) {
        this.history = (part.features ?? []).some((f) => !f.suppressed && !REFERENCE_OPS.has(f.op));
    }

    private followedSteps: Feature[] | null = null;

    /**
     * The part's steps as the kernel uses them: reference steps taken from the model (followRefs.ts) as it found
     * them on the body, so planes, axes and points are where the kernel has them.
     */
    get features(): Feature[] {
        if (!this.followedSteps) {
            const own = this.part.features ?? [];
            const followed = this.built(own.length).followed ?? {};
            this.followedSteps = own.map((f) => followed[f.id] ?? f);
        }
        return this.followedSteps;
    }

    /** The body after the first `count` steps (and why it stopped there, if it failed). */
    built(count: number): { shape: Shape3D | null; error: string | null; followed?: Record<string, Feature> } {
        const hit = this.shapes.get(count);
        if (hit) {
            return hit;
        }
        const features = (this.part.features ?? []).slice(0, count);
        const history = features.some((f) => !f.suppressed && !REFERENCE_OPS.has(f.op));
        let result: { shape: Shape3D | null; error: string | null; followed?: Record<string, Feature> };
        if (history === this.history) {
            result = buildPartial({ shape: this.part.shape, features }, this.print, this.context);
        } else {
            // Only reference steps so far: the base body as the whole history builds it (sharp edges).
            result = { shape: this.part.shape.kind === 'empty' ? null : buildShape(this.part.shape, !this.history), error: null };
        }
        this.shapes.set(count, result);
        return result;
    }

    /** The body before step `index` (null when there is none yet). */
    before(index: number): Shape3D | null {
        return this.built(index).shape;
    }

    after(index: number): Shape3D | null {
        return this.built(index + 1).shape;
    }

    /** The base body alone, as the history builds it. */
    base(): Shape3D | null {
        return this.part.shape.kind === 'empty' ? null : buildShape(this.part.shape, !this.history);
    }
}

/** The tight bounding box (from the exact geometry, not the control points of its surfaces). */
function tightBounds(shape: Shape3D): [Vec3, Vec3] {
    const oc = getOC();
    const box = new oc.Bnd_Box();
    try {
        oc.BRepBndLib.AddOptimal(shape.wrapped, box, false, false);
        const lo = box.CornerMin();
        const hi = box.CornerMax();
        const out: [Vec3, Vec3] = [[lo.X(), lo.Y(), lo.Z()], [hi.X(), hi.Y(), hi.Z()]];
        lo.delete();
        hi.delete();
        return out;
    } finally {
        box.delete();
    }
}

export function measure(shape: Shape3D | null): Measure | null {
    if (!shape) {
        return null;
    }
    const [lo, hi] = tightBounds(shape);
    const a = toFc(lo);
    const b = toFc(hi);
    return {
        volume: measureVolume(shape),
        box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
    };
}

/** The shape in FreeCAD's frame as BREP text, compressed and base64 encoded (lines of 100). */
export function brep(shape: Shape3D): string {
    const oc = getOC();
    const turned = shape.clone().rotate(90, [0, 0, 0], [1, 0, 0]);
    const file = `/jarvis-${process.pid}-${Date.now()}.brep`;
    try {
        oc.BRepTools.Clean(turned.wrapped, true);
        const progress = new oc.Message_ProgressRange();
        const ok = (oc.BRepTools as unknown as { Write(s: unknown, f: string, p: unknown): boolean }).Write(turned.wrapped, file, progress);
        progress.delete();
        if (!ok) {
            throw new Error('could not write the solid as BREP');
        }
        const text = (oc as unknown as { FS: { readFile(f: string, o: { encoding: 'utf8' }): string } }).FS.readFile(file, { encoding: 'utf8' });
        const packed = deflateSync(Buffer.from(text, 'ascii'), { level: 9 }).toString('base64');
        return packed.match(/.{1,100}/g)!.join('\n');
    } finally {
        try {
            (oc as unknown as { FS: { unlink(f: string): void } }).FS.unlink(file);
        } catch {
            // not written
        }
        turned.delete();
    }
}

/** What a step removed from and added to the body (either may be empty), as solids. */
export function delta(before: Shape3D | null, after: Shape3D | null): { removed: Shape3D | null; added: Shape3D | null } {
    const nonEmpty = (s: Shape3D | null): Shape3D | null => (s && !s.isNull && s.solids.length && measureVolume(s) > 1e-9 ? s : null);
    if (!before) {
        return { removed: null, added: after };
    }
    if (!after) {
        return { removed: before, added: null };
    }
    return { removed: nonEmpty(before.clone().cut(after.clone())), added: nonEmpty(after.clone().cut(before.clone())) };
}

// ---- Picked edges and faces --------------------------------------------------------------------------------

/** Start, middle and end of an edge, FreeCAD frame. */
export function edgePoints(edge: Edge): Vec3[] {
    return [tuple(edge.startPoint), tuple(edge.pointAt(0.5)), tuple(edge.endPoint)].map(toFc);
}

/** A point well inside a face and its area, FreeCAD frame. */
export function facePoint(face: Face): [Vec3, number] {
    const area = measureArea(face);
    const grid = [0.5, 0.25, 0.75, 0.375, 0.625, 0.125, 0.875];
    for (const u of grid) {
        for (const v of grid) {
            const p = tuple(face.pointOnSurface(u, v));
            if (distanceToShape(p, face) < 1e-7) {
                return [toFc(p), area];
            }
        }
    }
    return [toFc(tuple(face.center)), area];
}

function edgeBox(edge: Edge): [Vec3, Vec3] {
    const box = edge.boundingBox;
    const b = box.bounds as [Vec3, Vec3];
    box.delete();
    return b;
}

/** The kernel's edge groups (build.ts edgePicker). */
function groupEdges(shape: Shape3D, select: EdgeSelect): Edge[] {
    const [lo, hi] = bounds(shape);
    const pick = (edge: Edge): boolean => {
        const [min, max] = edgeBox(edge);
        switch (select) {
            case 'all':
                return true;
            case 'vertical':
                return edge.geomType === 'LINE' && max[0] - min[0] < EPS && max[2] - min[2] < EPS && max[1] - min[1] > EPS;
            case 'horizontal':
                return max[1] - min[1] < EPS;
            case 'top':
                return Math.abs(max[1] - hi[1]) < EPS && Math.abs(min[1] - hi[1]) < EPS;
            case 'bottom':
                return Math.abs(max[1] - lo[1]) < EPS && Math.abs(min[1] - lo[1]) < EPS;
        }
    };
    return shape.edges.filter(pick);
}

/** The edges a fillet or chamfer works on, as build.ts resolves them. */
export function stepEdges(shape: Shape3D, f: { at?: Vec3[]; faces?: FacePickRef[]; tangent?: boolean; edges?: EdgeSelect }): Edge[] {
    if (f.at?.length || f.faces?.length) {
        const edges = [
            ...resolveEdges(shape, f.at ?? [], { tangent: f.tangent }),
            ...resolveFaces(shape, f.faces ?? [], { tangent: f.tangent }).flatMap((face) => face.edges),
        ];
        return edges.filter((edge, i) => edges.findIndex((other) => other.isSame(edge)) === i);
    }
    return groupEdges(shape, f.edges ?? 'all');
}

const FACE_DIRECTIONS: Record<FaceSelect, Vec3> = {
    top: [0, 1, 0], bottom: [0, -1, 0], front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0],
};

/** The outermost flat faces facing a side (build.ts outermostFaces). */
export function sideFaces(shape: Shape3D, select: FaceSelect): Face[] {
    const d = FACE_DIRECTIONS[select];
    const candidates: { face: Face; offset: number }[] = [];
    for (const face of shape.faces) {
        if (face.geomType !== 'PLANE') continue;
        const n = tuple(face.normalAt());
        if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0.999) {
            const c = tuple(face.center);
            candidates.push({ face, offset: c[0] * d[0] + c[1] * d[1] + c[2] * d[2] });
        }
    }
    if (!candidates.length) {
        throw new Error(`no flat face faces ${select}`);
    }
    const max = Math.max(...candidates.map((c) => c.offset));
    return candidates.filter((c) => c.offset > max - EPS).map((c) => c.face);
}

export function pickedFaces(shape: Shape3D, picks: FacePickRef[], tangent?: boolean): Face[] {
    return resolveFaces(shape, picks, { tangent });
}

/**
 * For a chamfer measured from a reference face: whether each edge's reference face (applied.ts chamferReferenceFace)
 * is the first of the edge's faces in the body (FreeCAD's default) or the last (FreeCAD's Flip direction).
 */
export function chamferFlips(shape: Shape3D, edges: Edge[], side?: Vec3): boolean[] {
    const faces = shape.faces;
    return edges.map((edge) => {
        const own = faces.filter((f) => f.edges.some((e) => e.isSame(edge)));
        if (!side || own.length < 2) return false;
        const mid = tuple(edge.pointAt(0.5));
        let best = 0;
        let score = -Infinity;
        own.forEach((face, i) => {
            const n = tuple(face.normalAt(mid));
            const s = (n[0] * side[0] + n[1] * side[1] + n[2] * side[2]) / (Math.hypot(...n) || 1);
            if (s > score) {
                score = s;
                best = i;
            }
        });
        return best !== 0;
    });
}

/**
 * An up to next cut as a depth: the kernel removes the first pieces of material its prism meets (sketch.ts upToNext).
 * When those end before any other material ahead starts, a blind cut between the two removes the same; returns that
 * depth, Infinity when nothing else is ahead (through all), or null when the pieces overlap in depth.
 */
export function upToNextDepth(sketch: Sketch, regions: [number, number][] | undefined, body: Shape3D, sign: 1 | -1): number | null {
    const frame = sketchFrame(sketch);
    const [lo, hi] = bounds(body);
    let reach = -Infinity;
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
        const t = (x - frame.origin[0]) * frame.normal[0] + (y - frame.origin[1]) * frame.normal[1] + (z - frame.origin[2]) * frame.normal[2];
        reach = Math.max(reach, sign * t);
    }
    if (!(reach > 1e-6)) return null;
    const far = sign * (reach + 1);
    const prism = extrudeSketch(sketch, [Math.min(0, far), Math.max(0, far)], regions);
    const along = (shape: Shape3D): [number, number] => {
        // Exact extent along the cut direction: distances to planes square to it at both ends of the prism.
        const ends = [0, far].map((t) => {
            const origin: Vec3 = [frame.origin[0] + frame.normal[0] * t, frame.origin[1] + frame.normal[1] * t, frame.origin[2] + frame.normal[2] * t];
            const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + Math.abs(far) + 100;
            const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]): Vec3 => [
                origin[0] + (frame.u[0] * a + frame.v[0] * b) * size, origin[1] + (frame.u[1] * a + frame.v[1] * b) * size,
                origin[2] + (frame.u[2] * a + frame.v[2] * b) * size,
            ]);
            const face = makePolygon(corners);
            const d = measureDistanceBetween(shape, face);
            face.delete();
            return d;
        });
        return [ends[0], Math.abs(far) - ends[1]];
    };
    const pieces = (prism.intersect(body.clone()).solids as Shape3D[]).map(along);
    if (!pieces.length) return null;
    const first = pieces.reduce((a, b) => (b[0] < a[0] ? b : a));
    const chosen = pieces.filter((p) => p[0] < first[1] - 1e-3);
    const others = pieces.filter((p) => !chosen.includes(p));
    const end = Math.max(...chosen.map((p) => p[1]));
    if (!others.length) return Infinity;
    const next = Math.min(...others.map((p) => p[0]));
    return next > end + 1e-3 ? (end + next) / 2 : null;
}

export { threadEdge };

export function baseShape(shape: Shape, sharp: boolean): Shape3D {
    return buildShape(shape, !sharp);
}
