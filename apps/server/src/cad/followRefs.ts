// References taken from the model (reference planes, axes and points made from picked faces, edges and vertices),
// found again on the body as it is at their step at every rebuild, so they follow changes made before them as
// SolidWorks' references do. A face is the one the pick lies on; else one of the same kind that it moved to: a flat
// face facing the same way, moved along its normal (or split or resized in its plane), a cylinder or cone about the
// same axis. An edge or a vertex is the one at the pick, else the one where the faces that met there meet now. What
// cannot be found is an error naming what is lost (SolidWorks' dangling reference); the old value is never used.
// Kernel only; the cached values the steps carry are described in @jarvis/core/reference.

import { getOC, iterTopo, localGC, Vertex, type Edge, type Face, type Shape3D } from 'replicad';
import type {
    CustomSketchPlane, FacePickRef, Feature, FixedCylinder, FixedLine, ModelEdgePick, ModelEdgeShape, ModelVertexPick,
    PointDefinition, Vec3,
} from '@jarvis/core';
import { followsModel, normalizePlane, pointOfDefinition } from '@jarvis/core/reference';
import { distanceToShape, pickTolerance } from './refs.js';

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));

/** Directions within half a degree count as the same (a face facing the same way, parallel axes). */
const SAME_DIR = Math.cos((0.5 * Math.PI) / 180);
/** Two picks closer than this to two faces count as equally near. */
const TIE = 1e-3;
/** Points closer than this are one vertex. */
const SAME_POINT = 1e-6;

const num = (v: number): string => String(Math.round(v * 1e4) / 1e4 + 0);
const at = (p: Vec3): string => `(${p.map(num).join(', ')})`;

/** The distance from p to the infinite line through `point` along unit `direction`. */
const offLine = (p: Vec3, point: Vec3, direction: Vec3): number => {
    const rel = sub(p, point);
    return len(sub(rel, scale(direction, dot(rel, direction))));
};
/** p moved onto the plane through `point` with unit normal `n`, along n. */
const ontoPlane = (p: Vec3, point: Vec3, n: Vec3): Vec3 => add(p, scale(n, dot(sub(point, p), n)));
/** p moved onto the line through `point` along unit `d`. */
const ontoLine = (p: Vec3, point: Vec3, d: Vec3): Vec3 => add(point, scale(d, dot(sub(p, point), d)));

function vec(v: { x: number; y: number; z: number; delete(): void }): Vec3 {
    const out: Vec3 = [v.x, v.y, v.z];
    v.delete();
    return out;
}

type Pnt = { X(): number; Y(): number; Z(): number };
const xyz = (p: Pnt): Vec3 => [p.X(), p.Y(), p.Z()];

// ---- The body's faces and edges as geometry ----------------------------------------------------------------

type FaceGeom =
    | { type: 'plane'; face: Face; normal: Vec3; point: Vec3 }
    | { type: 'cylinder'; face: Face; point: Vec3; direction: Vec3; radius: number }
    | { type: 'cone'; face: Face; point: Vec3; direction: Vec3 }
    | { type: 'other'; face: Face };

type FaceKind = 'plane' | 'cylinder' | 'cone';

/** A circular edge's centre, axis (its curve's own direction of travel) and radius. */
function circleOf(edge: Edge): { centre: Vec3; normal: Vec3; radius: number } {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const circle = r(r(new oc.BRepAdaptor_Curve(edge.wrapped)).Circle());
        return { centre: xyz(r(circle.Location())), normal: xyz(r(r(circle.Axis()).Direction())), radius: circle.Radius() };
    } finally {
        gc();
    }
}

/** A straight or circular edge's shape (start to end as its curve runs), or null for other curves. */
function edgeShape(edge: Edge): ModelEdgeShape | null {
    const type = edge.geomType;
    if (type === 'LINE') {
        return { type: 'line', a: vec(edge.startPoint), b: vec(edge.endPoint) };
    }
    if (type === 'CIRCLE') {
        const c = circleOf(edge);
        return { type: 'circle', centre: c.centre, normal: c.normal, radius: c.radius, full: edge.isClosed, start: vec(edge.startPoint), end: vec(edge.endPoint) };
    }
    return null;
}

