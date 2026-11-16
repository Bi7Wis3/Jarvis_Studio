// Constant fillets and chamfers built from their true cross-sections, for edges OpenCascade's blend builder refuses
// (applied.ts tries this after its own builder, the loop blend and the run-out blend).
//
// The picked edges are grouped into chains (edges joined end to end that carry on smoothly). Along each chain,
// stations are placed and the blend's section is solved in the plane across the edge: for a fillet the ball of the
// radius touching both faces' surfaces (Newton on the two surfaces), for a chamfer the points at the distances along
// each face. Curves through the stations give the blend surface, refined until it lies within TOLERANCE of the true
// blend between stations; faces that follow the body's faces just outside it (outside corners) or just inside it
// (inside corners) close it into a solid, which is cut away or joined on.
//
// A fillet's surface touches the faces beside the edge tangentially, and OpenCascade's booleans find such contacts
// only now and then. So a fillet is made in two steps: the solid closed by its chord (which meets the faces at an
// angle) is cut away or joined on, then the circular segment between chord and arc is put back or taken away, glued
// along the chord's face (no intersections are computed in that step).
//
// At an open end the solids run on past the end where the faces there fall away from it, and are clipped by the
// surface of a face that rises across their path (a wall) or, at an inside corner, of the face the corner ends on.
// Chamfers that meet at a vertex overlap there: the corner is where they intersect. Fillets are made chain by chain,
// each on the body the ones before left, so a later one runs into the earlier ones. Neither is SolidWorks' rounded
// corner patch, and there are no setbacks.

import { cast, getOC, localGC, type Edge, type Face, type Shape3D } from 'replicad';
import { faceAngleAlong } from './edgeContinuity.js';

export type SectionBlend =
    | { kind: 'fillet'; radius: number }
    /** distances[0] on `reference`'s side (else on the first face of each chain). */
    | { kind: 'chamfer'; distances: [number, number]; reference?: (edge: Edge) => Face }
    /** `distance` on `reference`'s side, the chamfer face at `angle` degrees to that face. */
    | { kind: 'chamfer'; distance: number; angle: number; reference?: (edge: Edge) => Face };

/** A blend this way cannot make, with the place where it fails when there is one. */
export class SectionBlendError extends Error {
    constructor(message: string, readonly at?: V) {
        super(message);
    }
}

export interface SectionBlendInfo {
    chains: number;
    stations: number;
    /** Largest error between stations of the curves through them, as refined (mm). */
    fit: number;
    /** Largest distance of points sampled on the made blend faces from the true blend (mm). */
    error: number;
    /** Volume removed (negative) or added, and as expected from the sections. */
    change: number;
    expected: number;
    /** How many points of the blend faces were measured. */
    points: number;
    /** The solids cut away or joined on, one per chain. */
    tools: { volume: number; valid: boolean; inside: boolean }[];
}

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => mul(a, 1 / (len(a) || 1));
const mid = (a: V, b: V): V => mul(add(a, b), 0.5);
const fmtPoint = (p: V): string => `(${p.map((x) => Math.round(x * 1000) / 1000).join(', ')})`;
const deg = (radians: number): number => Math.round(radians * 180 / Math.PI * 10) / 10;

// The OpenCascade objects are typed loosely: this build's typings miss some overloads.
/* eslint-disable @typescript-eslint/no-explicit-any */
type OC = any;
type R = <T>(x: T) => T;

/** How closely the blend surface between stations must follow the true blend (mm). */
const TOLERANCE = 1e-4;
/** Results whose sampled blend faces stray further than this from the true blend are refused (mm). */
const REFUSE = 5e-3;
/** Points closer than this are the same (mm). */
const SAME_POINT = 1e-6;
/** Edges whose directions at a shared vertex are within 2 degrees continue a chain. */
const SMOOTH_COS = Math.cos(2 * Math.PI / 180);
/** An end face whose normal is within this (as a cosine) of square to the chain counts as in line with it. */
const IN_LINE = 0.02;

function solve3(rows: [V, V, V], rhs: V): V | null {
    const [r0, r1, r2] = rows;
    const det = dot(r0, cross(r1, r2));
    if (Math.abs(det) < 1e-14) {
        return null;
    }
    const c0 = cross(r1, r2);
    const c1 = cross(r2, r0);
    const c2 = cross(r0, r1);
    return mul(add(add(mul(c0, rhs[0]), mul(c1, rhs[1])), mul(c2, rhs[2])), 1 / det);
}

// ---- Surfaces ---------------------------------------------------------------------------------------------------

/** A face's surface, evaluated without its trimming (so a blend can be solved a little past the face's edges). */
interface Probe {
    face: Face;
    surface: OC;
    reversed: boolean;
    period: [number, number];
    /** The surface's own parameter range (infinite for planes and the like). */
    bounds: [number, number, number, number];
    /** The face's parameter box. */
    box: [number, number, number, number];
    /** The last foot's parameters: the next point asked about is nearly always close by. */
    uv: [number, number] | null;
    project: OC | null;
    p: OC;
    du: OC;
    dv: OC;
    duu: OC;
    dvv: OC;
    duv: OC;
}

interface Foot {
    q: V;
    /** Outward unit normal of the face at q. */
    n: V;
    uv: [number, number];
    distance: number;
}

const vecOf = (v: OC): V => [v.X(), v.Y(), v.Z()];

function probeOf(oc: OC, r: R, face: Face): Probe {
    const surface = oc.BRep_Tool.Surface(face.wrapped);
    const b = oc.BRepTools.UVBounds(face.wrapped, 0, 0, 0, 0);
    const n = surface.Bounds(0, 0, 0, 0);
    return {
        face, surface,
        reversed: face.wrapped.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED,
        period: [surface.IsUPeriodic() ? surface.UPeriod() : 0, surface.IsVPeriodic() ? surface.VPeriod() : 0],
        bounds: [n.U1, n.U2, n.V1, n.V2],
        box: [b.UMin, b.UMax, b.VMin, b.VMax],
        uv: null, project: null,
        p: r(new oc.gp_Pnt()), du: r(new oc.gp_Vec()), dv: r(new oc.gp_Vec()), duu: r(new oc.gp_Vec()),
        dvv: r(new oc.gp_Vec()), duv: r(new oc.gp_Vec()),
    };
}

interface Derivatives {
    p: V;
    su: V;
    sv: V;
    suu: V;
    svv: V;
    suv: V;
}

/**
 * Point and derivatives at (u, v). Past the end of a bounded surface's own range (a spline face that ends where the
 * blend has to run on), the surface is carried on along its tangents at that end (G1).
 */
function derivatives(probe: Probe, u: number, v: number): Derivatives {
    const [u0, u1, v0, v1] = probe.bounds;
    const cu = probe.period[0] > 0 ? u : Math.min(u1, Math.max(u0, u));
    const cv = probe.period[1] > 0 ? v : Math.min(v1, Math.max(v0, v));
    probe.surface.D2(cu, cv, probe.p, probe.du, probe.dv, probe.duu, probe.dvv, probe.duv);
    const d: Derivatives = {
        p: vecOf(probe.p), su: vecOf(probe.du), sv: vecOf(probe.dv), suu: vecOf(probe.duu), svv: vecOf(probe.dvv), suv: vecOf(probe.duv),
    };
    const eu = u - cu;
    const ev = v - cv;
    if (eu === 0 && ev === 0) {
        return d;
    }
    return {
        p: add(add(add(d.p, mul(d.su, eu)), mul(d.sv, ev)), mul(d.suv, eu * ev)),
        su: add(d.su, mul(d.suv, ev)),
        sv: add(d.sv, mul(d.suv, eu)),
        suu: eu !== 0 ? [0, 0, 0] : d.suu,
        svv: ev !== 0 ? [0, 0, 0] : d.svv,
        suv: d.suv,
    };
}

/** Point and outward unit normal at (u, v); null where the surface has no normal (a pole). */
function evalAt(probe: Probe, u: number, v: number): { q: V; n: V } | null {
    const d = derivatives(probe, u, v);
    const c = cross(d.su, d.sv);
    if (len(c) < 1e-14) {
        return null;
    }
    const n = unit(c);
    return { q: d.p, n: probe.reversed ? mul(n, -1) : n };
}

/**
 * Newton from (u, v) on the distance to x, kept within the surface's range carried on by as much again past each end;
 * null if it does not settle.
 */
function newtonFoot(probe: Probe, x: V, u: number, v: number): [number, number] | null {
    const [u0, u1, v0, v1] = probe.bounds;
    const fit = (w: number, lo: number, hi: number, period: number): number => {
        if (period > 0 || !Number.isFinite(hi - lo)) {
            return w;
        }
        return Math.min(hi + (hi - lo), Math.max(lo - (hi - lo), w));
    };
    for (let it = 0; it < 40; it++) {
        const s = derivatives(probe, u, v);
        const d = sub(s.p, x);
        const su = s.su;
        const sv = s.sv;
        const fu = dot(d, su);
        const fv = dot(d, sv);
        const a11 = dot(su, su) + dot(d, s.suu);
        const a22 = dot(sv, sv) + dot(d, s.svv);
        const a12 = dot(su, sv) + dot(d, s.suv);
        const det = a11 * a22 - a12 * a12;
        let du: number;
        let dv: number;
        if (Math.abs(det) > 1e-30 && a11 > 0 && a22 > 0 && det > 0) {
            du = -(a22 * fu - a12 * fv) / det;
            dv = -(a11 * fv - a12 * fu) / det;
        } else {
            du = -fu / (dot(su, su) || 1);
            dv = -fv / (dot(sv, sv) || 1);
        }
        // Not more than a fair step at a time (in model units).
        const step = Math.hypot(du * len(su), dv * len(sv));
        const limit = Math.max(1, len(d));
        if (step > limit) {
            du *= limit / step;
            dv *= limit / step;
        }
        const nu = fit(u + du, u0, u1, probe.period[0]);
        const nv = fit(v + dv, v0, v1, probe.period[1]);
        const moved = Math.hypot((nu - u) * len(su), (nv - v) * len(sv));
        u = nu;
        v = nv;
        if (moved < 1e-11) {
            return [u, v];
        }
    }
    return null;
}

