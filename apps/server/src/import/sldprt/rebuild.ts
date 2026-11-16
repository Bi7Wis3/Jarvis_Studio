// Geometry Parasolid keeps implicitly, rebuilt as B-splines:
// - intersection curves, from their chart points refined onto both surfaces and densified until a cubic
//   Hermite B-spline through them is within CURVE_TOL of the true curve;
// - rolling-ball blend faces, as the tube about the spine over the face's angular sector: exact circles across,
//   cubic Hermite along, within SURFACE_TOL (see blendPatch).

import {
    add, addScaled, cross, dist, dot, norm, nurbsEval, scale, sub, unit, type Nurbs, type NurbsSurf, type V3,
} from './nurbs.js';
import { BlendSurface, NurbsCurve, projectNear, type Curve, type Projection, type Surface } from './geometry.js';
import { BlendBoundSurface, MM, UnsupportedGeometry, type CurveBuilder, type XtModel } from './xtModel.js';
import type { XtNode } from './xtParse.js';

/** Largest distance allowed between a rebuilt curve and the true one, mm. */
export const CURVE_TOL = 1e-6;
/** Largest distance allowed between a rebuilt blend surface and the true one, mm. */
export const SURFACE_TOL = 1e-5;

interface CurvePoint {
    p: V3;
    /** Unit tangent along the curve's direction. */
    t: V3;
}

/** How a curve defined by two surfaces is followed: points mapped onto it, and how far a point is off it. */
export interface CurveRule {
    onCurve(x: V3): V3;
    /** Largest distance of x from the surfaces defining the curve. */
    error(x: V3): number;
    /** Unit tangent where it is well defined (a transversal intersection), else null. */
    tangent(p: V3): V3 | null;
}

/** Distance from a rolling-ball tube (its spine and radius). */
function tubeDistance(blend: BlendSurface, x: V3, hint?: number): number {
    const t = blend.spine.project(x, hint);
    return Math.abs(dist(x, blend.spine.eval(t).p) - blend.r);
}

function intersectionRule(m: XtModel, a: Surface, b: Surface): CurveRule {
    const bound = a instanceof BlendBoundSurface ? a : b instanceof BlendBoundSurface ? b : null;
    if (bound) {
        // The boundary where a blend touches its support: the foot of the spine point on the other surface.
        const other = bound === a ? b : a;
        if (other instanceof BlendBoundSurface) {
            throw new UnsupportedGeometry('An intersection of two blend boundary surfaces');
        }
        const blend = m.surface(bound.blend);
        if (!(blend instanceof BlendSurface)) {
            throw new UnsupportedGeometry('A blend boundary without its blend');
        }
        let hint: number | undefined;
        const spineParam = (x: V3): number => {
            const t = blend.spine.project(x, hint);
            hint = t;
            return t;
        };
        return {
            onCurve: (x) => other.project(blend.spine.eval(spineParam(x)).p).p,
            error: (x) => Math.max(dist(other.project(x).p, x), tubeDistance(blend, x, hint)),
            tangent: () => null,
        };
    }
    // Successive points lie close together: start each projection from the last one's parameters.
    const hints = new Hints(a, b);
    const onCurve = (x0: V3): V3 => {
        let x = x0;
        for (let i = 0; i < 60; i++) {
            const pa = hints.projectA(x);
            const pb = hints.projectB(x);
            const t = cross(pa.n, pb.n);
            let next: V3;
            if (norm(t) < 0.02) {
                // Nearly tangent: the touching line is found by alternate projection; how far along the
                // surfaces it lies matters little, as they stay within the square of that of each other.
                next = scale(add(pa.p, pb.p), 0.5);
            } else {
                next = solve3(pa.n, dot(pa.n, pa.p), pb.n, dot(pb.n, pb.p), t, dot(t, x)) ?? scale(add(pa.p, pb.p), 0.5);
            }
            const moved = dist(next, x);
            x = next;
            if (moved < 1e-12) {
                break;
            }
        }
        return x;
    };
    return {
        onCurve,
        error: (x) => Math.max(dist(hints.projectA(x).p, x), dist(hints.projectB(x).p, x)),
        tangent: (p) => {
            const t = cross(hints.projectA(p).n, hints.projectB(p).n);
            return norm(t) > 0.05 ? unit(t) : null;
        },
    };
}