function faceGeom(face: Face): FaceGeom {
    try {
        switch (face.geomType) {
            case 'PLANE':
                return { type: 'plane', face, normal: unit(vec(face.normalAt())), point: vec(face.center) };
            case 'CYLINDRE': {
                const oc = getOC();
                const [r, gc] = localGC();
                try {
                    const cylinder = r(r(new oc.BRepAdaptor_Surface(face.wrapped, false)).Cylinder());
                    const axis = r(cylinder.Axis());
                    return { type: 'cylinder', face, point: xyz(r(axis.Location())), direction: unit(xyz(r(axis.Direction()))), radius: cylinder.Radius() };
                } finally {
                    gc();
                }
            }
            case 'CONE': {
                // Its axis through the centres of its circular boundary edges (one circle: along its normal).
                const circles = face.edges.filter((e) => e.geomType === 'CIRCLE').map(circleOf);
                if (circles.length === 0) {
                    return { type: 'other', face };
                }
                const other = circles.find((c) => dist(c.centre, circles[0].centre) > 1e-6);
                const direction = other ? unit(sub(other.centre, circles[0].centre)) : unit(circles[0].normal);
                return { type: 'cone', face, point: circles[0].centre, direction };
            }
            default:
                return { type: 'other', face };
        }
    } catch {
        return { type: 'other', face };
    }
}

/** The body at one step, its faces and edges read once. */
class Body {
    readonly tolerance: number;
    private faceList: FaceGeom[] | null = null;
    private edgeList: Edge[] | null = null;

    constructor(readonly shape: Shape3D) {
        this.tolerance = pickTolerance(shape);
    }

    get faces(): FaceGeom[] {
        this.faceList ??= this.shape.faces.map(faceGeom);
        return this.faceList;
    }

    get edges(): Edge[] {
        this.edgeList ??= this.shape.edges;
        return this.edgeList;
    }

    private boxes = new Map<Face | Edge, [Vec3, Vec3]>();

    /** Whether p is within the tolerance of the entity's bounding box: a cheap test before the true distance. */
    near(entity: Face | Edge, p: Vec3): boolean {
        let box = this.boxes.get(entity);
        if (!box) {
            const b = entity.boundingBox;
            box = b.bounds as [Vec3, Vec3];
            b.delete();
            this.boxes.set(entity, box);
        }
        const [lo, hi] = box;
        return [0, 1, 2].every((k) => p[k] >= lo[k] - this.tolerance && p[k] <= hi[k] + this.tolerance);
    }
}

// ---- Finding a picked entity again -------------------------------------------------------------------------

interface FaceHint {
    /** A cylinder's or cone's axis as it was (and a cylinder's radius). */
    axis?: FixedLine;
    radius?: number;
}

/** A face turned further than this from the pick's normal is not the face picked (a side face next to a moved top). */
const FACING = Math.cos(Math.PI / 4);

/**
 * The face nearest to the pick within the tolerance and facing roughly the pick's way; between equally near ones the
 * one facing it best.
 */
function faceAtPick(body: Body, pick: FacePickRef, candidates: FaceGeom[]): FaceGeom | null {
    const wanted = pick.normal ? unit(pick.normal) : null;
    const facing = (g: FaceGeom): number => {
        if (!wanted) {
            return 1;
        }
        try {
            return dot(unit(vec(g.face.normalAt(pick.at))), wanted);
        } catch {
            return -Infinity;
        }
    };
    const near = candidates.filter((g) => body.near(g.face, pick.at)).map((g) => ({ g, d: distanceToShape(pick.at, g.face) }))
        .filter((c) => c.d <= body.tolerance).map((c) => ({ ...c, f: facing(c.g) })).filter((c) => c.f >= FACING);
    if (near.length === 0) {
        return null;
    }
    const nearest = Math.min(...near.map((c) => c.d));
    return near.filter((c) => c.d <= nearest + TIE).reduce((best, c) => (c.f > best.f ? c : best)).g;
}

/**
 * The face a pick refers to on the body now. `kind` limits it to flat faces, cylinders or cones (any face when
 * absent). Off the pick: a flat face facing the pick's way in the pick's plane (split, grown or shrunk), else one
 * the line through the pick along its normal meets (moved along its normal), the nearest; a cylinder or cone about
 * the same axis as `hint` (a cylinder of the nearest radius).
 */
