// The sketch curves beyond lines, circles and arcs: ellipses, partial ellipses, splines, parabolas and conics.
// Their point ids, their exact shapes (as the path segments the kernel builds from), and building them from the
// draw tools. The curve maths is shared with the kernel through @jarvis/core/curves.

import type { SketchCurve, SketchGeometry, SketchSegment } from '@jarvis/core';
import { conicAt, ellipseAt, ellipseAxes, ellipseParam, type EllipseAxes, type SplineShape } from '@jarvis/core/curves';
import { pointOf } from './solver';

type Pt = [number, number];

/** The curve kinds this module adds. */
export type ExtraKind = 'ellipse' | 'ellipseArc' | 'spline' | 'styleSpline' | 'parabola' | 'conic';
export type ExtraCurve = Extract<SketchCurve, { kind: ExtraKind }>;

export const EXTRA_KINDS: readonly string[] = ['ellipse', 'ellipseArc', 'spline', 'styleSpline', 'parabola', 'conic'];
export const isExtra = (c: SketchCurve | undefined | null): c is ExtraCurve => !!c && EXTRA_KINDS.includes(c.kind);

/** Whether a point can be held on the curve by the solver (not yet on splines). */
export function holdsPoints(g: SketchGeometry, id: string): boolean {
    const c = g.curves.find((k) => k.id === id);
    return c?.kind !== 'spline' && c?.kind !== 'styleSpline';
}

/** What each kind is called in messages. */

export const CURVE_NOUN: Record<SketchCurve['kind'], string> = {
    line: 'line', circle: 'circle', arc: 'arc', ellipse: 'ellipse', ellipseArc: 'partial ellipse', spline: 'spline',
    styleSpline: 'style spline', parabola: 'parabola', conic: 'conic',
};

const dist = (p: Pt, q: Pt): number => Math.hypot(q[0] - p[0], q[1] - p[1]);

// ---- Point ids --------------------------------------------------------------------------------------------

/** Every point a curve is built on (centres, axis ends, foci and control points too). */
export function curvePointIds(c: SketchCurve): string[] {
    switch (c.kind) {
        case 'line':
            return [c.a, c.b];
        case 'circle':
            return [c.center];
        case 'arc':
            return [c.center, c.start, c.end];
        case 'ellipse':
            return [c.center, c.major, c.minor];
        case 'ellipseArc':
            return [c.center, c.major, c.minor, c.start, c.end];
        case 'spline':
            return [...new Set([...c.points, ...(c.startHandle ? [c.startHandle] : []), ...(c.endHandle ? [c.endHandle] : []),
                ...(c.handles ?? []).map((k) => k.handle)])];
        case 'styleSpline':
            return [...c.points];
        case 'parabola':
            return [c.focus, c.vertex, c.start, c.end];
        case 'conic':
            return [c.start, c.end, c.apex];
    }
}

/** The two end points of an open curve (a closed spline: its first point twice); none for circles and ellipses. */
export function curveEndIds(c: SketchCurve): string[] {
    switch (c.kind) {
        case 'line':
            return [c.a, c.b];
        case 'circle':
        case 'ellipse':
            return [];
        case 'spline':
        case 'styleSpline':
            return [c.points[0], c.points[c.points.length - 1]];
        default:
            return [c.start, c.end];
    }
}

/** The degree a style spline is built with: its B-spline degree when it has the control vertices for it, else Bezier. */
export function styleDegree(c: Extract<SketchCurve, { kind: 'styleSpline' }>): number {
    return c.degree && c.points.length > c.degree ? c.degree : c.points.length - 1;
}

/** Whether a spline is closed (ends on its first point). */

export const closedSpline = (c: Extract<SketchCurve, { kind: 'spline' }>): boolean => c.points.length > 2 && c.points[0] === c.points[c.points.length - 1];

/**
 * The curve with its point ids renamed. `reflected`: the copy is a mirror image, so a counter-clockwise curve (an arc,
 * a partial ellipse) swaps its start and end to stay counter-clockwise.
 */
