// Real OpenCascade solids for part specs (via replicad), in the part's local frame: Y up, millimetres.
// Conventions match the three.js preview in @jarvis/core/geometry.

import { createHash } from 'node:crypto';
import opencascade from 'replicad-opencascadejs';
import {
    assembleWire, basicFaceExtrusion, cast, genericSweep, getOC, makeBox, makeBSplineApproximation, makeCircle,
    makeCompound, makeCylinder, makeFace, makeLine, makePolygon, makeSphere, makeThreePointArc,
    localGC, makeAx3, measureVolume, Plane, revolution, setOC, Solid, twistExtrude, Vector, Wire, type Edge, type Face, type Shape3D,
} from 'replicad';
import type {
    AxisRef, EdgeSelect, FacePickRef, FaceSelect, FastenerShape, Feature, HelixPath, PlaneRef, PrintSettings, Repeat, Shape, Sketch,
    ThreadSize, Vec3,
} from '@jarvis/core';
import {
    heatsetData, holeDimensions, nutData, screwHead, STANDARD_LENGTHS, threadData, washerData, type HoleDimensions,
    type ThreadData,
} from '@jarvis/core/fasteners';
import type { MeshData } from './kernel.js';
import { runScript } from './script.js';
import { pickTolerance, planeOfFace, resolveEdges, resolveFaces } from './refs.js';
import { chamferEdges, draftFaces, filletEdges, shellFaces, type ChamferSpec } from './applied.js';
import { resolveAxis, resolvePlane } from '@jarvis/core/reference';
import { derivedSketch } from '@jarvis/core/derived';
import { relativePlacement, type CombineContext } from './context.js';
import { followStep } from './followRefs.js';
import {
    externalRidge, ghostMesh, internalRidge, ridgeMesh, threadFeature, threadKey, threadMouthChamfer, threadMouths, threadsUnder,
    type Ridge, type RidgeSpec, type ThreadAxis, type ThreadGhost,
} from './thread.js';

export { threadEdge } from './thread.js';
import {
    extrudeRange, extrudeSketch, extrudeTool, isPlainExtrude, loftSketches, pathWire, revolveSketch, sweepProfile, throughRange,
    type SketchFrame,
} from './sketch.js';

type P2 = [number, number];

/** Angular mesh deflection in radians; the linear one scales with the part (see meshTolerance). */
const ANGULAR_TOLERANCE = 0.2;

/** Mesh tolerances for a solid: linear deflection ~0.02% of its diagonal, 0.01 to 0.2 mm. */
export function meshTolerance(shape: Shape3D): { tolerance: number; angularTolerance: number } {
    const [lo, hi] = shapeBounds(shape);
    const diagonal = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    return { tolerance: Math.min(0.2, Math.max(0.01, diagonal * 0.0002)), angularTolerance: ANGULAR_TOLERANCE };
}

const EPS = 1e-3;
const TAN30 = Math.tan(Math.PI / 6);

let ocReady: Promise<void> | null = null;

/** Loads OpenCascade once per thread. */
export function initOC(): Promise<void> {
    ocReady ??= (async () => {
        // OpenCascade chats on stdout (STEP transfer statistics); keep only its errors.
        const oc = await opencascade({ print: () => {}, printErr: (text) => console.error(`[opencascade] ${text}`) });
        setOC(oc);
    })();
    return ocReady;
}

/** Readable message for a JS error or an OpenCascade (WebAssembly) exception. */
export function errorMessage(error: unknown): string {
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

// ---- Small geometry helpers ---------------------------------------------------------------------------------

function defaultEdge(smallestSide: number): number {
    return Math.min(0.6, smallestSide * 0.06);
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

function asSolid(shape: unknown, what: string): Shape3D {
    const s = shape as Shape3D;
    if (!s || s.isNull || s.solids.length === 0) {
        throw new Error(`${what} produced no solid`);
    }
    return s;
}

/** Compound of the shapes, leaving the inputs usable (replicad's makeCompound deletes them). */
/**
 * Booleans often return a compound around a single solid: unwrap it so later features see a plain solid.
 * Several solids stay a compound (fine for meshing and STEP); none is an error.
 */
export function normalizeSolid(shape: Shape3D, what: string): Shape3D {
    const solids = shape.solids;
    if (solids.length === 0) {
        throw new Error(`${what} is empty`);
    }
    return solids.length === 1 && !(shape instanceof Solid) ? solids[0] : shape;
}

function singleSolid(shape: Shape3D, op: string): void {
    const count = shape.solids.length;
    if (count > 1) {
        throw new Error(`${op} needs a single solid, but the body is ${count} separate solids`);
    }
}

function compound(shapes: Shape3D[]): Shape3D {
    return shapes.length === 1 ? shapes[0] : (makeCompound(shapes.map((s) => s.clone())) as Shape3D);
}

/**
 * One tool from several possibly overlapping solids. (Cutting with a compound of overlapping solids leaves
 * stray internal faces, so tools are fused first.)
 */
function fuseAll(shapes: Shape3D[]): Shape3D {
    let result = shapes[0];
    for (const shape of shapes.slice(1)) {
        result = result.fuse(shape, { simplify: false });
    }
    return result;
}

export function isValid(shape: Shape3D): boolean {
    const analyzer = new (getOC().BRepCheck_Analyzer)(shape.wrapped, true, false);
    const ok = analyzer.IsValid();
    analyzer.delete();
    return ok;
}

function dedupe(points: P2[]): P2[] {
    const out: P2[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) {
            out.push(p);
        }
    }
    if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) {
        out.pop();
    }
    return out;
}

/** Solid of revolution about Y of a closed [radius, y] polygon. */
function revolve(points: P2[]): Shape3D {
    const face = makePolygon(dedupe(points).map(([r, y]) => [r, y, 0]));
    return asSolid(revolution(face, [0, 0, 0], [0, 1, 0]), 'revolve');
}

function cylinderY(radius: number, y0: number, y1: number): Shape3D {
    return makeCylinder(radius, y1 - y0, [0, y0, 0], [0, 1, 0]);
}

/** Prism of an [x, z] outline from y0 up by height. */
function prism(outline: P2[], y0: number, height: number): Shape3D {
    const face = makePolygon(dedupe(outline).map(([x, z]) => [x, y0, z]));
    return basicFaceExtrusion(face, new Vector([0, height, 0]));
}

function hexagon(acrossFlats: number): P2[] {
    const r = acrossFlats / Math.sqrt(3);
    return Array.from({ length: 6 }, (_, i) => [r * Math.cos(rad(60 * i)), r * Math.sin(rad(60 * i))] as P2);
}

function edgeBounds(edge: Edge): [Vec3, Vec3] {
    const box = edge.boundingBox;
    const bounds = box.bounds;
    box.delete();
    return bounds as [Vec3, Vec3];
}

function shapeBounds(shape: Shape3D): [Vec3, Vec3] {
    const box = shape.boundingBox;
    const bounds = box.bounds;
    box.delete();
    return bounds as [Vec3, Vec3];
}

/** Edges lying in a plane of constant Y. */
const isHorizontal = (edge: Edge): boolean => {
    const [min, max] = edgeBounds(edge);
    return max[1] - min[1] < EPS;
};

const isVertical = (edge: Edge): boolean => {
    if (edge.geomType !== 'LINE') {
        return false;
    }
    const [min, max] = edgeBounds(edge);
    return max[0] - min[0] < EPS && max[2] - min[2] < EPS && max[1] - min[1] > EPS;
};

function edgePicker(shape: Shape3D, select: EdgeSelect): (edge: Edge) => boolean {
    const [lo, hi] = shapeBounds(shape);
    switch (select) {
        case 'all':
            return () => true;
        case 'vertical':
            return isVertical;
        case 'horizontal':
            return isHorizontal;
        case 'top':
            return (edge) => {
                const [min, max] = edgeBounds(edge);
                return Math.abs(max[1] - hi[1]) < EPS && Math.abs(min[1] - hi[1]) < EPS;
            };
        case 'bottom':
            return (edge) => {
                const [min, max] = edgeBounds(edge);
                return Math.abs(max[1] - lo[1]) < EPS && Math.abs(min[1] - lo[1]) < EPS;
            };
    }
}

function roundEdges(shape: Shape3D, size: number, pick: (edge: Edge) => boolean, chamfer: boolean): Shape3D {
    const count = shape.edges.filter(pick).length;
    if (count === 0) {
        throw new Error('no edges match the selection');
    }
    const config = (edge: Edge): number | null => (pick(edge) ? size : null);
    const result = chamfer ? shape.chamfer(config) : shape.fillet(config);
    if (!isValid(result)) {
        throw new Error(`${chamfer ? 'chamfer' : 'fillet'} of ${size} mm is too big for the selected edges`);
    }
    return result;
}

/** Default edge softening of primitives: best effort, falls back to smaller, then to sharp edges. */
function soften(shape: Shape3D, size: number, pick: (edge: Edge) => boolean): Shape3D {
    if (size < 0.005) {
        return shape;
    }
    for (const attempt of [
        () => roundEdges(shape, size, pick, false),
        () => roundEdges(shape, size * 0.5, pick, false),
        () => roundEdges(shape, size, pick, true),
    ]) {
        try {
            return attempt();
        } catch {
            // try the next, gentler option
        }
    }
    return shape;
}

// ---- Transforms ---------------------------------------------------------------------------------------------

