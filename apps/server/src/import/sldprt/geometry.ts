// Parasolid curves and surfaces as evaluators in millimetres, with closest-point projection. These follow the
// parameterisations of the Parasolid XT Format Reference (Geometry); intersection curves and rolling-ball blends
// are rebuilt from them (see rebuild.ts).

import {
    add, addScaled, cross, dist, dot, norm, nurbsEval, nurbsRange, scale, sub, surfEval, surfRange, unit,
    type Nurbs, type NurbsSurf, type V3,
} from './nurbs.js';

export interface Curve {
    kind: string;
    /** Natural parameter range (infinite for lines). */
    range: [number, number];
    /** Period of a periodic curve, else 0. */
    period: number;
    eval(t: number): { p: V3; d: V3 };
    /** Parameter of the nearest point (a global search; `hint` is only a hint and may be ignored). */
    project(x: V3, hint?: number): number;
}

export interface Projection {
    p: V3;
    /** Unit natural normal at p (zero where undefined, e.g. on a zero-radius blend). */
    n: V3;
    uv: [number, number];
}

export interface Surface {
    kind: string;
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 };
    project(x: V3, hint?: [number, number]): Projection;
}

const TWO_PI = 2 * Math.PI;

export const wrapAngle = (t: number, from = 0): number => {
    let a = (t - from) % TWO_PI;
    if (a < 0) {
        a += TWO_PI;
    }
    return a + from;
};

// ---- Curves -------------------------------------------------------------------------------------------------

export class LineCurve implements Curve {
    kind = 'line';
    range: [number, number] = [-Infinity, Infinity];
    period = 0;
    constructor(readonly p0: V3, readonly dir: V3) {}
    eval(t: number): { p: V3; d: V3 } {
        return { p: addScaled(this.p0, this.dir, t), d: this.dir };
    }
    project(x: V3): number {
        return dot(sub(x, this.p0), this.dir);
    }
}

export class CircleCurve implements Curve {
    kind = 'circle';
    range: [number, number] = [0, TWO_PI];
    period = TWO_PI;
    readonly y: V3;
    constructor(readonly c: V3, readonly n: V3, readonly x: V3, readonly r: number) {
        this.y = cross(n, x);
    }
    eval(t: number): { p: V3; d: V3 } {
        const cs = Math.cos(t);
        const sn = Math.sin(t);
        return {
            p: add(this.c, add(scale(this.x, this.r * cs), scale(this.y, this.r * sn))),
            d: add(scale(this.x, -this.r * sn), scale(this.y, this.r * cs)),
        };
    }
    project(p: V3): number {
        const w = sub(p, this.c);
        return wrapAngle(Math.atan2(dot(w, this.y), dot(w, this.x)));
    }
}

export class EllipseCurve implements Curve {
    kind = 'ellipse';
    range: [number, number] = [0, TWO_PI];
    period = TWO_PI;
    readonly y: V3;
    constructor(readonly c: V3, readonly n: V3, readonly x: V3, readonly a: number, readonly b: number) {
        this.y = cross(n, x);
    }
    eval(t: number): { p: V3; d: V3 } {
        const cs = Math.cos(t);
        const sn = Math.sin(t);
        return {
            p: add(this.c, add(scale(this.x, this.a * cs), scale(this.y, this.b * sn))),
            d: add(scale(this.x, -this.a * sn), scale(this.y, this.b * cs)),
        };
    }
    project(p: V3): number {
        const w = sub(p, this.c);
        const t0 = Math.atan2(dot(w, this.y) / this.b, dot(w, this.x) / this.a);
        return wrapAngle(newtonCurve(this, p, t0));
    }
}

/** The nearest point of a curve to x found from t0 only (a local search, for points known to be near t0). */
export function projectNear(c: Curve, x: V3, t0: number, lo = -Infinity, hi = Infinity): number {
    return newtonCurve(c, x, t0, lo, hi);
}

