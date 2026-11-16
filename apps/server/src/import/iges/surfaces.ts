// IGES surfaces as B-rep text surface records in mm: rational B-spline (128), parametric spline (114), ruled
// (118), revolution (120), tabulated cylinder (122), offset (140), plane (108) and the analytic surfaces of B-rep
// solids (190 to 198). Revolutions and extrusions of lines and arcs become planes, cylinders, cones, spheres and
// tori. Surfaces round an axis can be written with their parameter seam turned to a given angle, so a face's seam
// falls where it cuts none of its loops.

import {
    BSurface, CylinderSurface, ConeSurface, PlaneSurface, SphereSurface, SpunSurface, SweptSurface, TorusSurface,
    CircleCurve, LineCurve, NurbsCurve, type Projection, type Surface,
} from '../sldprt/geometry.js';
import { nurbsSurfRecord } from '../sldprt/brep.js';
import { add, cross, dist, dot, norm, perpendicular, scale, sub, surfClamp, unit, type NurbsSurf, type V3 } from '../sldprt/nurbs.js';
import {
    compatible, curveSegments, joinNurbs, reverseNurbs, segNurbs, wholeCurveRecord, type Seg,
} from './curves.js';
import { apply, applyVector, compose, IgesGeometryError, int, num, point, scaleOf, type IgesModel, type Xf } from './model.js';
import type { IgesEntity } from './parse.js';

/** (u, v) -> (a u + b v + e, c u + d v + f): IGES parameters to the record's. */
export type UvMap = [number, number, number, number, number, number];

export const mapUv = (m: UvMap, u: number, v: number): [number, number] => [m[0] * u + m[1] * v + m[4], m[2] * u + m[3] * v + m[5]];

export interface SurfaceDef {
    kind: string;
    /** The B-rep text record. */
    rec: string;
    /** The surface in the record's parameters (its normal and, round an axis, its angle as OpenCascade has them). */
    occ: Surface;
    /** True when the record's normal is opposite to the IGES surface's. */
    flip: boolean;
    /** IGES parameters to the record's, when that is an affine map (for parameter-space curves). */
    uv?: UvMap;
    /** The IGES parameter domain [u0, u1, v0, v1]. */
    domain?: [number, number, number, number];
    /** The record's parameter box of that domain (for faces bounded by the whole surface). */
    bounds?: [number, number, number, number];
    /** For surfaces round an axis: the axis and the direction of angle 0, to place the seam. */
    axis?: { c: V3; n: V3; x: V3 };
    planar?: boolean;
    /** Periods of the record's u and v (0: not closed in that direction). */
    periods?: [number, number];
}

export interface SurfaceOptions {
    /** Turn of the parameter seam about the axis, radians from axis.x. */
    seam?: number;
    /** The face is bounded by the surface's own boundary: keep the IGES parameterisation (no plane from a revolution). */
    natural?: boolean;
    /** The face is trimmed by parameter-space curves: keep the IGES parameterisation (no analytic surface). */
    parametric?: boolean;
}

export const SURFACE_TYPES = new Set([108, 114, 118, 120, 122, 128, 140, 190, 192, 194, 196, 198]);

const fmt = (v: number): string => (v === 0 ? '0' : String(v));
const v3 = (v: V3): string => `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`;
const TWO_PI = 2 * Math.PI;

/** A rotation about an axis through c along unit n, as an affine map. */
export function rotation(c: V3, n: V3, angle: number): Xf {
    const cs = Math.cos(angle);
    const sn = Math.sin(angle);
    const t = 1 - cs;
    const [x, y, z] = n;
    const r = [
        t * x * x + cs, t * x * y - sn * z, t * x * z + sn * y,
        t * x * y + sn * z, t * y * y + cs, t * y * z - sn * x,
        t * x * z - sn * y, t * y * z + sn * x, t * z * z + cs,
    ];
    const rc = [r[0] * c[0] + r[1] * c[1] + r[2] * c[2], r[3] * c[0] + r[4] * c[1] + r[5] * c[2], r[6] * c[0] + r[7] * c[1] + r[8] * c[2]];
    return { r, t: [c[0] - rc[0], c[1] - rc[1], c[2] - rc[2]] };
}