/** The nearest point of the face's surface to x (from the last foot when there is one). */
function footOn(oc: OC, probe: Probe, x: V, start?: [number, number] | null): Foot | null {
    let uv: [number, number] | null = null;
    const from = start ?? probe.uv;
    if (from) {
        uv = newtonFoot(probe, x, from[0], from[1]);
    }
    if (!uv) {
        // A coarse search over the face's box, then Newton; OpenCascade's projection as the last resort.
        const [u0, u1, v0, v1] = probe.box;
        let best = Infinity;
        let seed: [number, number] = [(u0 + u1) / 2, (v0 + v1) / 2];
        for (let i = 0; i <= 10; i++) {
            for (let j = 0; j <= 10; j++) {
                const u = u0 + (u1 - u0) * i / 10;
                const v = v0 + (v1 - v0) * j / 10;
                probe.surface.D0(u, v, probe.p);
                const d = len(sub(vecOf(probe.p), x));
                if (d < best) {
                    best = d;
                    seed = [u, v];
                }
            }
        }
        uv = newtonFoot(probe, x, seed[0], seed[1]);
    }
    if (!uv) {
        probe.project ??= new oc.GeomAPI_ProjectPointOnSurf();
        const [u0, u1, v0, v1] = probe.box;
        const du = (u1 - u0) * 0.5;
        const dv = (v1 - v0) * 0.5;
        const p = new oc.gp_Pnt(x[0], x[1], x[2]);
        try {
            probe.project.Init(p, probe.surface, u0 - du, u1 + du, v0 - dv, v1 + dv, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
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
    const at = evalAt(probe, uv[0], uv[1]);
    if (!at) {
        return null;
    }
    probe.uv = uv;
    return { q: at.q, n: at.n, uv, distance: len(sub(at.q, x)) };
}

/** Distance from a point to a (bounded) shape. */
function distanceTo(oc: OC, r: R, p: V, shape: OC): number {
    const v = r(new oc.BRepBuilderAPI_MakeVertex(r(new oc.gp_Pnt(p[0], p[1], p[2])))).Vertex();
    const dss = r(new oc.BRepExtrema_DistShapeShape());
    dss.LoadS1(v);
    dss.LoadS2(shape);
    dss.Perform(r(new oc.Message_ProgressRange()));
    return dss.IsDone() ? dss.Value() : Infinity;
}

// ---- Chains -----------------------------------------------------------------------------------------------------

interface Link {
    edge: Edge;
    /** +1: walked along the curve's parameter, -1 against it. */
    dir: number;
    first: number;
    last: number;
    curve: OC;
    /** The face on the left of the walking direction (seen from outside) and the one on the right. */
    left: Probe;
    right: Probe;
}

interface Chain {
    links: Link[];
    closed: boolean;
    /** The ends of an open chain: point, outward direction and the vertex. */
    ends: { at: V; out: V; vertex: OC }[];
}

function orientationIn(oc: OC, face: OC, edge: OC): string | null {
    const ex = new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    try {
        for (; ex.More(); ex.Next()) {
            if (ex.Current().IsSame(edge)) {
                return ex.Current().Orientation();
            }
        }
        return null;
    } finally {
        ex.delete();
    }
}

function subShapes(oc: OC, shape: OC, type: OC): OC[] {
    const out: OC[] = [];
    const ex = new oc.TopExp_Explorer(shape, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) {
        out.push(ex.Current());
    }
    ex.delete();
    return out;
}

function pointOf(oc: OC, vertex: OC): V {
    const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex));
    const out = vecOf(p);
    p.delete();
    return out;
}

/** Point and unit tangent (in the walking direction) of a link at curve parameter w. */
function pointOn(oc: OC, link: Link, w: number): { p: V; t: V } {
    const p = new oc.gp_Pnt();
    const d = new oc.gp_Vec();
    link.curve.D1(w, p, d);
    const out = { p: vecOf(p), t: unit(mul(vecOf(d), link.dir)) };
    p.delete();
    d.delete();
    return out;
}

interface EdgeInfo {
    edge: Edge;
    faces: Face[];
    v0: OC;
    v1: OC;
    p0: V;
    p1: V;
    /** Unit tangents pointing out of the edge at its start and its end. */
    out0: V;
    out1: V;
    closed: boolean;
}

function edgeInfo(oc: OC, r: R, edge: Edge, faces: Face[]): EdgeInfo {
    const curve = r(new oc.BRepAdaptor_Curve(edge.wrapped));
    const first = curve.FirstParameter();
    const last = curve.LastParameter();
    const at = (w: number): { p: V; t: V } => {
        const p = new oc.gp_Pnt();
        const d = new oc.gp_Vec();
        curve.D1(w, p, d);
        const out = { p: vecOf(p), t: unit(vecOf(d)) };
        p.delete();
        d.delete();
        return out;
    };
    const s = at(first);
    const e = at(last);
    const vertices = subShapes(oc, edge.wrapped, oc.TopAbs_ShapeEnum.TopAbs_VERTEX);
    // The vertex at the curve's start and the one at its end (an edge's own orientation may reverse them).
    const near = (p: V): OC => vertices.reduce((best, v) => (len(sub(pointOf(oc, v), p)) < len(sub(pointOf(oc, best), p)) ? v : best), vertices[0]);
    return {
        edge, faces, v0: near(s.p), v1: near(e.p), p0: s.p, p1: e.p, out0: mul(s.t, -1), out1: e.t,
        closed: edge.isClosed || len(sub(s.p, e.p)) < SAME_POINT,
    };
}

/** The faces of the shape beside each edge (one pass over the faces). */
function facesBeside(oc: OC, shape: Shape3D, edges: Edge[]): Face[][] {
    const out: Face[][] = edges.map(() => []);
    for (const face of shape.faces) {
        for (const e of subShapes(oc, face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE)) {
            edges.forEach((edge, i) => {
                if (e.IsSame(edge.wrapped) && !out[i].some((f) => f.isSame(face))) {
                    out[i].push(face);
                }
            });
        }
    }
    return out;
}

/** The picked edges as chains: runs of edges joined end to end that carry on smoothly (exactly two at a vertex). */
function chainsOf(oc: OC, r: R, shape: Shape3D, edges: Edge[]): Chain[] {
    const faces = facesBeside(oc, shape, edges);
    const infos = edges.map((e, i) => edgeInfo(oc, r, e, faces[i]));
    for (const info of infos) {
        if (info.faces.length !== 2 || info.faces[0].isSame(info.faces[1])) {
            throw new SectionBlendError('a selected edge does not lie between two different faces', info.p0);
        }
    }
    // Joins: [edge index, which end] pairs meeting smoothly, only where exactly two picked edge ends meet.
    const ends: { i: number; k: 0 | 1; p: V; out: V }[] = [];
    infos.forEach((info, i) => {
        if (!info.closed) {
            ends.push({ i, k: 0, p: info.p0, out: info.out0 }, { i, k: 1, p: info.p1, out: info.out1 });
        }
    });
    const partner = new Map<string, { i: number; k: 0 | 1 }>();
    for (const a of ends) {
        const meeting = ends.filter((b) => len(sub(a.p, b.p)) < 1e-5);
        if (meeting.length === 2) {
            const b = meeting.find((x) => x !== a)!;
            if (b.i !== a.i && dot(a.out, b.out) <= -SMOOTH_COS) {
                partner.set(`${a.i}:${a.k}`, { i: b.i, k: b.k });
            }
        }
    }
    const used = new Set<number>();
    const chains: Chain[] = [];
    for (let start = 0; start < infos.length; start++) {
        if (used.has(start)) {
            continue;
        }
        // Walk back to the first edge of the run (or round a closed run).
        let i = start;
        let k: 0 | 1 = 0;
        const seen = new Set<number>([i]);
        for (;;) {
            const before = partner.get(`${i}:${k}`);
            if (!before || seen.has(before.i)) {
                break;
            }
            i = before.i;
            k = before.k === 0 ? 1 : 0;
            seen.add(i);
        }
        // Walk forward from there: entering edge i at end k.
        const order: { i: number; dir: number }[] = [];
        let closed = infos[i].closed;
        for (;;) {
            used.add(i);
            order.push({ i, dir: k === 0 ? 1 : -1 });
            if (infos[i].closed) {
                break;
            }
            const next = partner.get(`${i}:${k === 0 ? 1 : 0}`);
            if (!next) {
                break;
            }
            if (used.has(next.i)) {
                closed = next.i === order[0].i;
                break;
            }
            i = next.i;
            k = next.k;
        }
        const links = order.map(({ i: j, dir }) => {
            const info = infos[j];
            const curve = r(new oc.BRepAdaptor_Curve(info.edge.wrapped));
            const o = orientationIn(oc, info.faces[0].wrapped, info.edge.wrapped);
            const forwardIn0 = o === oc.TopAbs_Orientation.TopAbs_FORWARD;
            // A face lies to the left of its edges as they are oriented in it (seen from outside).
            const leftIs0 = forwardIn0 === dir > 0;
            return {
                edge: info.edge, dir, first: curve.FirstParameter(), last: curve.LastParameter(), curve,
                left: probeOf(oc, r, leftIs0 ? info.faces[0] : info.faces[1]),
                right: probeOf(oc, r, leftIs0 ? info.faces[1] : info.faces[0]),
            } as Link;
        });
        const chainEnds: Chain['ends'] = [];
        if (!closed) {
            const a = infos[order[0].i];
            const b = infos[order[order.length - 1].i];
            const [aDir, bDir] = [order[0].dir, order[order.length - 1].dir];
            chainEnds.push(aDir > 0 ? { at: a.p0, out: a.out0, vertex: a.v0 } : { at: a.p1, out: a.out1, vertex: a.v1 });
            chainEnds.push(bDir > 0 ? { at: b.p1, out: b.out1, vertex: b.v1 } : { at: b.p0, out: b.out0, vertex: b.v0 });
        }
        chains.push({ links, closed, ends: chainEnds });
    }
    return chains;
}

// ---- Sections ---------------------------------------------------------------------------------------------------

interface Section {
    /** Contact (or chamfer) points on side A and side B, and for a fillet the ball centre. */
    a: V;
    b: V;
    c?: V;
    /** The corner point (on both surfaces) and the faces' normals there. */
    p: V;
    nA: V;
    nB: V;
    /** Normals at a and b, and the face points halfway between the corner and a, b with their normals. */
    na: V;
    nb: V;
    ma: V;
    nma: V;
    mb: V;
    nmb: V;
}

interface Station {
    /** The section plane: through o, normal t (the walking direction). */
    o: V;
    t: V;
    /** Where it is: on link `link` at curve parameter w, or past an end (link -1, s along the run-out). */
    link: number;
    w: number;
    A: Probe;
    B: Probe;
    sec: Section;
    /** Past an end of the chain (the run-out). */
    virtual: boolean;
}

interface Spec {
    kind: 'fillet' | 'chamfer';
    radius: number;
    /** Chamfer: the distance on side A, and on side B or the angle from side A. */
    dA: number;
    dB: number | { angle: number };
    size: number;
}

/** The point on both surfaces in the plane (o, t), from p (Newton on the two surfaces and the plane). */
function cornerIn(oc: OC, A: Probe, B: Probe, o: V, t: V, p: V): V | null {
    let x = p;
    for (let it = 0; it < 40; it++) {
        const fa = footOn(oc, A, x);
        const fb = footOn(oc, B, x);
        if (!fa || !fb) {
            return null;
        }
        const res: V = [dot(sub(x, fa.q), fa.n), dot(sub(x, fb.q), fb.n), dot(sub(x, o), t)];
        if (Math.abs(res[0]) < 1e-11 && Math.abs(res[1]) < 1e-11 && Math.abs(res[2]) < 1e-11) {
            return x;
        }
        const step = solve3([fa.n, fb.n, t], mul(res, -1));
        if (!step) {
            return null;
        }
        x = add(x, step);
    }
    return null;
}

/** Point on the surface at chord distance d from p, in the plane (p, t), starting along dir. */
function offFace(oc: OC, probe: Probe, p: V, t: V, dir: V, d: number): Foot | null {
    let q = add(p, mul(dir, d));
    for (let it = 0; it < 60; it++) {
        const f = footOn(oc, probe, q);
        if (!f) {
            return null;
        }
        let w = sub(f.q, p);
        w = sub(w, mul(t, dot(w, t)));
        const next = add(p, mul(unit(w), d));
        const moved = len(sub(next, q));
        q = next;
        if (moved < 1e-12 && f.distance < 1e-10) {
            return footOn(oc, probe, q);
        }
    }
    const f = footOn(oc, probe, q);
    return f && f.distance < 1e-8 ? f : null;
}

/** The section of the blend in the plane (o, t) between the surfaces of A and B, the corner near p. */
/** `lean`: only the blend's points (for measuring), not the outline's. */
function sectionAt(oc: OC, A: Probe, B: Probe, o: V, t: V, p0: V, spec: Spec, convex: boolean | null, lean = false): Section {
    const p = cornerIn(oc, A, B, o, t, p0);
    if (!p) {
        throw new SectionBlendError(`the faces could not be followed at ${fmtPoint(p0)}`, p0);
    }
    const fa = footOn(oc, A, p);
    const fb = footOn(oc, B, p);
    if (!fa || !fb) {
        throw new SectionBlendError(`the faces could not be followed at ${fmtPoint(p)}`, p);
    }
    const nA = fa.n;
    const nB = fb.n;
    const intoA = unit(cross(nA, t));
    const intoB = unit(cross(t, nB));
    const isConvex = dot(intoA, nB) < 0;
    if (convex !== null && isConvex !== convex) {
        throw new SectionBlendError(`the edge turns from ${convex ? 'convex to concave' : 'concave to convex'} at `
            + `${fmtPoint(p)}`, p);
    }
    const opening = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(nA, nB))));
    if (opening < 0.5 * Math.PI / 180) {
        throw new SectionBlendError(`the faces meet at a knife edge of ${deg(opening)}° at ${fmtPoint(p)}`, p);
    }
    if (opening > Math.PI - 0.5 * Math.PI / 180) {
        throw new SectionBlendError(`the faces meet tangentially at ${fmtPoint(p)}: there is no corner to blend there`, p);
    }
    let a: Foot | null;
    let b: Foot | null;
    let c: V | undefined;
    if (spec.kind === 'fillet') {
        const sign = isConvex ? 1 : -1;
        const radius = spec.radius;
        const depth = (x: V, f: Foot): number => -dot(sub(x, f.q), f.n);
        let x = sub(p, mul(unit(add(nA, nB)), sign * radius / Math.sin(opening / 2)));
        let done = false;
        const tight = 1e-11 * Math.max(1, radius);
        for (let it = 0; it < 60 && !done; it++) {
            const ga = footOn(oc, A, x);
            const gb = footOn(oc, B, x);
            if (!ga || !gb) {
                break;
            }
            const res: V = [sign * radius - depth(x, ga), sign * radius - depth(x, gb), -dot(sub(x, o), t)];
            if (Math.abs(res[0]) < tight && Math.abs(res[1]) < tight && Math.abs(res[2]) < 1e-11) {
                done = true;
                break;
            }
            const step = solve3([mul(ga.n, -1), mul(gb.n, -1), t], res);
            if (!step) {
                break;
            }
            x = add(x, mul(step, Math.min(1, radius / (len(step) || 1))));
        }
        if (!done) {
            throw new SectionBlendError(`a fillet of ${radius} mm does not fit between the faces at ${fmtPoint(p)}, `
                + `where they meet at ${deg(opening)}°`, p);
        }
        c = x;
        a = footOn(oc, A, x);
        b = footOn(oc, B, x);
    } else {
        let dB: number;
        if (typeof spec.dB === 'number') {
            dB = spec.dB;
        } else {
            const between = Math.acos(Math.max(-1, Math.min(1, dot(intoA, intoB))));
            const third = Math.PI - between - spec.dB.angle * Math.PI / 180;
            if (!(third > 1e-3)) {
                throw new SectionBlendError(`a chamfer at ${spec.dB.angle}° does not reach the other face at `
                    + `${fmtPoint(p)}, where the faces meet at ${deg(between)}°`, p);
            }
            dB = spec.dA * Math.sin(spec.dB.angle * Math.PI / 180) / Math.sin(third);
        }
        a = offFace(oc, A, p, t, intoA, spec.dA);
        b = offFace(oc, B, p, t, intoB, dB);
    }
    if (!a || !b) {
        throw new SectionBlendError(`the ${spec.kind} could not be laid on the faces at ${fmtPoint(p)}`, p);
    }
    if (lean) {
        return { a: a.q, b: b.q, c, p, nA, nB, na: a.n, nb: b.n, ma: p, nma: nA, mb: p, nmb: nB };
    }
    // The outline is laid in one plane: a fillet's arc lies in the plane of its centre and contact points (not quite
    // square to the edge where a face leans along it), a chamfer's in the station's plane. The corner and the faces
    // halfway between it and the blend's edges are taken in that plane too, for the solid's sides.
    let po = p;
    let pt = t;
    if (c) {
        const n = unit(cross(sub(a.q, c), sub(b.q, c)));
        pt = dot(n, t) > 0 ? n : mul(n, -1);
        const q = cornerIn(oc, A, B, c, pt, p);
        if (!q) {
            throw new SectionBlendError(`the faces could not be followed at ${fmtPoint(p)}`, p);
        }
        po = q;
    }
    const ga = footOn(oc, A, po);
    const gb = footOn(oc, B, po);
    const ma = offFace(oc, A, po, pt, unit(sub(a.q, po)), len(sub(a.q, po)) / 2);
    const mb = offFace(oc, B, po, pt, unit(sub(b.q, po)), len(sub(b.q, po)) / 2);
    if (!ga || !gb || !ma || !mb) {
        throw new SectionBlendError(`the faces could not be followed at ${fmtPoint(p)}`, p);
    }
    // Normals laid into the plane, so the sides stay in it.
    const flat = (n: V): V => unit(sub(n, mul(pt, dot(n, pt))));
    return {
        a: a.q, b: b.q, c, p: po, nA: flat(ga.n), nB: flat(gb.n), na: flat(a.n), nb: flat(b.n), ma: ma.q, nma: flat(ma.n),
        mb: mb.q, nmb: flat(mb.n),
    };
}

