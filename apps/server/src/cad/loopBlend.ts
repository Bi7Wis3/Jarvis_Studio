// Fillets and chamfers built section by section along a closed loop of edges, for loops OpenCascade's blend builder
// gives up on. Its builder cannot make the corner where an edge between two faces on one side ends on the loop at a
// point where the faces on either side of the loop meet nearly tangentially or at a knife edge. That is the case at
// both ends of a hole that leaves a curved surface at a shallow angle when the surface is made of several faces (a
// loft), and it fails there at any size.
//
// Here the ball of the fillet radius is rolled into the corner at stations along the loop (for a chamfer the two
// distances are measured off the faces), the faces are cut along the two contact curves, the strips between those
// curves and the loop are dropped and the blend face is sewn in. Constant radius and the three chamfer types only.

import { cast, getOC, localGC, measureArea, type Edge, type Face, type Shape3D } from 'replicad';
import type { Vec3 } from '@jarvis/core';

export type LoopBlend =
    | { kind: 'fillet'; radius: number }
    /** distances[0] is measured on the side of `reference` (else on the first face of the first edge). */
    | { kind: 'chamfer'; distances: [number, number]; reference?: Face }
    /** `distance` on the side of `reference`, the chamfer face at `angle` degrees to it. */
    | { kind: 'chamfer'; distance: number; angle: number; reference?: Face };

/** A blend that cannot be made, with the place where it fails when there is one. */
export class LoopBlendError extends Error {
    constructor(message: string, readonly at?: Vec3) {
        super(message);
    }
}

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => mul(a, 1 / (len(a) || 1));
const fmtPoint = (p: V): string => `(${p.map((x) => Math.round(x * 1000) / 1000).join(', ')})`;
const deg = (radians: number): number => Math.round(radians * 180 / Math.PI * 10) / 10;

// The OpenCascade objects used here are typed loosely: this build's typings miss some overloads.
/* eslint-disable @typescript-eslint/no-explicit-any */
type OC = any;

// ---- Loops ----------------------------------------------------------------------------------------------------

const SAME_POINT = 1e-6;
/** cos(1°), as refs.ts: tangent directions within a degree continue a chain. */
const SMOOTH_COS = Math.cos(Math.PI / 180);

interface Ends { start: V; end: V; startOut: V; endOut: V }

function endsOf(edge: Edge): Ends | null {
    if (edge.isClosed) {
        return null;
    }
    const v = (x: { x: number; y: number; z: number; delete(): void }): V => {
        const out: V = [x.x, x.y, x.z];
        x.delete();
        return out;
    };
    const t0 = unit(v(edge.tangentAt(0)));
    const t1 = unit(v(edge.tangentAt(1)));
    return { start: v(edge.pointAt(0)), end: v(edge.pointAt(1)), startOut: mul(t0, -1), endOut: t1 };
}

/**
 * The closed loops the edges make, each first extended along edges that continue it tangentially (OpenCascade does
 * the same with any edge it is given). Null when an edge is not on a closed loop of exactly two edges per vertex.
 */
export function closedLoops(shape: Shape3D, edges: Edge[]): Edge[][] | null {
    const all = shape.edges;
    const ends = all.map(endsOf);
    const index = (edge: Edge): number => all.findIndex((e) => e.isSame(edge));
    const chosen = new Set(edges.map(index).filter((i) => i >= 0));
    // A closed edge is a loop by itself.
    const single: Edge[][] = [];
    for (const i of [...chosen]) {
        if (!ends[i] && all[i].isClosed) {
            single.push([all[i]]);
            chosen.delete(i);
        }
    }
    const queue = [...chosen];
    while (queue.length) {
        const i = queue.pop()!;
        const a = ends[i];
        if (!a) {
            return null;
        }
        for (const [p, out] of [[a.start, a.startOut], [a.end, a.endOut]] as [V, V][]) {
            for (let j = 0; j < all.length; j++) {
                const b = ends[j];
                if (chosen.has(j) || !b) {
                    continue;
                }
                if ((len(sub(b.start, p)) < SAME_POINT && dot(out, b.startOut) <= -SMOOTH_COS)
                    || (len(sub(b.end, p)) < SAME_POINT && dot(out, b.endOut) <= -SMOOTH_COS)) {
                    chosen.add(j);
                    queue.push(j);
                }
            }
        }
    }
    const left = [...chosen];
    const loops: Edge[][] = [];
    while (left.length) {
        const first = left.shift()!;
        const loop = [first];
        let at = ends[first]!.end;
        while (len(sub(at, ends[first]!.start)) >= SAME_POINT) {
            const next = left.filter((j) => len(sub(ends[j]!.start, at)) < SAME_POINT || len(sub(ends[j]!.end, at)) < SAME_POINT);
            if (next.length !== 1) {
                return null;
            }
            const j = next[0];
            left.splice(left.indexOf(j), 1);
            loop.push(j);
            at = len(sub(ends[j]!.start, at)) < SAME_POINT ? ends[j]!.end : ends[j]!.start;
        }
        if (loop.length < 2) {
            return null;
        }
        loops.push(loop.map((j) => all[j]));
    }
    return [...single, ...loops];
}

// ---- Faces as surfaces ----------------------------------------------------------------------------------------

interface Probe {
    face: Face;
    surface: OC;
    /** The face's parameter box, and the periods of a closed surface (0 if open). */
    box: [number, number, number, number];
    period: [number, number];
    reversed: boolean;
    /** The last foot's parameters: the next point asked about is nearly always close by. */
    last: [number, number] | null;
    project: OC | null;
    p: OC;
    du: OC;
    dv: OC;
    duu: OC;
    dvv: OC;
    duv: OC;
}

interface Foot {
    /** Nearest point on the face's surface (within its parameter bounds), its outward unit normal and the distance. */
    q: V;
    n: V;
    distance: number;
}

