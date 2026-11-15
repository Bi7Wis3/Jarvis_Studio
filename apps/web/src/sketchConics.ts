// Drawing the ellipse, partial ellipse, spline, parabola and conic tools: their click sequences (as the SolidWorks
// help gives them), the live preview, and the geometry each adds. The sketcher calls these from its draw-tool switch.

import type { SketchCurve, SketchGeometry, SketchProfile, SketchSegment } from '@jarvis/core';
import { ellipseAt, ellipseAxes, ellipseParam, type EllipseAxes } from '@jarvis/core/curves';
import { splitSplineAt } from './sketchSplines';
import { newId, placePoint, type PointRef } from './sketchGeometry';
import { parabolaAt, parabolaFrame, parabolaParam, parabolaSegment } from './sketchCurves';
import { curveEntity, type NewEntity, type Pt } from './sketchMath';
import { shownText } from './numberText';

/** The draw tools of this module. */
export type ConicTool = 'ellipse' | 'partialEllipse' | 'spline' | 'styleSpline' | 'parabola' | 'conic';
export const CONIC_TOOLS: readonly string[] = ['ellipse', 'partialEllipse', 'spline', 'styleSpline', 'parabola', 'conic'];

/** Style spline Curve Type: Bezier (no degree) or B-spline of degree 3, 5 or 7. New style splines take the last one set. */
export type StyleType = 'bezier' | 3 | 5 | 7;
let styleType: StyleType = 'bezier';
export const styleSplineType = (): StyleType => styleType;
export function setStyleSplineType(t: StyleType): void {
    styleType = t;
}
export const isConicTool = (tool: string): tool is ConicTool => CONIC_TOOLS.includes(tool);

type NewCurve = SketchCurve extends infer C ? (C extends SketchCurve ? Omit<C, 'id'> : never) : never;

const dist = (p: Pt, q: Pt): number => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** Distance from p to the line through c along the direction to `axis`, signed (left positive). */
function across(c: Pt, axis: Pt, p: Pt): number {
    const l = dist(c, axis) || 1;
    return ((axis[0] - c[0]) * (p[1] - c[1]) - (axis[1] - c[1]) * (p[0] - c[0])) / l;
}

/** The end of the second axis: square to the first, `r2` from the centre on the cursor's side. */
function secondAxis(c: Pt, axis: Pt, p: Pt): Pt {
    const l = dist(c, axis) || 1;
    const d = across(c, axis, p);
    const n: Pt = [-(axis[1] - c[1]) / l, (axis[0] - c[0]) / l];
    return [c[0] + n[0] * d, c[1] + n[1] * d];
}

function addPoint(g: SketchGeometry, at: Pt): { g: SketchGeometry; id: string } {
    const id = newId('p', g);
    return { g: { ...g, points: [...g.points, { id, u: at[0], v: at[1] }] }, id };
}

function addCurve(g: SketchGeometry, curve: NewCurve): { g: SketchGeometry; id: string } {
    const id = newId('c', g);
    return { g: { ...g, curves: [...g.curves, { ...curve, id } as SketchCurve] }, id };
}

/** Rho from where the pointer is: how far its foot on the chord-middle-to-apex line is towards the apex. */
export function rhoAt(a: Pt, b: Pt, apex: Pt, p: Pt): number {
    const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d: Pt = [apex[0] - m[0], apex[1] - m[1]];
    const l2 = d[0] * d[0] + d[1] * d[1] || 1;
    const t = ((p[0] - m[0]) * d[0] + (p[1] - m[1]) * d[1]) / l2;
    return Math.min(0.99, Math.max(0.01, t));
}

// ---- Adding the geometry ---------------------------------------------------------------------------------------

/** Ellipse about `center`: one axis ends at `axis`, the other `r2` from the centre square to it (on the side of `side`). */
export function addEllipse(g: SketchGeometry, center: PointRef, axis: PointRef, second: Pt): { g: SketchGeometry; id: string } {
    let r = placePoint(g, center);
    const c = r.id;
    r = placePoint(r.g, axis);
    const major = r.id;
    const q = addPoint(r.g, secondAxis(center.at, axis.at, second));
    return addCurve(q.g, { kind: 'ellipse', center: c, major, minor: q.id });
}