const convexOf = (s: Section, t: V): boolean => dot(unit(cross(s.nA, t)), s.nB) < 0;

/** The point at fraction f of the way round the fillet's arc from a to b. */
function arcPoint(s: Section, f: number, radius: number): V {
    const u = unit(sub(s.a, s.c!));
    const v = unit(sub(s.b, s.c!));
    const phi = Math.atan2(len(cross(u, v)), dot(u, v));
    const w = unit(sub(v, mul(u, dot(u, v))));
    return add(s.c!, mul(add(mul(u, Math.cos(f * phi)), mul(w, Math.sin(f * phi))), radius));
}

/** The section's outline: the blend from b back to a, then round the body's faces at `margin` outside (or inside). */
function outline(s: Section, spec: Spec, arcRows: number, margin: number): V[] {
    const pts: V[] = [s.a];
    if (spec.kind === 'fillet') {
        for (let j = 1; j < arcRows; j++) {
            pts.push(arcPoint(s, j / arcRows, spec.radius));
        }
    }
    pts.push(s.b);
    pts.push(add(s.b, mul(s.nb, margin)), add(s.mb, mul(s.nmb, margin)), add(s.p, mul(s.nB, margin)),
        add(s.p, mul(s.nA, margin)), add(s.ma, mul(s.nma, margin)), add(s.a, mul(s.na, margin)));
    return pts;
}