/** Newton on (C(t) - x) . C'(t) = 0 with a numerical second derivative. */
function newtonCurve(c: Curve, x: V3, t0: number, lo = -Infinity, hi = Infinity): number {
    let t = t0;
    const span = Number.isFinite(hi - lo) ? hi - lo : 1;
    for (let i = 0; i < 40; i++) {
        const e = c.eval(t);
        const h = 1e-7 * Math.max(1, span);
        const e2 = c.eval(t + h);
        const f = dot(sub(e.p, x), e.d);
        const f2 = dot(sub(e2.p, x), e2.d);
        const df = (f2 - f) / h;
        if (!(Math.abs(df) > 1e-300)) {
            break;
        }
        let step = -f / df;
        const limit = 0.25 * span;
        if (Math.abs(step) > limit) {
            step = Math.sign(step) * limit;
        }
        const next = Math.min(hi, Math.max(lo, t + step));
        if (Math.abs(next - t) < 1e-14 * Math.max(1, Math.abs(t))) {
            t = next;
            break;
        }
        t = next;
    }
    return t;
}

/** Sample points of a curve, made once: the start for every projection onto it. */
interface Samples {
    t: Float64Array;
    p: V3[];
}

function sampleCurve(c: Curve, n: number): Samples {
    const [a, b] = c.range;
    const t = new Float64Array(n + 1);
    const p: V3[] = [];
    for (let i = 0; i <= n; i++) {
        t[i] = a + ((b - a) * i) / n;
        p.push(c.eval(t[i]).p);
    }
    return { t, p };
}

/**
 * Nearest sample of a curve, then Newton (allowed `extend` times the range past its ends). Always a global
 * search: a hint from an earlier point can sit in another valley of the distance and mislead Newton.
 */
function projectSampled(c: Curve, x: V3, samples: Samples, extend = 0): number {
    const [a, b] = c.range;
    let best = a;
    let bestD = Infinity;
    for (let i = 0; i < samples.p.length; i++) {
        const q = samples.p[i];
        const d = (q[0] - x[0]) ** 2 + (q[1] - x[1]) ** 2 + (q[2] - x[2]) ** 2;
        if (d < bestD) {
            bestD = d;
            best = samples.t[i];
        }
    }
    const lo = c.period ? -Infinity : a - extend * (b - a);
    const hi = c.period ? Infinity : b + extend * (b - a);
    let t = newtonCurve(c, x, best, lo, hi);
    if (c.period) {
        t = a + (((t - a) % c.period) + c.period) % c.period;
    }
    return t;
}

export class NurbsCurve implements Curve {
    kind = 'nurbs';
    range: [number, number];
    period: number;
    private samples: Samples | null = null;
    constructor(readonly nurbs: Nurbs, periodic: boolean) {
        this.range = nurbsRange(nurbs);
        // A closed curve is treated as periodic, so edges may run across its seam.
        const closed = dist(nurbsEval(nurbs, this.range[0]).p, nurbsEval(nurbs, this.range[1]).p) < 1e-7;
        this.period = periodic || closed ? this.range[1] - this.range[0] : 0;
    }
    private wrap(t: number): number {
        if (!this.period) {
            return t;
        }
        const [a] = this.range;
        return a + (((t - a) % this.period) + this.period) % this.period;
    }
    eval(t: number): { p: V3; d: V3 } {
        if (!this.period) {
            // Past an end, continue along the end tangent (as B-surfaces do).
            const [a, b] = this.range;
            if (t < a || t > b) {
                const e = nurbsEval(this.nurbs, t < a ? a : b);
                return { p: addScaled(e.p, e.d, t - (t < a ? a : b)), d: e.d };
            }
        }
        return nurbsEval(this.nurbs, this.wrap(t));
    }
    project(x: V3): number {
        this.samples ??= sampleCurve(this, Math.min(4000, Math.max(16, (this.nurbs.cw.length - this.nurbs.degree) * 8)));
        return projectSampled(this, x, this.samples);
    }
}

/** A 2D B-curve embedded in a surface's parameter space. */
export class SpCurve implements Curve {
    kind = 'sp';
    range: [number, number];
    period = 0;
    constructor(readonly surface: Surface, readonly uv: Nurbs) {
        this.range = nurbsRange(uv);
    }
    eval(t: number): { p: V3; d: V3 } {
        const c = nurbsEval(this.uv, Math.min(this.range[1], Math.max(this.range[0], t)));
        const s = this.surface.eval(c.p[0], c.p[1]);
        return { p: s.p, d: add(scale(s.du, c.d[0]), scale(s.dv, c.d[1])) };
    }
    private samples: Samples | null = null;
    project(x: V3): number {
        this.samples ??= sampleCurve(this, Math.max(32, (this.uv.cw.length - this.uv.degree) * 8));
        return projectSampled(this, x, this.samples);
    }
}

