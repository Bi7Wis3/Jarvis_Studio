// Faces of IGES trimmed surfaces (144), bounded surfaces (143), untrimmed surfaces and bounded planes (108): the
// surface trimmed by its loops. A loop's edges are its 3D curves (model space) where the file gives them, else its
// curves in the surface's parameter space, whose 3D curves OpenCascade builds. Each face is written as B-rep text,
// read, and fixed with ShapeFix_Face (parameter-space curves, wire order and orientation, seams); the faces are
// knitted into shells afterwards (readIges.ts).

import { getOC, localGC } from 'replicad';
import { dist, dot, cross, nurbsEval, sub, type Nurbs, type V3 } from '../sldprt/nurbs.js';
import { nurbsRecord } from '../sldprt/brep.js';
import { BrepWriter } from './brepText.js';
import { curveRecord, curveSegments, segEnd, segNurbs, segStart, type Seg } from './curves.js';
import { IDENTITY, IgesGeometryError, int, type IgesModel, type Xf } from './model.js';
import type { IgesEntity } from './parse.js';
import { mapUv, surfaceDef, type SurfaceDef } from './surfaces.js';

type OC = ReturnType<typeof getOC>;
export type TopoShape = InstanceType<OC['TopoDS_Shape']>;

/** A loop edge: a 3D curve segment, or a curve in the record's (u, v), run forwards or backwards. */
export type LoopEdge = { kind: '3d'; seg: Seg; reversed: boolean } | { kind: '2d'; uv: Nurbs; reversed: boolean };
type Loop = LoopEdge[];

export interface FaceContext {
    /** Basic precision (mm): vertex and edge tolerances start here; ShapeFix works to it. */
    precision: number;
    /** The largest tolerance ShapeFix may give an edge or vertex (mm). */
    maxTolerance: number;
    /** Largest gap closed between the curves of a loop (mm). */
    largestGap: number;
    /** Faces whose loops came from parameter-space curves. */
    parameterLoops: number;
    /** Loops that did not close. */
    openLoops: number;
}

const BASE_TOL = 1e-7;
/** Curve ends closer than this (mm) meet as given: the file's direction stands. */
const JOIN_TOL = 1e-6;

const startOf = (e: LoopEdge, at: (uv: [number, number]) => V3): V3 => (e.kind === '3d'
    ? (e.reversed ? segEnd(e.seg) : segStart(e.seg))
    : at(uvAt(e.uv, e.reversed ? 'last' : 'first')));
const endOf = (e: LoopEdge, at: (uv: [number, number]) => V3): V3 => (e.kind === '3d'
    ? (e.reversed ? segStart(e.seg) : segEnd(e.seg))
    : at(uvAt(e.uv, e.reversed ? 'first' : 'last')));

function uvAt(c: Nurbs, end: 'first' | 'last'): [number, number] {
    const t = end === 'first' ? c.knots[0] : c.knots[c.knots.length - 1];
    const p = nurbsEval(c, t).p;
    return [p[0], p[1]];
}

/** Whether a segment has (next to) no length. */
function vanishing(s: Seg, tol: number): boolean {
    const a = segStart(s);
    const b = segEnd(s);
    const m = s.curve.eval((s.first + s.last) / 2).p;
    return dist(a, b) <= tol && dist(a, m) <= tol;
}

/** The edges of a loop oriented head to tail (a curve given the wrong way round is turned). */
function chain(edges: LoopEdge[], at: (uv: [number, number]) => V3): Loop {
    const out: Loop = [];
    const flip = (e: LoopEdge): LoopEdge => ({ ...e, reversed: !e.reversed });
    for (let i = 0; i < edges.length; i++) {
        let e = edges[i];
        const a = startOf(e, at);
        const b = endOf(e, at);
        if (i === 0) {
            if (edges.length > 1) {
                const n = edges[1];
                const na = startOf(n, at);
                const nb = endOf(n, at);
                const fromEnd = Math.min(dist(b, na), dist(b, nb));
                const fromStart = Math.min(dist(a, na), dist(a, nb));
                if (fromEnd > JOIN_TOL && fromStart < fromEnd * 0.5) {
                    e = flip(e);
                }
            }
        } else {
            const prev = endOf(out[i - 1], at);
            if (dist(prev, a) > JOIN_TOL && dist(prev, b) < dist(prev, a) * 0.5) {
                e = flip(e);
            }
        }
        out.push(e);
    }
    return out;
}

