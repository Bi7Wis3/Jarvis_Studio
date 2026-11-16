// Typed access to a parsed Parasolid partition: topology walks and geometry as evaluators in millimetres
// (Parasolid works in metres).

import { isNullDouble, type XtFile, type XtNode, type XtValue } from './xtParse.js';
import { expandKnots, scale, type Nurbs, type NurbsSurf, type V3 } from './nurbs.js';
import {
    BlendSurface, BSurface, CircleCurve, ConeSurface, CylinderSurface, EllipseCurve, LineCurve, NurbsCurve,
    OffsetSurface, PlaneSurface, SpCurve, SphereSurface, SpunSurface, SweptSurface, TorusSurface,
    type Curve, type Surface,
} from './geometry.js';

export const MM = 1000;

/** Thrown for geometry this reader cannot build; the message names it. */
export class UnsupportedGeometry extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsupportedGeometry';
    }
}

/** Marker for a blend boundary surface: Parasolid does not define its shape, only its blend and support. */
export class BlendBoundSurface implements Surface {
    kind = 'blend_bound';
    constructor(readonly blend: number, readonly boundary: number) {}
    eval(): never {
        throw new UnsupportedGeometry('A blend boundary surface cannot be evaluated');
    }
    project(): never {
        throw new UnsupportedGeometry('A blend boundary surface cannot be evaluated');
    }
}

export interface CurveBuilder {
    /** Rebuilds an intersection curve (rebuild.ts). */
    intersection(model: XtModel, node: XtNode): Curve;
}

export class XtModel {
    private readonly surfaces = new Map<number, Surface>();
    private readonly curves = new Map<number, Curve>();
    private readonly typeNames = new Map<number, string>();
    curveBuilder: CurveBuilder | null = null;

    constructor(readonly xt: XtFile) {
        for (const [id, t] of xt.types) {
            this.typeNames.set(id, t.name);
        }
    }

    node(index: number | XtValue | undefined): XtNode | undefined {
        return typeof index === 'number' && index > 0 ? this.xt.nodes.get(index) : undefined;
    }

    need(index: XtValue | undefined, what: string): XtNode {
        const n = this.node(index);
        if (!n) {
            throw new UnsupportedGeometry(`A ${what} is missing from the Parasolid data`);
        }
        return n;
    }

    typeName(n: XtNode | undefined): string {
        return n ? this.typeNames.get(n.type) ?? `type ${n.type}` : 'none';
    }

    /** Follows a `next` field from a chain head. */
    chain(head: XtValue | undefined, next: string): XtNode[] {
        const out: XtNode[] = [];
        const seen = new Set<number>();
        for (let n = this.node(head); n && !seen.has(n.index); n = this.node(n.f[next])) {
            seen.add(n.index);
            out.push(n);
        }
        return out;
    }

    /** Follows a ring (forward / other) from a member back to itself. */
    ring(start: XtNode, next: string): XtNode[] {
        const out: XtNode[] = [];
        const seen = new Set<number>();
        for (let n: XtNode | undefined = start; n && !seen.has(n.index); n = this.node(n.f[next])) {
            seen.add(n.index);
            out.push(n);
        }
        return out;
    }

    bodies(): XtNode[] {
        const world = [...this.xt.nodes.values()].find((n) => n.type === 101);
        const chained = world ? this.chain(world.f.body, 'next') : [];
        return chained.length > 0 ? chained : [...this.xt.nodes.values()].filter((n) => n.type === 12);
    }

    // ---- Attributes ---------------------------------------------------------------------------------------

    /** Attributes on a node, by definition identifier, with their field nodes. */
    attributes(n: XtNode): { id: string; fields: (XtNode | undefined)[] }[] {
        const out: { id: string; fields: (XtNode | undefined)[] }[] = [];
        for (const a of this.chain(n.f.attributes_groups, 'next')) {
            if (a.type !== 81) {
                continue;
            }
            const def = this.node(a.f.definition);
            const id = this.node(def?.f.identifier)?.f.string;
            out.push({ id: typeof id === 'string' ? id : '', fields: ((a.f.fields as number[]) ?? []).map((i) => this.node(i)) });
        }
        return out;
    }

    // ---- Geometry -----------------------------------------------------------------------------------------

    private vec(n: XtNode, field: string, s = 1): V3 {
        const v = n.f[field] as number[];
        return [v[0] * s, v[1] * s, v[2] * s];
    }

    /** Sign of a node's sense field: '+' 1, '-' -1. */
    sense(n: XtNode): number {
        return n.f.sense === '-' ? -1 : 1;
    }

