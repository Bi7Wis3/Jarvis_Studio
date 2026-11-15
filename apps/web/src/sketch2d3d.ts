// The 2D to 3D toolbar (SolidWorks: a single 2D sketch, drawn or imported, turned into a part). Create Sketch from
// Selections and Add to Front / Top / Right / Left / Bottom / Back Sketch take the selected entities out of the
// sketch being edited into a sketch of their own; the views fold up about the Front view's edges as if the drawing
// were paper (third angle: Top above the Front, Right to its right, Back beyond the Right), Auxiliary about a line of
// another view. Align Sketch moves one sketch in its plane so an edge or point of it meets one of another sketch. Pure
// functions of the geometry and planes; the forms are in sketch2d3dForms.tsx.

import type { CustomSketchPlane, Feature, Sketch, SketchConstraint, SketchGeometry, SketchPlane, SketchView, Vec3 } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, isDimension } from './solver';
import { constraintRefs, geometryEntities, geometryOpenChains, geometryProfiles, profilesToGeometry, removeItemsKeepingPoints } from './sketchGeometry';
import { curvePoints } from './sketchEdit';
import { regionsOf } from './regionPick';
import { entityPoints, planeFrame, type Pt } from './sketchMath';

type Frame = ReturnType<typeof planeFrame>;

export const VIEW_NAMES: Record<SketchView, string> = {
    front: 'Front', top: 'Top', right: 'Right', left: 'Left', bottom: 'Bottom', back: 'Back', auxiliary: 'Auxiliary',
};

// ---- Taking entities out ------------------------------------------------------------------------------------------

/**
 * The selected curves taken out of the sketch: `picked` holds them, their points and the relations and dimensions
 * among them (and to the origin and axes, which stay where they are); `rest` is the sketch without them.
 */
export function extractCurves(g: SketchGeometry, ids: string[], labels: Record<string, Pt> = {}): { picked: SketchGeometry; rest: SketchGeometry } {
    const curves = g.curves.filter((c) => ids.includes(c.id));
    const points = new Set(curves.flatMap(curvePoints));
    points.delete(ORIGIN);
    const own = new Set<string>([...curves.map((c) => c.id), ...points, ORIGIN, AXIS_U, AXIS_V]);
    const constraints = g.constraints.filter((k) => constraintRefs(k).every((r) => own.has(r)) && constraintRefs(k).some((r) => r !== ORIGIN && r !== AXIS_U && r !== AXIS_V))
        .map((k): SketchConstraint => (isDimension(k) && labels[k.id] ? { ...k, at: labels[k.id] } as SketchConstraint : k));
    const picked: SketchGeometry = { points: g.points.filter((p) => points.has(p.id) || p.id === ORIGIN), curves, constraints };
    return { picked, rest: removeItemsKeepingPoints(g, curves.map((c) => c.id)) };
}

/** A sketch step's sketch from sketcher geometry: the profiles the kernel builds, every region, the open chains. */
export function sketchOfGeometry(g: SketchGeometry, plane: SketchPlane, offset = 0, extra: Partial<Sketch> = {}): Sketch {
    const regions = regionsOf(g);
    const open = geometryOpenChains(g);
    return {
        plane,
        ...(offset ? { offset } : {}),
        profiles: geometryProfiles(g).profiles,
        ...(regions.length ? { regions } : {}),
        ...(open.length ? { open } : {}),
        geometry: g,
        ...extra,
    };
}

// ---- Folding views ------------------------------------------------------------------------------------------------

export interface Bounds {
    lo: Pt;
    hi: Pt;
}

/** The extent of the curves (arcs and splines by their drawn points). */
export function boundsOf(g: SketchGeometry): Bounds | null {
    const pts = geometryEntities(g).flatMap((e) => entityPoints(e));
    if (!pts.length) {
        return null;
    }
    return {
        lo: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))],
        hi: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))],
    };
}

// Float noise on whole numbers goes; directions keep their full precision (a rounded one would shift far points).
const clean = (x: number) => (Math.abs(x - Math.round(x)) < 1e-12 ? Math.round(x) + 0 : x);
const at3 = (f: Frame, p: Pt): Vec3 => [0, 1, 2].map((i) => f.origin[i] + f.u[i] * p[0] + f.v[i] * p[1]) as Vec3;
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot2 = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

/** The sketch plane on which a drawing point p of the view lands where `map` puts it (coordinates unchanged). */
function planeOfMap(map: (p: Pt) => Vec3): CustomSketchPlane {
    const o = map([0, 0]);
    const x = sub3(map([1, 0]), o);
    const y = sub3(map([0, 1]), o);
    return { origin: o.map(clean) as Vec3, normal: cross3(x, y).map(clean) as Vec3, xDir: x.map(clean) as Vec3 };
}

