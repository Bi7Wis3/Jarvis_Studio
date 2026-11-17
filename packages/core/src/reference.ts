// Construction planes and axes: resolves plane and axis references against a part's history, in the part frame.
// Shared by the CAD kernel (building) and the sketcher (drawing), so both see exactly the same planes.

import type {
    AxisRef, CustomSketchPlane, Feature, ModelEdgeShape, PlaneDefinition, PlaneRef, PointDefinition, PointRef, RevolveAxis, Sketch, SketchPlane,
    Vec3,
} from './index';
import { curveNormalPlane, curvePoint, curvePointOfDefinition, isCurvePointDefinition } from './curveRefs';

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function unit(a: Vec3, what: string): Vec3 {
    const l = length(a);
    if (!(l > 1e-9)) {
        throw new Error(`${what} must be a non-zero vector`);
    }
    return scale(a, 1 / l);
}

/** Rotates v about a unit axis by degrees (Rodrigues). */
function rotate(v: Vec3, axis: Vec3, degrees: number): Vec3 {
    const t = (degrees * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

/** A sensible u axis for a plane: the part's X projected onto it, or Z when the normal is close to X. */
function defaultXDir(normal: Vec3): Vec3 {
    const seed: Vec3 = Math.abs(normal[0]) > 0.9 ? [0, 0, -1] : [1, 0, 0];
    return unit(sub(seed, scale(normal, dot(seed, normal))), 'plane u axis');
}

/** Orthonormal plane: unit normal, u perpendicular to it (Gram-Schmidt). */
export function normalizePlane(plane: CustomSketchPlane): CustomSketchPlane {
    const normal = unit(plane.normal, 'plane normal');
    const x = sub(plane.xDir, scale(normal, dot(plane.xDir, normal)));
    if (!(length(x) > 1e-9)) {
        return { origin: plane.origin, normal, xDir: defaultXDir(normal) };
    }
    return { origin: plane.origin, normal, xDir: unit(x, 'plane u axis') };
}

const NAMED: Record<'top' | 'front' | 'right', CustomSketchPlane> = {
    top: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] },
    front: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    right: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 0, -1] },
};

export interface Axis {
    point: Vec3;
    direction: Vec3;
}

function earlier(features: Feature[], id: string, op: 'plane' | 'axis' | 'point' | 'sketch', where: string): Feature {
    const found = features.find((f) => f.id === id);
    if (!found || found.op !== op) {
        throw new Error(`${where}: ${op} "${id}" not found (it must be an earlier ${op} step of this part)`);
    }
    return found;
}

/**
 * Resolves any plane reference to an orthonormal plane in the part frame. `features` are the part's steps before
 * the one asking (later steps are never visible), so references can only point backwards.
 */
export function resolvePlane(ref: SketchPlane | PlaneRef, features: Feature[], where = 'plane'): CustomSketchPlane {
    if (typeof ref === 'string') {
        return NAMED[ref];
    }
    if ('planeRef' in ref) {
        const step = earlier(features, ref.planeRef, 'plane', where);
        if (step.op !== 'plane') {
            throw new Error(`${where}: "${ref.planeRef}" is not a plane`);
        }
        const plane = planeOfDefinition(step.definition, features.slice(0, features.indexOf(step)), where);
        return step.definition.flipNormal ? flipped(plane) : plane;
    }
    if ('fixedPlane' in ref) {
        return normalizePlane(checkedPlane(ref.fixedPlane, where));
    }
    return normalizePlane(checkedPlane(ref, where));
}

/** The same plane facing the other way: the normal turned around, u kept (so v turns too). */
const flipped = (p: CustomSketchPlane): CustomSketchPlane => ({ ...p, normal: scale(p.normal, -1) });