/** Partial ellipse: the ellipse's axes, then counter-clockwise from the start angle by `sweep` (negative: clockwise). */
export function addPartialEllipse(g: SketchGeometry, center: PointRef, axis: PointRef, second: Pt, end: Pt, sweep: number): { g: SketchGeometry; id: string } | null {
    const minorAt = secondAxis(center.at, axis.at, second);
    const e = ellipseAxes(center.at, axis.at, dist(center.at, minorAt));
    if (!(e.b > 1e-9)) {
        return null;
    }
    const startAt = ellipseAt(e, ellipseParam(e, second));
    const endAt = ellipseAt(e, ellipseParam(e, end));
    if (dist(startAt, endAt) < 1e-6) {
        return null;
    }
    let r = placePoint(g, center);
    const c = r.id;
    r = placePoint(r.g, axis);
    const major = r.id;
    let q = addPoint(r.g, minorAt);
    const minor = q.id;
    q = addPoint(q.g, startAt);
    const s = q.id;
    q = addPoint(q.g, endAt);
    const t = q.id;
    // Stored counter-clockwise from start to end.
    return addCurve(q.g, { kind: 'ellipseArc', center: c, major, minor, start: sweep >= 0 ? s : t, end: sweep >= 0 ? t : s });
}

/** Spline through the clicked points (shared where they snapped to points); closed: back to its first point. */
export function addSpline(g: SketchGeometry, refs: PointRef[], closed: boolean): { g: SketchGeometry; id: string } {
    let out = g;
    const ids: string[] = [];
    for (const ref of refs) {
        const r = placePoint(out, ref);
        out = r.g;
        ids.push(r.id);
    }
    return addCurve(out, { kind: 'spline', points: closed ? [...ids, ids[0]] : ids });
}

/** Parabola with its focus and vertex, from the point of the parabola across from `start` to the one across from `end`. */
export function addParabola(g: SketchGeometry, focus: PointRef, vertex: PointRef, start: Pt, end: Pt): { g: SketchGeometry; id: string } | null {
    const pf = parabolaFrame(focus.at, vertex.at);
    if (!pf) {
        return null;
    }
    const [x1, x2] = [parabolaParam(pf, start), parabolaParam(pf, end)];
    if (Math.abs(x1 - x2) < 1e-6) {
        return null;
    }
    let r = placePoint(g, focus);
    const f = r.id;
    r = placePoint(r.g, vertex);
    const v = r.id;
    let q = addPoint(r.g, parabolaAt(pf, x1));
    const s = q.id;
    q = addPoint(q.g, parabolaAt(pf, x2));
    return addCurve(q.g, { kind: 'parabola', focus: f, vertex: v, start: s, end: q.id });
}

/** Conic from a to b, its end tangents meeting at the top vertex, with Rho. */
export function addConic(g: SketchGeometry, a: PointRef, b: PointRef, apex: PointRef, rho: number): { g: SketchGeometry; id: string } {
    let r = placePoint(g, a);
    const s = r.id;
    r = placePoint(r.g, b);
    const e = r.id;
    r = placePoint(r.g, apex);
    return addCurve(r.g, { kind: 'conic', start: s, end: e, apex: r.id, rho });
}