/** Area and centroid of the corner the blend removes or fills, in its section (a polygon with the arc). */
function cornerArea(s: Section, spec: Spec): { area: number; centroid: V } {
    const pts: V[] = [s.p, s.ma, s.a];
    if (spec.kind === 'fillet') {
        for (let j = 1; j < 96; j++) {
            pts.push(arcPoint(s, j / 96, spec.radius));
        }
    }
    pts.push(s.b, s.mb);
    let area: V = [0, 0, 0];
    let centroid: V = [0, 0, 0];
    let total = 0;
    for (let i = 1; i + 1 < pts.length; i++) {
        const tri = cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0]));
        area = add(area, tri);
        const k = len(tri) / 2;
        total += k;
        centroid = add(centroid, mul(add(add(pts[0], pts[i]), pts[i + 1]), k / 3));
    }
    return { area: len(area) / 2, centroid: total > 0 ? mul(centroid, 1 / total) : s.p };
}

// ---- Curves and faces -------------------------------------------------------------------------------------------

/** Cubic through the points at the given parameters (closed: one more parameter than points, the period's end). */
function curveThrough(oc: OC, r: R, points: V[], params: number[], closed: boolean): OC {
    const pa = r(new oc.NCollection_Array1_gp_Pnt(1, points.length));
    points.forEach((p, i) => {
        const g = new oc.gp_Pnt(p[0], p[1], p[2]);
        pa.SetValue(i + 1, g);
        g.delete();
    });
    const used = closed ? params : params.slice(0, points.length);
    const ua = r(new oc.NCollection_Array1_double(1, used.length));
    used.forEach((u, i) => ua.SetValue(i + 1, u));
    const interp = r(new oc.GeomAPI_Interpolate(r(new oc.NCollection_HArray1_gp_Pnt(pa)), r(new oc.NCollection_HArray1_double(ua)),
        closed, 1e-9));
    interp.Perform();
    if (!interp.IsDone()) {
        throw new SectionBlendError('could not run a curve through the blend sections');
    }
    const curve = interp.Curve();
    if (closed) {
        // Written as an ordinary closed curve: OpenCascade's integration skips spans of periodic edges.
        curve.SetNotPeriodic();
    }
    return curve;
}

/** Distance from x to the curve, from the curve's nearest point (Newton from u, kept within span). */
function curveDistance(oc: OC, curve: OC, x: V, u: number, span: [number, number]): number {
    const p = new oc.gp_Pnt();
    const d1 = new oc.gp_Vec();
    const d2 = new oc.gp_Vec();
    try {
        for (let it = 0; it < 30; it++) {
            curve.D2(u, p, d1, d2);
            const w = sub(vecOf(p), x);
            const t1 = vecOf(d1);
            const f = dot(w, t1);
            const fp = dot(t1, t1) + dot(w, vecOf(d2));
            const next = Math.min(span[1], Math.max(span[0], u - f / (fp > 0 ? fp : (dot(t1, t1) || 1))));
            const done = Math.abs(next - u) < 1e-13 * Math.max(1, Math.abs(u));
            u = next;
            if (done) {
                break;
            }
        }
        curve.D0(u, p);
        return len(sub(vecOf(p), x));
    } finally {
        p.delete();
        d1.delete();
        d2.delete();
    }
}

function curvePoint(curve: OC, u: number): V {
    const p = curve.Value(u);
    const v: V = [p.X(), p.Y(), p.Z()];
    p.delete();
    return v;
}

/** The surface through curves with the same knots: ruled between two, else a cubic across them at equal steps. */
function surfaceThrough(oc: OC, r: R, curves: OC[]): OC {
    const first = curves[0];
    const n = first.NbPoles();
    if (curves.some((c) => c.NbPoles() !== n || c.NbKnots() !== first.NbKnots() || c.Degree() !== first.Degree())) {
        throw new SectionBlendError('could not make the blend surface');
    }
    const m = curves.length;
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
                throw new SectionBlendError('could not make the blend surface');
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
    return new oc.Geom_BSplineSurface(poles, first.Knots(), vKnots, first.Multiplicities(), vMults, first.Degree(),
        vDegree, false, false);
}

function faceOf(oc: OC, r: R, surface: OC): OC {
    const face = r(new oc.BRepBuilderAPI_MakeFace(surface, 1e-7));
    if (!face.IsDone()) {
        throw new SectionBlendError('could not make the blend surface');
    }
    return face.Face();
}

function isValid(oc: OC, shape: OC): boolean {
    const a = new oc.BRepCheck_Analyzer(shape, true, false);
    const ok = a.IsValid();
    a.delete();
    return ok;
}

/** Volume; `precise`: integrated to a relative error of 1e-7 (the quick one can be off on spline faces). */
function volumeOf(oc: OC, shape: OC, precise = false): number {
    const props = new oc.GProp_GProps();
    try {
        if (precise) {
            oc.BRepGProp.VolumeProperties(shape, props, 1e-7, false, false);
        } else {
            oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
        }
        return props.Mass();
    } finally {
        props.delete();
    }
}

function listOf(oc: OC, r: R, shapes: OC[]): OC {
    const list = r(new oc.NCollection_List_TopoDS_Shape());
    for (const s of shapes) {
        list.Append(s);
    }
    return list;
}

function boxOf(oc: OC, shape: OC): [V, V] {
    const box = new oc.Bnd_Box();
    try {
        oc.BRepBndLib.Add(shape, box, true);
        const lo = box.CornerMin();
        const hi = box.CornerMax();
        const out: [V, V] = [vecOf(lo), vecOf(hi)];
        lo.delete();
        hi.delete();
        return out;
    } finally {
        box.delete();
    }
}

/**
 * The runs of stations the blend's curves run through smoothly (as indices into `list`): one per edge, from its first
 * station to the first of the next edge (where the faces' curvature may change), the run-outs past the ends of their
 * own; a closed chain's last run ends at its first station, and one of a single closed edge is cut in two.
 */
function spansOf(list: Station[], closed: boolean): number[][] {
    const spans: number[][] = [];
    let current = [0];
    for (let i = 1; i < list.length; i++) {
        if (list[i].link === list[i - 1].link && list[i].virtual === list[i - 1].virtual) {
            current.push(i);
        } else if (list[i].virtual && !list[i - 1].virtual) {
            // A run-out starts at the chain's last station.
            spans.push(current);
            current = [i - 1, i];
        } else {
            // The next edge (or the chain after a run-out) starts at this station.
            current.push(i);
            spans.push(current);
            current = [i];
        }
    }
    if (closed) {
        current.push(0);
    }
    spans.push(current);
    if (closed && spans.length === 1) {
        const half = Math.floor(current.length / 2);
        return [current.slice(0, half + 1), current.slice(half)];
    }
    return spans.filter((span) => span.length > 1);
}

/**
 * The closed solid bounded by rings of surfaces through row curves, one ring per span (u along the chain, v across;
 * each surface meets the next of its ring along a shared row, and each ring the next along their shared section),
 * capped flat at both ends of an open chain.
 */
function ringSolid(oc: OC, r: R, rings: { surfaces: OC[]; u: [number, number] }[], closed: boolean): OC {
    const faces = rings.flatMap((ring) => ring.surfaces.map((s) => faceOf(oc, r, s)));
    if (!closed) {
        for (const [ring, u] of [[rings[0], rings[0].u[0]], [rings[rings.length - 1], rings[rings.length - 1].u[1]]] as const) {
            const wire = r(new oc.BRepBuilderAPI_MakeWire());
            for (const s of ring.surfaces) {
                wire.Add(r(new oc.BRepBuilderAPI_MakeEdge(s.UIso(u))).Edge());
            }
            if (!wire.IsDone()) {
                throw new SectionBlendError('could not close the blend solid at an end');
            }
            const cap = r(new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true));
            if (!cap.IsDone()) {
                throw new SectionBlendError('could not close the blend solid at an end');
            }
            faces.push(cap.Face());
        }
    }
    const sewing = r(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
    faces.forEach((f) => sewing.Add(f));
    sewing.Perform(r(new oc.Message_ProgressRange()));
    const sewn = sewing.SewedShape();
    if (sewn.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL || sewing.NbFreeEdges() > 0) {
        throw new SectionBlendError(`the blend solid could not be closed (${sewing.NbFreeEdges()} edges stayed open)`);
    }
    let solid = r(new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(sewn))).Solid();
    if (volumeOf(oc, solid, true) < 0) {
        solid = oc.TopoDS.Solid(solid.Reversed());
    }
    return solid;
}

// ---- Ends -------------------------------------------------------------------------------------------------------

interface EndFace {
    probe: Probe;
    /** Normal at the end vertex, and its component along the chain's outward direction. */
    n: V;
    along: number;
}

/** The faces at the end vertex other than those beside the chain's last edge. */
function endFaces(oc: OC, r: R, shape: Shape3D, vertex: OC, at: V, out: V, beside: Probe[]): EndFace[] {
    const found: EndFace[] = [];
    for (const face of shape.faces) {
        if (beside.some((b) => b.face.isSame(face))) {
            continue;
        }
        if (!subShapes(oc, face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_VERTEX).some((v) => v.IsSame(vertex))) {
            continue;
        }
        const probe = probeOf(oc, r, face);
        const f = footOn(oc, probe, at);
        if (!f || f.distance > 1e-4) {
            continue;
        }
        found.push({ probe, n: f.n, along: dot(f.n, out) });
    }
    return found;
}