const turn = (x: V3, n: V3, angle: number): V3 => add(scale(x, Math.cos(angle)), scale(cross(n, x), Math.sin(angle)));

/** Whether the record's normal is opposite to that of an IGES evaluator, compared at a parameter point. */
function flipAgainst(iges: Surface, u: number, v: number, occ: Surface): boolean {
    const e = iges.eval(u, v);
    const n = cross(e.du, e.dv);
    const m = occ.project(e.p).n;
    return dot(n, m) < 0;
}

/** The record parameters swapped (OpenCascade's revolution has the angle first). */
function swapped(s: Surface): Surface {
    return {
        kind: s.kind,
        eval: (u, v) => {
            const e = s.eval(v, u);
            return { p: e.p, du: e.dv, dv: e.du };
        },
        project: (x): Projection => {
            const p = s.project(x);
            return { p: p.p, n: scale(p.n, -1), uv: [p.uv[1], p.uv[0]] };
        },
    };
}

/** A B-spline surface (homogeneous poles) as a definition with the IGES parameters as its own. */
function bsplineDef(kind: string, s: NurbsSurf, domain?: [number, number, number, number]): SurfaceDef {
    const clamped = surfClamp(s);
    const occ = new BSurface(clamped, false, false);
    const [a0, a1, b0, b1] = occ.box;
    const d: [number, number, number, number] = domain
        ? [Math.max(a0, domain[0]), Math.min(a1, domain[1]), Math.max(b0, domain[2]), Math.min(b1, domain[3])]
        : [a0, a1, b0, b1];
    if (!(d[1] > d[0] && d[3] > d[2])) {
        d.splice(0, 4, a0, a1, b0, b1);
    }
    return { kind, rec: nurbsSurfRecord(clamped), occ, flip: false, uv: [1, 0, 0, 1, 0, 0], domain: d, bounds: d };
}

function nurbs128(e: IgesEntity, x: Xf): SurfaceDef {
    const K1 = int(e, 0);
    const K2 = int(e, 1);
    const M1 = int(e, 2);
    const M2 = int(e, 3);
    const polynomial = int(e, 6) === 1;
    if (K1 < 1 || K2 < 1 || M1 < 1 || M2 < 1 || M1 > 25 || M2 > 25) {
        throw new IgesGeometryError(`a B-spline surface of degree ${M1} x ${M2}`);
    }
    const nu = K1 + M1 + 2;
    const nv = K2 + M2 + 2;
    const uKnots = Array.from({ length: nu }, (_, k) => num(e, 9 + k));
    const vKnots = Array.from({ length: nv }, (_, k) => num(e, 9 + nu + k));
    const wAt = 9 + nu + nv;
    const count = (K1 + 1) * (K2 + 1);
    const pAt = wAt + count;
    const cw: number[][][] = [];
    for (let i = 0; i <= K1; i++) {
        const row: number[][] = [];
        for (let j = 0; j <= K2; j++) {
            const k = i + j * (K1 + 1);
            const w = polynomial ? 1 : num(e, wAt + k, 1);
            if (!(w > 0)) {
                throw new IgesGeometryError('a B-spline surface with a weight that is not positive');
            }
            const p = apply(x, point(e, pAt + 3 * k));
            row.push([p[0] * w, p[1] * w, p[2] * w, w]);
        }
        cw.push(row);
    }
    const dAt = pAt + 3 * count;
    const domain: [number, number, number, number] = [num(e, dAt, uKnots[M1]), num(e, dAt + 1, uKnots[K1 + 1]), num(e, dAt + 2, vKnots[M2]), num(e, dAt + 3, vKnots[K2 + 1])];
    return bsplineDef('B-spline', { uDegree: M1, vDegree: M2, uKnots, vKnots, cw, rational: !polynomial }, domain);
}