export function mapCurvePoints<C extends SketchCurve>(c: C, f: (id: string) => string, reflected = false): C {
    const swap = reflected && (c.kind === 'arc' || c.kind === 'ellipseArc');
    const out = { ...c } as SketchCurve;
    switch (out.kind) {
        case 'line':
            out.a = f(out.a);
            out.b = f(out.b);
            break;
        case 'circle':
            out.center = f(out.center);
            break;
        case 'spline':
            out.points = out.points.map(f);
            out.startHandle = out.startHandle && f(out.startHandle);
            out.endHandle = out.endHandle && f(out.endHandle);
            if (!out.startHandle) {
                delete out.startHandle;
            }
            if (!out.endHandle) {
                delete out.endHandle;
            }
            if (out.handles) {
                out.handles = out.handles.map((k) => ({ ...k, point: f(k.point), handle: f(k.handle) }));
            }
            if (out.curvature) {
                // A mirror image turns the other way.
                out.curvature = out.curvature.map((k) => ({ point: f(k.point), value: reflected ? -k.value : k.value }));
            }
            break;
        case 'styleSpline':
            out.points = out.points.map(f);
            break;
        case 'parabola':
            out.focus = f(out.focus);
            out.vertex = f(out.vertex);
            out.start = f(out.start);
            out.end = f(out.end);
            break;
        case 'conic':
            out.apex = f(out.apex);
            out.start = f(out.start);
            out.end = f(out.end);
            break;
        default:
            out.center = f(out.center);
            if (out.kind !== 'arc') {
                out.major = f(out.major);
                out.minor = f(out.minor);
            }
            if (out.kind !== 'ellipse') {
                const [s, e] = [f(out.start), f(out.end)];
                out.start = swap ? e : s;
                out.end = swap ? s : e;
            }
    }
    return out as C;
}

/** The centre-like points of a curve (snapped to as centres): circle, arc and ellipse centres, a parabola's focus. */
export function curveCentreIds(c: SketchCurve): string[] {
    switch (c.kind) {
        case 'circle':
        case 'arc':
        case 'ellipse':
        case 'ellipseArc':
            return [c.center];
        case 'parabola':
            return [c.focus];
        default:
            return [];
    }
}

// ---- Shapes -----------------------------------------------------------------------------------------------

const P = (g: SketchGeometry, id: string): Pt | null => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : null;
};

/** The ellipse of an ellipse or partial ellipse curve. */
export function ellipseOfCurve(g: SketchGeometry, c: Extract<SketchCurve, { kind: 'ellipse' | 'ellipseArc' }>): EllipseAxes | null {
    const [centre, major, minor] = [P(g, c.center), P(g, c.major), P(g, c.minor)];
    return centre && major && minor ? ellipseAxes(centre, major, dist(centre, minor)) : null;
}

/** A parabola's own frame: its vertex, the unit axis toward the focus (the way it opens) and the focal length. */
export interface ParabolaFrame {
    vertex: Pt;
    /** Unit vector from the vertex toward the focus (the way the parabola opens). */
    axis: Pt;
    /** Unit vector across the axis (axis turned a quarter left). */
    across: Pt;
    focal: number;
}

export function parabolaFrame(focus: Pt, vertex: Pt): ParabolaFrame | null {
    const f = dist(focus, vertex);
    if (!(f > 1e-9)) {
        return null;
    }
    const axis: Pt = [(focus[0] - vertex[0]) / f, (focus[1] - vertex[1]) / f];
    return { vertex, axis, across: [-axis[1], axis[0]], focal: f };
}

/** Position across the axis of a point (its parameter on the parabola). */
export const parabolaParam = (pf: ParabolaFrame, p: Pt): number => (p[0] - pf.vertex[0]) * pf.across[0] + (p[1] - pf.vertex[1]) * pf.across[1];

/** Point of the parabola at parameter x: x across the axis, x² / 4f along it. */
export function parabolaAt(pf: ParabolaFrame, x: number): Pt {
    const y = (x * x) / (4 * pf.focal);
    return [pf.vertex[0] + pf.across[0] * x + pf.axis[0] * y, pf.vertex[1] + pf.across[1] * x + pf.axis[1] * y];
}

/** The parabola arc from a to b as a conic segment: Rho 0.5, its end tangents meeting at the apex. */
export function parabolaSegment(pf: ParabolaFrame, a: Pt, b: Pt): SketchSegment {
    const [x1, x2] = [parabolaParam(pf, a), parabolaParam(pf, b)];
    const apex = parabolaAt(pf, 0);
    const k = (x1 * x2) / (4 * pf.focal);
    const m = (x1 + x2) / 2;
    const top: Pt = Math.abs(x1 - x2) < 1e-12 ? a : [apex[0] + pf.across[0] * m + pf.axis[0] * k, apex[1] + pf.across[1] * m + pf.axis[1] * k];
    return { kind: 'conic', to: b, apex: top, rho: 0.5 };
}

/** Points of a spline curve, in order (a closed one: its first point again at the end). */
export function splineCoords(g: SketchGeometry, c: Extract<SketchCurve, { kind: 'spline' }>): Pt[] | null {
    const pts = c.points.map((id) => P(g, id));
    return pts.every(Boolean) ? (pts as Pt[]) : null;
}