/**
 * Folds a view about a hinge line of the drawing (through `a`, along unit `l`): the view's side of the line turns away
 * from the viewer, square to the drawing, its edge nearest the line `near` mm from it landing on the line.
 */
export function foldAbout(drawing: Frame, a: Pt, l: Pt, side: Pt, near: number): CustomSketchPlane {
    return planeOfMap((p) => {
        const rel: Pt = [p[0] - a[0], p[1] - a[1]];
        const along = dot2(rel, l);
        const depth = dot2(rel, side) - near;
        const onLine = at3(drawing, [a[0] + l[0] * along, a[1] + l[1] * along]);
        return [0, 1, 2].map((i) => onLine[i] - drawing.n[i] * depth) as Vec3;
    });
}

/** Where each view goes, from the drawing's frame, the Front view's extent and the view's own (both in the drawing). */
export function viewPlane(
    view: Exclude<SketchView, 'front' | 'auxiliary'>, drawing: Frame, front: Bounds, own: Bounds, depth: number | null,
): CustomSketchPlane | { error: string } {
    switch (view) {
        case 'top':
            return foldAbout(drawing, [0, front.hi[1]], [1, 0], [0, 1], own.lo[1] - front.hi[1]);
        case 'bottom':
            return foldAbout(drawing, [0, front.lo[1]], [1, 0], [0, -1], front.lo[1] - own.hi[1]);
        case 'right':
            return foldAbout(drawing, [front.hi[0], 0], [0, 1], [1, 0], own.lo[0] - front.hi[0]);
        case 'left':
            return foldAbout(drawing, [front.lo[0], 0], [0, 1], [-1, 0], front.lo[0] - own.hi[0]);
        case 'back':
            if (depth === null) {
                return { error: 'Add the Right, Left, Top or Bottom view first: the Back view goes as far behind the Front as the part is deep.' };
            }
            // Beyond the Right view, seen from behind: its left edge is the part's right side.
            return planeOfMap((p) => {
                const q = at3(drawing, [front.hi[0] + own.lo[0] - p[0], p[1]]);
                return [0, 1, 2].map((i) => q[i] - drawing.n[i] * depth) as Vec3;
            });
    }
}

/** The Auxiliary view: folded about a line of another view (`a` to `b`, in the drawing), away from the line's side. */
export function auxiliaryPlane(drawing: Frame, a: Pt, b: Pt, own: SketchGeometry): CustomSketchPlane | { error: string } {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const pts = geometryEntities(own).flatMap((e) => entityPoints(e));
    if (length < 1e-9 || !pts.length) {
        return { error: 'Pick a line of another view for the angle of the Auxiliary view.' };
    }
    const l: Pt = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const centre: Pt = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    let side: Pt = [-l[1], l[0]];
    if (dot2([centre[0] - a[0], centre[1] - a[1]], side) < 0) {
        side = [l[1], -l[0]];
    }
    const near = Math.min(...pts.map((p) => dot2([p[0] - a[0], p[1] - a[1]], side)));
    return foldAbout(drawing, a, l, side, near);
}

// ---- The part's view sketches -------------------------------------------------------------------------------------

const sketchSteps = (features: Feature[]) => features.flatMap((f, i) => (f.op === 'sketch' && !f.suppressed ? [{ f, i, sketch: f.sketch }] : []));

/** A sketch step's geometry seen in the drawing's coordinates (projected), when its plane is parallel to it. */
function inDrawing(features: Feature[], i: number, sketch: Sketch, drawing: Frame): SketchGeometry | null {
    const there = planeFrame(sketch.plane, sketch.offset ?? 0, features.slice(0, i));
    if (Math.abs(there.n[0] * drawing.n[0] + there.n[1] * drawing.n[1] + there.n[2] * drawing.n[2]) < 1 - 1e-9) {
        return null;
    }
    const g = sketch.geometry ?? profilesToGeometry(sketch.profiles);
    return {
        ...g,
        points: g.points.map((p) => {
            const w = at3(there, [p.u, p.v]);
            const rel = sub3(w, drawing.origin);
            return { ...p, u: rel[0] * drawing.u[0] + rel[1] * drawing.u[1] + rel[2] * drawing.u[2], v: rel[0] * drawing.v[0] + rel[1] * drawing.v[1] + rel[2] * drawing.v[2] };
        }),
    };
}

/** The Front view's extent in the drawing, from the part's latest Front view sketch; or why there is none. */
export function frontBounds(features: Feature[], drawing: Frame): Bounds | { error: string } {
    const front = sketchSteps(features).filter((s) => s.sketch.view === 'front').pop();
    if (!front) {
        return { error: 'Add the Front view first (Add to front sketch): the other views fold up about its edges.' };
    }
    const g = inDrawing(features, front.i, front.sketch, drawing);
    const b = g && boundsOf(g);
    return b ?? { error: 'The Front view sketch is not parallel to this sketch, or is empty: add the Front view from this sketch.' };
}

