// Sketcher state: the plane and the constrained sketch geometry (points, curves, constraints, dimensions),
// solved by PlaneGCS on every change. Local to this browser; nothing reaches the server until the sketch is
// finished and saved as a sketch step (or a feature / new part).

import { create } from 'zustand';
import type {
    ExtrudeDirection, ExtrudeEnd, ExtrudeSide, Feature, Sketch, SketchConstraint, SketchGeometry, SketchPlane, SketchProfile,
} from '@jarvis/core';
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { useStudio } from './state';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, isDimension, loadSolver, measure, pointOf, solveGeometry, solverReady } from './solver';
import { regionsOf } from './regionPick';
import {
    EMPTY_GEOMETRY, PICKS_NEEDED, addArc, addCircle, addConstraint, addLine, addPerimeterCircle, addPolygon, addRect, addRect3, addSlot, addTangentArc,
    relationsFromPicks, tangentAt,
    curveAt, dimensionFromPicks, evaluate, geometryEntities, geometryProfiles, pickAt, placePoint, profilesToGeometry, removeItemsKeepingPoints,
    toggleConstruction, type ConstraintTool, type NewConstraint, type Pick, type PointRef,
} from './sketchGeometry';
import {
    addCentreArc, addCentreRect, chamferCorner, circularPattern, cornerOf, curvePoints, extendAt, filletCorner, linearPattern, mirrorCurves, offsetChain,
    offsetPreview, sideDistance, transformEntities, transformPoint, trimAt, type Transform,
} from './sketchEdit';
import { fixAll, fixProblem, fullyDefine, mergePoints, type Problem } from './sketchRepair';
import { dist, mid, planeForFace, planeFrame, round, type NewEntity, type Pt } from './sketchMath';
import { snapCursor, type QuickSnap, type Snap, type SnapKind } from './snapping';

export type { SnapKind } from './snapping';

void loadSolver(wasmUrl);

/** What the finish popup offers first: the operation the sketch was started for. */
export type SketchIntent = 'extrude' | 'cut' | 'revolve' | 'sketch';

export type DrawTool = 'line' | 'centerline' | 'point' | 'rect' | 'centerRect' | 'circle' | 'arc' | 'centerArc' | 'slot' | 'polygon'
    | 'tangentArc' | 'perimeterCircle' | 'rect3';
/** Tools that change existing geometry. */
export type EditTool = 'trim' | 'extend' | 'fillet' | 'chamfer' | 'offset' | 'mirror';
/** xform: picking points for Move, Copy, Rotate or Scale while their form is open. */
export type SketchTool = 'select' | DrawTool | EditTool | 'dimension' | 'xform' | `c:${ConstraintTool}`;

export type TransformKind = 'move' | 'copy' | 'rotate' | 'scale';

const EDIT_TOOLS: readonly string[] = ['trim', 'extend', 'fillet', 'chamfer', 'offset', 'mirror'];
export const isEditTool = (tool: SketchTool): tool is EditTool => EDIT_TOOLS.includes(tool);

/** The operation chosen in the finish popup; drives the live preview. */
export interface FinishOp {
    op: 'extrude' | 'revolve';
    /** sketch: keep it as a sketch step of the part, for later features to use. */
    mode: 'new' | 'add' | 'cut' | 'sketch';
    distance: number;
    direction: ExtrudeDirection;
    through: boolean;
    axis: 'u' | 'v';
    angle: number;
    /** Extrude options beyond distance and direction (see the extrude feature); absent: the defaults. */
    end?: ExtrudeEnd;
    from?: number;
    draft?: number;
    draftOutward?: boolean;
    flipSide?: boolean;
    second?: ExtrudeSide | null;
}

export type Selected = { type: 'point' | 'curve' | 'constraint'; id: string };

/** A dimension being placed or edited: its value input sits at `at`. */
export interface DimDraft {
    constraint: NewConstraint;
    at: Pt;
    text: string;
    /** The id of the dimension being edited, or null for a new one. */
    editing: string | null;
    error: string | null;
}

interface SketcherState {
    active: boolean;
    /** plane: choosing where to sketch; draw: drawing on it. */
    stage: 'plane' | 'draw';
    /** Part the sketch belongs to; null makes a new part on finish. */
    partId: string | null;
    plane: SketchPlane;
    offset: number;
    tool: SketchTool;
    geometry: SketchGeometry;
    /** Solver state of `geometry`: degrees of freedom (-1 unknown) and the last problem, if any. */
    dof: number;
    message: string | null;
    conflicting: string[];
    /** Relations and dimensions that repeat what others already hold: the sketch is over defined. */
    redundant: string[];
    /** Points placed so far for the entity in progress. */
    draft: PointRef[];
    /** Centre-point arc: the angle swept from the start toward the cursor so far (radians, + counter-clockwise). */
    arcSweep: number;
    /** Edit tools: what a click would change (trim: the piece that goes; extend and offset: what is added). */
    editPreview: NewEntity[];
    /** Edit tools: a short note at the cursor (the fillet radius, the offset distance). */
    editText: string | null;
    /** Offset: the curve whose chain is being offset, waiting for the distance. */
    offsetCurve: string | null;
    /** Mirror: the curves are picked and the next click picks the line to mirror about. */
    mirrorAbout: boolean;
    /** The last fillet radius and chamfer distance, used until another is typed. */
    filletRadius: number;
    chamferDistance: number;
    /** First point of the current line chain, to close it on. */
    chainStart: string | null;
    cursor: Pt | null;
    snapKind: SnapKind;
    snapRef: PointRef | null;
    /** Points the cursor is aligned with, drawn as guides. */
    snapGuides: Pt[];
    /** Midpoints of the lines under the cursor, drawn as targets. */
    snapHints: Pt[];
    selection: Selected[];
    /** Geometry picked for the dimension or constraint tool. */
    picks: Pick[];
    /** What a click would pick, for the dimension and constraint tools. */
    hover: Pick | null;
    /** Dimension tool: pressed on geometry and dragging the new dimension out to where it goes. */
    dimDrag: { picks: Pick[]; from: Pt; slop: number } | null;
    dimDraft: DimDraft | null;
    /** Where each dimension's label sits (sketch coordinates), when the user placed it. */
    labels: Record<string, Pt>;
    /** The sketch as it was when the drag started, for undo. */
    dragFrom: SketchGeometry | null;
    /** Select tool: the points being dragged, where each started, and where the pointer grabbed them. */
    drag: { points: { id: string; from: Pt }[]; grab: Pt } | null;
    grid: number;
    snap: boolean;
    sides: number;
    /** Dimension typed while drawing, applied with Enter. */
    typed: string;
    intent: SketchIntent;
    /** The history item being edited, when the sketch came from one. */
    edit: { partId: string; featureId: string | null } | null;
    /** Operation popup open, with its current values for the preview. */
    finishing: FinishOp | null;
    /** Bumped to turn the camera to face the plane. */
    look: number;
    /** The part's steps before this sketch, which construction-plane references resolve against. */
    context: Feature[];
    /** A standing note about the plane, e.g. that it is the tangent plane of a curved face. */
    notice: string | null;
    /** Where on the plane the user clicked to pick it (sketch coordinates); the camera centres there. */
    anchor: Pt;
    /** The last look request frames the sketch's geometry rather than the part. */
    fitToSketch: boolean;
    undo: SketchGeometry[];
    redo: SketchGeometry[];
    /** Geometry to light up from outside the view (the relations and repair lists, on hover). */
    highlight: string[];
    /** Quick snaps: the kinds switched off are false. Kept in localStorage. */
    snapKinds: Partial<Record<QuickSnap, boolean>>;
    /** Move, copy, rotate, scale: which form is open and the points picked in the view for it so far. */
    xform: { kind: TransformKind; picks: Pt[] } | null;
    /** Part workspace: draw the other parts as faint ghosts (else hide them). */
    showOthers: boolean;
    /** Draw the active part's sketch steps as thin curves (an override over the per-sketch eye). */
    showSketches: boolean;
    /** A sketch step clicked in the viewport, for the tools that use one (n makes repeats distinct). */
    picked: { id: string; n: number } | null;
}

const IDLE = {
    active: false,
    stage: 'plane' as const,
    partId: null,
    plane: 'top' as SketchPlane,
    offset: 0,
    tool: 'line' as SketchTool,
    geometry: EMPTY_GEOMETRY,
    dof: -1,
    message: null,
    notice: null,
    context: [],
    conflicting: [],
    redundant: [],
    draft: [],
    arcSweep: 0,
    editPreview: [],
    editText: null,
    offsetCurve: null,
    mirrorAbout: false,
    chainStart: null,
    cursor: null,
    snapKind: null,
    snapRef: null,
    snapGuides: [],
    snapHints: [],
    selection: [],
    picks: [],
    hover: null,
    dimDrag: null,
    dimDraft: null,
    labels: {},
    drag: null,
    dragFrom: null,
    typed: '',
    intent: 'extrude' as const,
    edit: null,
    finishing: null,
    undo: [],
    redo: [],
    highlight: [],
    xform: null,
};

const SNAPS_KEY = 'jarvis.sketch.snaps';