/** Applies a part-style placement: rotation in degrees (three.js XYZ Euler: Z first, then Y, then X), then position. */
export function place(shape: Shape3D, position?: Vec3, rotation?: Vec3): Shape3D {
    let s = shape;
    const [rx, ry, rz] = rotation ?? [0, 0, 0];
    if (rz) s = s.rotate(rz, [0, 0, 0], [0, 0, 1]);
    if (ry) s = s.rotate(ry, [0, 0, 0], [0, 1, 0]);
    if (rx) s = s.rotate(rx, [0, 0, 0], [1, 0, 0]);
    if (position && (position[0] || position[1] || position[2])) s = s.translate(position);
    return s;
}

/** Copies for a repeat, matching instanceTransforms in @jarvis/core/geometry. The input is consumed. */
export function repeatCopies(shape: Shape3D, repeat?: Repeat): Shape3D[] {
    if (!repeat || repeat.count < 2) {
        return [shape];
    }
    const out: Shape3D[] = [];
    for (let i = 0; i < repeat.count; i++) {
        const copy = i === repeat.count - 1 ? shape : shape.clone();
        if (repeat.kind === 'linear') {
            const [x, y, z] = repeat.step;
            out.push(i ? copy.translate(x * i, y * i, z * i) : copy);
        } else {
            const [cx, cz] = repeat.centre ?? [0, 0];
            const sweep = repeat.angle ?? 360;
            const divisions = sweep >= 360 ? repeat.count : repeat.count - 1;
            const angle = (sweep / divisions) * i;
            out.push(angle ? copy.rotate(angle, [cx, 0, cz], [0, 1, 0]) : copy);
        }
    }
    return out;
}

/** Rotates a tool built along -Y so that -Y points along `direction`. */
function orientDown(shape: Shape3D, direction: Vec3): Shape3D {
    const length = Math.hypot(...direction);
    if (length < 1e-9) {
        throw new Error('direction is zero');
    }
    const d = direction.map((v) => v / length) as Vec3;
    const cos = -d[1];
    if (cos > 1 - 1e-9) {
        return shape;
    }
    if (cos < -1 + 1e-9) {
        return shape.rotate(180, [0, 0, 0], [1, 0, 0]);
    }
    // axis = (0, -1, 0) x d
    const axis: Vec3 = [-d[2], 0, d[0]];
    return shape.rotate((Math.acos(cos) * 180) / Math.PI, [0, 0, 0], axis);
}

// ---- Threads ------------------------------------------------------------------------------------------------

/** Fastener compounds: the body and its thread ridges, meshed analytically by meshSolid. */
const threaded = new WeakMap<Shape3D, { body: Shape3D; ridges: RidgeSpec[] }>();

function withThread(body: Shape3D, ridges: Ridge[]): Shape3D {
    if (ridges.length === 0) {
        return body;
    }
    const result = compound([body, ...ridges.map((r) => r.shape)]);
    threaded.set(result, { body, ridges: ridges.map((r) => r.spec) });
    return result;
}

/** Tries to model a thread, falling back to nothing (plain) if the sweep fails. */
function tryThread<T>(make: () => T | null): T | null {
    try {
        return make();
    } catch {
        return null;
    }
}

// ---- Fasteners ----------------------------------------------------------------------------------------------

function defaultLength(size: ThreadSize): number {
    const target = Number(size.slice(1)) * 4;
    return STANDARD_LENGTHS.reduce((best, l) => (Math.abs(l - target) < Math.abs(best - target) ? l : best),
        STANDARD_LENGTHS[0] ?? target);
}

/**
 * Shank from y = -length up to `top` (inside the head). Modelled threads are a separate ridge solid sitting on a
 * core at the root diameter, so the result may be a compound of two overlapping closed solids.
 */
function shank(t: ThreadData, length: number, top: number, threadLength: number, modelled: boolean):
    { core: Shape3D; ridges: Ridge[] } {
    const rMaj = t.major / 2;
    const rRoot = t.minor / 2;
    const depth = rMaj - rRoot;
    const tip = -length;
    if (modelled) {
        const yThread = Math.min(top, tip + threadLength);
        const ridge = tryThread(() => externalRidge(t.pitch, rMaj, rRoot, tip + depth * 0.5, Math.min(yThread, top - 0.01)));
        if (ridge) {
            const profile: P2[] = [[0, tip], [rRoot - depth * 0.5, tip], [rRoot, tip + depth * 0.5]];
            if (yThread < top - depth) {
                profile.push([rRoot, yThread], [rMaj, yThread + depth]);
                profile.push([rMaj, top]);
            } else {
                profile.push([rRoot, top]);
            }
            profile.push([0, top]);
            return { core: revolve(profile), ridges: [ridge] };
        }
    }
    return { core: revolve([[0, tip], [rRoot, tip], [rMaj, tip + depth], [rMaj, top], [0, top]]), ridges: [] };
}

function socketRecess(size: number, depth: number, top: number): Shape3D {
    return prism(hexagon(size), top - depth, depth + 1);
}

function screw(f: FastenerShape, modelled: boolean): Shape3D {
    const t = threadData(f.size);
    const head = screwHead(f.type, f.size);
    const length = f.length ?? defaultLength(f.size);
    if (!(length > 0)) {
        throw new Error('length must be positive');
    }
    const R = head.diameter / 2;
    const k = head.height;
    const isoThread = 2 * t.major + 6;
    const fullyThreaded = f.type === 'hexBolt' || f.type === 'buttonHead' || length <= isoThread + t.major;
    const threadLength = fullyThreaded ? length : isoThread;

    let headSolid: Shape3D;
    let shankTop: number;
    let socketTop: number | null = null;
    switch (f.type) {
        case 'socketCap': {
            const c = Math.min(0.1 * k, 0.08 * head.diameter);
            headSolid = revolve([[0, 0], [R, 0], [R, k - c], [R - c, k], [0, k]]);
            shankTop = k * 0.3;
            socketTop = k;
            break;
        }
        case 'buttonHead': {
            // Spherical dome through the rim at (R, a), tangent to the axis at the top.
            const a = k * 0.2;
            const yc = (k * k - a * a - R * R) / (2 * (k - a));
            const rho = k - yc;
            const mid: P2 = [R / 2, yc + Math.sqrt(rho * rho - (R * R) / 4)];
            const wire = assembleWire([
                makeLine([0, 0, 0], [R, 0, 0]),
                makeLine([R, 0, 0], [R, a, 0]),
                makeThreePointArc([R, a, 0], [mid[0], mid[1], 0], [0, k, 0]),
                makeLine([0, k, 0], [0, 0, 0]),
            ]);
            headSolid = asSolid(revolution(makeFace(wire), [0, 0, 0], [0, 1, 0]), 'button head');
            shankTop = k * 0.3;
            socketTop = k;
            break;
        }
        case 'countersunk': {
            const rShank = t.major / 2;
            const coneHeight = Math.max(k, 0.01);
            headSolid = revolve([[0, 0], [R, 0], [rShank, -coneHeight], [0, -coneHeight]]);
            shankTop = -coneHeight * 0.5;
            socketTop = 0;
            break;
        }
        case 'hexBolt': {
            const flats = head.acrossFlats ?? head.diameter * (Math.sqrt(3) / 2);
            const corner = flats / Math.sqrt(3) + 0.05;
            const rt = 0.95 * (flats / 2);
            const drop = (corner - rt) * TAN30;
            const chamfer = revolve([[0, 0], [corner, 0], [corner, k - drop], [rt, k], [0, k]]);
            headSolid = asSolid(prism(hexagon(flats), 0, k).intersect(chamfer), 'hex head');
            shankTop = k * 0.3;
            break;
        }
        default:
            throw new Error(`${f.type} is not a screw`);
    }
    const { core, ridges } = shank(t, length, shankTop, threadLength, modelled);
    let body = headSolid.fuse(core);
    if (socketTop !== null && head.socket) {
        body = body.cut(socketRecess(head.socket.size, head.socket.depth, socketTop));
    }
    return withThread(asSolid(body, f.type), ridges);
}

/** Hex prism with 30 degree chamfered corners top and/or bottom, from y = y0 up by height. */
function chamferedHex(acrossFlats: number, y0: number, height: number, bottom: boolean, top: boolean): Shape3D {
    const corner = acrossFlats / Math.sqrt(3) + 0.05;
    const rt = 0.92 * (acrossFlats / 2);
    const drop = Math.min((corner - rt) * TAN30, height / 3);
    const profile: P2[] = [[0, y0]];
    profile.push(...(bottom ? [[rt, y0], [corner, y0 + drop]] as P2[] : [[corner, y0]] as P2[]));
    profile.push(...(top ? [[corner, y0 + height - drop], [rt, y0 + height]] as P2[] : [[corner, y0 + height]] as P2[]));
    profile.push([0, y0 + height]);
    return asSolid(prism(hexagon(acrossFlats), y0, height).intersect(revolve(profile)), 'hex body');
}

/** Bores a nut-like body along Y over [0, height] and adds the internal thread ridge when modelled. */
function threadedBore(body: Shape3D, t: ThreadData, height: number, modelled: boolean): Shape3D {
    const rMaj = t.major / 2;
    const bored = asSolid(body.cut(cylinderY(rMaj, -1, height + 1)), 'bore');
    if (!modelled) {
        return bored;
    }
    const ridge = tryThread(() => internalRidge(t.pitch, rMaj, 0, height));
    return withThread(bored, ridge ? [ridge] : []);
}