/** The plane a definition makes, its references resolved against `before` (the steps before it). */
export function planeOfDefinition(d: PlaneDefinition, before: Feature[], where = 'plane'): CustomSketchPlane {
    switch (d.kind) {
        case 'offset': {
            const base = resolvePlane(d.base, before, where);
            return { ...base, origin: add(base.origin, scale(base.normal, d.distance)) };
        }
        case 'angle': {
            let base = resolvePlane(d.base, before, where);
            const axis = d.about === 'u' || d.about === 'v'
                ? { point: base.origin, direction: d.about === 'u' ? base.xDir : cross(base.normal, base.xDir) }
                : resolveAxis(d.about, before, where);
            const dir = unit(axis.direction, 'rotation axis');
            if (d.throughAxis) {
                if (Math.abs(dot(dir, base.normal)) > 1e-6) {
                    throw new Error(`${where}: the axis must lie in the plane or be parallel to it`);
                }
                // Moved along its normal until the axis lies in it, its origin kept closest to where it was.
                base = { ...base, origin: add(base.origin, scale(base.normal, dot(sub(axis.point, base.origin), base.normal))) };
            }
            const origin = add(axis.point, rotate(sub(base.origin, axis.point), dir, d.angle));
            return normalizePlane({ origin, normal: rotate(base.normal, dir, d.angle), xDir: rotate(base.xDir, dir, d.angle) });
        }
        case 'threePoints': {
            const [a, b, c] = d.points.map((p) => resolvePoint(p, before, where));
            const normal = cross(sub(b, a), sub(c, a));
            if (!(length(normal) > 1e-9)) {
                throw new Error(`${where}: the three points lie on one line`);
            }
            return normalizePlane({ origin: a, normal, xDir: sub(b, a) });
        }
        case 'pointNormal': {
            const normal = unit(d.normal, `${where}: normal`);
            return normalizePlane({ origin: resolvePoint(d.point, before, where), normal, xDir: d.xDir ?? defaultXDir(normal) });
        }
        case 'parallel': {
            const base = resolvePlane(d.base, before, where);
            return { ...base, origin: resolvePoint(d.point, before, where) };
        }
        case 'normal': {
            const axis = resolveAxis(d.axis, before, where);
            const origin = d.point === undefined ? axis.point : resolvePoint(d.point, before, where);
            return normalizePlane({ origin, normal: axis.direction, xDir: defaultXDir(axis.direction) });
        }
        case 'midplane': {
            const a = resolvePlane(d.a, before, where);
            const b = resolvePlane(d.b, before, where);
            if (Math.abs(dot(a.normal, b.normal)) < 0.999) {
                throw new Error(`${where}: a midplane needs two parallel planes`);
            }
            const gap = dot(sub(b.origin, a.origin), a.normal);
            return { ...a, origin: add(a.origin, scale(a.normal, gap / 2)) };
        }
        case 'perpendicular': {
            const base = resolvePlane(d.base, before, where);
            const axis = resolveAxis(d.axis, before, where);
            const normal = cross(axis.direction, base.normal);
            if (!(length(normal) > 1e-9)) {
                throw new Error(`${where}: the axis is normal to the plane, so no single plane through it is perpendicular to it`);
            }
            return normalizePlane({ origin: axis.point, normal, xDir: axis.direction });
        }
        case 'linePoint': {
            const axis = resolveAxis(d.axis, before, where);
            const point = resolvePoint(d.point, before, where);
            const normal = cross(axis.direction, sub(point, axis.point));
            if (!(length(normal) > 1e-9 * Math.max(1, length(sub(point, axis.point))))) {
                throw new Error(`${where}: the point lies on the axis`);
            }
            return normalizePlane({ origin: axis.point, normal, xDir: axis.direction });
        }
        case 'tangent':
            return tangentPlane(d, before, where);
        case 'curveNormal':
            return curveNormalPlane(d, before, where, resolvePoint);
    }
}