/** Bicubic patches in power form as one B-spline surface with knots of multiplicity 3 (exact). */
function spline114(e: IgesEntity, x: Xf): SurfaceDef {
    const M = int(e, 2);
    const N = int(e, 3);
    if (M < 1 || N < 1) {
        throw new IgesGeometryError('a parametric spline surface without patches');
    }
    const TU = Array.from({ length: M + 1 }, (_, k) => num(e, 4 + k));
    const TV = Array.from({ length: N + 1 }, (_, k) => num(e, 5 + M + k));
    const at = 6 + M + N;
    // Some writers add a dummy patch after each row (and a dummy row): tell by the count.
    const rowLength = e.params.length - at >= 48 * (M + 1) * (N + 1) ? N + 1 : N;
    const T = [[1, 0, 0, 0], [1, 1 / 3, 0, 0], [1, 2 / 3, 1 / 3, 0], [1, 1, 1, 1]];
    const nu = 3 * M + 1;
    const nv = 3 * N + 1;
    const grid: V3[][] = Array.from({ length: nu }, () => Array.from({ length: nv }, (): V3 => [0, 0, 0]));
    for (let i = 0; i < M; i++) {
        const hu = TU[i + 1] - TU[i];
        for (let j = 0; j < N; j++) {
            const hv = TV[j + 1] - TV[j];
            const base = at + 48 * (i * rowLength + j);
            for (let axis = 0; axis < 3; axis++) {
                // c[k][l]: coefficient of s^k t^l, scaled to the unit patch.
                const c = [0, 1, 2, 3].map((k) => [0, 1, 2, 3].map((l) => num(e, base + 16 * axis + 4 * l + k) * hu ** k * hv ** l));
                for (let a = 0; a < 4; a++) {
                    for (let b = 0; b < 4; b++) {
                        let sum = 0;
                        for (let k = 0; k < 4; k++) {
                            for (let l = 0; l < 4; l++) {
                                sum += T[a][k] * T[b][l] * c[k][l];
                            }
                        }
                        grid[3 * i + a][3 * j + b][axis] = sum;
                    }
                }
            }
        }
    }
    const knots = (t: number[]): number[] => [t[0], ...t.flatMap((v) => [v, v, v]), t[t.length - 1]];
    const cw = grid.map((row) => row.map((p) => [...apply(x, p), 1]));
    return bsplineDef('spline', { uDegree: 3, vDegree: 3, uKnots: knots(TU), vKnots: knots(TV), cw, rational: false });
}

/** A curve entity (or a point, for a ruled surface's degenerate rail) as one NURBS. */
function railNurbs(m: IgesModel, e: IgesEntity, x: Xf) {
    if (e.type === 116) {
        const p = apply(m.xf(e, x), point(e, 0));
        return { degree: 1, knots: [0, 0, 1, 1], cw: [[...p, 1], [...p, 1]], rational: false };
    }
    const segs = curveSegments(m, e, x);
    if (!segs.length) {
        throw new IgesGeometryError('a ruled surface rail of zero length');
    }
    return joinNurbs(segs.map(segNurbs));
}

function ruled118(m: IgesModel, e: IgesEntity, x: Xf): SurfaceDef {
    const c1 = railNurbs(m, m.need(e.params[0], 'the first curve of a ruled surface'), x);
    let c2 = railNurbs(m, m.need(e.params[1], 'the second curve of a ruled surface'), x);
    if (int(e, 2) === 1) {
        c2 = reverseNurbs(c2);
    }
    const [a, b] = compatible(c1, c2);
    if (a.cw.length !== b.cw.length) {
        throw new IgesGeometryError('the curves of a ruled surface could not be matched');
    }
    const s: NurbsSurf = {
        uDegree: a.degree, vDegree: 1, uKnots: a.knots, vKnots: [0, 0, 1, 1],
        cw: a.cw.map((p, i) => [p, b.cw[i]]), rational: a.rational || b.rational,
    };
    return bsplineDef('ruled', s, [0, 1, 0, 1]);
}

/** The radial direction of p from the axis (zero on the axis), and its distance and height. */
function cylindrical(c: V3, n: V3, p: V3): { r: number; z: number; dir: V3 } {
    const w = sub(p, c);
    const z = dot(w, n);
    const rad = sub(w, scale(n, z));
    const r = norm(rad);
    return { r, z, dir: r > 0 ? scale(rad, 1 / r) : [0, 0, 0] };
}