/** A face on the surface of `probe` big enough to cut through a region of the given size round `at`. */
function cuttingFace(oc: OC, r: R, probe: Probe, at: V, size: number): { face: OC; side: (x: V) => number } {
    const f = footOn(oc, probe, at);
    if (!f) {
        throw new SectionBlendError('could not follow the face the blend ends on');
    }
    // A flat face (whatever its surface type: a spline face can be flat) cuts as its whole plane.
    const [b0u, b1u, b0v, b1v] = probe.box;
    let flat = true;
    for (let i = 0; i <= 2 && flat; i++) {
        for (let j = 0; j <= 2 && flat; j++) {
            const e = evalAt(probe, b0u + (b1u - b0u) * i / 2, b0v + (b1v - b0v) * j / 2);
            flat = !!e && dot(e.n, f.n) > 1 - 1e-12 && Math.abs(dot(sub(e.q, f.q), f.n)) < 1e-9;
        }
    }
    if (flat) {
        const plane = r(new oc.gp_Pln(r(new oc.gp_Pnt(f.q[0], f.q[1], f.q[2])), r(new oc.gp_Dir(f.n[0], f.n[1], f.n[2]))));
        const face = r(new oc.BRepBuilderAPI_MakeFace(plane, -size, size, -size, size));
        if (face.IsDone()) {
            return { face: face.Face(), side: (x) => dot(sub(x, f.q), f.n) };
        }
    }
    const [u0, u1, v0, v1] = probe.bounds;
    // Parameter steps for `size` in each direction, from the first derivatives at the foot.
    probe.surface.D1(f.uv[0], f.uv[1], probe.p, probe.du, probe.dv);
    const su = len(vecOf(probe.du)) || 1;
    const sv = len(vecOf(probe.dv)) || 1;
    const span = (w: number, s: number, lo: number, hi: number, period: number): [number, number] => {
        if (period > 0 && size / s >= period / 2) {
            return [w - period / 2, w + period / 2];
        }
        return [Math.max(lo, w - size / s), Math.min(hi, w + size / s)];
    };
    const [a0, a1] = span(f.uv[0], su, u0, u1, probe.period[0]);
    const [b0, b1] = span(f.uv[1], sv, v0, v1, probe.period[1]);
    const face = r(new oc.BRepBuilderAPI_MakeFace(probe.surface, a0, a1, b0, b1, 1e-7));
    if (!face.IsDone()) {
        throw new SectionBlendError('could not follow the face the blend ends on');
    }
    const side = (x: V): number => {
        const g = footOn(oc, probe, x);
        return g ? dot(sub(x, g.q), g.n) : 0;
    };
    return { face: face.Face(), side };
}

/** Keeps the part of `solid` on the side of the face's surface where `keep` is. */
function clipBy(oc: OC, r: R, solid: OC, probe: Probe, at: V, keep: V): OC {
    const [lo, hi] = boxOf(oc, solid);
    const { face, side } = cuttingFace(oc, r, probe, at, 2 * len(sub(hi, lo)) + 1);
    const splitter = r(new oc.BRepAlgoAPI_Splitter());
    splitter.SetArguments(listOf(oc, r, [solid]));
    splitter.SetTools(listOf(oc, r, [face]));
    splitter.SetRunParallel(false);
    splitter.Build(r(new oc.Message_ProgressRange()));
    if (!splitter.IsDone()) {
        throw new SectionBlendError('could not end the blend against the face there');
    }
    const want = Math.sign(side(keep));
    const pieces = subShapes(oc, splitter.Shape(), oc.TopAbs_ShapeEnum.TopAbs_SOLID);
    // Each piece lies on one side: judged by the middles of its edges (those on the cutting surface say nothing).
    const kept = pieces.filter((piece) => {
        let votes = 0;
        for (const e of subShapes(oc, piece, oc.TopAbs_ShapeEnum.TopAbs_EDGE)) {
            const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e));
            const p = curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2);
            const s = side(vecOf(p));
            p.delete();
            curve.delete();
            if (Math.abs(s) > 1e-6) {
                votes += Math.sign(s) === want ? 1 : -1;
            }
        }
        return votes > 0;
    });
    if (!kept.length) {
        throw new SectionBlendError('could not end the blend against the face there');
    }
    if (kept.length === 1) {
        return kept[0];
    }
    const builder = r(new oc.TopoDS_Builder());
    const comp = new oc.TopoDS_Compound();
    builder.MakeCompound(comp);
    kept.forEach((k) => builder.Add(comp, k));
    return comp;
}

// ---- The blend --------------------------------------------------------------------------------------------------

function specOf(blend: SectionBlend, chain: Chain): Spec {
    if (blend.kind === 'fillet') {
        if (!(blend.radius > 0)) {
            throw new SectionBlendError('the radius must be positive');
        }
        return { kind: 'fillet', radius: blend.radius, dA: 0, dB: 0, size: blend.radius };
    }
    // Which side the first distance is measured on: the reference face's, else side A.
    let refIsA = true;
    if (blend.reference) {
        const ref = blend.reference(chain.links[0].edge);
        refIsA = !chain.links[0].right.face.isSame(ref);
    }
    if ('angle' in blend) {
        if (!refIsA) {
            throw new SectionBlendError('swap');
        }
        return { kind: 'chamfer', radius: 0, dA: blend.distance, dB: { angle: blend.angle }, size: blend.distance };
    }
    const [d1, d2] = blend.distances;
    return { kind: 'chamfer', radius: 0, dA: refIsA ? d1 : d2, dB: refIsA ? d2 : d1, size: Math.max(d1, d2) };
}

/** A chain walked the other way: its left and right faces swap. */
function reversed(chain: Chain): Chain {
    return {
        links: [...chain.links].reverse().map((l) => ({ ...l, dir: -l.dir, left: l.right, right: l.left })),
        closed: chain.closed,
        ends: [...chain.ends].reverse(),
    };
}

interface Tool {
    /** Cut away at an outside corner, joined on at an inside one: a chamfer's own solid, for a fillet its chord's. */
    solid: OC;
    /**
     * A fillet's circular segment between its chord and its arc: joined back on (outside corner) or cut away (inside
     * corner) after the chord's solid, glued along the chord's face.
     */
    segment: OC | null;
    inside: boolean;
    /** The blend's surfaces as made, as faces (one per span). */
    blend: OC[];
    stations: Station[];
    spec: Spec;
    chain: Chain;
    expected: number;
    fit: number;
}

/** The plane at fraction f between stations s0 and s1 (along the edge where both lie on it), and the corner near it. */
function planeBetween(oc: OC, chain: Chain, s0: Station, s1: Station, f: number): { o: V; t: V } {
    if (!s0.virtual && !s1.virtual) {
        const l0 = chain.links[s0.link];
        if (s1.link === s0.link && (s1.w - s0.w) * l0.dir > 0) {
            const { p, t } = pointOn(oc, l0, s0.w + (s1.w - s0.w) * f);
            return { o: p, t };
        }
        // s1 starts the next edge: the rest of this edge.
        const end = l0.dir > 0 ? l0.last : l0.first;
        const { p, t } = pointOn(oc, l0, s0.w + (end - s0.w) * Math.min(1, f));
        return { o: p, t };
    }
    return { o: add(s0.o, mul(sub(s1.o, s0.o), f)), t: unit(add(mul(s0.t, 1 - f), mul(s1.t, f))) };
}

/** The interval of stations whose planes enclose x, the nearest such if several do (-1 if none). */
function intervalOf(stations: Station[], closed: boolean, x: V): number {
    const n = stations.length;
    let best = -1;
    let nearest = Infinity;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
        const s0 = stations[i];
        const s1 = stations[(i + 1) % n];
        if (dot(sub(x, s0.o), s0.t) >= -1e-9 && dot(sub(x, s1.o), s1.t) <= 1e-9) {
            const d = len(sub(x, mid(s0.sec.p, s1.sec.p)));
            if (d < nearest) {
                nearest = d;
                best = i;
            }
        }
    }
    return best;
}

/**
 * Distance of x from the true blend (mm), measured near interval k of the stations: a fillet's from the nearest ball
 * of the rolling ball's path, a chamfer's from its section in the plane through x.
 */
function errorNear(oc: OC, chain: Chain, stations: Station[], spec: Spec, convex: boolean, x: V, k: number): number {
    const s0 = stations[k];
    const s1 = stations[(k + 1) % stations.length];
    const sectionAtF = (f: number): Section => {
        const { o, t } = planeBetween(oc, chain, s0, s1, f);
        return sectionAt(oc, s0.A, s0.B, o, t, add(s0.sec.p, mul(sub(s1.sec.p, s0.sec.p), Math.max(0, Math.min(1, f)))), spec, convex, true);
    };
    // The fraction whose plane passes through x (secant on the signed distance).
    const sideOf = (f: number): number => {
        const { o, t } = planeBetween(oc, chain, s0, s1, f);
        return dot(sub(x, o), t);
    };
    let fa = 0;
    let fb = 1;
    let da = sideOf(fa);
    let db = sideOf(fb);
    let f = da - db !== 0 ? da / (da - db) : 0.5;
    for (let it = 0; it < 20 && Math.abs(fb - fa) > 1e-12; it++) {
        const d = sideOf(f);
        if (Math.abs(d) < 1e-12) {
            break;
        }
        if (Math.sign(d) === Math.sign(da)) {
            fa = f;
            da = d;
        } else {
            fb = f;
            db = d;
        }
        f = da - db !== 0 ? fa + (fb - fa) * da / (da - db) : (fa + fb) / 2;
    }
    try {
        if (spec.kind === 'chamfer') {
            const sec = sectionAtF(f);
            const ab = sub(sec.b, sec.a);
            const k2 = Math.max(0, Math.min(1, dot(sub(x, sec.a), ab) / (dot(ab, ab) || 1)));
            return len(sub(x, add(sec.a, mul(ab, k2))));
        }
        // The nearest ball centre: parabolic steps on the squared distance to the centres.
        const dist2 = (g: number): number => {
            const c = sectionAtF(g).c!;
            return dot(sub(x, c), sub(x, c));
        };
        let h = 0.05;
        let g = f;
        let best = dist2(g);
        for (let it = 0; it < 4; it++) {
            const lo = dist2(g - h);
            const hi = dist2(g + h);
            const curve = lo + hi - 2 * best;
            const step = curve > 0 ? h * (lo - hi) / (2 * curve) : (lo < hi ? -h : h);
            const next = g + Math.max(-2 * h, Math.min(2 * h, step));
            const value = dist2(next);
            if (value < best) {
                g = next;
                best = value;
            }
            h = Math.max(Math.abs(step) / 2, 1e-6);
        }
        return Math.abs(Math.sqrt(best) - spec.radius);
    } catch {
        return Infinity;
    }
}