/** Projections onto two surfaces, each started from the previous result when it is near. */
class Hints {
    /** Within this distance (mm) the last parameters are a safe start. */
    static readonly NEAR = 0.5;
    private ha: { x: V3; uv: [number, number] } | null = null;
    private hb: { x: V3; uv: [number, number] } | null = null;
    constructor(readonly a: Surface, readonly b: Surface) {}
    projectA(x: V3): Projection {
        const pr = this.a.project(x, this.ha && dist(this.ha.x, x) < Hints.NEAR ? this.ha.uv : undefined);
        this.ha = { x, uv: pr.uv };
        return pr;
    }
    projectB(x: V3): Projection {
        const pr = this.b.project(x, this.hb && dist(this.hb.x, x) < Hints.NEAR ? this.hb.uv : undefined);
        this.hb = { x, uv: pr.uv };
        return pr;
    }
}

/** Solves n1.x = d1, n2.x = d2, n3.x = d3. */
function solve3(n1: V3, d1: number, n2: V3, d2: number, n3: V3, d3: number): V3 | null {
    const c23 = cross(n2, n3);
    const det = dot(n1, c23);
    if (Math.abs(det) < 1e-14) {
        return null;
    }
    const c31 = cross(n3, n1);
    const c12 = cross(n1, n2);
    return scale(add(add(scale(c23, d1), scale(c31, d2)), scale(c12, d3)), 1 / det);
}

function hvecs(values: number[]): V3[] {
    const out: V3[] = [];
    for (let i = 0; i + 2 < values.length; i += 3) {
        out.push([values[i] * MM, values[i + 1] * MM, values[i + 2] * MM]);
    }
    return out;
}

/** Cubic B-spline (C1, double interior knots) through points with unit tangents, chord-length parameters. */
export function hermiteNurbs(pts: CurvePoint[]): Nurbs {
    const cw: number[][] = [];
    const knots: number[] = [0, 0, 0, 0];
    let t = 0;
    const homog = (p: V3): number[] => [p[0], p[1], p[2], 1];
    cw.push(homog(pts[0].p));
    for (let i = 0; i + 1 < pts.length; i++) {
        const h = dist(pts[i].p, pts[i + 1].p);
        cw.push(homog(addScaled(pts[i].p, pts[i].t, h / 3)));
        cw.push(homog(addScaled(pts[i + 1].p, pts[i + 1].t, -h / 3)));
        t += h;
        knots.push(t, t);
    }
    cw.push(homog(pts[pts.length - 1].p));
    knots.splice(knots.length - 2, 2, t, t, t, t);
    return { degree: 3, knots, cw, rational: false };
}

/**
 * Densifies a polyline of points on a curve until the cubic Hermite B-spline through them is within CURVE_TOL
 * of the surfaces defining the curve (tested at span midpoints).
 */
export function densify(start: V3[], rule: CurveRule): CurvePoint[] {
    // Drop repeated points.
    const pts: V3[] = [];
    for (const p of start) {
        if (pts.length === 0 || dist(p, pts[pts.length - 1]) > 1e-7) {
            pts.push(p);
        }
    }
    if (pts.length < 2) {
        throw new UnsupportedGeometry('A curve with fewer than two distinct points');
    }
    const tangentOf = (p: V3, dir: V3, h: number): V3 => {
        const t = rule.tangent(p);
        if (t) {
            return dot(t, dir) < 0 ? scale(t, -1) : t;
        }
        const e = Math.max(1e-6, Math.min(1e-3, h * 1e-3));
        const fd = unit(sub(rule.onCurve(addScaled(p, dir, e)), rule.onCurve(addScaled(p, dir, -e))));
        return norm(fd) > 0 && dot(fd, dir) > 0 ? fd : dir;
    };
    const refined = pts.map((p) => rule.onCurve(p));
    const out: CurvePoint[] = refined.map((p, i) => {
        const prev = refined[Math.max(0, i - 1)];
        const next = refined[Math.min(refined.length - 1, i + 1)];
        const dir = unit(sub(next, prev));
        return { p, t: tangentOf(p, dir, dist(next, prev)) };
    });
    const result: CurvePoint[] = [out[0]];
    let budget = 4000;
    // Halving a span cuts a Hermite error about sixteenfold. When it no longer halves, the error is the noise
    // of the surfaces' own evaluation, and further points would not help.
    const split = (a: CurvePoint, b: CurvePoint, depth: number, parentErr: number): void => {
        const h = dist(a.p, b.p);
        const guess = add(scale(add(a.p, b.p), 0.5), scale(sub(a.t, b.t), h / 8));
        const err = depth >= 14 || h < 1e-6 || budget <= 0 ? 0 : rule.error(guess);
        if (err <= CURVE_TOL || err > parentErr * 0.5) {
            result.push(b);
            return;
        }
        budget--;
        const mid = rule.onCurve(guess);
        const m: CurvePoint = { p: mid, t: tangentOf(mid, unit(sub(b.p, a.p)), h) };
        split(a, m, depth + 1, err);
        split(m, b, depth + 1, err);
    };
    for (let i = 0; i + 1 < out.length; i++) {
        split(out[i], out[i + 1], 0, Infinity);
    }
    return result;
}