/** 3D segments as loop edges, in order or all reversed (vanishing pieces dropped). */
export function loopEdges(segs: Seg[], reversed = false): LoopEdge[] {
    const out: LoopEdge[] = segs.filter((s) => !vanishing(s, BASE_TOL * 10)).map((seg) => ({ kind: '3d', seg, reversed: false }));
    return reversed ? out.reverse().map((e) => ({ ...e, reversed: true })) : out;
}

/** 3D segments of a model-space curve as loop edges. */
function edges3d(m: IgesModel, curve: IgesEntity, x: Xf, reversed = false): LoopEdge[] {
    return loopEdges(curveSegments(m, curve, x), reversed);
}

/** Parameter-space segments mapped to the record's (u, v), as exact 2D B-splines. */
function edges2d(m: IgesModel, curve: IgesEntity, def: SurfaceDef, reversed = false): LoopEdge[] {
    const map = def.uv;
    if (!map) {
        throw new IgesGeometryError(`a ${def.kind} face given only by curves in its parameter space`);
    }
    const out: LoopEdge[] = curveSegments(m, curve, IDENTITY).map((seg) => {
        const n = segNurbs(seg);
        const cw = n.cw.map((pw) => {
            const w = pw[3];
            const [u, v] = mapUv(map, pw[0] / w, pw[1] / w);
            return [u * w, v * w, 0, w];
        });
        return { kind: '2d', uv: { ...n, cw }, reversed: false };
    });
    return reversed ? out.reverse().map((e) => ({ ...e, reversed: true })) : out;
}

/** A loop from a curve on a parametric surface (142): its model-space curve, else its parameter-space curve. */
function loop142(m: IgesModel, e: IgesEntity, x: Xf, def: () => SurfaceDef): LoopEdge[] {
    if (e.type !== 142) {
        throw new IgesGeometryError(`a trimmed surface boundary of type ${e.type}`);
    }
    const cx = m.xf(e, x);
    const model = m.entity(int(e, 3));
    const param = m.entity(int(e, 2));
    let failure: unknown;
    if (model) {
        try {
            const edges = edges3d(m, model, cx);
            if (edges.length) {
                return edges;
            }
        } catch (error) {
            failure = error;
        }
    }
    if (param) {
        return edges2d(m, param, def());
    }
    throw failure ?? new IgesGeometryError('a trimming curve with neither a model-space nor a parameter-space curve');
}

/** A loop from a boundary entity (141): its model-space curves in turn (each possibly reversed). */
function loop141(m: IgesModel, e: IgesEntity, x: Xf, def: () => SurfaceDef): LoopEdge[] {
    if (e.type !== 141) {
        throw new IgesGeometryError(`a bounded surface boundary of type ${e.type}`);
    }
    const bx = m.xf(e, x);
    const n = int(e, 3);
    const out: LoopEdge[] = [];
    let k = 4;
    for (let i = 0; i < n; i++) {
        const curve = m.entity(int(e, k));
        const reversed = int(e, k + 1) === 2;
        const count = int(e, k + 2);
        const pcurves = Array.from({ length: count }, (_, j) => m.entity(int(e, k + 3 + j)));
        k += 3 + count;
        let edges: LoopEdge[] | null = null;
        if (curve) {
            try {
                edges = edges3d(m, curve, bx, reversed);
            } catch {
                edges = null;
            }
        }
        if (!edges?.length) {
            const pc = pcurves.filter((p): p is IgesEntity => !!p);
            if (!pc.length) {
                throw new IgesGeometryError('a boundary curve that could not be read');
            }
            edges = pc.flatMap((p) => edges2d(m, p, def()));
            if (reversed) {
                edges = edges.reverse().map((ed) => ({ ...ed, reversed: !ed.reversed }));
            }
        }
        out.push(...edges);
    }
    return out;
}