function findFace(body: Body, pick: FacePickRef, kind: FaceKind | null, hint: FaceHint = {}): FaceGeom | null {
    const all = body.faces.filter((g) => (kind ? g.type === kind : true));
    const on = faceAtPick(body, pick, all);
    if (on) {
        return on;
    }
    const tol = body.tolerance;
    if ((kind === null || kind === 'plane') && pick.normal) {
        const n = unit(pick.normal);
        const flat = all.filter((g): g is Extract<FaceGeom, { type: 'plane' }> => g.type === 'plane' && dot(g.normal, n) >= SAME_DIR);
        const offset = (g: Extract<FaceGeom, { type: 'plane' }>): number => dot(sub(g.point, pick.at), g.normal);
        const coplanar = flat.filter((g) => Math.abs(offset(g)) <= tol).sort((a, b) => Math.abs(offset(a)) - Math.abs(offset(b)));
        if (coplanar.length) {
            return coplanar[0];
        }
        const crossed = flat
            .filter((g) => {
                const crossing = add(pick.at, scale(g.normal, offset(g)));
                return body.near(g.face, crossing) && distanceToShape(crossing, g.face) <= tol;
            })
            .sort((a, b) => Math.abs(offset(a)) - Math.abs(offset(b)));
        if (crossed.length) {
            return crossed[0];
        }
    }
    const axis = hint.axis;
    if (axis && (kind === null || kind === 'cylinder' || kind === 'cone')) {
        const d = unit(axis.direction);
        const coaxial = all.filter((g): g is Extract<FaceGeom, { type: 'cylinder' | 'cone' }> => (g.type === 'cylinder' || g.type === 'cone')
            && Math.abs(dot(g.direction, d)) >= SAME_DIR && offLine(axis.point, g.point, g.direction) <= tol);
        const score = (g: Extract<FaceGeom, { type: 'cylinder' | 'cone' }>): number => (g.type === 'cylinder' && hint.radius !== undefined
            ? Math.abs(g.radius - hint.radius) : distanceToShape(pick.at, g.face));
        coaxial.sort((a, b) => score(a) - score(b));
        if (coaxial.length) {
            return coaxial[0];
        }
    }
    return null;
}

/** Faces that meet at an edge or a vertex, found again; null when any of them is gone. */
function findFaces(body: Body, faces: FacePickRef[], hint: FaceHint): FaceGeom[] | null {
    const found = faces.map((f) => findFace(body, f, null, hint));
    return found.every((g): g is FaceGeom => !!g) ? found : null;
}

/** Whether an edge is of the kind wanted, lying like the one picked (a line parallel to it, a circle about a parallel axis). */
function edgeFits(shape: ModelEdgeShape | null, kind: 'line' | 'circle' | null, was?: ModelEdgeShape): shape is ModelEdgeShape {
    if (!shape || (kind && shape.type !== kind)) {
        return false;
    }
    if (!was || was.type !== shape.type) {
        return true;
    }
    if (shape.type === 'line' && was.type === 'line') {
        return Math.abs(dot(unit(sub(shape.b, shape.a)), unit(sub(was.b, was.a)))) >= SAME_DIR;
    }
    return shape.type === 'circle' && was.type === 'circle' && Math.abs(dot(unit(shape.normal), unit(was.normal))) >= SAME_DIR;
}

/** Where an edge shape is, to choose the nearest of several. */
const edgeMiddle = (s: ModelEdgeShape): Vec3 => (s.type === 'line' ? scale(add(s.a, s.b), 0.5) : s.centre);

/**
 * The edge a pick refers to on the body now: the one at the pick point, else one where the faces that met there meet
 * now (the nearest to where it was). Returns its shape turned to run as the picked one did.
 */