function rebuildIntersection(m: XtModel, n: XtNode): Curve {
    const surf = n.f.surface as number[];
    const a = m.surface(surf[0]);
    const b = m.surface(surf[1]);
    const chart = m.need(n.f.chart, 'intersection chart');
    let pts = hvecs(chart.f.hvec as number[]);
    // A terminator lies just outside the chart: its exact position (first hvec) ends the curve.
    const start = m.node(n.f.start);
    const end = m.node(n.f.end);
    const term = (lim: XtNode | undefined): V3 | null => {
        if (!lim || lim.f.type !== 'T') {
            return null;
        }
        return hvecs(lim.f.hvec as number[])[0] ?? null;
    };
    const ts = term(start);
    const te = term(end);
    if (ts && dist(ts, pts[0]) > 1e-7) {
        pts = [ts, ...pts];
    }
    if (te && dist(te, pts[pts.length - 1]) > 1e-7) {
        pts = [...pts, te];
    }
    const rule = intersectionRule(m, a, b);
    // Terminators are singular points: keep them as given.
    const atTerminator = (x: V3): boolean => Boolean((ts && dist(x, ts) < 1e-9) || (te && dist(x, te) < 1e-9));
    const points = densify(pts, {
        onCurve: (x) => (atTerminator(x) ? x : rule.onCurve(x)),
        error: rule.error,
        tangent: (p) => (atTerminator(p) ? null : rule.tangent(p)),
    });
    const closed = start?.f.type === 'H' && dist(pts[0], pts[pts.length - 1]) < 1e-6;
    if (closed) {
        points[points.length - 1] = { p: points[0].p, t: points[0].t };
    }
    return new NurbsCurve(hermiteNurbs(points), false);
}

export const curveBuilder: CurveBuilder = { intersection: rebuildIntersection };

/**
 * An SP-curve on a rolling-ball blend, between two faces. Its (u, v) are in Parasolid's blend parameters (u the
 * spine's chart parameter, v the fraction of the arc from the first support's contact to the second's), which
 * are only reproduced approximately here: u is mapped linearly between the spine positions of the curve's end
 * points. That gives seed points near the curve; they are then refined onto the intersection of the two faces'
 * surfaces, so the result is exact.
 */
export function spCurveOnBlend(m: XtModel, sp: XtNode, ends: [V3, V3], faces: [Surface, Surface]): Curve {
    const blendNode = m.need(sp.f.surface, 'SP-curve surface');
    const blend = m.surface(blendNode.index);
    if (!(blend instanceof BlendSurface)) {
        throw new UnsupportedGeometry('An SP-curve on a blend without its blend');
    }
    const bc = m.need(sp.f.b_curve, 'SP-curve B-curve');
    const uv = m.nurbsCurve(m.need(bc.f.nurbs, 'SP-curve definition'), 1, m.paramScale(blendNode));
    const [t0, t1] = [uv.knots[uv.degree], uv.knots[uv.cw.length]];
    const at = (t: number): V3 => nurbsEval(uv, t).p;
    const [u0, u1] = [at(t0)[0], at(t1)[0]];
    const [s0, s1] = [blend.spine.project(ends[0]), blend.spine.project(ends[1])];
    const spineOf = (u: number): number => (Math.abs(u1 - u0) < 1e-12 ? s0 : s0 + ((u - u0) / (u1 - u0)) * (s1 - s0));
    const negative = m.sense(m.need(blendNode.f.spine, 'blend spine')) < 0;
    const [sa, sb] = negative ? [blend.supports[1], blend.supports[0]] : blend.supports;
    const seed = (t: number): V3 => {
        const [u, v] = at(t);
        const c = blend.spine.eval(spineOf(u)).p;
        if (!sa || !sb) {
            return c;
        }
        const x = sub(sa.project(c).p, c);
        const y0 = sub(sb.project(c).p, c);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(unit(x), unit(y0)))));
        const y = unit(sub(y0, scale(unit(x), dot(y0, unit(x)))));
        return add(c, add(scale(unit(x), blend.r * Math.cos(v * angle)), scale(y, blend.r * Math.sin(v * angle))));
    };
    const n = 16;
    const seeds: V3[] = [ends[0]];
    for (let i = 1; i < n; i++) {
        seeds.push(seed(t0 + ((t1 - t0) * i) / n));
    }
    seeds.push(ends[1]);
    const rule = intersectionRule(m, faces[0], faces[1]);
    const isEnd = (x: V3): boolean => dist(x, ends[0]) < 1e-9 || dist(x, ends[1]) < 1e-9;
    const points = densify(seeds, {
        onCurve: (x) => (isEnd(x) ? x : rule.onCurve(x)),
        error: rule.error,
        tangent: (p) => rule.tangent(p),
    });
    return new NurbsCurve(hermiteNurbs(points), false);
}

