// The model seen from an open sketch: the part's edges (as it is before the sketch's step) projected onto the
// sketch plane by the kernel, and the curves of the part's other sketches projected here, as exact sketch curves.
// Used for snapping to model geometry, Convert Entities, Intersection Curve, Silhouette Entities, offsets, mirror
// lines and pattern directions taken from model edges, and pierce points. References to the model are kept by value:
// what is converted is locked where it is and marked as coming from the model.

import { create } from 'zustand';
import type { Feature, SketchConstraint, SketchCurve, SketchGeometry, SketchPlane, SketchPoint, SketchSegment, Vec3 } from '@jarvis/core';
import { ellipseAxes, ellipseParam, segmentMiddle, splineBezier } from '@jarvis/core/curves';
import { bsplineGeom } from '@jarvis/core/curveSplit';
import {
    projectConic, projectPoint, tidy, type ModelCurve, type ModelQuery, type ModelSketch, type P2,
    type PlaneFrame3, type TaggedCurve,
} from '@jarvis/core/projection';
import { constraintRefs, curveAt, pickAt, profilesToGeometry } from './sketchGeometry';
import { withoutRepeatedLocks } from './sketchLock';
import { planeFrame, type NewEntity, type Pt } from './sketchMath';
import { closedSpline, curvePointIds, parabolaFrame, parabolaSegment, splineShapeOf, styleDegree } from './sketchCurves';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Constraint ids of the locks put on converted geometry start with this: the relations list names them. */
export const MODEL_LOCK = 'km';
export const isModelLock = (c: Pick<SketchConstraint, 'id'>): boolean => c.id.startsWith(MODEL_LOCK) && /^km\d+$/.test(c.id);
/** Locks on geometry taken from another sketch: `ks<n>@<step id>`. */
export const SKETCH_LOCK = 'ks';
/** The sketch step a lock's geometry was taken from, or null. */
export const sketchLockSource = (c: Pick<SketchConstraint, 'id'>): string | null => /^ks\d+@(.+)$/.exec(c.id)?.[1] ?? null;
/** How the relations list names a lock on converted geometry. */
export const MODEL_LOCK_NAME = 'From the model, as it was';
/** The one line every form that copies from the model shows. */
export const BY_VALUE_NOTE = 'Copied from the model as it is now: it is locked in place and does not follow later changes to the model.';
/** What Copy as sketch entities says instead. */
export const COPY_NOTE = 'Copied as plain sketch entities: nothing holds them, so they can be dragged, dimensioned and edited like any other.';

/**
 * A model edge or vertex picked while sketching (selected, or picked by a relation or dimension tool) comes into the
 * sketch as a reference: locked construction with ids `pr<n>` (points) and `cr<n>` (curves). One that no relation,
 * dimension or curve uses is taken out again once it is no longer selected or picked (sketchModelSelect.ts).
 */
export const isModelReference = (id: string): boolean => /^[pc]r\d+$/.test(id);

// ---- Turning model curves into sketch geometry -------------------------------------------------------------

const SAME = 1e-9;

export interface ToGeometryOptions {
    /** Ids for the new points and curves (default: p1, c1, ... after what `base` uses). */
    id?: (kind: 'p' | 'c', n: number) => string;
    construction?: boolean;
    /** Lock every new point (and circle radius) with a model lock. */
    lock?: boolean;
    /** The locks say the geometry came from this other sketch step (by id), not from the model. */
    lockFrom?: string;
}

/**
 * Adds the curves to `base` as sketch entities. End points that coincide are shared. Returns the geometry and the
 * ids of the new curves in order.
 */