/** Segments as one: the single segment, or their join as a B-spline. */
function asOne(segs: Seg[]): Seg {
    if (segs.length === 1) {
        return segs[0];
    }
    const joined = joinNurbs(segs.map(segNurbs));
    return { curve: new NurbsCurve(joined, false), first: joined.knots[0], last: joined.knots[joined.knots.length - 1] };
}

type Box = [number, number, number, number];

function revolution120(m: IgesModel, e: IgesEntity, x: Xf, o: SurfaceOptions): SurfaceDef {
    const line = m.need(e.params[0], 'the axis of a surface of revolution');
    const lx = m.xf(line, x);
    const a0 = apply(lx, point(line, 0));
    const a1 = apply(lx, point(line, 3));
    if (!(dist(a0, a1) > 0)) {
        throw new IgesGeometryError('a surface of revolution with an axis of zero length');
    }
    const n = unit(sub(a1, a0));
    const genEntity = m.need(e.params[1], 'the generatrix of a surface of revolution');
    const sa = num(e, 2);
    const ta = num(e, 3, TWO_PI);
    const gen = curveSegments(m, genEntity, x);
    if (!gen.length) {
        throw new IgesGeometryError('a surface of revolution with an empty generatrix');
    }
    const seam = o.seam ?? 0;
    const g0 = gen[0].curve.eval(gen[0].first).p;
    const g1 = gen[gen.length - 1].curve.eval(gen[gen.length - 1].last).p;
    const tol = 1e-9 * Math.max(1, dist(a0, g0), dist(a0, g1));
    // The IGES surface: the generatrix turned about the axis by v (right-handed).
    const iges = (seg: Seg): Surface => new SpunSurface(seg.curve, a0, n);
    const at = (seg: Seg): [number, number] => [(seg.first + seg.last) / 2, sa + Math.min(1, Math.abs(ta - sa) / 2)];
    const flipOf = (seg: Seg, occ: Surface): boolean => flipAgainst(iges(seg), ...at(seg), occ);
    const natural = seam === 0;
    if (gen.length === 1 && !o.parametric) {
        const seg = gen[0];
        const c = seg.curve;
        if (c instanceof LineCurve) {
            const s0 = cylindrical(a0, n, g0);
            const s1 = cylindrical(a0, n, g1);
            const coplanar = Math.abs(dot(cross(sub(g1, g0), n), sub(g0, a0))) <= tol * Math.max(1, dist(g0, g1));
            const xDir = s0.r > tol ? s0.dir : s1.dir;
            if (coplanar && norm(xDir) > 0) {
                const X = turn(xDir, n, seam);
                const P = add(a0, scale(n, s0.z));
                const dz = s1.z - s0.z;
                if (Math.abs(dz) <= tol && !o.natural) {
                    const occ = new PlaneSurface(P, n, X);
                    return { kind: 'plane', rec: `1 ${v3(P)} ${v3(n)} ${v3(X)} ${v3(cross(n, X))}`, occ, flip: flipOf(seg, occ), planar: true };
                }
                if (Math.abs(s1.r - s0.r) <= tol) {
                    const occ = new CylinderSurface(P, n, s0.r, X);
                    return {
                        kind: 'cylinder', rec: `2 ${v3(P)} ${v3(n)} ${v3(X)} ${v3(cross(n, X))} ${fmt(s0.r)}`, occ,
                        flip: flipOf(seg, occ), axis: { c: P, n, x: xDir },
                        ...(natural ? { uv: [0, 1, dz, 0, 0, 0] as UvMap, domain: [0, 1, sa, ta] as Box, bounds: [sa, ta, Math.min(0, dz), Math.max(0, dz)] as Box } : {}),
                    };
                }
                if (Math.abs(dz) > tol) {
                    const alpha = Math.atan2(s1.r - s0.r, dz);
                    if (Math.abs(alpha) > 1e-9 && Math.abs(alpha) < Math.PI / 2 - 1e-9) {
                        const occ = new ConeSurface(P, n, s0.r, Math.sin(alpha), Math.cos(alpha), X);
                        const len = dist(g0, g1) * Math.sign(dz);
                        return {
                            kind: 'cone', rec: `3 ${v3(P)} ${v3(n)} ${v3(X)} ${v3(cross(n, X))} ${fmt(s0.r)} ${fmt(alpha)}`, occ,
                            flip: flipOf(seg, occ), axis: { c: P, n, x: xDir },
                            ...(natural ? { domain: [0, 1, sa, ta] as Box, bounds: [sa, ta, Math.min(0, len), Math.max(0, len)] as Box } : {}),
                        };
                    }
                }
            }
        } else if (c instanceof CircleCurve && Math.abs(dot(c.n, n)) < 1e-9 && Math.abs(dot(sub(c.c, a0), c.n)) <= tol) {
            const sc = cylindrical(a0, n, c.c);
            const samples = Array.from({ length: 17 }, (_, i) => c.eval(seg.first + ((seg.last - seg.first) * i) / 16).p);
            if (sc.r <= tol) {
                const xDir = cylindrical(a0, n, c.eval((seg.first + seg.last) / 2).p).dir;
                if (norm(xDir) > 0) {
                    const X = turn(xDir, n, seam);
                    const occ = new SphereSurface(c.c, c.r, n, X);
                    const lat = samples.map((p) => Math.asin(Math.max(-1, Math.min(1, dot(sub(p, c.c), n) / c.r))));
                    return {
                        kind: 'sphere', rec: `4 ${v3(c.c)} ${v3(n)} ${v3(X)} ${v3(cross(n, X))} ${fmt(c.r)}`, occ,
                        flip: flipOf(seg, occ), axis: { c: c.c, n, x: xDir },
                        ...(natural ? { domain: [seg.first, seg.last, sa, ta] as Box, bounds: [sa, ta, Math.min(...lat), Math.max(...lat)] as Box } : {}),
                    };
                }
            } else if (sc.r > c.r + tol) {
                const T = add(a0, scale(n, sc.z));
                const X = turn(sc.dir, n, seam);
                const occ = new TorusSurface(T, n, sc.r, c.r, X);
                let prev = 0;
                const tube = samples.map((p, i) => {
                    const d = sub(p, c.c);
                    let a = Math.atan2(dot(d, n), dot(d, sc.dir));
                    if (i > 0) {
                        a += TWO_PI * Math.round((prev - a) / TWO_PI);
                    }
                    prev = a;
                    return a;
                });
                return {
                    kind: 'torus', rec: `5 ${v3(T)} ${v3(n)} ${v3(X)} ${v3(cross(n, X))} ${fmt(sc.r)} ${fmt(c.r)}`, occ,
                    flip: flipOf(seg, occ), axis: { c: T, n, x: sc.dir },
                    ...(natural ? { domain: [seg.first, seg.last, sa, ta] as Box, bounds: [sa, ta, Math.min(...tube), Math.max(...tube)] as Box } : {}),
                };
            }
        }
    }
    // Any other generatrix: OpenCascade's surface of revolution (angle first), the profile turned to the seam.
    const profile = asOne(seam ? curveSegments(m, genEntity, compose(rotation(a0, n, seam), x)) : gen);
    const occ = swapped(new SpunSurface(profile.curve, a0, n));
    const r0 = cylindrical(a0, n, g0);
    const xDir = r0.r > tol ? r0.dir : cylindrical(a0, n, g1).dir;
    const single = gen.length === 1 ? gen[0] : null;
    // IGES parameters on the generatrix: a line's run 0 to 1; a B-spline's are its own.
    const uv: UvMap | undefined = single?.curve instanceof LineCurve ? [0, 1, single.last, 0, 0, 0]
        : single?.curve instanceof NurbsCurve ? [0, 1, 1, 0, 0, 0] : undefined;
    return {
        kind: 'revolution', rec: `7 ${v3(a0)} ${v3(n)}\n${wholeCurveRecord(profile)}`, occ, flip: true,
        ...(norm(xDir) > 0 ? { axis: { c: a0, n, x: xDir } } : {}),
        ...(natural ? { bounds: [sa, ta, profile.first, profile.last] as Box } : {}),
        ...(natural && uv ? { uv, domain: [single!.curve instanceof LineCurve ? 0 : single!.first, single!.curve instanceof LineCurve ? 1 : single!.last, sa, ta] as Box } : {}),
    };
}