/** The middle of the widest gap between angles. */
function widestGap(angles: number[]): number {
    const TWO_PI = 2 * Math.PI;
    const sorted = angles.map((a) => ((a % TWO_PI) + TWO_PI) % TWO_PI).sort((a, b) => a - b);
    let best = sorted[0] + TWO_PI - sorted[sorted.length - 1];
    let at = sorted[sorted.length - 1] + best / 2;
    for (let i = 0; i + 1 < sorted.length; i++) {
        const gap = sorted[i + 1] - sorted[i];
        if (gap > best) {
            best = gap;
            at = sorted[i] + gap / 2;
        }
    }
    return at;
}

/** Indices of the edges of a loop that run back along another of its edges (the file's own seam, or a slit). */
function seamPairs(loop: LoopEdge[]): Set<number> {
    const out = new Set<number>();
    if (loop.length > 400) {
        return out;
    }
    // Five points along each edge as it is run; a pair has the same points in the opposite order.
    const marks = loop.map((e) => (e.kind === '3d'
        ? [0, 0.25, 0.5, 0.75, 1].map((k) => e.seg.curve.eval(e.seg.first + (e.seg.last - e.seg.first) * (e.reversed ? 1 - k : k)).p)
        : null));
    for (let i = 0; i < marks.length; i++) {
        const p = marks[i];
        if (!p || out.has(i)) {
            continue;
        }
        const size = Math.max(dist(p[0], p[2]), dist(p[1], p[3]));
        const tol = 1e-6 * Math.max(1, size);
        if (size <= tol) {
            continue;
        }
        for (let j = i + 1; j < marks.length; j++) {
            const q = marks[j];
            if (q && !out.has(j) && p.every((pt, k) => dist(pt, q[4 - k]) <= tol)) {
                out.add(i);
                out.add(j);
                break;
            }
        }
    }
    return out;
}

/**
 * A loop without its seam pairs: the pieces between them, each closed round the surface (ShapeFix puts the seam
 * back where the surface has it), and points along the removed seam edges.
 */
function splitAtSeams(loop: LoopEdge[]): { loops: LoopEdge[][]; seams: V3[][] } {
    const pairs = seamPairs(loop);
    if (!pairs.size) {
        return { loops: [loop], seams: [] };
    }
    const seams = [...pairs].map((i) => loop[i]).filter((e): e is Extract<LoopEdge, { kind: '3d' }> => e.kind === '3d')
        .map((e) => [0, 0.25, 0.5, 0.75, 1].map((k) => e.seg.curve.eval(e.seg.first + (e.seg.last - e.seg.first) * k).p));
    const first = [...pairs][0];
    const loops: LoopEdge[][] = [];
    let current: LoopEdge[] = [];
    for (let k = 1; k <= loop.length; k++) {
        const i = (first + k) % loop.length;
        if (pairs.has(i)) {
            if (current.length) {
                loops.push(current);
            }
            current = [];
        } else {
            current.push(loop[i]);
        }
    }
    if (current.length) {
        loops.push(current);
    }
    return { loops, seams };
}

/**
 * Where to put the seam of a face on a surface round an axis: on the file's own seam when a loop ran along it,
 * else in the widest angular gap the loops leave (a loop round the axis counts only at its vertices). 0 when
 * nothing constrains it.
 */
function seamAngle(axis: NonNullable<SurfaceDef['axis']>, loops: LoopEdge[][], fileSeams: V3[][]): number {
    const y = cross(axis.n, axis.x);
    const angleOf = (p: V3): number => {
        const w = sub(p, axis.c);
        return Math.atan2(dot(w, y), dot(w, axis.x));
    };
    // A seam the file ran along at one angle about the axis (a seam round the axis, such as a torus's, does not count).
    for (const marks of fileSeams) {
        const a = marks.map(angleOf);
        if (a.every((t) => Math.abs(Math.sin((t - a[2]) / 2)) < 1e-7)) {
            return a[2];
        }
    }
    const angles: number[] = [];
    for (const loop of loops) {
        const pts: number[] = [];
        const corners: number[] = [];
        for (const e of loop) {
            if (e.kind !== '3d') {
                return 0;
            }
            const { seg } = e;
            corners.push(angleOf(segStart(seg)));
            for (let i = 0; i < 12; i++) {
                const k = e.reversed ? 1 - i / 12 : i / 12;
                pts.push(angleOf(seg.curve.eval(seg.first + (seg.last - seg.first) * k).p));
            }
        }
        let turn = 0;
        for (let i = 0; i < pts.length; i++) {
            let d = pts[(i + 1) % pts.length] - pts[i];
            d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
            turn += d;
        }
        angles.push(...(Math.abs(turn) < Math.PI ? pts : corners));
    }
    return angles.length ? widestGap(angles) : 0;
}

