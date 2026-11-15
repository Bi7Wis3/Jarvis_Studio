// Modelled threads: helical ridges, the Thread step on circular edges (or from a point), chamfers on a thread's end,
// and the quick ghost a tool preview shows in place of the slow booleans.

import {
    cast, downcast, genericSweep, getOC, localGC, makeAx3, makeBox, makeCompound, makeCylinder, makeHelix, makePolygon, measureVolume,
    revolution, Wire, type Edge, type Face, type Shape3D,
} from 'replicad';
import type { FacePickRef, Feature, PrintSettings, Vec3 } from '@jarvis/core';
import type { MeshData } from './kernel.js';
import { pickTolerance, resolveEdges, resolveFaces } from './refs.js';

type P2 = [number, number];
type ThreadStep = Extract<Feature, { op: 'thread' }>;

/** ISO metric: the minor (tap drill) diameter is the major diameter less 1.0825 x pitch. */
export const MINOR_DEPTH = 1.0825;
const TAN30 = Math.tan(Math.PI / 6);
/** Thread ridges overlap their core / wall by this much so they are one connected body. */
const THREAD_OVERLAP = 0.02;
/** How far past the major radius (into the wall, or the shaft's core) the material behind a ridge is looked for. */
const WALL_DEPTH = THREAD_OVERLAP + 0.005;
/** Angular mesh step of a ghost ridge, in radians (as the kernel meshes). */
const ANGULAR_TOLERANCE = 0.2;

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const fmtMm = (mm: number): string => `${Math.round(mm * 1e6) / 1e6} mm`;

function asSolid(shape: unknown, what: string): Shape3D {
    const s = shape as Shape3D;
    if (!s || s.isNull || s.solids.length === 0) {
        throw new Error(`${what} produced no solid`);
    }
    return s;
}

/** Solid of revolution about Y of a closed [radius, y] polygon. */
function revolve(points: P2[]): Shape3D {
    const face = makePolygon(points.map(([r, y]) => [r, y, 0]));
    return asSolid(revolution(face, [0, 0, 0], [0, 1, 0]), 'revolve');
}

function cylinderY(radius: number, y0: number, y1: number): Shape3D {
    return makeCylinder(radius, y1 - y0, [0, y0, 0], [0, 1, 0]);
}

/** The part of a solid built along Y between y0 and y1 (a box: its sides are planes clear of the solid). */
function sliceY(shape: Shape3D, reach: number, y0: number, y1: number): Shape3D {
    return asSolid(shape.intersect(makeBox([-reach, y0, -reach], [reach, y1, reach]), { simplify: false }), 'trimmed thread');
}

// ---- Placement on an axis -------------------------------------------------------------------------------------

/** Rotation of v about the unit axis k by `angle` radians (right hand). */
function rotate3(v: Vec3, k: Vec3, angle: number): Vec3 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return add3(add3(scale3(v, c), scale3(cross3(k, v), s)), scale3(k, dot3(k, v) * (1 - c)));
}

/**
 * The frame a thread is built in: Y along its axis from `origin`, turned `angle` degrees about it. `toWorld` and
 * `toLocal` map points (and, without the origin, directions); `place` moves a solid built in the frame.
 */
interface Frame {
    toWorld(p: Vec3, direction?: boolean): Vec3;
    toLocal(p: Vec3): Vec3;
    place(solid: Shape3D, turn?: number): Shape3D;
}

function frameOf(origin: Vec3, axis: Vec3, angle: number): Frame {
    const length = Math.hypot(...axis);
    const d: Vec3 = [axis[0] / length, axis[1] / length, axis[2] / length];
    // As orientDown in build.ts: +Y is turned onto the axis about (0, -1, 0) x (-axis), or half a turn about X.
    const k: Vec3 = [d[2], 0, -d[0]];
    const kLength = Math.hypot(...k);
    const tilt = d[1] > 1 - 1e-9 ? null : d[1] < -1 + 1e-9 ? { k: [1, 0, 0] as Vec3, a: Math.PI }
        : { k: scale3(k, 1 / kLength), a: Math.acos(d[1]) };
    const spin = (angle * Math.PI) / 180;
    const forward = (p: Vec3): Vec3 => {
        const q = rotate3(p, [0, 1, 0], spin);
        return tilt ? rotate3(q, tilt.k, tilt.a) : q;
    };
    const backward = (p: Vec3): Vec3 => rotate3(tilt ? rotate3(p, tilt.k, -tilt.a) : p, [0, 1, 0], -spin);
    return {
        toWorld: (p, direction = false) => (direction ? forward(p) : add3(forward(p), origin)),
        toLocal: (p) => backward(sub3(p, origin)),
        place: (solid, turn = 0) => {
            let out = angle + turn ? solid.rotate(angle + turn, [0, 0, 0], [0, 1, 0]) : solid;
            if (tilt) {
                out = out.rotate((tilt.a * 180) / Math.PI, [0, 0, 0], tilt.k);
            }
            return out.translate(origin);
        },
    };
}

/** Turns a solid built along +Y from the origin onto `axis` (unit) at `origin`, first turning it `angle` degrees about Y. */
export function placeOnAxis(solid: Shape3D, origin: Vec3, axis: Vec3, angle: number): Shape3D {
    return frameOf(origin, axis, angle).place(solid);
}

// ---- Ridges -------------------------------------------------------------------------------------------------

/** Analytic description of a swept thread ridge, so it can be meshed without OpenCascade's mesher. */
export interface RidgeSpec {
    pitch: number;
    rBase: number;
    rCrest: number;
    wBase: number;
    wCrest: number;
    y0: number;
    height: number;
    /** Helix advance per turn when it differs from the pitch (multi-start threads). */
    lead?: number;
    leftHanded?: boolean;
    /** Degrees about Y where the ridge starts (a piece of a ridge, another start). */
    turn?: number;
}

export interface Ridge {
    shape: Shape3D;
    spec: RidgeSpec;
}

/**
 * A helix of `height` on a cylinder about Z from the origin, as one edge per turn. One long edge is approximated as a
 * single curve whose error grows with the turns (a 50 turn ridge swept on it came out 7% too big); a turn each stays
 * exact, and booleans then only look at the turns near what they cut.
 */
function helixByTurns(lead: number, height: number, radius: number, leftHanded: boolean): Wire {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const surface = new oc.Geom_CylindricalSurface(r(makeAx3([0, 0, 0], [0, 0, 1])), radius);
        const turns = height / lead;
        const count = Math.max(1, Math.ceil(turns - 1e-6));
        const u = leftHanded ? -2 * Math.PI : 2 * Math.PI;
        const builder = r(new oc.BRepBuilderAPI_MakeWire());
        for (let i = 0; i < count; i++) {
            const [t0, t1] = [i, Math.min(turns, i + 1)];
            const segment = r(new oc.GC_MakeSegment2d(r(new oc.gp_Pnt2d(u * t0, lead * t0)), r(new oc.gp_Pnt2d(u * t1, lead * t1))));
            builder.Add(r(new oc.BRepBuilderAPI_MakeEdge(r(segment.Value()), surface)).Edge());
        }
        const wire = builder.Wire();
        oc.BRepLib.BuildCurves3d(wire);
        return new Wire(wire);
    } finally {
        gc();
    }
}

/**
 * A helical ISO-style ridge (60 degree flanks) swept around the Y axis, from y0 up by `height` (helix travel).
 * The profile runs radially from `rBase` (buried in the core or wall) to `rCrest`, with the given axial widths.
 * `byTurns`: one face per turn (see helixByTurns); fasteners keep the single sweep they are meshed from.
 */