/**
 * The exact segment of an open (or closing) curve from its start point to its end point, and the start point; null
 * for an ellipse (closed, see ellipseOfCurve) and for missing points.
 */
export function curveSegment(g: SketchGeometry, c: ExtraCurve): { from: Pt; seg: SketchSegment } | null {
    switch (c.kind) {
        case 'ellipse':
            return null;
        case 'ellipseArc': {
            const [centre, major, minor, s, e] = [c.center, c.major, c.minor, c.start, c.end].map((id) => P(g, id));
            if (!centre || !major || !minor || !s || !e) {
                return null;
            }
            return { from: s, seg: { kind: 'ellipse', to: e, center: centre, major, minor: dist(centre, minor), ccw: true } };
        }
        case 'spline': {
            const pts = splineCoords(g, c);
            if (!pts || pts.length < 2) {
                return null;
            }
            const [start, end] = [c.startHandle && P(g, c.startHandle), c.endHandle && P(g, c.endHandle)];
            return {
                from: pts[0],
                seg: {
                    kind: 'spline', to: pts[pts.length - 1], through: pts.slice(1, -1), ...(start ? { startHandle: start } : {}), ...(end ? { endHandle: end } : {}),
                    ...splineExtras(g, c, pts),
                },
            };
        }
        case 'styleSpline': {
            const pts = c.points.map((id) => P(g, id));
            if (!pts.every(Boolean) || pts.length < 2) {
                return null;
            }
            const poles = pts as Pt[];
            const degree = styleDegree(c);
            const knots = degree < poles.length - 1 && c.knots?.length === poles.length - degree - 1 ? { knots: c.knots } : {};
            const weights = c.weights?.length === poles.length && c.weights.some((w) => w !== 1) ? { weights: c.weights } : {};
            return { from: poles[0], seg: { kind: 'bspline', to: poles[poles.length - 1], poles: poles.slice(1, -1), degree, ...knots, ...weights } };
        }
        case 'parabola': {
            const [f, v, s, e] = [c.focus, c.vertex, c.start, c.end].map((id) => P(g, id));
            const pf = f && v ? parabolaFrame(f, v) : null;
            return pf && s && e ? { from: s, seg: parabolaSegment(pf, s, e) } : null;
        }
        case 'conic': {
            const [s, e, apex] = [c.start, c.end, c.apex].map((id) => P(g, id));
            return s && e && apex ? { from: s, seg: { kind: 'conic', to: e, apex, rho: c.rho } } : null;
        }
    }
}

/**
 * What else a spline loses with deleted points (its `points` already without them): the handles and held curvatures
 * on them or with their handle point gone; where it has a stored spacing, the pieces either side of a deleted point
 * become one piece as long (in its parameter) as the two were.
 */
export function splineAfterRemoval(g: SketchGeometry, c: Extract<SketchCurve, { kind: 'spline' }>, points: string[], gone: ReadonlySet<string>): Partial<Extract<SketchCurve, { kind: 'spline' }>> {
    const out: Partial<Extract<SketchCurve, { kind: 'spline' }>> = {};
    if (c.handles) {
        out.handles = c.handles.filter((h) => !gone.has(h.point) && !gone.has(h.handle));
    }
    if (c.curvature) {
        out.curvature = c.curvature.filter((k) => !gone.has(k.point));
    }
    const closed = closedSpline(c);
    const old = closed ? c.points.slice(0, -1) : c.points;
    if (!c.spacing || !old.some((p) => gone.has(p))) {
        return out;
    }
    out.spacing = undefined;
    const at = old.map((id) => P(g, id));
    if (c.spacing.length !== c.points.length - 1 || points.length < 2 || !at.every(Boolean)) {
        return out;
    }
    const pts = at as Pt[];
    const span = (i: number) => c.spacing![i] * dist(pts[i], pts[(i + 1) % pts.length]);
    const kept = old.map((p, i) => (gone.has(p) ? -1 : i)).filter((i) => i >= 0);
    const spacing: number[] = [];
    const between = (a: number, b: number) => {
        let sum = 0;
        for (let i = a; i !== b; i = (i + 1) % old.length) {
            sum += span(i);
        }
        const chord = dist(pts[a], pts[b]);
        return chord > 1e-12 ? sum / chord : 1;
    };
    for (let j = 0; j + 1 < kept.length; j++) {
        spacing.push(between(kept[j], kept[j + 1]));
    }
    if (closed && kept.length > 1) {
        spacing.push(between(kept[kept.length - 1], kept[0]));
    }
    if (spacing.length === points.length - 1) {
        out.spacing = spacing;
    }
    return out;
}

