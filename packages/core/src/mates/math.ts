// Rigid placements for the mate solver: vectors, rotation matrices, Euler XYZ angles as Part.rotation stores them
// (three.js order: R = Rx Ry Rz, degrees), rotation vectors, and the transforms of a pattern's copies (Part.repeat).

import type { Repeat, Vec3 } from '../index';
import type { Placement } from './types';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** A rigid transform: x -> R x + t (R row-major). */
export interface Rigid {
    R: Mat3;
    t: Vec3;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const unit = (a: Vec3): Vec3 => {
    const l = len(a);
    return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};
export const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMat(a: Mat3, b: Mat3): Mat3 {
    const out = new Array(9) as Mat3;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
        }
    }
    return out;
}

export const mulVec = (m: Mat3, v: Vec3): Vec3 => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Rotation about a unit axis by an angle in radians (Rodrigues). */
export function axisAngle(axis: Vec3, angle: number): Mat3 {
    const [x, y, z] = axis;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const k = 1 - c;
    return [
        c + x * x * k, x * y * k - z * s, x * z * k + y * s,
        y * x * k + z * s, c + y * y * k, y * z * k - x * s,
        z * x * k - y * s, z * y * k + x * s, c + z * z * k,
    ];
}

/** The rotation of a rotation vector (axis times angle in radians). */
export function expRot(w: Vec3): Mat3 {
    const angle = len(w);
    if (angle < 1e-15) {
        // First order: I + [w]x.
        return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
    }
    return axisAngle(scale(w, 1 / angle), angle);
}

/** The rotation vector of a rotation matrix (inverse of expRot). */
export function logRot(m: Mat3): Vec3 {
    const cos = Math.min(1, Math.max(-1, (m[0] + m[4] + m[8] - 1) / 2));
    const angle = Math.acos(cos);
    const v: Vec3 = [m[7] - m[5], m[2] - m[6], m[3] - m[1]];
    if (angle < 1e-7) {
        return scale(v, 0.5);
    }
    if (Math.PI - angle < 1e-6) {
        // Near a half turn the antisymmetric part vanishes: take the axis from the symmetric part.
        const xx = Math.sqrt(Math.max(0, (m[0] + 1) / 2));
        const yy = Math.sqrt(Math.max(0, (m[4] + 1) / 2));
        const zz = Math.sqrt(Math.max(0, (m[8] + 1) / 2));
        let axis: Vec3;
        if (xx >= yy && xx >= zz) {
            axis = [xx, (m[1] + m[3]) / (4 * xx), (m[2] + m[6]) / (4 * xx)];
        } else if (yy >= zz) {
            axis = [(m[1] + m[3]) / (4 * yy), yy, (m[5] + m[7]) / (4 * yy)];
        } else {
            axis = [(m[2] + m[6]) / (4 * zz), (m[5] + m[7]) / (4 * zz), zz];
        }
        return scale(unit(axis), angle);
    }
    return scale(v, angle / (2 * Math.sin(angle)));
}

const DEG = Math.PI / 180;

/** The rotation of Euler XYZ angles in degrees, as three.js and Part.rotation use them: R = Rx(a) Ry(b) Rz(c). */
export function eulerToMat(rotation: Vec3): Mat3 {
    const [a, b, c] = rotation.map((d) => d * DEG);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const cb = Math.cos(b);
    const sb = Math.sin(b);
    const cc = Math.cos(c);
    const sc = Math.sin(c);
    return [
        cb * cc, -cb * sc, sb,
        ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb,
        sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb,
    ];
}

/** Values this close to a whole number of their unit are that number (float noise left by the solver). */
const SNAP = 1e-9;
const tidy = (v: number): number => {
    const r = Math.round(v);
    return Math.abs(v - r) < SNAP ? r + 0 : v + 0;
};

/** Euler XYZ degrees of a rotation (three.js setFromRotationMatrix, order XYZ). */
export function matToEuler(m: Mat3): Vec3 {
    const b = Math.asin(Math.min(1, Math.max(-1, m[2])));
    let a: number;
    let c: number;
    if (Math.abs(m[2]) < 0.9999999) {
        a = Math.atan2(-m[5], m[8]);
        c = Math.atan2(-m[1], m[0]);
    } else {
        a = Math.atan2(m[7], m[4]);
        c = 0;
    }
    return [a, b, c].map((r) => tidy(r / DEG)) as Vec3;
}

export function rigidOf(p: Placement): Rigid {
    return { R: eulerToMat(p.rotation), t: [...p.position] as Vec3 };
}

export function placementOf(r: Rigid): Placement {
    return { position: r.t.map((v) => tidy(v)) as Vec3, rotation: matToEuler(r.R) };
}

export const applyPoint = (r: Rigid, p: Vec3): Vec3 => add(mulVec(r.R, p), r.t);
export const applyDir = (r: Rigid, d: Vec3): Vec3 => mulVec(r.R, d);

/** a after b: x -> a(b(x)). */
export const compose = (a: Rigid, b: Rigid): Rigid => ({ R: mulMat(a.R, b.R), t: add(mulVec(a.R, b.t), a.t) });

export function invert(r: Rigid): Rigid {
    const Rt = transpose(r.R);
    return { R: Rt, t: neg(mulVec(Rt, r.t)) };
}

export const IDENTITY_RIGID: Rigid = { R: IDENTITY, t: [0, 0, 0] };

/**
 * The world transform of copy `k` of a patterned part, applied after its own placement (as instanceTransforms in
 * geometry.ts): linear steps, or turns about the vertical axis through `centre` [x, z].
 */
export function copyTransform(repeat: Repeat | undefined, k: number): Rigid {
    if (!repeat || repeat.count < 2 || !k) {
        return IDENTITY_RIGID;
    }
    if (repeat.kind === 'linear') {
        return { R: IDENTITY, t: scale(repeat.step, k) };
    }
    const [cx, cz] = repeat.centre ?? [0, 0];
    const sweep = repeat.angle ?? 360;
    const divisions = sweep >= 360 ? repeat.count : repeat.count - 1;
    const R = axisAngle([0, 1, 0], ((sweep / divisions) * k) * DEG);
    const c: Vec3 = [cx, 0, cz];
    return { R, t: sub(c, mulVec(R, c)) };
}

/** A unit vector at right angles to `d`. */
export function across(d: Vec3): Vec3 {
    const seed: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return unit(cross(d, seed));
}