// ---- Surfaces -----------------------------------------------------------------------------------------------

const normalOf = (du: V3, dv: V3): V3 => unit(cross(du, dv));

export class PlaneSurface implements Surface {
    kind = 'plane';
    readonly y: V3;
    constructor(readonly p0: V3, readonly n: V3, readonly x: V3) {
        this.y = cross(n, x);
    }
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        return { p: add(this.p0, add(scale(this.x, u), scale(this.y, v))), du: this.x, dv: this.y };
    }
    project(q: V3): Projection {
        const w = sub(q, this.p0);
        const u = dot(w, this.x);
        const v = dot(w, this.y);
        return { p: this.eval(u, v).p, n: this.n, uv: [u, v] };
    }
}

export class CylinderSurface implements Surface {
    kind = 'cylinder';
    readonly y: V3;
    constructor(readonly p0: V3, readonly axis: V3, readonly r: number, readonly x: V3) {
        this.y = cross(axis, x);
    }
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        const cs = Math.cos(u);
        const sn = Math.sin(u);
        const radial = add(scale(this.x, cs), scale(this.y, sn));
        return {
            p: add(addScaled(this.p0, this.axis, v), scale(radial, this.r)),
            du: scale(add(scale(this.x, -sn), scale(this.y, cs)), this.r),
            dv: this.axis,
        };
    }
    project(q: V3): Projection {
        const w = sub(q, this.p0);
        const v = dot(w, this.axis);
        const u = wrapAngle(Math.atan2(dot(w, this.y), dot(w, this.x)));
        const radial = add(scale(this.x, Math.cos(u)), scale(this.y, Math.sin(u)));
        return { p: add(addScaled(this.p0, this.axis, v), scale(radial, this.r)), n: radial, uv: [u, v] };
    }
}

/**
 * R(u, v) = P + vA + (X cos u + Y sin u)(r + v tan a). (The reference prints -vA; files fit +vA exactly.)
 */
export class ConeSurface implements Surface {
    kind = 'cone';
    readonly y: V3;
    readonly tan: number;
    constructor(readonly p0: V3, readonly axis: V3, readonly r: number, readonly sin: number, readonly cos: number, readonly x: V3) {
        this.y = cross(axis, x);
        this.tan = sin / cos;
    }
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        const cs = Math.cos(u);
        const sn = Math.sin(u);
        const radial = add(scale(this.x, cs), scale(this.y, sn));
        const rad = this.r + v * this.tan;
        return {
            p: add(addScaled(this.p0, this.axis, v), scale(radial, rad)),
            du: scale(add(scale(this.x, -sn), scale(this.y, cs)), rad),
            dv: add(this.axis, scale(radial, this.tan)),
        };
    }
    project(q: V3): Projection {
        const w = sub(q, this.p0);
        const z = dot(w, this.axis);
        const rho = sub(w, scale(this.axis, z));
        const rl = norm(rho);
        const u = rl > 1e-12 ? wrapAngle(Math.atan2(dot(rho, this.y), dot(rho, this.x))) : 0;
        const v = ((rl - this.r) * this.tan + z) / (1 + this.tan * this.tan);
        const e = this.eval(u, v);
        return { p: e.p, n: normalOf(e.du, e.dv), uv: [u, v] };
    }
}

export class SphereSurface implements Surface {
    kind = 'sphere';
    readonly y: V3;
    constructor(readonly c: V3, readonly r: number, readonly axis: V3, readonly x: V3) {
        this.y = cross(axis, x);
    }
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        const cu = Math.cos(u);
        const su = Math.sin(u);
        const cv = Math.cos(v);
        const sv = Math.sin(v);
        const radial = add(scale(this.x, cu), scale(this.y, su));
        return {
            p: add(this.c, add(scale(radial, this.r * cv), scale(this.axis, this.r * sv))),
            du: scale(add(scale(this.x, -su), scale(this.y, cu)), this.r * cv),
            dv: add(scale(radial, -this.r * sv), scale(this.axis, this.r * cv)),
        };
    }
    project(q: V3): Projection {
        const d = unit(sub(q, this.c));
        const v = Math.asin(Math.max(-1, Math.min(1, dot(d, this.axis))));
        const u = wrapAngle(Math.atan2(dot(d, this.y), dot(d, this.x)));
        return { p: addScaled(this.c, d, this.r), n: d, uv: [u, v] };
    }
}

