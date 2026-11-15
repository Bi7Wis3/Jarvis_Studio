// The spline tools in the open sketch (SolidWorks Spline Tools): what they show (curvature combs, inflection points,
// minimum radius, spline handles, control polygons) and its scale, the spline settings of Sketch settings, and the
// presses and drags in the view: handle circles, arrow heads and diamonds, curvature pointers, control polygon
// vertices, Add Tangency / Curvature Control, and the Proportional and Local edit drags. The sketcher calls the hooks
// here (splineDown, splineMove, splineUp, splineEscape) before its own handling.

import { create } from 'zustand';
import type { SketchGeometry } from '@jarvis/core';
import { curvatureSample, cubicPieces } from '@jarvis/core/splines';
import { curveOf, pointOf, solveGeometry, solverReady } from './solver';
import { closedSpline } from './sketchCurves';
import {
    activateHandle, curvatureAtPoint, handleEdit, handleInfo, handleValues, movePolygonVertex, nearestOnSpline, setCurvature, solvedSpline,
    splinePointIds, splinePolygon, splitSplineAt, type HandleInfo, type Spline,
} from './sketchSplines';
import { replaceGeometry, setTool, settleStatus, useSketcher } from './sketcher';
import { refreshOffsets } from './sketchCurveOffset';
import { buildEquation, equationEnds, nearestParam, rangeText } from './sketchEquation';
import { constantValue } from '@jarvis/core/expression';

type Pt = [number, number];

// ---- Spline settings (System Options > Sketch) -------------------------------------------------------------------

export interface SplineOptions {
    /** Enable spline tangency and curvature handles: a selected spline shows its handles to drag. */
    handles: boolean;
    /** Show spline control polygon by default. */
    polygon: boolean;
    /** Show curvature comb bounding curve: the line along the comb's tips. */
    bounding: boolean;
}

export const DEFAULT_SPLINE_OPTIONS: SplineOptions = { handles: true, polygon: false, bounding: true };
const OPTIONS_KEY = 'jarvis.sketch.splines';

