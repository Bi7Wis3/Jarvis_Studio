// Parasolid bodies as OpenCascade B-rep text (the BRepTools format): faces on their surfaces, bounded by edges
// with 3D curves, vertices and edges shared as the Parasolid topology has them. OpenCascade reads it as is;
// pcurves and seams are added afterwards (occ.ts).

import {
    cross, dist, dot, knotsWithMults, nurbsSegment, nurbsJoin, surfClamp, unit, sub,
    type Nurbs, type NurbsSurf, type V3,
} from './nurbs.js';
import {
    BlendSurface, CircleCurve, EllipseCurve, LineCurve, NurbsCurve, type Curve, type Surface,
} from './geometry.js';
import { blendPatch, CURVE_TOL, densify, hermiteNurbs, spCurveOnBlend } from './rebuild.js';
import { MM, UnsupportedGeometry, type XtModel } from './xtModel.js';
import type { XtNode } from './xtParse.js';

const fmt = (x: number): string => (x === 0 ? '0' : String(x));
const v3 = (v: V3): string => `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`;

/** Record of a NURBS curve (3D, or 2D with z = 0 when `dims` is 2). */
export function nurbsRecord(c: Nurbs, dims: 2 | 3 = 3): string {
    const rational = c.rational && c.cw.some((pw) => Math.abs(pw[3] - c.cw[0][3]) > 1e-15 * Math.abs(c.cw[0][3]));
    const { values, mults } = knotsWithMults(c.knots);
    const poles = c.cw.map((pw) => {
        const w = pw[3];
        const xyz = dims === 3 ? `${fmt(pw[0] / w)} ${fmt(pw[1] / w)} ${fmt(pw[2] / w)}` : `${fmt(pw[0] / w)} ${fmt(pw[1] / w)}`;
        return rational ? `${xyz} ${fmt(w)}` : xyz;
    });
    return `7 ${rational ? 1 : 0} 0 ${c.degree} ${c.cw.length} ${values.length} ${poles.join(' ')} ${values.map((v, i) => `${fmt(v)} ${mults[i]}`).join(' ')}`;
}

export function nurbsSurfRecord(s: NurbsSurf): string {
    const rational = s.rational && s.cw.some((row) => row.some((pw) => Math.abs(pw[3] - s.cw[0][0][3]) > 1e-15));
    const u = knotsWithMults(s.uKnots);
    const v = knotsWithMults(s.vKnots);
    const poles: string[] = [];
    for (const row of s.cw) {
        for (const pw of row) {
            const w = pw[3];
            poles.push(rational ? `${fmt(pw[0] / w)} ${fmt(pw[1] / w)} ${fmt(pw[2] / w)} ${fmt(w)}` : `${fmt(pw[0] / w)} ${fmt(pw[1] / w)} ${fmt(pw[2] / w)}`);
        }
    }
    const r = rational ? 1 : 0;
    return `9 ${r} ${r} 0 0 ${s.uDegree} ${s.vDegree} ${s.cw.length} ${s.cw[0].length} ${u.values.length} ${v.values.length} `
        + `${poles.join(' ')} ${u.values.map((k, i) => `${fmt(k)} ${u.mults[i]}`).join(' ')} ${v.values.map((k, i) => `${fmt(k)} ${v.mults[i]}`).join(' ')}`;
}

interface ShapeRec {
    head: string;
    flags: string;
    subs: [string, number][];
}

/** Accumulates the sections of a B-rep text file. Shapes are numbered in write order; sub-shapes first. */
export class BrepText {
    private readonly curves: string[] = [];
    private readonly surfaces: string[] = [];
    private readonly shapes: ShapeRec[] = [];

    curve(rec: string): number {
        this.curves.push(rec);
        return this.curves.length;
    }

    surface(rec: string): number {
        this.surfaces.push(rec);
        return this.surfaces.length;
    }

    shape(head: string, flags: string, subs: [string, number][] = []): number {
        this.shapes.push({ head, flags, subs });
        return this.shapes.length - 1;
    }

    vertex(p: V3, tol: number): number {
        return this.shape(`Ve\n${fmt(tol)}\n${v3(p)}\n0 0\n`, '0101101');
    }