function loadSnapKinds(): Partial<Record<QuickSnap, boolean>> {
    try {
        const raw = globalThis.localStorage?.getItem(SNAPS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export const useSketcher = create<SketcherState>(() => ({
    ...IDLE,
    grid: 1,
    snap: true,
    sides: 6,
    filletRadius: 5,
    chamferDistance: 2,
    look: 0,
    showOthers: true,
    showSketches: true,
    picked: null,
    fitToSketch: false,
    anchor: [0, 0],
    snapKinds: loadSnapKinds(),
}));

/** Frames the sketch, looking straight at its plane (F while sketching). */
export function fitSketch(): void {
    set((s) => ({ look: s.look + 1, fitToSketch: true }));
}

export function pickSketch(id: string): void {
    useSketcher.setState((s) => ({ picked: { id, n: (s.picked?.n ?? 0) + 1 } }));
}

const get = () => useSketcher.getState();
const set = (patch: Partial<SketcherState> | ((s: SketcherState) => Partial<SketcherState>)) => useSketcher.setState(patch);

// ---- Solving ------------------------------------------------------------------------------------------

/**
 * Solves `next` and makes it the sketch. A conflict (over-constrained) is not applied: the sketch stays as it
 * was, the message says why and the conflicting constraints are flagged.
 */
function commit(next: SketchGeometry, patch: Partial<SketcherState> = {}, message?: string): boolean {
    const s = get();
    if (!solverReady()) {
        set({ ...patch, geometry: next, undo: [...s.undo.slice(-80), s.geometry], redo: [], dof: -1, message: null, conflicting: [], redundant: [] });
        return true;
    }
    const result = solveGeometry(next);
    if (!result.ok) {
        const names = result.conflicting.map((id) => describe(next, id)).filter(Boolean);
        set({
            message: message ?? `Over-constrained${names.length ? `: conflicts with ${names.join(', ')}` : ''}. Not applied.`,
            conflicting: result.conflicting,
        });
        return false;
    }
    set({
        ...patch, geometry: result.geometry, undo: [...s.undo.slice(-80), s.geometry], redo: [], dof: result.dof, conflicting: [],
        redundant: result.redundant, message: overDefinedMessage(next, result.redundant, s.redundant),
    });
    return true;
}

/** What the status line says when a change left relations that repeat others (SolidWorks: over defined). */
function overDefinedMessage(g: SketchGeometry, redundant: string[], before: string[] = []): string | null {
    const added = redundant.filter((id) => !before.includes(id));
    if (!added.length) {
        return null;
    }
    const names = [...new Set(added.map((id) => describe(g, id)).filter(Boolean))];
    return `Over defined: ${names.join(', ')} ${added.length === 1 ? 'repeats' : 'repeat'} what other relations already hold. Delete one of the yellow relations.`;
}

/** Re-solves the current sketch (after loading, or a solver that was not ready yet). */
function resolve(): void {
    const s = get();
    if (!solverReady()) {
        void loadSolver(wasmUrl).then(resolve);
        return;
    }
    const result = solveGeometry(s.geometry);
    set(result.ok
        ? { geometry: result.geometry, dof: result.dof, message: overDefinedMessage(result.geometry, result.redundant), conflicting: [], redundant: result.redundant }
        : { dof: result.dof, conflicting: result.conflicting, redundant: result.redundant, message: 'The sketch is over-constrained; delete one of the red constraints.' });
}

/** A short human name of a constraint, for messages. */
export function describe(g: SketchGeometry, id: string): string {
    const c = g.constraints.find((k) => k.id === id);
    if (!c) {
        return '';
    }
    if (isDimension(c)) {
        const unit = c.kind === 'angle' ? '°' : ' mm';
        const label = c.kind === 'diameter' ? 'Ø' : c.kind === 'radius' ? 'R' : c.kind === 'angle' ? 'angle ' : '';
        return `${label}${round(c.value, 0.01)}${unit}`;
    }
    return c.kind.replace(/Points$/, '').replace(/([A-Z])/g, ' $1').toLowerCase();
}

// ---- Session ------------------------------------------------------------------------------------------

/** Starts a sketch on `partId` (null: a new part). The plane is picked next, unless `sketch` is given to edit. */
export function startSketch(partId: string | null, intent: SketchIntent = 'extrude',
    edit: { partId: string; featureId: string | null; sketch: Sketch } | null = null): void {
    const geometry = edit ? edit.sketch.geometry ?? profilesToGeometry(edit.sketch.profiles) : EMPTY_GEOMETRY;
    // Plane references resolve against the steps before the sketch (all of them for a new sketch).
    const owner = partId ? useStudio.getState().history?.parts.find((p) => p.id === partId) : null;
    const features = owner?.features ?? [];
    const at = edit?.featureId ? features.findIndex((f) => f.id === edit.featureId) : -1;
    const context = at >= 0 ? features.slice(0, at) : features;
    set({
        ...IDLE,
        active: true,
        partId,
        intent,
        stage: edit ? 'draw' : 'plane',
        plane: edit?.sketch.plane ?? 'top',
        offset: edit?.sketch.offset ?? 0,
        geometry,
        labels: Object.fromEntries(geometry.constraints.flatMap((c) => (isDimension(c) && c.at ? [[c.id, c.at]] : []))),
        edit: edit ? { partId: edit.partId, featureId: edit.featureId } : null,
        tool: edit ? 'select' : 'line',
        look: get().look + (edit ? 1 : 0),
        fitToSketch: !!edit,
        context,
    });
    useStudio.setState({ mode: 'sketch' });
    resolve();
}

export function choosePlane(plane: SketchPlane, offset = 0, notice: string | null = null, anchor: Pt = [0, 0]): void {
    set((s) => ({ plane, offset: round(offset, 0.01), stage: 'draw', tool: 'line', look: s.look + 1, fitToSketch: false, notice, anchor }));
}

/** Sketch on the planar face under the cursor: its axis-aligned plane and offset, in the part frame. */
export function chooseFace(normal: [number, number, number], point: [number, number, number], curved = false): void {
    const { plane, offset } = planeForFace(normal, point, curved);
    const f = planeFrame(plane, offset, get().context);
    const rel = [0, 1, 2].map((i) => point[i] - f.origin[i]);
    const anchor: Pt = [round(rel[0] * f.u[0] + rel[1] * f.u[1] + rel[2] * f.u[2], 0.01), round(rel[0] * f.v[0] + rel[1] * f.v[1] + rel[2] * f.v[2], 0.01)];
    choosePlane(plane, offset, curved ? 'Sketching on the tangent plane of a curved face.' : null, anchor);
}

export function closeSketch(): void {
    set({ ...IDLE });
    useStudio.setState({ mode: 'select' });
}

export function setTool(tool: SketchTool): void {
    // Mirror starts from the curves already selected.
    const picks = tool === 'mirror' ? get().selection.filter((x): x is Pick => x.type === 'curve') : [];
    set({
        tool, draft: [], chainStart: null, typed: '', picks, hover: null, dimDrag: null, dimDraft: null, message: null,
        editPreview: [], editText: null, offsetCurve: null, mirrorAbout: false, arcSweep: 0, ...(tool === 'xform' ? {} : { xform: null }),
    });
}

export function undoSketch(): void {
    set((s) => (s.undo.length
        ? {
            geometry: s.undo[s.undo.length - 1], undo: s.undo.slice(0, -1), redo: [...s.redo, s.geometry],
            draft: [], chainStart: null, selection: [], picks: [], dimDraft: null, editPreview: [], offsetCurve: null, mirrorAbout: false,
        }
        : {}));
    resolve();
}

export function redoSketch(): void {
    set((s) => (s.redo.length
        ? {
            geometry: s.redo[s.redo.length - 1], redo: s.redo.slice(0, -1), undo: [...s.undo, s.geometry],
            draft: [], chainStart: null, selection: [], picks: [], dimDraft: null, editPreview: [], offsetCurve: null, mirrorAbout: false,
        }
        : {}));
    resolve();
}

export function deleteSelected(): void {
    const { selection, geometry } = get();
    if (selection.length) {
        commit(removeItemsKeepingPoints(geometry, selection.map((s) => s.id)), { selection: [] });
    }
}

export function toggleConstructionSelected(): void {
    const { selection, geometry } = get();
    const curves = selection.filter((s) => s.type === 'curve').map((s) => s.id);
    if (curves.length) {
        commit(toggleConstruction(geometry, curves));
    } else {
        set({ message: 'Select lines, arcs or circles to turn into construction geometry.' });
    }
}

// ---- Snapping -----------------------------------------------------------------------------------------

function snapAt(raw: Pt, tolerance: number): Snap {
    const s = get();
    return snapCursor(s.geometry, raw, { enabled: s.snap, grid: s.grid, tolerance, last: s.draft[s.draft.length - 1]?.at, kinds: s.snapKinds });
}

// ---- Pointer input ------------------------------------------------------------------------------------

/** Pointer moved to raw sketch point `raw`; `tolerance` is a few pixels in mm. */
export function sketchMove(raw: Pt, tolerance: number): void {
    const s = get();
    if (s.drag) {
        if (solverReady()) {
            const result = dragTo(s.geometry, s.drag, raw);
            if (result) {
                set({ geometry: result.geometry, dof: result.dof, cursor: raw });
            }
        }
        return;
    }
    if (isEditTool(s.tool)) {
        set({ cursor: raw, snapKind: null, snapRef: { at: raw }, snapGuides: [], snapHints: [], ...editHover(s, raw, tolerance) });
        return;
    }
    const picking = s.tool === 'dimension' || s.tool.startsWith('c:');
    const snapped = s.tool === 'select' || picking
        ? { p: raw, kind: null, ref: { at: raw }, guides: [], hints: [] }
        : snapAt(raw, tolerance);
    const hover = !picking || s.dimDrag || s.dimDraft ? null
        : s.tool === 'dimension' ? dimensionPick(s.geometry, raw, tolerance) : pickAt(s.geometry, raw, tolerance);
    set({ cursor: snapped.p, snapKind: snapped.kind, snapRef: snapped.ref, snapGuides: snapped.guides, snapHints: snapped.hints, hover });
    if (s.tool === 'xform') {
        set({ editPreview: xformPreview(s, snapped.p) });
    }
    if (s.tool === 'centerArc' && s.draft.length === 2) {
        // Follow the cursor round from the start, so the arc can go either way and past half a turn.
        const [c, start] = s.draft.map((d) => d.at);
        const before = Math.atan2(start[1] - c[1], start[0] - c[0]) + s.arcSweep;
        const now = Math.atan2(snapped.p[1] - c[1], snapped.p[0] - c[0]);
        set({ arcSweep: s.arcSweep + Math.atan2(Math.sin(now - before), Math.cos(now - before)) });
    }
}

/**
 * Moves the dragged points with the pointer, disturbing as little as possible: first with every other point held
 * still, then with only the ends of the attached curves let go (a rectangle's corner takes its two sides along),
 * and only if neither can follow the pointer is the whole sketch free to move.
 */
function dragTo(g: SketchGeometry, drag: NonNullable<SketcherState['drag']>, raw: Pt): { geometry: SketchGeometry; dof: number } | null {
    const delta: Pt = [raw[0] - drag.grab[0], raw[1] - drag.grab[1]];
    const targets = drag.points.map(({ id, from }) => ({ point: id, u: from[0] + delta[0], v: from[1] + delta[1] }));
    const dragged = new Set(drag.points.map((p) => p.id));
    const attached = new Set(g.curves.flatMap((c) => {
        const ids = c.kind === 'line' ? [c.a, c.b] : c.kind === 'circle' ? [c.center] : [c.center, c.start, c.end];
        return ids.some((id) => dragged.has(id)) ? ids : [];
    }));
    const others = g.points.filter((p) => !dragged.has(p.id)).map((p) => p.id);
    const off = (geometry: SketchGeometry) => Math.max(...targets.map((t) => {
        const p = pointOf(geometry, t.point);
        return p ? Math.hypot(p.u - t.u, p.v - t.v) : 0;
    }));
    const close = 1e-3 + Math.hypot(delta[0], delta[1]) * 0.01;
    let best: { geometry: SketchGeometry; dof: number; off: number } | null = null;
    for (const hold of [new Set(others), new Set(others.filter((id) => !attached.has(id))), undefined]) {
        const result = solveGeometry(g, { targets, hold });
        if (!result.ok) {
            continue;
        }
        const miss = off(result.geometry);
        if (miss <= close) {
            return result;
        }
        if (!best || miss < best.off - 1e-6) {
            best = { geometry: result.geometry, dof: result.dof, off: miss };
        }
    }
    return best;
}

/**
 * Pointer pressed: in the select tool, start dragging the point (or nearest end of the curve) under it; in the
 * dimension tool, start dragging a dimension out of the geometry under it.
 */
export function sketchDown(raw: Pt, tolerance: number): boolean {
    const s = get();
    if (s.stage !== 'draw') {
        return false;
    }
    if (s.tool === 'dimension') {
        const pick = s.dimDraft ? null : dimensionPick(s.geometry, raw, tolerance);
        if (!pick) {
            return false;
        }
        // With one pick waiting, this is the second; otherwise it starts over.
        const picks = s.picks.length === 1 && s.picks[0].id !== pick.id ? [...s.picks, pick] : [pick];
        if (!dimensionFromPicks(s.geometry, picks, raw)) {
            return false;
        }
        set({ dimDrag: { picks, from: raw, slop: tolerance * 0.4 }, cursor: raw, hover: null });
        return true;
    }
    if (s.tool !== 'select') {
        return false;
    }
    const pick = pickAt(s.geometry, raw, tolerance);
    if (!pick || pick.id === ORIGIN || pick.id.startsWith('axis-')) {
        return false;
    }
    // A point moves alone; a line moves as a whole (both ends); a circle or arc by its centre.
    const curve = pick.type === 'curve' ? curveOf(s.geometry, pick.id) : null;
    const ids = pick.type === 'point' ? [pick.id] : curve?.kind === 'line' ? [curve.a, curve.b] : curve ? [curve.center] : [];
    const points = ids.flatMap((id) => {
        const p = pointOf(s.geometry, id);
        return p && !p.fixed && id !== ORIGIN ? [{ id, from: [p.u, p.v] as Pt }] : [];
    });
    if (!points.length) {
        return false;
    }
    set({ drag: { points, grab: raw }, dragFrom: s.geometry });
    return true;
}

export function sketchUp(): void {
    const s = get();
    if (s.drag) {
        // One undo step for the whole drag, and none for a press that moved nothing.
        const moved = s.dragFrom && s.dragFrom !== s.geometry;
        set({ drag: null, dragFrom: null, ...(moved ? { undo: [...s.undo.slice(-80), s.dragFrom!], redo: [] } : {}) });
    }
    if (s.dimDrag) {
        const { picks, from, slop } = s.dimDrag;
        // Released where it was pressed: a plain click, which picks as usual.
        if (!s.cursor || dist(s.cursor, from) <= slop) {
            set({ dimDrag: null });
            return;
        }
        set({ dimDrag: null, picks });
        placeDimension(picks, s.cursor);
    }
}

/** Moves a dimension's label. */
export function moveLabel(id: string, at: Pt): void {
    set((s) => ({ labels: { ...s.labels, [id]: at } }));
}

export function sketchClick(raw: Pt, tolerance: number, additive = false): void {
    const s = get();
    if (s.dimDraft) {
        return;
    }
    if (s.tool === 'select') {
        selectAt(raw, tolerance, additive);
        return;
    }
    if (s.tool === 'dimension') {
        dimensionClick(raw, tolerance);
        return;
    }
    if (s.tool.startsWith('c:')) {
        constraintClick(s.tool.slice(2) as ConstraintTool, raw, tolerance);
        return;
    }
    if (isEditTool(s.tool)) {
        editClick(s.tool, raw, tolerance);
        return;
    }
    if (s.tool === 'xform') {
        xformClick(raw, tolerance, additive);
        return;
    }
    const snapped = snapAt(raw, tolerance);
    place(snapped.ref, snapped.kind);
}

/** The select tool's click: the point or curve under the cursor becomes the selection (Shift adds or removes it). */
function selectAt(raw: Pt, tolerance: number, additive: boolean): void {
    const s = get();
    const pick = pickAt(s.geometry, raw, tolerance);
    const item: Selected | null = pick && pick.id !== AXIS_U && !pick.id.startsWith('axis-') && pick.id !== ORIGIN ? pick : null;
    set({ selection: item ? (additive ? toggle(s.selection, item) : [item]) : additive ? s.selection : [] });
}

function toggle(list: Selected[], item: Selected): Selected[] {
    return list.some((x) => x.id === item.id) ? list.filter((x) => x.id !== item.id) : [...list, item];
}

/** Selects one constraint or dimension (from its glyph or label). */
export function selectConstraint(id: string, additive = false): void {
    const item: Selected = { type: 'constraint', id };
    set((s) => ({ selection: additive ? toggle(s.selection, item) : [item] }));
}

// ---- Drawing ------------------------------------------------------------------------------------------

/** Adds a point to the entity in progress, completing it when it has enough. */
function place(ref: PointRef, kind: SnapKind, typed?: number[]): void {
    const { tool, draft, sides, geometry: g, chainStart } = get();
    const last = draft[draft.length - 1];
    if (last && dist(ref.at, last.at) < 1e-6) {
        return;
    }
    const lineDims = (next: SketchGeometry, line: string): SketchGeometry => {
        let out = next;
        if (typed?.[0] !== undefined) {
            out = addConstraint(out, { kind: 'length', line, value: Math.abs(typed[0]) }).g;
        }
        if (typed?.[1] !== undefined) {
            // The angle from +u to the line as drawn (from its start), 0-180 either side.
            const value = Math.abs(Math.atan2(Math.sin((typed[1] * Math.PI) / 180), Math.cos((typed[1] * Math.PI) / 180))) * 180 / Math.PI;
            out = addConstraint(out, { kind: 'angle', a: AXIS_U, b: line, value: round(value, 1e-6), reverseA: false, reverseB: false }).g;
        }
        return out;
    };
    switch (tool as DrawTool) {
        case 'point': {
            if (ref.point) {
                set({ message: 'There is a point there already.' });
                return;
            }
            commit(placePoint(g, ref).g, { typed: '' });
            return;
        }
        case 'line':
        case 'centerline': {
            if (!last) {
                set({ draft: [ref], typed: '', chainStart: null });
                return;
            }
            const infer = kind === 'horizontal' || kind === 'vertical' ? kind : null;
            const drawn = addLine(g, last, ref, infer);
            // A centre line is construction geometry from the start.
            const r = tool === 'centerline' ? { ...drawn, g: toggleConstruction(drawn.g, [drawn.id]) } : drawn;
            const line = r.g.curves.find((c) => c.id === r.id);
            const start = chainStart ?? (line?.kind === 'line' ? line.a : null);
            const closes = draft.length > 0 && ref.point !== undefined && ref.point === chainStart;
            const end = r.g.points.find((p) => p.id === r.b)!;
            commit(lineDims(r.g, r.id), {
                draft: closes ? [] : [{ at: [end.u, end.v], point: r.b }],
                chainStart: closes ? null : start,
                typed: '',
            });
            return;
        }
        case 'rect': {
            if (!last) {
                set({ draft: [ref], typed: '' });
                return;
            }
            if (Math.abs(ref.at[0] - last.at[0]) < 1e-6 || Math.abs(ref.at[1] - last.at[1]) < 1e-6) {
                return;
            }
            const r = addRect(g, last, ref);
            let out = r.g;
            if (typed?.length) {
                out = addConstraint(out, { kind: 'length', line: r.lines[0], value: Math.abs(typed[0]) }).g;
                out = addConstraint(out, { kind: 'length', line: r.lines[1], value: Math.abs(typed[1] ?? typed[0]) }).g;
            }
            commit(out, { draft: [], typed: '' });
            return;
        }
        case 'centerRect': {
            if (!last) {
                set({ draft: [ref], typed: '' });
                return;
            }
            if (Math.abs(ref.at[0] - last.at[0]) < 1e-6 || Math.abs(ref.at[1] - last.at[1]) < 1e-6) {
                return;
            }
            const r = addCentreRect(g, last, ref);
            let out = r.g;
            if (typed?.length) {
                out = addConstraint(out, { kind: 'length', line: r.lines[0], value: Math.abs(typed[0]) }).g;
                out = addConstraint(out, { kind: 'length', line: r.lines[1], value: Math.abs(typed[1] ?? typed[0]) }).g;
            }
            commit(out, { draft: [], typed: '' });
            return;
        }
        case 'centerArc': {
            if (draft.length < 2) {
                set({ draft: [...draft, ref], typed: '', arcSweep: 0 });
                return;
            }
            if (dist(ref.at, draft[0].at) < 1e-6) {
                return;
            }
            const r = addCentreArc(g, draft[0], draft[1], ref.at, get().arcSweep >= 0);
            // The end joins what it snapped to.
            const arc = curveOf(r.g, r.id);
            const end = arc?.kind === 'arc' ? (arc.start === placedStart(r.g, arc, draft[1]) ? arc.end : arc.start) : null;
            const own = arc?.kind === 'arc' ? [arc.center, arc.start, arc.end] : [];
            const joins = end && !(ref.point && own.includes(ref.point));
            commit(joins ? attachPoint(r.g, end, ref) : r.g, { draft: [], typed: '', arcSweep: 0 });
            return;
        }
        case 'circle': {
            if (!last) {
                set({ draft: [ref], typed: '' });
                return;
            }
            const r = addCircle(g, last, round(dist(last.at, ref.at)));
            let out = typed?.length ? addConstraint(r.g, { kind: 'diameter', curve: r.id, value: Math.abs(typed[0]) }).g : r.g;
            // Sized on a point: the circle passes through it.
            if (!typed?.length && ref.point && ref.point !== r.center) {
                out = addConstraint(out, { kind: 'pointOnCurve', point: ref.point, curve: r.id }).g;
            }
            commit(out, { draft: [], typed: '' });
            return;
        }
        case 'polygon': {
            if (!last) {
                set({ draft: [ref], typed: '' });
                return;
            }
            const r = addPolygon(g, last, ref.at, sides);
            const out = typed?.length ? addConstraint(r.g, { kind: 'radius', curve: r.circle, value: Math.abs(typed[0]) }).g : r.g;
            commit(out, { draft: [], typed: '' });
            return;
        }
        case 'arc': {
            if (draft.length < 2) {
                set({ draft: [...draft, ref], typed: '' });
                return;
            }
            const r = addArc(g, draft[0], draft[1], ref.at);
            const out = typed?.length ? addConstraint(r.g, { kind: 'radius', curve: r.id, value: Math.abs(typed[0]) }).g : r.g;
            commit(out, { draft: [], typed: '' });
            return;
        }
        case 'tangentArc': {
            if (!last) {
                if (!ref.point || !tangentAt(g, ref.point)) {
                    set({ message: 'Start a tangent arc on the end of a line or arc.' });
                    return;
                }
                set({ draft: [ref], typed: '', message: null });
                return;
            }
            const r = addTangentArc(g, last.point!, ref);
            if ('error' in r) {
                set({ message: r.error });
                return;
            }
            // Goes on from the new end, tangent again, until Enter, Esc or a double-click.
            const end = r.g.points.find((p) => p.id === r.end)!;
            commit(r.g, { draft: [{ at: [end.u, end.v], point: r.end }], typed: '' });
            return;
        }
        case 'perimeterCircle': {
            if (draft.length < 2) {
                set({ draft: [...draft, ref], typed: '' });
                return;
            }
            const r = addPerimeterCircle(g, [...draft, ref]);
            if (!r) {
                set({ message: 'Those three points are in a line; no circle passes through them.' });
                return;
            }
            commit(r.g, { draft: [], typed: '' });
            return;
        }
        case 'rect3': {
            if (draft.length < 2) {
                set({ draft: [...draft, ref], typed: '' });
                return;
            }
            const r = addRect3(g, draft[0], draft[1], ref.at);
            if (r) {
                commit(r.g, { draft: [], typed: '' });
            }
            return;
        }
        case 'slot': {
            if (draft.length < 2) {
                set({ draft: [...draft, ref], typed: '' });
                return;
            }
            const [a, b] = draft;
            const radius = typed?.length ? Math.abs(typed[0]) / 2 : Math.max(0.1, lineDistance(ref.at, a.at, b.at));
            const r = addSlot(g, a, b, round(radius));
            const out = typed?.length ? addConstraint(r.g, { kind: 'radius', curve: r.arcs[0], value: radius }).g : r.g;
            commit(out, { draft: [], typed: '' });
            return;
        }
    }
}

/** The id the arc's start point got from its draft ref (the start click). */
function placedStart(g: SketchGeometry, arc: Extract<SketchGeometry['curves'][number], { kind: 'arc' }>, start: PointRef): string {
    const near = (id: string) => {
        const p = pointOf(g, id);
        return p ? dist([p.u, p.v], start.at) : Infinity;
    };
    return near(arc.start) <= near(arc.end) ? arc.start : arc.end;
}

/**
 * Joins a newly drawn point to what the click snapped to: an existing point (they become one), a curve it lies on,
 * or the middle of a line.
 */
function attachPoint(g: SketchGeometry, id: string, ref: PointRef): SketchGeometry {
    if (ref.point) {
        return ref.point === id ? g : mergePoints(g, ref.point, id);
    }
    let out = g;
    if (ref.midOf) {
        out = addConstraint(out, { kind: 'midpoint', point: id, line: ref.midOf }).g;
    }
    for (const curve of ref.onCurves ?? []) {
        out = addConstraint(out, { kind: 'pointOnCurve', point: id, curve }).g;
    }
    return out;
}

function lineDistance(p: Pt, a: Pt, b: Pt): number {
    const length = dist(a, b);
    if (length === 0) {
        return dist(p, a);
    }
    return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / length;
}

/** Ends a line chain (double-click). */
export function endChain(): void {
    set({ draft: [], chainStart: null, typed: '' });
}

/**
 * Enter while sketching: applies a typed value (an error goes to the status line), takes an edit tool's next step,
 * or ends the line chain in progress. Returns 'exit' only when nothing was in progress, so Enter can then leave
 * the sketch; 'done' when it was used here.
 */
export function enterKey(): 'done' | 'exit' {
    const s = get();
    if (s.stage !== 'draw' || s.dimDraft) {
        return 'done';
    }
    if (s.typed) {
        const error = applyTyped();
        if (error) {
            set({ message: error });
        } else if (get().typed === s.typed && get().draft === s.draft && get().message === s.message) {
            // Nothing took the value (a zero size, or a point on top of the last one).
            set({ typed: '', message: 'That value cannot be drawn here; type a size above zero.' });
        }
        return 'done';
    }
    if (sketchEnter()) {
        return 'done';
    }
    if (s.draft.length) {
        if (s.tool === 'line' || s.tool === 'centerline' || s.tool === 'tangentArc') {
            endChain();
        } else {
            set({ message: 'Finish the shape with a click, or press Esc to drop it.' });
        }
        return 'done';
    }
    if (s.picks.length || s.dimDrag || s.drag || s.offsetCurve || s.xform?.picks.length) {
        return 'done';
    }
    return 'exit';
}

export function typeKey(key: string): boolean {
    const s = get();
    // Fillet and chamfer take a size at any time, offset a distance once its curve is picked.
    const sized = s.tool === 'fillet' || s.tool === 'chamfer' || (s.tool === 'offset' && !!s.offsetCurve);
    if (s.stage !== 'draw' || s.dimDraft) {
        return false;
    }
    if (!sized && (!s.draft.length || s.tool === 'select' || s.tool === 'dimension' || s.tool.startsWith('c:') || isEditTool(s.tool))) {
        return false;
    }
    if (key === 'Backspace') {
        // With nothing typed in an edit tool, Backspace still deletes the selection.
        if (sized && !s.typed) {
            return false;
        }
        set({ typed: s.typed.slice(0, -1) });
        return true;
    }
    // Edit tools take plain numbers only, so their letter shortcuts (X) keep working.
    if (sized ? /^[0-9.,\-*/+()]$/.test(key) : /^[0-9.,\-x*/+() ]$/.test(key)) {
        set({ typed: s.typed + key });
        return true;
    }
    return false;
}

/** Direction from `from` toward the cursor, or +u when the cursor is on it. */
function towardCursor(from: Pt): Pt {
    const c = get().cursor;
    if (!c || dist(c, from) < 1e-9) {
        return [1, 0];
    }
    const d = dist(from, c);
    return [(c[0] - from[0]) / d, (c[1] - from[1]) / d];
}

/** Applies the typed dimension(s) and keeps them as driving dimensions on the new geometry. */
export function applyTyped(): string | null {
    const s = get();
    const values = s.typed.split(/[;x\s]+|,(?=\s*-?\d)/).filter(Boolean).map((t) => evaluate(t));
    if (!values.length || values.some((v) => v === null)) {
        set({ typed: '' });
        return 'Type a number, e.g. 40, 40/2 or 40 x 20';
    }
    const nums = values as number[];
    if (s.tool === 'fillet' || s.tool === 'chamfer') {
        const size = Math.abs(nums[0]);
        if (!size) {
            set({ typed: '' });
            return 'Type a size above zero';
        }
        set(s.tool === 'fillet' ? { filletRadius: size, typed: '', editText: `R${round(size, 0.01)}` } : { chamferDistance: size, typed: '', editText: `${round(size, 0.01)}` });
        return null;
    }
    if (s.tool === 'offset') {
        const d = s.cursor && s.offsetCurve ? sideDistance(s.geometry, s.offsetCurve, s.cursor) : 1;
        applyOffset((Math.sign(d) || 1) * Math.abs(nums[0]));
        return null;
    }
    const last = s.draft[s.draft.length - 1];
    const [a, b] = nums;
    const step = (from: Pt, length: number, angle?: number): Pt => {
        const dir: Pt = angle !== undefined
            ? [Math.cos((angle * Math.PI) / 180), Math.sin((angle * Math.PI) / 180)]
            : towardCursor(from);
        return [round(from[0] + dir[0] * length), round(from[1] + dir[1] * length)];
    };
    switch (s.tool) {
        case 'line':
        case 'centerline':
            place({ at: step(last.at, a, b) }, null, nums);
            break;
        case 'rect': {
            const c = s.cursor ?? [last.at[0] + 1, last.at[1] + 1];
            const su = Math.sign(c[0] - last.at[0]) || 1;
            const sv = Math.sign(c[1] - last.at[1]) || 1;
            place({ at: [round(last.at[0] + su * a), round(last.at[1] + sv * (b ?? a))] }, null, [a, b ?? a]);
            break;
        }
        case 'centerRect': {
            const c = s.cursor ?? [last.at[0] + 1, last.at[1] + 1];
            const su = Math.sign(c[0] - last.at[0]) || 1;
            const sv = Math.sign(c[1] - last.at[1]) || 1;
            place({ at: [round(last.at[0] + (su * a) / 2), round(last.at[1] + (sv * (b ?? a)) / 2)] }, null, [a, b ?? a]);
            break;
        }
        case 'centerArc':
            if (s.draft.length === 1) {
                // The radius, toward the cursor.
                place({ at: step(last.at, Math.abs(a)) }, null);
            } else {
                // The angle it sweeps, in degrees, the way the cursor went.
                const [c, start] = s.draft.map((d) => d.at);
                const sweep = (Math.abs(a) * Math.PI / 180) * (s.arcSweep < 0 ? -1 : 1);
                const from = Math.atan2(start[1] - c[1], start[0] - c[0]);
                set({ arcSweep: sweep });
                place({ at: [round(c[0] + Math.cos(from + sweep) * 10), round(c[1] + Math.sin(from + sweep) * 10)] }, null);
            }
            break;
        case 'circle':
            place({ at: [last.at[0] + Math.abs(a) / 2, last.at[1]] }, null, [a]);
            break;
        case 'polygon':
            place({ at: step(last.at, Math.abs(a)) }, null, [a]);
            break;
        case 'arc':
            if (s.draft.length === 1) {
                place({ at: step(last.at, a, b) }, null);
            } else {
                const [p0, p1] = s.draft.map((d) => d.at);
                const chord = dist(p0, p1);
                const r = Math.abs(a);
                if (r < chord / 2) {
                    set({ typed: '' });
                    return `The radius must be at least half the chord (${round(chord / 2, 0.01)} mm)`;
                }
                const m = mid(p0, p1);
                const n: Pt = [-(p1[1] - p0[1]) / chord, (p1[0] - p0[0]) / chord];
                const c = s.cursor ?? m;
                const side = Math.sign((c[0] - m[0]) * n[0] + (c[1] - m[1]) * n[1]) || 1;
                const sagitta = r - Math.sqrt(r * r - (chord / 2) ** 2);
                place({ at: [round(m[0] + n[0] * sagitta * side), round(m[1] + n[1] * sagitta * side)] }, null, [r]);
            }
            break;
        case 'slot':
            if (s.draft.length === 1) {
                place({ at: step(last.at, a, b) }, null);
            } else {
                place({ at: s.draft[1].at }, null, [a]);
            }
            break;
    }
    return null;
}

// ---- Dimensions ---------------------------------------------------------------------------------------

/** Pick for the dimension tool: a point only when the cursor is right on it, else a curve from well away. */
function dimensionPick(g: SketchGeometry, raw: Pt, tolerance: number): Pick | null {
    const near = pickAt(g, raw, tolerance * 0.7);
    return near?.type === 'point' ? near : curveAt(g, raw, tolerance * 2.4, tolerance * 0.8);
}

/** Opens the value input for a dimension of `picks`, with its label at `at`. */
function placeDimension(picks: Pick[], at: Pt): void {
    const s = get();
    const constraint = dimensionFromPicks(s.geometry, picks, at);
    if (!constraint) {
        set({ picks: [], message: 'Those cannot be dimensioned together.' });
        return;
    }
    const value = measure(s.geometry, { ...constraint, id: 'measuring' } as SketchConstraint) ?? 0;
    set({ dimDraft: { constraint, at, text: String(round(value, 0.01)), editing: null, error: null }, hover: null, message: null });
}

function dimensionClick(raw: Pt, tolerance: number): void {
    const s = get();
    let pick = dimensionPick(s.geometry, raw, tolerance);
    // With two picks already, a click on an axis is the placement, not a third pick.
    if (pick && s.picks.length >= 2 && pick.id.startsWith('axis-')) {
        pick = null;
    }
    if (pick && !(s.picks.length === 1 && s.picks[0].id === pick.id)) {
        const picks = s.picks.length >= 2 ? [pick] : [...s.picks, pick];
        set({ picks, message: null });
        return;
    }
    if (!s.picks.length) {
        set({ message: 'Click a line or circle and drag the dimension out. Or click two points, a point and a line, or two lines.' });
        return;
    }
    // A click on empty space places the dimension there and asks for its value.
    placeDimension(s.picks, raw);
}

/** Opens the value input of an existing dimension. */
export function editDimension(id: string): void {
    const s = get();
    const c = s.geometry.constraints.find((k) => k.id === id);
    if (!c || !isDimension(c)) {
        return;
    }
    const { id: _id, ...constraint } = c;
    set({ dimDraft: { constraint, at: s.labels[id] ?? dimensionAnchor(s.geometry, c), text: String(round(c.value, 0.0001)), editing: id, error: null } });
}

export function setDimText(text: string): void {
    set((s) => (s.dimDraft ? { dimDraft: { ...s.dimDraft, text, error: null } } : {}));
}

export function cancelDimension(): void {
    set({ dimDraft: null, picks: [] });
}

/** Applies the value input: solves with the new dimension, or reports the conflict and keeps the input open. */
export function applyDimension(): void {
    const s = get();
    const draft = s.dimDraft;
    if (!draft) {
        return;
    }
    const value = evaluate(draft.text);
    const angle = draft.constraint.kind === 'angle';
    if (value === null || value < 0 || (!angle && value === 0)) {
        set({ dimDraft: { ...draft, error: 'Type a positive value, e.g. 40 or 80/2' } });
        return;
    }
    const constraint = { ...draft.constraint, value } as NewConstraint;
    let next: SketchGeometry;
    let id: string;
    if (draft.editing) {
        id = draft.editing;
        next = { ...s.geometry, constraints: s.geometry.constraints.map((c) => (c.id === id ? { ...constraint, id } as SketchConstraint : c)) };
    } else {
        const r = addConstraint(s.geometry, constraint);
        next = r.g;
        id = r.id;
    }
    const ok = commit(next, { dimDraft: null, picks: [], labels: { ...s.labels, [id]: draft.at } });
    if (!ok) {
        const message = get().message ?? 'Over-constrained';
        set({ dimDraft: { ...draft, error: message } });
    }
}

/** Default place for a dimension label: beside what it measures. */
export function dimensionAnchor(g: SketchGeometry, c: SketchConstraint): Pt {
    const p = (id: string): Pt => {
        const q = pointOf(g, id);
        return q ? [q.u, q.v] : [0, 0];
    };
    switch (c.kind) {
        case 'length': {
            const line = curveOf(g, c.line);
            if (line?.kind !== 'line') {
                return [0, 0];
            }
            const a = p(line.a);
            const b = p(line.b);
            const l = dist(a, b) || 1;
            const off = Math.max(4, l * 0.12);
            return [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / l) * off, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / l) * off];
        }
        case 'distance': {
            const a = p(c.a);
            const b = pointOf(g, c.b) ? p(c.b) : c.b === AXIS_U ? [a[0], 0] as Pt : c.b === 'axis-v' ? [0, a[1]] as Pt : a;
            return [(a[0] + b[0]) / 2 + 3, (a[1] + b[1]) / 2 + 3];
        }
        case 'radius':
        case 'diameter': {
            const curve = curveOf(g, c.curve);
            if (!curve || curve.kind === 'line') {
                return [0, 0];
            }
            const centre = p(curve.center);
            const r = curve.kind === 'circle' ? curve.radius : dist(centre, p(curve.start));
            return [centre[0] + r * 0.9, centre[1] + r * 0.9];
        }
        case 'angle': {
            const ends = [c.a, c.b].flatMap((id) => {
                const line = curveOf(g, id);
                return line?.kind === 'line' ? [p(line.a), p(line.b)] : [[0, 0] as Pt];
            });
            const u = ends.reduce((sum, q) => sum + q[0], 0) / ends.length;
            const v = ends.reduce((sum, q) => sum + q[1], 0) / ends.length;
            return [u + 4, v + 4];
        }
        default:
            return [0, 0];
    }
}

// ---- Constraints --------------------------------------------------------------------------------------

/** The constraint tool button: applies to the selection when it fits, else waits for picks in the view. */
export function constraintTool(tool: ConstraintTool): void {
    const s = get();
    const picks = s.selection.filter((x): x is Pick => x.type !== 'constraint');
    if (tool === 'fix' && picks.length) {
        toggleLock(picks);
        set({ selection: [] });
        return;
    }
    if (picks.length) {
        const result = relationsFromPicks(s.geometry, tool, picks);
        if (!('need' in result)) {
            applyRelations(tool, result, { selection: [] });
            return;
        }
        // Not a set this relation takes: keep what fits as the first picks, and say what it needs.
        setTool(`c:${tool}`);
        set({ picks: picks.length < pickLimit(tool) ? picks : [], message: result.need });
        return;
    }
    setTool(`c:${tool}`);
}

/** Picks a relation tool collects in the view before it gives up on a set that does not fit. */
function pickLimit(tool: ConstraintTool): number {
    return Math.max(2, PICKS_NEEDED[tool]);
}

/**
 * Adds the relations one tool made for the picks. Merge joins the points into the first. With several relations
 * (Equal on four lines), any that only repeat what the others already hold are left out, as SolidWorks keeps one
 * relation over all of them; a single relation that repeats others is added and the sketch reported over defined.
 */
function applyRelations(tool: ConstraintTool, relations: NewConstraint[], patch: Partial<SketcherState>): boolean {
    const s = get();
    if (tool === 'merge') {
        let g = s.geometry;
        for (const c of relations) {
            if (c.kind === 'coincident') {
                g = mergePoints(g, c.a, c.b);
            }
        }
        const collapsed = g.curves.some((c) => (c.kind === 'line' ? c.a === c.b : c.kind === 'arc' && (c.start === c.end || c.center === c.start || c.center === c.end)));
        if (collapsed) {
            set({ message: 'Those points belong to one line or arc; merging them would collapse it.' });
            return false;
        }
        return commit(g, patch);
    }
    if (relations.length === 1 || !solverReady()) {
        let g = s.geometry;
        for (const c of relations) {
            g = addConstraint(g, c).g;
        }
        return commit(g, patch);
    }
    let g = s.geometry;
    let repeats = 0;
    const before = solveGeometry(g).redundant.length;
    for (const c of relations) {
        const next = addConstraint(g, c).g;
        const r = solveGeometry(next);
        if (r.ok && r.redundant.length > before) {
            repeats += 1;
        } else {
            // A conflict is left in, so the commit refuses the whole set and names it.
            g = next;
        }
    }
    if (repeats === relations.length) {
        let all = s.geometry;
        for (const c of relations) {
            all = addConstraint(all, c).g;
        }
        return commit(all, patch);
    }
    const ok = commit(g, patch);
    if (ok && repeats) {
        set({ message: `Added ${relations.length - repeats} of ${relations.length}; the others already held.` });
    }
    return ok;
}

/**
 * Locks the picked points, lines (both ends), circles (centre and radius) and arcs (their points) in place; unlocks
 * them if all are locked.
 */
export function toggleLock(picks: Pick[]): void {
    const s = get();
    const ids = [...new Set(picks.flatMap((pick) => {
        if (pick.type === 'point') {
            return [pick.id];
        }
        const c = curveOf(s.geometry, pick.id);
        return !c ? [] : c.kind === 'line' ? [c.a, c.b] : c.kind === 'circle' ? [c.center] : [c.center, c.start, c.end];
    }))].filter((id) => id !== ORIGIN && pointOf(s.geometry, id));
    const circles = picks.filter((pick) => pick.type === 'curve' && curveOf(s.geometry, pick.id)?.kind === 'circle').map((pick) => pick.id);
    if (!ids.length && !circles.length) {
        set({ message: 'Pick a point, a line, a circle or an arc to lock.' });
        return;
    }
    const locked = new Set(s.geometry.constraints.flatMap((c) => (c.kind === 'fix' ? [c.point] : c.kind === 'fixRadius' ? [c.curve] : [])));
    if ([...ids, ...circles].every((id) => locked.has(id))) {
        const gone = new Set([...ids, ...circles]);
        commit({
            ...s.geometry,
            constraints: s.geometry.constraints.filter((c) => !((c.kind === 'fix' && gone.has(c.point)) || (c.kind === 'fixRadius' && gone.has(c.curve)))),
        }, { picks: [] });
        return;
    }
    let g = s.geometry;
    for (const id of ids.filter((x) => !locked.has(x))) {
        g = addConstraint(g, { kind: 'fix', point: id }).g;
    }
    for (const id of circles.filter((x) => !locked.has(x))) {
        g = addConstraint(g, { kind: 'fixRadius', curve: id }).g;
    }
    commit(g, { picks: [] });
}

function constraintClick(tool: ConstraintTool, raw: Pt, tolerance: number): void {
    const s = get();
    const pick = pickAt(s.geometry, raw, tolerance);
    if (!pick) {
        return;
    }
    if (tool === 'fix') {
        toggleLock([pick]);
        return;
    }
    const picks = [...s.picks.filter((p) => p.id !== pick.id), pick];
    const result = relationsFromPicks(s.geometry, tool, picks);
    if (!('need' in result)) {
        applyRelations(tool, result, { picks: [] });
        return;
    }
    if (picks.length >= pickLimit(tool)) {
        set({ picks: [], message: result.need });
    } else {
        set({ picks, message: null });
    }
}

/** Esc: the value input, the typed value, the entity in progress, the picks, the tool, then the selection. */
export function sketchEscape(): void {
    const s = get();
    if (s.dimDraft) {
        set({ dimDraft: null });
    } else if (s.typed) {
        set({ typed: '' });
    } else if (s.draft.length) {
        set({ draft: [], chainStart: null });
    } else if (s.picks.length || s.offsetCurve || s.mirrorAbout || s.xform?.picks.length) {
        set((x) => ({ picks: [], offsetCurve: null, mirrorAbout: false, editPreview: [], editText: null, xform: x.xform && { ...x.xform, picks: [] } }));
    } else if (s.tool !== 'select') {
        set({ tool: 'select', message: null });
    } else if (s.selection.length) {
        set({ selection: [] });
    }
}

// ---- Editing: trim, extend, fillet, chamfer, offset, mirror, patterns -----------------------------------

const isAxis = (id: string) => id === AXIS_U || id === AXIS_V;

/** A drawn curve under the cursor (not an axis). */
function drawnCurveAt(g: SketchGeometry, raw: Pt, tolerance: number): Pick | null {
    const pick = curveAt(g, raw, tolerance);
    return pick && !isAxis(pick.id) ? pick : null;
}

/** Fillet and chamfer: a point that curves use (the origin only when it is one), else a drawn curve. */
function cornerPick(g: SketchGeometry, raw: Pt, tolerance: number): Pick | null {
    const used = new Set(g.curves.flatMap(curvePoints));
    let best: { id: string; d: number } | null = null;
    for (const p of g.points) {
        const d = dist(raw, [p.u, p.v]);
        if (used.has(p.id) && d < tolerance * 1.2 && (!best || d < best.d)) {
            best = { id: p.id, d };
        }
    }
    return best ? { type: 'point', id: best.id } : drawnCurveAt(g, raw, tolerance);
}

/** Offset distance for the cursor: the typed value on the cursor's side, else the cursor's own distance. */
function offsetDistance(s: SketcherState, raw: Pt): number {
    const d = s.offsetCurve ? sideDistance(s.geometry, s.offsetCurve, raw) : 0;
    const typed = s.typed ? evaluate(s.typed) : null;
    return typed !== null ? (Math.sign(d) || 1) * Math.abs(typed) : round(d, 0.01);
}

/** What the edit tool would do at the cursor: the highlight, the preview and the note. */
function editHover(s: SketcherState, raw: Pt, tolerance: number): Partial<SketcherState> {
    const g = s.geometry;
    switch (s.tool) {
        case 'trim':
        case 'extend': {
            const pick = drawnCurveAt(g, raw, tolerance);
            const plan = pick && (s.tool === 'trim' ? trimAt(g, pick.id, raw) : extendAt(g, pick.id, raw));
            const shown = plan ? ('removed' in plan ? plan.removed : plan.added) : null;
            return { hover: null, editPreview: shown ? [shown] : [], editText: null };
        }
        case 'fillet':
        case 'chamfer': {
            const size = s.tool === 'fillet' ? `R${round(s.filletRadius, 0.01)}` : `${round(s.chamferDistance, 0.01)}`;
            return { hover: cornerPick(g, raw, tolerance), editPreview: [], editText: s.typed ? null : size };
        }
        case 'offset': {
            if (s.offsetCurve) {
                const d = offsetDistance(s, raw);
                return { hover: null, editPreview: offsetPreview(g, s.offsetCurve, d), editText: s.typed ? null : `${round(Math.abs(d), 0.01)}` };
            }
            return { hover: drawnCurveAt(g, raw, tolerance), editPreview: [], editText: null };
        }
        case 'mirror':
            return { hover: curveAt(g, raw, tolerance), editPreview: [], editText: null };
        default:
            return {};
    }
}

function editClick(tool: EditTool, raw: Pt, tolerance: number): void {
    const s = get();
    const g = s.geometry;
    switch (tool) {
        case 'trim':
        case 'extend': {
            const pick = drawnCurveAt(g, raw, tolerance);
            if (!pick) {
                return;
            }
            const plan = tool === 'trim' ? trimAt(g, pick.id, raw) : extendAt(g, pick.id, raw);
            if (!plan) {
                set({ message: tool === 'trim' ? 'Nothing to trim there: a circle needs two crossings.'
                    : 'Nothing to extend to: the end must be free and point at another curve.' });
                return;
            }
            commit(plan.g, { editPreview: [], selection: [] });
            return;
        }
        case 'fillet':
        case 'chamfer': {
            const typed = s.typed ? evaluate(s.typed) : null;
            const size = Math.abs(typed ?? (tool === 'fillet' ? s.filletRadius : s.chamferDistance));
            const pick = cornerPick(g, raw, tolerance);
            if (!pick) {
                return;
            }
            let corner: ReturnType<typeof cornerOf>;
            if (pick.type === 'point') {
                corner = cornerOf(g, { point: pick.id });
            } else {
                if (curveOf(g, pick.id)?.kind !== 'line') {
                    set({ picks: [], message: 'Pick a corner, or two lines.' });
                    return;
                }
                const first = s.picks.find((p) => p.type === 'curve' && p.id !== pick.id);
                if (!first) {
                    set({ picks: [pick], message: null });
                    return;
                }
                corner = cornerOf(g, { lines: [first.id, pick.id] });
            }
            const r = 'error' in corner ? corner : tool === 'fillet' ? filletCorner(g, corner, size) : chamferCorner(g, corner, size);
            if ('error' in r) {
                set({ picks: [], message: r.error });
                return;
            }
            commit(r.g, { picks: [], typed: '', hover: null, selection: [], ...(tool === 'fillet' ? { filletRadius: size } : { chamferDistance: size }) });
            return;
        }
        case 'offset': {
            if (!s.offsetCurve) {
                const pick = drawnCurveAt(g, raw, tolerance);
                if (pick) {
                    set({ offsetCurve: pick.id, picks: [pick], hover: null, message: null });
                    set(editHover(get(), raw, tolerance));
                }
                return;
            }
            applyOffset(offsetDistance(s, raw));
            return;
        }
        case 'mirror': {
            const pick = curveAt(g, raw, tolerance);
            if (!pick) {
                return;
            }
            const objects = s.picks.map((p) => p.id);
            const curve = curveOf(g, pick.id);
            const line = isAxis(pick.id) || curve?.kind === 'line';
            // An axis or a centre line is the mirror line straight away; any line once Enter was pressed.
            const about = objects.length > 0 && line && !objects.includes(pick.id) && (s.mirrorAbout || isAxis(pick.id) || !!curve?.construction);
            if (about) {
                const r = mirrorCurves(g, objects, pick.id);
                if ('error' in r) {
                    set({ message: r.error });
                    return;
                }
                commit(r.g, { picks: [], mirrorAbout: false, hover: null, selection: [] });
                return;
            }
            if (s.mirrorAbout) {
                set({ message: 'Pick a line or an axis to mirror about.' });
                return;
            }
            if (isAxis(pick.id)) {
                set({ message: 'Pick the curves to mirror first.' });
                return;
            }
            set({ picks: objects.includes(pick.id) ? s.picks.filter((p) => p.id !== pick.id) : [...s.picks, pick], message: null });
            return;
        }
    }
}

function applyOffset(d: number): void {
    const s = get();
    if (!s.offsetCurve) {
        return;
    }
    const r = offsetChain(s.geometry, s.offsetCurve, d);
    if ('error' in r) {
        set({ typed: '', message: r.error });
        return;
    }
    commit(r.g, { offsetCurve: null, picks: [], typed: '', editPreview: [], editText: null });
}

/** Enter in an edit tool: mirror moves on from picking curves to picking the line. False when it has no use for it. */
export function sketchEnter(): boolean {
    const s = get();
    if (s.tool === 'mirror' && s.picks.length && !s.mirrorAbout) {
        set({ mirrorAbout: true, message: null });
        return true;
    }
    return false;
}

/** The selected curves, for the patterns. */
function selectedCurves(): string[] {
    return get().selection.filter((x) => x.type === 'curve').map((x) => x.id);
}

/** Where a circular pattern turns about by default: the selected point, else the origin. */
export function patternCentre(): Pt {
    const s = get();
    const point = s.selection.find((x) => x.type === 'point');
    const p = point && pointOf(s.geometry, point.id);
    return p ? [p.u, p.v] : [0, 0];
}

/** Copies the selected curves `count` times in all, `step` apart. Returns an error to show, or null. */
export function linearPatternSelected(count: number, step: Pt): string | null {
    const r = linearPattern(get().geometry, selectedCurves(), Math.round(count), step);
    if ('error' in r) {
        return r.error;
    }
    return commit(r.g, { selection: [] }) ? null : get().message;
}

/** Copies the selected curves `count` times in all about `centre`, over `angle` degrees. Returns an error to show, or null. */
export function circularPatternSelected(count: number, angle: number, centre: Pt): string | null {
    const r = circularPattern(get().geometry, selectedCurves(), Math.round(count), angle, centre);
    if ('error' in r) {
        return r.error;
    }
    return commit(r.g, { selection: [] }) ? null : get().message;
}

// ---- Move, copy, rotate, scale ----------------------------------------------------------------------------

/** The selected curves and points (not relations). */
function selectedGeometry(): string[] {
    return get().selection.filter((x) => x.type !== 'constraint').map((x) => x.id);
}

/** While the Move, Copy, Rotate or Scale form is open, clicks in the view pick points for it. */
export function startTransformPick(kind: TransformKind): void {
    setTool('xform');
    set({ xform: { kind, picks: [] } });
}

/** The form closed: back to selecting. */
export function stopTransformPick(): void {
    // Keep the status line: it says what the form just did.
    const { message } = get();
    if (get().tool === 'xform') {
        setTool('select');
    }
    set({ xform: null, editPreview: [], message });
}

/** Forgets the points picked so far (after the form used them). */
export function clearTransformPicks(): void {
    set((s) => ({ xform: s.xform && { ...s.xform, picks: [] }, editPreview: [] }));
}

/** A click while picking: with nothing selected yet, or with Shift, it selects; else it picks a (snapped) point. */
function xformClick(raw: Pt, tolerance: number, additive: boolean): void {
    const s = get();
    if (additive || !selectedGeometry().length || !s.xform) {
        selectAt(raw, tolerance, additive);
        return;
    }
    const p = snapAt(raw, tolerance).p;
    set({ xform: { ...s.xform, picks: [...s.xform.picks, p] } });
}

/** Moving or copying by two points: the selection drawn at the cursor once the first point is picked. */
function xformPreview(s: SketcherState, cursor: Pt): NewEntity[] {
    const from = s.xform?.picks[0];
    if (!from || (s.xform?.kind !== 'move' && s.xform?.kind !== 'copy')) {
        return [];
    }
    const t: Transform = { kind: 'move', by: [cursor[0] - from[0], cursor[1] - from[1]] };
    const ids = new Set(selectedGeometry());
    const q = (p: Pt) => transformPoint(t, p);
    return geometryEntities(s.geometry).filter((e) => ids.has(e.id)).flatMap((e): NewEntity[] => {
        switch (e.kind) {
            case 'line':
                return [{ kind: 'line', a: q(e.a), b: q(e.b) }];
            case 'arc':
                return [{ kind: 'arc', a: q(e.a), b: q(e.b), m: q(e.m) }];
            case 'circle':
                return [{ kind: 'circle', c: q(e.c), r: e.r }];
            default:
                return [];
        }
    });
}

/**
 * Moves, turns or scales the selected curves and points, or copies them. Returns an error to show, or null; the
 * status line says what was done and how many relations to the rest of the sketch a move removed.
 */
export function transformSelected(t: Transform, copy: boolean): string | null {
    const s = get();
    const r = transformEntities(s.geometry, selectedGeometry(), t, copy);
    if ('error' in r) {
        return r.error;
    }
    // Dimension labels inside the moved set go with it.
    const kept = new Set(r.g.constraints.map((c) => c.id));
    const labels = copy ? s.labels : Object.fromEntries(Object.entries(s.labels).map(([id, at]) => [id, kept.has(id) && movedDimension(s.geometry, id, r.created) ? transformPoint(t, at) : at]));
    const selection: Selected[] = copy
        ? r.created.map((id) => ({ type: r.g.curves.some((c) => c.id === id) ? 'curve' : 'point', id }))
        : s.selection;
    if (!commit(r.g, { selection, labels, editPreview: [] })) {
        return get().message;
    }
    const verb = { move: copy ? 'Copied' : 'Moved', rotate: copy ? 'Copied and turned' : 'Turned', scale: copy ? 'Copied and scaled' : 'Scaled' }[t.kind];
    const count = selectedGeometry().length;
    const what = `${count} item${count === 1 ? '' : 's'}`;
    set({ message: r.dropped ? `${verb} ${what}; removed ${r.dropped} relation${r.dropped === 1 ? '' : 's'} to the rest of the sketch.` : `${verb} ${what}.` });
    return null;
}

/** Whether a dimension refers only to the moved curves (or their points). */
function movedDimension(g: SketchGeometry, id: string, curves: string[]): boolean {
    const c = g.constraints.find((k) => k.id === id);
    if (!c) {
        return false;
    }
    const inSet = new Set([...curves, ...curves.flatMap((x) => {
        const curve = curveOf(g, x);
        return curve ? curvePoints(curve) : [];
    })]);
    return Object.entries(c).every(([key, v]) => key === 'id' || key === 'kind' || key === 'axis' || typeof v !== 'string' || inSet.has(v));
}

/** Where Rotate and Scale turn about by default: the selected loose point, else the origin. */
export { patternCentre as transformCentre };

// ---- Relations, highlight, quick snaps -------------------------------------------------------------------

/** Lights up geometry from a list outside the view (empty clears it). */
export function setHighlight(ids: string[]): void {
    const now = get().highlight;
    if (now.length !== ids.length || now.some((id, i) => id !== ids[i])) {
        set({ highlight: ids });
    }
}

/**
 * Removes relations and dimensions. Removing can only take conflicts away, so it applies even when the sketch is
 * still over-constrained afterwards; the status line then says so.
 */
export function deleteConstraints(ids: string[]): void {
    const s = get();
    const gone = new Set(ids);
    if (!s.geometry.constraints.some((c) => gone.has(c.id))) {
        return;
    }
    const next = { ...s.geometry, constraints: s.geometry.constraints.filter((c) => !gone.has(c.id)) };
    const patch = { selection: s.selection.filter((x) => !gone.has(x.id)), highlight: [] };
    if (!commit(next, patch)) {
        set({ ...patch, geometry: next, undo: [...s.undo.slice(-80), s.geometry], redo: [] });
        resolve();
    }
}

/** Switches one quick snap on or off, or all of them on (kind null); remembered in this browser. */
export function setSnapKind(kind: QuickSnap | null, on = true): void {
    const next = kind ? { ...get().snapKinds, [kind]: on } : {};
    if (kind && on) {
        delete next[kind];
    }
    set({ snapKinds: next });
    try {
        globalThis.localStorage?.setItem(SNAPS_KEY, JSON.stringify(next));
    } catch {
        // Storage can be full or blocked; the setting still holds for this session.
    }
}

// ---- Repair and fully define ------------------------------------------------------------------------------

/** Fixes one problem Repair sketch found. */
export function repairProblem(problem: Problem): boolean {
    return commit(fixProblem(get().geometry, problem), { selection: [], highlight: [] });
}

/** Fixes everything Repair sketch finds; says how many. */
export function repairAll(): boolean {
    const r = fixAll(get().geometry);
    if (!r.fixed) {
        set({ message: 'Nothing to repair.' });
        return true;
    }
    if (!commit(r.g, { selection: [], highlight: [] })) {
        return false;
    }
    set({ message: `Repaired ${r.fixed} problem${r.fixed === 1 ? '' : 's'}.` });
    return true;
}

/** Adds the dimensions the sketch still needs to be fully defined; says how many. */
export function fullyDefineSketch(): void {
    if (!solverReady()) {
        set({ message: 'The solver is still loading; try again in a moment.' });
        return;
    }
    const s = get();
    const r = fullyDefine(s.geometry);
    if ('error' in r) {
        set({ message: r.error });
        return;
    }
    if (!r.added) {
        set({ message: r.dof === 0 ? 'The sketch is fully defined already.' : `No dimension could be added; ${r.dof} DOF left.` });
        return;
    }
    commit(r.g);
    const n = `Added ${r.added} dimension${r.added === 1 ? '' : 's'}`;
    set({ message: r.dof === 0 ? `${n}; the sketch is fully defined.` : `${n}; ${r.dof} DOF left.` });
}

// ---- Output -------------------------------------------------------------------------------------------

export function sketchProfiles(): { profiles: SketchProfile[]; open: number } {
    return geometryProfiles(get().geometry);
}

export function sketchEntities() {
    return geometryEntities(get().geometry);
}

/** The finished sketch: the solved profiles the kernel builds from, and the editable geometry. */
export function currentSketch(): Sketch {
    const s = get();
    // Every closed area on its own, so each extrude or cut can use just the ones picked for it.
    const regions = regionsOf(s.geometry);
    return {
        plane: s.plane,
        ...(s.offset ? { offset: s.offset } : {}),
        profiles: sketchProfiles().profiles,
        ...(regions.length ? { regions } : {}),
        // Label positions travel with their dimensions.
        geometry: {
            ...s.geometry,
            constraints: s.geometry.constraints.map((c) => (isDimension(c) && s.labels[c.id] ? { ...c, at: s.labels[c.id] } : c)),
        },
    };
}

/** Defaults for the finish popup: the edited item's values, else the intent's. */
export function finishDefaults(feature: Feature | null, base: { extrude?: { distance: number; direction?: ExtrudeDirection }; revolve?: { axis: 'u' | 'v'; angle?: number } } | null): FinishOp {
    const s = get();
    const op: FinishOp = {
        op: s.intent === 'revolve' ? 'revolve' : 'extrude',
        mode: s.intent === 'sketch' ? 'sketch' : s.intent === 'cut' ? 'cut' : 'add',
        distance: 10,
        direction: 'normal',
        through: false,
        axis: 'v',
        angle: 360,
    };
    if (feature?.op === 'sketch') {
        return { ...op, mode: 'sketch' };
    }
    if (feature?.op === 'extrude') {
        const end = feature.end ?? (feature.through ? 'throughAll' : 'blind');
        return { ...op, op: 'extrude', mode: feature.mode, distance: feature.distance ?? 10, direction: feature.direction ?? 'normal',
            through: end === 'throughAll', end, from: feature.from ?? 0,
            draft: feature.draft ?? 0, draftOutward: !!feature.draftOutward, flipSide: !!feature.flipSide, second: feature.second ?? null };
    }
    if (feature?.op === 'revolve') {
        return { ...op, op: 'revolve', mode: feature.mode, axis: feature.axis, angle: feature.angle ?? 360 };
    }
    if (base?.extrude) {
        return { ...op, op: 'extrude', mode: 'new', distance: base.extrude.distance, direction: base.extrude.direction ?? 'normal' };
    }
    if (base?.revolve) {
        return { ...op, op: 'revolve', mode: 'new', axis: base.revolve.axis, angle: base.revolve.angle ?? 360 };
    }
    return op;
}