function nut(f: FastenerShape, modelled: boolean): Shape3D {
    const t = threadData(f.size);
    const n = nutData(f.type, f.size);
    const m = n.thickness;
    if (f.type === 'squareNut') {
        const a = n.acrossFlats;
        const block = makeBox([-a / 2, 0, -a / 2], [a / 2, m, a / 2]);
        const body = soften(block, Math.min(0.3, m * 0.1), isHorizontal);
        return threadedBore(body, t, m, modelled);
    }
    if (f.type === 'nylocNut') {
        const hexHeight = m * 0.7;
        const hex = chamferedHex(n.acrossFlats, 0, hexHeight, true, false);
        const rOut = 0.92 * (n.acrossFlats / 2);
        const rIn = (t.major - 1.0825 * t.pitch) / 2;
        const collar = soften(revolve([[rIn, hexHeight - 0.2], [rOut, hexHeight - 0.2], [rOut, m], [rIn, m]]),
            Math.min(0.5, (m - hexHeight) * 0.4), (e) => e.geomType === 'CIRCLE' && edgeBounds(e)[1][1] > m - EPS
                && edgeBounds(e)[1][0] > rOut - EPS);
        const body = asSolid(hex.fuse(collar).cut(cylinderY(t.major / 2, -1, hexHeight)), 'nyloc body');
        if (!modelled) {
            return body;
        }
        const ridge = tryThread(() => internalRidge(t.pitch, t.major / 2, 0, hexHeight));
        return withThread(body, ridge ? [ridge] : []);
    }
    return threadedBore(chamferedHex(n.acrossFlats, 0, m, true, true), t, m, modelled);
}

function washer(f: FastenerShape): Shape3D {
    const w = washerData(f.size);
    return revolve([[w.inner / 2, 0], [w.outer / 2, 0], [w.outer / 2, w.thickness], [w.inner / 2, w.thickness]]);
}

function heatsetInsert(f: FastenerShape, modelled: boolean): Shape3D {
    const t = threadData(f.size);
    const h = heatsetData(f.size);
    const R = h.outer / 2;
    const L = h.length;
    const rCore = R * 0.84;
    const core = revolve([[0, 0], [rCore, 0], [rCore, L - 0.2], [rCore - 0.2, L], [0, L]]);
    const teeth = Math.max(10, 2 * Math.round((Math.PI * h.outer) / 1.6));
    const star = (offset: number): P2[] => Array.from({ length: teeth * 2 }, (_, i) => {
        const a = (Math.PI * (i + offset)) / teeth;
        const r = i % 2 === 0 ? R : R * 0.9;
        return [r * Math.cos(a), r * Math.sin(a)] as P2;
    });
    const bands = compound([prism(star(0), L * 0.1, L * 0.36), prism(star(1), L * 0.56, L * 0.36)]);
    const body = asSolid(core.fuse(bands), 'insert body');
    return threadedBore(body, t, L, modelled);
}

function fastener(f: FastenerShape): Shape3D {
    const modelled = (f.thread ?? 'modelled') === 'modelled';
    switch (f.type) {
        case 'socketCap':
        case 'buttonHead':
        case 'countersunk':
        case 'hexBolt':
            return screw(f, modelled);
        case 'hexNut':
        case 'nylocNut':
        case 'squareNut':
            return nut(f, modelled);
        case 'washer':
            return washer(f);
        case 'heatsetInsert':
            return heatsetInsert(f, modelled);
    }
}

// ---- Primitive shapes ---------------------------------------------------------------------------------------

/**
 * The solid for a part shape, centred like the preview geometry. `soften` applies the default edge rounding of
 * the preview to box, cylinder, tube and extrude where the shape does not set radius/bevel; bodies with a feature
 * history start sharp instead, as in real CAD.
 */
export function buildShape(shape: Shape, softEdges = true): Shape3D {
    const auto = (smallestSide: number): number => (softEdges ? defaultEdge(smallestSide) : 0);
    switch (shape.kind) {
        case 'box': {
            const [w, h, d] = shape.size;
            if (!(w > 0 && h > 0 && d > 0)) {
                throw new Error('box size must be positive');
            }
            const smallest = Math.min(w, h, d);
            const radius = Math.min(shape.radius ?? auto(smallest), smallest / 2 - 0.01);
            return soften(makeBox([-w / 2, -h / 2, -d / 2], [w / 2, h / 2, d / 2]), radius, () => true);
        }
        case 'cylinder': {
            const r = shape.radius;
            const top = shape.radiusTop ?? r;
            const h = shape.height;
            if (!(h > 0) || r < 0 || top < 0 || Math.max(r, top) <= 0) {
                throw new Error('cylinder needs a positive height and radius');
            }
            const solid = Math.abs(top - r) < 1e-9
                ? cylinderY(r, -h / 2, h / 2)
                : revolve([[0, -h / 2], [r, -h / 2], [top, h / 2], [0, h / 2]]);
            const bevel = shape.bevel ?? auto(Math.min(h, Math.max(r, top) * 2));
            const smallestRim = Math.min(...[r, top].filter((v) => v > 0));
            return soften(solid, Math.min(bevel, h / 2 - 0.01, smallestRim - 0.01), (e) => e.geomType === 'CIRCLE');
        }
        case 'tube': {
            const { outerRadius: ro, height: h } = shape;
            const ri = Math.min(shape.innerRadius, ro - 0.01);
            if (!(h > 0 && ro > 0)) {
                throw new Error('tube needs a positive height and radius');
            }
            const solid = ri > 0
                ? revolve([[ri, -h / 2], [ro, -h / 2], [ro, h / 2], [ri, h / 2]])
                : cylinderY(ro, -h / 2, h / 2);
            const bevel = softEdges ? Math.min(0.5, (ro - Math.max(ri, 0)) / 4, h / 4) : 0;
            return soften(solid, bevel, (e) => e.geomType === 'CIRCLE');
        }
        case 'sphere':
            if (!(shape.radius > 0)) {
                throw new Error('sphere radius must be positive');
            }
            return makeSphere(shape.radius);
        case 'torus': {
            if (!(shape.tube > 0 && shape.radius > shape.tube)) {
                throw new Error('torus tube must be positive and smaller than its radius');
            }
            const ring = makeFace(assembleWire([makeCircle(shape.tube, [shape.radius, 0, 0], [0, 0, 1])]));
            return asSolid(revolution(ring, [0, 0, 0], [0, 1, 0]), 'torus');
        }
        case 'cone': {
            const { radius: r, height: h } = shape;
            if (!(r > 0 && h > 0)) {
                throw new Error('cone needs a positive radius and height');
            }
            return revolve([[0, -h / 2], [r, -h / 2], [0, h / 2]]);
        }
        case 'capsule': {
            const r = shape.radius;
            const half = Math.max(0, shape.length / 2);
            if (!(r > 0)) {
                throw new Error('capsule radius must be positive');
            }
            if (half < 1e-6) {
                return makeSphere(r);
            }
            const s = Math.SQRT1_2 * r;
            const wire = assembleWire([
                makeThreePointArc([0, -half - r, 0], [s, -half - s, 0], [r, -half, 0]),
                makeLine([r, -half, 0], [r, half, 0]),
                makeThreePointArc([r, half, 0], [s, half + s, 0], [0, half + r, 0]),
                makeLine([0, half + r, 0], [0, -half - r, 0]),
            ]);
            return asSolid(revolution(makeFace(wire), [0, 0, 0], [0, 1, 0]), 'capsule');
        }
        case 'lathe':
            return lathe(shape.profile, !!shape.smooth);
        case 'extrude': {
            const h = shape.height;
            const outline = dedupe(shape.outline);
            if (!(h > 0) || outline.length < 3) {
                throw new Error('extrude needs a positive height and an outline of at least 3 points');
            }
            const solid = prism(outline, -h / 2, h);
            if (!isValid(solid)) {
                throw new Error('extrude outline is self-intersecting');
            }
            const bevel = Math.min(shape.bevel ?? auto(h), h / 2 - 0.01);
            return soften(solid, bevel, isHorizontal);
        }
        case 'fastener':
            return fastener(shape);
        case 'sketch': {
            // Exact CAD bodies: no default edge softening.
            if (!!shape.extrude === !!shape.revolve) {
                throw new Error('a sketch body needs exactly one of extrude or revolve');
            }
            return shape.extrude
                ? extrudeSketch(shape.sketch, extrudeRange(shape.extrude.distance, shape.extrude.direction))
                : revolveSketch(shape.sketch, shape.revolve!.axis, shape.revolve!.angle ?? 360);
        }
        case 'empty':
            throw new Error('an empty shape has no body');
        case 'script':
            // Scripts author in replicad's native Z-up frame; turn their Z onto our Y (their -Y front becomes +Z).
            return runScript(shape.code, shape.params ?? {}).rotate(-90, [0, 0, 0], [1, 0, 0]);
    }
}

function lathe(profile: [number, number][], smooth: boolean): Shape3D {
    const pts = dedupe(profile.map(([r, y]) => [Math.max(0, r), y] as P2));
    if (pts.length < 2 || pts.every(([r]) => r < 1e-6)) {
        throw new Error('lathe profile needs at least 2 points away from the axis');
    }
    const v = ([r, y]: P2): Vec3 => [r, y, 0];
    const edges: Edge[] = [];
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[0] > 1e-6) {
        edges.push(makeLine([0, first[1], 0], v(first)));
    }
    if (smooth && pts.length > 2) {
        edges.push(makeBSplineApproximation(pts.map(v), { tolerance: 1e-4, smoothing: null, degMax: 3, degMin: 1 }));
    } else {
        for (let i = 0; i + 1 < pts.length; i++) {
            edges.push(makeLine(v(pts[i]), v(pts[i + 1])));
        }
    }
    if (last[0] > 1e-6) {
        edges.push(makeLine(v(last), [0, last[1], 0]));
    }
    if (Math.abs(last[1] - first[1]) > 1e-6) {
        edges.push(makeLine([0, last[1], 0], [0, first[1], 0]));
    }
    const solid = asSolid(revolution(makeFace(assembleWire(edges)), [0, 0, 0], [0, 1, 0]), 'lathe');
    if (!isValid(solid)) {
        throw new Error('lathe profile is self-intersecting');
    }
    return solid;
}

