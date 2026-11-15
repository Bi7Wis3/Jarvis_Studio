// Bridge between the core SketchGeometry (points, curves, constraints, dimensions) and FreeCAD's PlaneGCS
// solver (WASM). Load once with loadSolver(); solveGeometry() is then synchronous and cheap for sketch sizes.

import { GcsWrapper, init_planegcs_module, SolveStatus, type SketchPrimitive } from '@salusoft89/planegcs';
import type { SketchConstraint, SketchCurve, SketchGeometry, SketchPoint } from '@jarvis/core';
import { curveCentreIds, curveEndIds, curvePointIds, isExtra, parabolaFrame, parabolaParam } from './sketchCurves';
import { rigidBodies, rigidInserts, rigidPrimitives, unfixBodies } from './sketchBlockRigid';
import {
    PHANTOM_DOF, conicPointPrimitives, equalSweepPrimitives, pathContactsSettled, pathPrimitives, pathTangentHold,
    withConicPointsPlaced, withDimensionedRho,
} from './solverExtras';
import { holdSplineLengths, measureSplineLength } from './sketchSplineLength';
import { equationDistances, holdEquations } from './sketchEquationCurve';
import { afterSolve } from './solverHooks';

/** Reserved ids: the fixed origin and the two sketch axes (lines through it). */
export const ORIGIN = 'origin';
export const AXIS_U = 'axis-u';
export const AXIS_V = 'axis-v';
const AXIS_U_END = 'axis-u-end';
const AXIS_V_END = 'axis-v-end';

let wrapper: GcsWrapper | null = null;
let loading: Promise<void> | null = null;

/** Loads the WASM solver. In the browser the .wasm file is located by `wasmUrl` (a Vite ?url import). */
export function loadSolver(wasmUrl?: string): Promise<void> {
    loading ??= (async () => {
        const module = await init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
        wrapper = new GcsWrapper(new module.GcsSystem(), module);
    })();
    return loading;
}

export function solverReady(): boolean {
    return wrapper !== null;
}

export interface SolveResult {
    geometry: SketchGeometry;
    /** Remaining degrees of freedom; 0 is fully constrained. */
    dof: number;
    ok: boolean;
    /** Our constraint ids that conflict (over-constrained), or are redundant. */
    conflicting: string[];
    redundant: string[];
}

const pid = (id: string) => `p:${id}`;
const cid = (id: string) => `c:${id}`;
const kid = (id: string) => `k:${id}`;

function curveId(id: string): string {
    return id === AXIS_U || id === AXIS_V ? id : cid(id);
}

/** The solver ids of a line's two points (the axes included). */
function lineEnds(g: SketchGeometry, id: string): [string, string] | null {
    if (id === AXIS_U || id === AXIS_V) {
        return [pid(ORIGIN), pid(id === AXIS_U ? AXIS_U_END : AXIS_V_END)];
    }
    const line = curveOf(g, id);
    return line?.kind === 'line' ? [pid(line.a), pid(line.b)] : null;
}

/** The spline end a tangency handle point belongs to (the handle's direction starts there), or null. */
export function handleEnd(g: SketchGeometry, id: string): string | null {
    for (const c of g.curves) {
        if (c.kind === 'spline' && c.points.length > 1) {
            if (c.startHandle === id) {
                return c.points[0];
            }
            if (c.endHandle === id) {
                return c.points[c.points.length - 1];
            }
        }
    }
    return null;
}

/** Angle of a line in radians, from its first point to its second (a spline handle: from the spline's end to it). */
function lineAngle(g: SketchGeometry, line: string): number | null {
    if (line === AXIS_U) {
        return 0;
    }
    if (line === AXIS_V) {
        return Math.PI / 2;
    }
    const curve = g.curves.find((c) => c.id === line);
    const end = curve ? null : handleEnd(g, line);
    if (curve?.kind !== 'line' && !end) {
        return null;
    }
    const a = pointOf(g, curve?.kind === 'line' ? curve.a : end!);
    const b = pointOf(g, curve?.kind === 'line' ? curve.b : line);
    return a && b ? Math.atan2(b.v - a.v, b.u - a.u) : null;
}

/** The solver ids of the two points a direction runs between: a line's ends, an axis, or a spline end and its handle. */
function directionEnds(g: SketchGeometry, id: string): [string, string] | null {
    const end = curveOf(g, id) ? null : handleEnd(g, id);
    return end ? [pid(end), pid(id)] : lineEnds(g, id);
}

export function pointOf(g: SketchGeometry, id: string): SketchPoint | undefined {
    if (id === ORIGIN) {
        return g.points.find((p) => p.id === ORIGIN) ?? { id: ORIGIN, u: 0, v: 0, fixed: true };
    }
    return g.points.find((p) => p.id === id);
}

export function curveOf(g: SketchGeometry, id: string): SketchCurve | undefined {
    return g.curves.find((c) => c.id === id);
}

/** The end point two lines or arcs share, if any. */
function sharedEnd(g: SketchGeometry, a: string, b: string): string | null {
    const ends = (id: string): string[] => {
        const c = curveOf(g, id);
        return c ? curveEndIds(c) : [];

    };
    const other = ends(b);
    return ends(a).find((p) => other.includes(p)) ?? null;
}

/** The centre point of a circle or arc, or the point itself. */
function centreOf(g: SketchGeometry, id: string): string | null {
    const curve = curveOf(g, id);
    if (!curve) {
        return pointOf(g, id) ? id : null;
    }
    return curveCentreIds(curve)[0] ?? null;
}

const isLine = (g: SketchGeometry, id: string) => id === AXIS_U || id === AXIS_V || curveOf(g, id)?.kind === 'line';