function probeOf(oc: OC, r: <T>(x: T) => T, face: Face): Probe {
    const surface = oc.BRep_Tool.Surface(face.wrapped);
    const b = oc.BRepTools.UVBounds(face.wrapped, 0, 0, 0, 0);
    return {
        face, surface, box: [b.UMin, b.UMax, b.VMin, b.VMax],
        period: [surface.IsUPeriodic() ? surface.UPeriod() : 0, surface.IsVPeriodic() ? surface.VPeriod() : 0],
        reversed: face.wrapped.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED,
        last: null, project: null,
        p: r(new oc.gp_Pnt()), du: r(new oc.gp_Vec()), dv: r(new oc.gp_Vec()), duu: r(new oc.gp_Vec()), dvv: r(new oc.gp_Vec()),
        duv: r(new oc.gp_Vec()),
    };
}

const vecOf = (v: OC): V => [v.X(), v.Y(), v.Z()];

/** Point and outward unit normal at (u, v). */
function evalAt(probe: Probe, u: number, v: number): { q: V; n: V } {
    probe.surface.D1(u, v, probe.p, probe.du, probe.dv);
    const n = unit(cross(vecOf(probe.du), vecOf(probe.dv)));
    return { q: vecOf(probe.p), n: probe.reversed ? mul(n, -1) : n };
}

/** Newton from (u, v) on the distance to x, kept in the face's parameter box; null if it does not settle. */
function newtonFoot(probe: Probe, x: V, u: number, v: number): [number, number] | null {
    const [u0, u1, v0, v1] = probe.box;
    const fit = (w: number, lo: number, hi: number, period: number): number => {
        if (period > 0) {
            while (w < lo - 1e-9) w += period;
            while (w > lo + period + 1e-9) w -= period;
            return w;
        }
        return Math.min(hi, Math.max(lo, w));
    };
    for (let it = 0; it < 30; it++) {
        probe.surface.D2(u, v, probe.p, probe.du, probe.dv, probe.duu, probe.dvv, probe.duv);
        const d = sub(vecOf(probe.p), x);
        const su = vecOf(probe.du);
        const sv = vecOf(probe.dv);
        const fu = dot(d, su);
        const fv = dot(d, sv);
        const a11 = dot(su, su) + dot(d, vecOf(probe.duu));
        const a22 = dot(sv, sv) + dot(d, vecOf(probe.dvv));
        const a12 = dot(su, sv) + dot(d, vecOf(probe.duv));
        let det = a11 * a22 - a12 * a12;
        let du: number;
        let dv: number;
        if (Math.abs(det) > 1e-30 && a11 > 0 && a22 > 0 && det > 0) {
            du = -(a22 * fu - a12 * fv) / det;
            dv = -(a11 * fv - a12 * fu) / det;
        } else {
            // Not convex here: a gradient step.
            det = 1;
            du = -fu / (dot(su, su) || 1);
            dv = -fv / (dot(sv, sv) || 1);
        }
        const nu = fit(u + du, u0, u1, probe.period[0]);
        const nv = fit(v + dv, v0, v1, probe.period[1]);
        const moved = Math.hypot((nu - u) * len(su), (nv - v) * len(sv));
        u = nu;
        v = nv;
        if (moved < 1e-10) {
            return [u, v];
        }
    }
    return null;
}