export function addModelCurves(base: SketchGeometry, curves: ModelCurve[], o: ToGeometryOptions = {}): { g: SketchGeometry; ids: string[] } {
    const used = new Set([...base.points.map((p) => p.id), ...base.curves.map((c) => c.id), ...base.constraints.map((c) => c.id)]);
    const counters = { p: 0, c: 0, k: 0 };
    const fresh = (kind: 'p' | 'c' | 'k'): string => {
        for (;;) {
            counters[kind] += 1;
            const id = kind === 'k' ? (o.lockFrom ? `${SKETCH_LOCK}${counters.k}@${o.lockFrom}` : `${MODEL_LOCK}${counters.k}`) : o.id ? o.id(kind, counters[kind]) : `${kind}m${counters[kind]}`;
            if (!used.has(id)) {
                used.add(id);
                return id;
            }
        }
    };
    const points: SketchPoint[] = [];
    const shared: { id: string; p: P2 }[] = [];
    // End points are shared between curves; centres and control vertices are each curve's own.
    const end = (p: P2): string => {
        const hit = shared.find((q) => Math.abs(q.p[0] - p[0]) <= SAME && Math.abs(q.p[1] - p[1]) <= SAME);
        if (hit) {
            return hit.id;
        }
        const id = point(p);
        shared.push({ id, p });
        return id;
    };
    const point = (p: P2): string => {
        const id = fresh('p');
        points.push({ id, u: p[0], v: p[1] });
        return id;
    };
    const out: SketchCurve[] = [];
    const extra = o.construction ? { construction: true } : {};
    for (const c of curves) {
        const id = fresh('c');
        switch (c.kind) {
            case 'line':
                out.push({ id, kind: 'line', a: end(c.a), b: end(c.b), ...extra });
                break;
            case 'circle':
                out.push({ id, kind: 'circle', center: point(c.center), radius: c.radius, ...extra });
                break;
            case 'arc':
                out.push({ id, kind: 'arc', center: point(c.center), start: end(c.start), end: end(c.end), ...extra });
                break;
            case 'ellipse':
            case 'ellipseArc': {
                const d: P2 = [c.major[0] - c.center[0], c.major[1] - c.center[1]];
                const l = Math.hypot(...d) || 1;
                const minor: P2 = [tidy(c.center[0] - (d[1] / l) * c.minor), tidy(c.center[1] + (d[0] / l) * c.minor)];
                const [centre, major, mi] = [point(c.center), point(c.major), point(minor)];
                out.push(c.kind === 'ellipse'
                    ? { id, kind: 'ellipse', center: centre, major, minor: mi, ...extra }
                    : { id, kind: 'ellipseArc', center: centre, major, minor: mi, start: end(c.start), end: end(c.end), ...extra });
                break;
            }
            case 'bezier':
            case 'bspline': {
                const ids = c.poles.map((p, i) => (i === 0 || i === c.poles.length - 1 ? end(p) : point(p)));
                out.push({ id, kind: 'styleSpline', points: ids, ...(c.kind === 'bspline' ? { degree: c.degree } : {}), ...extra });
                break;
            }
            case 'conic':
                out.push({ id, kind: 'conic', start: end(c.start), end: end(c.end), apex: point(c.apex), rho: c.rho, ...extra });
                break;
        }
    }
    const constraints: SketchConstraint[] = [];
    if (o.lock) {
        for (const p of points) {
            constraints.push({ id: fresh('k'), kind: 'fix', point: p.id });
        }
        for (const c of out) {
            if (c.kind === 'circle') {
                constraints.push({ id: fresh('k'), kind: 'fixRadius', curve: c.id });
            }
        }
    }
    const g: SketchGeometry = { points: [...base.points, ...points], curves: [...base.curves, ...out], constraints: [...base.constraints, ...constraints] };
    // Arcs, ellipses and parabolas: points that sit on the curve the others give are held in one coordinate only.
    return { g: o.lock ? withoutRepeatedLocks(g, constraints.map((c) => c.id), () => fresh('k')) : g, ids: out.map((c) => c.id) };
}

/** A model curve as a sketch preview entity. */
export function curveEntity(c: ModelCurve): NewEntity {
    const curve = (from: P2, seg: SketchSegment): NewEntity => ({ kind: 'curve', a: from, b: seg.to, m: segmentMiddle(from, seg), seg });
    switch (c.kind) {
        case 'line':
            return { kind: 'line', a: c.a, b: c.b };
        case 'circle':
            return { kind: 'circle', c: c.center, r: c.radius };
        case 'arc': {
            const seg: SketchSegment = { kind: 'arc', to: c.end, through: arcThrough(c.center, c.start, c.end) };
            return { kind: 'arc', a: c.start, b: c.end, m: seg.through };
        }
        case 'ellipse':
            return { kind: 'ellipse', c: c.center, major: c.major, minor: c.minor };
        case 'ellipseArc':
            return curve(c.start, { kind: 'ellipse', to: c.end, center: c.center, major: c.major, minor: c.minor, ccw: true });
        case 'bezier':
            return curve(c.poles[0], { kind: 'bspline', to: c.poles[c.poles.length - 1], poles: c.poles.slice(1, -1), degree: c.poles.length - 1 });
        case 'bspline':
            return curve(c.poles[0], { kind: 'bspline', to: c.poles[c.poles.length - 1], poles: c.poles.slice(1, -1), degree: c.degree });
        case 'conic':
            return curve(c.start, { kind: 'conic', to: c.end, apex: c.apex, rho: c.rho });
    }
}