// ---- Rolling-ball blend faces --------------------------------------------------------------------------------

/** Rotation-minimising frame step (double reflection) from (x0, t0) to tangent t1. */
function transport(x0: V3, t0: V3, p0: V3, p1: V3, t1: V3): V3 {
    const v1 = sub(p1, p0);
    const c1 = dot(v1, v1);
    // Over a vanishing chord the reflection plane is noise: the frame does not turn.
    if (c1 < 1e-18) {
        return unit(sub(x0, scale(t1, dot(x0, t1))));
    }
    const xl = sub(x0, scale(v1, (2 / c1) * dot(v1, x0)));
    const tl = sub(t0, scale(v1, (2 / c1) * dot(v1, t0)));
    const v2 = sub(t1, tl);
    const c2 = dot(v2, v2);
    const x1 = c2 < 1e-30 ? xl : sub(xl, scale(v2, (2 / c2) * dot(v2, xl)));
    return unit(sub(x1, scale(t1, dot(x1, t1))));
}

export interface BlendPatch {
    surface: NurbsSurf;
    /** Largest deviation from the tube found at test points, mm, and the spine parameter where. */
    error: number;
    errorAt: number;
    /** True when the patch closes on itself along the spine (a ring of blend). */
    uClosed: boolean;
}

/**
 * The part of a blend's tube that covers the given points of a face boundary, as a rational B-spline:
 * u along the spine (cubic, C1), v around it (exact rational quadratic arcs).
 */