function findEdge(body: Body, pick: ModelEdgePick, kind: 'line' | 'circle' | null): ModelEdgeShape | null {
    const was = pick.shape;
    const tol = body.tolerance;
    const shaped = (edge: Edge) => ({ edge, shape: edgeShape(edge) });
    const near = body.edges.filter((edge) => body.near(edge, pick.edge)).map((edge) => ({ edge, d: distanceToShape(pick.edge, edge) }))
        .filter((c) => c.d <= tol).sort((a, b) => a.d - b.d)
        .map((c) => shaped(c.edge)).filter((c) => edgeFits(c.shape, kind, was));
    if (near.length) {
        return orient(near[0].shape!, was);
    }
    if (!pick.faces?.length) {
        return null;
    }
    // A circle's faces (the flat end and the cylinder or cone through it) share its axis.
    const hint: FaceHint = was?.type === 'circle' ? { axis: { point: was.centre, direction: was.normal }, radius: was.radius } : {};
    const faces = findFaces(body, pick.faces, hint);
    if (!faces) {
        return null;
    }
    const common = faces[0].face.edges.filter((e) => faces.slice(1).every((g) => g.face.edges.some((x) => x.isSame(e))));
    const fits = common.map(shaped).filter((c) => edgeFits(c.shape, kind, was));
    if (fits.length === 0) {
        return null;
    }
    const from = was ? edgeMiddle(was) : pick.edge;
    fits.sort((a, b) => dist(edgeMiddle(a.shape!), from) - dist(edgeMiddle(b.shape!), from));
    return orient(fits[0].shape!, was);
}

/** The shape turned to run the way the picked one ran (a line from the same end, a circle about the same side). */
function orient(shape: ModelEdgeShape, was?: ModelEdgeShape): ModelEdgeShape {
    if (!was || was.type !== shape.type) {
        return shape;
    }
    if (shape.type === 'line' && was.type === 'line') {
        return dot(sub(shape.b, shape.a), sub(was.b, was.a)) < 0 ? { ...shape, a: shape.b, b: shape.a } : shape;
    }
    if (shape.type === 'circle' && was.type === 'circle' && dot(shape.normal, was.normal) < 0) {
        if (shape.full) {
            return { ...shape, normal: scale(shape.normal, -1) };
        }
        return { ...shape, normal: scale(shape.normal, -1), start: shape.end, end: shape.start };
    }
    return shape;
}

/** A full circle starts where the picked one did (turned onto it): points along it keep their places. */
function startLike(shape: ModelEdgeShape, was?: ModelEdgeShape): ModelEdgeShape {
    if (shape.type !== 'circle' || !shape.full || was?.type !== 'circle') {
        return shape;
    }
    const n = unit(shape.normal);
    const radial = sub(was.start, shape.centre);
    const flat = sub(radial, scale(n, dot(radial, n)));
    if (len(flat) < 1e-9) {
        return shape;
    }
    const start = add(shape.centre, scale(unit(flat), shape.radius));
    return { ...shape, start, end: start };
}

function vertexPoints(shape: { wrapped: unknown }): Vec3[] {
    const out: Vec3[] = [];
    for (const v of iterTopo(shape.wrapped as never, 'vertex')) {
        const vertex = new Vertex(v);
        out.push(vertex.asTuple());
        vertex.delete();
    }
    return out;
}

/** The vertex a pick refers to on the body now: the one at the pick, else where the faces that met there meet now. */
function findVertex(body: Body, pick: ModelVertexPick): Vec3 | null {
    const all = vertexPoints(body.shape);
    const nearest = all.reduce<Vec3 | null>((best, p) => (!best || dist(p, pick.vertex) < dist(best, pick.vertex) ? p : best), null);
    if (nearest && dist(nearest, pick.vertex) <= body.tolerance) {
        return nearest;
    }
    if (!pick.faces?.length) {
        return null;
    }
    const faces = findFaces(body, pick.faces, {});
    if (!faces) {
        return null;
    }
    const lists = faces.map((g) => vertexPoints(g.face));
    const common = lists[0].filter((p) => lists.slice(1).every((l) => l.some((q) => dist(p, q) <= SAME_POINT)));
    common.sort((a, b) => dist(a, pick.vertex) - dist(b, pick.vertex));
    return common[0] ?? null;
}

// ---- References of a step ----------------------------------------------------------------------------------

class Lost extends Error {}

function lost(what: string, where: Vec3): never {
    throw new Lost(`${what} picked at ${at(where)}`);
}

/** An edge pick with the shape it was found as (a full circle starting where the picked one did). */
const withShape = <T extends object>(pick: T, shape: ModelEdgeShape | null, was?: ModelEdgeShape): T =>
    (shape && 'edge' in pick ? { ...pick, shape: startLike(shape, was) } : pick);