export function threadRidge(spec: RidgeSpec, byTurns = false): Ridge {
    const { pitch, rBase, rCrest, wBase, wCrest, y0, height } = spec;
    const lead = spec.lead ?? pitch;
    const helix = byTurns ? helixByTurns(lead, height, rBase, !!spec.leftHanded)
        : makeHelix(lead, height, rBase, [0, 0, 0], [0, 0, 1], !!spec.leftHanded);
    const profile = makePolygon([
        [rBase, 0, -wBase / 2], [rCrest, 0, -wCrest / 2], [rCrest, 0, wCrest / 2], [rBase, 0, wBase / 2],
    ]);
    const ridge = genericSweep(profile.outerWire(), helix, { frenet: true });
    // Built along Z; turn Z onto Y (right-handed thread is preserved by a rotation).
    let shape = asSolid(ridge, 'thread sweep').rotate(-90, [0, 0, 0], [1, 0, 0]);
    if (spec.turn) {
        shape = shape.rotate(spec.turn, [0, 0, 0], [0, 1, 0]);
    }
    return { shape: shape.translate(0, y0, 0), spec };
}

/** The ridge of an external thread for a major radius, inside the zone [yLow, yHigh]; null if the zone is too short. */
function externalSpec(pitch: number, rMajor: number, rRoot: number, yLow: number, yHigh: number,
    hand: Pick<RidgeSpec, 'lead' | 'leftHanded'> = {}, proud = 0): RidgeSpec | null {
    const rBase = rRoot - THREAD_OVERLAP;
    const wCrest = pitch / 8;
    const wBase = wCrest + 2 * (rMajor - rBase) * TAN30;
    const y0 = yLow + wBase / 2 + 0.01;
    const height = yHigh - wBase / 2 - 0.01 - y0;
    if (height < pitch || wBase >= pitch * 0.98) {
        return null;
    }
    // `proud`: the flanks carried on past the crest by that fraction of the pitch (a sharper, taller ridge). Taken out
    // of a cutter, its flanks then pass straight through the surface the crest lies in, and the cutter has neither a
    // face nor an edge in that surface.
    const more = Math.min(proud, 0.09) * pitch;
    return { pitch, rBase, rCrest: rMajor + more, wBase, wCrest: wCrest - 2 * more * TAN30, y0, height, ...hand };
}

/** The ridge of an internal thread in a bore of radius rMajor, inside [yLow, yHigh]; null if too short. */
function internalSpec(pitch: number, rMajor: number, yLow: number, yHigh: number,
    hand: Pick<RidgeSpec, 'lead' | 'leftHanded'> = {}, proud = 0): RidgeSpec | null {
    const rBase = rMajor + THREAD_OVERLAP;
    const rCrest = rMajor - (MINOR_DEPTH * pitch) / 2;
    const wCrest = pitch / 4;
    const wBase = wCrest + 2 * (rBase - rCrest) * TAN30;
    const y0 = yLow + wBase / 2 + 0.01;
    const height = yHigh - wBase / 2 - 0.01 - y0;
    if (height < pitch || wBase >= pitch * 0.98) {
        return null;
    }
    const more = Math.min(proud, 0.18) * pitch;
    return { pitch, rBase, rCrest: rCrest - more, wBase, wCrest: wCrest - 2 * more * TAN30, y0, height, ...hand };
}

/** External thread ridge for a major radius, inside the zone [yLow, yHigh]; null if the zone is too short. */
export function externalRidge(pitch: number, rMajor: number, rRoot: number, yLow: number, yHigh: number,
    hand: Pick<RidgeSpec, 'lead' | 'leftHanded'> = {}, proud = 0): Ridge | null {
    const spec = externalSpec(pitch, rMajor, rRoot, yLow, yHigh, hand, proud);
    return spec && threadRidge(spec);
}

/** Internal thread ridge in a bore of radius rMajor, inside [yLow, yHigh]; null if too short. */
export function internalRidge(pitch: number, rMajor: number, yLow: number, yHigh: number,
    hand: Pick<RidgeSpec, 'lead' | 'leftHanded'> = {}, proud = 0): Ridge | null {
    const spec = internalSpec(pitch, rMajor, yLow, yHigh, hand, proud);
    return spec && threadRidge(spec);
}

/** Exact helical mesh of a thread ridge: four strips (smooth within, sharp between) and two end caps. */
export function ridgeMesh(spec: RidgeSpec, angularTolerance = ANGULAR_TOLERANCE): MeshData {
    const { pitch, rBase, rCrest, wBase, wCrest, y0, height } = spec;
    const lead = spec.lead ?? pitch;
    const turns = height / lead;
    const steps = Math.max(8, Math.ceil(turns * Math.ceil((2 * Math.PI) / angularTolerance)));
    const profile: P2[] = [[rBase, -wBase / 2], [rCrest, -wCrest / 2], [rCrest, wCrest / 2], [rBase, wBase / 2]];
    const sweep = 2 * Math.PI * turns * (spec.leftHanded ? -1 : 1);
    const turn = ((spec.turn ?? 0) * Math.PI) / 180;
    // Z-up helix turned onto Y: (x, y, z) -> (x, z, -y), then lifted by y0.
    const point = (i: number, j: number): Vec3 => {
        const theta = (sweep * i) / steps;
        const [r, dz] = profile[j % 4];
        return [r * Math.cos(theta + turn), y0 + (lead * Math.abs(theta)) / (2 * Math.PI) + dz, -r * Math.sin(theta + turn)];
    };
    const tangent = (i: number, j: number): Vec3 => {
        const theta = (sweep * i) / steps;
        const r = profile[j % 4][0];
        const k = spec.leftHanded ? -1 : 1;
        return [-r * k * Math.sin(theta + turn), lead / (2 * Math.PI), -r * k * Math.cos(theta + turn)];
    };
    const unit = (v: Vec3): Vec3 => {
        const l = Math.hypot(...v) || 1;
        return [v[0] / l, v[1] / l, v[2] / l];
    };
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const edges: number[] = [];
    const triFace: number[] = [];
    const segEdge: number[] = [];
    for (let j = 0; j < 4; j++) {
        const start = positions.length / 3;
        for (let i = 0; i <= steps; i++) {
            const a = point(i, j);
            const d = point(i, j + 1);
            const n = unit(cross3(sub3(d, a), tangent(i, j)));
            positions.push(...a, ...d);
            normals.push(...n, ...n);
            if (i > 0) {
                edges.push(...point(i - 1, j), ...a);
                segEdge.push(j);
            }
        }
        for (let i = 0; i < steps; i++) {
            const a = start + i * 2;
            const d = a + 1;
            const b = a + 2;
            const c = a + 3;
            indices.push(a, d, c, a, c, b);
            triFace.push(j, j);
        }
    }
    // Faces: the four strips, then the two caps; edges: the four helices, then each cap's four sides.
    const cap = (i: number, order: number[], face: number): void => {
        const start = positions.length / 3;
        const [p0, p1, p2] = order.map((j) => point(i, j));
        const n = unit(cross3(sub3(p1, p0), sub3(p2, p0)));
        for (const j of order) {
            positions.push(...point(i, j));
            normals.push(...n);
        }
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
        triFace.push(face, face);
        for (let j = 0; j < 4; j++) {
            edges.push(...point(i, j), ...point(i, j + 1));
            segEdge.push(4 + (face - 4) * 4 + j);
        }
    };
    // Caps run against the strips' edges so the whole surface is consistently wound.
    cap(0, [3, 2, 1, 0], 4);
    cap(steps, [0, 1, 2, 3], 5);
    // Make the winding outward (the profile's direction depends on internal vs external threads).
    let volume = 0;
    for (let k = 0; k < indices.length; k += 3) {
        const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]].map((v) => positions.slice(v * 3, v * 3 + 3) as Vec3);
        volume += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    if (volume < 0) {
        for (let k = 0; k < indices.length; k += 3) {
            [indices[k + 1], indices[k + 2]] = [indices[k + 2], indices[k + 1]];
        }
        for (let k = 0; k < normals.length; k++) {
            normals[k] = -normals[k];
        }
    }
    return {
        positions: Float32Array.from(positions),
        normals: Float32Array.from(normals),
        indices: Uint32Array.from(indices),
        edges: Float32Array.from(edges),
        triFace: Uint32Array.from(triFace),
        segEdge: Uint32Array.from(segEdge),
    };
}