// ---- Features -----------------------------------------------------------------------------------------------

const FACE_DIRECTIONS: Record<FaceSelect, Vec3> = {
    top: [0, 1, 0],
    bottom: [0, -1, 0],
    front: [0, 0, 1],
    back: [0, 0, -1],
    right: [1, 0, 0],
    left: [-1, 0, 0],
};

/** The outermost planar face(s) whose outward normal points along a direction. */
function outermostFaces(shape: Shape3D, select: FaceSelect): Face[] {
    const d = FACE_DIRECTIONS[select];
    const candidates: { face: Face; offset: number }[] = [];
    for (const face of shape.faces) {
        if (face.geomType !== 'PLANE') {
            continue;
        }
        const n = face.normalAt();
        const dot = n.x * d[0] + n.y * d[1] + n.z * d[2];
        n.delete();
        if (dot > 0.999) {
            const c = face.center;
            candidates.push({ face, offset: c.x * d[0] + c.y * d[1] + c.z * d[2] });
            c.delete();
        }
    }
    if (candidates.length === 0) {
        throw new Error(`no flat face faces ${select}`);
    }
    const max = Math.max(...candidates.map((c) => c.offset));
    return candidates.filter((c) => c.offset > max - EPS).map((c) => c.face);
}

function shell(shape: Shape3D, thickness: number, open: FaceSelect[]): Shape3D {
    if (!(thickness > 0)) {
        throw new Error('thickness must be positive');
    }
    let result: Shape3D;
    if (open.length === 0) {
        const oc = getOC();
        const builder = new oc.BRepOffsetAPI_MakeOffsetShape();
        builder.PerformByJoin(shape.wrapped, -thickness, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
            oc.GeomAbs_JoinType.GeomAbs_Arc, false);
        const inner = cast(builder.Shape()) as Shape3D;
        builder.delete();
        result = shape.cut(inner);
    } else {
        const faces = [...new Set(open)].flatMap((select) => outermostFaces(shape, select));
        try {
            result = shape.shell(thickness, (finder) => finder.inList(faces));
        } catch (e) {
            throw new Error(`could not offset the walls by ${thickness} mm (${errorMessage(e)}); fillets smaller than `
                + 'the wall thickness usually cause this: use a bigger radius, or shell first and fillet after');
        }
    }
    result = asSolid(result, 'shell');
    if (!isValid(result)) {
        throw new Error(`walls of ${thickness} mm do not fit this shape (try a thinner wall or fewer fillets)`);
    }
    const before = measureVolume(shape);
    const after = measureVolume(result);
    if (!(after > 1e-6 && after < before - 1e-6)) {
        throw new Error('shell did not hollow the solid');
    }
    return result;
}

function throughLength(shape: Shape3D, position: Vec3): number {
    const [lo, hi] = shapeBounds(shape);
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    const centre = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
    return diag + Math.hypot(position[0] - centre[0], position[1] - centre[1], position[2] - centre[2]) + 1;
}

/** Hole tool with its entry at the origin, drilling along -Y. */
function holeTool(dims: HoleDimensions, depth: number): Shape3D {
    const above = 0.5;
    const r = dims.diameter / 2;
    if (!(r > 0)) {
        throw new Error('hole diameter must be positive');
    }
    const parts = [cylinderY(r, -depth, above)];
    if (dims.counterbore) {
        parts.push(cylinderY(dims.counterbore.diameter / 2, -dims.counterbore.depth, above));
    }
    if (dims.countersink && dims.countersink.diameter / 2 > r) {
        const R = dims.countersink.diameter / 2;
        const sink = (R - r) / Math.tan(rad(dims.countersink.angle / 2));
        parts.push(revolve([[0, above], [R, above], [R, 0], [r, -sink], [0, -sink]]));
    }
    if (dims.nutTrap) {
        parts.push(prism(hexagon(dims.nutTrap.acrossFlats), -dims.nutTrap.depth, dims.nutTrap.depth + above));
    }
    return fuseAll(parts);
}

function cutChecked(shape: Shape3D, tool: Shape3D, what: string): Shape3D {
    const result = asSolid(shape.cut(tool), what);
    // A cut that touches the part changes its faces; only measure when that is not obvious.
    if (result.faces.length === shape.faces.length && Math.abs(measureVolume(shape) - measureVolume(result)) < 1e-6) {
        throw new Error(`the ${what} does not touch the part`);
    }
    return result;
}

const fmtMm = (mm: number): string => `${Math.round(mm * 1e6) / 1e6} mm`;

/** The edges a fillet or chamfer picked in the view: its picked edges, and every edge of its picked faces. */
function pickedEdges(shape: Shape3D, f: { at?: Vec3[]; faces?: FacePickRef[]; tangent?: boolean }): Edge[] {
    const edges = [
        ...resolveEdges(shape, f.at ?? [], { tangent: f.tangent }),
        ...resolveFaces(shape, f.faces ?? [], { tangent: f.tangent }).flatMap((face) => face.edges),
    ];
    return edges.filter((edge, i) => edges.findIndex((other) => other.isSame(edge)) === i);
}

function applyToBody(shape: Shape3D, f: Extract<Feature, { op: 'fillet' | 'chamfer' | 'shell' }>,
    print: PrintSettings): Shape3D {
    switch (f.op) {
        case 'fillet':
            if (!(f.radius > 0)) throw new Error('radius must be positive');
            singleSolid(shape, 'fillet');
            // Edges picked in the view win over the group.
            if (f.at?.length || f.faces?.length) {
                return filletEdges(shape, pickedEdges(shape, f), f.radius2 !== undefined ? { radii: [f.radius, f.radius2] } : { radius: f.radius });
            }
            return roundEdges(shape, f.radius, edgePicker(shape, f.edges ?? 'all'), false);
        case 'chamfer': {
            if (!(f.size > 0)) throw new Error('size must be positive');
            singleSolid(shape, 'chamfer');
            const spec: ChamferSpec = f.angle !== undefined ? { distance: f.size, angle: f.angle, side: f.side }
                : f.distance2 !== undefined ? { distances: [f.size, f.distance2], side: f.side } : { distance: f.size };
            if (f.at?.length || f.faces?.length) {
                return chamferEdges(shape, pickedEdges(shape, f), spec);
            }
            if (f.angle !== undefined || f.distance2 !== undefined) {
                return chamferEdges(shape, shape.edges.filter(edgePicker(shape, f.edges ?? 'all')), spec);
            }
            return roundEdges(shape, f.size, edgePicker(shape, f.edges ?? 'all'), true);
        }
        case 'shell':
            singleSolid(shape, 'shell');
            if (f.remove?.length || f.outward) {
                const faces = [...(f.open ?? []).flatMap((side) => outermostFaces(shape, side)), ...resolveFaces(shape, f.remove ?? [])];
                return shellFaces(shape, f.thickness, faces, { outward: f.outward });
            }
            return shell(shape, f.thickness, f.open ?? []);
    }
}

/** The older part-frame plane names, as base planes. */
const MIRROR_PLANES: Record<'YZ' | 'XY' | 'XZ', PlaneRef> = { YZ: 'right', XY: 'front', XZ: 'top' };

/** A mirror step's plane: origin (moved by the offset along the normal) and normal. */
function mirrorPlane(f: Extract<Feature, { op: 'mirror' }>, earlier: Feature[]): { origin: Vec3; normal: Vec3 } {
    if (f.plane === undefined) {
        throw new Error('a mirror needs a plane');
    }
    const ref = typeof f.plane === 'string' && f.plane in MIRROR_PLANES ? MIRROR_PLANES[f.plane as 'YZ'] : f.plane as PlaneRef;
    const p = resolvePlane(ref, earlier, 'mirror plane');
    const offset = f.offset ?? 0;
    const origin: Vec3 = [p.origin[0] + p.normal[0] * offset, p.origin[1] + p.normal[1] * offset, p.origin[2] + p.normal[2] * offset];
    return { origin, normal: p.normal };
}

/**
 * Mirror: with `features`, those earlier steps' tools are added or cut again, mirrored (Features to mirror);
 * else the body built so far is mirrored and joined (or replaced by its image when keepOriginal is false).
 */
function mirror(shape: Shape3D | null, f: Extract<Feature, { op: 'mirror' }>, state: BuildState): Shape3D {
    const { origin, normal } = mirrorPlane(f, before(state));
    if (!f.features?.length) {
        const body = needBody(shape);
        // replicad's mirror consumes its input, so mirror a copy.
        const image = body.clone().mirror(normal, origin);
        return f.keepOriginal === false ? image : asSolid(body.fuse(image), 'mirror');
    }
    let body = shape;
    for (const id of f.features) {
        const index = state.features.findIndex((g) => g.id === id);
        if (index < 0 || index >= state.index) {
            throw new Error(`step "${id}" not found (a mirror repeats earlier steps of this part)`);
        }
        const step = state.features[index];
        if (step.suppressed) {
            continue;
        }
        const made = stepTool(body, step, state, index);
        if (!made) {
            throw new Error(`step "${step.name ?? id}" (${step.op}) cannot be mirrored: only steps that add or cut material can`);
        }
        body = combine(body, made.tool.clone().mirror(normal, origin), made.mode, `mirror of "${step.name ?? id}"`);
    }
    return needBody(body);
}