/** Ellipse profiles and paths with elliptical arcs, splines or conics (written by Jarvis) as editable geometry. */
export function addCurveFromProfile(g: SketchGeometry, p: SketchProfile): SketchGeometry {
    let out = g;
    const point = (at: Pt): string => {
        const found = out.points.find((q) => Math.abs(q.u - at[0]) < 1e-6 && Math.abs(q.v - at[1]) < 1e-6 && q.id !== 'origin');
        if (found) {
            return found.id;
        }
        const r = addPoint(out, at);
        out = r.g;
        return r.id;
    };
    const curve = (c: NewCurve) => {
        out = addCurve(out, c).g;
    };
    const ellipse = (center: Pt, major: Pt, minor: number) => {
        const c = point(center);
        const m = point(major);
        const l = dist(center, major) || 1;
        const n = point([center[0] - ((major[1] - center[1]) / l) * minor, center[1] + ((major[0] - center[0]) / l) * minor]);
        return { c, m, n };
    };
    if (p.kind === 'ellipse') {
        const e = ellipse(p.center, p.major, p.minor);
        curve({ kind: 'ellipse', center: e.c, major: e.m, minor: e.n });
        return out;
    }
    if (p.kind !== 'path') {
        return out;
    }
    let at = p.start;
    let from = point(at);
    const first = from;
    const segments: SketchSegment[] = [...p.segments];
    const last = segments[segments.length - 1];
    if (last && dist(last.to, p.start) > 1e-6) {
        segments.push({ kind: 'line', to: p.start });
    }
    for (const s of segments) {
        const to = dist(s.to, p.start) < 1e-6 ? first : point(s.to);
        switch (s.kind) {
            case 'line':
                if (to !== from) {
                    curve({ kind: 'line', a: from, b: to });
                }
                break;
            case 'arc': {
                const d = 2 * (at[0] * (s.through[1] - s.to[1]) + s.through[0] * (s.to[1] - at[1]) + s.to[0] * (at[1] - s.through[1]));
                if (Math.abs(d) < 1e-12) {
                    curve({ kind: 'line', a: from, b: to });
                    break;
                }
                const sq = (q: Pt) => q[0] * q[0] + q[1] * q[1];
                const centre: Pt = [
                    (sq(at) * (s.through[1] - s.to[1]) + sq(s.through) * (s.to[1] - at[1]) + sq(s.to) * (at[1] - s.through[1])) / d,
                    (sq(at) * (s.to[0] - s.through[0]) + sq(s.through) * (at[0] - s.to[0]) + sq(s.to) * (s.through[0] - at[0])) / d,
                ];
                // Counter-clockwise from `at` when the through point is left of the chord's way round.
                const ccw = (s.through[0] - at[0]) * (s.to[1] - at[1]) - (s.through[1] - at[1]) * (s.to[0] - at[0]) < 0;
                const c = point(centre);
                curve({ kind: 'arc', center: c, start: ccw ? from : to, end: ccw ? to : from });
                break;
            }
            case 'ellipse': {
                const e = ellipse(s.center, s.major, s.minor);
                curve({ kind: 'ellipseArc', center: e.c, major: e.m, minor: e.n, start: s.ccw ? from : to, end: s.ccw ? to : from });
                break;
            }
            case 'spline':
                curve({ kind: 'spline', points: [from, ...s.through.map(point), to] });
                break;
            case 'conic':
                curve({ kind: 'conic', start: from, end: to, apex: point(s.apex), rho: s.rho });
                break;
            case 'bspline': {
                const points = [from, ...s.poles.map(point), to];
                const degree = s.degree === 3 || s.degree === 5 || s.degree === 7 ? s.degree : undefined;
                curve({ kind: 'styleSpline', points, ...(degree && degree < points.length - 1 ? { degree } : {}) });
                break;
            }

        }
        from = to;
        at = s.to;
    }
    return out;
}

// ---- The click sequences ------------------------------------------------------------------------------------

export type PlaceResult =
    | { draft: PointRef[] }
    | { g: SketchGeometry; id: string }
    | { message: string };

/** Points each tool takes (the spline: until it is ended). */
const CLICKS: Record<ConicTool, number> = { ellipse: 3, partialEllipse: 4, spline: Infinity, styleSpline: Infinity, parabola: 4, conic: 4 };