/** A thread shown, not built: a ridge placed on its axis, for a tool preview. */
export interface ThreadGhost {
    spec: RidgeSpec;
    origin: Vec3;
    axis: Vec3;
    /** Degrees about the axis (the start angle). */
    angle: number;
}

/** The ghost's ridge, meshed analytically and placed on its axis. */
export function ghostMesh(ghost: ThreadGhost, angularTolerance = ANGULAR_TOLERANCE): MeshData {
    const mesh = ridgeMesh(ghost.spec, angularTolerance);
    const frame = frameOf(ghost.origin, ghost.axis, ghost.angle);
    const map = (values: Float32Array, direction: boolean): void => {
        for (let i = 0; i < values.length; i += 3) {
            const p = frame.toWorld([values[i], values[i + 1], values[i + 2]], direction);
            values.set(p, i);
        }
    };
    map(mesh.positions, false);
    map(mesh.normals, true);
    map(mesh.edges, false);
    return mesh;
}

// ---- Where a thread sits ------------------------------------------------------------------------------------

/** Centre, unit normal and radius of a circular edge. */
function circleOf(edge: Edge): { centre: Vec3; normal: Vec3; radius: number } {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const circle = r(r(new oc.BRepAdaptor_Curve(edge.wrapped)).Circle());
        const loc = r(circle.Location());
        const dir = r(r(circle.Axis()).Direction());
        return { centre: [loc.X(), loc.Y(), loc.Z()], normal: [dir.X(), dir.Y(), dir.Z()], radius: circle.Radius() };
    } finally {
        gc();
    }
}

/**
 * The full-circle end of a cylindrical face that a thread was picked on. When the mouth has been chamfered or rounded
 * since (the picked edge is gone), the nearest end of a cylinder the pick still lies on: the thread then starts
 * behind the chamfer.
 */
function threadStart(shape: Shape3D, at: Vec3): { edge: Edge; face: Face } {
    const cylinders = shape.faces.filter((f) => f.geomType === 'CYLINDRE');
    const ends = (edge: Edge): boolean => edge.geomType === 'CIRCLE' && edge.isClosed;
    let picked: Edge | null = null;
    try {
        [picked] = resolveEdges(shape, [at]);
    } catch {
        picked = null;
    }
    if (picked && ends(picked)) {
        const exact = picked;
        const face = cylinders.find((f) => f.edges.some((e) => e.isSame(exact)));
        if (face) {
            return { edge: exact, face };
        }
    }
    const tolerance = pickTolerance(shape);
    let best: { edge: Edge; face: Face; gap: number } | null = null;
    for (const face of cylinders) {
        for (const edge of face.edges.filter(ends)) {
            const { centre, normal, radius } = circleOf(edge);
            const rel = sub3(at, centre);
            const k = dot3(rel, normal);
            const gap = Math.abs(k);
            const off = Math.hypot(...sub3(rel, scale3(normal, k)));
            if (Math.abs(off - radius) <= tolerance && gap <= radius && (!best || gap < best.gap)) {
                best = { edge, face, gap };
            }
        }
    }
    if (!best) {
        throw new Error(picked && !ends(picked)
            ? 'the thread needs the circular edge at the end of a shaft or hole; the picked edge is not a full circle'
            : 'the thread needs the circular edge at the end of a shaft or hole, and it is no longer on the part; pick it again');
    }
    return best;
}

/** Where a thread picked on a circular edge sits. */
export interface ThreadEdge {
    centre: Vec3;
    /** Unit axis pointing from the edge into its cylindrical face. */
    axis: Vec3;
    radius: number;
    /** How far the cylinder runs from the edge. */
    reach: number;
    hole: boolean;
}

export function threadEdge(shape: Shape3D, at: Vec3): ThreadEdge {
    const { edge, face } = threadStart(shape, at);
    const { centre, normal, radius } = circleOf(edge);
    // The face's centre of mass lies on the axis halfway along it: that gives the side and the length.
    const mid = face.center.toTuple() as Vec3;
    const along = dot3(sub3(mid, centre), normal);
    const axis: Vec3 = along < 0 ? scale3(normal, -1) : normal;
    // On a point of the face, the outward normal points away from the axis on a shaft and toward it in a hole.
    const onFace = face.pointOnSurface(0.5, 0.5).toTuple() as Vec3;
    const rel = sub3(onFace, centre);
    const radial = sub3(rel, scale3(axis, dot3(rel, axis)));
    const outward = face.normalAt(onFace).toTuple() as Vec3;
    return { centre, axis, radius, reach: Math.max(2 * Math.abs(along), cylinderReach(shape, centre, axis, radius)), hole: dot3(outward, radial) < 0 };
}

/**
 * How far a hole or shaft runs from its edge along the axis: over every face of the same cylinder (a hole that breaks
 * out through a curved wall is split into several, partial ones) that follows on from the edge without a gap.
 */
function cylinderReach(shape: Shape3D, centre: Vec3, axis: Vec3, radius: number): number {
    const spans: [number, number][] = [];
    for (const face of cylinderFaces(shape, centre, axis, radius)) {
        const along = face.edges.flatMap((e) => Array.from({ length: 17 }, (_, i) => dot3(sub3(e.pointAt(i / 16).toTuple() as Vec3, centre), axis)));
        spans.push([Math.min(...along), Math.max(...along)]);
    }
    let reach = 0;
    for (const [a, b] of spans.sort((p, q) => p[0] - q[0])) {
        if (a > reach + 1e-4) {
            break;
        }
        reach = Math.max(reach, b);
    }
    return reach;
}

/** The faces of a body that lie on one cylinder (axis through `centre` along unit `axis`, `radius`). */
function cylinderFaces(shape: Shape3D, centre: Vec3, axis: Vec3, radius: number): Face[] {
    const oc = getOC();
    return shape.faces.filter((face) => {
        if (face.geomType !== 'CYLINDRE') {
            return false;
        }
        const [r, gc] = localGC();
        try {
            const cylinder = r(r(new oc.BRepAdaptor_Surface(face.wrapped, true)).Cylinder());
            const ax = r(cylinder.Axis());
            const loc = r(ax.Location());
            const dir = r(ax.Direction());
            const rel = sub3([loc.X(), loc.Y(), loc.Z()], centre);
            const off = Math.hypot(...sub3(rel, scale3(axis, dot3(rel, axis))));
            return Math.abs(cylinder.Radius() - radius) <= 1e-5 && Math.hypot(...cross3([dir.X(), dir.Y(), dir.Z()], axis)) <= 1e-7 && off <= 1e-5;
        } finally {
            gc();
        }
    });
}

/** Where a thread step runs on the body it is cut into: for the chamfers and fillets that come after it. */
export interface ThreadAxis {
    point: Vec3;
    dir: Vec3;
    radius: number;
    pitch: number;
    kind: 'external' | 'internal';
    /** The radius a chamfer on the thread's end is measured from: the hole's opening, or the shaft's outside. */
    mouth: number;
    /** How far the hole or shaft runs from `point` along `dir`. */
    reach: number;
}

function axisOf(f: ThreadStep, print: PrintSettings, edge: ThreadEdge | null): ThreadAxis {
    const crest = (major: number): number => (f.kind === 'internal'
        ? (major + print.holeTolerance) / 2 - (MINOR_DEPTH * f.pitch) / 2 : major / 2);
    if (!edge) {
        const major = f.diameter ?? 0;
        return {
            point: f.position ?? [0, 0, 0], dir: [0, 1, 0], radius: major / 2, pitch: f.pitch, kind: f.kind, mouth: crest(major),
            reach: f.length ?? (f.revolutions ?? 0) * f.pitch * (f.starts ?? 1),
        };
    }
    const major = f.diameter ?? (f.kind === 'external' ? 2 * edge.radius : 2 * edge.radius + MINOR_DEPTH * f.pitch);
    return {
        point: edge.centre, dir: edge.axis, radius: f.diameter !== undefined ? f.diameter / 2 : edge.radius, pitch: f.pitch, kind: f.kind,
        // The opening is the hole itself or the crests, whichever is narrower; a shaft's outside the wider of the two.
        mouth: f.kind === 'internal' ? Math.min(edge.radius, crest(major)) : Math.max(edge.radius, crest(major)),
        reach: edge.reach,
    };
}

