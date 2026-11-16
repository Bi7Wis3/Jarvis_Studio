// Vectors and SolidWorks transforms for the history import. SolidWorks lengths are metres; the studio's are mm.
//
// MathTransform.ArrayData holds a 3x3 rotation (a..i), a translation (j, k, l) and a scale. SolidWorks multiplies row
// vectors (p' = p R s + T), so a..c is where the x axis goes. The files carry the three standard planes, whose
// orientation is known, so the importer checks this against them (conventionFromPlanes) instead of trusting it.

import type { Vec3 } from '@jarvis/core';

export const MM = 1000;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => {
    const l = norm(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const mm = (p: readonly number[] | null | undefined): Vec3 => [(p?.[0] ?? 0) * MM, (p?.[1] ?? 0) * MM, (p?.[2] ?? 0) * MM];
export const v3 = (p: readonly number[] | null | undefined): Vec3 => [p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0];
export const deg = (rad: number): number => (rad * 180) / Math.PI;

/** A rigid transform for column vectors: p' = r p + t (r row-major), t in mm. */
export interface Rigid {
    r: [Vec3, Vec3, Vec3];
    t: Vec3;
}

/** How ArrayData is laid out: rows (SolidWorks' documented row-vector form) or columns. */
export type Convention = 'rows' | 'columns';

/** ArrayData as a rigid transform in mm (the scale folded into the rotation). */
export function rigidOf(data: readonly number[] | null | undefined, convention: Convention = 'rows'): Rigid | null {
    if (!data || data.length < 12 || data.slice(0, 12).some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
        return null;
    }
    const s = typeof data[12] === 'number' && Number.isFinite(data[12]) && data[12] !== 0 ? data[12] : 1;
    const [a, b, c, d, e, f, g, h, i] = data;
    const r: [Vec3, Vec3, Vec3] = convention === 'rows'
        ? [[a * s, d * s, g * s], [b * s, e * s, h * s], [c * s, f * s, i * s]]
        : [[a * s, b * s, c * s], [d * s, e * s, f * s], [g * s, h * s, i * s]];
    return { r, t: [data[9] * MM, data[10] * MM, data[11] * MM] };
}

export const applyRot = (x: Rigid, v: Vec3): Vec3 => [dot(x.r[0], v), dot(x.r[1], v), dot(x.r[2], v)];
export const apply = (x: Rigid, p: Vec3): Vec3 => add(applyRot(x, p), x.t);

/** The inverse of a rigid transform (rotation inverted in general, so a scale is undone too). */
export function invert(x: Rigid): Rigid {
    const [[a, b, c], [d, e, f], [g, h, i]] = x.r;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    const k = det !== 0 ? 1 / det : 0;
    const r: [Vec3, Vec3, Vec3] = [
        [(e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k],
        [(f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k],
        [(d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k],
    ];
    const t = scale([dot(r[0], x.t), dot(r[1], x.t), dot(r[2], x.t)], -1);
    return { r, t };
}

/** Where a transform takes the x, y and z axes, and the origin. */
export function frameOf(x: Rigid): { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 } {
    return {
        origin: x.t,
        x: [x.r[0][0], x.r[1][0], x.r[2][0]],
        y: [x.r[0][1], x.r[1][1], x.r[2][1]],
        z: [x.r[0][2], x.r[1][2], x.r[2][2]],
    };
}

export const near = (a: Vec3, b: Vec3, tol = 1e-6): boolean => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol && Math.abs(a[2] - b[2]) < tol;

/**
 * The ArrayData layout, from the part's first three reference planes (Front, Top, Right in every SolidWorks part):
 * read as rows, Top's z axis is +Y and Right's is +X. Null when the planes do not tell.
 */
export function conventionFromPlanes(planes: (readonly number[] | null | undefined)[]): Convention | null {
    let rows = 0;
    let columns = 0;
    const expected: Vec3[] = [[0, 0, 1], [0, 1, 0], [1, 0, 0]];
    planes.slice(0, 3).forEach((data, i) => {
        const asRows = rigidOf(data, 'rows');
        const asColumns = rigidOf(data, 'columns');
        if (!asRows || !asColumns) {
            return;
        }
        const zr = unit(frameOf(asRows).z);
        const zc = unit(frameOf(asColumns).z);
        if (near(zr, expected[i], 1e-6) && !near(zc, expected[i], 1e-6)) rows++;
        if (near(zc, expected[i], 1e-6) && !near(zr, expected[i], 1e-6)) columns++;
    });
    return rows > columns ? 'rows' : columns > rows ? 'columns' : null;
}

/** Rounds away float noise (1e-12 mm) so values typed by the user in SolidWorks come back as typed. */
export function clean(x: number): number {
    const r = Math.round(x * 1e9) / 1e9;
    return Math.abs(r - x) < 1e-9 ? r : x;
}

export const cleanV = (v: Vec3): Vec3 => [clean(v[0]), clean(v[1]), clean(v[2])];