function tabulated122(m: IgesModel, e: IgesEntity, x: Xf, o: SurfaceOptions): SurfaceDef {
    const directrix = m.need(e.params[0], 'the directrix of a tabulated cylinder');
    const segs = curveSegments(m, directrix, x);
    if (!segs.length) {
        throw new IgesGeometryError('a tabulated cylinder with an empty directrix');
    }
    const start = segs[0].curve.eval(segs[0].first).p;
    const D = sub(apply(x, point(e, 1)), start);
    const len = norm(D);
    if (!(len > 0)) {
        throw new IgesGeometryError('a tabulated cylinder of zero height');
    }
    const dir = scale(D, 1 / len);
    const section = asOne(segs);
    const iges = new SweptSurface(section.curve, D);
    const mid = (section.first + section.last) / 2;
    if (segs.length === 1 && !o.natural && !o.parametric) {
        const c = section.curve;
        if (c instanceof LineCurve && norm(cross(c.dir, dir)) > 1e-9) {
            const N = unit(cross(c.dir, dir));
            const occ = new PlaneSurface(start, N, c.dir);
            return { kind: 'plane', rec: `1 ${v3(start)} ${v3(N)} ${v3(c.dir)} ${v3(cross(N, c.dir))}`, occ, flip: flipAgainst(iges, mid, 0.5, occ), planar: true };
        }
        if (c instanceof CircleCurve && norm(cross(c.n, dir)) < 1e-9) {
            const X = turn(c.x, dir, o.seam ?? 0);
            const occ = new CylinderSurface(c.c, dir, c.r, X);
            return {
                kind: 'cylinder', rec: `2 ${v3(c.c)} ${v3(dir)} ${v3(X)} ${v3(cross(dir, X))} ${fmt(c.r)}`, occ,
                flip: flipAgainst(iges, mid, 0.5, occ), axis: { c: c.c, n: dir, x: c.x },
            };
        }
    }
    const f = section.first;
    const l = section.last;
    const uv: UvMap = [l - f, 0, 0, len, f, 0];
    if (dist(section.curve.eval(f).p, section.curve.eval(l).p) <= 1e-9 * Math.max(1, len)) {
        // Round a closed curve: the same surface as an exact B-spline (OpenCascade's sewing misses the edges of an
        // extrusion of a closed curve).
        const c = segNurbs(section);
        const s: NurbsSurf = {
            uDegree: c.degree, vDegree: 1, uKnots: c.knots, vKnots: [0, 0, len, len],
            cw: c.cw.map((pw) => [pw, [pw[0] + D[0] * pw[3], pw[1] + D[1] * pw[3], pw[2] + D[2] * pw[3], pw[3]]]), rational: c.rational,
        };
        return { ...bsplineDef('extrusion', s), uv, domain: [0, 1, 0, 1], bounds: [c.knots[0], c.knots[c.knots.length - 1], 0, len] };
    }
    return {
        kind: 'extrusion', rec: `6 ${v3(dir)}\n${wholeCurveRecord(section)}`, occ: new SweptSurface(section.curve, dir), flip: false,
        uv, domain: [0, 1, 0, 1], bounds: [f, l, 0, len],
    };
}