/** The point halfway round a counter-clockwise arc. */
function arcThrough(c: P2, s: P2, e: P2): P2 {
    const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
    const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
    let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
    while (a1 <= a0) {
        a1 += 2 * Math.PI;
    }
    const m = (a0 + a1) / 2;
    return [c[0] + r * Math.cos(m), c[1] + r * Math.sin(m)];
}

// ---- Other sketches of the part, projected exactly ----------------------------------------------------------

export interface SourcedCurve {
    /** `<step id>/<curve id>` */
    id: string;
    curve: ModelCurve;
    construction: boolean;
}

/**
 * Every curve of the part's sketches in `features`, projected straight onto `here` as exact sketch curves: lines stay
 * lines; circles, arcs and ellipses become circles, arcs, ellipses or partial ellipses (or lines seen edge-on); splines
 * become Bezier pieces; style splines and conics keep their kind. `skip` leaves a step out.
 */
export function otherSketchCurves(features: Feature[], here: PlaneFrame3, skip: (id: string) => boolean = () => false): SourcedCurve[] {
    const out: SourcedCurve[] = [];
    features.forEach((f, index) => {
        const sketch = 'sketch' in f ? (f as { sketch?: { plane: SketchPlane; offset?: number; geometry?: SketchGeometry; profiles: never[] } }).sketch : undefined;
        if (!sketch || f.suppressed || skip(f.id)) {
            return;
        }
        const there = planeFrame(sketch.plane, sketch.offset ?? 0, features.slice(0, index));
        const g = sketch.geometry ?? profilesToGeometry(sketch.profiles);
        const at = new Map(g.points.map((p) => [p.id, [p.u, p.v] as P2]));
        at.set('origin', [0, 0]);
        const to3 = (p: P2): V3 => [0, 1, 2].map((i) => there.origin[i] + there.u[i] * p[0] + there.v[i] * p[1]) as V3;
        const P = (id: string): P2 | null => at.get(id) ?? null;
        for (const c of g.curves) {
            for (const curve of projectSketchCurve(c, P, to3, here)) {
                out.push({ id: `${f.id}/${c.id}`, curve, construction: !!c.construction });
            }
        }
    });
    return out;
}