/** Everything a step may need besides the body: earlier steps, resolved sketches and other parts. */
interface BuildState {
    print: PrintSettings;
    features: Feature[];
    /** Index of the step being applied. */
    index: number;
    sketches: Map<string, Sketch>;
    /** Where each thread built so far runs: a point on its axis, the axis, its nominal radius and pitch. */
    threads: Map<string, ThreadAxis>;
    /** Threads a preview shows without building them (see ThreadGhost). */
    ghosts: ThreadGhost[];
    /** What the open tool form should say about the steps (see PartialBuild). */
    notes: string[];
    context?: CombineContext;
    /** Parts being built, outermost first, to catch combine cycles. */
    stack: string[];
}

const before = (state: BuildState, index = state.index): Feature[] => state.features.slice(0, index);

/** A sketch with any `{ planeRef }` replaced by the plane it refers to, as of the given earlier steps. */
function concrete(sketch: Sketch, earlier: Feature[]): Sketch {
    const plane = sketch?.plane;
    if (plane && typeof plane === 'object' && 'planeRef' in plane) {
        return { ...sketch, plane: resolvePlane(plane, earlier, 'sketch plane') };
    }
    return sketch;
}

function resolveSketch(source: { sketch?: Sketch; sketchRef?: string }, state: BuildState, index = state.index): Sketch {
    if (source.sketchRef !== undefined) {
        const sketch = state.sketches.get(source.sketchRef);
        if (!sketch) {
            throw new Error(`sketch "${source.sketchRef}" not found (it must be an earlier sketch step of this part)`);
        }
        return sketch;
    }
    if (!source.sketch) {
        throw new Error('needs a sketch or a sketchRef');
    }
    return concrete(source.sketch, before(state, index));
}

const NO_BODY = 'needs a body first: start the part with an extrude, revolve, loft or sweep in add mode';

function needBody(shape: Shape3D | null): Shape3D {
    if (!shape) {
        throw new Error(NO_BODY);
    }
    return shape;
}

/** Joins or removes a tool; in add mode it starts the body when there is none yet. */
function combine(shape: Shape3D | null, tool: Shape3D, mode: 'add' | 'cut', what: string): Shape3D {
    if (mode === 'cut') {
        return cutChecked(needBody(shape), tool, `${what} cut`);
    }
    return shape ? asSolid(shape.fuse(tool), what) : asSolid(tool, what);
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Helix around an axis starting next to `centre` (the profile), so the profile sits at the helix start. A taper
 * (degrees) makes a conical helix that widens along the axis direction.
 */
function helixWire(h: HelixPath, centre: Vec3, earlier: Feature[]): Wire {
    const axis = resolveAxis(h.axis, earlier, 'helix axis');
    const d = axis.direction;
    const rel = sub3(centre, axis.point);
    const along = dot3(rel, d);
    const foot: Vec3 = [axis.point[0] + d[0] * along, axis.point[1] + d[1] * along, axis.point[2] + d[2] * along];
    const radial = sub3(centre, foot);
    const distance = Math.hypot(...radial);
    const radius = h.radius ?? distance;
    if (!(radius > 1e-6)) {
        throw new Error('helix radius must be positive (the profile sits on the axis: give a radius)');
    }
    if (!(h.pitch > 0) || !(h.turns > 0)) {
        throw new Error('helix needs a positive pitch and number of turns');
    }
    const taper = h.taper ?? 0;
    if (!(Math.abs(taper) < 80)) {
        throw new Error('helix taper must be between -80 and 80 degrees');
    }
    let xDir: Vec3 = distance > 1e-9 ? [radial[0] / distance, radial[1] / distance, radial[2] / distance] : [1, 0, 0];
    if (distance <= 1e-9) {
        const seed: Vec3 = Math.abs(d[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0];
        const k = dot3(seed, d);
        const x = sub3(seed, [d[0] * k, d[1] * k, d[2] * k]);
        const l = Math.hypot(...x);
        xDir = [x[0] / l, x[1] / l, x[2] / l];
    }
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const alpha = rad(taper);
        const ax3 = r(makeAx3(foot, d, xDir));
        const surface = Math.abs(taper) < 1e-9
            ? new oc.Geom_CylindricalSurface(ax3, radius)
            : new oc.Geom_ConicalSurface(ax3, alpha, radius);
        // In (u, v) the helix is a straight line: u turns 2 pi per pitch; on a cone v runs along the slant.
        const rise = h.pitch / Math.cos(alpha);
        const turn = (h.leftHanded ? -1 : 1) * 2 * Math.PI;
        const line = r(new oc.Geom2d_Line(r(new oc.gp_Pnt2d(0, 0)), r(new oc.gp_Dir2d(turn, rise))));
        const length = h.turns * Math.hypot(turn, rise);
        const segment = r(new oc.GC_MakeSegment2d(line.Value(0), line.Value(length)));
        const edge = r(new oc.BRepBuilderAPI_MakeEdge(r(segment.Value()), r(surface))).Edge();
        const wire = r(new oc.BRepBuilderAPI_MakeWire(edge)).Wire();
        oc.BRepLib.BuildCurves3d(wire);
        return new Wire(wire);
    } finally {
        gc();
    }
}

/** Sweeps one wire along a spine; keepNormal: the profile keeps its plane's orientation (a fixed trihedron). */
function sweepWire(wire: Wire, spine: Wire, opts: { frenet?: boolean; keepNormal?: SketchFrame | null }): Shape3D {
    if (!opts.keepNormal) {
        return genericSweep(wire, spine, opts.frenet ? { frenet: true } : { transitionMode: 'round' }) as Shape3D;
    }
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const { origin, normal, u } = opts.keepNormal;
        const builder = r(new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped));
        builder.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
        builder.SetMode(r(new oc.gp_Ax2(r(new oc.gp_Pnt(...origin)), r(new oc.gp_Dir(...normal)), r(new oc.gp_Dir(...u)))));
        builder.Add(wire.wrapped, false, false);
        builder.Build(r(new oc.Message_ProgressRange()));
        if (!builder.IsDone()) {
            throw new Error('the profile cannot be swept along this path with its normal kept constant');
        }
        builder.MakeSolid();
        return cast(builder.Shape()) as Shape3D;
    } finally {
        gc();
    }
}

/** A circle of `diameter` at the start of the path, square to it there (the Circular profile option). */
function circularProfile(path: Wire, diameter: number): { outer: Wire; holes: Wire[]; centre: Vec3; frame: SketchFrame } {
    if (!(diameter > 0)) {
        throw new Error('circular profile diameter must be positive');
    }
    const centre = path.startPoint.toTuple() as Vec3;
    const t = path.tangentAt(0).toTuple() as Vec3;
    const l = Math.hypot(...t);
    const normal: Vec3 = [t[0] / l, t[1] / l, t[2] / l];
    const seed: Vec3 = Math.abs(normal[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const k = dot3(seed, normal);
    const x = sub3(seed, [normal[0] * k, normal[1] * k, normal[2] * k]);
    const xl = Math.hypot(...x);
    const u: Vec3 = [x[0] / xl, x[1] / xl, x[2] / xl];
    const v: Vec3 = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]];
    return { outer: assembleWire([makeCircle(diameter / 2, centre, normal)]), holes: [], centre, frame: { origin: centre, u, v, normal } };
}

function sweepTool(f: Extract<Feature, { op: 'sweep' }>, state: BuildState, index: number): Shape3D {
    const helix = 'helix' in f.path && f.path.helix ? f.path.helix : null;
    if (helix && f.twist) {
        throw new Error('twist is not supported along a helix');
    }
    const drawn = f.profile ? sweepProfile(resolveSketch(f.profile, state, index), f.regions) : null;
    // An open path is used from its end nearer the profile.
    const path = helix ? null : pathWire(resolveSketch(f.path as { sketch?: Sketch; sketchRef?: string }, state, index), drawn?.centre);
    let profile: { outer: Wire; holes: Wire[]; centre: Vec3; frame: SketchFrame };
    if (drawn) {
        profile = drawn;
    } else if (f.diameter !== undefined) {
        if (!path) {
            throw new Error('a circular profile needs a path sketch, not a helix; draw the profile for a coil');
        }
        profile = circularProfile(path.wire, f.diameter);
    } else {
        throw new Error('sweep needs a profile sketch or a diameter (circular profile)');
    }
    const orientation = f.orientation ?? 'followPath';
    if (orientation !== 'followPath' && orientation !== 'keepNormal') {
        throw new Error('sweep orientation must be followPath or keepNormal');
    }
    const keepNormal = orientation === 'keepNormal' ? profile.frame : null;
    if (keepNormal && f.twist) {
        throw new Error('twist cannot be combined with keep normal constant');
    }
    const sweepOne = (wire: Wire): Shape3D => {
        if (helix) {
            return sweepWire(wire, helixWire(helix, profile.centre, before(state, index)), { frenet: true, keepNormal });
        }
        if (f.twist) {
            if (!path!.line) {
                throw new Error('twist is only supported along a single straight line');
            }
            return twistExtrude(wire, f.twist, path!.line[0], sub3(path!.line[1], path!.line[0])) as Shape3D;
        }
        return sweepWire(wire, path!.wire, { keepNormal });
    };
    let result = asSolid(sweepOne(profile.outer), 'sweep');
    // A profile with holes (a tube's ring): the holes swept the same way are taken out.
    for (const hole of profile.holes) {
        result = asSolid(result.cut(asSolid(sweepOne(hole), 'sweep')), 'sweep');
    }
    if (!isValid(result)) {
        throw new Error('the swept solid intersects itself (profile too big for the path\'s bends or helix pitch?)');
    }
    return result;
}