// ---- Where the wall stands ----------------------------------------------------------------------------------

/**
 * Where a cylinder about the thread's axis runs through no material: the hole comes out through a slanted or curved
 * face there, meets another hole, or a shaft has a flat or a cross hole. Built as two overlapping half cylinders cut
 * by the part, each kept as the outline of its open patches in (angle about the axis, distance along it) of the
 * thread's frame; null when the material is whole all round, the usual case.
 */
interface Openings {
    radius: number;
    /** Where the line along the axis at `angle` crosses the outline of the open patches, in order: open between pairs. */
    crossings(angle: number): number[];
    /**
     * Where the circle at `s` crosses the outline, in order, as angles of the half that answers for `angle` (open
     * between pairs), and `angle` as an angle of that half.
     */
    around(s: number, angle: number): { angles: number[]; at: number };
}

function openings(shape: Shape3D, frame: Frame, radius: number, low: number, high: number): Openings | null {
    const oc = getOC();
    const BINS = 400;
    const SPAN = (200 * Math.PI) / 180;
    const halves: { from: number; segments: number[]; bins: number[][]; rows: number[][] }[] = [];
    const row = (y: number): number => Math.floor(((y - low) / Math.max(high - low, 1e-9)) * BINS);
    // Half A from -100 to 100 degrees answers for -90 to 90, half B from 80 to 280 for the rest.
    for (const degrees of [-100, 80]) {
        const from = (degrees * Math.PI) / 180;
        const [r, gc] = localGC();
        let cut: Shape3D | null = null;
        try {
            const cylinder = r(new oc.gp_Cylinder(r(makeAx3([0, 0, 0], [0, 1, 0], [1, 0, 0])), radius));
            const face = cast(r(new oc.BRepBuilderAPI_MakeFace(cylinder, from, from + SPAN, low, high)).Face()) as Face;
            const placed = frame.place(face as unknown as Shape3D);
            const builder = r(new oc.BRepAlgoAPI_Cut(placed.wrapped, shape.wrapped));
            builder.Build();
            cut = cast(downcast(builder.Shape())) as Shape3D;
            placed.delete();
        } finally {
            gc();
        }
        // Each boundary edge as a polyline in (angle, s), filed by angle and by s.
        const segments: number[] = [];
        const bins: number[][] = Array.from({ length: BINS }, () => []);
        const rows: number[][] = Array.from({ length: BINS }, () => []);
        const file = (into: number[][], b0: number, b1: number, at: number): void => {
            for (let k = Math.max(0, Math.min(b0, b1)); k <= Math.min(BINS - 1, Math.max(b0, b1)); k++) {
                into[k].push(at);
            }
        };
        for (const face of cut?.faces ?? []) {
            for (const edge of face.edges) {
                const count = Math.max(8, Math.ceil(edge.length / 0.05));
                let last: P2 | null = null;
                for (let i = 0; i <= count; i++) {
                    const p = frame.toLocal(edge.pointAt(i / count).toTuple() as Vec3);
                    let a = Math.atan2(-p[2], p[0]);
                    if (degrees > 0 && a < 0) {
                        a += 2 * Math.PI;
                    }
                    const q: P2 = [a, p[1]];
                    if (last) {
                        const at = segments.length;
                        segments.push(last[0], last[1], q[0], q[1]);
                        file(bins, Math.floor(((last[0] - from) / SPAN) * BINS), Math.floor(((q[0] - from) / SPAN) * BINS), at);
                        file(rows, row(last[1]), row(q[1]), at);
                    }
                    last = q;
                }
            }
        }
        cut?.delete();
        halves.push({ from, segments, bins, rows });
    }
    if (halves.every((h) => h.segments.length === 0)) {
        return null;
    }
    /** The half that answers for an angle, and the angle as one of that half. */
    const halfOf = (angle: number): { half: (typeof halves)[number]; at: number } => {
        const a = Math.atan2(Math.sin(angle), Math.cos(angle));
        return Math.abs(a) <= Math.PI / 2 ? { half: halves[0], at: a } : { half: halves[1], at: a < 0 ? a + 2 * Math.PI : a };
    };
    return {
        radius,
        crossings(angle) {
            const { half, at } = halfOf(angle);
            // Nudged off the polyline's corners.
            const x = at + 1.234e-9;
            const g = half.segments;
            const out: number[] = [];
            for (const i of half.bins[Math.min(BINS - 1, Math.max(0, Math.floor(((x - half.from) / SPAN) * BINS)))]) {
                const [x0, y0, x1, y1] = [g[i], g[i + 1], g[i + 2], g[i + 3]];
                if ((x0 > x) !== (x1 > x)) {
                    out.push(y0 + ((x - x0) * (y1 - y0)) / (x1 - x0));
                }
            }
            return out.sort((p, q) => p - q);
        },
        around(s, angle) {
            const { half, at } = halfOf(angle);
            if (s < low || s > high) {
                return { angles: [], at };
            }
            const y = s + 2.345e-9;
            const g = half.segments;
            const out: number[] = [];
            for (const i of half.rows[Math.min(BINS - 1, Math.max(0, row(y)))]) {
                const [x0, y0, x1, y1] = [g[i], g[i + 1], g[i + 2], g[i + 3]];
                if ((y0 > y) !== (y1 > y)) {
                    out.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
                }
            }
            return { angles: out.sort((p, q) => p - q), at };
        },
    };
}

/**
 * The material a thread stands on, seen at two radii: `near` right behind the ridge's root, `far` a little deeper.
 * Between the two, the edge of the material (where the hole comes out through a face) is carried on in a straight
 * line, along the axis and around it, to each radius of the ridge's profile, as the face itself would run on across
 * the hole.
 */
interface Wall {
    near: Openings;
    far: Openings | null;
}

function wallOf(shape: Shape3D, frame: Frame, near: number, far: number, low: number, high: number): Wall | null {
    const [inner, outer] = [openings(shape, frame, near, low, high), openings(shape, frame, far, low, high)];
    if (!inner && !outer) {
        return null;
    }
    return { near: inner ?? { radius: near, crossings: () => [], around: (_, angle) => ({ angles: [], at: angle }) }, far: outer };
}

/** Walls a preview has looked at: while a value is typed it shows the same thread on the same body again and again. */
const seen = new Map<string, Wall | null>();

/** wallOf, kept for the next preview of the same body and place (`place`: the thread's origin, axis and angle). */
function wallSeen(shape: Shape3D, frame: Frame, place: string, near: number, far: number, low: number, high: number): Wall | null {
    const box = shape.boundingBox;
    const bounds = box.bounds.flat().map((v) => v.toFixed(6)).join(',');
    box.delete();
    const key = [shape.hashCode, shape.faces.length, measureVolume(shape).toFixed(6), bounds, place, near, far, low, high].join('|');
    if (!seen.has(key)) {
        seen.set(key, wallOf(shape, frame, near, far, low, high));
        while (seen.size > 32) {
            seen.delete(seen.keys().next().value as string);
        }
    }
    return seen.get(key) ?? null;
}

/**
 * A ridge kept to where the material it stands on is: the stretches of the helix where its whole profile lies on the
 * part's side of the face the hole (or shaft) comes out through, each swept as a piece of its own that ends square on
 * its profile. Nothing then hangs in the air or reaches past such a face; the ridge stops a little before the face
 * instead of being cut to its exact shape.
 */