function projectSketchCurve(c: SketchCurve, P: (id: string) => P2 | null, to3: (p: P2) => V3, here: PlaneFrame3): ModelCurve[] {
    const proj = (p: P2): P2 => {
        const q = projectPoint(here, to3(p));
        return [tidy(q[0]), tidy(q[1])];
    };
    const conic = (centre: P2, x: P2, y: P2, t0: number, t1: number, full: boolean): ModelCurve[] => {
        const C = to3(centre);
        const X = sub(to3(x), C);
        const Y = sub(to3(y), C);
        const r = projectConic(here, C, X, Y, t0, t1, full);
        return r ? [r] : [];
    };
    switch (c.kind) {
        case 'line': {
            const [a, b] = [P(c.a), P(c.b)];
            if (!a || !b) {
                return [];
            }
            const [pa, pb] = [proj(a), proj(b)];
            return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) > 1e-9 ? [{ kind: 'line', a: pa, b: pb }] : [];
        }
        case 'circle':
        case 'arc': {
            const centre = P(c.center);
            const start = c.kind === 'arc' ? P(c.start) : null;
            const finish = c.kind === 'arc' ? P(c.end) : null;
            if (!centre || (c.kind === 'arc' && (!start || !finish))) {
                return [];
            }
            const radius = c.kind === 'circle' ? c.radius : Math.hypot(start![0] - centre[0], start![1] - centre[1]);
            const x: P2 = c.kind === 'circle' ? [centre[0] + radius, centre[1]] : start!;
            const ux = [(x[0] - centre[0]) / radius, (x[1] - centre[1]) / radius];
            const y: P2 = [centre[0] - ux[1] * radius, centre[1] + ux[0] * radius];
            if (c.kind === 'circle') {
                return conic(centre, x, y, 0, 2 * Math.PI, true);
            }
            let sweep = Math.atan2(finish![1] - centre[1], finish![0] - centre[0]) - Math.atan2(start![1] - centre[1], start![0] - centre[0]);
            while (sweep <= 0) {
                sweep += 2 * Math.PI;
            }
            return conic(centre, x, y, 0, sweep, false);
        }
        case 'ellipse':
        case 'ellipseArc': {
            const [centre, major, minor] = [P(c.center), P(c.major), P(c.minor)];
            if (!centre || !major || !minor) {
                return [];
            }
            const e = ellipseAxes(centre, major, Math.hypot(minor[0] - centre[0], minor[1] - centre[1]));
            const x: P2 = [centre[0] + e.a * Math.cos(e.angle), centre[1] + e.a * Math.sin(e.angle)];
            const y: P2 = [centre[0] - e.b * Math.sin(e.angle), centre[1] + e.b * Math.cos(e.angle)];
            if (c.kind === 'ellipse') {
                return conic(centre, x, y, 0, 2 * Math.PI, true);
            }
            const [s, f] = [P(c.start), P(c.end)];
            if (!s || !f) {
                return [];
            }
            const t0 = ellipseParam(e, s);
            let t1 = ellipseParam(e, f);
            while (t1 <= t0) {
                t1 += 2 * Math.PI;
            }
            return conic(centre, x, y, t0, t1, false);
        }
        case 'spline': {
            const pts = c.points.map(P);
            if (pts.some((p) => !p) || pts.length < 2) {
                return [];
            }
            const closed = closedSpline(c);
            const through = (closed ? pts.slice(0, -1) : pts) as P2[];
            // Its handles at any point, held curvatures and spacing, from its own points.
            const local: SketchGeometry = {
                points: curvePointIds(c).flatMap((id) => {
                    const q = P(id);
                    return q ? [{ id, u: q[0], v: q[1] }] : [];
                }),
                curves: [c], constraints: [],
            };
            const poles = splineBezier(through, closed, splineShapeOf(local, c));
            const out: ModelCurve[] = [];
            for (let i = 0; i + 3 < poles.length; i += 3) {
                out.push({ kind: 'bezier', poles: poles.slice(i, i + 4).map(proj) });
            }
            return out;
        }
        case 'styleSpline': {
            const pts = c.points.map(P);
            // A rational style spline has no exact model curve here yet: it is left out rather than drawn wrong.
            if (pts.some((p) => !p) || pts.length < 2 || c.weights?.some((w) => w !== 1)) {
                return [];
            }
            const degree = styleDegree(c);
            const poles = (pts as P2[]).map(proj);
            if (degree === poles.length - 1) {
                return poles.length === 2 ? [{ kind: 'line', a: poles[0], b: poles[1] }] : [{ kind: 'bezier', poles }];
            }
            if (c.knots) {
                // Uneven knots (a piece cut from a longer style spline): as its exact Bezier pieces.
                return bsplineGeom(pts as P2[], degree, c.knots).pieces.map((k) => ({ kind: 'bezier' as const, poles: k.poles.map(proj) }));
            }
            return [{ kind: 'bspline', poles, degree: degree as 3 | 5 | 7 }];
        }
        case 'parabola': {
            const [focus, vertex, s, e] = [P(c.focus), P(c.vertex), P(c.start), P(c.end)];
            const pf = focus && vertex ? parabolaFrame(focus, vertex) : null;
            if (!pf || !s || !e) {
                return [];
            }
            const seg = parabolaSegment(pf, s, e);
            return seg.kind === 'conic' ? [{ kind: 'conic', start: proj(s), apex: proj(seg.apex), end: proj(e), rho: seg.rho }] : [];
        }
        case 'conic': {
            const [s, e, apex] = [P(c.start), P(c.end), P(c.apex)];
            return s && e && apex ? [{ kind: 'conic', start: proj(s), apex: proj(apex), end: proj(e), rho: c.rho }] : [];
        }
    }
}

/** The curves joined end to end with `seed` (through shared end points), seed first. */
export function chainOf(curves: SourcedCurve[], seed: number): number[] {
    const ends = curves.map((c) => endsOf(c.curve));
    const near = (p: P2, q: P2) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
    const out = [seed];
    for (let k = 0; k < out.length; k++) {
        for (let i = 0; i < curves.length; i++) {
            if (!out.includes(i) && ends[i].some((p) => ends[out[k]].some((q) => near(p, q)))) {
                out.push(i);
            }
        }
    }
    return out;
}

function endsOf(c: ModelCurve): P2[] {
    switch (c.kind) {
        case 'line':
            return [c.a, c.b];
        case 'circle':
        case 'ellipse':
            return [];
        case 'bezier':
        case 'bspline':
            return [c.poles[0], c.poles[c.poles.length - 1]];
        default:
            return [c.start, c.end];
    }
}

// ---- The kernel service -------------------------------------------------------------------------------------

export interface ModelTarget {
    partId: string;
    /** Steps of the part before the sketch. */
    steps: number;
    frame: PlaneFrame3;
}