interface Tool {
    tool: Shape3D;
    mode: 'add' | 'cut';
    what: string;
}

/** The material a step adds or removes, or null for steps that only modify the body (fillet, shell...). */
function stepTool(shape: Shape3D | null, f: Feature, state: BuildState, index: number): Tool | null {
    switch (f.op) {
        case 'add':
        case 'cut': {
            needBody(shape);
            // Added bodies keep the preview's soft edges; cutting tools are sharp so pockets get crisp corners.
            const tool = fuseAll(repeatCopies(place(buildShape(f.shape, f.op === 'add'), f.position, f.rotation), f.repeat));
            return { tool, mode: f.op, what: f.op };
        }
        case 'hole': {
            const body = needBody(shape);
            const dims = holeDimensions(f.spec, state.print);
            const depth = f.depth ?? dims.depth ?? throughLength(body, f.position);
            if (!(depth > 0)) throw new Error('depth must be positive');
            const tool = orientDown(holeTool(dims, depth), f.direction ?? [0, -1, 0]).translate(f.position);
            return { tool: fuseAll(repeatCopies(tool, f.repeat)), mode: 'cut', what: 'hole' };
        }
        case 'extrude': {
            const sketch = resolveSketch(f, state, index);
            if (!isPlainExtrude(f)) {
                if (f.mode === 'cut') needBody(shape);
                const tool = extrudeTool(sketch, f, f.regions, shape, shape ? shapeBounds(shape) : null);
                return { tool, mode: f.mode, what: 'extrude' };
            }
            let range: [number, number];
            if (f.end ? f.end === 'throughAll' : f.through) {
                if (!shape) {
                    throw new Error('through needs a body to pass through; give a distance for the first extrude');
                }
                range = throughRange(sketch, shapeBounds(shape), f.direction);
            } else if (f.distance !== undefined) {
                range = extrudeRange(f.distance, f.direction);
            } else {
                throw new Error('extrude needs a distance or through: true');
            }
            if (f.mode === 'cut') needBody(shape);
            return { tool: extrudeSketch(sketch, range, f.regions), mode: f.mode, what: 'extrude' };
        }
        case 'revolve': {
            const sketch = resolveSketch(f, state, index);
            if (f.mode === 'cut') needBody(shape);
            const tool = revolveSketch(sketch, f.axis, f.angle ?? 360, f.regions, {
                features: before(state, index), type: f.type, reverse: f.reverse, angle2: f.angle2,
            });
            return { tool, mode: f.mode, what: 'revolve' };
        }
        case 'loft': {
            const sections = (f.sections ?? []).map((source, i) => {
                try {
                    return resolveSketch(source, state, index);
                } catch (e) {
                    throw new Error(`section ${i}: ${errorMessage(e)}`);
                }
            });
            if (f.mode === 'cut') needBody(shape);
            return { tool: loftSketches(sections, !!f.ruled, !!f.closed), mode: f.mode, what: 'loft' };
        }
        case 'sweep':
            if (f.mode === 'cut') needBody(shape);
            return { tool: sweepTool(f, state, index), mode: f.mode, what: 'sweep' };
        default:
            return null;
    }
}

function pattern(shape: Shape3D | null, f: Extract<Feature, { op: 'pattern' }>, state: BuildState): Shape3D {
    const count = Math.floor(f.count);
    if (!(count >= 2)) {
        throw new Error('a pattern needs a count of at least 2');
    }
    if (!f.features?.length) {
        throw new Error('a pattern needs the ids of the steps to repeat');
    }
    const earlier = before(state);
    const skipped = new Set((f.skip ?? []).map(([i, j]) => `${i},${j}`));
    // Instances as [n along direction 1, n along direction 2], numbered from 0 here (the seed is [0, 0]).
    const instances: [number, number][] = [];
    let move: (s: Shape3D, i: number, j: number) => Shape3D;
    if (f.kind === 'linear') {
        const step = (direction: AxisRef | Vec3 | undefined, spacing: number | undefined, reverse: boolean | undefined, what: string): Vec3 => {
            if (direction === undefined) throw new Error(`a linear pattern needs ${what}: an axis or a direction vector`);
            const d = Array.isArray(direction) ? direction : resolveAxis(direction, earlier, `pattern ${what}`).direction;
            const l = Math.hypot(...d);
            if (!(l > 1e-9)) throw new Error(`pattern ${what} must be a non-zero vector`);
            if (spacing === undefined || !Number.isFinite(spacing) || spacing === 0) throw new Error(`pattern spacing along ${what} must be non-zero`);
            const s = (reverse ? -spacing : spacing) / l;
            return [d[0] * s, d[1] * s, d[2] * s];
        };
        const a = step(f.direction, f.spacing, f.reverse, 'direction 1');
        const second = f.direction2 !== undefined;
        const b = second ? step(f.direction2, f.spacing2, f.reverse2, 'direction 2') : [0, 0, 0] as Vec3;
        const count2 = second ? Math.floor(f.count2 ?? 0) : 1;
        if (second && !(count2 >= 2)) throw new Error('direction 2 needs a count of at least 2');
        for (let j = 0; j < count2; j++) {
            for (let i = 0; i < (j > 0 && f.seedOnly2 ? 1 : count); i++) {
                instances.push([i, j]);
            }
        }
        move = (s, i, j) => s.translate(a[0] * i + b[0] * j, a[1] * i + b[1] * j, a[2] * i + b[2] * j);
    } else {
        if (f.axis === undefined) throw new Error('a circular pattern needs an axis');
        const axis = resolveAxis(f.axis, earlier, 'pattern axis');
        const equal = f.equal !== false;
        let angle: number;
        if (equal) {
            const total = f.angle ?? 360;
            if (!(Math.abs(total) > 1e-6 && Math.abs(total) <= 360)) throw new Error('pattern angle must be between 0 and 360');
            // A full turn spreads the copies evenly without a duplicate at 360; a partial arc includes both ends.
            angle = Math.abs(total) >= 360 ? total / count : total / (count - 1);
        } else {
            angle = f.angle ?? NaN;
            if (!(Math.abs(angle) > 1e-6 && Math.abs(angle * (count - 1)) < 360 + 1e-6)) {
                throw new Error('the angle between instances must be above 0, and all instances must fit in one turn');
            }
        }
        if (f.reverse) angle = -angle;
        for (let i = 0; i < count; i++) {
            instances.push([i, 0]);
        }
        move = (s, i) => s.rotate(angle * i, axis.point, axis.direction);
    }
    const placed = instances.filter(([i, j]) => (i || j) && !skipped.has(`${i + 1},${j + 1}`));
    if (placed.length === 0) {
        throw new Error('every instance of the pattern is skipped');
    }
    let body = shape;
    for (const id of f.features) {
        const index = state.features.findIndex((g) => g.id === id);
        if (index < 0 || index >= state.index) {
            throw new Error(`step "${id}" not found (a pattern repeats earlier steps of this part)`);
        }
        const step = state.features[index];
        if (step.suppressed) {
            continue;
        }
        const made = stepTool(body, step, state, index);
        if (!made) {
            throw new Error(`step "${step.name ?? id}" (${step.op}) cannot be patterned: only steps that add or cut material can`);
        }
        const copies = placed.map(([i, j]) => move(made.tool.clone(), i, j));
        body = combine(body, fuseAll(copies), made.mode, `pattern of "${step.name ?? id}"`);
    }
    return needBody(body);
}

function combineWith(shape: Shape3D, f: Extract<Feature, { op: 'combine' }>, state: BuildState): Shape3D {
    const context = state.context;
    const other = context?.parts[f.part];
    const self = context?.parts[context.self];
    if (!context || !other || !self) {
        throw new Error(`part "${f.part}" is not available to combine with`);
    }
    if (state.stack.includes(f.part)) {
        throw new Error(`combine cycle: ${[...state.stack, f.part].join(' -> ')}`);
    }
    const built = buildPartial(other, state.print, { ...context, self: f.part }, [...state.stack, f.part]);
    if (built.error || !built.shape) {
        throw new Error(`part "${f.part}": ${built.error ?? 'has no body'}`);
    }
    const { axis, angle, translation } = relativePlacement(self, other);
    let tool = built.shape.clone();
    if (Math.abs(angle) > 1e-9) tool = tool.rotate(angle, [0, 0, 0], axis);
    if (Math.hypot(...translation) > 1e-12) tool = tool.translate(translation);
    switch (f.operation) {
        case 'join':
            return asSolid(shape.fuse(tool), 'join');
        case 'cut':
            return cutChecked(shape, tool, 'combine cut');
        case 'intersect': {
            const result = shape.intersect(tool);
            if (result.isNull || result.solids.length === 0) {
                throw new Error(`the part does not overlap "${f.part}"`);
            }
            return result;
        }
        default:
            throw new Error('combine operation must be join, cut or intersect');
    }
}

function replicadPlane(ref: PlaneRef, earlier: Feature[], what: string): Plane {
    const p = resolvePlane(ref, earlier, what);
    return new Plane(p.origin, p.xDir, p.normal);
}