/** The plane of a flat face or circular edge, through where it was (moved onto it along the normal). */
function followPlane(body: Body, ref: { fixedPlane: CustomSketchPlane; pick: { face: FacePickRef } | ModelEdgePick }) {
    const was = ref.fixedPlane;
    const n0 = unit(was.normal);
    let normal: Vec3;
    let point: Vec3;
    let shape: ModelEdgeShape | null = null;
    if ('face' in ref.pick) {
        const pick = ref.pick.face;
        const g = findFace(body, { at: pick.at, normal: pick.normal ?? n0 }, 'plane');
        if (g?.type !== 'plane') {
            return lost('the flat face', pick.at);
        }
        normal = g.normal;
        point = g.point;
    } else {
        shape = findEdge(body, ref.pick, 'circle');
        if (shape?.type !== 'circle') {
            return lost('the circular edge', ref.pick.edge);
        }
        normal = unit(shape.normal);
        point = shape.centre;
    }
    normal = dot(normal, n0) < 0 ? scale(normal, -1) : normal;
    return {
        fixedPlane: normalizePlane({ origin: ontoPlane(was.origin, point, normal), normal, xDir: was.xDir }),
        pick: withShape(ref.pick, shape, 'edge' in ref.pick ? ref.pick.shape : undefined),
    };
}

/** The line of a straight edge (through its midpoint) or the axis of a cylinder or cone (level with where it was). */
function followAxis(body: Body, ref: { fixedAxis: FixedLine; from?: string; pick: ModelEdgePick | { face: FacePickRef } }) {
    const was = ref.fixedAxis;
    const d0 = unit(was.direction);
    const same = (d: Vec3): Vec3 => (dot(d, d0) < 0 ? scale(d, -1) : d);
    if ('face' in ref.pick) {
        const kind = ref.from === 'cone' ? 'cone' : 'cylinder';
        const g = findFace(body, ref.pick.face, kind, { axis: was });
        if (g?.type !== 'cylinder' && g?.type !== 'cone') {
            return lost(`the ${kind === 'cone' ? 'conical' : 'cylindrical'} face`, ref.pick.face.at);
        }
        const direction = same(g.direction);
        return { fixedAxis: { point: ontoLine(was.point, g.point, direction), direction }, pick: ref.pick };
    }
    const shape = findEdge(body, ref.pick, 'line');
    if (shape?.type !== 'line') {
        return lost('the straight edge', ref.pick.edge);
    }
    return {
        fixedAxis: { point: scale(add(shape.a, shape.b), 0.5), direction: same(unit(sub(shape.b, shape.a))) },
        pick: withShape(ref.pick, shape, ref.pick.shape),
    };
}

function followCylinder(body: Body, ref: FixedCylinder & { pick: { face: FacePickRef } }): FixedCylinder {
    const g = findFace(body, ref.pick.face, 'cylinder', { axis: ref, radius: ref.radius });
    if (g?.type !== 'cylinder') {
        return lost('the cylindrical face', ref.pick.face.at);
    }
    const direction = dot(g.direction, ref.direction) < 0 ? scale(g.direction, -1) : g.direction;
    return { ...ref, point: ontoLine(ref.point, g.point, direction), direction, radius: g.radius };
}

function followEdgePick(body: Body, pick: ModelEdgePick, kind: 'line' | 'circle' | null, what: string): ModelEdgePick {
    const shape = findEdge(body, pick, kind);
    if (!shape) {
        return lost(what, pick.edge);
    }
    return { ...pick, shape: startLike(shape, pick.shape) };
}

function followPoint(body: Body, ref: { fixedPoint: Vec3; from: 'vertex' | 'centre'; pick: ModelVertexPick | ModelEdgePick }) {
    if ('vertex' in ref.pick) {
        return { fixedPoint: findVertex(body, ref.pick) ?? lost('the vertex', ref.pick.vertex), pick: ref.pick };
    }
    const pick = followEdgePick(body, ref.pick, 'circle', 'the circular edge');
    return { fixedPoint: pick.shape?.type === 'circle' ? pick.shape.centre : lost('the circular edge', ref.pick.edge), pick };
}