function ridgePieces(spec: RidgeSpec, wall: Wall | null, startTurn: number): RidgeSpec[] {
    if (!wall) {
        return [{ ...spec, turn: (spec.turn ?? 0) + startTurn }];
    }
    const lead = spec.lead ?? spec.pitch;
    const turns = spec.height / lead;
    const sign = spec.leftHanded ? -1 : 1;
    // The profile at its crest, middle and base: radius and half its axial width, with 0.03 mm to spare so that the
    // ridge's root, buried in the wall, never reaches past the wall's edge either.
    const samples: P2[] = [0, 0.5, 1].map((k) => [spec.rCrest + k * (spec.rBase - spec.rCrest),
        (spec.wCrest + k * (spec.wBase - spec.wCrest)) / 2 + 0.03]);
    const [r0, r1] = [wall.near.radius, wall.far?.radius ?? wall.near.radius];
    const overlaps = (s: number, half: number, a: number, b: number): boolean => s - half < Math.max(a, b) && s + half > Math.min(a, b);
    const held = (t: number): boolean => {
        const angle = sign * 2 * Math.PI * t + ((spec.turn ?? 0) + startTurn) * (Math.PI / 180);
        const s = spec.y0 + lead * t;
        const c0 = wall.near.crossings(angle);
        const c1 = wall.far?.crossings(angle) ?? [];
        // The wall stands behind the whole profile right at the ridge's root and a little deeper too, so a ridge never
        // stands on a sliver of wall where the hole grazes a face.
        const base = samples[2][1];
        for (const c of [c0, c1]) {
            for (let i = 0; i + 1 < c.length; i += 2) {
                if (overlaps(s, base, c[i], c[i + 1])) {
                    return false;
                }
            }
        }
        // Where the edge of the wall crosses the axis's direction at both depths, it is carried on along the axis to
        // each radius of the profile.
        if (c0.length && c1.length === c0.length) {
            for (const [r, half] of samples) {
                const k = (r - r0) / (r1 - r0);
                for (let i = 0; i + 1 < c0.length; i += 2) {
                    if (overlaps(s, half, c0[i] + k * (c1[i] - c0[i]), c0[i + 1] + k * (c1[i + 1] - c0[i + 1]))) {
                        return false;
                    }
                }
            }
        }
        // Where it runs along the axis (the edge of a breakout along the hole), the face is taken across the section as
        // the straight line through where it meets the two depths, next to the profile's own angle: the part of the
        // profile inside the hole stays on the part's side of that line.
        if (wall.far) {
            for (const [r, half] of samples.slice(0, 2)) {
                for (const ds of [-half, 0, half]) {
                    const a0 = wall.near.around(s + ds, angle);
                    const a1 = wall.far.around(s + ds, angle);
                    if (a0.angles.length === 0 || a1.angles.length !== a0.angles.length) {
                        continue;
                    }
                    // The edge nearest the profile's angle, and which way from it the hole is open.
                    let i = 0;
                    for (let j = 1; j < a0.angles.length; j++) {
                        if (Math.abs(a0.angles[j] - a0.at) < Math.abs(a0.angles[i] - a0.at)) {
                            i = j;
                        }
                    }
                    const open = i % 2 === 0 ? 1 : -1;
                    const point = (radius: number, a: number): P2 => [radius * Math.cos(a), radius * Math.sin(a)];
                    const [n, f] = [point(r0, a0.angles[i]), point(r1, a1.angles[i])];
                    const side = (q: P2): number => (f[0] - n[0]) * (q[1] - n[1]) - (f[1] - n[1]) * (q[0] - n[0]);
                    if (Math.hypot(f[0] - n[0], f[1] - n[1]) < 1e-9) {
                        continue;
                    }
                    const solid = side(point(r0, a0.angles[i] - open * 0.01));
                    const here = side(point(r, a0.at));
                    // On the open side, or within 0.03 mm of the line.
                    if (here * solid < 0 || Math.abs(here) / Math.hypot(f[0] - n[0], f[1] - n[1]) < 0.03) {
                        return false;
                    }
                }
            }
        }
        return true;
    };
    const steps = Math.max(2, Math.ceil(turns * 720));
    const pieces: [number, number][] = [];
    let from: number | null = held(0) ? 0 : null;
    let previous = 0;
    for (let i = 1; i <= steps; i++) {
        const t = (turns * i) / steps;
        const now = held(t);
        if ((from !== null) !== now) {
            // Where it changes, to a hundred-thousandth of a turn.
            let [a, b] = [previous, t];
            for (let k = 0; k < 20; k++) {
                const m = (a + b) / 2;
                if (held(m) === now) {
                    b = m;
                } else {
                    a = m;
                }
            }
            if (now) {
                from = b;
            } else {
                pieces.push([from!, a]);
                from = null;
            }
        }
        previous = t;
    }
    if (from !== null) {
        pieces.push([from, turns]);
    }
    // Where a piece ends at the wall's edge, it stops 0.03 mm short of it around the axis too.
    const spare = 0.03 / (2 * Math.PI * spec.rBase);
    return pieces.map(([a, b]): [number, number] => [a > 0 ? a + spare : a, b < turns ? b - spare : b])
        .filter(([a, b]) => b - a >= 1 / 72).map(([a, b]) => ({
        ...spec, y0: spec.y0 + lead * a, height: lead * (b - a), turn: (spec.turn ?? 0) + startTurn + sign * 360 * a,
    }));
}

// ---- The Thread step ----------------------------------------------------------------------------------------

export interface ThreadResult {
    shape: Shape3D;
    /** Where each thread of the step runs, in the order of its edges. */
    axes: ThreadAxis[];
    /** For a preview: the ridges to show; the body is then left as it was. */
    ghosts: ThreadGhost[];
    /** What the form should say about the step (a thread cut to the length of its hole). */
    notes: string[];
}

/** The edges a thread step is picked on: its first edge and the others, without the same edge twice. */
function threadPicks(f: ThreadStep): Vec3[] {
    const all = [f.at!, ...(f.alsoAt ?? [])];
    return all.filter((p, i) => all.findIndex((q) => Math.hypot(...sub3(p, q)) < 1e-6) === i);
}

/**
 * The Thread step: on each picked circular edge, the same thread (each from its own hole or shaft, which decides
 * where it starts and how far it can run), or from a point up +Y. A step with `preview` set only places the ridges.
 */
export function threadFeature(shape: Shape3D, f: ThreadStep, print: PrintSettings): ThreadResult {
    if (!f.at) {
        return { ...threadOne(shape, f, print, null), axes: [axisOf(f, print, null)] };
    }
    const picks = threadPicks(f);
    // With several edges an error says which (as the selection box lists them); a kernel exception goes on as it is.
    const named = (i: number, e: unknown): unknown => (picks.length > 1 && e instanceof Error ? new Error(`Edge<${i + 1}>: ${e.message}`) : e);
    // Every edge is found on the body as it was before the step, so threading one hole cannot move another's pick.
    const edges = picks.map((at, i) => {
        try {
            return threadEdge(shape, at);
        } catch (e) {
            throw named(i, e);
        }
    });
    let body = shape;
    const ghosts: ThreadGhost[] = [];
    const notes: string[] = [];
    edges.forEach((edge, i) => {
        try {
            const one = threadOne(body, f, print, edge);
            body = one.shape;
            ghosts.push(...one.ghosts);
            notes.push(...one.notes.map((n) => (picks.length > 1 ? `Edge<${i + 1}>: ${n}` : n)));
        } catch (e) {
            throw named(i, e);
        }
    });
    return { shape: body, axes: edges.map((edge) => axisOf(f, print, edge)), ghosts, notes };
}

