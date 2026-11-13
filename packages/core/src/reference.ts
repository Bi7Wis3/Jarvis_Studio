// Construction planes and axes: resolves plane and axis references against a part's history, in the part frame.
// Shared by the CAD kernel (building) and the sketcher (drawing), so both see exactly the same planes.

import type { AxisRef, CustomSketchPlane, Feature, PlaneRef, SketchPlane, Vec3 } from './index';

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

function earlier(features: Feature[], id: string, op: 'plane' | 'axis', where: string): Feature {
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
        const before = features.slice(0, features.indexOf(step));
        const d = step.definition;
        switch (d.kind) {
            case 'offset': {
                const base = resolvePlane(d.base, before, where);
                return { ...base, origin: add(base.origin, scale(base.normal, d.distance)) };
            }
            case 'angle': {
                const base = resolvePlane(d.base, before, where);
                const axis = d.about === 'u' || d.about === 'v'
                    ? { point: base.origin, direction: d.about === 'u' ? base.xDir : cross(base.normal, base.xDir) }
                    : resolveAxis(d.about, before, where);
                const dir = unit(axis.direction, 'rotation axis');
                const origin = add(axis.point, rotate(sub(base.origin, axis.point), dir, d.angle));
                return normalizePlane({ origin, normal: rotate(base.normal, dir, d.angle), xDir: rotate(base.xDir, dir, d.angle) });
            }
            case 'threePoints': {
                const [a, b, c] = d.points;
                const normal = cross(sub(b, a), sub(c, a));
                if (!(length(normal) > 1e-9)) {
                    throw new Error(`${where}: the three points lie on one line`);
                }
                return normalizePlane({ origin: a, normal, xDir: sub(b, a) });
            }
            case 'pointNormal': {
                const normal = unit(d.normal, `${where}: normal`);
                return normalizePlane({ origin: d.point, normal, xDir: d.xDir ?? defaultXDir(normal) });
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
        }
    }
    return normalizePlane(checkedPlane(ref, where));
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
    const step = earlier(features, ref.axisRef, 'axis', where);
    if (step.op !== 'axis') {
        throw new Error(`${where}: "${ref.axisRef}" is not an axis`);
    }
    const before = features.slice(0, features.indexOf(step));
    const d = step.definition;
    switch (d.kind) {
        case 'twoPoints':
            return { point: d.a, direction: unit(sub(d.b, d.a), `${where}: the two points`) };
        case 'pointDirection':
            return { point: d.point, direction: unit(d.direction, `${where}: direction`) };
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