/** Asks the kernel about the body before the sketch (POST /api/sketch-model). */
export async function fetchModelSketch(target: ModelTarget, query: ModelQuery): Promise<ModelSketch> {
    const response = await fetch('/api/sketch-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...target, query }),
    });
    const body = await response.json() as ModelSketch & { error?: string };
    if (!response.ok) {
        throw new Error(body.error ?? `The model could not be read (${response.status}).`);
    }
    return body;
}

export interface ModelPick {
    kind: 'edge' | 'face';
    /** Mesh ordinal (to tell picks apart and toggle them). */
    index: number;
    /** A point on it in the part frame; for a face, its outward normal there. */
    at: Vec3;
    normal?: Vec3;
}

interface SketchModelState {
    /** Sketch setting: the cursor snaps to the model's projected edges and vertices. Kept in localStorage. */
    snapModel: boolean;
    /** The projected edges per sketch target (see edgesKey). */
    edges: Record<string, ModelSketch | 'loading' | { error: string }>;
    /** A form that takes model picks is open: which one. */
    picking: string | null;
    /** Model faces and edges picked for it, and curves of other sketches (`<step>/<curve>`). */
    picks: ModelPick[];
    sketchPicks: string[];
    /** Ghost of what the form would add. */
    preview: NewEntity[];
    /** Bumped on every pick, for forms to react to. */
    version: number;
    /** Dimension and relation tools: the model edge or vertex under the cursor, lit up. */
    hover: NewEntity | null;
    /** Convert entities: model edges picked on the sketch plane, as their projected curves. */
    curvePicks: ModelCurve[];
    /** A face or edge right-clicked in the open sketch, for the form opened from that menu. */
    pendingPick: ModelPick | null;
}

const SNAP_MODEL_KEY = 'jarvis.sketch.snapModel';

export const useSketchModel = create<SketchModelState>(() => ({
    snapModel: globalThis.localStorage?.getItem(SNAP_MODEL_KEY) !== 'off',
    edges: {},
    picking: null,
    picks: [],
    sketchPicks: [],
    preview: [],
    version: 0,
    hover: null,
    curvePicks: [],
    pendingPick: null,
}));

export function setSnapModel(on: boolean): void {
    try {
        globalThis.localStorage?.setItem(SNAP_MODEL_KEY, on ? 'on' : 'off');
    } catch {
        // Private mode: the setting lasts for the session.
    }
    useSketchModel.setState({ snapModel: on });
}

export const edgesKey = (t: ModelTarget, meshKey: string | null): string => `${t.partId} ${t.steps} ${meshKey ?? ''} ${JSON.stringify(t.frame)}`;

/**
 * The model edges and vertices projected onto the sketch plane as sketch geometry for snapping (ids `model/...`),
 * or undefined while they load. Starts loading them on first use.
 */
export function modelSnapGeometry(target: ModelTarget | null, meshKey: string | null): SketchGeometry | undefined {
    if (!target || !useSketchModel.getState().snapModel) {
        return undefined;
    }
    const key = edgesKey(target, meshKey);
    const known = useSketchModel.getState().edges[key];
    if (known === undefined) {
        loadEdges(target, key);
        return undefined;
    }
    return typeof known === 'object' && 'curves' in known ? snapGeometryOf(known) : undefined;
}

function loadEdges(target: ModelTarget, key: string): void {
    useSketchModel.setState((s) => ({ edges: { ...s.edges, [key]: 'loading' } }));
    fetchModelSketch(target, { kind: 'edges' }).then(
        (model) => useSketchModel.setState((s) => ({ edges: { ...s.edges, [key]: model } })),
        (e: unknown) => useSketchModel.setState((s) => ({ edges: { ...s.edges, [key]: { error: e instanceof Error ? e.message : String(e) } } })),
    );
}

const snapMemo = new WeakMap<ModelSketch, SketchGeometry>();

/** Model curves and vertices as geometry to snap to: curves with shared end points, plus every vertex. */
export function snapGeometryOf(model: ModelSketch): SketchGeometry {
    let g = snapMemo.get(model);
    if (!g) {
        const made = addModelCurves({ points: [], curves: [], constraints: [] }, model.curves, { id: (kind, n) => `model/${kind}${n}` });
        const known = made.g.points.map((p) => [p.u, p.v]);
        const vertices = model.points
            .filter(([u, v]) => !known.some(([a, b]) => Math.abs(a - u) < 1e-9 && Math.abs(b - v) < 1e-9))
            .map(([u, v], i) => ({ id: `model/v${i + 1}`, u, v }));
        g = { points: [...made.g.points, ...vertices], curves: made.g.curves, constraints: [] };
        snapMemo.set(model, g);
    }
    return g;
}