function threadOne(shape: Shape3D, f: ThreadStep, print: PrintSettings, edge: ThreadEdge | null):
    { shape: Shape3D; ghosts: ThreadGhost[]; notes: string[] } {
    const { pitch } = f;
    const starts = f.starts ?? 1;
    if (!(Number.isInteger(starts) && starts >= 1 && starts <= 8)) {
        throw new Error('thread starts must be a whole number from 1 to 8');
    }
    const lead = pitch * starts;
    let origin: Vec3 = f.position ?? [0, 0, 0];
    let axis: Vec3 = [0, 1, 0];
    let diameter = f.diameter;
    let reach = Infinity;
    /** The radius of the hole or shaft the thread was picked on. */
    let picked: number | null = null;
    if (edge) {
        picked = edge.radius;
        if (edge.hole !== (f.kind === 'internal')) {
            throw new Error(edge.hole ? 'the picked edge is on a hole: use an internal thread'
                : 'the picked edge is on a shaft: use an external thread');
        }
        ({ centre: origin, axis, reach } = edge);
        diameter ??= f.kind === 'external' ? 2 * edge.radius : 2 * edge.radius + MINOR_DEPTH * pitch;
    }
    if (diameter === undefined) {
        throw new Error('thread needs a diameter, or the circular edge where it begins');
    }
    // Direction 2 is the same thread carried on the other way from its start: it starts that much earlier.
    const back = edge ? f.length2 ?? 0 : 0;
    if (!(back >= 0)) {
        throw new Error('thread direction 2 depth must be positive');
    }
    const offset = (f.offset ?? 0) - back;
    if (!Number.isFinite(offset)) {
        throw new Error('thread offset must be a number');
    }
    origin = add3(origin, scale3(axis, offset));
    if (f.revolutions !== undefined && !(f.revolutions > 0)) {
        throw new Error('thread revolutions must be positive');
    }
    const forward = f.revolutions !== undefined ? f.revolutions * lead : f.length;
    const asked = forward === undefined ? undefined : forward + back;
    if (!(pitch > 0 && asked !== undefined && asked >= pitch && diameter > 2 * pitch)) {
        throw new Error('thread needs pitch > 0, length >= pitch and diameter > 2 x pitch');
    }
    const length = asked;
    // On a picked edge the thread may start before the edge (a negative offset, so it runs in at full depth) or be
    // asked longer than the hole or shaft: it is trimmed to the cylinder, as with its end faces in SolidWorks.
    // `trim` is the part kept, measured along the thread from where it starts.
    let trim: [number, number] | null = null;
    if (edge) {
        const from = Math.max(offset, 0);
        const to = Math.min(offset + asked, reach);
        if (to - from < pitch - 1e-6) {
            throw new Error(`the thread misses the cylinder: it is ${fmtMm(reach)} long from the edge, `
                + `the thread runs from ${fmtMm(offset)} to ${fmtMm(offset + asked)} along it`);
        }
        if (offset < -1e-6 || offset + asked > reach + 1e-6) {
            trim = [from - offset, to - offset];
        }
    }
    const [low, high] = trim ?? [0, length];
    const hand = { lead, leftHanded: !!f.leftHanded };
    const frame = frameOf(origin, axis, f.startAngle ?? 0);
    const at = (s: Shape3D, turn = 0): Shape3D => frame.place(s, turn);
    const turnOf = (i: number): number => (360 * i) / starts;
    // Asked longer than the hole or shaft: it stops at the end, and the form says so.
    const notes = edge && offset + asked > reach + 1e-6
        ? [`cut to the length of the ${edge.hole ? 'hole' : 'shaft'}: ${fmtMm(reach)} (${fmtMm(offset + asked)} asked)`] : [];

    if (f.preview) {
        // A quick look while the form is open, without the slow booleans: the ridges the build keeps (only where the
        // wall or the shaft's core stands behind them), within the thread's length, on the body as it is.
        const rMaj = f.kind === 'external' ? diameter / 2 : (diameter + print.holeTolerance) / 2;
        const core = rMaj - 0.6134 * pitch - WALL_DEPTH;
        const spec = f.kind === 'external' ? externalSpec(pitch, rMaj, rMaj - 0.6134 * pitch, low, high, hand)
            : internalSpec(pitch, rMaj, low, high, hand);
        if (!spec) {
            throw new Error('thread is too short for its pitch');
        }
        const place = [...origin, ...axis, f.startAngle ?? 0].join(',');
        const wall = !edge ? null : f.kind === 'external'
            ? wallSeen(shape, frame, place, core, core - Math.min(0.3, core / 2), low, high)
            : wallSeen(shape, frame, place, rMaj + WALL_DEPTH, rMaj + WALL_DEPTH + 0.3, low, high);
        const pieces = Array.from({ length: starts }, (_, i) => ridgePieces(spec, wall, turnOf(i))).flat();
        return { shape, notes, ghosts: pieces.map((piece) => ({ spec: piece, origin, axis, angle: f.startAngle ?? 0 })) };
    }
    // Every boolean below runs on the piece of the part within a cylinder about the thread, which is then sewn back to
    // the rest: on a big part the kernel otherwise compares each turn of the ridge with every large face of the part.
    const zone = edge ? splitZone(shape, frame, (f.kind === 'external' ? diameter / 2 : (diameter + print.holeTolerance) / 2)
        + Math.max(0.6, pitch / 2) + 0.0137, Math.min(low, 0) - 2 * lead - 1.3, Math.max(high, length) + 2 * lead + 1.3) : null;
    if (zone) {
        shape = zone.local;
    }
    const done = (made: Shape3D): { shape: Shape3D; ghosts: ThreadGhost[]; notes: string[] } => ({
        shape: zone ? rejoin(zone, made) : made, ghosts: [], notes,
    });

    /**
     * The ridge and its copies for the other starts, evenly around the axis, each kept to the `wall` it stands on, and
     * cut off square at `slice` [from, to, reach] (only the pieces that run past it are cut).
     */
    const ridges = (spec: RidgeSpec | null, wall: Wall | null = null, slice?: [number, number, number]): Shape3D => {
        if (!spec) {
            throw new Error('thread is too short for its pitch');
        }
        const pieces = Array.from({ length: starts }, (_, i) => ridgePieces(spec, wall, turnOf(i))).flat()
            .filter((piece) => !slice || (piece.y0 + piece.height + piece.wBase / 2 > slice[0] && piece.y0 - piece.wBase / 2 < slice[1]));
        if (pieces.length === 0) {
            throw new Error('the thread has no wall to stand on: the hole or shaft is open all along it');
        }
        const solids = pieces.map((piece) => {
            const solid = threadRidge(piece, true).shape;
            const past = slice && (piece.y0 - piece.wBase / 2 < slice[0] || piece.y0 + piece.height + piece.wBase / 2 > slice[1]);
            return past ? sliceY(solid, slice[2], slice[0], slice[1]) : solid;
        });
        // The pieces and starts never overlap, so they go to the kernel together as they are.
        return solids.length === 1 ? solids[0] : makeCompound(solids) as Shape3D;
    };
    // Trim with start face / end face: the thread runs on past the end of the hole or shaft and is cut off there, so it
    // meets the face with part of its profile instead of starting a little inside with a blunt end.
    // From a point the bore also runs on where there is free space past its ends, so it never ends in a face of the part.
    const wantIn = (f.trimStart ?? true) && offset <= 1e-9;
    const wantOut = (f.trimEnd ?? true) && (!edge || offset + asked >= reach - 1e-6);
    /** Whether the part has nothing in this zone of the tool (free space past an end of the hole or shaft). */
    const free = (zone: Shape3D): boolean => {
        const hit = shape.intersect(at(zone));
        return !hit.solids?.length || measureVolume(hit) < 1e-6;
    };
    /**
     * The tool taken from, or added to, the part. The kernel now and then hands the part back untouched when the
     * thread's start lines up exactly with a seam of the part; turned a fiftieth of a degree about its axis it works.
     */
    const applied = (tool: Shape3D, add: boolean): Shape3D => {
        const before = measureVolume(shape);
        for (const turn of [0, 0.02]) {
            const placed = at(tool.clone(), turn);
            const result = add ? shape.fuse(placed, { simplify: false }) : shape.cut(placed);
            // More than nothing, and never more than the tool itself holds: the kernel now and then hands back an
            // empty or broken body, which is not a thread.
            const change = result.solids?.length ? (measureVolume(result) - before) * (add ? 1 : -1) : 0;
            if (change > 1e-6 && change <= measureVolume(placed) + 1e-6) {
                return asSolid(result, 'thread');
            }
        }
        throw new Error(add ? 'the thread adds nothing to the part: its ridges lie inside material already'
            : 'the thread takes nothing from the part: it does not reach any material there (check its start, diameter and method)');
    };
    /**
     * Cuts what a tap or die removes: `stock` (the bore, or the ring around the shaft) without the ridges. The stock is
     * built over the thread's own range, and past an end of the hole or shaft where that is free space, so that the
     * ridge starts and ends inside it and runs out through the part's end face. Where the kernel cannot make the cut
     * with the far end run out (some shafts threaded over their whole length), that end is left as it would be without
     * Trim with end face, then the start too: the thread is made either way.
     */
    const cutThread = (stock: (from: number, to: number) => Shape3D, ridge: (from: number, to: number) => RidgeSpec | null, reachOut: number): Shape3D => {
        const before = -2 * lead - 0.5;
        const canIn = wantIn && free(stock(before, low - 1e-3));
        const canOut = wantOut && free(stock(high + 1e-3, high + 2 * lead + 0.5));
        // [run in, run out, end the ridge inside the range]: the last also when the thread was asked longer than the
        // hole or shaft, so that nothing of the tool's far end lies in the part's own end face.
        const plans = ([[canIn, canOut, false], [canIn, false, false], [canIn, false, true], [false, false, true]] as [boolean, boolean, boolean][])
            .map(([runIn, runOut, inside]) => ({ runIn, runOut, to: runOut ? high + 2 * lead : inside ? Math.min(length, high) : length }))
            .filter((plan, n, all) => all.findIndex((other) => other.runIn === plan.runIn && other.runOut === plan.runOut && other.to === plan.to) === n);
        let failure: unknown;
        for (const { runIn, runOut, to } of plans) {
            try {
                // Whole leads before the start, so the helix keeps its place around the axis.
                const span: [number, number] = [runIn ? -2 * lead : 0, to];
                // A ridge that still runs past the range (asked longer than the hole, or started before its edge, with no
                // free space there) is cut off square a little outside it: the kernel will not cut with a sweep's raw ends.
                const pokesIn = !runIn && low > 1e-9;
                const pokesOut = !runOut && to > high + 1e-9;
                const kept = ridges(ridge(span[0], span[1]), null, pokesIn || pokesOut
                    ? [pokesIn ? low - 0.2 : span[0] - 1, pokesOut ? high + 0.2 : span[1] + 1, reachOut] : undefined);
                return applied(asSolid(stock(runIn ? before : low, runOut ? high + 2 * lead + 0.5 : high).cut(kept), 'thread cutter'), false);
            } catch (e) {
                failure = e;
            }
        }
        throw failure;
    };
    /** The ridges to add, kept to the material they stand on, running out at the ends trimmed with their face. */
    const ridgesToAdd = (ridge: (from: number, to: number) => RidgeSpec | null, reachOut: number, wall: Wall | null): Shape3D => {
        return ridges(ridge(wantIn ? -2 * lead : 0, wantOut ? high + 2 * lead : length), wall,
            wantIn || wantOut || trim ? [low, high, reachOut] : undefined);
    };
    if (f.kind === 'external') {
        const rMaj = diameter / 2;
        const rRoot = rMaj - 0.6134 * pitch;
        // The cutter reaches a little past the shaft's surface, less far than the sharpened ridge that is taken out of it.
        const over = Math.min(0.05, 0.045 * pitch);
        const ring = (from: number, to: number): Shape3D => revolve([[rRoot, from], [rMaj + over, from], [rMaj + over, to], [rRoot, to]]);
        if (picked === null) {
            // At a point: a threaded rod of its own, standing on whatever is there.
            const rod = asSolid(cylinderY(rRoot, 0, length).fuse(ridges(externalSpec(pitch, rMaj, rRoot, 0, length, hand)), { simplify: false }), 'threaded rod');
            const turned = shape.cut(at(revolve([[rRoot - 0.05, low], [rMaj + 0.05, low], [rMaj + 0.05, high], [rRoot - 0.05, high]])));
            return done(asSolid(turned.fuse(at(rod)), 'thread'));
        }
        const method = f.method ?? (picked < rMaj - 1e-4 ? 'extrude' : 'cut');
        if (method === 'cut') {
            // Cut thread: what a die removes, the stock between the ridges. Only ever takes material away, so a shaft
            // with a slanted end, a cross hole or a bore keeps them, and nothing is left standing in the air.
            if (picked <= rRoot + 1e-6) {
                throw new Error(`Cut thread: the shaft (${fmtMm(2 * picked)}) is no thicker than the root of the thread `
                    + `(${fmtMm(2 * rRoot)}), so there is nothing to cut. Make the shaft ${fmtMm(diameter)} thick, or use Extrude thread`);
            }
            // The crest lies in the shaft's own surface: sharpened past it, the cutter has neither a face nor an edge there.
            const proud = picked > rMaj + 1e-4 ? 0 : 0.09;
            return done(cutThread(ring, (from, to) => externalSpec(pitch, rMaj, rRoot, from, to, hand, proud), rMaj + pitch));
        }
        // Extrude thread: the ridges are added on the shaft, which is first turned down to the root where it is thicker;
        // only where the shaft's core stands behind them (not across a flat or a cross hole).
        const core = rRoot - WALL_DEPTH;
        const wall = wallOf(shape, frame, core, core - Math.min(0.3, core / 2), low, high);
        const added = ridgesToAdd((from, to) => externalSpec(pitch, rMaj, rRoot, from, to, hand), rMaj + pitch, wall);
        if (picked > rRoot + 1e-4) {
            shape = asSolid(shape.cut(at(ring(low, high))), 'thread');
        }
        return done(applied(added, true));
    }
    const rMaj = (diameter + print.holeTolerance) / 2;
    const rCrest = rMaj - (MINOR_DEPTH * pitch) / 2;
    const method = f.method ?? (picked !== null && picked > rCrest + 1e-4 ? 'extrude' : 'cut');
    if (method === 'cut') {
        // Cut thread: what a tap removes, the bore without the ridges. Only ever takes material away, so where the hole
        // comes out through a slanted or curved face (no wall there) nothing is left hanging in the air.
        if (picked !== null && picked >= diameter / 2 - 1e-6) {
            throw new Error(`Cut thread: the hole (${fmtMm(2 * picked)}) is already as wide as the thread (${fmtMm(diameter)}), so `
                + `there is nothing to cut. Make the hole the tap size, ${fmtMm(diameter - MINOR_DEPTH * pitch)}, or use Extrude thread`);
        }
        // A hole already at the thread's minor diameter: the crest lies in its wall, so it is sharpened on into the hole.
        const proud = picked !== null && Math.abs(picked - rCrest) < 1e-4 ? 0.1 : 0;
        return done(cutThread((from, to) => cylinderY(rMaj, from, to), (from, to) => internalSpec(pitch, rMaj, from, to, hand, proud), rMaj + pitch));
    }
    // Extrude thread: the hole is opened to the major diameter where it is narrower, and the ridges are added on its
    // wall, only where the wall stands (not where the hole comes out through a slanted or curved face, or meets
    // another hole).
    const wall = picked === null ? null : wallOf(shape, frame, rMaj + WALL_DEPTH, rMaj + WALL_DEPTH + 0.3, low, high);
    const added = ridgesToAdd((from, to) => internalSpec(pitch, rMaj, from, to, hand), rMaj + pitch, wall);
    shape = shape.cut(at(cylinderY(rMaj, low, high)));
    return done(applied(added, true));
}