/** Every reference with a pick in a definition, found again (the rest as it is). */
function followValue(body: Body, value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((v) => followValue(body, v));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const o = value as Record<string, unknown>;
    if (o.pick && typeof o.pick === 'object') {
        if ('fixedPlane' in o) {
            return { ...o, ...followPlane(body, o as Parameters<typeof followPlane>[1]) };
        }
        if ('fixedAxis' in o) {
            return { ...o, ...followAxis(body, o as Parameters<typeof followAxis>[1]) };
        }
        if ('fixedPoint' in o) {
            return { ...o, ...followPoint(body, o as Parameters<typeof followPoint>[1]) };
        }
        if ('radius' in o && 'direction' in o) {
            return followCylinder(body, o as unknown as Parameters<typeof followCylinder>[1]);
        }
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, followValue(body, v)]));
}

/**
 * A tangent plane made where a cylinder was clicked keeps that spot as coordinates on its surface: when the cylinder
 * follows the model, the spot goes with it (same height along the axis and the same side).
 */
function tangentSpot(before: unknown, after: unknown): unknown {
    const b = before as { kind?: string; cylinder?: FixedCylinder; point?: unknown; plane?: unknown };
    const a = after as typeof b;
    if (b.kind !== 'tangent' || !b.cylinder?.pick || !a.cylinder || !Array.isArray(b.point) || b.plane !== undefined) {
        return after;
    }
    const was = b.cylinder;
    const d = unit(was.direction);
    const rel = sub(b.point as Vec3, was.point);
    const along = dot(rel, d);
    const radial = sub(rel, scale(d, along));
    if (Math.abs(len(radial) - was.radius) > 1e-6 * Math.max(1, was.radius) || len(radial) < 1e-12) {
        return after;
    }
    const now = a.cylinder;
    const dn = unit(now.direction);
    const out = sub(radial, scale(dn, dot(radial, dn)));
    return { ...a, point: add(ontoLine(add(was.point, scale(d, along)), now.point, dn), scale(unit(out), now.radius)) };
}

function followPointStep(body: Body, d: PointDefinition, position: Vec3): { definition: PointDefinition; position: Vec3 } {
    switch (d.kind) {
        case 'arcCentre': {
            const definition = { ...d, edge: followEdgePick(body, d.edge, 'circle', 'the circular edge') };
            return { definition, position: pointOfDefinition(definition, position) };
        }
        case 'faceCentre': {
            const g = findFace(body, d.face, null);
            return { definition: d, position: g ? vec(g.face.center) : lost('the face', d.face.at) };
        }
        case 'vertex':
            return { definition: d, position: findVertex(body, d.vertex) ?? lost('the vertex', d.vertex.vertex) };
        case 'intersection': {
            const definition = {
                ...d, a: followEdgePick(body, d.a, 'line', 'the first straight edge'), b: followEdgePick(body, d.b, 'line', 'the second straight edge'),
            };
            return { definition, position: pointOfDefinition(definition, position) };
        }
        case 'along': {
            const definition = { ...d, edge: followEdgePick(body, d.edge, d.edge.shape?.type ?? null, 'the edge') };
            return { definition, position: pointOfDefinition(definition, position) };
        }
    }
}

/**
 * A reference step (plane, axis or point) with every reference it takes from the model found again on `shape`, the
 * body as it is before the step: its cached values (fixedPlane, fixedAxis, fixedPoint, a cylinder, an edge's shape,
 * a point's position) are where they are now. Steps without picks come back as they are. Throws an error naming
 * what is lost when a picked face, edge or vertex is no longer on the body.
 */
export function followStep(shape: Shape3D | null, f: Feature): Feature {
    if (!followsModel(f)) {
        return f;
    }
    const name = f.name ?? f.id;
    if (!shape) {
        throw new Error(`its reference is taken from the model, but there is no body before it; edit ${name} and pick another reference`);
    }
    const body = new Body(shape);
    try {
        if (f.op === 'point' && f.definition) {
            return { ...f, ...followPointStep(body, f.definition, f.position) };
        }
        if (f.op === 'plane' || f.op === 'axis') {
            return { ...f, definition: tangentSpot(f.definition, followValue(body, f.definition)) } as Feature;
        }
        return f;
    } catch (e) {
        if (e instanceof Lost) {
            throw new Error(`a reference it was made from is missing (it dangles): ${e.message} is no longer on the part. `
                + `Edit ${name} and pick it again`);
        }
        throw e;
    }
}