/** Wraps an angle to (-π, π]. */
function wrap(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Translates one of our constraints to PlaneGCS primitives (several for some kinds). */
function translate(g: SketchGeometry, c: SketchConstraint, temporary = false): SketchPrimitive[] {
    // Suppressed relations and driven (reference) dimensions hold nothing.
    if (c.suppressed || (isDimension(c) && c.driven)) {
        return [];
    }
    const id = kid(c.id);
    const base = { id, ...(temporary ? { temporary: true } : {}) };
    const kindOf = (curve: string) => (curve === AXIS_U || curve === AXIS_V ? 'line' : curveOf(g, curve)?.kind);
    switch (c.kind) {
        case 'coincident':
            return [{ ...base, type: 'p2p_coincident', p1_id: pid(c.a), p2_id: pid(c.b) }];
        case 'horizontal':
            return [{ ...base, type: 'horizontal_l', l_id: curveId(c.line) }];
        case 'vertical':
            return [{ ...base, type: 'vertical_l', l_id: curveId(c.line) }];
        case 'horizontalPoints':
            return [{ ...base, type: 'horizontal_pp', p1_id: pid(c.a), p2_id: pid(c.b) }];
        case 'verticalPoints':
            return [{ ...base, type: 'vertical_pp', p1_id: pid(c.a), p2_id: pid(c.b) }];
        case 'concentric':
        case 'coradial': {
            const ca = centreOf(g, c.a);
            const cb = centreOf(g, c.b);
            if (!ca || !cb) {
                return [];
            }
            const same: SketchPrimitive = { ...base, type: 'p2p_coincident', p1_id: pid(ca), p2_id: pid(cb) };
            return c.kind === 'concentric' ? [same] : [same, ...translate(g, { id: `${c.id}:r`, kind: 'equal', a: c.a, b: c.b }, temporary)];
        }
        case 'collinear': {
            // The other line's two ends on the first one's infinite line (an axis can only be the first).
            const [on, other] = c.b === AXIS_U || c.b === AXIS_V ? [c.b, c.a] : [c.a, c.b];
            const line = curveOf(g, other);
            return line?.kind === 'line' ? [
                { ...base, type: 'point_on_line_pl', p_id: pid(line.a), l_id: curveId(on) },
                { ...base, id: `${id}:b`, type: 'point_on_line_pl', p_id: pid(line.b), l_id: curveId(on) },
            ] : [];
        }
        case 'fixRadius': {
            if (isExtra(curveOf(g, c.curve))) {
                return [];
            }
            const r = curveRadius(g, c.curve);
            const kind = kindOf(c.curve);
            return r === null ? [] : kind === 'arc'
                ? [{ ...base, type: 'arc_radius', a_id: cid(c.curve), radius: r }]
                : [{ ...base, type: 'circle_radius', c_id: cid(c.curve), radius: r }];
        }
        case 'parallel':
            return [{ ...base, type: 'parallel', l1_id: curveId(c.a), l2_id: curveId(c.b) }];
        case 'perpendicular':
            return [{ ...base, type: 'perpendicular_ll', l1_id: curveId(c.a), l2_id: curveId(c.b) }];
        case 'equal': {
            const [ka, kb] = [kindOf(c.a), kindOf(c.b)];
            const oval = (k: string | undefined) => k === 'ellipse' || k === 'ellipseArc';
            if (oval(ka) && oval(kb)) {
                return equalOvals(g, c.a, c.b, base);
            }
            if (isExtra(curveOf(g, c.a)) || isExtra(curveOf(g, c.b))) {
                return [];
            }
            if (ka === 'line' && kb === 'line') {
                return [{ ...base, type: 'equal_length', l1_id: curveId(c.a), l2_id: curveId(c.b) }];
            }
            if (ka === 'circle' && kb === 'circle') {
                return [{ ...base, type: 'equal_radius_cc', c1_id: cid(c.a), c2_id: cid(c.b) }];
            }
            if (ka === 'arc' && kb === 'arc') {
                return [{ ...base, type: 'equal_radius_aa', a1_id: cid(c.a), a2_id: cid(c.b) }];
            }
            const [circle, arc] = ka === 'circle' ? [c.a, c.b] : [c.b, c.a];
            return [{ ...base, type: 'equal_radius_ca', c1_id: cid(circle), a2_id: cid(arc) }];
        }
        case 'tangent': {
            const [ka, kb] = [kindOf(c.a), kindOf(c.b)];
            if (isExtra(curveOf(g, c.a)) || isExtra(curveOf(g, c.b))) {
                return extraTangent(g, c.a, c.b, base);
            }
            // Joined at an end: tangent there (the distance form is flat at a shared end, so the solver cannot use it).
            const joined = sharedEnd(g, c.a, c.b);
            if (joined) {
                const [ca, cb] = [curveOf(g, c.a)!, curveOf(g, c.b)!];
                if (ca.kind === 'arc' && cb.kind === 'arc') {
                    if (ca.center === cb.center) {
                        return [];
                    }
                    // Both centres on one line through the joint (still well posed when the centres meet).
                    return [{ ...base, type: 'point_on_line_ppp', p_id: pid(cb.center), lp1_id: pid(ca.center), lp2_id: pid(joined) }];
                }
                const [line, arc] = ca.kind === 'line' ? [ca, cb] : [cb, ca];
                if (line.kind === 'line' && arc.kind === 'arc') {
                    return [{ ...base, type: 'perpendicular_pppp', l1p1_id: pid(line.a), l1p2_id: pid(line.b), l2p1_id: pid(arc.center), l2p2_id: pid(joined) }];
                }
            }
            if (ka === 'line' || kb === 'line') {
                const [line, other] = ka === 'line' ? [c.a, c.b] : [c.b, c.a];
                return kindOf(other) === 'arc'
                    ? [{ ...base, type: 'tangent_la', l_id: curveId(line), a_id: cid(other) }]
                    : [{ ...base, type: 'tangent_lc', l_id: curveId(line), c_id: cid(other) }];
            }
            if (ka === 'arc' && kb === 'arc') {
                return [{ ...base, type: 'tangent_aa', a1_id: cid(c.a), a2_id: cid(c.b) } as SketchPrimitive];
            }
            if (ka === 'circle' && kb === 'circle') {
                return [{ ...base, type: 'tangent_cc', c1_id: cid(c.a), c2_id: cid(c.b) }];
            }
            const [circle, arc] = ka === 'circle' ? [c.a, c.b] : [c.b, c.a];
            return [{ ...base, type: 'tangent_ca', c_id: cid(circle), a_id: cid(arc) } as SketchPrimitive];
        }
        case 'pointOnCurve': {
            const kind = kindOf(c.curve);
            if (kind === 'ellipse' || kind === 'ellipseArc') {
                return [{ ...base, type: 'point_on_ellipse', p_id: pid(c.point), e_id: cid(c.curve) }];
            }
            if (kind === 'parabola') {
                return [{ ...base, type: 'point_on_parabolic_arc', p_id: pid(c.point), e_id: cid(c.curve) }];
            }
            if (kind === 'conic') {
                return conicPointPrimitives(g, c.point, c.curve, base);
            }
            if (kind === 'spline') {
                return [];
            }
            if (kind === 'line') {
                return [{ ...base, type: 'point_on_line_pl', p_id: pid(c.point), l_id: curveId(c.curve) }];
            }
            return kind === 'arc'
                ? [{ ...base, type: 'point_on_arc', p_id: pid(c.point), a_id: cid(c.curve) }]
                : [{ ...base, type: 'point_on_circle', p_id: pid(c.point), c_id: cid(c.curve) }];
        }
        case 'midpoint':
            return [
                { ...base, type: 'point_on_line_pl', p_id: pid(c.point), l_id: curveId(c.line) },
                { ...base, id: `${id}:bisector`, type: 'point_on_perp_bisector_pl', p_id: pid(c.point), l_id: curveId(c.line) },
            ];
        case 'symmetric': {
            if (c.part === 'perpendicular') {
                const ends = lineEnds(g, c.about);
                return ends ? [{ ...base, type: 'perpendicular_pppp', l1p1_id: pid(c.a), l1p2_id: pid(c.b), l2p1_id: ends[0], l2p2_id: ends[1] }] : [];
            }
            if (c.part === 'midpoint') {
                // A hidden point at the middle of a-b, held on the line.
                const [a, b] = [pointOf(g, c.a), pointOf(g, c.b)];
                if (!a || !b) {
                    return [];
                }
                const mid = `${base.id}:mid`;
                return [
                    { id: mid, type: 'point', x: (a.u + b.u) / 2, y: (a.v + b.v) / 2, fixed: false },
                    { ...base, id: `${base.id}:halves`, type: 'p2p_symmetric_ppp', p1_id: pid(c.a), p2_id: pid(c.b), p_id: mid },
                    { ...base, type: 'point_on_line_pl', p_id: mid, l_id: curveId(c.about) },
                ];
            }
            return [{ ...base, type: 'p2p_symmetric_ppl', p1_id: pid(c.a), p2_id: pid(c.b), l_id: curveId(c.about) }];
        }
        case 'intersection':
            return [
                { ...base, type: 'point_on_line_pl', p_id: pid(c.point), l_id: curveId(c.a) },
                { ...base, id: `${id}:b`, type: 'point_on_line_pl', p_id: pid(c.point), l_id: curveId(c.b) },
            ];
        case 'fix': {
            const p = pointOf(g, c.point);
            return p ? [
                ...(c.axis === 'v' ? [] : [{ ...base, type: 'coordinate_x', p_id: pid(c.point), x: p.u } as SketchPrimitive]),
                ...(c.axis === 'u' ? [] : [{ ...base, id: `${id}:y`, type: 'coordinate_y', p_id: pid(c.point), y: p.v } as SketchPrimitive]),
            ] : [];
        }
        case 'distance': {
            if (c.aMid || c.bMid || c.aCond || c.bCond || c.doubled) {
                return distancePrimitives(g, c, base);
            }
            if (isLine(g, c.b) && !pointOf(g, c.b)) {
                return [{ ...base, type: 'p2l_distance', p_id: pid(c.a), l_id: curveId(c.b), distance: c.value }];
            }
            if (c.axis) {
                // Signed along one axis, keeping the side the points are on now.
                const a = pointOf(g, c.a);
                const b = pointOf(g, c.b);
                const prop = c.axis === 'u' ? 'x' : 'y';
                const now = a && b ? (c.axis === 'u' ? b.u - a.u : b.v - a.v) : 1;
                return [{
                    ...base, type: 'difference',
                    param1: { o_id: pid(c.a), prop }, param2: { o_id: pid(c.b), prop },
                    difference: (now < 0 ? -1 : 1) * c.value,
                }];
            }
            return [{ ...base, type: 'p2p_distance', p1_id: pid(c.a), p2_id: pid(c.b), distance: c.value }];
        }
        case 'length': {
            const line = curveOf(g, c.line);
            return line?.kind === 'line'
                ? [{ ...base, type: 'p2p_distance', p1_id: pid(line.a), p2_id: pid(line.b), distance: c.value }]
                : [];
        }
        case 'angle': {
            // A spline's tangency handle stands for the direction from the spline's end to it.
            const handles = !isLine(g, c.a) || !isLine(g, c.b);
            const [ea, eb] = handles ? [directionEnds(g, c.a), directionEnds(g, c.b)] : [null, null];
            if (handles && (!ea || !eb)) {
                return [];
            }
            const angle = (target: number): SketchPrimitive => (handles
                ? { ...base, type: 'l2l_angle_pppp', l1p1_id: ea![0], l1p2_id: ea![1], l2p1_id: eb![0], l2p2_id: eb![1], angle: target }
                : { ...base, type: 'l2l_angle_ll', l1_id: curveId(c.a), l2_id: curveId(c.b), angle: target });
            if (c.reverseA !== undefined || c.reverseB !== undefined) {
                // The dimensioned directions are fixed; keep the turn from one to the other the way it goes now.
                const da = lineAngle(g, c.a);
                const db = lineAngle(g, c.b);
                const value = (c.value * Math.PI) / 180;
                const shift = (c.reverseA ? Math.PI : 0) - (c.reverseB ? Math.PI : 0);
                const now = da !== null && db !== null ? wrap(db - da - shift) : value;
                return [angle(wrap((now < 0 ? -value : value) + shift))];
            }
            // The solver's angle is signed and depends on line direction: aim for the variant nearest to now.
            const a = lineAngle(g, c.a);
            const b = lineAngle(g, c.b);
            const value = (c.value * Math.PI) / 180;
            const now = a !== null && b !== null ? wrap(b - a) : value;
            const candidates = [value, -value, Math.PI - value, value - Math.PI];
            return [angle(candidates.reduce((best, t) => (Math.abs(wrap(t - now)) < Math.abs(wrap(best - now)) ? t : best)))];
        }
        case 'radius':
        case 'diameter': {
            const kind = kindOf(c.curve);
            if (isExtra(curveOf(g, c.curve))) {
                return [];
            }
            const prefix = kind === 'arc' ? 'arc' : 'circle';
            const key = kind === 'arc' ? 'a_id' : 'c_id';
            return [{ ...base, type: `${prefix}_${c.kind}`, [key]: cid(c.curve), [c.kind]: c.value } as SketchPrimitive];
        }
        case 'arcLength':
            return kindOf(c.curve) === 'arc' ? [{ ...base, type: 'arc_length', a_id: cid(c.curve), dist: c.value }] : [];
        case 'pathLength':
            return pathLengthPrimitives(g, c, base);
        case 'pathTangent': {
            // Held by whichever member of the path the follower touches now (solverExtras.ts).
            const hold = pathTangentHold(g, c);
            return hold ? translate(g, hold, temporary) : [];
        }
        case 'equalSweep':
            return equalSweepPrimitives(g, c, base);
        case 'rho':
            // The conic takes a driving Rho before the solve (withDimensionedRho); nothing to solve.
            return [];
        case 'pointAngle': {
            // Keep the turn from a to b the way it goes now; a running angle turns anticlockwise from its zero.
            const now = pointAngleNow(g, c);
            const value = (c.value * Math.PI) / 180;
            return now === null ? [] : [{
                ...base, type: 'l2l_angle_pppp', l1p1_id: pid(c.vertex), l1p2_id: pid(c.a), l2p1_id: pid(c.vertex), l2p2_id: pid(c.b),
                angle: anticlockwise(c) ? wrap(value) : now < 0 ? -value : value,
            }];
        }
    }
}

/**
 * Equal ellipses (full or partial): the same major and the same minor radius. Each radius is the radius of a hidden
 * circle about the centre through that axis end, and the hidden circles are equal (this PlaneGCS build cannot run its
 * own equal-ellipse relation).
 */
function equalOvals(g: SketchGeometry, a: string, b: string, base: { id: string; temporary?: boolean }): SketchPrimitive[] {
    const [ca, cb] = [curveOf(g, a), curveOf(g, b)];
    if ((ca?.kind !== 'ellipse' && ca?.kind !== 'ellipseArc') || (cb?.kind !== 'ellipse' && cb?.kind !== 'ellipseArc')) {
        return [];
    }
    const [fa, fb] = [ellipseFrame(g, ca), ellipseFrame(g, cb)];
    if (!fa || !fb) {
        return [];
    }
    const out: SketchPrimitive[] = [];
    const ring = (e: typeof ca, axisEnd: string, r: number, tag: string) => {
        const id = `${base.id}:${tag}`;
        out.push(
            { id, type: 'circle', c_id: pid(e.center), radius: r },
            { ...base, id: `${id}-on`, type: 'point_on_circle', p_id: pid(axisEnd), c_id: id },
        );
        return id;
    };
    for (const [axis, ra, rb] of [['major', fa.a, fb.a], ['minor', fa.b, fb.b]] as const) {
        const [ea, eb] = axis === 'major' ? [fa.majorId, fb.majorId] : [fa.minorId, fb.minorId];
        const r1 = ring(ca, ea, ra, `${axis}-a`);
        const r2 = ring(cb, eb, rb, `${axis}-b`);
        out.push({ ...base, id: `${base.id}:${axis}`, type: 'equal_radius_cc', c1_id: r1, c2_id: r2 });
    }
    return out;
}

/** The signed turn (radians) at a point angle's vertex from the direction to a to the direction to b. */
function pointAngleNow(g: SketchGeometry, c: Extract<SketchConstraint, { kind: 'pointAngle' }>): number | null {
    const [v, a, b] = [c.vertex, c.a, c.b].map((x) => pointOf(g, x));
    if (!v || !a || !b) {
        return null;
    }
    return wrap(Math.atan2(b.v - v.v, b.u - v.u) - Math.atan2(a.v - v.v, a.u - v.u));
}

/** An angular running dimension measured anticlockwise from its zero (not run bidirectionally). */
const anticlockwise = (c: Extract<SketchConstraint, { kind: 'pointAngle' }>): boolean => !!c.running && !c.bidirectional;

/**
 * A driving path length: PlaneGCS has no sum of lengths, so a hidden point per curve carries the curve's length (x)
 * and the running sum up to it (y); the last sum is the value.
 */
function pathLengthPrimitives(g: SketchGeometry, c: Extract<SketchConstraint, { kind: 'pathLength' }>, base: { id: string; temporary?: boolean }): SketchPrimitive[] {
    const out: SketchPrimitive[] = [];
    let prev: string | null = null;
    let sum = 0;
    for (const [i, id] of c.curves.entries()) {
        const curve = curveOf(g, id);
        const length = curve?.kind === 'line' ? measure(g, { id: 'm', kind: 'length', line: id, value: 0 })
            : curve?.kind === 'arc' ? measure(g, { id: 'm', kind: 'arcLength', curve: id, value: 0 }) : null;
        if (length === null || !curve) {
            return [];
        }
        sum += length;
        const h = `${base.id}:l${i}`;
        const x = { o_id: h, prop: 'x' as const };
        out.push({ id: h, type: 'point', x: length, y: sum, fixed: false });
        out.push(curve.kind === 'line'
            ? { ...base, id: `${base.id}:len${i}`, type: 'p2p_distance', p1_id: pid(curve.a), p2_id: pid(curve.b), distance: x }
            : { ...base, id: `${base.id}:len${i}`, type: 'arc_length', a_id: cid(id), dist: x });
        out.push(prev === null
            ? { ...base, id: `${base.id}:sum${i}`, type: 'difference', param1: 0, param2: { o_id: h, prop: 'y' }, difference: x }
            : { ...base, id: `${base.id}:sum${i}`, type: 'difference', param1: { o_id: prev, prop: 'y' }, param2: { o_id: h, prop: 'y' }, difference: x });
        prev = h;
    }
    return prev ? [...out, { ...base, type: 'coordinate_y', p_id: prev, y: c.value }] : [];
}

type DistanceConstraint = Extract<SketchConstraint, { kind: 'distance' }>;

/** One end of a distance, resolved: a point (its position), a line, or a circle or arc measured to its near or far side. */
type DistanceEnd =
    | { kind: 'point'; at: [number, number]; id: string; mid?: string }
    | { kind: 'line'; id: string; p: [number, number]; q: [number, number] }
    | { kind: 'round'; id: string; centre: string; c: [number, number]; r: number; cond: 'min' | 'max'; arc: boolean };

function distanceEnd(g: SketchGeometry, c: DistanceConstraint, side: 'a' | 'b'): DistanceEnd | null {
    const id = side === 'a' ? c.a : c.b;
    const mid = side === 'a' ? c.aMid : c.bMid;
    const cond = side === 'a' ? c.aCond : c.bCond;
    const xy = (p: string): [number, number] | null => {
        const q = pointOf(g, p);
        return q ? [q.u, q.v] : null;
    };
    if (id === AXIS_U || id === AXIS_V) {
        return { kind: 'line', id, p: [0, 0], q: id === AXIS_U ? [1, 0] : [0, 1] };
    }
    const curve = curveOf(g, id);
    if (curve?.kind === 'line') {
        const [p, q] = [xy(curve.a), xy(curve.b)];
        if (!p || !q) {
            return null;
        }
        return mid ? { kind: 'point', at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], id, mid: id } : { kind: 'line', id, p, q };
    }
    if (mid && curve?.kind === 'arc') {
        // An arc's midpoint: on the arc, as far from its start as from its end.
        const [m, s, e] = [xy(curve.center), xy(curve.start), xy(curve.end)];
        if (!m || !s || !e) {
            return null;
        }
        const r = Math.hypot(s[0] - m[0], s[1] - m[1]);
        const a0 = Math.atan2(s[1] - m[1], s[0] - m[0]);
        let a1 = Math.atan2(e[1] - m[1], e[0] - m[0]);
        while (a1 <= a0) {
            a1 += 2 * Math.PI;
        }
        const t = (a0 + a1) / 2;
        return { kind: 'point', at: [m[0] + r * Math.cos(t), m[1] + r * Math.sin(t)], id, mid: id };
    }
    if (cond && (curve?.kind === 'circle' || curve?.kind === 'arc')) {
        const centre = xy(curve.center);
        const r = curveRadius(g, id);
        return centre && r !== null ? { kind: 'round', id, centre: curve.center, c: centre, r, cond, arc: curve.kind === 'arc' } : null;
    }
    const at = xy(id);
    return at ? { kind: 'point', at, id } : null;
}