function footOn(oc: OC, probe: Probe, x: V): Foot | null {
    let uv: [number, number] | null = null;
    if (probe.last) {
        uv = newtonFoot(probe, x, probe.last[0], probe.last[1]);
    }
    if (!uv) {
        // A coarse search over the face's parameter box, then Newton; OpenCascade's projection as the last resort.
        const [u0, u1, v0, v1] = probe.box;
        let best = Infinity;
        let start: [number, number] = [(u0 + u1) / 2, (v0 + v1) / 2];
        for (let i = 0; i <= 12; i++) {
            for (let j = 0; j <= 12; j++) {
                const u = u0 + (u1 - u0) * i / 12;
                const v = v0 + (v1 - v0) * j / 12;
                probe.surface.D0(u, v, probe.p);
                const d = len(sub(vecOf(probe.p), x));
                if (d < best) {
                    best = d;
                    start = [u, v];
                }
            }
        }
        uv = newtonFoot(probe, x, start[0], start[1]);
    }
    if (!uv) {
        probe.project ??= new oc.GeomAPI_ProjectPointOnSurf();
        const [u0, u1, v0, v1] = probe.box;
        const p = new oc.gp_Pnt(x[0], x[1], x[2]);
        try {
            probe.project.Init(p, probe.surface, u0, u1, v0, v1, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
            if (!probe.project.IsDone() || probe.project.NbPoints() < 1) {
                return null;
            }
            const { U, V } = probe.project.LowerDistanceParameters(0, 0);
            uv = [U, V];
        } catch {
            return null;
        } finally {
            p.delete();
        }
    }
    probe.last = uv;
    const { q, n } = evalAt(probe, uv[0], uv[1]);
    return { q, n, distance: len(sub(q, x)) };
}

function nearestFoot(oc: OC, side: Probe[], x: V): Foot | null {
    let best: Foot | null = null;
    for (const probe of side) {
        const f = footOn(oc, probe, x);
        if (f && (!best || f.distance < best.distance)) {
            best = f;
        }
    }
    return best;
}

// ---- Stations along the loop ----------------------------------------------------------------------------------

interface Station {
    p: V;
    /** Unit tangent in the direction the loop is walked. */
    t: V;
    /** Outward normals of the face on the left (side A) and on the right (side B) of the loop at p. */
    nA: V;
    nB: V;
    /** Where the station is on the loop, for adding stations in between. */
    edge: number;
    param: number;
}

interface LoopEdge {
    edge: Edge;
    /** +1: walked along the curve's parameter, -1 against it. */
    dir: number;
    first: number;
    last: number;
    curve: OC;
    left: Face;
    right: Face;
}

function orientationIn(oc: OC, face: Face, edge: Edge): string | null {
    const ex = new oc.TopExp_Explorer(face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    try {
        for (; ex.More(); ex.Next()) {
            const e = ex.Current();
            if (e.IsSame(edge.wrapped)) {
                return e.Orientation();
            }
        }
        return null;
    } finally {
        ex.delete();
    }
}

function loopEdges(oc: OC, r: <T>(x: T) => T, shape: Shape3D, loop: Edge[]): LoopEdge[] {
    const out: LoopEdge[] = [];
    let at: V | null = null;
    for (const edge of loop) {
        const curve = r(new oc.BRepAdaptor_Curve(edge.wrapped));
        const first = curve.FirstParameter();
        const last = curve.LastParameter();
        const value = (u: number): V => {
            const p = curve.Value(u);
            const v: V = [p.X(), p.Y(), p.Z()];
            p.delete();
            return v;
        };
        let dir = 1;
        if (at) {
            dir = len(sub(value(first), at)) <= len(sub(value(last), at)) ? 1 : -1;
        } else if (loop.length > 1) {
            // The first edge's direction is set by where the second one joins it.
            const next = loop[1];
            const e = endsOf(next)!;
            const end = value(last);
            dir = Math.min(len(sub(e.start, end)), len(sub(e.end, end))) < SAME_POINT ? 1 : -1;
        }
        at = value(dir > 0 ? last : first);
        const faces = shape.faces.filter((f) => f.edges.some((e) => e.isSame(edge)));
        if (faces.length !== 2) {
            throw new LoopBlendError('an edge of the loop does not lie between exactly two faces', value((first + last) / 2));
        }
        const o = orientationIn(oc, faces[0], edge);
        const forwardIn0 = o === oc.TopAbs_Orientation.TopAbs_FORWARD;
        // A face lies to the left of its edges as they are oriented in it (seen from outside).
        const leftIs0 = forwardIn0 === dir > 0;
        out.push({ edge, dir, first, last, curve, left: leftIs0 ? faces[0] : faces[1], right: leftIs0 ? faces[1] : faces[0] });
    }
    return out;
}

function stationAt(oc: OC, le: LoopEdge, index: number, u: number, sideA: Probe, sideB: Probe): Station {
    const { p: at, t } = pointOn(oc, le, u);
    const fa = footOn(oc, sideA, at);
    const fb = footOn(oc, sideB, at);
    if (!fa || !fb) {
        throw new LoopBlendError('could not find the faces along the loop', at);
    }
    return { p: at, t, nA: fa.n, nB: fb.n, edge: index, param: u };
}

/** Point and unit tangent (in the walking direction) of a loop edge at curve parameter u. */
function pointOn(oc: OC, le: LoopEdge, u: number): { p: V; t: V } {
    const p = new oc.gp_Pnt();
    const d = new oc.gp_Vec();
    le.curve.D1(u, p, d);
    const out = { p: [p.X(), p.Y(), p.Z()] as V, t: unit(mul([d.X(), d.Y(), d.Z()], le.dir)) };
    p.delete();
    d.delete();
    return out;
}

/** Stations at most `step` apart and at most a few degrees of turning apart, from each edge's start in the loop. */
function stations(oc: OC, les: LoopEdge[], probes: Map<Face, Probe>, step: number): Station[] {
    const out: Station[] = [];
    les.forEach((le, i) => {
        const fine = 200;
        const params = Array.from({ length: fine }, (_, k) => le.dir > 0
            ? le.first + (le.last - le.first) * k / fine : le.last - (le.last - le.first) * k / fine);
        const keep: number[] = [params[0]];
        let last = pointOn(oc, le, params[0]);
        let prev = last;
        let run = 0;
        for (let k = 1; k < fine; k++) {
            const s = pointOn(oc, le, params[k]);
            run += len(sub(s.p, prev.p));
            prev = s;
            if (run >= step || dot(s.t, last.t) < Math.cos(3 * Math.PI / 180)) {
                keep.push(params[k]);
                last = s;
                run = 0;
            }
        }
        const A = probes.get(le.left)!;
        const B = probes.get(le.right)!;
        const made = keep.map((u) => stationAt(oc, le, i, u, A, B));
        // Where the loop has a corner (a face edge meeting it can bend it), the section turns about the corner point:
        // stations there with the tangent going round from the previous edge's to this one's.
        const before = les[(i + les.length - 1) % les.length];
        if (les.length > 1 || i > 0) {
            const t0 = pointOn(oc, before, before.dir > 0 ? before.last : before.first).t;
            const t1 = made[0].t;
            const turn = Math.acos(Math.max(-1, Math.min(1, dot(t0, t1))));
            if (turn > MAX_CORNER) {
                throw new LoopBlendError(`the edges meet at a corner of ${deg(turn)}° at ${fmtPoint(made[0].p)}: the blend `
                    + 'cannot turn that corner', made[0].p);
            }
            if (turn > 0.01 * Math.PI / 180) {
                const steps = Math.ceil(turn / (0.5 * Math.PI / 180));
                const axis = unit(cross(t0, t1));
                const corner: Station[] = [];
                for (let k = 0; k < steps; k++) {
                    const a = turn * k / steps;
                    // t0 rotated by a about the axis (t0 is perpendicular to it).
                    const t = unit(add(mul(t0, Math.cos(a)), mul(cross(axis, t0), Math.sin(a))));
                    corner.push({ ...made[0], t });
                }
                made.unshift(...corner);
            }
        }
        out.push(...made);
    });
    return out;
}

/** The largest corner a loop may have for the constructed blend (the section turns about the corner point). */
const MAX_CORNER = 45 * Math.PI / 180;

// ---- Sections -------------------------------------------------------------------------------------------------

interface Section {
    /** Contact (or chamfer) points on side A and side B, and for a fillet the ball centre. */
    a: V;
    b: V;
    c?: V;
}

function solve3(rows: [V, V, V], rhs: V): V | null {
    const [r0, r1, r2] = rows;
    const det = dot(r0, cross(r1, r2));
    if (Math.abs(det) < 1e-14) {
        return null;
    }
    // Cramer's rule with the columns replaced by rhs.
    const c0 = cross(r1, r2);
    const c1 = cross(r2, r0);
    const c2 = cross(r0, r1);
    return mul(add(add(mul(c0, rhs[0]), mul(c1, rhs[1])), mul(c2, rhs[2])), 1 / det);
}

/** Convex edge: the faces meet at less than 180 degrees inside the material. */
function convexAt(s: Station): boolean {
    const intoA = unit(cross(s.nA, s.t));
    return dot(intoA, s.nB) < 0;
}

/** The angle between the faces on the open side of the loop (convex: inside the material). */
function openingAngle(s: Station): number {
    return Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(s.nA, s.nB))));
}