/** Index of a spline point among the spline's points (a closed spline's first point is 0). */
export function splineIndex(c: Extract<SketchCurve, { kind: 'spline' }>, point: string): number {
    return c.points.indexOf(point);
}

/** The control points before and after an inner handle: the handle point, and as far again times `back` the other way. */
export function handleArms(g: SketchGeometry, h: { point: string; handle: string; back?: number; before?: true }): { prev: Pt; next: Pt } | null {
    const [p, q] = [P(g, h.point), P(g, h.handle)];
    if (!p || !q) {
        return null;
    }
    const k = h.back ?? 1;
    const other: Pt = [p[0] - (q[0] - p[0]) * k, p[1] - (q[1] - p[1]) * k];
    return h.before ? { prev: q, next: other } : { prev: other, next: q };
}

/** The spline run the other way: its points reversed, end handles swapped, each inner handle on its other side. */
export function reversedSpline(c: Extract<SketchCurve, { kind: 'spline' }>): Extract<SketchCurve, { kind: 'spline' }> {
    const out: Extract<SketchCurve, { kind: 'spline' }> = { ...c, points: [...c.points].reverse() };
    delete out.startHandle;
    delete out.endHandle;
    if (c.endHandle) {
        out.startHandle = c.endHandle;
    }
    if (c.startHandle) {
        out.endHandle = c.startHandle;
    }
    if (c.spacing) {
        out.spacing = [...c.spacing].reverse();
    }
    if (c.handles) {
        out.handles = c.handles.map(({ before, ...h }) => (before ? h : { ...h, before: true as const }));
    }
    if (c.curvature) {
        out.curvature = c.curvature.map((k) => ({ ...k, value: -k.value }));
    }
    return out;
}

/** What a spline's shape takes besides its points (end and inner handles, curvatures, spacing), for splineBezier. */
export function splineShapeOf(g: SketchGeometry, c: Extract<SketchCurve, { kind: 'spline' }>): SplineShape {
    const pts = splineCoords(g, c);
    const [start, end] = [c.startHandle ? P(g, c.startHandle) : null, c.endHandle ? P(g, c.endHandle) : null];
    const extras = pts ? splineExtras(g, c, pts) : {};
    return {
        ...(start ? { start } : {}), ...(end ? { end } : {}),
        ...(extras.handles ? { inner: extras.handles } : {}), ...(extras.curvature ? { curvature: extras.curvature } : {}),
        ...(extras.continuity ? { continuity: true } : {}), ...(extras.spacing ? { spacing: extras.spacing } : {}),
    };
}

/** A spline's inner handles, held curvatures, continuity and stored spans, as its path segment carries them. */
function splineExtras(g: SketchGeometry, c: Extract<SketchCurve, { kind: 'spline' }>, pts: Pt[]): Partial<Extract<SketchSegment, { kind: 'spline' }>> {
    const closed = closedSpline(c);
    const count = pts.length - 1;
    const distinct = closed ? count : pts.length;
    const at = (point: string) => {
        const i = splineIndex(c, point);
        return i >= 0 && i < distinct ? i : -1;
    };
    const handles = (c.handles ?? []).flatMap((h) => {
        const i = at(h.point);
        const arms = i >= 0 ? handleArms(g, h) : null;
        return arms ? [{ at: i, ...arms }] : [];
    });
    const curvature = (c.curvature ?? []).flatMap((k) => {
        const i = at(k.point);
        return i >= 0 && Number.isFinite(k.value) ? [{ at: i, value: k.value }] : [];
    });
    const spacing = c.spacing && c.spacing.length === count && c.spacing.every((f) => f > 0) ? c.spacing : null;
    return {
        ...(handles.length ? { handles } : {}),
        ...(curvature.length ? { curvature } : {}),
        ...(handles.length && c.continuity !== false ? { continuity: true } : {}),
        ...(spacing ? { spacing } : {}),
    };
}

/** The shoulder point of a conic (on the line from the chord's middle to the apex, Rho of the way). */
export function conicShoulder(a: Pt, apex: Pt, b: Pt, rho: number): Pt {
    return conicAt(a, apex, b, rho, 0.5);
}

/** Point of an ellipse nearest in parameter to p, on the curve. */
export function onEllipse(e: EllipseAxes, p: Pt): Pt {
    return ellipseAt(e, ellipseParam(e, p));
}
