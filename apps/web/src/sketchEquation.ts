// Equation driven curves in the sketcher: the equations are kept with the sketch and built as a spline through
// enough points of the curve to keep within the tolerance (@jarvis/core/curveFit). The curve is rigid: its inner
// points are fixed and follow its two end points, which are free points that take relations and dimensions (the
// solver holds them apart as the equations do; see holdEquations). An unlocked end can be dragged along the curve,
// which changes the range.

import type { SketchEquationCurve, SketchGeometry, SketchPoint } from '@jarvis/core';
import { fitSpline, type FitResult } from '@jarvis/core/curveFit';
import { addOwned } from './sketchItems';
import { constraintRefs } from './sketchGeometry';
import { equationCurve, equationEnds } from './sketchEquationCurve';

export { equationCurve, equationEnds, equationDistances, holdEquations, nearestParam, placeOf, rangeText } from './sketchEquationCurve';

type Pt = [number, number];

/** Most points a spline gets (the spline maths solves all of them together, so more makes the sketch slow). */
export const MAX_EQUATION_POINTS = 300;

export function fitEquation(e: SketchEquationCurve): FitResult | string {
    const c = equationCurve(e);
    if (typeof c === 'string') {
        return c;
    }
    if (!(e.tolerance > 0)) {
        return 'The tolerance must be above zero.';
    }
    return fitSpline(c.f, c.from, c.to, { tolerance: e.tolerance, maxPoints: MAX_EQUATION_POINTS, start: 9 });
}

/**
 * The sketch with the equation curve built (or rebuilt in place of its old spline). A rebuilt curve keeps its end
 * points (and the relations and dimensions on them): they move to where the new curve ends.
 */
export function buildEquation(g: SketchGeometry, e: SketchEquationCurve): { g: SketchGeometry; item: SketchEquationCurve; fit: FitResult } | string {
    const fit = fitEquation(e);
    if (typeof fit === 'string') {
        return fit;
    }
    const old = g.equations?.find((q) => q.id === e.id) ?? null;
    const oldEnds = old && !fit.closed ? equationEnds(g, old) : null;
    const pts = fit.closed ? fit.points.slice(0, -1) : fit.points;
    const keys = pts.map((_, i) => `q${i}`);
    // The ends follow the curve's own directions through tangency handles.
    const handles = [...(fit.handles.start ? [{ key: 'hs', at: fit.handles.start as Pt }] : []), ...(fit.handles.end ? [{ key: 'he', at: fit.handles.end as Pt }] : [])];
    const base = old ? withoutOwned(g, old, new Set(oldEnds ?? [])) : g;
    const { g: added, owned } = addOwned(base, [...pts.map((at, i) => ({ key: keys[i], at: at as Pt })), ...handles], [
        (id) => ({
            kind: 'spline', points: [...keys.map(id), ...(fit.closed ? [id(keys[0])] : [])], ...(e.construction ? { construction: true } : {}),
            ...(fit.handles.start ? { startHandle: id('hs') } : {}), ...(fit.handles.end ? { endHandle: id('he') } : {}),
        }),
    ]);
    let out = added;
    let points = owned.points;
    if (!fit.closed) {
        // The two ends are free points of their own (not owned: they show and take relations); a rebuilt curve's old ones.
        const spline = out.curves.find((k) => k.id === owned.curves[0]);
        if (spline?.kind === 'spline') {
            const [first, last] = [spline.points[0], spline.points[spline.points.length - 1]];
            const rename = new Map<string, string>(oldEnds ? [[first, oldEnds[0]], [last, oldEnds[1]]] : []);
            const placed = new Map([[first, pts[0] as Pt], [last, pts[pts.length - 1] as Pt]]);
            out = {
                ...out,
                points: out.points.flatMap((p): SketchPoint[] => {
                    if (oldEnds && rename.has(p.id)) {
                        return [];
                    }
                    if (oldEnds && oldEnds.includes(p.id)) {
                        const at = placed.get(oldEnds[0] === p.id ? first : last)!;
                        return [{ id: p.id, u: at[0] + 0, v: at[1] + 0 }];
                    }
                    return placed.has(p.id) ? [{ id: p.id, u: p.u, v: p.v }] : [p];
                }),
                curves: out.curves.map((k) => (k.id === spline.id ? { ...spline, points: spline.points.map((p) => rename.get(p) ?? p) } : k)),
            };
            points = points.filter((p) => p !== first && p !== last);
        }
    }
    const item: SketchEquationCurve = { ...e, curves: owned.curves, points, deviation: fit.deviation };
    return { g: { ...out, equations: [...(g.equations ?? []).filter((q) => q.id !== e.id), item] }, item, fit };
}

/** The sketch without an item's entities and the relations on them, except the points kept (and relations on those). */
function withoutOwned(g: SketchGeometry, e: SketchEquationCurve, keep: ReadonlySet<string>): SketchGeometry {
    const ends = equationEnds(g, e) ?? [];
    const gone = new Set([...e.curves, ...e.points, ...ends].filter((id) => !keep.has(id)));
    return {
        ...g,
        points: g.points.filter((p) => !gone.has(p.id)),
        curves: g.curves.filter((c) => !gone.has(c.id)),
        constraints: g.constraints.filter((c) => !constraintRefs(c).some((r) => gone.has(r))),
    };
}