function loadOptions(): SplineOptions {
    try {
        const raw = globalThis.localStorage?.getItem(OPTIONS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return { ...DEFAULT_SPLINE_OPTIONS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
        return { ...DEFAULT_SPLINE_OPTIONS };
    }
}

// ---- What the view shows -----------------------------------------------------------------------------------------

export type SplineDrag =
    /** A handle: its circle (end), arrow head (weight) or diamond (direction) on the side before or after the point. */
    | { kind: 'handle'; curve: string; index: number; side: 'before' | 'after'; grip: 'end' | 'weight' | 'direction' }
    /** The ball of a curvature pointer. */
    | { kind: 'ball'; curve: string; index: number }
    /** A control polygon vertex. */
    | { kind: 'vertex'; curve: string; index: number }
    /** An end point of a Proportional spline. */
    | { kind: 'proportional'; curve: string; point: string }
    /** A control vertex of a style spline with Local edit. */
    | { kind: 'local'; curve: string; point: string }
    /** An unlocked end of an equation driven curve, slid along the curve (its range changes). */
    | { kind: 'eqend'; curve: string; equation: string; side: 'from' | 'to' };

interface SplineViewState {
    options: SplineOptions;
    /** Curves showing curvature combs, inflection points, the minimum radius. */
    combs: string[];
    inflections: string[];
    minRadius: string[];
    /** Splines whose control polygon is shown or hidden against the default (Display control polygon). */
    polygonFlip: string[];
    /** Hide all spline handles (Show spline handles, off). */
    handlesHidden: boolean;
    /** Curvature Scale: comb length (percent of the default) and teeth along each curve. */
    scale: number;
    density: number;
    /** Add Tangency Control or Add Curvature Control waiting for a click on a spline, and where it would go. */
    adding: { kind: 'tangency' | 'curvature'; curve: string | null } | null;
    addHover: { curve: string; at: Pt; normal: Pt; curvature: number; tangent: Pt } | null;
    /** The spline point whose handle the Spline form edits (Spline point number), and the polygon vertex picked. */
    picked: { curve: string; index: number } | null;
    vertex: { curve: string; index: number } | null;
    /** The press being dragged, the sketch before it and where it was pressed. */
    drag: { what: SplineDrag; from: SketchGeometry; grab: Pt; moved: boolean } | null;
    /** Alt (or Shift) held: handle drags change both sides alike. */
    symmetric: boolean;
}

export const useSplineView = create<SplineViewState>(() => ({
    options: loadOptions(), combs: [], inflections: [], minRadius: [], polygonFlip: [], handlesHidden: false, scale: 100, density: 50,
    adding: null, addHover: null, picked: null, vertex: null, drag: null, symmetric: false,
}));

const view = () => useSplineView.getState();
const sk = () => useSketcher.getState();
const say = (message: string | null) => useSketcher.setState({ message });

export function setSplineOptions(patch: Partial<SplineOptions>): void {
    const options = { ...view().options, ...patch };
    useSplineView.setState({ options });
    try {
        globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
        // Storage can be full or blocked; the setting still holds for this visit.
    }
}

const toggled = (list: string[], ids: string[], on?: boolean): string[] => {
    const all = ids.every((id) => list.includes(id));
    const want = on ?? !all;
    return want ? [...new Set([...list, ...ids])] : list.filter((id) => !ids.includes(id));
};

/** Show Curvature Combs, Show Inflection Points, Show Minimum Radius: switched for these curves (on, off, or over). */
export function toggleShown(kind: 'combs' | 'inflections' | 'minRadius', ids: string[], on?: boolean): void {
    useSplineView.setState((s) => ({ [kind]: toggled(s[kind], ids, on) }) as Partial<SplineViewState>);
}

/** Display Control Polygon for these splines. */
export function togglePolygon(ids: string[]): void {
    const s = view();
    const shown = ids.every((id) => polygonShown(id));
    useSplineView.setState({ polygonFlip: ids.reduce((list, id) => (polygonShown(id) === !shown ? list : list.includes(id) ? list.filter((x) => x !== id) : [...list, id]), s.polygonFlip) });
}

export const polygonShown = (id: string): boolean => view().options.polygon !== view().polygonFlip.includes(id);

export function setCurvatureScale(scale: number, density: number): void {
    useSplineView.setState({ scale, density: Math.max(2, Math.round(density)) });
}

/** mm of comb per 1/mm of curvature: the Scale in percent of a length that suits the sketch's size. */
export function combFactor(g: SketchGeometry): number {
    let [lo, hi] = [[Infinity, Infinity], [-Infinity, -Infinity]];
    for (const p of g.points) {
        lo = [Math.min(lo[0], p.u), Math.min(lo[1], p.v)];
        hi = [Math.max(hi[0], p.u), Math.max(hi[1], p.v)];
    }
    const size = Number.isFinite(lo[0]) ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) : 100;
    // Rounded up to a power of ten, so the combs do not change size while the geometry is dragged a little.
    const base = 10 ** Math.ceil(Math.log10(Math.max(size, 1e-3)));
    return ((view().scale / 100) * base * base) / 40;
}

/** The splines whose handles are shown: those selected (or with a point selected) while handles are enabled. */
export function handleSplines(g: SketchGeometry): Spline[] {
    const s = view();
    if (!s.options.handles || s.handlesHidden) {
        return [];
    }
    const picked = new Set(sk().selection.map((x) => x.id));
    if (s.drag && 'curve' in s.drag.what) {
        picked.add(s.drag.what.curve);
    }
    if (s.picked) {
        picked.add(s.picked.curve);
    }
    return g.curves.filter((c): c is Spline => c.kind === 'spline' && (picked.has(c.id) || c.points.some((p) => picked.has(p))));
}

// ---- Handle glyphs ---------------------------------------------------------------------------------------------

/** Where a handle's grips are: the circle at the end of each side, the arrow head and the diamond along it. */
export function handleGrips(h: HandleInfo): { side: 'before' | 'after'; grip: 'end' | 'weight' | 'direction'; at: Pt }[] {
    const out: { side: 'before' | 'after'; grip: 'end' | 'weight' | 'direction'; at: Pt }[] = [];
    for (const [side, end] of [['after', h.next], ['before', h.prev]] as const) {
        if (!end) {
            continue;
        }
        const along = (f: number): Pt => [h.at[0] + (end[0] - h.at[0]) * f, h.at[1] + (end[1] - h.at[1]) * f];
        out.push({ side, grip: 'end', at: end }, { side, grip: 'weight', at: along(0.72) }, { side, grip: 'direction', at: along(0.42) });
    }
    return out;
}

/** The tip of a curvature pointer: off the point along the normal, away from the centre, as long as the comb's tooth. */
export function pointerTip(at: Pt, normal: Pt, curvature: number, factor: number): Pt {
    return [at[0] - normal[0] * curvature * factor, at[1] - normal[1] * curvature * factor];
}

/** The unit left normal of a spline at point i (from its handle direction now). */
function normalAt(h: HandleInfo): Pt {
    const a = handleValues(h).angle;
    return [-Math.sin(a), Math.cos(a)];
}

function gripAt(g: SketchGeometry, raw: Pt, tolerance: number): SplineDrag | null {
    const factor = combFactor(g);
    let best: { what: SplineDrag; d: number } | null = null;
    const consider = (what: SplineDrag, at: Pt, rank: number) => {
        const d = Math.hypot(at[0] - raw[0], at[1] - raw[1]) + rank * tolerance * 0.05;
        if (d < tolerance && (!best || d < best.d)) {
            best = { what, d };
        }
    };
    for (const c of handleSplines(g)) {
        const solved = solvedSpline(g, c);
        if (!solved) {
            continue;
        }
        splinePointIds(c).forEach((_, i) => {
            const h = handleInfo(g, c, i, solved);
            if (!h) {
                return;
            }
            handleGrips(h).forEach((grip, k) => consider({ kind: 'handle', curve: c.id, index: i, side: grip.side, grip: grip.grip }, grip.at, k % 3));
            if (h.curvature !== null) {
                consider({ kind: 'ball', curve: c.id, index: i }, pointerTip(h.at, normalAt(h), h.curvature, factor), 0);
            }
        });
    }
    const shownPolygons = g.curves.filter((c): c is Spline => c.kind === 'spline' && polygonShown(c.id));
    for (const c of shownPolygons) {
        const solved = solvedSpline(g, c);
        if (solved) {
            splinePolygon(solved).forEach((p, i) => consider({ kind: 'vertex', curve: c.id, index: i }, p, 4));
        }
    }
    return best ? (best as { what: SplineDrag }).what : null;
}

// ---- Hooks the sketcher calls ------------------------------------------------------------------------------------

const selectTool = () => sk().tool === 'select';

/** The spline (or style spline) end or vertex under the cursor that a Proportional or Local edit drag takes. */
function specialPointDrag(g: SketchGeometry, raw: Pt, tolerance: number): SplineDrag | null {
    let best: { what: SplineDrag; d: number } | null = null;
    for (const c of g.curves) {
        const ids = c.kind === 'spline' && c.proportional && !closedSpline(c) ? [c.points[0], c.points[c.points.length - 1]]
            : c.kind === 'styleSpline' && c.localEdit ? c.points : [];
        for (const id of ids) {
            const p = pointOf(g, id);
            const d = p ? Math.hypot(p.u - raw[0], p.v - raw[1]) : Infinity;
            if (p && !p.fixed && d < tolerance * 1.2 && (!best || d < best.d)) {
                best = { what: c.kind === 'spline' ? { kind: 'proportional', curve: c.id, point: id } : { kind: 'local', curve: c.id, point: id }, d };
            }
        }
    }
    for (const e of g.equations ?? []) {
        const ends = equationEnds(g, e);
        if (!ends) {
            continue;
        }
        for (const [side, id] of [['from', ends[0]], ['to', ends[1]]] as const) {
            const p = pointOf(g, id);
            const d = p ? Math.hypot(p.u - raw[0], p.v - raw[1]) : Infinity;
            const unlocked = side === 'from' ? e.lockFrom === false : e.lockTo === false;
            if (unlocked && d < tolerance * 1.2 && (!best || d < best.d)) {
                best = { what: { kind: 'eqend', curve: e.curves[0], equation: e.id, side }, d };
            }
        }
    }
    return best ? (best as { what: SplineDrag }).what : null;
}

/** Whether the last press was taken here (its click, if it makes one, is too). */
let tookPress = false;

/** The click that follows a press taken here: true, so the sketcher does not select with it. */
export function splineClick(): boolean {
    const took = tookPress;
    tookPress = false;
    return took;
}

/** Pointer pressed in the sketch: true when a spline tool takes the press (the view and the sketcher leave it). */
export function splineDown(raw: Pt, tolerance: number): boolean {
    tookPress = pressed(raw, tolerance);
    return tookPress;
}

function pressed(raw: Pt, tolerance: number): boolean {
    const s = sk();
    if (!s.active || s.stage !== 'draw') {
        return false;
    }
    const g = s.geometry;
    const adding = view().adding;
    if (adding) {
        placeControl(raw, tolerance);
        return true;
    }
    if (!selectTool()) {
        return false;
    }
    const what = gripAt(g, raw, tolerance) ?? specialPointDrag(g, raw, tolerance);
    if (!what) {
        return false;
    }
    if (what.kind === 'vertex') {
        useSplineView.setState({ vertex: { curve: what.curve, index: what.index } });
    }
    if (what.kind === 'handle' || what.kind === 'ball') {
        useSplineView.setState({ picked: { curve: what.curve, index: what.index } });
    }
    useSplineView.setState({ drag: { what, from: g, grab: raw, moved: false } });
    return true;
}

/** Pointer moved: true when a spline tool takes the move. */
export function splineMove(raw: Pt, tolerance: number): boolean {
    const s = view();
    if (s.adding) {
        useSplineView.setState({ addHover: hoverFor(sk().geometry, raw, tolerance, s.adding.curve) });
        useSketcher.setState({ cursor: raw });
        return true;
    }
    const drag = s.drag;
    if (!drag) {
        return false;
    }
    if (!drag.moved && Math.hypot(raw[0] - drag.grab[0], raw[1] - drag.grab[1]) <= tolerance * 0.4) {
        return true;
    }
    if (!solverReady()) {
        return true;
    }
    const next = dragged(drag.from, drag.what, raw);
    if (typeof next === 'string') {
        say(next);
    } else if (next) {
        // Offsets of what is dragged follow it (quickly while dragging; exactly on release).
        useSketcher.setState({ geometry: refreshOffsets(next.geometry, true), dof: next.dof, cursor: raw, message: null });
    }
    if (!drag.moved) {
        useSplineView.setState({ drag: { ...drag, moved: true } });
    }
    return true;
}

/** Pointer released: true when a spline tool had the press. */
export function splineUp(): boolean {
    const drag = view().drag;
    if (!drag) {
        return false;
    }
    useSplineView.setState({ drag: null });
    const s = sk();
    if (drag.moved && s.geometry !== drag.from) {
        // One undo step for the whole drag; the status from a full solve, not the drag's.
        useSketcher.setState({ geometry: refreshOffsets(s.geometry), undo: [...s.undo.slice(-80), drag.from], redo: [] });
        settleStatus();
    } else if (!drag.moved && (drag.what.kind === 'handle' || drag.what.kind === 'ball' || drag.what.kind === 'vertex')) {
        // A click on a grip picks its spline (and point) for the form.
        useSketcher.setState({ selection: [{ type: 'curve', id: drag.what.curve }] });
        openForm(drag.what.kind === 'vertex' ? 'sk-spline-polygon' : 'sk-pm-spline');
    }
    return true;
}

/** Esc: stops Add Tangency / Curvature Control; true when it did. */
export function splineEscape(): boolean {
    if (view().adding) {
        useSplineView.setState({ adding: null, addHover: null });
        say(null);
        return true;
    }
    return false;
}

function openForm(id: string): void {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: id })), 0);
    }
}