/** A plane tangent to a cylinder, through a point or parallel (or at an angle) to a plane; see PlaneDefinition. */
function tangentPlane(d: Extract<PlaneDefinition, { kind: 'tangent' }>, before: Feature[], where: string): CustomSketchPlane {
    const axisDir = unit(d.cylinder.direction, `${where}: cylinder axis`);
    const centre = d.cylinder.point;
    const r = d.cylinder.radius;
    if (!(r > 0)) {
        throw new Error(`${where}: the cylinder radius must be greater than 0`);
    }
    // The radial direction of the tangent line, then the plane touches the cylinder there and contains the axis direction.
    const touch = (radial: Vec3, along: Vec3): CustomSketchPlane =>
        normalizePlane({ origin: add(add(centre, scale(radial, r)), along), normal: radial, xDir: axisDir });
    if (d.point !== undefined) {
        const p = resolvePoint(d.point, before, where);
        const rel = sub(p, centre);
        const along = scale(axisDir, dot(rel, axisDir));
        const w = sub(rel, along);
        const dist = length(w);
        const tol = 1e-6 * Math.max(1, r);
        if (dist < r - tol) {
            throw new Error(`${where}: the point is inside the cylinder, so no tangent plane passes through it`);
        }
        const out = scale(w, 1 / dist);
        if (dist <= r + tol) {
            return touch(out, along);
        }
        // The two tangent lines from the point: their radial directions are `out` turned by ±acos(r / dist).
        const turn = (Math.acos(r / dist) * 180) / Math.PI;
        return touch(rotate(out, axisDir, d.flip ? -turn : turn), along);
    }
    if (d.plane !== undefined) {
        const plane = resolvePlane(d.plane, before, where);
        if (Math.abs(dot(plane.normal, axisDir)) > 1e-6) {
            throw new Error(`${where}: the plane must be parallel to the cylinder's axis`);
        }
        const n = rotate(plane.normal, axisDir, d.angle ?? 0);
        return touch(d.flip ? scale(n, -1) : n, scale(axisDir, dot(sub(plane.origin, centre), axisDir)));
    }
    throw new Error(`${where}: a tangent plane needs a point or a plane`);
}

/** A plane given directly must say what it means: no zero vectors, and a u axis that is not along the normal. */
function checkedPlane(plane: CustomSketchPlane, where: string): CustomSketchPlane {
    const normal = unit(plane.normal, `${where}: normal`);
    unit(plane.xDir, `${where}: xDir`);
    if (!(length(cross(normal, plane.xDir)) > 1e-9 * length(plane.xDir))) {
        throw new Error(`${where}: xDir must not be parallel to the normal`);
    }
    return plane;
}

/** Resolves an axis reference to a point and unit direction in the part frame. */
export function resolveAxis(ref: AxisRef, features: Feature[], where = 'axis'): Axis {
    if (typeof ref === 'string') {
        const direction: Vec3 = ref === 'x' ? [1, 0, 0] : ref === 'y' ? [0, 1, 0] : [0, 0, 1];
        return { point: [0, 0, 0], direction };
    }
    if ('fixedAxis' in ref) {
        return { point: ref.fixedAxis.point, direction: unit(ref.fixedAxis.direction, `${where}: direction`) };
    }
    const step = earlier(features, ref.axisRef, 'axis', where);
    if (step.op !== 'axis') {
        throw new Error(`${where}: "${ref.axisRef}" is not an axis`);
    }
    const before = features.slice(0, features.indexOf(step));
    const d = step.definition;
    switch (d.kind) {
        case 'twoPoints': {
            const a = resolvePoint(d.a, before, where);
            return { point: a, direction: unit(sub(resolvePoint(d.b, before, where), a), `${where}: the two points`) };
        }
        case 'pointDirection':
            return { point: resolvePoint(d.point, before, where), direction: unit(d.direction, `${where}: direction`) };
        case 'sketchLine': {
            const step = earlier(before, d.sketchRef, 'sketch', where);
            if (step.op !== 'sketch') {
                throw new Error(`${where}: "${d.sketchRef}" is not a sketch`);
            }
            const line = sketchLine(step.sketch, d.line, where);
            const frame = sketchFrameOf(step.sketch, before.slice(0, before.indexOf(step)));
            const a = onFrame(frame, line.a);
            return { point: a, direction: unit(sub(onFrame(frame, line.b), a), `${where}: the sketch line`) };
        }
        case 'pointPlane':
            return { point: resolvePoint(d.point, before, where), direction: resolvePlane(d.plane, before, where).normal };
        case 'along':
            return resolveAxis(d.axis, before, where);
        case 'planeIntersection': {
            const a = resolvePlane(d.a, before, where);
            const b = resolvePlane(d.b, before, where);
            const direction = cross(a.normal, b.normal);
            if (!(length(direction) > 1e-9)) {
                throw new Error(`${where}: the two planes are parallel and do not intersect`);
            }
            // The point on the line closest to the origin satisfies both plane equations.
            const da = dot(a.normal, a.origin);
            const db = dot(b.normal, b.origin);
            const n = dot(direction, direction);
            const point = scale(add(scale(cross(b.normal, direction), da), scale(cross(direction, a.normal), db)), 1 / n);
            return { point, direction: unit(direction, 'axis') };
        }
    }
}