/** Faces turning by less than this (degrees) at a side of the face beside the edge: the loop blend may roll over. */
const ROLL_OVER = 30;

/**
 * Refuses a blend wider than a face beside the edge: one whose edge on a face lies off that face across one of its
 * sides. (Past the face's end at the end of an open chain it may: there the blend runs out or is clipped.) With
 * `shape`, a side where another face carries on at a shallow crease lets it pass too (the loop blend can roll the ball
 * over onto that face).
 */
function refuseOverflow(oc: OC, r: R, stations: Station[], chain: Chain, spec: Spec, shape?: Shape3D): void {
    for (const s of stations) {
        for (const [x, probe] of [[s.sec.a, s.A], [s.sec.b, s.B]] as [V, Probe][]) {
            const v = r(new oc.BRepBuilderAPI_MakeVertex(r(new oc.gp_Pnt(x[0], x[1], x[2])))).Vertex();
            const dss = r(new oc.BRepExtrema_DistShapeShape());
            dss.LoadS1(v);
            dss.LoadS2(probe.face.wrapped);
            dss.Perform(r(new oc.Message_ProgressRange()));
            if (!dss.IsDone() || dss.Value() <= 1e-4) {
                continue;
            }
            // Where the face's nearest boundary is: an edge or vertex at one of the chain's ends lets it pass.
            const support = dss.SupportOnShape2(1);
            const atEnd = subShapes(oc, support, oc.TopAbs_ShapeEnum.TopAbs_VERTEX)
                .some((vertex) => chain.ends.some((e) => vertex.IsSame(e.vertex)));
            const smooth = !!shape && support.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE
                && (faceAngleAlong(shape, cast(support) as unknown as Edge) ?? Infinity) < ROLL_OVER;
            if (!atEnd && !smooth) {
                const what = spec.kind === 'fillet' ? `a fillet of ${spec.radius} mm` : `a chamfer of ${spec.size} mm`;
                throw new SectionBlendError(`${what} is wider than a face beside the edge at ${fmtPoint(s.o)}: it would run `
                    + 'off that face', s.o);
            }
        }
    }
}

/**
 * A quick look before any blend is tried (sections at a few stations of each edge, nothing built): whether the blend
 * runs off a face beside the edges across one of its sides where no face carries on (at less than ROLL_OVER). Then no way of making
 * it can work, and trying them all takes long on a big body. The reason, or null.
 */
export function overflowsFace(shape: Shape3D, edges: Edge[], blend: SectionBlend): string | null {
    const oc = getOC() as OC;
    const [keep, gc] = localGC();
    const r = keep as R;
    try {
        let chains: Chain[];
        try {
            chains = chainsOf(oc, r, shape, edges);
        } catch {
            return null;
        }
        for (const chain0 of chains) {
            let chain = chain0;
            let spec: Spec;
            try {
                spec = specOf(blend, chain);
            } catch {
                chain = reversed(chain);
                spec = specOf(blend, chain);
            }
            const stations: Station[] = [];
            let convex: boolean | null = null;
            chain.links.forEach((l, i) => {
                for (const f of [0, 0.25, 0.5, 0.75, 1]) {
                    const w = l.dir > 0 ? l.first + (l.last - l.first) * f : l.last - (l.last - l.first) * f;
                    try {
                        const { p, t } = pointOn(oc, l, w);
                        const sec = sectionAt(oc, l.left, l.right, p, t, p, spec, convex, true);
                        convex ??= convexOf(sec, t);
                        stations.push({ o: p, t, link: i, w, A: l.left, B: l.right, sec, virtual: false });
                    } catch {
                        // a section that cannot be solved says nothing here
                    }
                }
            });
            try {
                refuseOverflow(oc, r, stations, chain, spec, shape);
            } catch (e) {
                if (e instanceof SectionBlendError) {
                    return e.message;
                }
                throw e;
            }
        }
        return null;
    } catch {
        return null;
    } finally {
        gc();
    }
}

