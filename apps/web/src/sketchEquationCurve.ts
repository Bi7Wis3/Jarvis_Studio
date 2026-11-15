// An equation driven curve's shape and placement, and what keeps it rigid in the solver (the solver calls
// equationDistances and holdEquations): its free end points stay as far apart as the equations put them, and the
// rest of it follows them, turned and moved. Only core imports here, as the solver loads this module.

import type { SketchEquationCurve, SketchGeometry } from '@jarvis/core';
import { compileExpression, constantValue } from '@jarvis/core/expression';
import type { ParamCurve } from '@jarvis/core/curveFit';

type Pt = [number, number];

/** Where the equations' point (x, y) is placed in the sketch: turned by the curve's angle, then moved by its offset. */
export function placeOf(e: Pick<SketchEquationCurve, 'offset' | 'angle'>): (p: Pt) => Pt {
    const a = ((e.angle ?? 0) * Math.PI) / 180;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const [du, dv] = e.offset ?? [0, 0];
    return a === 0 ? ([x, y]) => [x + du, y + dv] : ([x, y]) => [x * c - y * s + du, x * s + y * c + dv];
}

/** The curve the equations describe, over its range, or what is wrong with them. */
export function equationCurve(e: Pick<SketchEquationCurve, 'type' | 'x' | 'y' | 'from' | 'to' | 'offset' | 'angle'>): { f: ParamCurve; from: number; to: number } | string {
    const variable = e.type === 'explicit' ? 'x' : 't';
    const y = compileExpression(e.y, [variable]);
    if ('error' in y) {
        return `${e.type === 'explicit' ? 'y' : 'y(t)'}: ${y.error}`;
    }
    let x: ((v: Record<string, number>) => number) | null = null;
    if (e.type === 'parametric') {
        const r = compileExpression(e.x ?? '', ['t']);
        if ('error' in r) {
            return `x(t): ${r.error}`;
        }
        x = r.f;
    }
    const from = constantValue(e.from);
    const to = constantValue(e.to);
    if (from === null || to === null) {
        return `The range ${variable}1 to ${variable}2 must be numbers or constant expressions (such as 2*pi).`;
    }
    if (!(to > from)) {
        return `${variable}2 must be larger than ${variable}1.`;
    }
    const place = placeOf(e);
    const raw = equationAt(e.type, x, y.f);
    const f: ParamCurve = (s) => place(raw(s));
    // The curve must exist all along the range.
    for (let k = 0; k <= 400; k++) {
        const s = from + ((to - from) * k) / 400;
        const p = f(s);
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
            return `The equation cannot be solved at ${variable} = ${Math.round(s * 1e6) / 1e6}.`;
        }
    }
    return { f, from, to };
}

function equationAt(type: SketchEquationCurve['type'], x: ((v: Record<string, number>) => number) | null, y: (v: Record<string, number>) => number): ParamCurve {
    return type === 'parametric' && x ? (s) => [x({ t: s }), y({ t: s })] : (s) => [s, y({ x: s })];
}

/** The end points of an equation curve's spline (free points that take relations), or null. */
export function equationEnds(g: SketchGeometry, e: SketchEquationCurve): [string, string] | null {
    const c = g.curves.find((k) => k.id === e.curves[0]);
    return c?.kind === 'spline' && c.points.length >= 2 && c.points[0] !== c.points[c.points.length - 1] ? [c.points[0], c.points[c.points.length - 1]] : null;
}

// ---- Rigid in the solver ---------------------------------------------------------------------------------------

/** The ends of an equation curve as its equations and placement put them, and their ids; null when it is not rigid. */
function placedEnds(g: SketchGeometry, e: SketchEquationCurve): { ids: [string, string]; a: Pt; b: Pt } | null {
    const ids = equationEnds(g, e);
    const c = equationCurve(e);
    if (!ids || typeof c === 'string' || ids.some((id) => g.points.find((p) => p.id === id)?.fixed)) {
        return null;
    }
    return { ids, a: c.f(c.from), b: c.f(c.to) };
}