const mergeMemo = new WeakMap<SketchGeometry, WeakMap<SketchGeometry, SketchGeometry>>();

/**
 * Joins the part's other sketches and the model into one geometry to snap to: the same object for the same two, so
 * what snapping works out from it is kept between pointer moves.
 */
export function mergeSnapGeometry(a: SketchGeometry | undefined, b: SketchGeometry | undefined): SketchGeometry | undefined {
    if (!a || !b) {
        return a ?? b;
    }
    let withA = mergeMemo.get(a);
    if (!withA) {
        withA = new WeakMap();
        mergeMemo.set(a, withA);
    }
    let merged = withA.get(b);
    if (!merged) {
        merged = { points: [...a.points, ...b.points], curves: [...a.curves, ...b.curves], constraints: [] };
        withA.set(b, merged);
    }
    return merged;
}

/** The curves of a kernel answer, keeping only the loops wanted for each picked face. */
export function chosenCurves(model: ModelSketch, loops: (face: number, loop: number) => boolean = () => true): TaggedCurve[] {
    return model.curves.filter((c) => c.face === undefined || c.loop === undefined || loops(c.face, c.loop));
}

export const pickKey = (p: Pick<ModelPick, 'kind' | 'index'>): string => `${p.kind}${p.index}`;

/** Point the frame of the open sketch would give, in the part frame (for pierce points). */
export function onPlane(f: PlaneFrame3, p: Pt): V3 {
    return [0, 1, 2].map((i) => f.origin[i] + f.u[i] * p[0] + f.v[i] * p[1]) as V3;
}

/** Where a straight 3D segment crosses the plane, in (u, v), or null when it does not (or lies in it). */
export function pierceSegment(f: PlaneFrame3, a: V3, b: V3): P2 | null {
    const n = f.n as V3;
    const ha = dot(sub(a, f.origin as V3), n);
    const hb = dot(sub(b, f.origin as V3), n);
    if (Math.abs(ha - hb) < 1e-12 || ha * hb > 0) {
        return null;
    }
    const t = ha / (ha - hb);
    const p: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const q = projectPoint(f, p);
    return [tidy(q[0]), tidy(q[1])];
}


const targetMemo = new WeakMap<Feature[], Map<string, ModelTarget>>();

/** The part and plane of the open sketch, for the kernel; null for a sketch that makes a new part. */
export function modelTarget(s: { partId: string | null; edit: { partId: string } | null; plane: SketchPlane; offset: number; context: Feature[] }): ModelTarget | null {
    const partId = s.edit?.partId ?? s.partId;
    if (!partId) {
        return null;
    }
    // One object per plane and history, so a key built from it stays the same between pointer moves.
    const key = `${partId} ${JSON.stringify(s.plane)} ${s.offset}`;
    let byPlane = targetMemo.get(s.context);
    if (!byPlane) {
        byPlane = new Map();
        targetMemo.set(s.context, byPlane);
    }
    let target = byPlane.get(key);
    if (!target) {
        const f = planeFrame(s.plane, s.offset, s.context);
        target = { partId, steps: s.context.length, frame: { origin: f.origin, u: f.u, v: f.v, n: f.n } };
        byPlane.set(key, target);
    }
    return target;
}

// ---- Model edges and vertices as references for dimensions and relations ----------------------------------

/** A model vertex or edge under the cursor, as seen on the sketch plane. */
export type ModelRef = ({ kind: 'point'; p: P2 } | { kind: 'curve'; curve: ModelCurve }) & {
    /** The other sketch step it belongs to; absent: the model. */
    from?: string;
};

/**
 * The model edges and vertices projected onto the sketch plane, loaded once per sketch target whatever the snapping
 * setting; null while they load (loading starts on first use).
 */
export function loadedModel(target: ModelTarget | null, meshKey: string | null): ModelSketch | null {
    if (!target) {
        return null;
    }
    const key = edgesKey(target, meshKey);
    const known = useSketchModel.getState().edges[key];
    if (known === undefined) {
        loadEdges(target, key);
        return null;
    }
    return typeof known === 'object' && 'curves' in known ? known : null;
}

/**
 * The model vertex or edge, or the point or curve of another sketch (`others`, ids `<step>/<id>`), within `tolerance`
 * of p: points first, then the nearest curve. Null when there is none.
 */