function plane108(e: IgesEntity, x: Xf): SurfaceDef {
    const nLocal: V3 = [num(e, 0), num(e, 1), num(e, 2)];
    const d = num(e, 3);
    const nl = norm(nLocal);
    if (!(nl > 0)) {
        throw new IgesGeometryError('a plane without a normal');
    }
    const pLocal = scale(nLocal, d / (nl * nl));
    const P = apply(x, pLocal);
    const N = unit(applyVector(x, nLocal));
    const X = perpendicular(N);
    return { kind: 'plane', rec: `1 ${v3(P)} ${v3(N)} ${v3(X)} ${v3(cross(N, X))}`, occ: new PlaneSurface(P, N, X), flip: false, planar: true };
}

/** Point (116) and direction (123) entities of the analytic surfaces. */
function pointOf(m: IgesModel, de: unknown, x: Xf, what: string): V3 {
    const e = m.need(de as number, what);
    return apply(m.xf(e, x), point(e, 0));
}

function directionOf(m: IgesModel, de: unknown, x: Xf, what: string): V3 {
    const e = m.need(de as number, what);
    const v = unit(applyVector(x, point(e, 0)));
    if (!(norm(v) > 0)) {
        throw new IgesGeometryError(`${what} has zero length`);
    }
    return v;
}