function filletSection(oc: OC, s: Station, sideA: Probe[], sideB: Probe[], radius: number, convex: boolean): Section {
    const sign = convex ? 1 : -1;
    const alpha = openingAngle(s);
    if (alpha < 0.5 * Math.PI / 180) {
        throw new LoopBlendError(`the faces meet at a knife edge of ${deg(alpha)}° at ${fmtPoint(s.p)}: no fillet fits there`, s.p);
    }
    if (alpha > Math.PI - 0.2 * Math.PI / 180) {
        throw new LoopBlendError(`the faces meet tangentially at ${fmtPoint(s.p)}: there is no corner to fillet there`, s.p);
    }
    const tight = 1e-10 * Math.max(1, radius);
    // Depth of c inside the material below a face (negative outside).
    const depth = (c: V, f: Foot): number => -dot(sub(c, f.q), f.n);
    // The ball touching one face of each side, centred in the station's normal plane.
    const roll = (pa: Probe, pb: Probe, from: V): V | null => {
        let c = from;
        for (let it = 0; it < 40; it++) {
            const fa = footOn(oc, pa, c);
            const fb = footOn(oc, pb, c);
            if (!fa || !fb) {
                return null;
            }
            const res: V = [sign * radius - depth(c, fa), sign * radius - depth(c, fb), -dot(sub(c, s.p), s.t)];
            if (Math.abs(res[0]) < tight && Math.abs(res[1]) < tight && Math.abs(res[2]) < 1e-10) {
                return c;
            }
            const step = solve3([mul(fa.n, -1), mul(fb.n, -1), s.t], res);
            if (!step) {
                return null;
            }
            c = add(c, mul(step, Math.min(1, radius / (len(step) || 1))));
        }
        return null;
    };
    // A face of the side the ball cuts into (it must stay clear of all of them).
    const intruder = (side: Probe[], c: V, own: Probe): Probe | null => {
        for (const probe of side) {
            const f = probe === own ? null : footOn(oc, probe, c);
            if (f && f.distance < radius - 1e-7 && sign * depth(c, f) > 0) {
                return probe;
            }
        }
        return null;
    };
    const start = add(s.p, mul(unit(mul(add(s.nA, s.nB), -1)), sign * radius / Math.sin(alpha / 2)));
    const nearest = (side: Probe[], x: V): Probe => {
        let best = side[0];
        let d = Infinity;
        for (const probe of side) {
            const f = footOn(oc, probe, x);
            if (f && f.distance < d) {
                d = f.distance;
                best = probe;
            }
        }
        return best;
    };
    let pa = nearest(sideA, start);
    let pb = nearest(sideB, start);
    const tried = new Set<string>();
    let c: V = start;
    for (let attempt = 0; attempt < 6; attempt++) {
        tried.add(`${sideA.indexOf(pa)},${sideB.indexOf(pb)}`);
        const made = roll(pa, pb, c);
        if (!made) {
            break;
        }
        c = made;
        const xa = intruder(sideA, c, pa);
        const xb = intruder(sideB, c, pb);
        if (!xa && !xb) {
            return { a: footOn(oc, pa, c)!.q, b: footOn(oc, pb, c)!.q, c };
        }
        const next: [Probe, Probe] = xa ? [xa, pb] : [pa, xb!];
        if (tried.has(`${sideA.indexOf(next[0])},${sideB.indexOf(next[1])}`)) {
            // Rolling over a crease between two faces of one side: the ball touches both of them and the other side.
            const [p1, p2, other] = xa ? [pa, xa, pb] : [pb, xb!, pa];
            const k = kinkBall(oc, p1, p2, other, c, radius, sign);
            if (k) {
                const f1 = footOn(oc, p1, k)!;
                const f3 = footOn(oc, other, k)!;
                return xa ? { a: f1.q, b: f3.q, c: k } : { a: f3.q, b: f1.q, c: k };
            }
            break;
        }
        [pa, pb] = next;
    }
    throw new LoopBlendError(`a fillet of ${radius} mm does not fit between the faces at ${fmtPoint(s.p)}, where they meet `
        + `at ${deg(alpha)}°`, s.p);
}

/** The centre of the ball of `radius` touching three faces (two on one side of a crease, one on the other side). */
function kinkBall(oc: OC, p1: Probe, p2: Probe, p3: Probe, start: V, radius: number, sign: number): V | null {
    const tight = 1e-10 * Math.max(1, radius);
    let k = start;
    for (let it = 0; it < 40; it++) {
        const f = [p1, p2, p3].map((p) => footOn(oc, p, k));
        if (f.some((x) => !x)) {
            return null;
        }
        const [f1, f2, f3] = f as Foot[];
        const depth = (x: Foot): number => -dot(sub(k, x.q), x.n);
        const res: V = [sign * radius - depth(f1), sign * radius - depth(f2), sign * radius - depth(f3)];
        if (Math.abs(res[0]) < tight && Math.abs(res[1]) < tight && Math.abs(res[2]) < tight) {
            return k;
        }
        const step = solve3([mul(f1.n, -1), mul(f2.n, -1), mul(f3.n, -1)], res);
        if (!step) {
            return null;
        }
        k = add(k, mul(step, Math.min(1, radius / (len(step) || 1))));
    }
    return null;
}