const unit = (d: [number, number]): [number, number] => {
    const l = Math.hypot(d[0], d[1]);
    return l > 1e-12 ? [d[0] / l, d[1] / l] : [1, 0];
};

/** Where a distance end measures from: the point itself, or the near or far point of a circle toward the other end. */
function endPosition(e: DistanceEnd, other: DistanceEnd, axis?: 'u' | 'v'): [number, number] {
    if (e.kind === 'point') {
        return e.at;
    }
    if (e.kind === 'line') {
        return e.p;
    }
    // The direction toward the other end (along the axis for a horizontal or vertical distance).
    const target = other.kind === 'round' ? other.c : other.kind === 'point' ? other.at : footOn(other, e.c);
    let d = unit([target[0] - e.c[0], target[1] - e.c[1]]);
    if (axis) {
        const along = axis === 'u' ? target[0] - e.c[0] : target[1] - e.c[1];
        d = axis === 'u' ? [along < 0 ? -1 : 1, 0] : [0, along < 0 ? -1 : 1];
    }
    const s = e.cond === 'min' ? 1 : -1;
    return [e.c[0] + d[0] * e.r * s, e.c[1] + d[1] * e.r * s];
}

function footOn(l: Extract<DistanceEnd, { kind: 'line' }>, p: [number, number]): [number, number] {
    const d = unit([l.q[0] - l.p[0], l.q[1] - l.p[1]]);
    const t = (p[0] - l.p[0]) * d[0] + (p[1] - l.p[1]) * d[1];
    return [l.p[0] + d[0] * t, l.p[1] + d[1] * t];
}