function analytic(m: IgesModel, e: IgesEntity, x: Xf, o: SurfaceOptions): SurfaceDef {
    const s = scaleOf(x);
    const seam = o.seam ?? 0;
    const refDir = (k: number, n: V3): V3 => {
        const r = e.form === 1 && m.entity(int(e, k)) ? directionOf(m, e.params[k], x, 'a reference direction') : perpendicular(n);
        const flat = sub(r, scale(n, dot(r, n)));
        return norm(flat) > 1e-9 ? unit(flat) : perpendicular(n);
    };
    switch (e.type) {
        case 190: {
            const P = pointOf(m, e.params[0], x, 'the point of a plane surface');
            const N = directionOf(m, e.params[1], x, 'the normal of a plane surface');
            const X = refDir(2, N);
            return { kind: 'plane', rec: `1 ${v3(P)} ${v3(N)} ${v3(X)} ${v3(cross(N, X))}`, occ: new PlaneSurface(P, N, X), flip: false, planar: true };
        }
        case 192: {
            const P = pointOf(m, e.params[0], x, 'the point of a cylindrical surface');
            const N = directionOf(m, e.params[1], x, 'the axis of a cylindrical surface');
            const r = num(e, 2) * s;
            const X0 = refDir(3, N);
            const X = turn(X0, N, seam);
            return { kind: 'cylinder', rec: `2 ${v3(P)} ${v3(N)} ${v3(X)} ${v3(cross(N, X))} ${fmt(r)}`, occ: new CylinderSurface(P, N, r, X), flip: false, axis: { c: P, n: N, x: X0 } };
        }
        case 194: {
            const P = pointOf(m, e.params[0], x, 'the point of a conical surface');
            const N = directionOf(m, e.params[1], x, 'the axis of a conical surface');
            const r = num(e, 2) * s;
            const alpha = (num(e, 3) * Math.PI) / 180;
            const X0 = refDir(4, N);
            const X = turn(X0, N, seam);
            return {
                kind: 'cone', rec: `3 ${v3(P)} ${v3(N)} ${v3(X)} ${v3(cross(N, X))} ${fmt(r)} ${fmt(alpha)}`,
                occ: new ConeSurface(P, N, r, Math.sin(alpha), Math.cos(alpha), X), flip: false, axis: { c: P, n: N, x: X0 },
            };
        }
        case 196: {
            const C = pointOf(m, e.params[0], x, 'the centre of a spherical surface');
            const r = num(e, 1) * s;
            const N = e.form === 1 && m.entity(int(e, 2)) ? directionOf(m, e.params[2], x, 'the axis of a spherical surface') : [0, 0, 1] as V3;
            const X0 = refDir(3, N);
            const X = turn(X0, N, seam);
            return { kind: 'sphere', rec: `4 ${v3(C)} ${v3(N)} ${v3(X)} ${v3(cross(N, X))} ${fmt(r)}`, occ: new SphereSurface(C, r, N, X), flip: false, axis: { c: C, n: N, x: X0 } };
        }
        case 198: {
            const C = pointOf(m, e.params[0], x, 'the centre of a toroidal surface');
            const N = directionOf(m, e.params[1], x, 'the axis of a toroidal surface');
            const R = num(e, 2) * s;
            const r = num(e, 3) * s;
            const X0 = refDir(4, N);
            const X = turn(X0, N, seam);
            return { kind: 'torus', rec: `5 ${v3(C)} ${v3(N)} ${v3(X)} ${v3(cross(N, X))} ${fmt(R)} ${fmt(r)}`, occ: new TorusSurface(C, N, R, r, X), flip: false, axis: { c: C, n: N, x: X0 } };
        }
        default:
            throw new IgesGeometryError(`entity type ${e.type} is not a surface`);
    }
}