/** A click of one of these tools with the points placed so far; `sweep` is the turn round the centre so far (partial ellipse). */
export function placeConic(tool: ConicTool, g: SketchGeometry, draft: PointRef[], ref: PointRef, sweep: number): PlaceResult {
    const next = [...draft, ref];
    if (tool === 'spline') {
        // A click on the first point closes the spline.
        const first = draft[0];
        const closing = draft.length >= 2 && first && ((ref.point && ref.point === first.point) || dist(ref.at, first.at) < 1e-6);
        return closing ? finishSpline(g, draft, true) : { draft: next };
    }
    if (tool === 'styleSpline') {
        return { draft: next };
    }
    if (next.length < CLICKS[tool]) {
        if (tool !== 'conic' && next.length === 2 && dist(next[0].at, next[1].at) < 1e-6) {
            return { message: 'Click away from the first point.' };
        }
        return { draft: next };
    }
    const [a, b, c, d] = next.map((x) => x.at);
    switch (tool) {
        case 'ellipse':
            if (Math.abs(across(a, b, c)) < 1e-6) {
                return { message: 'Click away from the first axis to give the ellipse a second radius.' };
            }
            return addEllipse(g, draft[0], draft[1], c);
        case 'partialEllipse': {
            if (Math.abs(across(a, b, c)) < 1e-6) {
                return { message: 'The second axis needs a radius: start again away from the first axis.' };
            }
            return addPartialEllipse(g, draft[0], draft[1], c, d, sweep) ?? { message: 'Go further round the ellipse before you click.' };
        }
        case 'parabola':
            return addParabola(g, draft[0], draft[1], c, d) ?? { message: 'Click the end away from the start.' };
        case 'conic': {
            if (dist(a, b) < 1e-6) {
                return { message: 'The two ends of a conic must be apart.' };
            }
            if (Math.abs(across(a, b, c)) < 1e-6) {
                return { message: 'The top vertex must be off the line between the ends.' };
            }
            return addConic(g, draft[0], draft[1], draft[2], rhoAt(a, b, c, d));
        }
        default:
            return { draft: next };
    }
}

/** Ends the style spline in progress (double-click or Enter) with the current Curve Type. */
export function finishStyleSpline(g: SketchGeometry, draft: PointRef[]): PlaceResult {
    const refs = draft.filter((r, i) => i === 0 || dist(r.at, draft[i - 1].at) > 1e-6);
    const t = styleSplineType();
    const need = t === 'bezier' ? 2 : t + 1;
    if (refs.length < need) {
        return { message: t === 'bezier' ? 'A style spline needs at least two control vertices.'
            : `A B-spline of degree ${t} needs at least ${need} control vertices; click more, or pick Bezier in the Style spline form.` };
    }
    let out = g;
    const ids: string[] = [];
    for (const ref of refs) {
        const r = placePoint(out, ref);
        out = r.g;
        ids.push(r.id);
    }
    return addCurve(out, { kind: 'styleSpline', points: ids, ...(t === 'bezier' ? {} : { degree: t }) });
}

/** Inserts a control vertex at `at` into the control polygon side of the style spline nearest it (SolidWorks: Insert Control Vertex). */
export function insertControlVertex(g: SketchGeometry, id: string, at: Pt): { g: SketchGeometry; point: string } | { error: string } {
    const c = g.curves.find((k) => k.id === id);
    if (c?.kind !== 'styleSpline') {
        return { error: 'Pick a style spline.' };
    }
    const pts = c.points.map((p) => {
        const q = g.points.find((x) => x.id === p);
        return q ? [q.u, q.v] as Pt : [0, 0] as Pt;
    });
    let best = { i: 0, d: Infinity };
    for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((at[0] - a[0]) * (b[0] - a[0]) + (at[1] - a[1]) * (b[1] - a[1])) / l2));
        const d = dist(at, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        if (d < best.d) {
            best = { i, d };
        }
    }
    const r = addPoint(g, at);
    const points = [...c.points.slice(0, best.i + 1), r.id, ...c.points.slice(best.i + 1)];
    // A new vertex takes weight 1; knots of a converted spline no longer fit, so they go back to evenly spaced.
    const weights = c.weights ? [...c.weights.slice(0, best.i + 1), 1, ...c.weights.slice(best.i + 1)] : undefined;
    const next = { ...c, points, ...(weights ? { weights } : {}), knots: undefined };
    return { g: { ...r.g, curves: r.g.curves.map((k) => (k.id === id ? next : k)) }, point: r.id };
}