/**
 * The two points a distance with midpoints, arc conditions or doubled measures between (the foot on a line for a
 * distance to a line), for drawing it; null for a plain distance or missing geometry.
 */
export function distancePoints(g: SketchGeometry, c: SketchConstraint): [[number, number], [number, number]] | null {
    if (c.kind !== 'distance' || !(c.aMid || c.bMid || c.aCond || c.bCond || c.doubled)) {
        return null;
    }
    const [ea, eb] = [distanceEnd(g, c, 'a'), distanceEnd(g, c, 'b')];
    if (!ea || !eb || (ea.kind === 'line' && eb.kind === 'line')) {
        return null;
    }
    if (ea.kind === 'line' || eb.kind === 'line') {
        const [line, other] = (eb.kind === 'line' ? [eb, ea] : [ea, eb]) as [Extract<DistanceEnd, { kind: 'line' }>, DistanceEnd];
        const p = endPosition(other, line);
        const foot = footOn(line, p);
        if (!c.doubled) {
            return [p, foot];
        }
        // Doubled: across the centreline, to the mirror image.
        return [p, [2 * foot[0] - p[0], 2 * foot[1] - p[1]]];
    }
    return [endPosition(ea, eb, c.axis), endPosition(eb, ea, c.axis)];
}

/** The distance as the geometry stands, for the kinds with midpoints, arc conditions or doubled. */
function measureDistanceEnds(g: SketchGeometry, c: DistanceConstraint): number | null {
    const [ea, eb] = [distanceEnd(g, c, 'a'), distanceEnd(g, c, 'b')];
    if (!ea || !eb) {
        return null;
    }
    const [line, other] = eb.kind === 'line' ? [eb, ea] : ea.kind === 'line' ? [ea, eb] : [null, null];
    const factor = c.doubled ? 2 : 1;
    if (line && other) {
        if (other.kind === 'line') {
            return null;
        }
        const p = endPosition(other, line);
        const foot = footOn(line, p);
        return Math.hypot(p[0] - foot[0], p[1] - foot[1]) * factor;
    }
    const pa = endPosition(ea, eb, c.axis);
    const pb = endPosition(eb, ea, c.axis);
    const d = c.axis === 'u' ? Math.abs(pb[0] - pa[0]) : c.axis === 'v' ? Math.abs(pb[1] - pa[1]) : Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    return d * factor;
}