export class TorusSurface implements Surface {
    kind = 'torus';
    readonly y: V3;
    constructor(readonly c: V3, readonly axis: V3, readonly major: number, readonly minor: number, readonly x: V3) {
        this.y = cross(axis, x);
    }
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        const cu = Math.cos(u);
        const su = Math.sin(u);
        const cv = Math.cos(v);
        const sv = Math.sin(v);
        const radial = add(scale(this.x, cu), scale(this.y, su));
        const rr = this.major + this.minor * cv;
        return {
            p: add(this.c, add(scale(radial, rr), scale(this.axis, this.minor * sv))),
            du: scale(add(scale(this.x, -su), scale(this.y, cu)), rr),
            dv: add(scale(radial, -this.minor * sv), scale(this.axis, this.minor * cv)),
        };
    }
    project(q: V3): Projection {
        const w = sub(q, this.c);
        const z = dot(w, this.axis);
        const rho = sub(w, scale(this.axis, z));
        const u = norm(rho) > 1e-12 ? wrapAngle(Math.atan2(dot(rho, this.y), dot(rho, this.x))) : 0;
        const radial = add(scale(this.x, Math.cos(u)), scale(this.y, Math.sin(u)));
        const tube = addScaled(this.c, radial, this.major);
        const d = sub(q, tube);
        const v = Math.atan2(dot(d, this.axis), dot(d, radial));
        const [uu, vv] = newtonSurface(this, q, [u, v]);
        const e = this.eval(uu, vv);
        return { p: e.p, n: normalOf(e.du, e.dv), uv: [uu, vv] };
    }
}

/**
 * Newton for the nearest point of a surface to x, from (u, v). Second derivatives by differences: with them it
 * converges quadratically even for points well off the surface (offsets of a basis), where Gauss-Newton crawls.
 */
export function newtonSurface(s: Surface, x: V3, start: [number, number], box?: [number, number, number, number]): [number, number] {
    let [u, v] = start;
    const scaleU = box ? Math.max(1e-9, box[1] - box[0]) : 1;
    const scaleV = box ? Math.max(1e-9, box[3] - box[2]) : 1;
    for (let i = 0; i < 40; i++) {
        const e = s.eval(u, v);
        const r = sub(e.p, x);
        const hu = 1e-7 * scaleU;
        const hv = 1e-7 * scaleV;
        const eu = s.eval(u + hu, v);
        const ev = s.eval(u, v + hv);
        const suu = scale(sub(eu.du, e.du), 1 / hu);
        const suv = scale(sub(eu.dv, e.dv), 1 / hu);
        const svv = scale(sub(ev.dv, e.dv), 1 / hv);
        let a = dot(e.du, e.du) + dot(r, suu);
        let b = dot(e.du, e.dv) + dot(r, suv);
        let c = dot(e.dv, e.dv) + dot(r, svv);
        if (a <= 0 || c <= 0 || a * c - b * b <= 0) {
            // Not a minimum nearby: fall back to the Gauss-Newton step.
            a = dot(e.du, e.du);
            b = dot(e.du, e.dv);
            c = dot(e.dv, e.dv);
        }
        const g0 = -dot(r, e.du);
        const g1 = -dot(r, e.dv);
        const det = a * c - b * b;
        if (!(Math.abs(det) > 1e-300)) {
            break;
        }
        let du = (c * g0 - b * g1) / det;
        let dv = (a * g1 - b * g0) / det;
        if (box) {
            const lu = 0.3 * (box[1] - box[0]);
            const lv = 0.3 * (box[3] - box[2]);
            const k = Math.max(Math.abs(du) / lu, Math.abs(dv) / lv, 1);
            du /= k;
            dv /= k;
        }
        let nu = u + du;
        let nv = v + dv;
        if (box) {
            nu = Math.min(box[1], Math.max(box[0], nu));
            nv = Math.min(box[3], Math.max(box[2], nv));
        }
        const moved = Math.abs(nu - u) / scaleU + Math.abs(nv - v) / scaleV;
        u = nu;
        v = nv;
        if (moved < 1e-14) {
            break;
        }
    }
    return [u, v];
}