/** A loop run the other way round. */
const reversedLoop = (loop: Loop): Loop => loop.slice().reverse().map((e) => ({ ...e, reversed: !e.reversed }));

/**
 * The loops turned so the face lies to their left in the record's (u, v): the outer loop anticlockwise, holes
 * clockwise. A loop round a periodic direction (a band's edge) is turned toward the rest of the face; alone, it
 * keeps the file's direction. IGES does not fix the direction of a trimmed surface's loops.
 */
function orientLoops(def: SurfaceDef, loops: Loop[], outerAt: number | 'largest' | null): Loop[] {
    const [uPeriod, vPeriod] = def.periods ?? [0, 0];
    const samples = loops.map((loop) => {
        const uv: [number, number][] = [];
        let hint: [number, number] | undefined;
        for (const e of loop) {
            for (let i = 0; i < 8; i++) {
                const k = e.reversed ? 1 - i / 8 : i / 8;
                let q: [number, number];
                if (e.kind === '3d') {
                    const p = e.seg.curve.eval(e.seg.first + (e.seg.last - e.seg.first) * k).p;
                    q = def.occ.project(p, hint).uv;
                } else {
                    const t = e.uv.knots[0] + (e.uv.knots[e.uv.knots.length - 1] - e.uv.knots[0]) * k;
                    const p = nurbsEval(e.uv, t).p;
                    q = [p[0], p[1]];
                }
                if (uv.length) {
                    const prev = uv[uv.length - 1];
                    if (uPeriod) {
                        q = [q[0] + uPeriod * Math.round((prev[0] - q[0]) / uPeriod), q[1]];
                    }
                    if (vPeriod) {
                        q = [q[0], q[1] + vPeriod * Math.round((prev[1] - q[1]) / vPeriod)];
                    }
                }
                hint = q;
                uv.push(q);
            }
        }
        return uv;
    });
    // The closing step back to the start tells a loop round a periodic direction.
    const turns = samples.map((uv) => {
        const first = uv[0] ?? [0, 0];
        const last = uv[uv.length - 1] ?? [0, 0];
        return {
            du: uPeriod ? -uPeriod * Math.round((first[0] - last[0]) / uPeriod) : 0,
            dv: vPeriod ? -vPeriod * Math.round((first[1] - last[1]) / vPeriod) : 0,
        };
    });
    const areas = samples.map((uv, i) => {
        if (Math.abs(turns[i].du) > uPeriod / 2 && uPeriod || Math.abs(turns[i].dv) > vPeriod / 2 && vPeriod) {
            return null;
        }
        let area = 0;
        for (let k = 0; k < uv.length; k++) {
            const a = uv[k];
            const b = uv[(k + 1) % uv.length];
            area += a[0] * b[1] - b[0] * a[1];
        }
        return area / 2;
    });
    let outer = outerAt === 'largest' ? null : outerAt;
    if (outerAt === 'largest') {
        let best = 0;
        areas.forEach((a, i) => {
            if (a !== null && Math.abs(a) > best) {
                best = Math.abs(a);
                outer = i;
            }
        });
    }
    const out: Loop[] = [];
    loops.forEach((loop, i) => {
        const uv = samples[i];
        if (uv.length < 3) {
            out.push(loop);
            return;
        }
        const { du, dv } = turns[i];
        const wrapsU = uPeriod > 0 && Math.abs(du) > uPeriod / 2;
        const wrapsV = vPeriod > 0 && Math.abs(dv) > vPeriod / 2;
        const area = areas[i];
        if (area !== null) {
            const want = i === outer ? 1 : -1;
            out.push(Math.sign(area) === -want ? reversedLoop(loop) : loop);
            return;
        }
        // Round the surface: the face lies on the side of the other loops (left of +u is +v).
        const others = samples.filter((_, k) => k !== i).flat();
        if (!others.length || (wrapsU && wrapsV)) {
            out.push(loop);
            return;
        }
        const mean = (pts: [number, number][], k: 0 | 1): number => pts.reduce((sum, q) => sum + q[k], 0) / pts.length;
        const along = wrapsU ? du : dv;
        const side = wrapsU ? mean(others, 1) - mean(uv, 1) : -(mean(others, 0) - mean(uv, 0));
        out.push(Math.sign(along) === Math.sign(side) || side === 0 ? loop : reversedLoop(loop));
    });
    return out;
}