/** PlaneGCS primitives of a distance with midpoints, arc conditions or doubled: hidden points stand for the measured ends. */
function distancePrimitives(g: SketchGeometry, c: DistanceConstraint, base: { id: string; temporary?: boolean }): SketchPrimitive[] {
    const [ea, eb] = [distanceEnd(g, c, 'a'), distanceEnd(g, c, 'b')];
    if (!ea || !eb || (ea.kind === 'line' && eb.kind === 'line')) {
        return [];
    }
    const out: SketchPrimitive[] = [];
    const value = c.doubled ? c.value / 2 : c.value;
    const lineIds = (l: Extract<DistanceEnd, { kind: 'line' }>): [string, string] => {
        if (l.id === AXIS_U || l.id === AXIS_V) {
            return [pid(ORIGIN), pid(l.id === AXIS_U ? AXIS_U_END : AXIS_V_END)];
        }
        const line = curveOf(g, l.id) as Extract<SketchCurve, { kind: 'line' }>;
        return [pid(line.a), pid(line.b)];
    };
    // The solver point each end measures from: the point itself, or a hidden point for a midpoint or a circle side.
    const ref = (e: DistanceEnd, other: DistanceEnd, tag: string): string | null => {
        if (e.kind === 'line') {
            return null;
        }
        if (e.kind === 'point' && !e.mid) {
            return pid(e.id);
        }
        const at = endPosition(e, other, c.axis);
        out.push({ id: `${base.id}:${tag}`, type: 'point', x: at[0], y: at[1], fixed: false });
        return `${base.id}:${tag}`;
    };
    const pa = ref(ea, eb, 'ha');
    const pb = ref(eb, ea, 'hb');
    const tie = (e: DistanceEnd, p: string | null, other: DistanceEnd, toward: string | null, tag: string) => {
        const arc = e.kind === 'point' && e.mid ? curveOf(g, e.mid) : undefined;
        if (arc?.kind === 'arc' && p) {
            out.push(
                { ...base, id: `${base.id}:${tag}-on`, type: 'point_on_arc', p_id: p, a_id: cid(arc.id) },
                { ...base, id: `${base.id}:${tag}-mid`, type: 'point_on_perp_bisector_ppp', p_id: p, lp1_id: pid(arc.start), lp2_id: pid(arc.end) },
            );
        } else if (e.kind === 'point' && e.mid && p) {
            out.push(
                { ...base, id: `${base.id}:${tag}-on`, type: 'point_on_line_pl', p_id: p, l_id: curveId(e.mid) },
                { ...base, id: `${base.id}:${tag}-mid`, type: 'point_on_perp_bisector_pl', p_id: p, l_id: curveId(e.mid) },
            );
        }
        if (e.kind !== 'round' || !p) {
            return;
        }
        out.push(e.arc
            ? { ...base, id: `${base.id}:${tag}-on`, type: 'point_on_arc', p_id: p, a_id: cid(e.id) }
            : { ...base, id: `${base.id}:${tag}-on`, type: 'point_on_circle', p_id: p, c_id: cid(e.id) });
        // The side point lies on the line from the centre toward the other end (square to a line; level for an axis).
        if (c.axis) {
            out.push({ ...base, id: `${base.id}:${tag}-dir`, type: c.axis === 'u' ? 'horizontal_pp' : 'vertical_pp', p1_id: pid(e.centre), p2_id: p });
        } else if (other.kind === 'line') {
            const [l1, l2] = lineIds(other);
            out.push({ ...base, id: `${base.id}:${tag}-dir`, type: 'perpendicular_pppp', l1p1_id: pid(e.centre), l1p2_id: p, l2p1_id: l1, l2p2_id: l2 });
        } else {
            const target = other.kind === 'round' ? pid(other.centre) : toward;
            if (target) {
                out.push({ ...base, id: `${base.id}:${tag}-dir`, type: 'point_on_line_ppp', p_id: p, lp1_id: pid(e.centre), lp2_id: target });
            }
        }
    };
    tie(ea, pa, eb, pb, 'ha');
    tie(eb, pb, ea, pa, 'hb');
    if (!pa || !pb) {
        const [point, line] = pa ? [pa, eb as Extract<DistanceEnd, { kind: 'line' }>] : [pb!, ea as Extract<DistanceEnd, { kind: 'line' }>];
        out.push({ ...base, type: 'p2l_distance', p_id: point, l_id: curveId(line.id), distance: value });
        return out;
    }
    if (c.axis) {
        const prop = c.axis === 'u' ? 'x' : 'y';
        const [a, b] = [endPosition(ea, eb, c.axis), endPosition(eb, ea, c.axis)];
        const now = c.axis === 'u' ? b[0] - a[0] : b[1] - a[1];
        out.push({ ...base, type: 'difference', param1: { o_id: pa, prop }, param2: { o_id: pb, prop }, difference: (now < 0 ? -1 : 1) * value });
        return out;
    }
    out.push({ ...base, type: 'p2p_distance', p1_id: pa, p2_id: pb, distance: value });
    return out;
}

/** Unit tangent of a curve at one of its points, the way the solver runs it (lines a to b, arcs and ellipses anticlockwise). */
function tangentDir(g: SketchGeometry, id: string, at: string): [number, number] | null {
    const curve = curveOf(g, id);
    const p = pointOf(g, at);
    const P = (x: string): [number, number] => {
        const q = pointOf(g, x);
        return q ? [q.u, q.v] : [0, 0];
    };
    if (!curve || !p) {
        return null;
    }
    let d: [number, number] | null = null;
    if (curve.kind === 'line') {
        const [a, b] = [P(curve.a), P(curve.b)];
        d = [b[0] - a[0], b[1] - a[1]];
    } else if (curve.kind === 'arc' || curve.kind === 'circle') {
        const c = P(curve.center);
        d = [-(p.v - c[1]), p.u - c[0]];
    } else if (curve.kind === 'ellipse' || curve.kind === 'ellipseArc') {
        const e = ellipseFrame(g, curve);
        if (e) {
            const [x, y] = [(p.u - e.c[0]) * e.dir[0] + (p.v - e.c[1]) * e.dir[1], -(p.u - e.c[0]) * e.dir[1] + (p.v - e.c[1]) * e.dir[0]];
            const phi = Math.atan2(y / e.b, x / e.a);
            const [lx, ly] = [-e.a * Math.sin(phi), e.b * Math.cos(phi)];
            d = [lx * e.dir[0] - ly * e.dir[1], lx * e.dir[1] + ly * e.dir[0]];
        }
    } else if (curve.kind === 'parabola') {
        const pf = parabolaFrame(P(curve.focus), P(curve.vertex));
        if (pf) {
            const x = parabolaParam(pf, [p.u, p.v]);
            const k = x / (2 * pf.focal);
            d = [pf.across[0] + pf.axis[0] * k, pf.across[1] + pf.axis[1] * k];
        }
    }
    const l = d ? Math.hypot(d[0], d[1]) : 0;
    return d && l > 1e-12 ? [d[0] / l, d[1] / l] : null;
}