function split(shape: Shape3D, f: Extract<Feature, { op: 'split' }>, state: BuildState): Shape3D {
    const { positive, negative } = shape.split(replicadPlane(f.plane, before(state), 'split plane'));
    if (f.keep === 'both') {
        if (!positive || !negative) {
            throw new Error('the plane does not cross the body');
        }
        return compound([positive, negative]);
    }
    const kept = f.keep === 'negative' ? negative : f.keep === 'positive' ? positive : undefined;
    if (kept === undefined) {
        throw new Error('keep must be positive, negative or both');
    }
    if (!kept) {
        throw new Error(`nothing of the body is on the ${f.keep} side of the plane`);
    }
    return kept;
}

function draft(shape: Shape3D, f: Extract<Feature, { op: 'draft' }>, state: BuildState): Shape3D {
    if (!(Math.abs(f.angle) > 1e-6 && Math.abs(f.angle) < 45)) {
        throw new Error('draft angle must be between 0 and 45 degrees');
    }
    singleSolid(shape, 'draft');
    const sides = [...new Set(f.faces ?? [])].flatMap((select) => outermostFaces(shape, select));
    if (f.picked?.length || f.neutralFace || f.flip) {
        // Faces and/or the neutral plane picked in the view.
        const picked = [...sides, ...resolveFaces(shape, f.picked ?? [], { tangent: f.tangent })];
        if (picked.length === 0) {
            throw new Error('no faces selected');
        }
        if (!f.neutralFace && !f.neutral) {
            throw new Error('pick a neutral plane');
        }
        const plane = f.neutralFace
            ? planeOfFace(resolveFaces(shape, [f.neutralFace])[0], f.neutralFace.at)
            : resolvePlane(f.neutral!, before(state), 'neutral plane');
        return draftFaces(shape, picked, f.angle, { origin: plane.origin, normal: plane.normal }, { flip: f.flip });
    }
    const faces = sides;
    if (faces.length === 0) {
        throw new Error('no faces selected');
    }
    if (!f.neutral) {
        throw new Error('pick a neutral plane');
    }
    const neutral = replicadPlane(f.neutral, before(state), 'neutral plane');
    let result: Shape3D;
    try {
        result = asSolid(shape.draft(f.angle, (finder) => finder.inList(faces), neutral), 'draft');
    } catch (e) {
        throw new Error(`could not draft those faces (${errorMessage(e)})`);
    }
    if (!isValid(result)) {
        throw new Error('the drafted faces do not meet their neighbours cleanly');
    }
    return result;
}

function applyFeature(shape: Shape3D | null, f: Feature, state: BuildState): Shape3D | null {
    switch (f.op) {
        case 'sketch':
        case 'plane':
        case 'axis':
        case 'point':
            // Reference geometry builds nothing; later steps use it by id.
            return shape;
        case 'pattern':
            return pattern(shape, f, state);
        case 'combine':
            return combineWith(needBody(shape), f, state);
        case 'split':
            return split(needBody(shape), f, state);
        case 'draft':
            return draft(needBody(shape), f, state);
        case 'fillet':
        case 'chamfer': {
            const body = needBody(shape);
            if (f.op === 'chamfer' && f.at?.length && state.threads.size) {
                // The end of a thread is chamfered as a cut; any other picked edges go to the kernel as usual.
                const mouths = threadMouths(body, f.at, state.threads);
                if (mouths.some((m) => m)) {
                    const rest = f.at.filter((_, i) => !mouths[i]);
                    let out = rest.length || f.faces?.length ? applyToBody(body, { ...f, at: rest }, state.print) : body;
                    const done: { thread: ThreadAxis; s: number }[] = [];
                    for (const m of mouths) {
                        if (m && !done.some((d) => d.thread === m.thread && Math.abs(d.s - m.s) < 1e-6)) {
                            out = threadMouthChamfer(out, m.thread, m.s, f);
                            done.push(m);
                        }
                    }
                    return out;
                }
            }
            try {
                return applyToBody(body, f, state.print);
            } catch (e) {
                if (!(e instanceof Error) || !/failed on|not done|could not/i.test(e.message)) {
                    throw e;
                }
                const earlier = before(state).filter((s) => !s.suppressed);
                const label = `${f.op} of ${fmtMm(f.op === 'fillet' ? f.radius : f.size)}`;
                const self = f.name ?? 'this step';
                // Beside a cut thread the wall of the hole or shaft pinches out between the helical faces, so no kernel
                // blend fits there at any size: the thread has to come after.
                const threads = threadsUnder(body, f, state.threads)
                    .map((id) => earlier.find((s) => s.id === id)).filter((s): s is Feature => !!s);
                if (threads.length) {
                    const names = threads.map((s) => s.name ?? s.id).join(', ');
                    throw new Error(`${label}: a selected edge runs along a thread (${names}), which leaves too little of the `
                        + `hole or shaft wall beside it for the kernel to ${f.op}, at any size. Cut the thread afterwards: `
                        + `drag ${threads[0].name ?? threads[0].id} below ${self} in the feature tree. The thread then starts behind it`);
                }
                // An edge that ends on an earlier fillet or chamfer only works up to about that one's size.
                const blends = earlier.filter((s) => s.op === 'fillet' || s.op === 'chamfer');
                if (blends.length) {
                    const names = blends.map((s) => s.name ?? s.id).join(', ');
                    throw new Error(`${label} could not be built. If its edges end on ${names}: the kernel only blends into an `
                        + `earlier ${f.op === 'fillet' ? 'fillet' : 'fillet or chamfer'} up to a limited size (roughly two to three times `
                        + `the earlier one), so ${self} has to come first: drag ${self} above ${blends[0].name ?? blends[0].id} in the `
                        + 'feature tree (corners first, then the edges around them). Otherwise the size is too large for the faces '
                        + 'next to the edges');
                }
                throw e;
            }
        }
        case 'shell':
            return applyToBody(needBody(shape), f, state.print);
        case 'thread': {
            const made = threadFeature(needBody(shape), f, state.print);
            made.axes.forEach((axis, i) => state.threads.set(threadKey(f.id, i), axis));
            state.ghosts.push(...made.ghosts);
            state.notes.push(...made.notes.map((n) => `${f.name ?? f.id}: ${n}`));
            return made.shape;
        }
        case 'mirror':
            return mirror(shape, f, state);
        default: {
            const made = stepTool(shape, f, state, state.index);
            if (!made) {
                throw new Error(`unknown step "${(f as Feature).op}"`);
            }
            return combine(shape, made.tool, made.mode, made.what);
        }
    }
}

export interface PartSpec {
    shape: Shape;
    features?: Feature[];
}

export interface PartialBuild {
    /** The solid as far as it could be built (null if the base shape failed, or there is no body yet). */
    shape: Shape3D | null;
    /** Why the build stopped, naming the failing feature; null on success. */
    error: string | null;
    /** Reference steps whose references taken from the model were found again, as found (by step id). */
    followed?: Record<string, Feature>;
    /** What a tool form should say about the steps, named (a thread cut to the length of its hole). */
    notes?: string[];
}

// The body after each step, kept so that a build which shares its first steps with an earlier one (editing a later
// step, a preview while typing) starts from there instead of from nothing.
interface Prefix {
    shape: Shape3D | null;
    threads: [string, ThreadAxis][];
    ghosts: ThreadGhost[];
    notes: string[];
    /** The reference steps followed so far (by index), as found. */
    followed: [number, Feature][];
}

const PREFIX_LIMIT = 48;
const prefixes = new Map<string, Prefix>();

const digest = (text: string): string => createHash('sha1').update(text).digest('hex');

/** One key per step: everything that decides the body after it (names aside). */
function prefixKeys(part: PartSpec, print: PrintSettings, history: boolean, context: CombineContext | undefined): string[] {
    let key = digest(JSON.stringify([part.shape, print, history, context ?? null]));
    return (part.features ?? []).map(({ name: _name, ...step }) => {
        key = digest(key + JSON.stringify(step));
        return key;
    });
}

function remember(key: string, shape: Shape3D | null, threads: Map<string, ThreadAxis>, ghosts: ThreadGhost[],
    followed: Map<number, Feature>, notes: string[]): void {
    if (prefixes.has(key)) {
        return;
    }
    // A copy of the handle: steps may dispose of the body they are given.
    prefixes.set(key, { shape: shape ? shape.clone() : null, threads: [...threads], ghosts: [...ghosts], followed: [...followed], notes: [...notes] });
    while (prefixes.size > PREFIX_LIMIT) {
        const oldest = prefixes.keys().next().value as string;
        prefixes.get(oldest)?.shape?.delete();
        prefixes.delete(oldest);
    }
}

/**
 * Builds as far as possible: on a failing feature, returns the solid before it and the error. `context` supplies
 * the other parts that combine steps use.
 */