    toString(root: number): string {
        const n = this.shapes.length;
        const ref = (pos: number): number => n - pos;
        const out: string[] = ['DBRep_DrawableShape', '', 'CASCADE Topology V3, (c) Open Cascade', 'Locations 0', 'Curve2ds 0'];
        out.push(`Curves ${this.curves.length}`, ...this.curves);
        out.push('Polygon3D 0', 'PolygonOnTriangulations 0');
        out.push(`Surfaces ${this.surfaces.length}`, ...this.surfaces);
        out.push('Triangulations 0', '', `TShapes ${n}`);
        for (const s of this.shapes) {
            const subs = s.subs.map(([o, p]) => `${o}${ref(p)} 0`).join(' ');
            out.push(`${s.head}\n${s.flags}\n${subs ? `${subs} *` : '*'}`);
        }
        out.push('', `+${ref(root)} 0`, '');
        return out.join('\n');
    }
}

// ---- Curves on edges ----------------------------------------------------------------------------------------

/** The curve between two parameters as a record, with the record's own parameter range. */
function curveRecord(curve: Curve, first: number, last: number): { rec: string; first: number; last: number } {
    if (curve instanceof LineCurve) {
        return { rec: `1 ${v3(curve.p0)} ${v3(curve.dir)}`, first, last };
    }
    if (curve instanceof CircleCurve) {
        return { rec: `2 ${v3(curve.c)} ${v3(curve.n)} ${v3(curve.x)} ${v3(curve.y)} ${fmt(curve.r)}`, first, last };
    }
    if (curve instanceof EllipseCurve) {
        return { rec: `3 ${v3(curve.c)} ${v3(curve.n)} ${v3(curve.x)} ${v3(curve.y)} ${fmt(curve.a)} ${fmt(curve.b)}`, first, last };
    }
    if (curve instanceof NurbsCurve) {
        const piece = nurbsPiece(curve, first, last);
        return { rec: nurbsRecord(piece), first, last };
    }
    // Any other curve (an SP-curve): a cubic B-spline within CURVE_TOL.
    const fit = fitCurve(curve, first, last);
    return { rec: nurbsRecord(fit), first: fit.knots[0], last: fit.knots[fit.knots.length - 1] };
}

/** The exact piece of a B-spline curve over [first, last], across the seam of a closed one. */
function nurbsPiece(curve: NurbsCurve, first: number, last: number): Nurbs {
    const [a, b] = curve.range;
    const eps = 1e-12 * Math.max(1, b - a);
    const P = curve.period;
    let f = first;
    let l = last;
    if (P && f >= b - eps) {
        f -= P;
        l -= P;
    }
    f = Math.max(a, f);
    if (!P || l <= b + eps) {
        return nurbsSegment(curve.nurbs, f, Math.min(b, l));
    }
    const head = nurbsSegment(curve.nurbs, f, b);
    const tail = l - P;
    if (tail <= a + eps) {
        return head;
    }
    return nurbsJoin(head, nurbsSegment(curve.nurbs, a, Math.min(b, tail)));
}

/** A curve between two parameters, fitted as a cubic Hermite B-spline (chord-length parameters). */
function fitCurve(curve: Curve, first: number, last: number): Nurbs {
    const n = 24;
    const pts: V3[] = [];
    for (let i = 0; i <= n; i++) {
        pts.push(curve.eval(first + ((last - first) * i) / n).p);
    }
    let hint = first;
    const near = (x: V3): number => {
        hint = curve.project(x, hint);
        return hint;
    };
    const points = densify(pts, {
        onCurve: (x) => curve.eval(near(x)).p,
        error: (x) => dist(x, curve.eval(near(x)).p),
        tangent: (p) => unit(curve.eval(near(p)).d),
    });
    return hermiteNurbs(points);
}

// ---- Surfaces -----------------------------------------------------------------------------------------------

interface SurfaceRec {
    rec: string;
    /** True when the record's natural normal is opposite to Parasolid's. */
    flip: boolean;
}

/** A curve over its whole range as a record (sections and profiles of swept and spun surfaces). */
function wholeCurveRecord(curve: Curve): string {
    if (curve instanceof NurbsCurve) {
        return nurbsRecord(nurbsSegment(curve.nurbs, curve.range[0], curve.range[1]));
    }
    if (curve instanceof LineCurve || curve instanceof CircleCurve || curve instanceof EllipseCurve) {
        return curveRecord(curve, 0, 1).rec;
    }
    throw new UnsupportedGeometry(`A ${curve.kind} curve as a section or profile`);
}

