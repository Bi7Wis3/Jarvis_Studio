// Bridge between the core SketchGeometry (points, curves, constraints, dimensions) and FreeCAD's PlaneGCS
// solver (WASM). Load once with loadSolver(); solveGeometry() is then synchronous and cheap for sketch sizes.

import { GcsWrapper, init_planegcs_module, SolveStatus, type SketchPrimitive } from '@salusoft89/planegcs';
import type { SketchConstraint, SketchCurve, SketchGeometry, SketchPoint } from '@jarvis/core';

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

/** Angle of a line in radians, from its first point to its second. */
function lineAngle(g: SketchGeometry, line: string): number | null {
    if (line === AXIS_U) {
        return 0;
    }
    if (line === AXIS_V) {
        return Math.PI / 2;
    }
    const curve = g.curves.find((c) => c.id === line);
    if (curve?.kind !== 'line') {
        return null;
    }
    const a = pointOf(g, curve.a);
    const b = pointOf(g, curve.b);
    return a && b ? Math.atan2(b.v - a.v, b.u - a.u) : null;
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

const isLine = (g: SketchGeometry, id: string) => id === AXIS_U || id === AXIS_V || curveOf(g, id)?.kind === 'line';

/** Wraps an angle to (-π, π]. */
function wrap(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Translates one of our constraints to PlaneGCS primitives (several for some kinds). */
function translate(g: SketchGeometry, c: SketchConstraint, temporary = false): SketchPrimitive[] {
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
        case 'parallel':
            return [{ ...base, type: 'parallel', l1_id: curveId(c.a), l2_id: curveId(c.b) }];
        case 'perpendicular':
            return [{ ...base, type: 'perpendicular_ll', l1_id: curveId(c.a), l2_id: curveId(c.b) }];
        case 'equal': {
            const [ka, kb] = [kindOf(c.a), kindOf(c.b)];
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
        case 'symmetric':
            return [{ ...base, type: 'p2p_symmetric_ppl', p1_id: pid(c.a), p2_id: pid(c.b), l_id: curveId(c.about) }];
        case 'fix': {
            const p = pointOf(g, c.point);
            return p ? [
                { ...base, type: 'coordinate_x', p_id: pid(c.point), x: p.u },
                { ...base, id: `${id}:y`, type: 'coordinate_y', p_id: pid(c.point), y: p.v },
            ] : [];
        }
        case 'distance': {
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
            // The solver's angle is signed and depends on line direction: aim for the variant nearest to now.
            const a = lineAngle(g, c.a);
            const b = lineAngle(g, c.b);
            const value = (c.value * Math.PI) / 180;
            const now = a !== null && b !== null ? wrap(b - a) : value;
            const candidates = [value, -value, Math.PI - value, value - Math.PI];
            const target = candidates.reduce((best, t) => (Math.abs(wrap(t - now)) < Math.abs(wrap(best - now)) ? t : best));
            return [{ ...base, type: 'l2l_angle_ll', l1_id: curveId(c.a), l2_id: curveId(c.b), angle: target }];
        }
        case 'radius':
        case 'diameter': {
            const kind = kindOf(c.curve);
            const prefix = kind === 'arc' ? 'arc' : 'circle';
            const key = kind === 'arc' ? 'a_id' : 'c_id';
            return [{ ...base, type: `${prefix}_${c.kind}`, [key]: cid(c.curve), [c.kind]: c.value } as SketchPrimitive];
        }
    }
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

const ownId = (id: string) => (id.startsWith('k:') ? id.slice(2).replace(/:(bisector|y)$/, '') : null);

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
export function solveGeometry(g: SketchGeometry, drag?: Drag): SolveResult {
    if (!wrapper) {
        return { geometry: g, dof: -1, ok: false, conflicting: [], redundant: [] };
    }
    const gcs = wrapper;
    gcs.clear_data();
    const pulled = new Map(drag?.targets.map((t) => [t.point, t]));
    const start = drag
        ? {
            ...g,
            points: g.points.map((p) => {
                const t = pulled.get(p.id);
                return t ? { ...p, u: t.u, v: t.v } : drag.hold?.has(p.id) ? { ...p, fixed: true } : p;
            }),
        }
        : g;
    gcs.push_primitives_and_params(primitives(start));
    for (const c of g.constraints) {
        try {
            // A lock holds its point where it was, not where a drag is pulling it.
            gcs.push_primitives_and_params(translate(c.kind === 'fix' ? g : start, c));
        } catch {
            // A constraint that refers to deleted geometry is skipped.
        }
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
    const dof = gcs.gcs.dof();
    if (!ok) {
        return { geometry: g, dof, ok, conflicting, redundant };
    }
    const solved = new Map<string, { x: number; y: number; radius?: number }>();
    for (const p of gcs.sketch_index.get_primitives()) {
        if (p.type === 'point' || p.type === 'circle' || p.type === 'arc') {
            solved.set(p.id, p as never);
        }
    }
    const clean = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
    return {
        geometry: {
            points: g.points.map((p) => {
                const s = solved.get(pid(p.id));
                return s ? { ...p, u: clean(s.x), v: clean(s.y) } : p;
            }),
            curves: g.curves.map((c) => {
                const s = solved.get(cid(c.id));
                return c.kind === 'circle' && s?.radius !== undefined ? { ...c, radius: clean(s.radius) } : c;
            }),
            constraints: g.constraints,
        },
        dof,
        ok,
        conflicting,
        redundant,
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
            // Lines have no preferred direction: report the reading (θ or 180° − θ) nearer the dimension's value.
            const deg = (Math.abs(wrap(b - a)) * 180) / Math.PI;
            return Math.abs(deg - c.value) <= Math.abs(180 - deg - c.value) ? deg : 180 - deg;
        }
        case 'radius':
        case 'diameter': {
            const r = curveRadius(g, c.curve);
            return r === null ? null : c.kind === 'diameter' ? 2 * r : r;
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