/** Hidden distances that keep each equation curve's free ends as far apart as the equations put them. */
export function equationDistances(g: SketchGeometry): { a: string; b: string; distance: number; id: string }[] {
    return (g.equations ?? []).flatMap((e) => {
        const p = placedEnds(g, e);
        return p ? [{ id: `eq-rigid:${e.id}`, a: p.ids[0], b: p.ids[1], distance: Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) }] : [];
    });
}

/**
 * After a solve: each equation curve whose ends moved goes with them as a rigid curve (turned and moved), its inner
 * points and handles placed again and its placement (offset and angle) kept with it.
 */
export function holdEquations(g: SketchGeometry): SketchGeometry {
    let out = g;
    for (const e of g.equations ?? []) {
        const p = placedEnds(out, e);
        if (!p) {
            continue;
        }
        const at = (id: string): Pt | null => {
            const q = out.points.find((x) => x.id === id);
            return q ? [q.u, q.v] : null;
        };
        const [a1, b1] = [at(p.ids[0]), at(p.ids[1])];
        if (!a1 || !b1 || (Math.hypot(a1[0] - p.a[0], a1[1] - p.a[1]) < 1e-12 && Math.hypot(b1[0] - p.b[0], b1[1] - p.b[1]) < 1e-12)) {
            continue;
        }
        const long = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) > 1e-9;
        const turn = long ? Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) - Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0]) : 0;
        const [c, s] = [Math.cos(turn), Math.sin(turn)];
        const move = (q: Pt): Pt => {
            const [x, y] = [q[0] - p.a[0], q[1] - p.a[1]];
            return [a1[0] + x * c - y * s, a1[1] + x * s + y * c];
        };
        const owned = new Set(e.points);
        const offset = move(e.offset ?? [0, 0]);
        const item: SketchEquationCurve = { ...e, offset: [offset[0] + 0, offset[1] + 0], angle: (e.angle ?? 0) + (turn * 180) / Math.PI };
        out = {
            ...out,
            points: out.points.map((q) => {
                if (!owned.has(q.id)) {
                    return q;
                }
                const m = move([q.u, q.v]);
                return { ...q, u: m[0] + 0, v: m[1] + 0 };
            }),
            equations: (out.equations ?? []).map((x) => (x.id === e.id ? item : x)),
        };
    }
    return out;
}

/** The parameter of the point of an equation curve nearest `at` (searched a range's length past either end). */
export function nearestParam(e: SketchEquationCurve, at: Pt): number | null {
    const c = equationCurve(e);
    if (typeof c === 'string') {
        return null;
    }
    const span = c.to - c.from;
    const [lo, hi] = [c.from - span, c.to + span];
    let best: { s: number; d: number } | null = null;
    for (let k = 0; k <= 1200; k++) {
        const s = lo + ((hi - lo) * k) / 1200;
        const q = c.f(s);
        const d = Math.hypot(q[0] - at[0], q[1] - at[1]);
        if (Number.isFinite(d) && (!best || d < best.d)) {
            best = { s, d };
        }
    }
    if (!best) {
        return null;
    }
    // Golden section search next to the best sample.
    let [a, b] = [best.s - (hi - lo) / 1200, best.s + (hi - lo) / 1200];
    const dist = (s: number) => {
        const q = c.f(s);
        const d = Math.hypot(q[0] - at[0], q[1] - at[1]);
        return Number.isFinite(d) ? d : Infinity;
    };
    const r = (Math.sqrt(5) - 1) / 2;
    for (let i = 0; i < 80 && b - a > 1e-13; i++) {
        const [x1, x2] = [b - r * (b - a), a + r * (b - a)];
        if (dist(x1) < dist(x2)) {
            b = x2;
        } else {
            a = x1;
        }
    }
    return (a + b) / 2;
}

/** The text of a range value: full precision, as the range fields hold it. */
export const rangeText = (s: number): string => String(Math.round(s * 1e12) / 1e12);