/**
 * A surface as a record. `seam` turns the x-axis of a surface of revolution (cylinder, cone, sphere, torus)
 * about its axis by that angle, which moves its parameter seam: the face's seam edge is placed there.
 */
function surfaceRecord(m: XtModel, s: XtNode, seam = 0, tubeSeam = 0): SurfaceRec {
    const name = m.typeName(s);
    const vec = (field: string, k = 1): V3 => {
        const v = m.vector(s, field, k);
        if (field !== 'x_axis' || seam === 0) {
            return v;
        }
        const a = m.vector(s, 'axis');
        const y = cross(a, v);
        return [v[0] * Math.cos(seam) + y[0] * Math.sin(seam), v[1] * Math.cos(seam) + y[1] * Math.sin(seam),
            v[2] * Math.cos(seam) + y[2] * Math.sin(seam)];
    };
    switch (name) {
        case 'PLANE': {
            const n = vec('normal');
            const x = vec('x_axis');
            return { rec: `1 ${v3(vec('pvec', MM))} ${v3(n)} ${v3(x)} ${v3(cross(n, x))}`, flip: false };
        }
        case 'CYLINDER': {
            const a = vec('axis');
            const x = vec('x_axis');
            return { rec: `2 ${v3(vec('pvec', MM))} ${v3(a)} ${v3(x)} ${v3(cross(a, x))} ${fmt((s.f.radius as number) * MM)}`, flip: false };
        }
        case 'CONE': {
            const a = vec('axis');
            const x = vec('x_axis');
            const angle = Math.atan2(s.f.sin_half_angle as number, s.f.cos_half_angle as number);
            return {
                rec: `3 ${v3(vec('pvec', MM))} ${v3(a)} ${v3(x)} ${v3(cross(a, x))} ${fmt((s.f.radius as number) * MM)} ${fmt(angle)}`,
                flip: false,
            };
        }
        case 'SPHERE': {
            const a = vec('axis');
            const x = vec('x_axis');
            return { rec: `4 ${v3(vec('centre', MM))} ${v3(a)} ${v3(x)} ${v3(cross(a, x))} ${fmt((s.f.radius as number) * MM)}`, flip: false };
        }
        case 'TORUS': {
            const a = vec('axis');
            const x = vec('x_axis');
            const c = vec('centre', MM);
            const major = (s.f.major_radius as number) * MM;
            const minor = (s.f.minor_radius as number) * MM;
            if (major > 0 && tubeSeam === 0) {
                return { rec: `5 ${v3(c)} ${v3(a)} ${v3(x)} ${v3(cross(a, x))} ${fmt(major)} ${fmt(minor)}`, flip: false };
            }
            // The same surface as the circle (centre + major x, radius minor, in the plane of x and the axis)
            // spun about the axis: for a lemon torus, and to start the tube angle at `tubeSeam`.
            const cc: V3 = [c[0] + x[0] * major, c[1] + x[1] * major, c[2] + x[2] * major];
            const cs = Math.cos(tubeSeam);
            const sn = Math.sin(tubeSeam);
            const dx: V3 = [x[0] * cs + a[0] * sn, x[1] * cs + a[1] * sn, x[2] * cs + a[2] * sn];
            const dy: V3 = [-x[0] * sn + a[0] * cs, -x[1] * sn + a[1] * cs, -x[2] * sn + a[2] * cs];
            const n = cross(x, a);
            return { rec: `7 ${v3(c)} ${v3(a)}\n2 ${v3(cc)} ${v3(n)} ${v3(dx)} ${v3(dy)} ${fmt(minor)}`, flip: false };
        }
        case 'B_SURFACE': {
            const bs = m.surface(s.index) as unknown as { nurbs: NurbsSurf };
            return { rec: nurbsSurfRecord(surfClamp(bs.nurbs)), flip: false };
        }
        case 'OFFSET_SURF': {
            const basisNode = m.need(s.f.surface, 'offset basis');
            const basis = surfaceRecord(m, basisNode);
            const off = m.surface(s.index) as unknown as { d: number };
            return { rec: `11 ${fmt(basis.flip ? -off.d : off.d)}\n${basis.rec}`, flip: basis.flip };
        }
        case 'SWEPT_SURF':
            return { rec: `6 ${v3(vec('sweep'))}\n${wholeCurveRecord(m.curve(s.f.section))}`, flip: false };
        case 'SPUN_SURF':
            // OpenCascade's surface of revolution has the angle first: the parameters swap, the normal flips.
            return { rec: `7 ${v3(vec('base', MM))} ${v3(vec('axis'))}\n${wholeCurveRecord(m.curve(s.f.profile))}`, flip: true };
        default:
            throw new UnsupportedGeometry(`${name.toLowerCase().replace(/_/g, ' ')} surfaces are not supported`);
    }
}