/** How deep the part is, from its Right or Left view (their width) or its Top or Bottom view (their height). */
export function viewDepth(features: Feature[]): number | null {
    for (const s of sketchSteps(features).reverse()) {
        const b = s.sketch.view && boundsOf(s.sketch.geometry ?? profilesToGeometry(s.sketch.profiles));
        if (b && (s.sketch.view === 'right' || s.sketch.view === 'left')) {
            return b.hi[0] - b.lo[0];
        }
        if (b && (s.sketch.view === 'top' || s.sketch.view === 'bottom')) {
            return b.hi[1] - b.lo[1];
        }
    }
    return null;
}

/** A fresh, unused name for a view sketch: Top, then Top2, ... */
export function viewName(features: Feature[], view: SketchView): string {
    const base = VIEW_NAMES[view];
    const names = new Set(features.map((f) => f.name));
    if (!names.has(base)) {
        return base;
    }
    let n = 2;
    while (names.has(`${base}${n}`)) {
        n += 1;
    }
    return `${base}${n}`;
}

/** A fresh step id for a sketch: sketch-<n>. */
export function sketchStepId(features: Feature[]): string {
    const ids = new Set(features.map((f) => f.id));
    let n = features.filter((f) => f.op === 'sketch').length + 1;
    while (ids.has(`sketch-${n}`)) {
        n += 1;
    }
    return `sketch-${n}`;
}

// ---- Align sketch -------------------------------------------------------------------------------------------------

export type AlignRef = { kind: 'point'; p: Pt } | { kind: 'line'; a: Pt; b: Pt };

/**
 * How this sketch moves in its plane so its point or line meets the other sketch's (seen in this sketch's coordinates):
 * a line turns the least way to lie along the other line, then slides square to it; a point goes onto the other point,
 * or square onto the other line.
 */
export function alignMotion(mine: AlignRef, other: AlignRef): { by: Pt; centre: Pt; angle: number } | { error: string } {
    const unit = (a: Pt, b: Pt): Pt | null => {
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return l > 1e-9 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
    };
    if (mine.kind === 'point') {
        if (other.kind === 'point') {
            return { by: [other.p[0] - mine.p[0], other.p[1] - mine.p[1]], centre: [0, 0], angle: 0 };
        }
        const d = unit(other.a, other.b);
        if (!d) {
            return { error: 'The other line is seen end on from this sketch: pick one of its points instead.' };
        }
        const n: Pt = [-d[1], d[0]];
        const off = dot2([mine.p[0] - other.a[0], mine.p[1] - other.a[1]], n);
        return { by: [-n[0] * off, -n[1] * off], centre: [0, 0], angle: 0 };
    }
    const d1 = unit(mine.a, mine.b);
    if (!d1) {
        return { error: 'Pick a line with some length in this sketch.' };
    }
    const mid: Pt = [(mine.a[0] + mine.b[0]) / 2, (mine.a[1] + mine.b[1]) / 2];
    if (other.kind === 'point') {
        const n: Pt = [-d1[1], d1[0]];
        const off = dot2([other.p[0] - mine.a[0], other.p[1] - mine.a[1]], n);
        return { by: [n[0] * off, n[1] * off], centre: mid, angle: 0 };
    }
    const d2 = unit(other.a, other.b);
    if (!d2) {
        return { error: 'The other line is seen end on from this sketch: pick one of its points instead.' };
    }
    // Lines have no direction: the turn of less than a quarter either way.
    let turn = Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0]);
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    if (turn > Math.PI / 2) {
        turn -= Math.PI;
    } else if (turn < -Math.PI / 2) {
        turn += Math.PI;
    }
    const n: Pt = [-d2[1], d2[0]];
    const off = dot2([mid[0] - other.a[0], mid[1] - other.a[1]], n);
    return { by: [-n[0] * off, -n[1] * off], centre: mid, angle: (turn * 180) / Math.PI };
}

/** The point or line `id` of a geometry as an align reference. */
export function alignRef(g: SketchGeometry, id: string): AlignRef | null {
    const p = g.points.find((q) => q.id === id);
    if (p) {
        return { kind: 'point', p: [p.u, p.v] };
    }
    if (id === ORIGIN) {
        return { kind: 'point', p: [0, 0] };
    }
    const c = curveOf(g, id);
    if (c?.kind === 'line') {
        const [a, b] = [g.points.find((q) => q.id === c.a), g.points.find((q) => q.id === c.b)];
        return a && b ? { kind: 'line', a: [a.u, a.v], b: [b.u, b.v] } : null;
    }
    return null;
}