/** The part split at a cylinder about a thread's axis: the piece inside it (where the thread goes) and the rest. */
interface Zone {
    local: Shape3D;
    rest: Shape3D;
    frame: Frame;
    radius: number;
    from: number;
    to: number;
}

function splitZone(shape: Shape3D, frame: Frame, radius: number, from: number, to: number): Zone | null {
    if (shape.solids.length !== 1) {
        return null;
    }
    // Only worth it when the zone is a small part of the body (not a nut whose bore is most of it).
    const box = shape.boundingBox;
    const [lo, hi] = box.bounds;
    box.delete();
    if (Math.PI * radius * radius * (to - from) > 0.25 * (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])) {
        return null;
    }
    try {
        const cylinder = frame.place(cylinderY(radius, from, to));
        const local = shape.intersect(cylinder.clone(), { simplify: false });
        const rest = shape.cut(cylinder, { simplify: false });
        // The whole part inside the cylinder (a small part): it is threaded as it is.
        return local.solids?.length && rest.solids?.length ? { local, rest, frame, radius, from, to } : null;
    } catch {
        return null;
    }
}

/**
 * The threaded piece put back in the part: the faces of both, less those of the cut between them, sewn into one
 * solid, and faces the cut had split joined up again. A fuse when sewing does not give the solid it should.
 */