/** The tools of one chain's blend. */
function chainTool(oc: OC, r: R, shape: Shape3D, chain0: Chain, blend: SectionBlend): Tool {
    let chain = chain0;
    let spec: Spec;
    try {
        spec = specOf(blend, chain);
    } catch (e) {
        if (!(e instanceof SectionBlendError && e.message === 'swap')) {
            throw e;
        }
        // An angle is measured from side A: walk the chain the other way round.
        chain = reversed(chain);
        spec = specOf(blend, chain);
    }
    const size = spec.size;
    const sampled = (l: Link): { length: number; turn: number } => {
        let length = 0;
        let turn = 0;
        let prev = pointOn(oc, l, l.first);
        for (let k = 1; k <= 16; k++) {
            const s = pointOn(oc, l, l.first + (l.last - l.first) * k / 16);
            length += len(sub(s.p, prev.p));
            turn += Math.acos(Math.max(-1, Math.min(1, dot(s.t, prev.t))));
            prev = s;
        }
        return { length, turn };
    };
    // First stations: at most about the blend's size apart and 10 degrees of turning, at least 4 per edge.
    const stations: Station[] = [];
    let convex: boolean | null = null;
    const make = (linkIndex: number, w: number): Station => {
        const l = chain.links[linkIndex];
        const { p, t } = pointOn(oc, l, w);
        const sec = sectionAt(oc, l.left, l.right, p, t, p, spec, convex);
        convex ??= convexOf(sec, t);
        return { o: p, t, link: linkIndex, w, A: l.left, B: l.right, sec, virtual: false };
    };
    chain.links.forEach((l, i) => {
        const { length, turn } = sampled(l);
        const count = Math.max(4, Math.ceil(length / Math.max(size, 0.05)), Math.ceil(turn / (10 * Math.PI / 180)));
        // Each edge from its start in the walking direction; the vertex between two edges gets one station, on the
        // edge that leaves it; a closed chain's last edge stops short of the start.
        const upTo = i === chain.links.length - 1 && !chain.closed ? count : count - 1;
        for (let k = 0; k <= upTo; k++) {
            const f = k / count;
            stations.push(make(i, l.dir > 0 ? l.first + (l.last - l.first) * f : l.last - (l.last - l.first) * f));
        }
    });
    // A blend wider than a face beside the edge is refused before anything else is made (overflow is not handled).
    refuseOverflow(oc, r, stations, chain, spec);
    const inside = !convex;
    // Rows across a fillet's arc at most 6 degrees apart (the surface across them is a cubic through them).
    const arcRows = spec.kind === 'fillet'
        ? Math.max(4, Math.ceil(Math.max(...stations.map((s) => {
            const u = unit(sub(s.sec.a, s.sec.c!));
            const v = unit(sub(s.sec.b, s.sec.c!));
            return Math.atan2(len(cross(u, v)), dot(u, v));
        })) / (6 * Math.PI / 180)))
        : 1;
    const blendRows = spec.kind === 'fillet' ? arcRows + 1 : 2;
    // Curve parameters through the stations of a span: their mean chord length.
    const paramsOf = (list: Station[]): number[] => {
        const out = [0];
        for (let k = 1; k < list.length; k++) {
            const x = list[k].sec;
            const y = list[k - 1].sec;
            out.push(out[k - 1] + Math.max((len(sub(x.a, y.a)) + len(sub(x.b, y.b)) + len(sub(x.p, y.p))) / 3, 1e-9));
        }
        return out;
    };
    const rowPoint = (s: Station, j: number): V => (j === 0 ? s.sec.a : j === blendRows - 1 ? s.sec.b
        : arcPoint(s.sec, j / arcRows, spec.radius));
    // The station halfway between stations i and i + 1 (in the edge's parameter).
    const halfway = (i: number): Station | null => {
        const s0 = stations[i];
        const s1 = stations[(i + 1) % stations.length];
        const l = chain.links[s0.link];
        const end = s1.link === s0.link && (s1.w - s0.w) * l.dir > 0 ? s1.w : (l.dir > 0 ? l.last : l.first);
        return Math.abs(end - s0.w) < 1e-12 ? null : make(s0.link, (s0.w + end) / 2);
    };

    // Refine: where the curves through the stations stray from the true blend between them, add a station there. A
    // fillet's error is bounded by how far its centre curve strays from the true centre halfway (the rows are measured
    // against the centre curve); a chamfer's is measured in the section plane through each point.
    let fit = 0;
    const checked = [0, Math.floor(blendRows / 2), blendRows - 1].filter((j, k, all) => all.indexOf(j) === k);
    for (let round = 0; round < 12; round++) {
        const inserts: { at: number; s: Station }[] = [];
        fit = 0;
        for (const span of spansOf(stations, chain.closed)) {
            const list = span.map((i) => stations[i]);
            const params = paramsOf(list);
            const curves = checked.map((j) => ({ j, curve: curveThrough(oc, r, list.map((x) => rowPoint(x, j)), params, false) }));
            const centres = spec.kind === 'fillet' ? curveThrough(oc, r, list.map((x) => x.sec.c!), params, false) : null;
            for (let q = 0; q + 1 < span.length; q++) {
                const i = span[q];
                const u = (params[q] + params[q + 1]) / 2;
                const range: [number, number] = [params[Math.max(0, q - 1)], params[Math.min(params.length - 1, q + 2)]];
                let e = 0;
                const half = centres ? halfway(i) : null;
                if (centres && half) {
                    e = curveDistance(oc, centres, half.sec.c!, u, range);
                }
                for (const { j, curve } of curves) {
                    const x = curvePoint(curve, u);
                    let err = centres ? Math.abs(curveDistance(oc, centres, x, u, range) - spec.radius) + e
                        : errorNear(oc, chain, stations, spec, convex!, x, i);
                    if (j === 0 || j === blendRows - 1) {
                        // The blend's edges lie on the faces.
                        const foot = footOn(oc, j === 0 ? stations[i].A : stations[i].B, x);
                        err = Math.max(err, foot ? foot.distance : Infinity);
                    }
                    e = Math.max(e, err);
                }
                fit = Math.max(fit, e);
                const short = len(sub(stations[span[q + 1]].o, stations[i].o)) < 1e-4;
                if (e > TOLERANCE && !short) {
                    const insert = half ?? halfway(i);
                    if (insert) {
                        inserts.push({ at: i + 1, s: insert });
                    }
                }
            }
        }
        if (!inserts.length) {
            break;
        }
        for (const { at, s } of inserts.sort((x, y) => y.at - x.at)) {
            stations.splice(at, 0, s);
        }
        if (stations.length > 4000) {
            throw new SectionBlendError(`the ${spec.kind} needs too many sections to follow the faces closely`);
        }
    }
    if (!(fit <= REFUSE)) {
        throw new SectionBlendError(`the ${spec.kind} could not be made to follow its true shape closer than `
            + `${fit.toExponential(1)} mm`);
    }

    refuseOverflow(oc, r, stations, chain, spec);

    // The margin by which the solid's sides stand off the body's faces (outside it at an outside corner, inside it at
    // an inside one): clear of the faces' bulge between the points the sides are laid through.
    let bulge = 0;
    for (const s of stations) {
        for (const [p, q, probe] of [[s.sec.p, s.sec.ma, s.A], [s.sec.ma, s.sec.a, s.A], [s.sec.p, s.sec.mb, s.B],
            [s.sec.mb, s.sec.b, s.B]] as [V, V, Probe][]) {
            const f = footOn(oc, probe, mid(p, q));
            if (f) {
                bulge = Math.max(bulge, f.distance);
            }
        }
    }
    const margin = (inside ? -1 : 1) * Math.max((inside ? 0.1 : 0.25) * size, 4 * bulge, 1e-3);

    // Ends: run out past an end where the faces there fall away, clip by a wall (or at an inside corner by the face the
    // corner ends on); else end square. A fillet's segment also ends on the faces that fall away.
    const clips: { probe: Probe; at: V; keep: V }[] = [];
    const segmentClips: { probe: Probe; at: V; keep: V }[] = [];
    const before: Station[] = [];
    const after: Station[] = [];
    if (!chain.closed) {
        chain.ends.forEach((end, k) => {
            const s = k === 0 ? stations[0] : stations[stations.length - 1];
            const faces = endFaces(oc, r, shape, end.vertex, end.at, end.out, [s.A, s.B]);
            const away = faces.filter((f) => f.along > IN_LINE);
            const walls = faces.filter((f) => f.along < -IN_LINE);
            const clipping = inside ? [...away, ...walls] : walls;
            const runout = clipping.length > 0 || (faces.length > 0 && away.length === faces.length);
            if (!runout) {
                return;
            }
            // Far enough for every point of the section to pass the faces it must clear.
            const pts = outline(s.sec, spec, arcRows, margin);
            let reach = 0.1 * size + 0.05;
            for (const f of faces) {
                if (Math.abs(f.along) <= IN_LINE) {
                    continue;
                }
                for (const x of pts) {
                    const w = sub(x, end.at);
                    reach = Math.max(reach, (f.along > 0 ? -dot(w, f.n) : dot(w, f.n)) / Math.abs(f.along) + 0.1 * size);
                }
            }
            reach = Math.min(reach, 50 * size);
            // Close enough that the curves through them stay on the true blend where it ends against a face.
            const steps = Math.min(200, Math.max(4, Math.ceil(reach / Math.max(size / 8, 0.01))));
            const list = runOut(oc, s, end.out, reach, steps, spec, convex!);
            if (k === 0) {
                before.push(...list.reverse());
            } else {
                after.push(...list);
            }
            const keep = sub(end.at, mul(end.out, Math.min(size, 1e-2)));
            for (const f of clipping) {
                clips.push({ probe: f.probe, at: end.at, keep });
            }
            for (const f of [...away, ...walls]) {
                segmentClips.push({ probe: f.probe, at: end.at, keep });
            }
        });
    }
    // The surfaces, span by span (the run-outs are spans of their own): the blend's (a fillet's arc, a chamfer's face),
    // a fillet's chord, and the sides round the outline.
    const all = [...before, ...stations, ...after];
    const outlines = all.map((x) => outline(x.sec, spec, arcRows, margin));
    const pieces = spansOf(all, chain.closed).map((span) => {
        const params = paramsOf(span.map((i) => all[i]));
        const curves = outlines[0].map((_, j) => curveThrough(oc, r, span.map((i) => outlines[i][j]), params, false));
        const strips: OC[] = [];
        for (let k = blendRows - 1; k < curves.length; k++) {
            strips.push(surfaceThrough(oc, r, [curves[k], curves[(k + 1) % curves.length]]));
        }
        const blendSurface = surfaceThrough(oc, r, curves.slice(0, blendRows));
        const chord = spec.kind === 'fillet' ? surfaceThrough(oc, r, [curves[0], curves[blendRows - 1]]) : null;
        return { blendSurface, chord, strips, u: [params[0], params[params.length - 1]] as [number, number] };
    });
    let solid: OC;
    let segment: OC | null = null;
    if (spec.kind === 'fillet') {
        solid = ringSolid(oc, r, pieces.map((x) => ({ surfaces: [x.chord, ...x.strips], u: x.u })), chain.closed);
        segment = ringSolid(oc, r, pieces.map((x) => ({ surfaces: [x.blendSurface, x.chord], u: x.u })), chain.closed);
        for (const c of segmentClips) {
            segment = clipBy(oc, r, segment, c.probe, c.at, c.keep);
        }
    } else {
        solid = ringSolid(oc, r, pieces.map((x) => ({ surfaces: [x.blendSurface, ...x.strips], u: x.u })), chain.closed);
    }
    for (const c of clips) {
        solid = clipBy(oc, r, solid, c.probe, c.at, c.keep);
    }

    // The corner's volume, from the sections (Pappus: area times the path of its centroid).
    let expected = 0;
    const corners = stations.map((s) => cornerArea(s.sec, spec));
    for (let i = 0; i + 1 < corners.length + (chain.closed ? 1 : 0); i++) {
        const x = corners[i];
        const y = corners[(i + 1) % corners.length];
        expected += (x.area + y.area) / 2 * len(sub(y.centroid, x.centroid));
    }
    return { solid, segment, inside, blend: pieces.map((x) => faceOf(oc, r, x.blendSurface)), stations: all, spec, chain, expected, fit };
}

/**
 * Stations past an end, marching along `out`: along the faces' intersection where it can be followed, else the end
 * section moved on. Their planes face the chain's walking direction, as all stations do.
 */
function runOut(oc: OC, from: Station, out: V, reach: number, steps: number, spec: Spec, convex: boolean): Station[] {
    const list: Station[] = [];
    const walk = dot(from.t, out) > 0 ? 1 : -1;
    let p = from.sec.p;
    let t = out;
    let follow = true;
    for (let k = 1; k <= steps; k++) {
        const s = reach * k / steps;
        let sec: Section | null = null;
        let o: V = add(from.sec.p, mul(out, s));
        let tt: V = from.t;
        if (follow) {
            try {
                const guess = add(p, mul(t, reach / steps));
                const q = cornerIn(oc, from.A, from.B, guess, t, guess);
                const fa = q && footOn(oc, from.A, q);
                const fb = q && footOn(oc, from.B, q);
                if (q && fa && fb && len(cross(fa.n, fb.n)) > 1e-9) {
                    const tn = unit(cross(fa.n, fb.n));
                    const along = dot(tn, t) > 0 ? tn : mul(tn, -1);
                    tt = mul(along, walk);
                    sec = sectionAt(oc, from.A, from.B, q, tt, q, spec, convex);
                    o = q;
                    p = q;
                    t = along;
                }
            } catch {
                sec = null;
            }
            if (!sec) {
                follow = false;
            }
        }
        if (!sec) {
            // The end section moved on along the end's direction.
            const d = mul(out, s);
            const e = from.sec;
            const mv = (x: V): V => add(x, d);
            sec = { ...e, a: mv(e.a), b: mv(e.b), c: e.c && mv(e.c), p: mv(e.p), ma: mv(e.ma), mb: mv(e.mb) };
            o = mv(from.o);
            tt = from.t;
        }
        list.push({ o, t: tt, link: -1, w: s, A: from.A, B: from.B, sec, virtual: true });
    }
    return list;
}

/**
 * The body with the tools cut away or joined on. `glue`: the tools only touch the body (along faces they share), so no
 * intersections are computed.
 */
function boolean(oc: OC, r: R, kind: 'cut' | 'fuse', body: OC, tools: OC[], fuzzy: number, glue = false): OC {
    const op = r(kind === 'cut' ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Fuse());
    op.SetArguments(listOf(oc, r, [body]));
    op.SetTools(listOf(oc, r, tools));
    op.SetRunParallel(false);
    // The body handed in (and whatever the result shares with it) must not be changed: a part's bodies are shared
    // between build steps. (Changing them in place also made the segment's glued fuse come out empty now and then.)
    op.SetNonDestructive(true);
    if (fuzzy > 0) {
        op.SetFuzzyValue(fuzzy);
    }
    if (glue) {
        op.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    }
    op.Build(r(new oc.Message_ProgressRange()));
    if (!op.IsDone() || op.HasErrors()) {
        throw new SectionBlendError(`the blend could not be ${kind === 'cut' ? 'cut from' : 'joined to'} the body`);
    }
    return op.Shape();
}

/**
 * Sampled distance of the result's blend faces from the true blend: points on the faces of the result that lie on a
 * tool's blend surface, each measured against the true blend. Also how many points were measured.
 */