/**
 * Resolves a point reference: coordinates as they are, a point taken from the model where it was last found (the
 * kernel finds it again before this runs), or the position of an earlier point step.
 */
export function resolvePoint(ref: PointRef, features: Feature[], where = 'point'): Vec3 {
    if (Array.isArray(ref)) {
        return ref;
    }
    if ('fixedPoint' in ref) {
        return ref.fixedPoint;
    }
    if ('curveRef' in ref) {
        return curvePoint(ref, features, where);
    }
    const step = earlier(features, ref.pointRef, 'point', where);
    if (step.op !== 'point') {
        throw new Error(`${where}: "${ref.pointRef}" is not a point`);
    }
    // A point made on a curve goes where the curve is now (its position is only where it was last worked out).
    if (step.definition && isCurvePointDefinition(step.definition)) {
        return curvePointOfDefinition(step.definition, features.slice(0, features.indexOf(step)), where);
    }
    return step.position;
}

/** A sketch plane in the part frame: origin (offset applied), u, v and normal. */
export interface SketchFrame {
    origin: Vec3;
    u: Vec3;
    v: Vec3;
    normal: Vec3;
}

/** The frame of a sketch, its plane resolved against `features` (the steps before it). */
export function sketchFrameOf(sketch: Pick<Sketch, 'plane' | 'offset'>, features: Feature[]): SketchFrame {
    const plane = resolvePlane(sketch.plane, features, 'sketch plane');
    return {
        origin: add(plane.origin, scale(plane.normal, sketch.offset ?? 0)),
        u: plane.xDir,
        v: cross(plane.normal, plane.xDir),
        normal: plane.normal,
    };
}

const onFrame = (f: SketchFrame, [a, b]: [number, number]): Vec3 => add(f.origin, add(scale(f.u, a), scale(f.v, b)));

/** The two end points (u, v) of a line or centreline of a sketch, by curve id. */
export function sketchLine(sketch: Pick<Sketch, 'geometry'>, id: string, where = 'line'): { a: [number, number]; b: [number, number] } {
    const curve = sketch.geometry?.curves.find((c) => c.id === id);
    if (!curve || curve.kind !== 'line') {
        throw new Error(`${where}: the sketch has no line "${id}"`);
    }
    const point = (pid: string): [number, number] => {
        if (pid === 'origin') {
            return [0, 0];
        }
        const p = sketch.geometry!.points.find((q) => q.id === pid);
        if (!p) {
            throw new Error(`${where}: line "${id}" has a missing point`);
        }
        return [p.u, p.v];
    };
    const a = point(curve.a);
    const b = point(curve.b);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) {
        throw new Error(`${where}: line "${id}" has no length`);
    }
    return { a, b };
}

/** A revolve axis in the part frame and, when it lies in the sketch plane, as a line in sketch (u, v). */
export interface RevolveAxisFrame extends Axis {
    inPlane: { point: [number, number]; direction: [number, number] } | null;
}