/** The point on the side's faces at distance `d` from the station, in its normal plane, starting along `dir`. */
function offFace(oc: OC, s: Station, side: Probe[], dir: V, d: number): V {
    let q = add(s.p, mul(dir, d));
    for (let it = 0; it < 30; it++) {
        const f = nearestFoot(oc, side, q);
        if (!f) {
            break;
        }
        let w = sub(f.q, s.p);
        w = sub(w, mul(s.t, dot(w, s.t)));
        const next = add(s.p, mul(unit(w), d));
        const moved = len(sub(next, q));
        q = next;
        if (moved < 1e-11 && f.distance < 1e-9) {
            return q;
        }
    }
    const f = nearestFoot(oc, side, q);
    if (f && f.distance < 1e-7) {
        return f.q;
    }
    throw new LoopBlendError(`the face beside the loop ends within ${d} mm of it at ${fmtPoint(s.p)}`, s.p);
}

function chamferSection(oc: OC, s: Station, sideA: Probe[], sideB: Probe[], dA: number, dB: number | { angle: number }): Section {
    const intoA = unit(cross(s.nA, s.t));
    const intoB = unit(cross(s.t, s.nB));
    let distB: number;
    if (typeof dB === 'number') {
        distB = dB;
    } else {
        // Triangle edge-A-B: angle at the edge between the faces, at A the chamfer's angle to face A.
        const between = Math.acos(Math.max(-1, Math.min(1, dot(intoA, intoB))));
        const third = Math.PI - between - dB.angle * Math.PI / 180;
        if (!(third > 1e-3)) {
            throw new LoopBlendError(`a chamfer at ${dB.angle}° does not reach the other face at ${fmtPoint(s.p)}, where the `
                + `faces meet at ${deg(between)}°`, s.p);
        }
        distB = dA * Math.sin(dB.angle * Math.PI / 180) / Math.sin(third);
    }
    return { a: offFace(oc, s, sideA, intoA, dA), b: offFace(oc, s, sideB, intoB, distB) };
}

// ---- Curves and faces -----------------------------------------------------------------------------------------

/** Periodic cubic through the points at the given parameters (one more than points: the period's end). */
function periodicCurve(oc: OC, r: <T>(x: T) => T, points: V[], params: number[]): OC {
    const pa = r(new oc.NCollection_Array1_gp_Pnt(1, points.length));
    points.forEach((p, i) => {
        const g = new oc.gp_Pnt(p[0], p[1], p[2]);
        pa.SetValue(i + 1, g);
        g.delete();
    });
    const ua = r(new oc.NCollection_Array1_double(1, params.length));
    params.forEach((u, i) => ua.SetValue(i + 1, u));
    const pts = r(new oc.NCollection_HArray1_gp_Pnt(pa));
    const ps = r(new oc.NCollection_HArray1_double(ua));
    const interp = r(new oc.GeomAPI_Interpolate(pts, ps, true, 1e-9));
    interp.Perform();
    if (!interp.IsDone()) {
        throw new LoopBlendError('could not run a curve through the blend sections');
    }
    // The same curve, written as an ordinary closed one: OpenCascade's area and volume integration skips spans of
    // periodic edges whose range does not start at the curve's origin, as edges cut from them do.
    const curve = interp.Curve();
    curve.SetNotPeriodic();
    return curve;
}

/**
 * The face through curves with the same knots (all curves here are made through the same parameters): ruled between
 * two, else a cubic across them at equal steps (the rows of a fillet are at equal angles round its arcs).
 */
function surfaceThrough(oc: OC, r: <T>(x: T) => T, curves: OC[]): OC {
    const first = curves[0];
    const n = first.NbPoles();
    if (curves.some((c) => c.NbPoles() !== n || c.NbKnots() !== first.NbKnots() || c.Degree() !== first.Degree())) {
        throw new LoopBlendError('could not make the blend surface');
    }
    const m = curves.length;
    // Across: each column of poles interpolated through the rows (the same parameters, so the same knots).
    const columns: OC[][] = [];
    let vKnots: OC;
    let vMults: OC;
    let vDegree = 1;
    if (m === 2) {
        columns.push(...Array.from({ length: n }, (_, i) => [first.Pole(i + 1), curves[1].Pole(i + 1)]));
        vKnots = r(new oc.NCollection_Array1_double(1, 2));
        vKnots.SetValue(1, 0);
        vKnots.SetValue(2, 1);
        vMults = r(new oc.NCollection_Array1_int(1, 2));
        vMults.SetValue(1, 2);
        vMults.SetValue(2, 2);
    } else {
        const vs = r(new oc.NCollection_Array1_double(1, m));
        curves.forEach((_, j) => vs.SetValue(j + 1, j / (m - 1)));
        const vParams = r(new oc.NCollection_HArray1_double(vs));
        let across: OC = null;
        for (let i = 1; i <= n; i++) {
            const pa = r(new oc.NCollection_Array1_gp_Pnt(1, m));
            curves.forEach((c, j) => {
                const p = c.Pole(i);
                pa.SetValue(j + 1, p);
                p.delete();
            });
            const interp = r(new oc.GeomAPI_Interpolate(r(new oc.NCollection_HArray1_gp_Pnt(pa)), vParams, false, 1e-12));
            interp.Perform();
            if (!interp.IsDone()) {
                throw new LoopBlendError('could not make the blend surface');
            }
            across = interp.Curve();
            columns.push(Array.from({ length: across.NbPoles() }, (_, k) => across.Pole(k + 1)));
        }
        vKnots = across.Knots();
        vMults = across.Multiplicities();
        vDegree = across.Degree();
    }
    const poles = r(new oc.NCollection_Array2_gp_Pnt(1, n, 1, columns[0].length));
    columns.forEach((col, i) => col.forEach((p, k) => {
        poles.SetValue(i + 1, k + 1, p);
        p.delete();
    }));
    const surface = new oc.Geom_BSplineSurface(poles, first.Knots(), vKnots, first.Multiplicities(), vMults, first.Degree(),
        vDegree, false, false);
    const face = r(new oc.BRepBuilderAPI_MakeFace(surface, 1e-7));
    if (!face.IsDone()) {
        throw new LoopBlendError('could not make the blend surface');
    }
    return face.Face();
}