export class BSurface implements Surface {
    kind = 'bsurface';
    readonly box: [number, number, number, number];
    private grid: { uv: [number, number]; p: V3 }[] | null = null;
    constructor(readonly nurbs: NurbsSurf, readonly uPeriodic: boolean, readonly vPeriodic: boolean) {
        this.box = surfRange(nurbs);
    }
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        const [u0, u1, v0, v1] = this.box;
        if (this.uPeriodic) {
            u = u0 + (((u - u0) % (u1 - u0)) + (u1 - u0)) % (u1 - u0);
        }
        if (this.vPeriodic) {
            v = v0 + (((v - v0) % (v1 - v0)) + (v1 - v0)) % (v1 - v0);
        }
        {
            // Past an edge Parasolid continues the surface along its tangent there (curves on offsets of
            // B-surfaces reach past the patch edge; they fit this exactly).
            const cu = Math.min(u1, Math.max(u0, u));
            const cv = Math.min(v1, Math.max(v0, v));
            if (cu !== u || cv !== v) {
                const e = surfEval(this.nurbs, cu, cv);
                const du = u - cu;
                const dv = v - cv;
                const h = 1e-7;
                const eu = cu !== u ? surfEval(this.nurbs, cu, Math.min(v1, cv + h)) : e;
                const ev = cv !== v ? surfEval(this.nurbs, Math.min(u1, cu + h), cv) : e;
                // Cross derivatives keep the normal turning smoothly past the edge.
                const duv: V3 = cu !== u ? scale(sub(eu.du, e.du), 1 / h) : [0, 0, 0];
                const dvu: V3 = cv !== v ? scale(sub(ev.dv, e.dv), 1 / h) : [0, 0, 0];
                return {
                    p: add(e.p, add(scale(e.du, du), scale(e.dv, dv))),
                    du: add(e.du, scale(dvu, dv)),
                    dv: add(e.dv, scale(duv, du)),
                };
            }
        }
        return surfEval(this.nurbs, u, v);
    }
    private samples(): { uv: [number, number]; p: V3 }[] {
        if (!this.grid) {
            const [u0, u1, v0, v1] = this.box;
            const nu = Math.min(80, Math.max(8, (this.nurbs.cw.length - this.nurbs.uDegree) * 6));
            const nv = Math.min(80, Math.max(8, (this.nurbs.cw[0].length - this.nurbs.vDegree) * 6));
            this.grid = [];
            for (let i = 0; i <= nu; i++) {
                for (let j = 0; j <= nv; j++) {
                    const uv: [number, number] = [u0 + ((u1 - u0) * i) / nu, v0 + ((v1 - v0) * j) / nv];
                    this.grid.push({ uv, p: surfEval(this.nurbs, uv[0], uv[1]).p });
                }
            }
        }
        return this.grid;
    }
    project(x: V3, hint?: [number, number]): Projection {
        let start = hint;
        if (!start) {
            let best = Infinity;
            for (const g of this.samples()) {
                const d = dist(g.p, x);
                if (d < best) {
                    best = d;
                    start = g.uv;
                }
            }
        }
        // The foot point may run off the patch, onto the tangent continuation (see eval).
        const [u0, u1, v0, v1] = this.box;
        const mu = (this.uPeriodic ? 10 : 0.5) * (u1 - u0);
        const mv = (this.vPeriodic ? 10 : 0.5) * (v1 - v0);
        const uv = newtonSurface(this, x, start!, [u0 - mu, u1 + mu, v0 - mv, v1 + mv]);
        const e = this.eval(uv[0], uv[1]);
        return { p: e.p, n: normalOf(e.du, e.dv), uv };
    }
}

/** Offset along the basis's natural normal by `d` (already signed for the basis sense). */
export class OffsetSurface implements Surface {
    kind = 'offset';
    constructor(readonly basis: Surface, readonly d: number) {}
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        const at = (uu: number, vv: number): V3 => {
            const e = this.basis.eval(uu, vv);
            return addScaled(e.p, normalOf(e.du, e.dv), this.d);
        };
        const h = 1e-6;
        const p = at(u, v);
        return { p, du: scale(sub(at(u + h, v), at(u - h, v)), 0.5 / h), dv: scale(sub(at(u, v + h), at(u, v - h)), 0.5 / h) };
    }
    project(x: V3, hint?: [number, number]): Projection {
        const b = this.basis.project(x, hint);
        return { p: addScaled(b.p, b.n, this.d), n: b.n, uv: b.uv };
    }
}