/**
 * Inserts a spline point on the spline where `at` is nearest it (SolidWorks: Insert Spline Point): the piece there
 * is split, so the curve keeps its exact shape (the spans of the pieces are stored, sketchSplines.ts).
 */
export function insertSplinePoint(g: SketchGeometry, id: string, at: Pt): { g: SketchGeometry; point: string } | { error: string } {
    const c = g.curves.find((k) => k.id === id);
    if (c?.kind !== 'spline') {
        return { error: 'Pick a spline.' };
    }
    const r = splitSplineAt(g, c, at);
    if ('error' in r) {
        return r;
    }
    return { g: r.g, point: r.point };
}

/** Ends the spline in progress (double-click or Enter); with the first point again it closes. */
export function finishSpline(g: SketchGeometry, draft: PointRef[], closed = false): PlaceResult {
    // A double-click places its point twice: the same point is dropped.
    const refs = draft.filter((r, i) => i === 0 || dist(r.at, draft[i - 1].at) > 1e-6);
    if (refs.length < (closed ? 3 : 2)) {
        return { message: closed ? 'A closed spline needs at least three points.' : 'A spline needs at least two points.' };
    }
    return addSpline(g, refs, closed);
}

// ---- The preview ----------------------------------------------------------------------------------------------

function ellipseEntity(e: EllipseAxes): NewEntity {
    return { kind: 'ellipse', c: e.center, major: ellipseAt(e, 0), minor: e.b };
}

/** What the curve in progress would be with the cursor as its next point. */
export function conicDraftEntity(tool: ConicTool, draft: Pt[], cursor: Pt, sweep: number): NewEntity | null {
    const [a, b, c] = draft;
    const line = (p: Pt, q: Pt): NewEntity => ({ kind: 'line', a: p, b: q });
    switch (tool) {
        case 'ellipse':
        case 'partialEllipse': {
            if (draft.length === 1) {
                return line(a, cursor);
            }
            const second = draft.length === 2 ? cursor : c;
            const r2 = dist(a, secondAxis(a, b, second));
            if (r2 < 1e-9) {
                return line(a, b);
            }
            const e = ellipseAxes(a, b, r2);
            if (draft.length === 2) {
                return ellipseEntity(e);
            }
            const from = ellipseAt(e, ellipseParam(e, c));
            const to = ellipseAt(e, ellipseParam(e, cursor));
            if (dist(from, to) < 1e-9) {
                return ellipseEntity(e);
            }
            const ccw = sweep >= 0;
            const major = ellipseAt(e, 0);
            return withoutId(curveEntity('', from, { kind: 'ellipse', to, center: a, major, minor: e.b, ccw }));
        }
        case 'styleSpline': {
            const pts = [...draft, cursor].filter((p, i, all) => i === 0 || dist(p, all[i - 1]) > 1e-9);
            if (pts.length < 2) {
                return null;
            }
            const t = styleSplineType();
            const degree = t !== 'bezier' && pts.length > t ? t : pts.length - 1;
            return withoutId(curveEntity('', pts[0], { kind: 'bspline', to: pts[pts.length - 1], poles: pts.slice(1, -1), degree }));
        }
        case 'spline': {
            const pts = [...draft, cursor].filter((p, i, all) => i === 0 || dist(p, all[i - 1]) > 1e-9);
            if (pts.length < 2) {
                return null;
            }
            return withoutId(curveEntity('', pts[0], { kind: 'spline', to: pts[pts.length - 1], through: pts.slice(1, -1) }));
        }
        case 'parabola': {
            if (draft.length === 1) {
                return line(a, cursor);
            }
            const pf = parabolaFrame(a, b);
            if (!pf) {
                return null;
            }
            // Before the ends are set: the parabola as wide as the cursor is across its axis (at least 2f each side).
            const [x1, x2] = draft.length === 2
                ? [-Math.max(Math.abs(parabolaParam(pf, cursor)), 2 * pf.focal), Math.max(Math.abs(parabolaParam(pf, cursor)), 2 * pf.focal)]
                : [parabolaParam(pf, c), parabolaParam(pf, cursor)];
            if (Math.abs(x1 - x2) < 1e-9) {
                return null;
            }
            const from = parabolaAt(pf, x1);
            return withoutId(curveEntity('', from, parabolaSegment(pf, from, parabolaAt(pf, x2))));
        }
        case 'conic': {
            if (draft.length === 1) {
                return line(a, cursor);
            }
            const apex = draft.length === 2 ? cursor : c;
            const rho = draft.length === 2 ? 0.5 : rhoAt(a, b, c, cursor);
            if (Math.abs(across(a, b, apex)) < 1e-9) {
                return line(a, b);
            }
            return withoutId(curveEntity('', a, { kind: 'conic', to: b, apex, rho }));
        }
    }
}