/**
 * Writes a face: the surface record and its loops (each a closed wire), vertices shared where curves meet. An edge
 * of a seam pair (`seams`: per loop, edge index to its partner) is written once and used both ways, as
 * OpenCascade has a seam.
 */
function writeFace(def: SurfaceDef, loops: Loop[], ctx: FaceContext, seams: Map<number, number>[] = []): string {
    const w = new BrepWriter();
    const surf = w.surface(def.rec);
    const at = (uv: [number, number]): V3 => def.occ.eval(uv[0], uv[1]).p;
    const wires: [string, number][] = [];
    loops.forEach((loop, li) => {
        const n = loop.length;
        const pairs = seams[li] ?? new Map<number, number>();
        const starts = loop.map((e) => startOf(e, at));
        const ends = loop.map((e) => endOf(e, at));
        // Joint k: where edge k - 1 ends and edge k starts. Joints at the two ends of a seam are one vertex.
        const group = Array.from({ length: n }, (_, k) => k);
        const find = (k: number): number => (group[k] === k ? k : (group[k] = find(group[k])));
        for (const [i, j] of pairs) {
            group[find(i)] = find((j + 1) % n);
            group[find((i + 1) % n)] = find(j);
        }
        const separate = new Set<number>();
        const members = new Map<number, V3[]>();
        for (let k = 0; k < n; k++) {
            const a = ends[(k + n - 1) % n];
            const b = starts[k];
            const gap = dist(a, b);
            if (gap > ctx.maxTolerance * 2) {
                separate.add(k);
                ctx.openLoops++;
            } else {
                ctx.largestGap = Math.max(ctx.largestGap, gap);
            }
            const list = members.get(find(k)) ?? [];
            list.push(...(separate.has(k) ? [b] : [a, b]));
            members.set(find(k), list);
        }
        const vertexOf = new Map<number, number>();
        for (const [root, pts] of members) {
            const c: V3 = [0, 1, 2].map((d) => pts.reduce((sum, q) => sum + q[d], 0) / pts.length) as V3;
            const tol = Math.max(ctx.precision, BASE_TOL, ...pts.map((q) => dist(q, c) * 1.01));
            vertexOf.set(root, w.vertex(c, tol));
        }
        const written = new Map<number, { pos: number; orientation: string }>();
        const edges: [string, number][] = [];
        for (let i = 0; i < n; i++) {
            const e = loop[i];
            const partner = pairs.get(i);
            const done = partner !== undefined ? written.get(partner) : undefined;
            if (done) {
                edges.push([done.orientation === '+' ? '-' : '+', done.pos]);
                continue;
            }
            let vs = vertexOf.get(find(i))!;
            let ve = vertexOf.get(find((i + 1) % n))!;
            if (separate.has((i + 1) % n)) {
                ve = w.vertex(ends[i], Math.max(ctx.precision, BASE_TOL));
            }
            if (e.reversed) {
                [vs, ve] = [ve, vs];
            }
            let pos: number;
            if (e.kind === '3d') {
                const r = curveRecord(e.seg);
                pos = w.edge3d(w.curve(r.rec), r.first, r.last, vs, ve, BASE_TOL);
            } else {
                const k0 = e.uv.knots[0];
                const k1 = e.uv.knots[e.uv.knots.length - 1];
                pos = w.edge2d(w.curve2d(nurbsRecord(e.uv, 2)), surf, k0, k1, vs, ve, BASE_TOL);
            }
            const orientation = e.reversed ? '-' : '+';
            written.set(i, { pos, orientation });
            edges.push([orientation, pos]);
        }
        wires.push(['+', w.wire(edges)]);
    });
    return w.toString(w.face(surf, BASE_TOL, wires));
}