/** Tangent relations with an ellipse, partial ellipse, parabola or conic. */
function extraTangent(g: SketchGeometry, a: string, b: string, base: { id: string; temporary?: boolean }): SketchPrimitive[] {
    const [ca, cb] = [curveOf(g, a), curveOf(g, b)];
    const lineId = a === AXIS_U || a === AXIS_V || ca?.kind === 'line' ? a : b === AXIS_U || b === AXIS_V || cb?.kind === 'line' ? b : null;
    const other = lineId === a ? cb : lineId === b ? ca : isExtra(cb) ? cb : ca;
    const first = other === ca ? cb : ca;
    if (!other) {
        return [];
    }
    const joined = sharedEnd(g, a, b);
    if (other.kind === 'conic' || other.kind === 'spline' || other.kind === 'styleSpline') {
        // These leave an end towards a control point (a conic's top vertex, a style spline's next control vertex, a
        // spline's tangency handle): tangent at a joined end holds that point on the tangent there.
        if (!joined || !first) {
            return [];
        }
        const atStart = curveEndIds(other)[0] === joined;
        const toward = other.kind === 'conic' ? other.apex
            : other.kind === 'styleSpline' ? other.points[atStart ? 1 : other.points.length - 2]
                : atStart ? other.startHandle : other.endHandle;
        if (!toward) {
            return [];
        }
        if (first.kind === 'line') {
            return [{ ...base, type: 'point_on_line_pl', p_id: pid(toward), l_id: curveId(first.id) }];
        }
        if (first.kind === 'arc') {
            return [{ ...base, type: 'perpendicular_pppp', l1p1_id: pid(first.center), l1p2_id: pid(joined), l2p1_id: pid(joined), l2p2_id: pid(toward) }];
        }
        return [];
    }
    if (!joined && lineId && (other.kind === 'ellipse' || other.kind === 'ellipseArc')) {
        return [{ ...base, type: 'tangent_le', l_id: curveId(lineId), e_id: cid(other.id) } as SketchPrimitive];
    }
    if (!joined) {
        return [];
    }
    // Joined at an end: the curves' directions there are the same, or opposite, as they are now.
    const [da, db] = [tangentDir(g, a, joined), tangentDir(g, b, joined)];
    const opposite = da && db ? da[0] * db[0] + da[1] * db[1] < 0 : false;
    return [{ ...base, type: 'angle_via_point', crv1_id: curveId(a), crv2_id: curveId(b), p_id: pid(joined), angle: opposite ? Math.PI : 0 } as SketchPrimitive];
}

/** An ellipse curve's centre, unit major direction and radii (the longer axis is the major one). */
function ellipseFrame(g: SketchGeometry, c: Extract<SketchCurve, { kind: 'ellipse' | 'ellipseArc' }>): { c: [number, number]; dir: [number, number]; a: number; b: number; majorId: string; minorId: string } | null {
    const [centre, p1, p2] = [c.center, c.major, c.minor].map((id) => pointOf(g, id));
    if (!centre || !p1 || !p2) {
        return null;
    }
    const r1 = Math.hypot(p1.u - centre.u, p1.v - centre.v);
    const r2 = Math.hypot(p2.u - centre.u, p2.v - centre.v);
    // The longer axis is the major one; a radius dimension says how long an axis is going to be.
    const sized = (id: string, now: number) => g.constraints.find((k): k is Extract<SketchConstraint, { kind: 'distance' }> => k.kind === 'distance' && !k.axis
        && !k.driven && !k.suppressed && ((k.a === c.center && k.b === id) || (k.b === c.center && k.a === id)))?.value ?? now;
    const [far, near, majorId, minorId] = sized(c.major, r1) >= sized(c.minor, r2) ? [p1, r2, c.major, c.minor] : [p2, r1, c.minor, c.major];
    const a = Math.hypot(far.u - centre.u, far.v - centre.v);
    if (!(a > 1e-12)) {
        return null;
    }
    return { c: [centre.u, centre.v], dir: [(far.u - centre.u) / a, (far.v - centre.v) / a], a, b: Math.max(Math.min(near, a), 1e-9), majorId, minorId };

}

/** PlaneGCS primitives of an ellipse, partial ellipse or parabola: hidden focus, the curve, and its axis points tied on. */
function extraPrimitives(g: SketchGeometry, c: SketchCurve): SketchPrimitive[] {
    const id = cid(c.id);
    if (c.kind === 'ellipse' || c.kind === 'ellipseArc') {
        const e = ellipseFrame(g, c);
        if (!e) {
            return [];
        }
        // Off the centre a little even for a circle: the solver takes the major axis direction from the focus.
        const f = Math.max(Math.sqrt(Math.max(0, e.a * e.a - e.b * e.b)), e.a * 1e-3);
        const focus = `${id}:focus`;
        const minor = pointOf(g, e.minorId)!;
        // The minor axis point is on one side of the major axis: positive is a quarter turn anticlockwise.
        const left = e.dir[0] * (minor.v - e.c[1]) - e.dir[1] * (minor.u - e.c[0]) >= 0;
        const out: SketchPrimitive[] = [{ id: focus, type: 'point', x: e.c[0] + e.dir[0] * f, y: e.c[1] + e.dir[1] * f, fixed: false }];
        if (c.kind === 'ellipse') {
            out.push({ id, type: 'ellipse', c_id: pid(c.center), focus1_id: focus, radmin: e.b });
        } else {
            const angle = (pt: string) => {
                const p = pointOf(g, pt)!;
                const [x, y] = [(p.u - e.c[0]) * e.dir[0] + (p.v - e.c[1]) * e.dir[1], -(p.u - e.c[0]) * e.dir[1] + (p.v - e.c[1]) * e.dir[0]];
                return Math.atan2(y / e.b, x / e.a);
            };
            const a0 = angle(c.start);
            let a1 = angle(c.end);
            while (a1 <= a0) {
                a1 += 2 * Math.PI;
            }
            out.push({ id, type: 'arc_of_ellipse', c_id: pid(c.center), focus1_id: focus, start_id: pid(c.start), end_id: pid(c.end), start_angle: a0, end_angle: a1, radmin: e.b });
            out.push({ id: `${id}:rules`, type: 'arc_of_ellipse_rules', a_id: id });
        }
        // The axis ends as the ends of the major and minor diameters; the opposite ends are hidden points.
        const far = pointOf(g, e.majorId)!;
        const majorBack = `${id}:major-`;
        const minorBack = `${id}:minor-`;
        out.push(
            { id: majorBack, type: 'point', x: 2 * e.c[0] - far.u, y: 2 * e.c[1] - far.v, fixed: false },
            { id: minorBack, type: 'point', x: 2 * e.c[0] - minor.u, y: 2 * e.c[1] - minor.v, fixed: false },
            { id: `${id}:majord`, type: 'internal_alignment_ellipse_major_diameter', e_id: id, p1_id: pid(e.majorId), p2_id: majorBack } as SketchPrimitive,
            { id: `${id}:minord`, type: 'internal_alignment_ellipse_minor_diameter', e_id: id, ...(left ? { p1_id: pid(e.minorId), p2_id: minorBack } : { p1_id: minorBack, p2_id: pid(e.minorId) }) } as SketchPrimitive,
        );
        return out;

    }
    if (c.kind === 'parabola') {
        const [f, v, s, e] = [c.focus, c.vertex, c.start, c.end].map((x) => pointOf(g, x));
        const pf = f && v ? parabolaFrame([f.u, f.v], [v.u, v.v]) : null;
        if (!pf || !s || !e) {
            return [];
        }
        return [
            { id, type: 'arc_of_parabola', vertex_id: pid(c.vertex), focus1_id: pid(c.focus), start_id: pid(c.start), end_id: pid(c.end),
                start_angle: parabolaParam(pf, [s.u, s.v]), end_angle: parabolaParam(pf, [e.u, e.v]) },
            { id: `${id}:rules`, type: 'arc_of_parabola_rules', a_id: id },
        ];
    }
    return [];
}

