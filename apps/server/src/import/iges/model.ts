// An IGES file's entities with typed access to their parameters, transformation matrices (124) composed along
// their chains, colours (314 and the standard colour numbers) and names (406 form 15, subfigure names).

import { cross, norm, type V3 } from '../sldprt/nurbs.js';
import type { IgesEntity, IgesFile, Param } from './parse.js';

/** An affine map p -> R p + t (R row-major 3 x 3). IGES transformations are rotations or reflections, possibly scaled. */
export interface Xf {
    r: number[];
    t: V3;
}

export const IDENTITY: Xf = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export const scaling = (s: number): Xf => ({ r: [s, 0, 0, 0, s, 0, 0, 0, s], t: [0, 0, 0] });

export function apply(x: Xf, p: V3): V3 {
    const r = x.r;
    return [r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + x.t[0], r[3] * p[0] + r[4] * p[1] + r[5] * p[2] + x.t[1], r[6] * p[0] + r[7] * p[1] + r[8] * p[2] + x.t[2]];
}

/** A direction through the linear part (not normalised). */
export function applyVector(x: Xf, v: V3): V3 {
    const r = x.r;
    return [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
}

/** a after b: p -> a(b(p)). */
export function compose(a: Xf, b: Xf): Xf {
    const A = a.r;
    const B = b.r;
    const r: number[] = [];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            r.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]);
        }
    }
    return { r, t: apply(a, b.t) };
}

export const determinant = (x: Xf): number => {
    const r = x.r;
    return r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
};

/** The uniform scale of a similarity transformation. */
export const scaleOf = (x: Xf): number => Math.cbrt(Math.abs(determinant(x)));

/** The images of the x and y axes, and the normal they span (right-handed even under a reflection). */
export function frame(x: Xf): { x: V3; y: V3; n: V3 } {
    const ax = applyVector(x, [1, 0, 0]);
    const ay = applyVector(x, [0, 1, 0]);
    const nx = norm(ax);
    const ny = norm(ay);
    const ux: V3 = [ax[0] / nx, ax[1] / nx, ax[2] / nx];
    const uy: V3 = [ay[0] / ny, ay[1] / ny, ay[2] / ny];
    return { x: ux, y: uy, n: cross(ux, uy) };
}

const STANDARD_COLOURS: Record<number, string> = {
    1: '#000000', 2: '#ff0000', 3: '#00ff00', 4: '#0000ff', 5: '#ffff00', 6: '#ff00ff', 7: '#00ffff', 8: '#ffffff',
};

export class IgesModel {
    /** Millimetres per model unit (the unit and the model space scale). */
    readonly unitMm: number;
    /** Model units to mm: the parent of every top-level entity. */
    readonly root: Xf;
    private readonly xfCache = new Map<number, Xf>();

    constructor(readonly file: IgesFile) {
        this.unitMm = file.global.unitMm / file.global.scale;
        this.root = scaling(this.unitMm);
    }

    entity(de: number | null | undefined): IgesEntity | undefined {
        return typeof de === 'number' && de > 0 ? this.file.entities.get(de) : undefined;
    }

    need(de: Param, what: string): IgesEntity {
        const e = typeof de === 'number' ? this.entity(Math.abs(de)) : undefined;
        if (!e) {
            throw new IgesGeometryError(`${what} is missing`);
        }
        return e;
    }

    /** The entity's own transformation, composed along its chain of 124 entities (identity when there is none). */
    ownXf(e: IgesEntity): Xf {
        if (!e.xform) {
            return IDENTITY;
        }
        const cached = this.xfCache.get(e.de);
        if (cached) {
            return cached;
        }
        let x = IDENTITY;
        const seen = new Set<number>();
        for (let m = this.entity(e.xform); m && m.type === 124 && !seen.has(m.de); m = this.entity(m.xform)) {
            seen.add(m.de);
            const p = m.params.map((v) => (typeof v === 'number' ? v : 0));
            const local: Xf = { r: [p[0], p[1], p[2], p[4], p[5], p[6], p[8], p[9], p[10]], t: [p[3], p[7], p[11]] };
            // The matrix of a matrix applies after it.
            x = compose(local, x);
        }
        this.xfCache.set(e.de, x);
        return x;
    }

    /** The transformation from an entity's space to its parent's (`parent` already maps the parent to mm). */
    xf(e: IgesEntity, parent: Xf): Xf {
        return e.xform ? compose(parent, this.ownXf(e)) : parent;
    }

    colourOf(e: IgesEntity | undefined): string | undefined {
        if (!e || e.color === 0) {
            return undefined;
        }
        if (e.color > 0) {
            return STANDARD_COLOURS[e.color];
        }
        const c = this.entity(-e.color);
        if (!c || c.type !== 314) {
            return undefined;
        }
        const pct = [0, 1, 2].map((k) => (typeof c.params[k] === 'number' ? c.params[k] as number : 0));
        return `#${pct.map((v) => Math.round(Math.min(100, Math.max(0, v)) * 2.55).toString(16).padStart(2, '0')).join('')}`;
    }

    /**
     * The property pointers after an entity's own `count` parameters (associativities, then properties), and a
     * Name property (406 form 15) among them.
     */
    nameOf(e: IgesEntity, count: number): string | undefined {
        const p = e.params;
        const nv = typeof p[count] === 'number' ? p[count] as number : 0;
        const at = count + 1 + nv;
        const np = typeof p[at] === 'number' ? p[at] as number : 0;
        for (let k = 1; k <= np; k++) {
            const prop = this.entity(p[at + k] as number);
            if (prop?.type === 406 && prop.form === 15 && typeof prop.params[1] === 'string' && prop.params[1].trim()) {
                return prop.params[1].trim();
            }
        }
        return undefined;
    }
}

/** Geometry the reader cannot build: the face or body is left out with this reason. */
export class IgesGeometryError extends Error {}

// ---- Parameter access --------------------------------------------------------------------------------------

export function num(e: IgesEntity, i: number, fallback = 0): number {
    const v = e.params[i];
    return typeof v === 'number' ? v : fallback;
}

export const int = (e: IgesEntity, i: number, fallback = 0): number => Math.round(num(e, i, fallback));

export function str(e: IgesEntity, i: number): string {
    const v = e.params[i];
    return typeof v === 'string' ? v.trim() : '';
}

export const point = (e: IgesEntity, i: number): V3 => [num(e, i), num(e, i + 1), num(e, i + 2)];