if (typeof window !== 'undefined') {
    const keys = (e: KeyboardEvent) => {
        const on = e.altKey || e.shiftKey;
        if (on !== view().symmetric) {
            useSplineView.setState({ symmetric: on });
        }
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('keyup', keys);
    window.addEventListener('blur', () => useSplineView.setState({ symmetric: false }));
}

/** Solves `g` with points pulled to targets (as the sketcher's drag does), others held where possible. */
export function solveWithTargets(g: SketchGeometry, targets: { point: string; u: number; v: number }[], hold?: ReadonlySet<string>):
    { geometry: SketchGeometry; dof: number; miss: number } | null {
    const moving = new Set(targets.map((t) => t.point));
    const others = g.points.filter((p) => !moving.has(p.id)).map((p) => p.id);
    let best: { geometry: SketchGeometry; dof: number; miss: number } | null = null;
    for (const held of [new Set([...others]), hold]) {
        const r = solveGeometry(g, { targets, ...(held ? { hold: held } : {}) });
        if (!r.ok) {
            continue;
        }
        const miss = Math.max(0, ...targets.map((t) => {
            const p = pointOf(r.geometry, t.point);
            return p ? Math.hypot(p.u - t.u, p.v - t.v) : 0;
        }));
        if (!best || miss < best.miss - 1e-9) {
            best = { geometry: r.geometry, dof: r.dof, miss };
        }
        if (miss < 1e-6) {
            break;
        }
    }
    return best;
}

/** The sketch with the drag applied (from the sketch as it was at the press). */
function dragged(from: SketchGeometry, what: SplineDrag, raw: Pt): { geometry: SketchGeometry; dof: number } | string | null {
    const c = curveOf(from, what.curve);
    if (what.kind === 'local') {
        if (c?.kind !== 'styleSpline') {
            return null;
        }
        // Local edit: the style splines joined to this one stay as they are.
        const others = new Set(from.curves.filter((k) => k.kind === 'styleSpline' && k.id !== c.id).flatMap((k) => (k.kind === 'styleSpline' ? k.points : [])));
        others.delete(what.point);
        return solveWithTargets(from, [{ point: what.point, u: raw[0], v: raw[1] }], others);
    }
    if (what.kind === 'eqend') {
        // The end slides along the curve: the range changes and the curve is built again over it.
        const e = from.equations?.find((x) => x.id === what.equation);
        const s = e ? nearestParam(e, raw) : null;
        const [lo, hi] = e ? [constantValue(e.from), constantValue(e.to)] : [null, null];
        if (!e || s === null || lo === null || hi === null || (what.side === 'from' ? !(s < hi - 1e-9) : !(s > lo + 1e-9))) {
            return null;
        }
        const built = buildEquation(from, { ...e, [what.side]: rangeText(s) });
        return typeof built === 'string' ? built : solveWithTargets(built.g, []);
    }
    if (c?.kind !== 'spline') {
        return null;
    }
    if (what.kind === 'proportional') {
        // The other end stays; the whole spline turns and scales with the dragged end.
        const ends = [c.points[0], c.points[c.points.length - 1]];
        const fixed = ends.find((id) => id !== what.point)!;
        const [a, b] = [pointOf(from, fixed), pointOf(from, what.point)];
        if (!a || !b) {
            return null;
        }
        const [ox, oy] = [b.u - a.u, b.v - a.v];
        const [nx, ny] = [raw[0] - a.u, raw[1] - a.v];
        const l2 = ox * ox + oy * oy || 1;
        const [cs, sn] = [(ox * nx + oy * ny) / l2, (ox * ny - oy * nx) / l2];
        const ids = [...new Set([...c.points, c.startHandle, c.endHandle, ...(c.handles ?? []).map((h) => h.handle)].filter((p): p is string => !!p && p !== fixed))];
        const targets = ids.flatMap((id) => {
            const p = pointOf(from, id);
            if (!p) {
                return [];
            }
            const [x, y] = [p.u - a.u, p.v - a.v];
            return [{ point: id, u: a.u + cs * x - sn * y, v: a.v + sn * x + cs * y }];
        });
        return solveWithTargets(from, targets);
    }
    if (what.kind === 'vertex') {
        const r = movePolygonVertex(from, c, what.index, raw);
        return 'error' in r ? r.error : solveWithTargets(r.g, r.targets);
    }
    const h = handleInfo(from, c, what.index);
    if (!h) {
        return null;
    }
    if (what.kind === 'ball') {
        // Along the pointer: the curvature is how far the ball is from the point, over the comb's scale.
        const n = normalAt(h);
        const k = -((raw[0] - h.at[0]) * n[0] + (raw[1] - h.at[1]) * n[1]) / combFactor(from);
        const r = setCurvature(from, c, what.index, k);
        return solveWithTargets(r.g, []);
    }
    const now = handleValues(h);
    const sideLength = what.side === 'after' ? now.after : now.before;
    const d: Pt = [raw[0] - h.at[0], raw[1] - h.at[1]];
    const outward = what.side === 'after' ? d : [-d[0], -d[1]] as Pt;
    const values: { angle?: number; before?: number; after?: number } = {};
    if (what.grip === 'end' || what.grip === 'direction') {
        values.angle = Math.atan2(outward[1], outward[0]);
    }
    if (what.grip === 'end' || what.grip === 'weight') {
        const u: Pt = [Math.cos(now.angle), Math.sin(now.angle)];
        // The arrow head slides along the handle; the circle goes where the pointer is.
        const grabbed = what.grip === 'weight' ? 0.72 : 1;
        const along = what.grip === 'weight' ? (outward[0] * u[0] + outward[1] * u[1]) : Math.hypot(d[0], d[1]);
        const length = Math.max(1e-6, along / grabbed);
        const ratio = sideLength ? length / sideLength : 1;
        values[what.side] = length;
        if (view().symmetric) {
            // Alt: both sides alike.
            const other = what.side === 'after' ? 'before' : 'after';
            const was = other === 'after' ? now.after : now.before;
            if (was !== null) {
                values[other] = was * ratio;
            }
        }
    }
    const r = handleEdit(from, c, what.index, values);
    if ('error' in r) {
        return r.error;
    }
    return solveWithTargets(r.g, r.targets);
}

// ---- Add Tangency Control, Add Curvature Control ------------------------------------------------------------------

/** Starts Add Tangency Control or Add Curvature Control: the next click on a spline (this one, if given) places it. */
export function startAddControl(kind: 'tangency' | 'curvature', curve: string | null = null): void {
    const g = sk().geometry;
    if (!g.curves.some((c) => c.kind === 'spline' && (!curve || c.id === curve))) {
        say('Draw a spline first: tangency and curvature controls go on splines through points.');
        return;
    }
    setTool('select');
    useSplineView.setState({ adding: { kind, curve }, addHover: null });
    say(kind === 'tangency'
        ? 'Move along the spline and click where the tangency handle goes · Esc stops'
        : 'Move along the spline and click where the curvature control goes (the pointer flips side at an inflection) · Esc stops');
}

function hoverFor(g: SketchGeometry, raw: Pt, tolerance: number, only: string | null): SplineViewState['addHover'] {
    let best: { curve: string; d: number; at: Pt; piece: number; t: number; solved: NonNullable<ReturnType<typeof solvedSpline>> } | null = null;
    for (const c of g.curves) {
        if (c.kind !== 'spline' || (only && c.id !== only)) {
            continue;
        }
        const solved = solvedSpline(g, c);
        if (!solved) {
            continue;
        }
        const near = nearestOnSpline(solved, raw);
        if (near.d < tolerance * 3 && (!best || near.d < best.d)) {
            best = { curve: c.id, d: near.d, at: near.at, piece: near.piece, t: near.t, solved };
        }
    }
    if (!best) {
        return null;
    }
    const b = best as NonNullable<typeof best>;
    const s = curvatureSample(cubicPieces(b.solved.poles), b.piece, b.t);
    return { curve: b.curve, at: s.at as Pt, normal: s.normal as Pt, curvature: s.curvature, tangent: [s.normal[1], -s.normal[0]] };
}

function placeControl(raw: Pt, tolerance: number): void {
    const s = view();
    const g = sk().geometry;
    const hover = hoverFor(g, raw, tolerance, s.adding!.curve);
    if (!hover) {
        say('Click on the spline.');
        return;
    }
    const c = curveOf(g, hover.curve) as Spline;
    const r = splitSplineAt(g, c, hover.at, s.adding!.kind === 'tangency' ? { handle: true } : { curvature: true });
    useSplineView.setState({ adding: null, addHover: null });
    if ('error' in r) {
        say(r.error);
        return;
    }
    const error = replaceGeometry(r.g);
    if (error) {
        say(error);
        return;
    }
    useSplineView.setState({ picked: { curve: c.id, index: r.index } });
    useSketcher.setState({ selection: [{ type: 'curve', id: c.id }], message: s.adding!.kind === 'tangency'
        ? 'Tangency handle added: drag its circles (weight and direction), arrow heads (weight) or diamonds (direction); Alt or Shift for both sides.'
        : 'Curvature control added: drag the ball along its pointer to set the radius of curvature.' });
    openForm('sk-pm-spline');
}

/** Activates the handle at a spline point (Tangent driving), committed. */
export function driveHandle(curve: string, index: number): string | null {
    const g = sk().geometry;
    const c = curveOf(g, curve);
    if (c?.kind !== 'spline') {
        return 'Select a spline.';
    }
    return replaceGeometry(activateHandle(g, c, index).g);
}

/** The curvature on each side of a spline point now, for the form. */
export function pointCurvature(g: SketchGeometry, c: Spline, index: number): { before: number | null; after: number | null } | null {
    const solved = solvedSpline(g, c);
    return solved ? curvatureAtPoint(solved, index) : null;
}