function primitives(g: SketchGeometry): SketchPrimitive[] {
    const out: SketchPrimitive[] = [
        { id: pid(ORIGIN), type: 'point', x: 0, y: 0, fixed: true },
        { id: pid(AXIS_U_END), type: 'point', x: 1, y: 0, fixed: true },
        { id: pid(AXIS_V_END), type: 'point', x: 0, y: 1, fixed: true },
        { id: AXIS_U, type: 'line', p1_id: pid(ORIGIN), p2_id: pid(AXIS_U_END) },
        { id: AXIS_V, type: 'line', p1_id: pid(ORIGIN), p2_id: pid(AXIS_V_END) },
    ];
    for (const p of g.points) {
        if (p.id !== ORIGIN) {
            out.push({ id: pid(p.id), type: 'point', x: p.u, y: p.v, fixed: !!p.fixed });
        }
    }
    for (const c of g.curves) {
        if (c.kind === 'line') {
            out.push({ id: cid(c.id), type: 'line', p1_id: pid(c.a), p2_id: pid(c.b) });
        } else if (c.kind === 'circle') {
            out.push({ id: cid(c.id), type: 'circle', c_id: pid(c.center), radius: c.radius });
        } else if (isExtra(c)) {
            out.push(...extraPrimitives(g, c));
        } else {
            const centre = pointOf(g, c.center)!;
            const start = pointOf(g, c.start)!;
            const end = pointOf(g, c.end)!;
            const a0 = Math.atan2(start.v - centre.v, start.u - centre.u);
            let a1 = Math.atan2(end.v - centre.v, end.u - centre.u);
            while (a1 <= a0) {
                a1 += 2 * Math.PI;
            }
            out.push({
                id: cid(c.id), type: 'arc', c_id: pid(c.center), start_id: pid(c.start), end_id: pid(c.end),
                start_angle: a0, end_angle: a1, radius: Math.hypot(start.u - centre.u, start.v - centre.v),
            });
            out.push({ id: `${cid(c.id)}:rules`, type: 'arc_rules', a_id: cid(c.id) });
        }
    }
    return out;
}

// Our constraint ids have no colon; what follows one names a part of a constraint (`k1:bisector`, `k1:ha-on`).
const ownId = (id: string) => (id.startsWith('k:') ? id.slice(2).replace(/:.*$/, '') : null);


export interface Drag {
    /** Points pulled toward a position, with lower priority than the real constraints. */
    targets: { point: string; u: number; v: number }[];
    /** Points that must stay exactly where they are while the others are pulled. */
    hold?: ReadonlySet<string>;
}

/**
 * Solves the sketch. `drag` pulls points toward positions with lower priority than the real constraints, so free
 * geometry follows the pointer and constrained geometry keeps its rules.
 */
export function solveGeometry(g0: SketchGeometry, drag?: Drag): SolveResult {
    // A driving Rho dimension sets its conic's Rho.
    // A free point held on a conic starts on it (the solver could not reach it from far away).
    const g = withConicPointsPlaced(withDimensionedRho(g0));
    let result = solveOnce(g, drag);
    // A path tangent whose follower moved on to another member of the path is solved again, held by that one.
    let from = g;
    for (let i = 0; i < 3 && result.ok && g.constraints.some((k) => k.kind === 'pathTangent') && !pathContactsSettled(from, result.geometry); i++) {
        from = result.geometry;
        const next = solveOnce(from, drag);
        if (!next.ok) {
            break;
        }
        result = next;
    }
    return result;
}

function solveOnce(g: SketchGeometry, drag?: Drag): SolveResult {
    if (!wrapper) {
        return { geometry: g, dof: -1, ok: false, conflicting: [], redundant: [] };
    }
    const gcs = wrapper;
    gcs.clear_data();
    const pulled = new Map(drag?.targets.map((t) => [t.point, t]));
    // Block instances are rigid bodies: their points are solved, held together by their frame (sketchBlockRigid.ts).
    const bodies = rigidBodies(g);
    const base = unfixBodies(g, bodies);
    const start = drag
        ? {
            ...base,
            points: base.points.map((p) => {
                const t = pulled.get(p.id);
                return t ? { ...p, u: t.u, v: t.v } : drag.hold?.has(p.id) ? { ...p, fixed: true } : p;
            }),
        }
        : base;
    gcs.push_primitives_and_params(primitives(start));
    const rigid = rigidPrimitives(start, bodies);
    gcs.push_primitives_and_params(rigid.primitives);
    for (const path of g.paths ?? []) {
        try {
            gcs.push_primitives_and_params(pathPrimitives(start, path));
        } catch {
            // A path whose curves are gone holds nothing.
        }
    }
    for (const c of g.constraints) {
        try {
            // A lock holds its point where it was, not where a drag is pulling it.
            gcs.push_primitives_and_params(translate(c.kind === 'fix' || c.kind === 'fixRadius' ? g : start, c));
        } catch {
            // A constraint that refers to deleted geometry is skipped.
        }
    }
    // Equation driven curves are rigid: their free ends stay as far apart as the equations put them (sketchEquation.ts).
    // (Taken from the sketch as it is: a point held for a drag is still a free end.)
    for (const d of equationDistances(g)) {
        gcs.push_primitives_and_params([{ id: d.id, type: 'p2p_distance', p1_id: pid(d.a), p2_id: pid(d.b), distance: d.distance }]);
    }
    for (const t of drag?.targets ?? []) {
        gcs.push_primitives_and_params([
            { id: `drag-x:${t.point}`, type: 'coordinate_x', p_id: pid(t.point), x: t.u, temporary: true },
            { id: `drag-y:${t.point}`, type: 'coordinate_y', p_id: pid(t.point), y: t.v, temporary: true },
        ]);
    }
    const status = gcs.solve();
    const conflicting = [...new Set(gcs.get_gcs_conflicting_constraints().map(ownId).filter((id): id is string => !!id))];
    const redundant = [...new Set(gcs.get_gcs_redundant_constraints().map(ownId).filter((id): id is string => !!id))];
    const ok = (status === SolveStatus.Success || status === SolveStatus.Converged) && conflicting.length === 0;
    if (ok) {
        gcs.apply_solution();
    }
    // Hidden B-splines (points on conics) bring unknowns nothing uses.
    const dof = gcs.gcs.dof() - PHANTOM_DOF * gcs.sketch_index.get_primitives().filter((p) => p.type === 'bspline').length;
    if (!ok) {
        return { geometry: g, dof, ok, conflicting, redundant };
    }
    const solved = new Map<string, { x: number; y: number; radius?: number }>();
    for (const p of gcs.sketch_index.get_primitives()) {
        if (p.type === 'point' || p.type === 'circle' || p.type === 'arc') {
            solved.set(p.id, p as never);
        }
    }
    // Solver noise next to a round value (9.99999999997) is cleaned off; a value that is really between keeps its
    // full precision (rounded to 0.000001 mm, relations would be off by as much).
    const clean = (n: number) => {
        const r = Math.round(n * 1e6) / 1e6;
        return (Math.abs(r - n) < 1e-9 ? r : n) + 0;
    };
    // Points of ellipses and parabolas keep the solver's full precision: rounded, an end would sit a hair off its curve.
    const exact = new Set(g.curves.filter((c) => c.kind === 'ellipse' || c.kind === 'ellipseArc' || c.kind === 'parabola').flatMap(curvePointIds));
    const geometry: SketchGeometry = {
        // The sketch's text, pictures, equation curves and blocks (sketchItems.ts) stay with it.
        ...g,
        points: g.points.map((p) => {
            const s = solved.get(pid(p.id));
            // A point the solve left where it was keeps its value exactly (rounding it would move it).
            if (s && Math.abs(s.x - p.u) < 1e-10 && Math.abs(s.y - p.v) < 1e-10) {
                return p;
            }
            // Fixed points (text glyphs, equation curves, blocks) are not solved: they keep their values exactly.
            return s ? (exact.has(p.id) || p.fixed ? { ...p, u: s.x + 0, v: s.y + 0 } : { ...p, u: clean(s.x), v: clean(s.y) }) : p;
        }),
        curves: g.curves.map((c) => {
            const s = solved.get(cid(c.id));
            return c.kind === 'circle' && s?.radius !== undefined && Math.abs(s.radius - c.radius) >= 1e-10 ? { ...c, radius: clean(s.radius) } : c;
        }),
        constraints: g.constraints,
        ...(rigid.active.length ? { inserts: rigidInserts(g, rigid.active, (id) => solved.get(id)) } : {}),
    };
    // Spline lengths (sketchSplineLength.ts) are held after the solve, by the splines' free shaping points.
    const lengths = holdSplineLengths(afterSolve(holdEquations(geometry)));
    if (lengths.failed.length) {
        return { geometry: g, dof, ok: false, conflicting: lengths.failed, redundant };
    }
    return { geometry: withDrivenValues(lengths.geometry), dof, ok, conflicting, redundant };
}