/** Reads a written face, builds missing 3D curves, bounds it by the surface's own boundary when asked, and fixes it. */
function buildFace(text: string, def: SurfaceDef, natural: boolean, parameterEdges: boolean, ctx: FaceContext): TopoShape[] {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const read = r(oc.BRepToolsWrapper.Read(text));
        if (read.IsNull()) {
            throw new IgesGeometryError('OpenCascade could not read the face');
        }
        let face = r(oc.TopoDS.Face(read));
        const kinds = oc.TopAbs_ShapeEnum;
        if (parameterEdges) {
            // Edges known only in the parameter space get their 3D curves (edges that have one are left alone).
            oc.BRepLib.BuildCurves3d(face);
        }
        if (natural) {
            const b = def.bounds;
            if (!b) {
                throw new IgesGeometryError(`a ${def.kind} face bounded by its surface's own boundary`);
            }
            const surface = r(oc.BRep_Tool.Surface(face));
            const maker = r(new oc.BRepBuilderAPI_MakeFace(surface, b[0], b[1], b[2], b[3], 1e-7));
            if (!maker.IsDone()) {
                throw new IgesGeometryError(`the ${def.kind} surface could not be bounded`);
            }
            let whole = r(maker.Face());
            const wires = r(new oc.TopExp_Explorer(face, kinds.TopAbs_WIRE, kinds.TopAbs_SHAPE));
            for (; wires.More(); wires.Next()) {
                const add = r(new oc.BRepBuilderAPI_MakeFace(whole, oc.TopoDS.Wire(wires.Current())));
                if (add.IsDone()) {
                    whole = r(add.Face());
                }
            }
            face = whole;
        }
        const fix = r(new oc.ShapeFix_Face(face));
        fix.SetPrecision(ctx.precision);
        fix.SetMaxTolerance(ctx.maxTolerance);
        fix.Perform(r(new oc.Message_ProgressRange()));
        const result = r(fix.Result());
        const out: TopoShape[] = [];
        const faces = r(new oc.TopExp_Explorer(result, kinds.TopAbs_FACE, kinds.TopAbs_SHAPE));
        for (; faces.More(); faces.Next()) {
            out.push(faces.Current());
        }
        if (!out.length) {
            throw new IgesGeometryError('the face vanished when it was fixed');
        }
        return out;
    } finally {
        gc();
    }
}

/** A face from a surface and its boundaries (`outer` null: the surface's own boundary). */
function faceOf(m: IgesModel, surface: IgesEntity, x: Xf, def0: () => SurfaceDef, outer: (() => LoopEdge[]) | null,
    inner: (() => LoopEdge[])[], ctx: FaceContext): TopoShape[] {
    const natural = outer === null;
    const raw = [...(outer ? [outer()] : []), ...inner.map((f) => f())].filter((l) => l.length > 0);
    let def = def0();
    const parameterEdges = raw.some((l) => l.some((e) => e.kind === '2d'));
    if (parameterEdges) {
        ctx.parameterLoops++;
    }
    const at0 = (uv: [number, number]): V3 => def.occ.eval(uv[0], uv[1]).p;
    let loops = raw.map((l) => chain(l, at0));
    // The outer boundary may split at the file's seam into rings (or, at a slit, into an outer loop and a hole).
    // A closed surface without an axis keeps its seam edges: ShapeFix cannot always put its seam back.
    let outerSplit = false;
    const [uPeriod, vPeriod] = def.periods ?? [0, 0];
    const keepSeams = !def.axis && (uPeriod > 0 || vPeriod > 0);
    if (!parameterEdges && !natural && !keepSeams) {
        const fileSeams: V3[][] = [];
        loops = loops.flatMap((l, i) => {
            const split = splitAtSeams(l);
            fileSeams.push(...split.seams);
            if (i === 0) {
                outerSplit = split.loops.length !== 1 || split.loops[0] !== l;
            }
            return split.loops;
        });
        if (def.axis) {
            const seam = seamAngle(def.axis, loops, fileSeams);
            if (Math.abs(seam) > 1e-12) {
                def = surfaceDef(m, surface, x, { seam });
            }
        }
    }
    const oriented = orientLoops(def, loops, natural ? null : outerSplit ? 'largest' : 0);
    const seams = keepSeams ? oriented.map((l) => {
        const pairs = [...seamPairs(l)];
        const map = new Map<number, number>();
        for (let k = 0; k + 1 < pairs.length; k += 2) {
            map.set(pairs[k], pairs[k + 1]);
            map.set(pairs[k + 1], pairs[k]);
        }
        return map;
    }) : [];
    const text = writeFace(def, oriented, ctx, seams);
    return buildFace(text, def, natural, parameterEdges, ctx);
}