export function modelRefAt(model: ModelSketch | null, p: Pt, tolerance: number, others?: SketchGeometry): ModelRef | null {
    const g = mergeSnapGeometry(others, model ? snapGeometryOf(model) : undefined);
    if (!g) {
        return null;
    }
    const hit = pickAt(g, p, tolerance);
    if (!hit || hit.id === 'origin' || hit.id.startsWith('axis-')) {
        return null;
    }
    const from = hit.id.startsWith('model/') ? undefined : hit.id.split('/')[0];
    const tag = from ? { from } : {};
    if (hit.type === 'point') {
        const q = g.points.find((x) => x.id === hit.id)!;
        return { kind: 'point', p: [q.u, q.v], ...tag };
    }
    const c = g.curves.find((x) => x.id === hit.id)!;
    if (!from && model) {
        // The model's own curve, exact (snapGeometryOf numbers them c1, c2, ... in order).
        const n = Number(/^model\/c(\d+)$/.exec(c.id)?.[1]);
        return n ? { kind: 'curve', curve: model.curves[n - 1] } : null;
    }
    const at = (id: string): P2 | null => {
        const q = g.points.find((x) => x.id === id);
        return q ? [q.u, q.v] : null;
    };
    if (c.kind === 'line' && at(c.a) && at(c.b)) {
        return { kind: 'curve', curve: { kind: 'line', a: at(c.a)!, b: at(c.b)! }, ...tag };
    }
    if (c.kind === 'circle' && at(c.center)) {
        return { kind: 'curve', curve: { kind: 'circle', center: at(c.center)!, radius: c.radius }, ...tag };
    }
    if (c.kind === 'arc' && at(c.center) && at(c.start) && at(c.end)) {
        return { kind: 'curve', curve: { kind: 'arc', center: at(c.center)!, start: at(c.start)!, end: at(c.end)! }, ...tag };
    }
    return null;
}

const near = (a: SketchPoint | undefined, p: P2): boolean => !!a && Math.abs(a.u - p[0]) < 1e-9 && Math.abs(a.v - p[1]) < 1e-9;

/** Points of `g` locked as from the model. */
function modelLocked(g: SketchGeometry): Set<string> {
    return new Set(g.constraints.flatMap((c) => ((isModelLock(c) || sketchLockSource(c)) && c.kind === 'fix' ? [c.point] : [])));
}

/**
 * Brings a model vertex or edge into the sketch as a locked construction point, line, circle or arc at its exact
 * place (marked as from the model), or finds the one brought in before. Returns the geometry and what to pick.
 */
export function bringModelRef(g: SketchGeometry, ref: ModelRef, o: { reference?: boolean } = {}): { g: SketchGeometry; pick: { type: 'point' | 'curve'; id: string } } {
    const locked = modelLocked(g);
    const P = (id: string) => g.points.find((x) => x.id === id);
    if (ref.kind === 'point') {
        const old = g.points.find((x) => locked.has(x.id) && near(x, ref.p));
        if (old) {
            return { g, pick: { type: 'point', id: old.id } };
        }
        const used = new Set([...g.points.map((x) => x.id), ...g.curves.map((x) => x.id), ...g.constraints.map((c) => c.id)]);
        const fresh = (prefix: string, suffix = ''): string => {
            let n = 1;
            while (used.has(`${prefix}${n}${suffix}`)) {
                n++;
            }
            used.add(`${prefix}${n}${suffix}`);
            return `${prefix}${n}${suffix}`;
        };
        const id = fresh(o.reference ? 'pr' : 'pm');
        return {
            g: {
                ...g, points: [...g.points, { id, u: ref.p[0], v: ref.p[1] }],
                constraints: [...g.constraints, { id: ref.from ? fresh(SKETCH_LOCK, `@${ref.from}`) : fresh(MODEL_LOCK), kind: 'fix', point: id }],
            },
            pick: { type: 'point', id },
        };
    }
    const c = ref.curve;
    const same = g.curves.find((x) => {
        if (!x.construction) {
            return false;
        }
        if (c.kind === 'line' && x.kind === 'line') {
            return locked.has(x.a) && locked.has(x.b) && ((near(P(x.a), c.a) && near(P(x.b), c.b)) || (near(P(x.a), c.b) && near(P(x.b), c.a)));
        }
        if (c.kind === 'circle' && x.kind === 'circle') {
            return locked.has(x.center) && near(P(x.center), c.center) && Math.abs(x.radius - c.radius) < 1e-9;
        }
        if (c.kind === 'arc' && x.kind === 'arc') {
            return locked.has(x.center) && near(P(x.center), c.center) && near(P(x.start), c.start) && near(P(x.end), c.end);
        }
        return false;
    });
    if (same) {
        return { g, pick: { type: 'curve', id: same.id } };
    }
    const r = addModelCurves(g, [c], {
        construction: true, lock: true, ...(ref.from ? { lockFrom: ref.from } : {}), ...(o.reference ? { id: (kind, n) => `${kind}r${n}` } : {}),
    });
    return { g: r.g, pick: { type: 'curve', id: r.ids[0] } };
}