/**
 * Resolves what a revolve turns about. `sketch` is the revolve's sketch, its plane resolved against `features`
 * (the steps before the revolve); axis steps resolve against `features` too.
 */
export function resolveRevolveAxis(
    axis: RevolveAxis, sketch: Pick<Sketch, 'plane' | 'offset' | 'geometry'>, features: Feature[],
): RevolveAxisFrame {
    const frame = sketchFrameOf(sketch, features);
    if (axis === 'u' || axis === 'v') {
        return {
            point: frame.origin, direction: axis === 'u' ? frame.u : frame.v,
            inPlane: { point: [0, 0], direction: axis === 'u' ? [1, 0] : [0, 1] },
        };
    }
    if (typeof axis === 'object' && 'line' in axis) {
        const { a, b } = sketchLine(sketch, axis.line, 'revolve axis');
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const point = onFrame(frame, a);
        return {
            point, direction: unit(sub(onFrame(frame, b), point), 'revolve axis'),
            inPlane: { point: a, direction: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] },
        };
    }
    const resolved = resolveAxis(axis, features, 'revolve axis');
    const across = dot(resolved.direction, frame.normal);
    if (Math.abs(Math.abs(across) - 1) < 1e-9) {
        throw new Error('revolve axis: the axis is perpendicular to the sketch plane');
    }
    const rel = sub(resolved.point, frame.origin);
    const du = dot(resolved.direction, frame.u);
    const dv = dot(resolved.direction, frame.v);
    const l = Math.hypot(du, dv);
    // In the sketch plane when its direction and its point both are.
    const inPlane = Math.abs(across) < 1e-6 && Math.abs(dot(rel, frame.normal)) < 1e-6;
    return {
        ...resolved,
        inPlane: inPlane ? { point: [dot(rel, frame.u), dot(rel, frame.v)], direction: [du / l, dv / l] } : null,
    };
}

/** The curve ids of a sketch's centrelines (construction lines), the default revolve axis when there is one. */
export function sketchCentrelines(sketch: Pick<Sketch, 'geometry'>): string[] {
    return (sketch.geometry?.curves ?? []).filter((c) => c.kind === 'line' && c.construction).map((c) => c.id);
}

// ---- References taken from the model ------------------------------------------------------------------------------
// The kernel finds each picked face, edge or vertex again on the body at every rebuild (apps/server/src/cad/followRefs.ts)
// and writes where it found it into the cached values (fixedPlane, fixedAxis, fixedPoint, a cylinder's axis and radius,
// an edge's shape, a point step's position); the view shows those (apps/web/src/followedRefs.ts).

/** Where two lines (a point and a unit direction each) meet; throws when they are parallel or pass each other. */
export function linesMeet(a: Vec3, da: Vec3, b: Vec3, db: Vec3): Vec3 {
    const n = cross(da, db);
    const nn = dot(n, n);
    if (!(nn > 1e-18)) {
        throw new Error('The two edges are parallel: they do not meet.');
    }
    const w = sub(b, a);
    const pa = add(a, scale(da, dot(cross(w, db), n) / nn));
    const pb = add(b, scale(db, dot(cross(w, da), n) / nn));
    const size = Math.max(1, length(a), length(b));
    if (length(sub(pa, pb)) > Math.max(1e-4, 1e-6 * size)) {
        throw new Error('The two edges do not meet (not even extended).');
    }
    return scale(add(pa, pb), 0.5);
}

/**
 * `count` points along a straight or circular edge from its start (`reverse`: from its end), spaced by a distance or a
 * percentage of its length; the first is one spacing from the end, as in SolidWorks. `fmt` writes the length in errors.
 */