function rejoin(zone: Zone, made: Shape3D): Shape3D {
    const oc = getOC();
    const { frame, radius, from, to } = zone;
    const onCut = (face: Face): boolean => {
        const points = [
            ...[0.25, 0.5, 0.75].map((k) => face.pointOnSurface(k, k).toTuple() as Vec3),
            ...face.edges.flatMap((e) => [0, 0.5, 1].map((k) => e.pointAt(k).toTuple() as Vec3)),
        ].map((p) => frame.toLocal(p));
        const r = (p: Vec3): number => Math.hypot(p[0], p[2]);
        return points.every((p) => Math.abs(r(p) - radius) < 1e-5) || [from, to].some((s) => points.every((p) => Math.abs(p[1] - s) < 1e-5));
    };
    const expected = measureVolume(zone.rest) + measureVolume(made);
    try {
        const [r, gc] = localGC();
        try {
            const sewing = r(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
            for (const face of [...zone.rest.faces, ...made.faces]) {
                if (!onCut(face)) {
                    sewing.Add(face.wrapped);
                }
            }
            sewing.Perform();
            const shell = r(sewing.SewedShape());
            if (shell.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
                const solid = cast(r(new oc.ShapeFix_Solid()).SolidFromShell(oc.TopoDS.Shell(shell))) as Shape3D;
                if (solid.solids.length === 1 && Math.abs(measureVolume(solid) - expected) <= 1e-6 * expected + 1e-3) {
                    const unify = r(new oc.ShapeUpgrade_UnifySameDomain(solid.wrapped, true, true, false));
                    unify.Build();
                    const joined = cast(downcast(unify.Shape())) as Shape3D;
                    if (joined.solids.length === 1 && Math.abs(measureVolume(joined) - expected) <= 1e-6 * expected + 1e-3 && isValid(joined)) {
                        return joined;
                    }
                    if (isValid(solid)) {
                        return solid;
                    }
                }
            }
        } finally {
            gc();
        }
    } catch {
        // Fused below.
    }
    return asSolid(zone.rest.fuse(made, { optimisation: 'commonFace' }), 'thread');
}

function isValid(shape: Shape3D): boolean {
    const analyzer = new (getOC().BRepCheck_Analyzer)(shape.wrapped, true, false);
    const ok = analyzer.IsValid();
    analyzer.delete();
    return ok;
}

// ---- Chamfers and fillets next to a thread ------------------------------------------------------------------

/**
 * The picks of a chamfer that lie on the end of a thread: its mouth or shaft-end edge, a flat loop across the axis at
 * about the thread's radius. For each pick the thread and where along its axis the end is; null for any other edge.
 */
export function threadMouths(shape: Shape3D, picks: Vec3[], threads: Map<string, ThreadAxis>): ({ thread: ThreadAxis; s: number } | null)[] {
    const tolerance = pickTolerance(shape);
    return picks.map((pick) => {
        for (const thread of threads.values()) {
            const rel = sub3(pick, thread.point);
            const along = dot3(rel, thread.dir);
            const off = Math.hypot(...sub3(rel, scale3(thread.dir, along)));
            // At the thread's radius (anywhere from the opening to the full depth of the profile)...
            const near = off >= Math.min(thread.mouth, thread.radius) - thread.pitch - tolerance
                && off <= Math.max(thread.mouth, thread.radius) + thread.pitch + tolerance;
            // ...and on one of the two ends of the hole or shaft: the only places with a flat edge across the axis.
            const end = Math.abs(along) <= tolerance ? 0 : Math.abs(along - thread.reach) <= tolerance ? thread.reach : null;
            if (near && end !== null) {
                return { thread, s: end };
            }
        }
        return null;
    });
}

/**
 * A chamfer on the mouth of a threaded hole or the end of a threaded shaft, made as the cut it is: a countersink, or a
 * turned bevel. The kernel's own chamfer needs one clean edge between two plain faces, which a thread's end is not.
 */
export function threadMouthChamfer(shape: Shape3D, thread: ThreadAxis, s: number, f: Extract<Feature, { op: 'chamfer' }>): Shape3D {
    // The distance on the reference face first: the flat end face unless `side` points at the wall.
    const onFlat = !f.side || Math.abs(dot3(f.side, thread.dir)) >= 0.5;
    const second = f.angle !== undefined ? f.size * Math.tan((f.angle * Math.PI) / 180) : f.distance2 ?? f.size;
    const [across, down] = onFlat ? [f.size, second] : [second, f.size];
    if (!(across > 0 && down > 0)) {
        throw new Error('chamfer distances must be positive');
    }
    const R = thread.mouth;
    // Material lies along the axis from the start end, and against it from the far end.
    const into = s <= thread.reach / 2 ? 1 : -1;
    const hole = thread.kind === 'internal';
    if (!hole && across >= R) {
        throw new Error(`chamfer of ${fmtMm(across)} is larger than the shaft's radius (${fmtMm(R)})`);
    }
    // The bevel line from the end face to the wall, carried on a little at both ends, and the corner on the air side.
    const k = hole ? Math.min(0.25, (0.9 * R) / across) : 0.25;
    const a: P2 = hole ? [R + across, s] : [R - across, s];
    const step: P2 = [hole ? -across : across, into * down];
    const p1: P2 = [a[0] - k * step[0], a[1] - k * step[1]];
    const p2: P2 = [a[0] + (1 + k) * step[0], a[1] + (1 + k) * step[1]];
    const p3: P2 = [p2[0], p1[1]];
    const area = (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (p2[1] - p1[1]);
    const cutter = placeOnAxis(revolve(area > 0 ? [p1, p2, p3] : [p1, p3, p2]), thread.point, thread.dir, 0);
    return asSolid(shape.cut(cutter), 'chamfer');
}

/** The ids of the thread steps a fillet or chamfer's picked edges run along (an edge of the hole or shaft wall). */
export function threadsUnder(shape: Shape3D, f: { at?: Vec3[]; faces?: FacePickRef[]; tangent?: boolean },
    threads: Map<string, ThreadAxis>): string[] {
    if (threads.size === 0 || !(f.at?.length || f.faces?.length)) {
        return [];
    }
    let edges: Vec3[][];
    try {
        const picked = [
            ...resolveEdges(shape, f.at ?? [], { tangent: f.tangent }),
            ...resolveFaces(shape, f.faces ?? [], { tangent: f.tangent }).flatMap((face) => face.edges),
        ];
        edges = picked.map((edge) => [edge.startPoint, edge.pointAt(0.5), edge.endPoint].map((p) => p.toTuple() as Vec3));
    } catch {
        return [];
    }
    const tolerance = pickTolerance(shape);
    // An edge is on the thread when it stays at about the thread's radius from its axis: the mouth circle, at the major
    // or minor radius give or take the print clearance, or a piece of the ridge that crosses it.
    const ids = [...threads].filter(([, axis]) => edges.some((points) => points.every((p) => {
        const rel = sub3(p, axis.point);
        const k = dot3(rel, axis.dir);
        const off = Math.hypot(...sub3(rel, scale3(axis.dir, k)));
        return Math.abs(off - axis.radius) <= axis.pitch + tolerance;
    }))).map(([key]) => threadStepId(key));
    return ids.filter((id, i) => ids.indexOf(id) === i);
}

/** Key of the thread on a step's edge `index` in the build's map of threads (the step id for its first edge). */
export const threadKey = (id: string, index: number): string => (index ? `${id}#${index}` : id);

const threadStepId = (key: string): string => key.replace(/#\d+$/, '');