function offset140(m: IgesModel, e: IgesEntity, x: Xf, o: SurfaceOptions, depth: number): SurfaceDef {
    const basis = surfaceDef(m, m.need(e.params[4], 'the basis of an offset surface'), x, o, depth + 1);
    const d = num(e, 3) * scaleOf(x) * (basis.flip ? -1 : 1);
    const occ: Surface = {
        kind: 'offset',
        eval: (u, v) => {
            const b = basis.occ.eval(u, v);
            const nn = unit(cross(b.du, b.dv));
            return { p: add(b.p, scale(nn, d)), du: b.du, dv: b.dv };
        },
        project: (q) => {
            const b = basis.occ.project(q);
            return { p: add(b.p, scale(b.n, d)), n: b.n, uv: b.uv };
        },
    };
    return { ...basis, kind: 'offset', rec: `11 ${fmt(d)}\n${basis.rec}`, occ, planar: basis.planar };
}

/** The definition of a surface entity, through its own transformation and `parent`. */
/** Whether the record closes on itself in u and in v, and over what period. */
function periodsOf(def: SurfaceDef): [number, number] {
    switch (def.kind) {
        case 'cylinder': case 'cone': case 'sphere': case 'revolution':
            return [TWO_PI, 0];
        case 'torus':
            return [TWO_PI, TWO_PI];
        case 'plane':
            return [0, 0];
        default:
            break;
    }
    const box = def.occ instanceof BSurface ? def.occ.box : def.bounds;
    if (!box) {
        return [0, 0];
    }
    const [u0, u1, v0, v1] = box;
    const size = Math.max(1e-9, dist(def.occ.eval(u0, v0).p, def.occ.eval(u1, v1).p), dist(def.occ.eval(u0, v1).p, def.occ.eval(u1, v0).p));
    const tol = 1e-7 * Math.max(1, size);
    const at = [0, 0.25, 0.5, 0.75, 1];
    const uClosed = at.every((k) => dist(def.occ.eval(u0, v0 + (v1 - v0) * k).p, def.occ.eval(u1, v0 + (v1 - v0) * k).p) <= tol);
    const vClosed = at.every((k) => dist(def.occ.eval(u0 + (u1 - u0) * k, v0).p, def.occ.eval(u0 + (u1 - u0) * k, v1).p) <= tol);
    return [uClosed ? u1 - u0 : 0, vClosed ? v1 - v0 : 0];
}

export function surfaceDef(m: IgesModel, e: IgesEntity, parent: Xf, o: SurfaceOptions = {}, depth = 0): SurfaceDef {
    if (depth > 8) {
        throw new IgesGeometryError('offset surfaces nest too deeply');
    }
    const def = surfaceOf(m, e, m.xf(e, parent), o, depth);
    return def.periods ? def : { ...def, periods: periodsOf(def) };
}

function surfaceOf(m: IgesModel, e: IgesEntity, x: Xf, o: SurfaceOptions, depth: number): SurfaceDef {
    switch (e.type) {
        case 128:
            return nurbs128(e, x);
        case 114:
            return spline114(e, x);
        case 118:
            return ruled118(m, e, x);
        case 120:
            return revolution120(m, e, x, o);
        case 122:
            return tabulated122(m, e, x, o);
        case 140:
            return offset140(m, e, x, o, depth);
        case 108:
            return plane108(e, x);
        case 190:
        case 192:
        case 194:
        case 196:
        case 198:
            return analytic(m, e, x, o);
        default:
            throw new IgesGeometryError(`entity type ${e.type} is not a surface the studio reads`);
    }
}