    nurbsCurve(nc: XtNode, lengthScale: number, uvScale?: [number, number]): Nurbs {
        const degree = nc.f.degree as number;
        const dim = nc.f.vertex_dim as number;
        const rational = nc.f.rational as boolean;
        const verts = this.need(nc.f.bspline_vertices, 'B-curve vertex list').f.vertices as number[];
        const mults = this.need(nc.f.knot_mult, 'B-curve knot list').f.mult as number[];
        const values = this.need(nc.f.knots, 'B-curve knot list').f.knots as number[];
        const space = rational ? dim - 1 : dim;
        const n = nc.f.n_vertices as number;
        const cw: number[][] = [];
        for (let i = 0; i < n; i++) {
            const b = i * dim;
            const w = rational ? verts[b + dim - 1] : 1;
            const pw = [0, 0, 0, w];
            for (let k = 0; k < space; k++) {
                const s = uvScale ? uvScale[k] : lengthScale;
                pw[k] = (rational ? verts[b + k] : verts[b + k] * w) * s;
            }
            cw.push(pw);
        }
        const knots = expandKnots(values, mults);
        if (knots.length !== n + degree + 1) {
            throw new UnsupportedGeometry('A B-curve has an inconsistent knot vector');
        }
        return { degree, knots, cw, rational };
    }

    /** Pole order of B-surface vertices: true when v varies fastest. */
    static vFastest = true;

    nurbsSurf(ns: XtNode): NurbsSurf {
        const ud = ns.f.u_degree as number;
        const vd = ns.f.v_degree as number;
        const nu = ns.f.n_u_vertices as number;
        const nv = ns.f.n_v_vertices as number;
        const dim = ns.f.vertex_dim as number;
        const rational = ns.f.rational as boolean;
        const verts = this.need(ns.f.bspline_vertices, 'B-surface vertex list').f.vertices as number[];
        const uKnots = expandKnots(this.need(ns.f.u_knots, 'knots').f.knots as number[], this.need(ns.f.u_knot_mult, 'knots').f.mult as number[]);
        const vKnots = expandKnots(this.need(ns.f.v_knots, 'knots').f.knots as number[], this.need(ns.f.v_knot_mult, 'knots').f.mult as number[]);
        if (uKnots.length !== nu + ud + 1 || vKnots.length !== nv + vd + 1) {
            throw new UnsupportedGeometry('A B-surface has an inconsistent knot vector');
        }
        const cw: number[][][] = [];
        for (let i = 0; i < nu; i++) {
            const row: number[][] = [];
            for (let j = 0; j < nv; j++) {
                const b = (XtModel.vFastest ? i * nv + j : j * nu + i) * dim;
                const w = rational ? verts[b + 3] : 1;
                row.push(rational
                    ? [verts[b] * MM, verts[b + 1] * MM, verts[b + 2] * MM, w]
                    : [verts[b] * MM, verts[b + 1] * MM, verts[b + 2] * MM, 1]);
            }
            cw.push(row);
        }
        return { uDegree: ud, vDegree: vd, uKnots, vKnots, cw, rational };
    }

    /** How a surface's Parasolid (u, v) parameters scale to the millimetre evaluators here. */
    paramScale(s: XtNode): [number, number] {
        switch (this.typeName(s)) {
            case 'PLANE': return [MM, MM];
            case 'CYLINDER':
            case 'CONE': return [1, MM];
            case 'SPHERE':
            case 'TORUS':
            case 'B_SURFACE': return [1, 1];
            case 'OFFSET_SURF': return this.paramScale(this.need(s.f.surface, 'offset basis'));
            case 'SWEPT_SURF': return [this.curveParamScale(this.need(s.f.section, 'swept section')), MM];
            case 'SPUN_SURF': return [this.curveParamScale(this.need(s.f.profile, 'spun profile')), 1];
            case 'BLENDED_EDGE': return [this.curveParamScale(this.need(s.f.spine, 'blend spine')), 1];
            default: throw new UnsupportedGeometry(`Parameters on a ${this.typeName(s).toLowerCase()} surface`);
        }
    }

    curveParamScale(c: XtNode): number {
        switch (this.typeName(c)) {
            case 'LINE':
            case 'INTERSECTION': return MM;
            case 'TRIMMED_CURVE': return this.curveParamScale(this.need(c.f.basis_curve, 'trimmed basis'));
            default: return 1;
        }
    }

    surface(index: XtValue | undefined): Surface {
        const n = this.need(index, 'surface');
        let s = this.surfaces.get(n.index);
        if (!s) {
            s = this.makeSurface(n);
            this.surfaces.set(n.index, s);
        }
        return s;
    }