function curvePoint(oc: OC, curve: OC, u: number): V {
    const p = curve.Value(u);
    const v: V = [p.X(), p.Y(), p.Z()];
    p.delete();
    return v;
}

function facesOfShape(oc: OC, shape: OC): Face[] {
    const out: Face[] = [];
    const ex = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) {
        out.push(cast(oc.TopoDS.Face(ex.Current())) as unknown as Face);
    }
    ex.delete();
    return out;
}

function listOf(oc: OC, r: <T>(x: T) => T, shapes: OC[]): OC {
    const list = r(new oc.NCollection_List_TopoDS_Shape());
    for (const s of shapes) {
        list.Append(s);
    }
    return list;
}

function listItems(oc: OC, list: OC): OC[] {
    const out: OC[] = [];
    const n = list.Size();
    for (let i = 0; i < n; i++) {
        out.push(list.First());
        list.RemoveFirst();
    }
    return out;
}

function boxOf(oc: OC, shape: OC): [V, V] {
    const box = new oc.Bnd_Box();
    try {
        oc.BRepBndLib.Add(shape, box, true);
        const lo = box.CornerMin();
        const hi = box.CornerMax();
        const out: [V, V] = [[lo.X(), lo.Y(), lo.Z()], [hi.X(), hi.Y(), hi.Z()]];
        lo.delete();
        hi.delete();
        return out;
    } finally {
        box.delete();
    }
}

const overlaps = (a: [V, V], b: [V, V]): boolean => [0, 1, 2].every((k) => a[0][k] <= b[1][k] + 1e-6 && b[0][k] <= a[1][k] + 1e-6);

function isValid(oc: OC, shape: OC): boolean {
    const a = new oc.BRepCheck_Analyzer(shape, true, false);
    const ok = a.IsValid();
    a.delete();
    return ok;
}

// ---- The blend ------------------------------------------------------------------------------------------------

export interface LoopBlendInfo {
    stations: number;
    /** Largest error of the blend's shape between stations (fillet: distance from the rolling ball). */
    shape: number;
    /** Largest distance of the contact curves from their faces between stations. */
    deviation: number;
    sewing: number;
}

export function blendLoop(shape: Shape3D, loop: Edge[], blend: LoopBlend, info?: Partial<LoopBlendInfo>): Shape3D {
    const oc = getOC() as OC;
    const [r, gc] = localGC();
    try {
        return build(oc, r as <T>(x: T) => T, shape, loop, blend, info);
    } finally {
        gc();
    }
}