export function pointsAlong(shape: ModelEdgeShape, by: 'distance' | 'percent', amount: number, count: number, reverse = false,
    fmt: (mm: number) => string = String): Vec3[] {
    let total: number;
    let at: (s: number) => Vec3;
    if (shape.type === 'line') {
        total = length(sub(shape.b, shape.a));
        const [from, to] = reverse ? [shape.b, shape.a] : [shape.a, shape.b];
        const d = unit(sub(to, from), 'edge');
        at = (s) => add(from, scale(d, s));
    } else {
        if (!(shape.radius > 0)) {
            throw new Error('Pick a straight or circular edge.');
        }
        const n = unit(shape.normal, 'circle normal');
        const r0 = sub(shape.start, shape.centre);
        const r1 = sub(shape.end, shape.centre);
        // Counter-clockwise about the normal from start to end (the direction the edge runs).
        let sweep = shape.full ? 2 * Math.PI : Math.atan2(dot(cross(r0, r1), n), dot(r0, r1));
        if (sweep <= 0) {
            sweep += 2 * Math.PI;
        }
        total = shape.radius * sweep;
        const deg = (s: number): number => ((s / shape.radius) * 180) / Math.PI;
        at = (s) => (reverse ? add(shape.centre, rotate(r1, n, -deg(s))) : add(shape.centre, rotate(r0, n, deg(s))));
    }
    const spacing = by === 'percent' ? (total * amount) / 100 : amount;
    if (spacing * count > total * (1 + 1e-9)) {
        throw new Error(`The points run past the end of the edge (it is ${fmt(total)} mm long): use a smaller value or fewer points.`);
    }
    return Array.from({ length: count }, (_, i) => at(spacing * (i + 1)));
}

/**
 * A point step's position from its definition's cached values (the edges' shapes as last found); faces and vertices
 * keep none of their own, so `position` (where the step was last found) stands for them.
 */
export function pointOfDefinition(d: PointDefinition, position: Vec3): Vec3 {
    switch (d.kind) {
        case 'arcCentre':
            return d.edge.shape?.type === 'circle' ? d.edge.shape.centre : position;
        case 'intersection': {
            const [a, b] = [d.a.shape, d.b.shape];
            if (a?.type !== 'line' || b?.type !== 'line') {
                return position;
            }
            return linesMeet(a.a, unit(sub(a.b, a.a), 'edge'), b.a, unit(sub(b.b, b.a), 'edge'));
        }
        case 'along':
            return d.edge.shape ? pointsAlong(d.edge.shape, d.by, d.amount, d.index, d.reverse)[d.index - 1] : position;
        default:
            return position;
    }
}

/** Keys of an object that only say where a picked reference was last found. */
function cacheKeys(o: Record<string, unknown>): string[] {
    if (o.pick && typeof o.pick === 'object') {
        return ['fixedPlane', 'fixedAxis', 'fixedPoint', ...('radius' in o ? ['point', 'direction', 'radius'] : [])];
    }
    // A plane tangent where a followed cylinder was clicked: the spot goes with the cylinder.
    const cylinder = o.cylinder as { pick?: unknown } | undefined;
    if (o.kind === 'tangent' && cylinder?.pick && Array.isArray(o.point) && o.plane === undefined) {
        return ['point'];
    }
    return Array.isArray(o.edge) ? ['shape'] : [];
}

/** A copy of a step (or any part of one) without the values that only say where its model references were last found. */
export function withoutFollowCaches<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map(withoutFollowCaches) as T;
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const o = value as Record<string, unknown>;
    const drop = new Set(cacheKeys(o));
    if (o.op === 'point' && o.definition) {
        drop.add('position');
    }
    return Object.fromEntries(Object.entries(o).filter(([k]) => !drop.has(k)).map(([k, v]) => [k, withoutFollowCaches(v)])) as T;
}

/** Whether a step holds references taken from the model that follow it (picks the kernel finds again). */
export function followsModel(f: Feature): boolean {
    if (f.op === 'point') {
        return !!f.definition;
    }
    if (f.op !== 'plane' && f.op !== 'axis') {
        return false;
    }
    const scan = (v: unknown): boolean => (Array.isArray(v) ? v.some(scan)
        : !!v && typeof v === 'object' && ('pick' in v || Object.values(v).some(scan)));
    return scan(f.definition);
}