    private makeSurface(n: XtNode): Surface {
        const f = n.f;
        switch (this.typeName(n)) {
            case 'PLANE': return new PlaneSurface(this.vec(n, 'pvec', MM), this.vec(n, 'normal'), this.vec(n, 'x_axis'));
            case 'CYLINDER': return new CylinderSurface(this.vec(n, 'pvec', MM), this.vec(n, 'axis'), (f.radius as number) * MM, this.vec(n, 'x_axis'));
            case 'CONE': return new ConeSurface(this.vec(n, 'pvec', MM), this.vec(n, 'axis'), (f.radius as number) * MM,
                f.sin_half_angle as number, f.cos_half_angle as number, this.vec(n, 'x_axis'));
            case 'SPHERE': return new SphereSurface(this.vec(n, 'centre', MM), (f.radius as number) * MM, this.vec(n, 'axis'), this.vec(n, 'x_axis'));
            case 'TORUS': return new TorusSurface(this.vec(n, 'centre', MM), this.vec(n, 'axis'), (f.major_radius as number) * MM,
                (f.minor_radius as number) * MM, this.vec(n, 'x_axis'));
            case 'B_SURFACE': {
                const ns = this.need(f.nurbs, 'B-surface definition');
                return new BSurface(this.nurbsSurf(ns), ns.f.u_periodic as boolean, ns.f.v_periodic as boolean);
            }
            case 'OFFSET_SURF': {
                const basis = this.need(f.surface, 'offset basis');
                return new OffsetSurface(this.surface(basis.index), (f.offset as number) * MM * XtModel.offsetSign * this.sense(basis));
            }
            case 'SWEPT_SURF': return new SweptSurface(this.curve(f.section), this.vec(n, 'sweep'));
            case 'SPUN_SURF': return new SpunSurface(this.curve(f.profile), this.vec(n, 'base', MM), this.vec(n, 'axis'));
            case 'BLENDED_EDGE': {
                const range = f.range as number[];
                const sup = f.surface as number[];
                const support = (i: number): Surface | null => {
                    try {
                        return this.surface(sup[i]);
                    } catch {
                        return null;
                    }
                };
                return new BlendSurface(this.curve(f.spine), Math.abs(range[0]) * MM, [support(0), support(1)]);
            }
            case 'BLEND_BOUND': return new BlendBoundSurface(f.blend as number, f.boundary as number);
            default: throw new UnsupportedGeometry(`${this.typeName(n).toLowerCase().replace(/_/g, ' ')} surfaces are not supported`);
        }
    }

    /** Sign applied to offset distances (with the basis sense); settled against real files. */
    static offsetSign = 1;

    curve(index: XtValue | undefined): Curve {
        const n = this.need(index, 'curve');
        let c = this.curves.get(n.index);
        if (!c) {
            c = this.makeCurve(n);
            this.curves.set(n.index, c);
        }
        return c;
    }

    private makeCurve(n: XtNode): Curve {
        const f = n.f;
        switch (this.typeName(n)) {
            case 'LINE': return new LineCurve(this.vec(n, 'pvec', MM), this.vec(n, 'direction'));
            case 'CIRCLE': return new CircleCurve(this.vec(n, 'centre', MM), this.vec(n, 'normal'), this.vec(n, 'x_axis'), (f.radius as number) * MM);
            case 'ELLIPSE': return new EllipseCurve(this.vec(n, 'centre', MM), this.vec(n, 'normal'), this.vec(n, 'x_axis'),
                (f.major_radius as number) * MM, (f.minor_radius as number) * MM);
            case 'B_CURVE': {
                const nc = this.need(f.nurbs, 'B-curve definition');
                return new NurbsCurve(this.nurbsCurve(nc, MM), nc.f.periodic as boolean);
            }
            case 'TRIMMED_CURVE': return this.curve(f.basis_curve);
            case 'SP_CURVE': {
                const surf = this.need(f.surface, 'SP-curve surface');
                const bc = this.need(f.b_curve, 'SP-curve B-curve');
                const nc = this.need(bc.f.nurbs, 'SP-curve definition');
                return new SpCurve(this.surface(surf.index), this.nurbsCurve(nc, 1, this.paramScale(surf)));
            }
            case 'INTERSECTION': {
                if (!this.curveBuilder) {
                    throw new UnsupportedGeometry('Intersection curves need the curve builder');
                }
                return this.curveBuilder.intersection(this, n);
            }
            default: throw new UnsupportedGeometry(`${this.typeName(n).toLowerCase().replace(/_/g, ' ')} curves are not supported`);
        }
    }

    // ---- Small helpers ------------------------------------------------------------------------------------

    point(vertex: XtNode): V3 {
        const pt = this.need(vertex.f.point, 'vertex point');
        return this.vec(pt, 'pvec', MM);
    }

    /** A tolerance field in millimetres, or null when unset. */
    tolerance(n: XtNode): number | null {
        const t = n.f.tolerance as number;
        return typeof t === 'number' && !isNullDouble(t) ? t * MM : null;
    }

    vector(n: XtNode, field: string, s = 1): V3 {
        return this.vec(n, field, s);
    }
}

export const mmScale = (v: V3): V3 => scale(v, MM);