function build(oc: OC, r: <T>(x: T) => T, shape: Shape3D, loop: Edge[], blend: LoopBlend,
    info?: Partial<LoopBlendInfo>): Shape3D {
    const les = loopEdges(oc, r, shape, loop);
    const probes = new Map<Face, Probe>();
    const sideFaces = (pick: (le: LoopEdge) => Face): Face[] => {
        const out: Face[] = [];
        for (const le of les) {
            if (!out.some((f) => f.isSame(pick(le)))) {
                out.push(pick(le));
            }
        }
        return out;
    };
    const facesA = sideFaces((le) => le.left);
    const facesB = sideFaces((le) => le.right);
    if (facesA.some((f) => facesB.some((g) => g.isSame(f)))) {
        throw new LoopBlendError('the loop has the same face on both sides');
    }
    // Probes keyed by the faces the loop edges name, the side lists use the same probes.
    const probeFor = (face: Face): Probe => {
        for (const [f, p] of probes) {
            if (f.isSame(face)) {
                probes.set(face, p);
                return p;
            }
        }
        const p = probeOf(oc, r, face);
        probes.set(face, p);
        return p;
    };
    const sideA = facesA.map(probeFor);
    const sideB = facesB.map(probeFor);
    les.forEach((le) => {
        probeFor(le.left);
        probeFor(le.right);
    });

    const size = blend.kind === 'fillet' ? blend.radius
        : 'distances' in blend ? Math.max(...blend.distances) : blend.distance;
    // Which side the first distance of a chamfer is measured on.
    let refIsA = true;
    if (blend.kind === 'chamfer' && blend.reference) {
        const ref = blend.reference;
        refIsA = facesA.some((f) => f.isSame(ref)) || !facesB.some((f) => f.isSame(ref));
    }
    const st = stations(oc, les, probes, Math.min(0.5, Math.max(0.05, 2 * size)));
    const convex = convexAt(st[0]);
    for (const s of st) {
        if (convexAt(s) !== convex) {
            throw new LoopBlendError(`the edge turns from ${convex ? 'convex to concave' : 'concave to convex'} at `
                + `${fmtPoint(s.p)}: a blend along it cannot be made this way`, s.p);
        }
    }
    const sectionOf = (s: Station): Section => {
        if (blend.kind === 'fillet') {
            return filletSection(oc, s, sideA, sideB, blend.radius, convex);
        }
        const [first, second] = 'distances' in blend ? blend.distances : [blend.distance, blend.distance];
        if ('angle' in blend) {
            if (refIsA) {
                return chamferSection(oc, s, sideA, sideB, blend.distance, { angle: blend.angle });
            }
            const flipped = chamferSection(oc, { ...s, t: mul(s.t, -1), nA: s.nB, nB: s.nA }, sideB, sideA, blend.distance,
                { angle: blend.angle });
            return { a: flipped.b, b: flipped.a };
        }
        return chamferSection(oc, s, sideA, sideB, refIsA ? first : second, refIsA ? second : first);
    };
    const sections = st.map(sectionOf);

    // Parameters: mean chord length of the two contact curves (the rim itself can turn much faster than they do).
    // (Where a contact curve crosses a crease between two faces of one side it has a small kink, which the curves
    // follow to within `deviation`; that is sewn over.)
    const paramsOf = (): number[] => {
        const out = [0];
        for (let k = 1; k <= sections.length; k++) {
            const x = sections[k % sections.length];
            const y = sections[k - 1];
            out.push(out[k - 1] + (len(sub(x.a, y.a)) + len(sub(x.b, y.b))) / 2);
        }
        return out;
    };
    // The point at fraction f of the way round the fillet's arc from side A to side B.
    const arcPoint = (x: Section, f: number): V => {
        const u = unit(sub(x.a, x.c!));
        const v = unit(sub(x.b, x.c!));
        const phi = Math.atan2(len(cross(u, v)), dot(u, v));
        const w = unit(sub(v, mul(u, dot(u, v))));
        return add(x.c!, mul(add(mul(u, Math.cos(f * phi)), mul(w, Math.sin(f * phi))), (blend as { radius: number }).radius));
    };
    interface Curves { params: number[]; curve: (pts: V[]) => OC; a: OC; b: OC }
    const curvesOf = (): Curves => {
        const params = paramsOf();
        const curve = (pts: V[]): OC => periodicCurve(oc, r, pts, params);
        return { params, curve, a: curve(sections.map((x) => x.a)), b: curve(sections.map((x) => x.b)) };
    };
    // Add stations where the curves through them stray between stations: the contact curves from their faces, and for
    // a fillet the centre curve from its distance to the faces and the arc's middle from its distance to the centre.
    const tolerance = 1e-6;
    let deviation = 0;
    let rc = curvesOf();
    const rounds = 7;
    for (let round = 0; round < rounds; round++) {
        if (round > 0) {
            rc = curvesOf();
        }
        deviation = 0;
        let shapeError = 0;
        const refine: number[] = [];
        const centres = blend.kind === 'fillet' ? rc.curve(sections.map((x) => x.c!)) : null;
        const middles = blend.kind === 'fillet' ? rc.curve(sections.map((x) => arcPoint(x, 0.5))) : null;
        for (let i = 0; i < sections.length; i++) {
            const u = (rc.params[i] + rc.params[i + 1]) / 2;
            const fa = nearestFoot(oc, sideA, curvePoint(oc, rc.a, u));
            const fb = nearestFoot(oc, sideB, curvePoint(oc, rc.b, u));
            const d = Math.max(fa ? fa.distance : Infinity, fb ? fb.distance : Infinity);
            let e = 0;
            if (centres && middles && blend.kind === 'fillet') {
                const c = curvePoint(oc, centres, u);
                const ca = nearestFoot(oc, sideA, c);
                const cb = nearestFoot(oc, sideB, c);
                e = Math.max(ca ? Math.abs(ca.distance - blend.radius) : Infinity, cb ? Math.abs(cb.distance - blend.radius) : Infinity,
                    Math.abs(len(sub(curvePoint(oc, middles, u), c)) - blend.radius));
            }
            deviation = Math.max(deviation, d);
            shapeError = Math.max(shapeError, e);
            // Where the loop has a corner the curves have a kink and only follow it ever closer: stop at a few microns.
            const short = len(sub(st[(i + 1) % st.length].p, st[i].p)) < 0.004;
            if ((d > tolerance || e > 10 * tolerance) && !short) {
                refine.push(i);
            }
        }
        if (info) {
            info.shape = shapeError;
        }
        if (!refine.length || round === rounds - 1) {
            break;
        }
        const added: { at: number; s: Station }[] = [];
        for (const i of refine) {
            const s0 = st[i];
            const s1 = st[(i + 1) % st.length];
            const le = les[s0.edge];
            // Halfway in the edge's parameter, or to the end of the edge when the next station is on the next edge.
            const end = s1.edge === s0.edge && i + 1 < st.length && s1.param !== s0.param ? s1.param : (le.dir > 0 ? le.last : le.first);
            const u = (s0.param + end) / 2;
            added.push({ at: i + 1, s: stationAt(oc, le, s0.edge, u, probeFor(le.left), probeFor(le.right)) });
        }
        for (const { at, s } of added.sort((x, y) => y.at - x.at)) {
            st.splice(at, 0, s);
            sections.splice(at, 0, sectionOf(s));
        }
    }
    if (info) {
        info.stations = st.length;
        info.deviation = deviation;
    }
    // Round a corner of the loop that turns towards one side's face, the blend's edge on that side would run back over
    // itself (it needs a mitre there, which this construction does not make): say so rather than fold the face.
    for (let i = 0; i < st.length; i++) {
        const j = (i + 1) % st.length;
        const along = add(st[i].t, st[j].t);
        for (const key of ['a', 'b'] as const) {
            const back = -dot(sub(sections[j][key], sections[i][key]), along);
            if (back > 1e-5 * Math.max(1, size)) {
                throw new LoopBlendError(`the ${blend.kind} would fold over itself at ${fmtPoint(st[i].p)}, where the edges `
                    + 'bend round a corner (a face edge meets them there): on the inside of that corner it needs a mitre, '
                    + 'which is not made yet', st[i].p);
            }
        }
    }

    // The blend face: rows across the section (for a fillet, points at equal angles round each arc), each a curve
    // through the stations, and the surface through the rows.
    let blendShape: OC;
    if (blend.kind === 'fillet') {
        const widest = Math.max(...sections.map((x) => {
            const u = unit(sub(x.a, x.c!));
            const v = unit(sub(x.b, x.c!));
            return Math.atan2(len(cross(u, v)), dot(u, v));
        }));
        const rows = Math.max(4, Math.ceil(widest / (12 * Math.PI / 180)));
        const curves: OC[] = [rc.a];
        for (let j = 1; j < rows; j++) {
            curves.push(rc.curve(sections.map((x) => arcPoint(x, j / rows))));
        }
        curves.push(rc.b);
        blendShape = surfaceThrough(oc, r, curves);
    } else {
        blendShape = surfaceThrough(oc, r, [rc.a, rc.b]);
    }
    const blendFaces = facesOfShape(oc, blendShape);

    // The blend must not reach any face other than those beside the loop.
    const box = boxOf(oc, blendShape);
    const near = shape.faces.filter((f) => !facesA.some((g) => g.isSame(f)) && !facesB.some((g) => g.isSame(f))
        && overlaps(box, boxOf(oc, f.wrapped)));
    if (near.length) {
        const builder = r(new oc.TopoDS_Builder());
        const comp = r(new oc.TopoDS_Compound());
        builder.MakeCompound(comp);
        near.forEach((f) => builder.Add(comp, f.wrapped));
        const dss = r(new oc.BRepExtrema_DistShapeShape());
        dss.LoadS1(blendShape);
        dss.LoadS2(comp);
        dss.Perform(r(new oc.Message_ProgressRange()));
        if (dss.IsDone() && dss.Value() < 1e-6) {
            const p = dss.PointOnShape1(1);
            const at: V = [p.X(), p.Y(), p.Z()];
            p.delete();
            throw new LoopBlendError(`the ${blend.kind} runs into another face at ${fmtPoint(at)}: it is too large to fit there`, at);
        }
    }

    // Cut the faces along the contact curves: the curves lie on them (to within `deviation`).
    const contact = [rc.a, rc.b].map((c) => r(new oc.BRepBuilderAPI_MakeEdge(c)).Edge());
    // Only the faces beside the loop are cut; the others keep their edges and are sewn back unchanged.
    const sideFacesAll = [...facesA, ...facesB];
    const others = shape.faces.filter((f) => !sideFacesAll.some((g) => g.isSame(f)));
    const splitter = r(new oc.BRepAlgoAPI_Splitter());
    splitter.SetArguments(listOf(oc, r, sideFacesAll.map((f) => f.wrapped)));
    splitter.SetTools(listOf(oc, r, contact));
    splitter.SetFuzzyValue(Math.max(1e-7, 2 * deviation));
    splitter.SetUseOBB(true);
    splitter.Build(r(new oc.Message_ProgressRange()));
    if (!splitter.IsDone()) {
        throw new LoopBlendError('could not cut the faces along the blend');
    }
    const pieces = [...facesOfShape(oc, splitter.Shape()), ...others];
    const imagesOf = (edges: OC[]): OC[] => edges.flatMap((e) => {
        const mod = listItems(oc, splitter.Modified(e));
        return mod.length ? mod : [e];
    });
    const contactPieces = imagesOf(contact);
    const isSection = (e: Edge): boolean => contactPieces.some((s) => s.IsSame(e.wrapped));
    const sectionEdges = contactPieces;
    // Pieces of the loop edges.
    const loopPieces = imagesOf(loop.map((e) => e.wrapped));
    const onLoop = (e: Edge): boolean => loopPieces.some((l) => l.IsSame(e.wrapped));
    // Strips: pieces reached from the loop without crossing a contact curve.
    const strip = new Set<number>();
    const queue: number[] = [];
    pieces.forEach((f, i) => {
        if (f.edges.some(onLoop)) {
            strip.add(i);
            queue.push(i);
        }
    });
    // Slivers the cutting leaves where a contact curve crosses a face edge at a kink (narrower than a micron) go too:
    // sewing closes them.
    pieces.forEach((f, i) => {
        if (i < pieces.length - others.length) {
            const area = measureArea(f);
            const perimeter = f.edges.reduce((sum, e) => sum + e.length, 0);
            if (area < 1e-3 && 2 * area / (perimeter || 1) < 1e-3) {
                strip.add(i);
            }
        }
    });
    const pieceEdges = pieces.map((f) => f.edges);
    while (queue.length) {
        const i = queue.pop()!;
        for (const e of pieceEdges[i]) {
            if (isSection(e)) {
                continue;
            }
            pieces.forEach((_, j) => {
                if (!strip.has(j) && pieceEdges[j].some((x) => x.isSame(e))) {
                    strip.add(j);
                    queue.push(j);
                }
            });
        }
    }
    // The strips must be narrow bands along the loop, no more than about the blend's width.
    let expected = 0;
    for (let i = 0; i < st.length; i++) {
        const step = len(sub(st[(i + 1) % st.length].p, st[i].p));
        expected += step * (len(sub(sections[i].a, st[i].p)) + len(sub(sections[i].b, st[i].p)));
    }
    const stripArea = [...strip].reduce((sum, i) => sum + measureArea(pieces[i]), 0);
    if (strip.size === pieces.length || stripArea > 1.5 * expected + 1e-6) {
        throw new LoopBlendError(`the ${blend.kind} could not be trimmed into the faces next to the edges: a contact curve `
            + 'runs off its face');
    }

    // Sew the remaining pieces and the blend face into a solid.
    let lastWhy = 'the faces could not be joined';
    // Where a face edge meets the loop the contact curves have a kink, which the smooth curves only follow to within
    // `deviation`: sew to a little more than that.
    for (const tol of [1e-6, 1e-5, 1e-4, 2e-4, 5e-4, 1e-3].filter((t) => t > 2 * deviation)) {
        const sewing = r(new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false));
        pieces.forEach((f, i) => {
            if (!strip.has(i)) {
                sewing.Add(f.wrapped);
            }
        });
        blendFaces.forEach((f) => sewing.Add(f.wrapped));
        sewing.Perform(r(new oc.Message_ProgressRange()));
        const sewn = sewing.SewedShape();
        if (sewn.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL || sewing.NbFreeEdges() > 0) {
            lastWhy = `${sewing.NbFreeEdges()} edges stayed open`;
            continue;
        }
        const solid = cast(r(new oc.ShapeFix_Solid()).SolidFromShell(oc.TopoDS.Shell(sewn))) as Shape3D;
        if (!solid.solids || solid.solids.length !== 1 || !isValid(oc, solid.wrapped)) {
            lastWhy = 'the joined faces do not make a valid solid';
            continue;
        }
        if (info) {
            info.sewing = tol;
        }
        return solid.solids[0];
    }
    throw new LoopBlendError(`the ${blend.kind} could not be joined to the faces next to the edges (${lastWhy})`);
}