function withoutId(e: { id: string } & NewEntity): NewEntity {
    const { id: _id, ...rest } = e;
    return rest as NewEntity;
}

/** The live size shown at the cursor. */
export function conicDraftText(tool: ConicTool, draft: Pt[], cursor: Pt): string | null {
    const f = shownText;
    const [a, b, c] = draft;
    if ((tool === 'ellipse' || tool === 'partialEllipse') && draft.length >= 1) {
        return draft.length === 1 ? `R1 ${f(dist(a, cursor))}` : draft.length === 2 ? `R2 ${f(Math.abs(across(a, b, cursor)))}` : null;
    }
    if (tool === 'conic' && draft.length === 3) {
        return `Rho ${f(rhoAt(a, b, c, cursor))}`;
    }
    return null;
}

/** Guides while drawing: the first axis, the whole ellipse round which a partial ellipse goes, a conic's end tangents. */
export function conicGuides(tool: ConicTool, draft: Pt[], cursor: Pt): NewEntity[] {
    const [a, b, c] = draft;
    const line = (p: Pt, q: Pt): NewEntity => ({ kind: 'line', a: p, b: q });
    if ((tool === 'ellipse' || tool === 'partialEllipse') && draft.length >= 2) {
        const out = [line(a, b)];
        if (draft.length === 3) {
            const r2 = dist(a, secondAxis(a, b, c));
            if (r2 > 1e-9) {
                out.push(ellipseEntity(ellipseAxes(a, b, r2)));
            }
        }
        return out;
    }
    if (tool === 'conic' && draft.length >= 2) {
        const apex = draft.length === 2 ? cursor : c;
        return [line(a, apex), line(apex, b)];
    }
    if (tool === 'parabola' && draft.length >= 2) {
        return [line(a, b)];
    }
    if (tool === 'styleSpline' && draft.length >= 1) {
        // The control polygon.
        const pts = [...draft, cursor];
        return pts.slice(1).map((p, i) => line(pts[i], p));
    }
    return [];
}

/**
 * Lines drawn with the sketch's curves: each style spline's control polygon and each conic's tangent lines (a
 * spline's handles are drawn by the spline tools while it is selected, sketchSplineDrawing.tsx).
 */
export function curveHelpers(g: SketchGeometry): NewEntity[] {
    const at = (id: string): Pt | null => {
        const p = g.points.find((q) => q.id === id) ?? (id === 'origin' ? { u: 0, v: 0 } : null);
        return p ? [p.u, p.v] : null;
    };
    const out: NewEntity[] = [];
    const line = (x: string, y: string) => {
        const [p, q] = [at(x), at(y)];
        if (p && q) {
            out.push({ kind: 'line', a: p, b: q });
        }
    };
    for (const c of g.curves) {
        if (c.kind === 'styleSpline') {
            c.points.slice(1).forEach((p, i) => line(c.points[i], p));
        } else if (c.kind === 'conic') {
            line(c.start, c.apex);
            line(c.apex, c.end);
        }
    }
    return out;
}