export function buildPartial(part: PartSpec, print: PrintSettings, context?: CombineContext, stack?: string[]): PartialBuild {
    let shape: Shape3D | null = null;
    // A copy: reference steps are replaced by themselves as found on the body (followRefs.ts) for the steps after them.
    const features = [...(part.features ?? [])];
    const followed = new Map<number, Feature>();
    const found = (): Record<string, Feature> => Object.fromEntries([...followed.values()].map((f) => [f.id, f]));
    const said = (): { notes?: string[] } => (state.notes.length ? { notes: [...state.notes] } : {});
    // Reference steps build nothing, so they do not count as a history for the default edge softening.
    const history = features.some((f) => !f.suppressed && !['sketch', 'plane', 'axis', 'point'].includes(f.op));
    const state: BuildState = {
        print, features, index: 0, sketches: new Map(), threads: new Map(), ghosts: [], notes: [], context,
        stack: stack ?? (context ? [context.self] : []),
    };
    // Start from the longest run of first steps that was built before.
    const keys = prefixKeys(part, print, history, context);
    let start = 0;
    for (let index = features.length - 1; index >= 0 && start === 0; index--) {
        const hit = prefixes.get(keys[index]);
        if (hit) {
            prefixes.delete(keys[index]);
            prefixes.set(keys[index], hit);
            shape = hit.shape ? hit.shape.clone() : null;
            state.threads = new Map(hit.threads);
            state.ghosts = [...hit.ghosts];
            state.notes = [...hit.notes];
            for (const [i, step] of hit.followed) {
                features[i] = step;
                followed.set(i, step);
            }
            start = index + 1;
        }
    }
    if (start === 0 && part.shape.kind !== 'empty') {
        try {
            shape = buildShape(part.shape, !history);
        } catch (e) {
            const message = errorMessage(e);
            return { shape: null, error: part.shape.kind === 'script' ? message : `shape (${part.shape.kind}): ${message}` };
        }
    }
    for (let index = 0; index < features.length; index++) {
        const feature = features[index];
        state.index = index;
        const label = `feature "${feature.name ?? feature.id}" (${feature.op})`;
        // Sketch steps resolve even when suppressed: suppressing a sketch hides it, not the features using it.
        if (feature.op === 'sketch') {
            try {
                // A derived sketch takes the parent's contents, on its own plane.
                const own = feature.sketch.derived ? derivedSketch(feature.sketch, state.sketches.get(feature.sketch.derived.from)) : feature.sketch;
                state.sketches.set(feature.id, concrete(own, before(state)));
            } catch (e) {
                if (!feature.suppressed && index >= start) {
                    return { shape, error: `${label}: ${errorMessage(e)}`, followed: found() };
                }
            }
            continue;
        }
        // References taken from the model are found again on the body as it is here (suppressed too: later steps may use them).
        if (index >= start) {
            try {
                const next = followStep(shape, feature);
                if (next !== feature) {
                    features[index] = next;
                    followed.set(index, next);
                }
            } catch (e) {
                if (!feature.suppressed) {
                    return { shape, error: `${label}: ${errorMessage(e)}`, followed: found() };
                }
            }
        }
        if (feature.suppressed || index < start) {
            continue;
        }
        try {
            const next = applyFeature(shape, features[index], state);
            shape = next && normalizeSolid(next, 'the result');
        } catch (e) {
            return { shape: withGhosts(shape, state.ghosts), error: `${label}: ${errorMessage(e)}`, followed: found(), ...said() };
        }
        remember(keys[index], shape, state.threads, state.ghosts, followed, state.notes);
    }
    return { shape: withGhosts(shape, state.ghosts), error: null, followed: found(), ...said() };
}

/** Solids of preview builds and the threads shown on them without being built, meshed by meshSolid. */
const ghosted = new WeakMap<Shape3D, ThreadGhost[]>();

function withGhosts(shape: Shape3D | null, ghosts: ThreadGhost[]): Shape3D | null {
    if (shape && ghosts.length) {
        ghosted.set(shape, ghosts);
    }
    return shape;
}

/** Builds the part's solid; throws an Error naming the failing feature, or if the part has no body. */
export function buildPart(part: PartSpec, print: PrintSettings, context?: CombineContext): Shape3D {
    const { shape, error } = buildPartial(part, print, context);
    if (error || !shape) {
        throw new Error(error ?? 'the part has no body yet');
    }
    return shape;
}

// ---- Meshing ------------------------------------------------------------------------------------------------

/** Hash codes of seam edges (where a closed surface meets itself), which CAD outlines leave out. */
function seamEdges(shape: Shape3D): Set<number> {
    const oc = getOC();
    const seams = new Set<number>();
    for (const face of shape.faces) {
        for (const edge of face.edges) {
            if (oc.BRep_Tool.IsClosed(edge.wrapped, face.wrapped)) {
                seams.add(edge.hashCode);
            }
        }
    }
    return seams;
}

/** Removes zero-area slivers (two corners at the same point), which OpenCascade leaves at poles and apexes. */
function dropDegenerate(positions: Float32Array, triangles: number[], faces: Uint32Array): { indices: Uint32Array; triFace: Uint32Array } {
    const same = (a: number, b: number): boolean => positions[a * 3] === positions[b * 3]
        && positions[a * 3 + 1] === positions[b * 3 + 1] && positions[a * 3 + 2] === positions[b * 3 + 2];
    const out: number[] = [];
    const kept: number[] = [];
    for (let i = 0; i + 2 < triangles.length; i += 3) {
        const [a, b, c] = [triangles[i], triangles[i + 1], triangles[i + 2]];
        if (!same(a, b) && !same(b, c) && !same(a, c)) {
            out.push(a, b, c);
            kept.push(faces[i / 3]);
        }
    }
    return { indices: Uint32Array.from(out), triFace: Uint32Array.from(kept) };
}

/** Face ordinal of every triangle, from replicad's face groups (whose start/count are in index units). */
function triangleFaces(mesh: { triangles: number[]; faceGroups: { start: number; count: number; faceId: number }[] }): Uint32Array {
    const faces = new Uint32Array(Math.floor(mesh.triangles.length / 3));
    const ordinals = new Map<number, number>();
    for (const group of mesh.faceGroups) {
        let ordinal = ordinals.get(group.faceId);
        if (ordinal === undefined) {
            ordinal = ordinals.size;
            ordinals.set(group.faceId, ordinal);
        }
        faces.fill(ordinal, Math.floor(group.start / 3), Math.floor((group.start + group.count) / 3));
    }
    return faces;
}

function meshWithOpenCascade(shape: Shape3D): MeshData {
    // Faces shared with an earlier (already meshed) solid keep stale triangulations that no longer match the
    // edges of new neighbouring faces; drop them so the whole solid is meshed in one consistent pass.
    getOC().BRepTools.Clean(shape.wrapped, true);
    const tolerance = meshTolerance(shape);
    const mesh = shape.mesh(tolerance);
    const lines = shape.meshEdges(tolerance);
    const seams = seamEdges(shape);
    let segments = 0;
    for (const group of lines.edgeGroups) {
        if (!seams.has(group.edgeId)) {
            segments += Math.floor(group.count / 2);
        }
    }
    const edges = new Float32Array(segments * 6);
    const segEdge = new Uint32Array(segments);
    const ordinals = new Map<number, number>();
    let o = 0;
    let s = 0;
    for (const group of lines.edgeGroups) {
        if (seams.has(group.edgeId)) {
            continue;
        }
        let ordinal = ordinals.get(group.edgeId);
        if (ordinal === undefined) {
            ordinal = ordinals.size;
            ordinals.set(group.edgeId, ordinal);
        }
        // replicad gives each edge as consecutive point pairs, one per segment.
        for (let i = group.start; i + 1 < group.start + group.count; i += 2) {
            for (let k = 0; k < 6; k++) {
                edges[o++] = lines.lines[i * 3 + k];
            }
            segEdge[s++] = ordinal;
        }
    }
    const positions = Float32Array.from(mesh.vertices);
    const { indices, triFace } = dropDegenerate(positions, mesh.triangles, triangleFaces(mesh));
    return { positions, normals: Float32Array.from(mesh.normals), indices, edges, triFace, segEdge };
}

function mergeMeshes(meshes: MeshData[]): MeshData {
    const total = (key: Exclude<keyof MeshData, 'followed' | 'notes'>): number => meshes.reduce((n, m) => n + m[key].length, 0);
    const out: MeshData = {
        positions: new Float32Array(total('positions')),
        normals: new Float32Array(total('normals')),
        indices: new Uint32Array(total('indices')),
        edges: new Float32Array(total('edges')),
        triFace: new Uint32Array(total('triFace')),
        segEdge: new Uint32Array(total('segEdge')),
    };
    let p = 0;
    let i = 0;
    let e = 0;
    let t = 0;
    let s = 0;
    // Face and edge ordinals continue from one mesh to the next.
    let faceBase = 0;
    let edgeBase = 0;
    for (const m of meshes) {
        out.positions.set(m.positions, p);
        out.normals.set(m.normals, p);
        const base = p / 3;
        for (let k = 0; k < m.indices.length; k++) {
            out.indices[i + k] = m.indices[k] + base;
        }
        out.edges.set(m.edges, e);
        let faces = 0;
        for (let k = 0; k < m.triFace.length; k++) {
            out.triFace[t + k] = m.triFace[k] + faceBase;
            faces = Math.max(faces, m.triFace[k] + 1);
        }
        let edgeCount = 0;
        for (let k = 0; k < m.segEdge.length; k++) {
            out.segEdge[s + k] = m.segEdge[k] + edgeBase;
            edgeCount = Math.max(edgeCount, m.segEdge[k] + 1);
        }
        p += m.positions.length;
        i += m.indices.length;
        e += m.edges.length;
        t += m.triFace.length;
        s += m.segEdge.length;
        faceBase += faces;
        edgeBase += edgeCount;
    }
    return out;
}

/** Triangles (per-face vertices: smooth within a face, sharp across edges) and B-rep edge outlines. */
export function meshSolid(shape: Shape3D): MeshData {
    const thread = threaded.get(shape);
    if (thread) {
        return mergeMeshes([meshWithOpenCascade(thread.body), ...thread.ridges.map(ridgeMesh)]);
    }
    const ghosts = ghosted.get(shape);
    return ghosts ? mergeMeshes([meshWithOpenCascade(shape), ...ghosts.map(ghostMesh)]) : meshWithOpenCascade(shape);
}