function blendError(oc: OC, r: R, result: OC, tools: Tool[]): { error: number; points: number } {
    let worst = 0;
    let points = 0;
    const probes = tools.flatMap((t) => t.blend.map((f) => ({ tool: t, probe: probeOf(oc, r, cast(f) as unknown as Face), box: boxOf(oc, f) })));
    const overlaps = (a: [V, V], b: [V, V]): boolean => [0, 1, 2].every((k) => a[0][k] <= b[1][k] + 1e-3 && b[0][k] <= a[1][k] + 1e-3);
    // Which blend surface a point lies on, if any.
    const onBlend = (x: V): number => probes.findIndex(({ probe: pr }) => {
        let foot = footOn(oc, pr, x);
        if (!foot || foot.distance >= 1e-6) {
            // From the last foot Newton can settle on the far side of a closed surface: search afresh.
            pr.uv = null;
            foot = footOn(oc, pr, x);
        }
        return !!foot && foot.distance < 1e-6;
    });
    // A fillet's points are measured against the curve through its true ball centres (the refinement made that
    // curve follow the true centres between stations): off the blend by their distance from it less the radius.
    const centreCurves = new Map<Tool, { spans: number[][]; params: number[][]; curves: OC[] }>();
    const offCentres = (x: V, tool: Tool, k: number): number => {
        let c = centreCurves.get(tool);
        if (!c) {
            const spans = spansOf(tool.stations, tool.chain.closed);
            const params = spans.map((span) => {
                const out = [0];
                for (let q = 1; q < span.length; q++) {
                    out.push(out[q - 1] + Math.max(len(sub(tool.stations[span[q]].sec.c!, tool.stations[span[q - 1]].sec.c!)), 1e-9));
                }
                return out;
            });
            c = { spans, params, curves: spans.map((span, i) => curveThrough(oc, r, span.map((q) => tool.stations[q].sec.c!), params[i], false)) };
            centreCurves.set(tool, c);
        }
        const n = tool.stations.length;
        const i = c.spans.findIndex((span) => span.some((q, m) => q === k && m + 1 < span.length && span[m + 1] === (k + 1) % n));
        if (i < 0) {
            return 0;
        }
        const m = c.spans[i].findIndex((q, idx) => q === k && c!.spans[i][idx + 1] === (k + 1) % n);
        const ps = c.params[i];
        const range: [number, number] = [ps[Math.max(0, m - 1)], ps[Math.min(ps.length - 1, m + 2)]];
        return Math.abs(curveDistance(oc, c.curves[i], x, (ps[m] + ps[m + 1]) / 2, range) - tool.spec.radius);
    };
    for (const face of subShapes(oc, result, oc.TopAbs_ShapeEnum.TopAbs_FACE)) {
        const f = oc.TopoDS.Face(face);
        const box = boxOf(oc, f);
        if (!probes.some((p) => overlaps(p.box, box))) {
            continue;
        }
        const b = oc.BRepTools.UVBounds(f, 0, 0, 0, 0);
        const probe = probeOf(oc, r, cast(f) as unknown as Face);
        const at = (i: number, j: number): V | null => {
            const x = evalAt(probe, b.UMin + (b.UMax - b.UMin) * i / 6, b.VMin + (b.VMax - b.VMin) * j / 6);
            return x && distanceTo(oc, r, x.q, f) <= 1e-7 ? x.q : null;
        };
        // Judged at points away from the face's edges (an edge it shares with a face beside the blend lies on both).
        const inner = [[3, 3], [2, 2], [4, 4], [2, 4], [4, 2]].map(([i, j]) => at(i, j)).filter((x): x is V => !!x)
            .filter((x) => distanceTo(oc, r, x, oc.BRepTools.OuterWire(f)) > 1e-4).slice(0, 3);
        const k0 = inner.length ? onBlend(inner[0]) : -1;
        if (k0 < 0 || !inner.every((x) => probes[onBlend(x)]?.tool === probes[k0].tool)) {
            continue;
        }
        const tool = probes[k0].tool;
        for (let i = 0; i <= 6; i++) {
            for (let j = 0; j <= 6; j++) {
                const x = at(i, j);
                const k = x ? intervalOf(tool.stations, tool.chain.closed, x) : -1;
                if (x && k >= 0) {
                    worst = Math.max(worst, tool.spec.kind === 'fillet' ? offCentres(x, tool, k)
                        : errorNear(oc, tool.chain, tool.stations, tool.spec, !tool.inside, x, k));
                    points++;
                }
            }
        }
    }
    return { error: worst, points };
}

/** The edges of `body` that are pieces of the given edges (after an earlier chain's blend rebuilt the body). */
function piecesOn(oc: OC, r: R, body: Shape3D, edges: Edge[]): Edge[] {
    const out: Edge[] = [];
    const all = body.edges;
    for (const edge of edges) {
        const exact = all.find((e) => e.isSame(edge));
        if (exact) {
            out.push(exact);
            continue;
        }
        const [lo, hi] = boxOf(oc, edge.wrapped);
        const inside = (p: V): boolean => [0, 1, 2].every((k) => p[k] >= lo[k] - 1e-5 && p[k] <= hi[k] + 1e-5);
        for (const e of all) {
            const pts = [0, 0.5, 1].map((k) => {
                const p = e.pointAt(k);
                const v: V = [p.x, p.y, p.z];
                p.delete();
                return v;
            });
            if (pts.every(inside) && pts.every((p) => distanceTo(oc, r, p, edge.wrapped) < 1e-6) && e.length > 1e-6) {
                out.push(e);
            }
        }
    }
    if (!out.length) {
        throw new SectionBlendError('a selected edge was taken away by the blend of another chain of edges');
    }
    return out;
}

/**
 * The body with constant fillets or chamfers on the edges, built from true sections. Throws SectionBlendError with
 * the reason when it cannot be made this way or the result does not check out.
 */
export function sectionBlend(shape: Shape3D, edges: Edge[], blend: SectionBlend, info?: Partial<SectionBlendInfo>): Shape3D {
    const oc = getOC() as OC;
    const [keep, gc] = localGC();
    const r = keep as R;
    try {
        const chains = chainsOf(oc, r, shape, edges);
        const size = blend.kind === 'fillet' ? blend.radius : 'distances' in blend ? Math.max(...blend.distances) : blend.distance;
        const fuzzy = Math.min(1e-5, 1e-3 * size);
        // Chamfers in one go (their solids meet the faces at an angle, so they may overlap at a corner); fillets chain
        // by chain, each on the body as the ones before left it (their segments are glued on, which needs them apart).
        const groups = blend.kind === 'chamfer' ? [chains] : chains.map((c) => [c]);
        const chainEdges = chains.map((c) => c.links.map((l) => l.edge));
        let body = shape;
        const tools: Tool[] = [];
        groups.forEach((group, g) => {
            const here = g === 0 ? group : chainsOf(oc, r, body, piecesOn(oc, r, body, chainEdges[chains.indexOf(group[0])]));
            const made = here.map((c) => chainTool(oc, r, body, c, blend));
            tools.push(...made);
            let out = body.wrapped;
            const fills = made.filter((t) => t.inside).map((t) => t.solid);
            const cuts = made.filter((t) => !t.inside).map((t) => t.solid);
            if (fills.length) {
                out = boolean(oc, r, 'fuse', out, fills, fuzzy);
            }
            if (cuts.length) {
                out = boolean(oc, r, 'cut', out, cuts, fuzzy);
            }
            // A fillet's segment back on at an outside corner, away at an inside one: glued along the chord's face.
            const back = made.filter((t) => !t.inside && t.segment).map((t) => t.segment);
            const away = made.filter((t) => t.inside && t.segment).map((t) => t.segment);
            if (back.length) {
                out = boolean(oc, r, 'fuse', out, back, fuzzy, true);
            }
            if (away.length) {
                out = boolean(oc, r, 'cut', out, away, fuzzy, true);
            }
            const solids = subShapes(oc, out, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
            if (solids.length !== 1) {
                throw new SectionBlendError(`the ${blend.kind} left ${solids.length} pieces instead of one solid`);
            }
            if (!isValid(oc, solids[0])) {
                throw new SectionBlendError(`the ${blend.kind} made an invalid solid`);
            }
            body = cast(solids[0]) as Shape3D;
        });
        if (info) {
            info.tools = tools.map((t) => ({ volume: volumeOf(oc, t.solid), valid: isValid(oc, t.solid), inside: t.inside }));
        }
        const change = volumeOf(oc, body.wrapped, true) - volumeOf(oc, shape.wrapped, true);
        const expected = tools.reduce((sum, t) => sum + (t.inside ? t.expected : -t.expected), 0);
        if (info) {
            info.chains = chains.length;
            info.stations = tools.reduce((n, t) => n + t.stations.length, 0);
            info.fit = Math.max(...tools.map((t) => t.fit));
            info.change = change;
            info.expected = expected;
        }
        const allInside = tools.every((t) => t.inside);
        const allOutside = tools.every((t) => !t.inside);
        if ((allInside && !(change > 0)) || (allOutside && !(change < 0))) {
            throw new SectionBlendError(`the ${blend.kind} ${change > 0 ? 'added' : 'removed'} material where it should not`);
        }
        const slack = 0.1 * Math.abs(expected) + tools.reduce((sum, t) => sum + (t.chain.closed ? 0 : 2 * t.spec.size ** 3), 0);
        if (Math.abs(change - expected) > slack) {
            throw new SectionBlendError(`the ${blend.kind} changed the volume by ${change.toFixed(4)} mm³ where about `
                + `${expected.toFixed(4)} mm³ was expected: it reaches other faces of the part`);
        }
        const { error, points } = blendError(oc, r, body.wrapped, tools);
        if (info) {
            info.error = error;
            info.points = points;
        }
        if (error > REFUSE) {
            throw new SectionBlendError(`the ${blend.kind} strays ${error.toExponential(1)} mm from its true shape`);
        }
        return body;
    } finally {
        gc();
    }
}