/** Driven (reference) dimensions take the value the geometry has; the same object when there are none. */
export function withDrivenValues(g: SketchGeometry): SketchGeometry {
    if (!g.constraints.some((c) => isDimension(c) && c.driven)) {
        return g;
    }
    return {
        ...g,
        constraints: g.constraints.map((c) => {
            if (!isDimension(c) || !c.driven) {
                return c;
            }
            const now = measure(g, c);
            return now === null || Math.abs(now - c.value) < 1e-12 ? c : { ...c, value: now };
        }),
    };
}

/** Current value of a dimension, measured on the geometry (mm or degrees). */
export function measure(g: SketchGeometry, c: SketchConstraint): number | null {
    switch (c.kind) {
        case 'length': {
            const line = curveOf(g, c.line);
            if (line?.kind !== 'line') {
                return null;
            }
            const a = pointOf(g, line.a)!;
            const b = pointOf(g, line.b)!;
            return Math.hypot(b.u - a.u, b.v - a.v);
        }
        case 'distance': {
            if (c.aMid || c.bMid || c.aCond || c.bCond || c.doubled) {
                return measureDistanceEnds(g, c);
            }
            const a = pointOf(g, c.a);
            if (!a) {
                return null;
            }
            const b = pointOf(g, c.b);
            if (b) {
                return c.axis === 'u' ? Math.abs(b.u - a.u) : c.axis === 'v' ? Math.abs(b.v - a.v) : Math.hypot(b.u - a.u, b.v - a.v);
            }
            if (c.b === AXIS_U) {
                return Math.abs(a.v);
            }
            if (c.b === AXIS_V) {
                return Math.abs(a.u);
            }
            const line = curveOf(g, c.b);
            if (line?.kind !== 'line') {
                return null;
            }
            const p = pointOf(g, line.a)!;
            const q = pointOf(g, line.b)!;
            const length = Math.hypot(q.u - p.u, q.v - p.v) || 1;
            return Math.abs((q.u - p.u) * (p.v - a.v) - (p.u - a.u) * (q.v - p.v)) / length;
        }
        case 'angle': {
            const a = lineAngle(g, c.a);
            const b = lineAngle(g, c.b);
            if (a === null || b === null) {
                return null;
            }
            if (c.reverseA !== undefined || c.reverseB !== undefined) {
                const turn = b - a + (c.reverseB ? Math.PI : 0) - (c.reverseA ? Math.PI : 0);
                return (Math.abs(wrap(turn)) * 180) / Math.PI;
            }
            // Lines have no preferred direction: report the reading (θ or 180° − θ) nearer the dimension's value.
            const deg = (Math.abs(wrap(b - a)) * 180) / Math.PI;
            return Math.abs(deg - c.value) <= Math.abs(180 - deg - c.value) ? deg : 180 - deg;
        }
        case 'radius':
        case 'diameter': {
            const r = curveRadius(g, c.curve);
            return r === null ? null : c.kind === 'diameter' ? 2 * r : r;
        }
        case 'arcLength': {
            const spline = measureSplineLength(g, c);
            if (spline !== undefined) {
                return spline;
            }
            const arc = curveOf(g, c.curve);
            if (arc?.kind !== 'arc') {
                return null;
            }
            const [m, s, e] = [arc.center, arc.start, arc.end].map((id) => pointOf(g, id));
            if (!m || !s || !e) {
                return null;
            }
            const sweep = Math.atan2(e.v - m.v, e.u - m.u) - Math.atan2(s.v - m.v, s.u - m.u);
            return Math.hypot(s.u - m.u, s.v - m.v) * ((((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) || 2 * Math.PI);
        }
        case 'pointAngle': {
            const now = pointAngleNow(g, c);
            if (now === null) {
                return null;
            }
            if (anticlockwise(c)) {
                const deg = (now * 180) / Math.PI;
                const ccw = deg < 0 ? deg + 360 : deg;
                // Right at the zero, a running angle of 360 still reads 360.
                return ccw < 1e-9 && c.value > 180 ? 360 : ccw;
            }
            return (Math.abs(now) * 180) / Math.PI;
        }
        case 'rho': {
            const conic = curveOf(g, c.curve);
            return conic?.kind === 'conic' ? conic.rho : null;
        }
        case 'pathLength': {
            let sum = 0;
            for (const id of c.curves) {
                const curve = curveOf(g, id);
                const part = curve?.kind === 'line' ? measure(g, { id: 'm', kind: 'length', line: id, value: 0 })
                    : curve?.kind === 'arc' ? measure(g, { id: 'm', kind: 'arcLength', curve: id, value: 0 }) : null;
                if (part === null) {
                    return null;
                }
                sum += part;
            }
            return sum;
        }
        default:
            return null;
    }
}

export function curveRadius(g: SketchGeometry, id: string): number | null {
    const curve = curveOf(g, id);
    if (curve?.kind === 'circle') {
        return curve.radius;
    }
    if (curve?.kind === 'arc') {
        const c = pointOf(g, curve.center)!;
        const s = pointOf(g, curve.start)!;
        return Math.hypot(s.u - c.u, s.v - c.v);
    }
    return null;
}

/** Dimension kinds (they carry a value); the rest are geometric constraints. */
export function isDimension(c: SketchConstraint): c is Extract<SketchConstraint, { value: number }> {
    return 'value' in c;
}