export function blendPatch(blend: BlendSurface, boundary: V3[]): BlendPatch {
    const spine = blend.spine;
    const r = blend.r;
    if (!(r > 0)) {
        throw new UnsupportedGeometry('A blend of zero radius');
    }
    // Spine parameters of the boundary points.
    let hint: number | undefined;
    const params = boundary.map((x) => {
        const t = spine.project(x, hint);
        hint = t;
        return t;
    });
    let t0: number;
    let t1: number;
    let uClosed = false;
    if (spine.period) {
        const P = spine.period;
        const base = spine.range[0];
        const sorted = params.map((t) => base + (((t - base) % P) + P) % P).sort((x, y) => x - y);
        let gap = sorted[0] + P - sorted[sorted.length - 1];
        let at = sorted.length - 1;
        for (let i = 0; i + 1 < sorted.length; i++) {
            if (sorted[i + 1] - sorted[i] > gap) {
                gap = sorted[i + 1] - sorted[i];
                at = i;
            }
        }
        if (gap < P * 0.02) {
            t0 = base;
            t1 = base + P;
            uClosed = true;
        } else {
            t0 = sorted[(at + 1) % sorted.length];
            t1 = sorted[at];
            if (t1 <= t0) {
                t1 += P;
            }
        }
    } else {
        t0 = Math.min(...params);
        t1 = Math.max(...params);
    }
    const span = t1 - t0;
    // The face's own extent along the spine: the patch's error is measured there, not in the margins.
    const [faceT0, faceT1] = [t0, t1];
    if (!(span > 0)) {
        throw new UnsupportedGeometry('A blend face without extent along its spine');
    }
    if (!uClosed) {
        const margin = span * 0.02;
        t0 -= margin;
        t1 += margin;
        if (!spine.period) {
            t0 = Math.max(t0, spine.range[0] - margin);
            t1 = Math.min(t1, spine.range[1] + margin);
        }
    }

    // Frames at a fine set of stations; boundary points measured in the nearest one.
    const nFrames = 400;
    const frames: { t: number; c: V3; tan: V3; x: V3 }[] = [];
    for (let i = 0; i <= nFrames; i++) {
        const t = t0 + ((t1 - t0) * i) / nFrames;
        const e = spine.eval(t);
        const tan = unit(e.d);
        let x: V3;
        if (i === 0) {
            // Start towards the boundary points.
            const near = boundary.reduce((best, p) => (dist(p, e.p) < dist(best, e.p) ? p : best), boundary[0]);
            const d = sub(near, e.p);
            x = unit(sub(d, scale(tan, dot(d, tan))));
            if (norm(x) === 0) {
                x = unit(cross(tan, [0.3, 0.5, 0.8]));
            }
        } else {
            const prev = frames[i - 1];
            x = transport(prev.x, prev.tan, prev.c, e.p, tan);
        }
        frames.push({ t, c: e.p, tan, x });
    }
    // The frame at any parameter: transported from the stored frame before it, so it varies smoothly.
    const frameAt = (t: number): { c: V3; tan: V3; x: V3; y: V3 } => {
        const k = Math.max(0, Math.min(nFrames, Math.floor(((t - t0) / (t1 - t0)) * nFrames)));
        const e = spine.eval(t);
        const tan = unit(e.d);
        const f = frames[k];
        const x = transport(f.x, f.tan, f.c, e.p, tan);
        return { c: e.p, tan, x, y: cross(tan, x) };
    };
    // Angular sector of the boundary.
    const angles = boundary.map((p, i) => {
        const f = frameAt(params[i]);
        const d = sub(p, f.c);
        return Math.atan2(dot(d, f.y), dot(d, f.x));
    });
    // The sector is less than a full turn: unwrap about the largest gap.
    const sortedA = [...angles].sort((x, y) => x - y);
    let gapA = sortedA[0] + 2 * Math.PI - sortedA[sortedA.length - 1];
    let atA = sortedA.length - 1;
    for (let i = 0; i + 1 < sortedA.length; i++) {
        if (sortedA[i + 1] - sortedA[i] > gapA) {
            gapA = sortedA[i + 1] - sortedA[i];
            atA = i;
        }
    }
    let a0 = sortedA[(atA + 1) % sortedA.length];
    let a1 = sortedA[atA];
    if (a1 <= a0) {
        a1 += 2 * Math.PI;
    }
    const aMargin = Math.max(0.02, (a1 - a0) * 0.03);
    a0 -= aMargin;
    a1 += aMargin;
    if (a1 - a0 >= 2 * Math.PI - 1e-3) {
        throw new UnsupportedGeometry('A blend face that wraps all the way round its spine');
    }
    const nSeg = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2)));
    const half = (a1 - a0) / nSeg / 2;
    const wMid = Math.cos(half);

    // Arc control points (cartesian) at a spine parameter.
    const arc = (t: number): V3[] => {
        const f = frameAt(t);
        const out: V3[] = [];
        for (let k = 0; k <= 2 * nSeg; k++) {
            const ang = a0 + k * half;
            const rad = k % 2 === 1 ? r / wMid : r;
            out.push(add(f.c, add(scale(f.x, rad * Math.cos(ang)), scale(f.y, rad * Math.sin(ang)))));
        }
        return out;
    };
    // Control points and their derivatives along the spine. The frame's derivative comes from the rotation-
    // minimising frame equations (X' = -(X.T')T, Y' = T' x X), not from differences of stored frames.
    const station = (t: number): { t: number; q: V3[]; dq: V3[] } => {
        const f = frameAt(t);
        const e = spine.eval(t);
        const h = Math.max(1e-9, (t1 - t0) * 1e-6);
        const d2 = scale(sub(spine.eval(t + h).d, spine.eval(t - h).d), 0.5 / h);
        const speed = norm(e.d);
        const dT = scale(sub(d2, scale(f.tan, dot(d2, f.tan))), 1 / speed);
        const dX = scale(f.tan, -dot(f.x, dT));
        const dY = cross(dT, f.x);
        const q: V3[] = [];
        const dq: V3[] = [];
        for (let k = 0; k <= 2 * nSeg; k++) {
            const ang = a0 + k * half;
            const rad = k % 2 === 1 ? r / wMid : r;
            const cs = Math.cos(ang) * rad;
            const sn = Math.sin(ang) * rad;
            q.push(add(f.c, add(scale(f.x, cs), scale(f.y, sn))));
            dq.push(add(e.d, add(scale(dX, cs), scale(dY, sn))));
        }
        return { t, q, dq };
    };
    // Distance from the tube: from the nearest spine point found globally and from the station's own spine
    // parameter (a tight bend of the spine can mislead either search alone), whichever is closer.
    const tubeError = (p: V3, near: number): number => {
        const local = projectNear(spine, p, near, near - (t1 - t0), near + (t1 - t0));
        const global = spine.project(p);
        return Math.min(Math.abs(dist(p, spine.eval(local).p) - r), Math.abs(dist(p, spine.eval(global).p) - r));
    };
    const build = (st: { t: number; q: V3[]; dq: V3[] }[]): NurbsSurf => {
        const uKnots = [st[0].t, st[0].t, st[0].t, st[0].t];
        const rows: V3[][] = [st[0].q];
        for (let i = 0; i + 1 < st.length; i++) {
            const h = st[i + 1].t - st[i].t;
            rows.push(st[i].q.map((q, k) => addScaled(q, st[i].dq[k], h / 3)));
            rows.push(st[i + 1].q.map((q, k) => addScaled(q, st[i + 1].dq[k], -h / 3)));
            uKnots.push(st[i + 1].t, st[i + 1].t);
        }
        rows.push(st[st.length - 1].q);
        const last = st[st.length - 1].t;
        uKnots.splice(uKnots.length - 2, 2, last, last, last, last);
        const vKnots = [0, 0, 0];
        for (let k = 1; k < nSeg; k++) {
            vKnots.push(k, k);
        }
        vKnots.push(nSeg, nSeg, nSeg);
        const cw = rows.map((row) => row.map((q, k) => {
            const w = k % 2 === 1 ? wMid : 1;
            return [q[0] * w, q[1] * w, q[2] * w, w];
        }));
        return { uDegree: 3, vDegree: 2, uKnots, vKnots, cw, rational: true };
    };

    // Adaptive stations: split a span when the patch strays from the tube at its middle.
    const evalPatchPoint = (sa: { t: number; q: V3[]; dq: V3[] }, sb: { t: number; q: V3[]; dq: V3[] }, s: number, k: number): V3 => {
        // Hermite of control point k at fraction s, then the rational arc at the arc's middle parameter.
        const h = sb.t - sa.t;
        const herm = (j: number): V3 => {
            const s2 = s * s;
            const s3 = s2 * s;
            const p0 = sa.q[j];
            const p1 = sb.q[j];
            const m0 = scale(sa.dq[j], h);
            const m1 = scale(sb.dq[j], h);
            return add(add(scale(p0, 2 * s3 - 3 * s2 + 1), scale(m0, s3 - 2 * s2 + s)), add(scale(p1, -2 * s3 + 3 * s2), scale(m1, s3 - s2)));
        };
        // Point of arc segment k at its middle: (P0 + 2 w P1 + P2) / (2 + 2 w) * ... with t = 1/2.
        const p0 = herm(2 * k);
        const p1 = herm(2 * k + 1);
        const p2 = herm(2 * k + 2);
        const den = 0.25 + 0.5 * wMid + 0.25;
        return scale(add(add(scale(p0, 0.25), scale(p1, 0.5 * wMid)), scale(p2, 0.25)), 1 / den);
    };
    const stations: { t: number; q: V3[]; dq: V3[] }[] = [];
    const initial = Math.max(4, Math.ceil(span / (spine.period ? spine.period / 16 : span / 4)));
    let worst = 0;
    let worstAt = t0;
    const refineSpan = (sa: { t: number; q: V3[]; dq: V3[] }, sb: { t: number; q: V3[]; dq: V3[] }, depth: number): void => {
        let err = 0;
        for (const s of [0.25, 0.5, 0.75]) {
            const t = sa.t + (sb.t - sa.t) * s;
            if (!uClosed && (t < faceT0 || t > faceT1)) {
                continue;
            }
            for (let k = 0; k < nSeg; k++) {
                const p = evalPatchPoint(sa, sb, s, k);
                err = Math.max(err, tubeError(p, t));
            }
        }
        if (err <= SURFACE_TOL * 0.5 || depth >= 12) {
            if (err > worst) {
                worst = err;
                worstAt = sa.t;
            }
            stations.push(sb);
            return;
        }
        const mid = station((sa.t + sb.t) / 2);
        refineSpan(sa, mid, depth + 1);
        refineSpan(mid, sb, depth + 1);
    };
    const first = station(t0);
    stations.push(first);
    let prev = first;
    for (let i = 1; i <= initial; i++) {
        const next = station(t0 + ((t1 - t0) * i) / initial);
        refineSpan(prev, next, 0);
        prev = next;
    }
    return { surface: build(stations), error: worst, errorAt: worstAt, uClosed };
}