/**
 * The sketch without the model references (isModelReference) that nothing uses: no relation or dimension other than
 * their own locks, no curve of the sketch, and nothing in `keep` (what is selected or picked).
 */
export function withoutLooseReferences(g: SketchGeometry, keep: ReadonlySet<string> = new Set()): SketchGeometry {
    if (!g.curves.some((c) => isModelReference(c.id)) && !g.points.some((p) => isModelReference(p.id))) {
        return g;
    }
    const locks = new Set(g.constraints.filter((c) => (c.kind === 'fix' || c.kind === 'fixRadius') && (isModelLock(c) || sketchLockSource(c))).map((c) => c.id));
    const used = new Set<string>(keep);
    for (const c of g.constraints) {
        if (!locks.has(c.id)) {
            constraintRefs(c).forEach((id) => used.add(id));
        }
    }
    for (const c of g.curves) {
        if (!isModelReference(c.id)) {
            curvePointIds(c).forEach((id) => used.add(id));
        }
    }
    const drop = new Set(g.curves.filter((c) => isModelReference(c.id) && !used.has(c.id) && !curvePointIds(c).some((id) => used.has(id))).map((c) => c.id));
    const onKept = new Set(g.curves.filter((c) => !drop.has(c.id)).flatMap((c) => curvePointIds(c)));
    g.points.filter((p) => isModelReference(p.id) && !used.has(p.id) && !onKept.has(p.id)).forEach((p) => drop.add(p.id));
    if (!drop.size) {
        return g;
    }
    return {
        ...g,
        points: g.points.filter((p) => !drop.has(p.id)),
        curves: g.curves.filter((c) => !drop.has(c.id)),
        constraints: g.constraints.filter((c) => !constraintRefs(c).some((id) => drop.has(id))),
    };
}

/** A sketch curve copied in from the model back as the model curve it was made from (addModelCurves' inverse). */
export function modelCurveOf(g: SketchGeometry, c: SketchCurve): ModelCurve | null {
    const P = (id: string): P2 | null => {
        const q = g.points.find((x) => x.id === id);
        return q ? [q.u, q.v] : null;
    };
    switch (c.kind) {
        case 'line': {
            const [a, b] = [P(c.a), P(c.b)];
            return a && b ? { kind: 'line', a, b } : null;
        }
        case 'circle': {
            const centre = P(c.center);
            return centre ? { kind: 'circle', center: centre, radius: c.radius } : null;
        }
        case 'arc': {
            const [centre, start, end] = [P(c.center), P(c.start), P(c.end)];
            return centre && start && end ? { kind: 'arc', center: centre, start, end } : null;
        }
        case 'ellipse':
        case 'ellipseArc': {
            const [centre, major, minor] = [P(c.center), P(c.major), P(c.minor)];
            if (!centre || !major || !minor) {
                return null;
            }
            const b = Math.hypot(minor[0] - centre[0], minor[1] - centre[1]);
            if (c.kind === 'ellipse') {
                return { kind: 'ellipse', center: centre, major, minor: b };
            }
            const [start, end] = [P(c.start), P(c.end)];
            return start && end ? { kind: 'ellipseArc', center: centre, major, minor: b, start, end } : null;
        }
        case 'styleSpline': {
            const poles = c.points.map(P);
            if (poles.some((p) => !p) || c.knots || c.weights?.some((w) => w !== 1)) {
                return null;
            }
            const degree = styleDegree(c);
            return degree === poles.length - 1 ? { kind: 'bezier', poles: poles as P2[] } : { kind: 'bspline', poles: poles as P2[], degree: degree as 3 | 5 | 7 };
        }
        case 'conic': {
            const [start, apex, end] = [P(c.start), P(c.apex), P(c.end)];
            return start && apex && end ? { kind: 'conic', start, apex, end, rho: c.rho } : null;
        }
        default:
            return null;
    }
}

/** What is under the cursor of the model, as a preview entity to light up (dimension and relation tools). */
export function modelRefEntity(ref: ModelRef | null, size: number): NewEntity | null {
    return !ref ? null : ref.kind === 'point' ? { kind: 'circle', c: ref.p, r: size } : curveEntity(ref.curve);
}