/** R(u, v) = C(u) + v D. */
export class SweptSurface implements Surface {
    kind = 'swept';
    private flatSamples: Samples | null = null;
    constructor(readonly section: Curve, readonly dir: V3) {}
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        const c = this.section.eval(u);
        return { p: addScaled(c.p, this.dir, v), du: c.d, dv: this.dir };
    }
    project(x: V3): Projection {
        // Nearest point of the section curve in the plane across the sweep direction.
        const flat = (p: V3): V3 => sub(p, scale(this.dir, dot(p, this.dir)));
        const fx = flat(x);
        const flatCurve: Curve = {
            kind: 'flat', range: this.section.range, period: this.section.period,
            eval: (t) => {
                const e = this.section.eval(t);
                return { p: flat(e.p), d: flat(e.d) };
            },
            project: () => 0,
        };
        this.flatSamples ??= sampleCurve(flatCurve, 400);
        const u = projectSampled(flatCurve, fx, this.flatSamples, 0.5);
        const c = this.section.eval(u);
        const v = dot(sub(x, c.p), this.dir);
        return { p: addScaled(c.p, this.dir, v), n: normalOf(c.d, this.dir), uv: [u, v] };
    }
}

/** The profile C(u) spun about an axis by angle v. */
export class SpunSurface implements Surface {
    kind = 'spun';
    private meridianSamples: Samples | null = null;
    constructor(readonly profile: Curve, readonly base: V3, readonly axis: V3) {}
    private rotate(w: V3, v: number): V3 {
        const z = scale(this.axis, dot(w, this.axis));
        const r = sub(w, z);
        return add(z, add(scale(r, Math.cos(v)), scale(cross(this.axis, r), Math.sin(v))));
    }
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        const c = this.profile.eval(u);
        const w = this.rotate(sub(c.p, this.base), v);
        return { p: add(this.base, w), du: this.rotate(c.d, v), dv: cross(this.axis, w) };
    }
    project(x: V3): Projection {
        // In (distance from axis, height) coordinates the surface is the profile's meridian curve.
        const meridian = (p: V3): V3 => {
            const w = sub(p, this.base);
            const z = dot(w, this.axis);
            return [norm(sub(w, scale(this.axis, z))), z, 0];
        };
        const mc: Curve = {
            kind: 'meridian', range: this.profile.range, period: this.profile.period,
            eval: (t) => {
                const h = 1e-7;
                const p = meridian(this.profile.eval(t).p);
                return { p, d: scale(sub(meridian(this.profile.eval(t + h).p), p), 1 / h) };
            },
            project: () => 0,
        };
        this.meridianSamples ??= sampleCurve(mc, 400);
        const u = projectSampled(mc, meridian(x), this.meridianSamples, 0.5);
        const c = this.profile.eval(u).p;
        const wc = sub(c, this.base);
        const wx = sub(x, this.base);
        const rc = sub(wc, scale(this.axis, dot(wc, this.axis)));
        const rx = sub(wx, scale(this.axis, dot(wx, this.axis)));
        const v = Math.atan2(dot(cross(rc, rx), this.axis), dot(rc, rx));
        const e = this.eval(u, v);
        return { p: e.p, n: normalOf(e.du, e.dv), uv: [u, v] };
    }
}

/**
 * A rolling-ball blend as the tube of radius r about its spine (the face picks the part between the contact
 * lines). Its natural parameterisation is not needed here: the face is rebuilt as a B-spline (rebuild.ts).
 */
export class BlendSurface implements Surface {
    kind = 'blend';
    constructor(readonly spine: Curve, readonly r: number, readonly supports: [Surface | null, Surface | null]) {}
    eval(u: number, v: number): { p: V3; du: V3; dv: V3 } {
        // Tube coordinates: u along the spine, v the angle from a frame (used only for sampling).
        const c = this.spine.eval(u);
        const t = unit(c.d);
        const x = unit(cross(t, Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
        const y = cross(t, x);
        const radial = add(scale(x, Math.cos(v)), scale(y, Math.sin(v)));
        return { p: addScaled(c.p, radial, this.r), du: c.d, dv: scale(add(scale(x, -Math.sin(v)), scale(y, Math.cos(v))), this.r) };
    }
    project(x: V3): Projection {
        const t = this.spine.project(x);
        const c = this.spine.eval(t).p;
        const dir = unit(sub(x, c));
        return { p: addScaled(c, dir, this.r), n: this.r > 0 ? dir : [0, 0, 0], uv: [t, 0] };
    }
}