/**
 * Where to put the seam of a face on a surface of revolution: in the widest angular gap left by the loops that
 * do not go round the axis (a hole through a cylinder wall must not straddle the seam). 0 when no loop
 * constrains it.
 */
function seamAngle(m: XtModel, face: XtNode, s: XtNode, edgeGeo: Map<number, EdgeGeo>, centreTubeSeam: boolean): [number, number] {
    if (!['CYLINDER', 'CONE', 'SPHERE', 'TORUS'].includes(m.typeName(s))) {
        return [0, 0];
    }
    const surface = m.surface(s.index);
    const angles: number[] = [];
    const vs: number[] = [];
    for (const loop of m.chain(face.f.loop, 'next')) {
        const fin = m.node(loop.f.fin);
        if (!fin) {
            continue;
        }
        const us: number[] = [];
        for (const f of m.ring(fin, 'forward')) {
            const g = edgeGeo.get(m.node(f.f.edge)?.index ?? -1);
            if (!g) {
                continue;
            }
            const along = (f.f.sense !== '-') === g.aligned;
            for (let i = 0; i < 12; i++) {
                const k = along ? i / 12 : 1 - i / 12;
                const uv = surface.project(g.curve.eval(g.first + (g.last - g.first) * k).p).uv;
                us.push(uv[0]);
                vs.push(uv[1]);
            }
        }
        let turn = 0;
        for (let i = 0; i < us.length; i++) {
            let d = us[(i + 1) % us.length] - us[i];
            d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
            turn += d;
        }
        if (Math.abs(turn) < Math.PI) {
            angles.push(...us);
        } else {
            // A loop round the axis: keep the seam off its vertices, so no edge of it is cut.
            for (const f of m.ring(fin, 'forward')) {
                const v = m.node(f.f.vertex);
                if (v) {
                    angles.push(surface.project(m.point(v)).uv[0]);
                }
            }
        }
    }
    // Around a torus tube too, when the face straddles the outer equator where its v seam lies.
    const vSeam = m.typeName(s) === 'TORUS' && vs.length > 0 ? widestGap(vs) : null;
    return [angles.length > 0 ? widestGap(angles).middle : 0, vSeam && (centreTubeSeam || !vSeam.containsZero) ? vSeam.middle : 0];
}