/** The faces of a trimmed surface entity (144). */
export function trimmedSurface(m: IgesModel, e: IgesEntity, parent: Xf, ctx: FaceContext): TopoShape[] {
    const x = m.xf(e, parent);
    const surface = m.need(e.params[0], 'the surface of a trimmed surface');
    const n1 = int(e, 1);
    const n2 = int(e, 2);
    const outerEntity = m.entity(int(e, 3));
    const innerEntities = Array.from({ length: n2 }, (_, k) => m.entity(int(e, 4 + k))).filter((c): c is IgesEntity => !!c);
    // A boundary given only in the parameter space needs the surface in its IGES parameters.
    const parametric = [...(n1 !== 0 && outerEntity ? [outerEntity] : []), ...innerEntities].some((c) => !m.entity(int(c, 3)));
    let def: SurfaceDef | null = null;
    const lazyDef = (): SurfaceDef => (def ??= surfaceDef(m, surface, x, { natural: n1 === 0, parametric }));
    const outer = n1 !== 0 && outerEntity ? () => loop142(m, outerEntity, x, lazyDef) : null;
    const inner = innerEntities.map((c) => () => loop142(m, c, x, lazyDef));
    return faceOf(m, surface, x, lazyDef, outer, inner, ctx);
}

/** The faces of a bounded surface entity (143): its first boundary is the outer one. */
export function boundedSurface(m: IgesModel, e: IgesEntity, parent: Xf, ctx: FaceContext): TopoShape[] {
    const x = m.xf(e, parent);
    const surface = m.need(e.params[1], 'the surface of a bounded surface');
    const n = int(e, 2);
    let def: SurfaceDef | null = null;
    const bounds = Array.from({ length: n }, (_, k) => m.entity(int(e, 3 + k))).filter((c): c is IgesEntity => !!c);
    const lazyDef = (): SurfaceDef => (def ??= surfaceDef(m, surface, x, { natural: !bounds.length }));
    if (!bounds.length) {
        return faceOf(m, surface, x, lazyDef, null, [], ctx);
    }
    return faceOf(m, surface, x, lazyDef, () => loop141(m, bounds[0], x, lazyDef), bounds.slice(1).map((b) => () => loop141(m, b, x, lazyDef)), ctx);
}

/** A whole untrimmed surface (128, 120 ...), bounded by its own parameter domain. */
export function untrimmedSurface(m: IgesModel, e: IgesEntity, parent: Xf, ctx: FaceContext): TopoShape[] {
    let def: SurfaceDef | null = null;
    return faceOf(m, e, parent, () => (def ??= surfaceDef(m, e, parent, { natural: true })), null, [], ctx);
}

/** A bounded plane (108 form 1): the plane inside its bounding curve. */
export function boundedPlane(m: IgesModel, e: IgesEntity, parent: Xf, ctx: FaceContext): TopoShape[] {
    const x = m.xf(e, parent);
    const curve = m.entity(int(e, 4));
    if (!curve) {
        throw new IgesGeometryError('an unbounded plane');
    }
    // The plane's own transformation is applied by surfaceDef; its curve's is relative to the plane's.
    let def: SurfaceDef | null = null;
    return faceOf(m, e, parent, () => (def ??= surfaceDef(m, e, parent)), () => edges3d(m, curve, x), [], ctx);
}

/** A face on a surface entity bounded by loops of 3D edges (B-rep solid faces, 510). */
export function faceFromLoops(m: IgesModel, surface: IgesEntity, x: Xf, loops: LoopEdge[][], ctx: FaceContext): TopoShape[] {
    let def: SurfaceDef | null = null;
    const lazy = (): SurfaceDef => (def ??= surfaceDef(m, surface, x));
    if (!loops.length) {
        throw new IgesGeometryError('a face without loops');
    }
    return faceOf(m, surface, x, lazy, () => loops[0], loops.slice(1).map((l) => () => l), ctx);
}