/** The middle of the widest gap between angles, and whether that gap contains angle 0. */
function widestGap(angles: number[]): { middle: number; containsZero: boolean } {
    const sorted = angles.map((a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
    let best = sorted[0] + 2 * Math.PI - sorted[sorted.length - 1];
    let at = sorted[sorted.length - 1] + best / 2;
    let zero = true;
    for (let i = 0; i + 1 < sorted.length; i++) {
        const gap = sorted[i + 1] - sorted[i];
        if (gap > best) {
            best = gap;
            at = sorted[i] + gap / 2;
            zero = false;
        }
    }
    return { middle: at, containsZero: zero };
}

// ---- Bodies -------------------------------------------------------------------------------------------------

export interface BodyBrep {
    text: string;
    faces: number;
    solids: number;
    /** Faces whose surface had to be approximated, with the largest deviation found (mm). */
    approximated: { kind: string; count: number; error: number }[];
    /** Largest distance of an edge curve from the faces it bounds, mm, and that edge's node index. */
    edgeDeviation: { dev: number; edge: number };
    /** Every edge's deviation (for diagnostics). */
    edgeDeviations: { edge: number; dev: number }[];
}

interface EdgeGeo {
    /** Position of the edge in the text. */
    pos: number;
    /** True when the written edge runs the same way as the Parasolid edge. */
    aligned: boolean;
    curve: Curve;
    first: number;
    last: number;
}

/** A Parasolid edge's curve and how the edge runs along it (+1 with increasing parameter, -1 against, null: unknown). */
function edgeCurve(m: XtModel, edge: XtNode, ps: V3 | null, pe: V3 | null): { curve: Curve; dir: number | null; tolerant: boolean } {
    // An SP-curve on a blend is rebuilt between the edge's two faces (see spCurveOnBlend).
    const onBlend = (sp: XtNode | undefined, sense: number): Curve | null => {
        if (!sp || m.typeName(sp) !== 'SP_CURVE' || m.typeName(m.node(sp.f.surface)) !== 'BLENDED_EDGE') {
            return null;
        }
        if (!ps || !pe) {
            throw new UnsupportedGeometry('A closed edge on a blend');
        }
        const faces = m.ring(m.need(edge.f.fin, 'edge fin'), 'other')
            .map((f) => m.node(m.node(f.f.loop)?.f.face))
            .filter((f): f is XtNode => Boolean(f))
            .map((f) => m.surface(f.f.surface));
        if (faces.length !== 2) {
            throw new UnsupportedGeometry('An edge on a blend without two faces');
        }
        return spCurveOnBlend(m, sp, sense > 0 ? [ps, pe] : [pe, ps], [faces[0], faces[1]]);
    };
    const c = m.node(edge.f.curve);
    if (c) {
        const basis = m.typeName(c) === 'TRIMMED_CURVE' ? m.node(c.f.basis_curve) : c;
        const rebuilt = onBlend(basis, m.sense(c) * (basis === c ? 1 : m.sense(basis!)));
        if (rebuilt) {
            return { curve: rebuilt, dir: null, tolerant: false };
        }
        if (m.typeName(c) === 'TRIMMED_CURVE') {
            const basis = m.need(c.f.basis_curve, 'trimmed curve basis');
            return { curve: m.curve(c.index), dir: m.sense(c) * m.sense(basis), tolerant: false };
        }
        return { curve: m.curve(c.index), dir: m.sense(c), tolerant: false };
    }
    // A tolerant edge: each fin has a trimmed SP-curve on its face. Use one not on a blend.
    const fins = m.ring(m.need(edge.f.fin, 'edge fin'), 'other').filter((f) => m.node(f.f.curve));
    const spSurface = (f: XtNode): string => {
        const tc = m.node(f.f.curve);
        const sp = tc && m.typeName(tc) === 'TRIMMED_CURVE' ? m.node(tc.f.basis_curve) : tc;
        return sp && m.typeName(sp) === 'SP_CURVE' ? m.typeName(m.node(sp.f.surface)) : '';
    };
    const pick = fins.find((f) => spSurface(f) !== 'BLENDED_EDGE') ?? fins[0];
    if (!pick) {
        throw new UnsupportedGeometry('An edge without a curve');
    }
    if (spSurface(pick) === 'BLENDED_EDGE') {
        const tc = m.need(pick.f.curve, 'fin curve');
        const sp = m.typeName(tc) === 'TRIMMED_CURVE' ? m.need(tc.f.basis_curve, 'trimmed basis') : tc;
        return { curve: onBlend(sp, (pick.f.sense === '-' ? -1 : 1) * m.sense(tc))!, dir: null, tolerant: true };
    }
    return { curve: m.curve(pick.f.curve), dir: null, tolerant: true };
}

/** Edge parameters on its curve from the vertex positions; ring edges take the whole closed curve. */
function edgeRange(curve: Curve, dir: number | null, ps: V3 | null, pe: V3 | null): { first: number; last: number; aligned: boolean } {
    const P = curve.period;
    if (!ps || !pe) {
        if (!P) {
            throw new UnsupportedGeometry('A ring edge on an open curve');
        }
        const a = Number.isFinite(curve.range[0]) ? curve.range[0] : 0;
        return { first: a, last: a + P, aligned: dir === null || dir > 0 };
    }
    const ts = curve.project(ps);
    const te = curve.project(pe, undefined);
    if (P) {
        const aligned = dir === null ? true : dir > 0;
        const [f, l] = aligned ? [ts, te] : [te, ts];
        let span = (((l - f) % P) + P) % P;
        if (span < 1e-12 * P || (dist(ps, pe) < 1e-9 && span > P * (1 - 1e-9))) {
            span = P;
        }
        return { first: f, last: f + span, aligned };
    }
    if (Math.abs(te - ts) < 1e-14) {
        throw new UnsupportedGeometry('An edge of zero length');
    }
    return { first: Math.min(ts, te), last: Math.max(ts, te), aligned: te > ts };
}

export interface BrepOptions {
    /**
     * Write every torus as the circle spun about its axis with the tube angle starting in the gap the face leaves.
     * Some faces need it for OpenCascade to place their pcurves consistently.
     */
    centreTubeSeams?: boolean;
}

export function bodyToBrep(m: XtModel, body: XtNode, options: BrepOptions = {}): BodyBrep {
    const brep = new BrepText();
    const regions = m.chain(body.f.region, 'next').filter((r) => r.f.type === 'S');
    if (regions.length === 0) {
        throw new UnsupportedGeometry('The body has no solid region');
    }
    // Faces per shell; faces on a shell's front chain face into the region and are turned round.
    const shells = regions.map((r) => m.chain(r.f.shell, 'next').map((sh) => [
        ...m.chain(sh.f.face, 'next').map((face) => ({ face, turned: false })),
        ...m.chain(sh.f.front_face, 'next_front').map((face) => ({ face, turned: true })),
    ]));
    const allFaces = shells.flat(2);

    // Edges and vertices, in first-use order.
    const edges = new Map<number, XtNode>();
    for (const { face } of allFaces) {
        for (const loop of m.chain(face.f.loop, 'next')) {
            const fin = m.node(loop.f.fin);
            if (!fin) {
                continue;
            }
            for (const f of m.ring(fin, 'forward')) {
                const e = m.node(f.f.edge);
                if (e) {
                    edges.set(e.index, e);
                }
            }
        }
    }

    // Edge geometry first: vertex tolerances depend on how close the curve ends come.
    interface Pending {
        edge: XtNode;
        curve: Curve;
        first: number;
        last: number;
        aligned: boolean;
        /** Vertex nodes at first and last (null: a ring edge's own vertex). */
        vFirst: XtNode | null;
        vLast: XtNode | null;
        tol: number;
    }
    const pending: Pending[] = [];
    const deviations: { edge: number; dev: number }[] = [];
    const vertexTol = new Map<number, number>();
    const bump = (v: XtNode | null, d: number): void => {
        if (v) {
            vertexTol.set(v.index, Math.max(vertexTol.get(v.index) ?? 0, d));
        }
    };
    for (const edge of edges.values()) {
        let vs: XtNode | null = null;
        let ve: XtNode | null = null;
        for (const f of m.ring(m.need(edge.f.fin, 'edge fin'), 'other')) {
            const v = m.node(f.f.vertex) ?? null;
            if (f.f.sense === '-') {
                vs ??= v;
            } else {
                ve ??= v;
            }
        }
        const ps = vs ? m.point(vs) : null;
        const pe = ve ? m.point(ve) : null;
        const { curve, dir, tolerant } = edgeCurve(m, edge, ps, pe);
        const range = edgeRange(curve, dir, ps, pe);
        const vFirst = range.aligned ? vs : ve;
        const vLast = range.aligned ? ve : vs;
        // How far the edge strays from the faces it bounds (the exact Parasolid surfaces): its tolerance.
        let dev = 0;
        const surfaces: Surface[] = [];
        for (const f of m.ring(m.need(edge.f.fin, 'edge fin'), 'other')) {
            const face = m.node(m.node(f.f.loop)?.f.face);
            const s = face ? m.node(face.f.surface) : undefined;
            if (s) {
                surfaces.push(m.surface(s.index));
            }
        }
        for (let i = 0; i <= 8; i++) {
            const p = curve.eval(range.first + ((range.last - range.first) * i) / 8).p;
            for (const s of surfaces) {
                dev = Math.max(dev, dist(s.project(p).p, p));
            }
        }
        deviations.push({ edge: edge.index, dev });
        const tol = Math.max(1e-7, m.tolerance(edge) ?? 0, tolerant ? CURVE_TOL : 0, Math.min(dev * 1.5, 1e-3));
        if (vFirst) {
            bump(vFirst, dist(curve.eval(range.first).p, m.point(vFirst)));
        }
        if (vLast) {
            bump(vLast, dist(curve.eval(range.last).p, m.point(vLast)));
        }
        pending.push({ edge, curve, ...range, vFirst, vLast, tol });
    }

    const vertexPos = new Map<number, number>();
    const vertexOf = (v: XtNode): number => {
        let pos = vertexPos.get(v.index);
        if (pos === undefined) {
            const tol = Math.max(1e-7, m.tolerance(v) ?? 0, (vertexTol.get(v.index) ?? 0) * 1.5);
            pos = brep.vertex(m.point(v), tol);
            vertexPos.set(v.index, pos);
        }
        return pos;
    };
    const edgeGeo = new Map<number, EdgeGeo>();
    for (const p of pending) {
        const rec = curveRecord(p.curve, p.first, p.last);
        const ci = brep.curve(rec.rec);
        let v1: number;
        let v2: number;
        if (p.vFirst && p.vLast) {
            v1 = vertexOf(p.vFirst);
            v2 = vertexOf(p.vLast);
        } else {
            // A ring edge: one vertex where the closed curve starts.
            v1 = brep.vertex(p.curve.eval(p.first).p, 1e-7);
            v2 = v1;
        }
        const pos = brep.shape(`Ed\n ${fmt(p.tol)} 1 1 0\n1  ${ci} 0 ${fmt(rec.first)} ${fmt(rec.last)}\n0\n`, '0101000', [['+', v1], ['-', v2]]);
        edgeGeo.set(p.edge.index, { pos, aligned: p.aligned, curve: p.curve, first: p.first, last: p.last });
    }

    // Face orientation relative to Parasolid's natural normal: outward when the face and surface senses agree.
    const psSign = (face: XtNode, turned: boolean): number => {
        const s = m.node(face.f.surface);
        const sign = (face.f.sense === '-' ? -1 : 1) * (s && s.f.sense === '-' ? -1 : 1);
        return turned ? -sign : sign;
    };
    const approximated = new Map<string, { count: number; error: number }>();
    const faceInfo = new Map<number, { surf: number; sign: number }>();
    const blendFaces: { face: XtNode; turned: boolean; blend: BlendSurface; surf: number }[] = [];
    for (const { face, turned } of allFaces) {
        const s = m.need(face.f.surface, 'face surface');
        const kind = m.typeName(s);
        if (kind === 'BLENDED_EDGE') {
            const blend = m.surface(s.index);
            if (!(blend instanceof BlendSurface)) {
                throw new UnsupportedGeometry('A blend face without its blend');
            }
            const samples: V3[] = [];
            for (const loop of m.chain(face.f.loop, 'next')) {
                for (const f of m.ring(m.need(loop.f.fin, 'loop fin'), 'forward')) {
                    const g = edgeGeo.get(m.node(f.f.edge)?.index ?? -1);
                    if (g) {
                        for (let i = 0; i <= 16; i++) {
                            samples.push(g.curve.eval(g.first + ((g.last - g.first) * i) / 16).p);
                        }
                    }
                }
            }
            const patch = blendPatch(blend, samples);
            const surf = brep.surface(nurbsSurfRecord(patch.surface));
            const a = approximated.get('rolling-ball blend') ?? { count: 0, error: 0 };
            approximated.set('rolling-ball blend', { count: a.count + 1, error: Math.max(a.error, patch.error) });
            blendFaces.push({ face, turned, blend, surf });
            continue;
        }
        const [uSeam, vSeam] = seamAngle(m, face, s, edgeGeo, options.centreTubeSeams ?? false);
        const rec = surfaceRecord(m, s, uSeam, vSeam);
        const surf = brep.surface(rec.rec);
        faceInfo.set(face.index, { surf, sign: psSign(face, turned) * (rec.flip ? -1 : 1) });
    }

    // Blend faces: their outward normal agrees with that of a face they run tangent into.
    const outward = new Map<number, (p: V3) => V3>();
    for (const { face, turned } of allFaces) {
        const s = m.node(face.f.surface);
        if (m.typeName(s) !== 'BLENDED_EDGE') {
            const surface: Surface = m.surface(s!.index);
            const sign = psSign(face, turned);
            outward.set(face.index, (p) => {
                const n = surface.project(p).n;
                return [n[0] * sign, n[1] * sign, n[2] * sign];
            });
        }
    }
    const radial = (blend: BlendSurface, p: V3): V3 => unit(sub(p, blend.spine.eval(blend.spine.project(p)).p));
    let unresolved = blendFaces.slice();
    for (let pass = 0; pass < 8 && unresolved.length > 0; pass++) {
        const left: typeof unresolved = [];
        for (const bf of unresolved) {
            let side = 0;
            for (const loop of m.chain(bf.face.f.loop, 'next')) {
                for (const f of m.ring(m.need(loop.f.fin, 'loop fin'), 'forward')) {
                    const e = m.node(f.f.edge);
                    const g = e ? edgeGeo.get(e.index) : undefined;
                    const other = m.node(m.node(f.f.other)?.f.loop);
                    const otherFace = m.node(other?.f.face);
                    const out = otherFace ? outward.get(otherFace.index) : undefined;
                    if (!g || !out || side !== 0) {
                        continue;
                    }
                    const p = g.curve.eval((g.first + g.last) / 2).p;
                    const d = dot(out(p), radial(bf.blend, p));
                    if (Math.abs(d) > 0.9) {
                        side = Math.sign(d);
                    }
                }
            }
            if (side === 0) {
                left.push(bf);
                continue;
            }
            // The patch's natural normal points to the spine.
            faceInfo.set(bf.face.index, { surf: bf.surf, sign: side > 0 ? -1 : 1 });
            outward.set(bf.face.index, (p) => {
                const r = radial(bf.blend, p);
                return [r[0] * side, r[1] * side, r[2] * side];
            });
        }
        unresolved = left;
    }
    if (unresolved.length > 0) {
        throw new UnsupportedGeometry(`${unresolved.length} blend face(s) whose side could not be told`);
    }

    // Wires, faces, shells, solids.
    const faceShape = (face: XtNode): { pos: number; sign: number } => {
        const info = faceInfo.get(face.index)!;
        const wires: [string, number][] = [];
        for (const loop of m.chain(face.f.loop, 'next')) {
            const fin = m.node(loop.f.fin);
            if (!fin) {
                continue;
            }
            const subs: [string, number][] = [];
            for (const f of m.ring(fin, 'forward')) {
                const e = m.node(f.f.edge);
                const g = e ? edgeGeo.get(e.index) : undefined;
                if (g) {
                    subs.push([(f.f.sense !== '-') === g.aligned ? '+' : '-', g.pos]);
                }
            }
            if (subs.length > 0) {
                wires.push([info.sign < 0 ? '-' : '+', brep.shape('Wi\n', '0101100', subs)]);
            }
        }
        const pos = brep.shape(`Fa\n0  ${fmt(Math.max(1e-7, m.tolerance(face) ?? 0))} ${info.surf} 0\n`, '0101000', wires);
        return { pos, sign: info.sign };
    };
    const solids: number[] = [];
    let faceCount = 0;
    for (const regionShells of shells) {
        const shellPos: [string, number][] = [];
        for (const faces of regionShells) {
            const subs: [string, number][] = faces.map(({ face }) => {
                const f = faceShape(face);
                faceCount++;
                return [f.sign < 0 ? '-' : '+', f.pos];
            });
            shellPos.push(['+', brep.shape('Sh\n', '0101100', subs)]);
        }
        solids.push(brep.shape('So\n', '0100000', shellPos));
    }
    const root = solids.length === 1 ? solids[0] : brep.shape('Co\n', '1100000', solids.map((s) => ['+', s] as [string, number]));
    return {
        text: brep.toString(root),
        faces: faceCount,
        solids: solids.length,
        approximated: [...approximated.entries()].map(([kind, a]) => ({ kind, count: a.count, error: a.error })),
        edgeDeviation: deviations.reduce((w, d) => (d.dev > w.dev ? d : w), { dev: 0, edge: 0 }),
        edgeDeviations: deviations,
    };
}
