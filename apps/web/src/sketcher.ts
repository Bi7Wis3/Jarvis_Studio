// Sketcher state: the plane and the constrained sketch geometry (points, curves, constraints, dimensions),
// solved by PlaneGCS on every change. Local to this browser; nothing reaches the server until the sketch is
// finished and saved as a sketch step (or a feature / new part).

import { create } from 'zustand';
import type {
    ExtrudeDirection, ExtrudeEnd, ExtrudeSide, Feature, RevolveAxis, RevolveType, Sketch, SketchConstraint, SketchGeometry, SketchPlane,
    SketchProfile,
} from '@jarvis/core';
import { sketchCentrelines } from '@jarvis/core/reference';
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { useStudio } from './state';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, curveRadius, isDimension, loadSolver, measure, pointOf, solveGeometry, solverReady } from './solver';
import { openSketchRegions } from './sketchModelContours';
import { sketchOutputExtras } from './sketchDerived';
import { geometryOpenChains } from './sketchGeometry';
import {
    EMPTY_GEOMETRY, PICKS_NEEDED, addArc, addCircle, addConstraint, addLine, addPerimeterCircle, addPolygon, addRect, addRect3, addSlot,
    relationsFromPicks, tangentAt,
    curveAt, dimensionFromPicks, evaluate, geometryEntities, geometryProfiles, pickAt, placePoint, profilesToGeometry, removeItemsKeepingPoints,
    toggleConstruction, type ConstraintTool, type NewConstraint, type Pick, type PointRef, midOfPick, midPick, arcMiddle,
} from './sketchGeometry';
import {
    addCentreArc, addCentreRect, curvePoints, extendAt, mirrorCurves, notForCurve, offsetEntities,
    offsetPreview, sideDistance, splitAt, transformEntities, transformPoint, trimAt, type OffsetCap, type OffsetOptions, type Transform,
} from './sketchEdit';
import { powerTrim, trimBetween, trimCorner, trimmable, type TrimMode } from './sketchTrim';
import { closesOnItself, secondSplitPrompt } from './sketchCut';
import { joinSplitPoints } from './sketchJoin';
import { solveDrag } from './sketchDragSolve';
import { circularSketchPattern, linearSketchPattern, type CircularPatternOptions, type LinearPatternOptions } from './sketchPattern';
import { chamferSides, filletCornerAt, filletCornerOf, filletSides, notePick, pickPosition, type ChamferOptions, type FilletCorner } from './sketchFillet';
import { fixAll, fixProblem, fullyDefine, mergePoints, type Problem } from './sketchRepair';
import { collapsedCurves, unmetConstraints } from './sketchCheck';
import { dist, mid, PICKED, planeForFace, planeFrame, round, type NewEntity, type Pt } from './sketchMath';
import { snapCursor, type QuickSnap, type Snap, type SnapKind } from './snapping';
import { otherSketches } from './sketchOthers';
import { hiddenStepsNow } from './stepVisibility';
import { assemblySketches } from './sketchAssemblySnaps';
import { bringModelRef, isModelReference, loadedModel, mergeSnapGeometry, modelRefAt, modelRefEntity, modelSnapGeometry, modelTarget, useSketchModel, withoutLooseReferences, type ModelRef } from './sketchModel';
import {
    DEFAULT_DRAW_OPTIONS, LINE_ARC_IDLE, finishDrawn, lineArcMove, placeVariant, type DrawOptions, type LineArc,
} from './sketchDrawVariants';
import { isExtra, mapCurvePoints } from './sketchCurves';
import { constraintRefs, newId } from './sketchGeometry';
import { overDefines, setDriven } from './sketchDimensions';
import { moreDimensionAnchor } from './sketchDimDraw';
import { replaceEntity } from './sketchRelationEdit';
import { loadSketchSettings, saveSketchSettings, type SketchSettings } from './sketchSettings';
import { savedFinishOptions } from './options';
import { fullyDefineWith, type FullyDefineOptions } from './sketchFullyDefine';
import { finishSpline, finishStyleSpline, insertControlVertex, insertSplinePoint, placeConic, type ConicTool, type PlaceResult } from './sketchConics';
import { afterDrawn, boxStart, dragCopyStart, moreClick, moreDown, moreEscape, moreMove, moreUp, useSketchMore, zonedTangentArc, type MoreTool } from './sketchMoreTools';
import { splineClick, splineDown, splineEscape, splineMove, splineUp } from './sketchSplineTools';
import { transformWithItems } from './sketchItemTransform';
import { withoutRepeatedLocks } from './sketchLock';
import { carryItems, cutRefusal, expandOwned, ownerOf, syncItems } from './sketchItems';
import {
    clearDimensionLock, overDefiningAction, reportReverse, smartDimension, specialClick, specialPlacing, typedDimension, withDrawnDimensions,
} from './sketchDimTools';
import { alignedLabels } from './sketchDimGroups';
import { gridSnapStep, overEntityLimit } from './sketchSettings';
import { quickSnapIs, quickSnapOn, quickSnapUsed, snapKindsInForce } from './sketchQuickSnaps';
import { noSolveDrag, noSolveDrop } from './sketchNoSolve';
import { isOffsetDimension, refreshOffsets } from './sketchCurveOffset';
import { blockDrag, grabbedTarget } from './sketchBlocks';
import { pathSelection } from './sketchPathModel';
import { formForCurve } from './sketchDrawCommands';
import { openEntityForm } from './sketchEntityOpen';
import { deletePieces, withPieces } from './sketchPieces';

export type { SnapKind } from './snapping';

void loadSolver(wasmUrl);

/** What the finish popup offers first: the operation the sketch was started for. */
export type SketchIntent = 'extrude' | 'cut' | 'revolve' | 'sketch';

export type DrawTool = 'line' | 'centerline' | 'point' | 'rect' | 'centerRect' | 'circle' | 'arc' | 'centerArc' | 'slot' | 'polygon'
    | 'tangentArc' | 'perimeterCircle' | 'rect3'
    | 'midpointLine' | 'centerRect3' | 'parallelogram' | 'centerSlot' | 'arcSlot3' | 'centerArcSlot'
    | ConicTool;
/** Tools that change existing geometry. */
export type EditTool = 'trim' | 'extend' | 'fillet' | 'chamfer' | 'offset' | 'mirror' | 'split';
/** xform: picking points for Move, Copy, Rotate or Scale while their form is open. */
export type SketchTool = 'select' | DrawTool | EditTool | 'dimension' | 'xform' | `c:${ConstraintTool}` | `m:${MoreTool}`;

export type TransformKind = 'move' | 'copy' | 'rotate' | 'scale' | 'stretch';

const EDIT_TOOLS: readonly string[] = ['trim', 'extend', 'fillet', 'chamfer', 'offset', 'mirror', 'split'];
export const isEditTool = (tool: SketchTool): tool is EditTool => EDIT_TOOLS.includes(tool);

/** The operation chosen in the finish popup; drives the live preview. */
export interface FinishOp {
    op: 'extrude' | 'revolve';
    /** sketch: keep it as a sketch step of the part, for later features to use. */
    mode: 'new' | 'add' | 'cut' | 'sketch';
    distance: number;
    direction: ExtrudeDirection;
    through: boolean;
    axis: RevolveAxis;
    angle: number;
    /** Revolve options beyond axis and angle (see the revolve feature); absent: the defaults. */
    type?: RevolveType;
    reverse?: boolean;
    angle2?: number | null;
    /** Extrude options beyond distance and direction (see the extrude feature); absent: the defaults. */
    end?: ExtrudeEnd;
    from?: number;
    draft?: number;
    draftOutward?: boolean;
    flipSide?: boolean;
    second?: ExtrudeSide | null;
}

export type Selected = { type: 'point' | 'curve' | 'constraint'; id: string };

/** Options of the edit tools (the SolidWorks PropertyManager options of each). */
export interface EditOptions {
    trimMode: TrimMode;
    /** Keep trimmed entities as construction geometry. */
    trimConstruction: boolean;
    /** Ignore trimming of construction geometry. */
    trimIgnoreConstruction: boolean;
    offsetDistance: number;
    /** Add dimensions: one offset dimension. */
    offsetDimension: boolean;
    offsetReverse: boolean;
    /** Select chain: all contiguous entities, else only the picked ones. */
    offsetChain: boolean;
    offsetBoth: boolean;
    /** Cap ends of a bi-directional open offset. */
    offsetCap: OffsetCap;
    /** Construction geometry: turn the original (base) and / or the offset into construction. */
    offsetBaseConstruction: boolean;
    offsetConstruction: boolean;
    /** Keep constrained corners: the sharp corner stays as a point with its relations and dimensions. */
    filletKeepCorners: boolean;
    /** Dimension each fillet; off: an equal relation to the first one. */
    filletDimensionEach: boolean;
    chamferType: 'distance' | 'angle';
    chamferEqual: boolean;
    chamferDistance2: number;
    chamferAngle: number;
    /** Copy: keep the originals. */
    mirrorCopy: boolean;
}

export const DEFAULT_EDIT_OPTIONS: EditOptions = {
    trimMode: 'power', trimConstruction: false, trimIgnoreConstruction: false,
    offsetDistance: 5, offsetDimension: true, offsetReverse: false, offsetChain: true, offsetBoth: false, offsetCap: 'none',
    offsetBaseConstruction: false, offsetConstruction: false,
    filletKeepCorners: true, filletDimensionEach: false,
    chamferType: 'distance', chamferEqual: true, chamferDistance2: 2, chamferAngle: 45,
    mirrorCopy: true,
};

/** A dimension being placed or edited: its value input sits at `at`. */
export interface DimDraft {
    constraint: NewConstraint;
    at: Pt;
    text: string;
    /** The id of the dimension being edited, or null for a new one. */
    editing: string | null;
    error: string | null;
    /** A new dimension that would over define the sketch: the choice to make it driven or leave it driving comes first. */
    overDefining?: boolean;
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
    /** The options of the edit tools, set in their forms. */
    editOptions: EditOptions;
    /** The options of the draw tools, set in their forms. */
    drawOptions: DrawOptions;
    /** Line tool: whether moving back over the chain's end switched it to a tangent arc. */
    lineArc: LineArc;
    /** Power trim: the sketch before the stroke (for undo), where the pointer was, and the path so far. */
    trimStroke: { from: SketchGeometry; path: Pt[]; trimmed: number; slop: number } | null;
    /** Trim corner: the first line and where it was clicked; trim away inside / outside: the two boundaries. */
    trimPicks: { id: string; at: Pt }[];
    /** Fillet: the first fillet made since the tool started (later ones of the same radius are equal to it). */
    filletFirst: string | null;
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
    /** Horizontal ('u') or Vertical ('v') Dimension tool; null: Smart Dimension. */
    dimLock: 'u' | 'v' | null;
    /**
     * Horizontal or Vertical Ordinate (the zero picked, and the row the dimensions line up in) or Path Length, when
     * the dimension tool is one of those.
     */
    dimSpecial: { kind: 'ordinate'; axis: 'u' | 'v'; zero?: string; row?: number; auto?: boolean } | { kind: 'path' }
        | { kind: 'running'; centre?: string; zero?: string; radius?: number } | null;
    /** Where each dimension's label sits (sketch coordinates), when the user placed it. */
    labels: Record<string, Pt>;
    /** The sketch as it was when the drag started, for undo. */
    dragFrom: SketchGeometry | null;
    /**
     * The points being dragged, where each started, and where the pointer grabbed them; detached: the end was split
     * off what it joined for this drag (Detach segment on drag); slop: how far the pointer must go before anything
     * moves (a draw tool, where a press without a drag is the tool's click).
     */
    drag: { points: { id: string; from: Pt }[]; grab: Pt; detached?: boolean; moved?: boolean; slop?: number; rigid?: string } | null;
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
    /** Sketch settings: automatic relations and solve, drag behaviour, relation markers, snap angle. Kept in localStorage. */
    settings: SketchSettings;
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
    trimStroke: null,
    trimPicks: [],
    filletFirst: null,
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
    dimLock: null,
    dimSpecial: null,
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
    lineArc: LINE_ARC_IDLE,
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
    grid: gridSnapStep(loadSketchSettings()),
    snap: true,
    sides: 6,
    filletRadius: 5,
    chamferDistance: 2,
    editOptions: DEFAULT_EDIT_OPTIONS,
    drawOptions: DEFAULT_DRAW_OPTIONS,
    look: 0,
    showOthers: true,
    showSketches: true,
    picked: null,
    fitToSketch: false,
    anchor: [0, 0],
    snapKinds: loadSnapKinds(),
    settings: loadSketchSettings(),
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
function commit(next0: SketchGeometry, patch: Partial<SketcherState> = {}, message?: string): boolean {
    const s = get();
    // Text, pictures, equation curves and blocks ride along with tools that rebuild only points and curves.
    const next = refreshOffsets(syncItems(carryItems(s.geometry, next0)));
    if (!solverReady()) {
        set({ ...patch, geometry: next, undo: [...s.undo.slice(-80), s.geometry], redo: [], dof: -1, message: null, conflicting: [], redundant: [] });
        return true;
    }
    // Over the entity limit set in the sketch options, Automatic solve and Undo are off too.
    const limited = overEntityLimit(s.settings, next.curves.length);
    if (!s.settings.autoSolve || limited) {
        // Automatic solve off: the change is kept as it is until Solve.
        set({ ...patch, geometry: next, undo: limited ? [] : [...s.undo.slice(-80), s.geometry], redo: [], dof: -1, conflicting: [], redundant: [],
            message: message ?? (limited ? `More than ${s.settings.solveLimit} entities: automatic solve and undo are off; Solve updates the sketch.`
                : 'Automatic solve is off: Solve updates the sketch.') });
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
    // A solve can report success without meeting every relation: refuse that too.
    const unmet = unmetConstraints(result.geometry);
    if (unmet.length) {
        const names = unmet.map((id) => describe(next, id)).filter(Boolean);
        set({
            message: message ?? `Cannot solve${names.length ? `: ${names.join(', ')} would not hold` : ''}. Not applied.`,
            conflicting: unmet,
        });
        return false;
    }
    // Relations met only by shrinking a line to a point or a circle to nothing: refused as over defining.
    const was = new Set(collapsedCurves(next));
    const collapsed = collapsedCurves(result.geometry).filter((id) => !was.has(id));
    if (collapsed.length) {
        const added = next.constraints.filter((c) => !s.geometry.constraints.some((k) => k.id === c.id)).map((c) => c.id);
        const touched = new Set(collapsed.flatMap((id) => [id, ...curvePoints(curveOf(next, id)!)]));
        const holding = next.constraints.filter((c) => !added.includes(c.id) && constraintRefs(c).some((r) => touched.has(r))).map((c) => c.id);
        const name = (ids: string[]) => [...new Set(ids.map((id) => describe(next, id)).filter(Boolean))].join(', ');
        const what = curveOf(next, collapsed[0])!.kind === 'line' ? 'a line to a point' : 'a curve to nothing';
        set({
            message: message ?? `Over-constrained${added.length ? `: ${name(added)}${holding.length ? ` conflicts with ${name(holding)}` : ''}` : ''} (it would shrink ${what}). Not applied.`,
            conflicting: [...added, ...holding],
        });
        return false;
    }
    set({
        ...patch, geometry: refreshOffsets(result.geometry), undo: [...s.undo.slice(-80), s.geometry], redo: [], dof: result.dof, conflicting: [],
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
    return `Over defined: ${names.join(', ')} ${added.length === 1 ? 'repeats' : 'repeat'} what other relations already hold. Delete one of the yellow relations, or let SketchXpert find which.`;
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
        ? { geometry: refreshOffsets(result.geometry), dof: result.dof, message: overDefinedMessage(result.geometry, result.redundant), conflicting: [], redundant: result.redundant }
        : { dof: result.dof, conflicting: result.conflicting, redundant: result.redundant, message: 'The sketch is over-constrained; delete one of the red constraints.' });
}

/**
 * After undo or redo: the stored geometry comes back exactly as it was (it was solved when it was made); a solve only
 * tells its degrees of freedom and what is over defined, and moves nothing.
 */
function restored(): void {
    const s = get();
    if (!solverReady()) {
        void loadSolver(wasmUrl).then(restored);
        return;
    }
    const result = solveGeometry(s.geometry);
    set(result.ok
        ? { dof: result.dof, message: overDefinedMessage(s.geometry, result.redundant), conflicting: [], redundant: result.redundant }
        : { dof: result.dof, conflicting: result.conflicting, redundant: result.redundant, message: 'The sketch is over-constrained; delete one of the red constraints.' });
}

/** After a drag: the status from a full solve of the sketch as it now is, not from the drag's solve that held the rest. */
export function settleStatus(): void {
    restored();
}

/** Solve (with Automatic solve off): solves the sketch as it stands, or names what does not hold. */
export function solveSketch(): boolean {
    const s = get();
    if (!solverReady()) {
        set({ message: 'The solver is still loading; try again in a moment.' });
        return false;
    }
    const result = solveGeometry(s.geometry);
    const unmet = result.ok ? unmetConstraints(result.geometry) : [];
    if (!result.ok || unmet.length) {
        const bad = result.ok ? unmet : result.conflicting;
        const names = [...new Set(bad.map((id) => describe(s.geometry, id)).filter(Boolean))];
        set({ dof: result.dof, conflicting: bad, redundant: result.redundant,
            message: `Cannot solve${names.length ? `: ${names.join(', ')} ${names.length === 1 ? 'does' : 'do'} not hold` : ''}. Change or delete the red items.` });
        return false;
    }
    set({ geometry: refreshOffsets(result.geometry), undo: [...s.undo.slice(-80), s.geometry], redo: [], dof: result.dof, conflicting: [], redundant: result.redundant,
        message: overDefinedMessage(result.geometry, result.redundant) ?? 'Solved.' });
    return true;
}

/** A short human name of a constraint, for messages. */
export function describe(g: SketchGeometry, id: string): string {
    const c = g.constraints.find((k) => k.id === id);
    if (!c) {
        return '';
    }
    if (isDimension(c)) {
        const angular = c.kind === 'angle' || c.kind === 'pointAngle';
        const unit = angular ? '°' : ' mm';
        const label = c.kind === 'diameter' || (c.kind === 'distance' && c.doubled) ? 'Ø' : c.kind === 'radius' ? 'R' : angular ? 'angle '
            : c.kind === 'arcLength' ? 'arc ' : '';
        return `${label}${round(c.value, 1e-4)}${unit}${c.driven ? ' (driven)' : ''}`;
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
    set((s) => ({ plane, offset: round(offset), stage: 'draw', tool: 'line', look: s.look + 1, fitToSketch: false, notice, anchor }));
}

/** Sketch on the planar face under the cursor: its axis-aligned plane and offset, in the part frame. */
export function chooseFace(normal: [number, number, number], point: [number, number, number], curved = false): void {
    const { plane, offset } = planeForFace(normal, point, curved);
    const f = planeFrame(plane, offset, get().context);
    const rel = [0, 1, 2].map((i) => point[i] - f.origin[i]);
    const anchor: Pt = [round(rel[0] * f.u[0] + rel[1] * f.u[1] + rel[2] * f.u[2], PICKED), round(rel[0] * f.v[0] + rel[1] * f.v[1] + rel[2] * f.v[2], PICKED)];
    choosePlane(plane, offset, curved ? 'Sketching on the tangent plane of a curved face.' : null, anchor);
}

/** Whether the last sketch was left without keeping it (the view then goes back to where it was; see Scene.tsx). */
let lastLeftDiscarded = false;
export const sketchWasDiscarded = (): boolean => lastLeftDiscarded;

/** Leaves the sketch; `discarded` when its changes are not kept (Discard, or cancelling while choosing the plane). */
export function closeSketch(discarded = false): void {
    lastLeftDiscarded = discarded;
    set({ ...IDLE });
    useStudio.setState({ mode: 'select' });
}

export function setTool(tool: SketchTool): void {
    // Mirror starts from the curves already selected.
    const picks = tool === 'mirror' ? get().selection.filter((x): x is Pick => x.type === 'curve') : [];
    set({
        tool, draft: [], chainStart: null, typed: '', picks, hover: null, dimDrag: null, dimDraft: null, message: null,
        editPreview: [], editText: null, offsetCurve: null, mirrorAbout: false, arcSweep: 0, ...(tool === 'xform' ? {} : { xform: null }),
        trimStroke: null, trimPicks: [], filletFirst: null, lineArc: LINE_ARC_IDLE,
    });

}

/** An edit tool's form opened: the tool starts from the current selection where it can use it (pre-selection). */
export function startEditTool(tool: EditTool): void {
    sizeErrors = [];
    const selected = get().selection;
    setTool(tool);
    const curves = selected.filter((x): x is Pick => x.type === 'curve');
    if (tool === 'offset' && curves.length) {
        set({ offsetCurve: curves[0].id, picks: curves });
    }
    if (tool === 'fillet' || tool === 'chamfer') {
        // Selected corner points, or two selected curves, are filleted with OK.
        const used = new Set(get().geometry.curves.flatMap(curvePoints));
        const corners = selected.filter((x): x is Pick => x.type === 'point' && used.has(x.id));
        set({ picks: [...corners, ...curves.slice(0, 2)] });
    }
    if (tool === 'mirror') {
        set({ picks: curves });
    }
}

/**
 * The edit tool form's OK: applies what is waiting (an offset, the selected corners, a mirror) and returns an error
 * to show, or null to close the form.
 */
export function finishEditTool(tool: EditTool): string | null {
    const s = get();
    if ((tool === 'offset' || tool === 'fillet' || tool === 'chamfer') && sizeErrors.length && (tool !== 'offset' || s.offsetCurve)) {
        set({ message: sizeErrors[0] });
        return sizeErrors[0];
    }
    if (tool === 'offset' && s.offsetCurve) {
        // The form's distance, on the side the pointer was last (left of the chain without one), Reverse flips it.
        const side = s.cursor ? Math.sign(sideDistance(s.geometry, s.offsetCurve, s.cursor, offsetAllowed(s))) || 1 : 1;
        const o = s.editOptions;
        applyOffset(side * (o.offsetReverse ? -1 : 1) * Math.abs(o.offsetDistance));
        return get().offsetCurve ? get().message ?? 'The offset could not be applied.' : null;
    }
    if (tool === 'fillet' || tool === 'chamfer') {
        const size = tool === 'fillet' ? s.filletRadius : s.chamferDistance;
        const points = s.picks.filter((p) => p.type === 'point').map((p) => p.id);
        const curves = s.picks.filter((p) => p.type === 'curve').map((p) => p.id);
        const errors: string[] = [];
        for (const id of points) {
            const corner = filletCornerAt(get().geometry, id);
            if ('error' in corner) {
                errors.push(corner.error);
            } else if (!applyCorner(tool, corner, size)) {
                errors.push(get().message ?? 'Not applied.');
            }
        }
        if (curves.length === 2) {
            const corner = filletCornerOf(get().geometry, curves[0], curves[1]);
            if ('error' in corner) {
                errors.push(corner.error);
            } else if (!applyCorner(tool, corner, size)) {
                errors.push(get().message ?? 'Not applied.');
            }
        }
        set({ picks: [] });
        return errors.length ? errors[0] : null;
    }
    return null;
}

/** What is wrong with the open edit form's sizes (a radius or distance of 0 or below, or not a number); empty: fine. */
let sizeErrors: string[] = [];

/** The edit form says which of its sizes cannot be used: fillet, chamfer and offset do nothing until they can. */
export function setSizeErrors(errors: string[]): void {
    const was = sizeErrors;
    sizeErrors = errors;
    if (errors.length) {
        set({ message: errors[0] });
    } else if (was.includes(get().message ?? '')) {
        set({ message: null });
    }
}

/** Changes edit tool options (from the tool's form). */
export function setEditOptions(patch: Partial<EditOptions> & { filletRadius?: number; chamferDistance?: number }): void {
    const { filletRadius, chamferDistance, ...options } = patch;
    set((s) => ({
        editOptions: { ...s.editOptions, ...options },
        trimPicks: patch.trimMode ? [] : s.trimPicks,
        picks: patch.trimMode ? [] : s.picks,
        ...(filletRadius && filletRadius > 0 ? { filletRadius } : {}),
        ...(chamferDistance && chamferDistance > 0 ? { chamferDistance } : {}),
    }));
}

/** Changes draw tool options (from the tool's form). */
export function setDrawOptions(patch: Partial<DrawOptions>): void {
    set((s) => ({ drawOptions: { ...s.drawOptions, ...patch, construction: { ...s.drawOptions.construction, ...patch.construction } } }));
}

/** Solves and applies geometry changed outside the tools (a form's parameters); false when it would not solve. */
export function commitGeometry(next: SketchGeometry, message?: string): boolean {
    return commit(next, {}, message);
}

/** A in the line tool: switches the next piece of the chain between a line and a tangent arc. */
export function toggleLineArc(): boolean {
    const s = get();
    const end = s.draft[0]?.point;
    if (s.tool !== 'line' || s.draft.length !== 1 || !end || !tangentAt(s.geometry, end)) {
        return false;
    }
    set({ lineArc: { arc: !s.lineArc.arc, phase: 'out' } });
    return true;
}

/**
 * The sketch plane an undo or redo entry was made on, kept for the steps that move the plane (Modify sketch), so
 * undo and redo put the plane back with the geometry.
 */
const frames = new WeakMap<SketchGeometry, { plane: SketchPlane; offset: number }>();

/** The entry `g` (on the undo stack) was made with the sketch on `frame`. */
export function recordFrame(g: SketchGeometry, frame: { plane: SketchPlane; offset: number }): void {
    frames.set(g, frame);
}

/** Steps back to `target`; the plane goes back too when the step moved it. */
function stepTo(s: SketcherState, target: SketchGeometry): Partial<SketcherState> {
    const frame = frames.get(target);
    if (!frame) {
        return {};
    }
    frames.set(s.geometry, { plane: s.plane, offset: s.offset });
    return { plane: frame.plane, offset: frame.offset, look: s.look + 1, fitToSketch: true };
}

export function undoSketch(): void {
    set((s) => (s.undo.length
        ? {
            ...stepTo(s, s.undo[s.undo.length - 1]),
            geometry: s.undo[s.undo.length - 1], undo: s.undo.slice(0, -1), redo: [...s.redo, s.geometry],
            draft: [], chainStart: null, selection: [], picks: [], dimDraft: null, editPreview: [], offsetCurve: null, mirrorAbout: false,
        }
        : {}));
    restored();
}

export function redoSketch(): void {
    set((s) => (s.redo.length
        ? {
            ...stepTo(s, s.redo[s.redo.length - 1]),
            geometry: s.redo[s.redo.length - 1], redo: s.redo.slice(0, -1), undo: [...s.undo, s.geometry],
            draft: [], chainStart: null, selection: [], picks: [], dimDraft: null, editPreview: [], offsetCurve: null, mirrorAbout: false,
        }
        : {}));
    restored();
}

export function deleteSelected(): void {
    // Pieces of curves selected with Alt go as Trim to closest takes them (sketchPieces.ts).
    if (deletePieces()) {
        return;
    }
    const { selection, geometry } = get();
    if (selection.length) {
        // A split point joins its two pieces again (sketchJoin.ts) instead of taking them with it.
        const join = joinSplitPoints(geometry, selection.filter((s) => s.type === 'point').map((s) => s.id));
        const ids = selection.map((s) => s.id).filter((id) => !join.joined.includes(id));
        // A curve of a text, equation curve or block instance takes the whole item with it.
        commit(removeItemsKeepingPoints(join.g, expandOwned(join.g, ids)), { selection: [] });
    }
}

/**
 * A form that picks places in the view (where sketch text starts, the scale points on a picture) takes the clicks
 * and pointer moves while it is set; click returns true when it took the click.
 */
let viewPicker: { click: (raw: Pt, tolerance: number) => boolean; move?: (raw: Pt) => void } | null = null;

export function setViewPicker(picker: typeof viewPicker): void {
    viewPicker = picker;
}

export function toggleConstructionSelected(): void {
    if (withPieces(toggleConstructionSelected)) {
        return;
    }
    const { selection, geometry } = get();
    const curves = selection.filter((s) => s.type === 'curve').map((s) => s.id);
    if (curves.length) {
        commit(toggleConstruction(geometry, curves));
    } else {
        set({ message: 'Select lines, arcs or circles to turn into construction geometry.' });
    }
}

// ---- Snapping -----------------------------------------------------------------------------------------

/** The part's other sketches seen from the plane being sketched on, worked out once per sketch plane and history. */
let othersMemo: { context: Feature[]; plane: SketchPlane; offset: number; hidden: ReadonlySet<string>; scene: unknown; g: SketchGeometry } | null = null;

function othersToSnap(s: SketcherState): SketchGeometry | undefined {
    // The model's edges and vertices too, when the sketch setting "Snap to model geometry" is on (sketchModel.ts).
    const target = modelTarget(s);
    return mergeSnapGeometry(sketchesToSnap(s), modelSnapGeometry(target, target ? useStudio.getState().meshes.keys[target.partId] ?? null : null));
}

function sketchesToSnap(s: SketcherState): SketchGeometry | undefined {
    // Only what is on screen can be aimed for: the sketches shown, without the ones hidden one by one.
    // In the assembly, the other parts' shown sketches too (sketchAssemblySnaps.ts).
    const studio = useStudio.getState();
    const scene = studio.workspace === 'assembly' ? studio.project : null;
    if (!s.showSketches || (!s.context.length && !scene)) {
        return undefined;
    }
    const partId = s.edit?.partId ?? s.partId;
    const hidden = hiddenStepsNow();
    if (!othersMemo || othersMemo.context !== s.context || othersMemo.plane !== s.plane || othersMemo.offset !== s.offset || othersMemo.hidden !== hidden
        || othersMemo.scene !== scene) {
        const others = scene && partId ? assemblySketches(scene, studio.history?.parts ?? scene.parts, partId, hidden) : [];
        const g = otherSketches(s.context, s.plane, s.offset, (id) => hidden.has(`${partId}/${id}`), others);
        othersMemo = { context: s.context, plane: s.plane, offset: s.offset, hidden, scene, g };
    }
    return othersMemo.g;
}

function snapAt(raw: Pt, tolerance: number): Snap {
    const s = get();
    const snapped = snapCursor(s.geometry, raw, {
        // A quick snap works with snapping off too; the grid snap only while the grid shows (unless set otherwise).
        enabled: s.snap || quickSnapOn(), grid: s.grid, tolerance, last: s.draft[s.draft.length - 1]?.at,
        kinds: snapKindsInForce(s.snapKinds, s.settings.gridDisplay || !s.settings.gridSnapOnlyShown), others: othersToSnap(s),
        lastPoint: s.draft[s.draft.length - 1]?.point, woken, angleStep: s.settings.snapAngle, lengthSnap: modifiers.shift || quickSnapIs('length'),
        drawsLine: (s.tool === 'line' || s.tool === 'centerline' || s.tool === 'midpointLine') && s.draft.length > 0 && !s.lineArc.arc,
    });
    // Automatic relations off, or Ctrl held: the cursor still snaps, but nothing it snapped to becomes a relation.
    return s.settings.autoRelations && !modifiers.ctrl ? snapped : withoutRelations(snapped);
}

/**
 * The relation a line drawn with an inferred direction takes on (parallel, perpendicular, tangent), left out when
 * it would not solve with what is there.
 */
function withInferred(g: SketchGeometry, line: string, infer: NonNullable<PointRef['infer']>): SketchGeometry {
    if (!curveOf(g, infer.to)) {
        return g;
    }
    const next = addConstraint(g, { kind: infer.kind, a: infer.to, b: line }).g;
    if (!solverReady()) {
        return next;
    }
    const r = solveGeometry(next);
    return r.ok && !unmetConstraints(r.geometry).length && r.redundant.length <= solveGeometry(g).redundant.length ? next : g;
}

/** Keys held with the pointer: Shift (length snap) and Ctrl (no automatic relations for this click). */
const modifiers = { shift: false, ctrl: false };

/** Lines the pointer passed over lately while drawing ("woken" snaps: parallel and perpendicular to them). */
let woken: string[] = [];

/** A snap without the relations it would add: a free point where it snapped, inferences shown as plain alignment. */
function withoutRelations(snap: Snap): Snap {
    const inferring = snap.kind === 'horizontal' || snap.kind === 'vertical' || snap.kind === 'parallel' || snap.kind === 'perpendicular' || snap.kind === 'tangent';
    return { ...snap, kind: inferring ? 'aligned' : snap.kind, ref: { at: snap.ref.at } };
}

/** Changes sketch settings (Tools > Sketch Settings); kept in this browser. */
export function setSketchSettings(patch: Partial<SketchSettings>): void {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    saveSketchSettings(settings);
    if (patch.autoSolve === true) {
        resolve();
    }
}

// ---- Pointer input ------------------------------------------------------------------------------------

/** Pointer moved to raw sketch point `raw`; `tolerance` is a few pixels in mm. `keys`: Shift and Ctrl held. */
export function sketchMove(raw: Pt, tolerance: number, screenX?: number, keys?: { shift?: boolean; ctrl?: boolean }): void {
    const s = get();
    modifiers.shift = !!keys?.shift;
    modifiers.ctrl = !!keys?.ctrl;
    if (splineMove(raw, tolerance)) {
        return;
    }
    if (s.tool !== 'select' && s.tool !== 'dimension' && !s.tool.startsWith('c:') && !isEditTool(s.tool) && !s.drag) {
        // Passing over a line wakes it: the next line can be made parallel or square to it.
        const over = curveAt(s.geometry, raw, tolerance, 0);
        if (over && curveOf(s.geometry, over.id)?.kind === 'line' && woken[0] !== over.id) {
            woken = [over.id, ...woken.filter((id) => id !== over.id)].slice(0, 2);
        }
    }
    if (s.drag) {
        if (s.drag.slop && !s.drag.moved && dist(s.drag.grab, raw) <= s.drag.slop) {
            return;
        }
        if (s.settings.noSolveMove) {
            noSolveDrag(raw);
            return;
        }
        if (solverReady()) {
            const result = dragTo(s.geometry, s.drag, raw, s.settings.overrideDims);
            if (result) {
                set({ geometry: refreshOffsets(result.geometry, true), dof: result.dof, cursor: raw, ...(s.drag.moved ? {} : { drag: { ...s.drag, moved: true } }) });
            }
        }
        return;
    }
    if (s.trimStroke) {
        const path = s.trimStroke.path;
        const last = path[path.length - 1];
        if (path.length === 1 && dist(path[0], raw) <= s.trimStroke.slop) {
            // Not a drag yet: a click trims on release instead.
            set({ cursor: raw });
            return;
        }
        const { trimConstruction, trimIgnoreConstruction } = s.editOptions;
        const r = powerTrim(s.geometry, last, raw, { construction: trimConstruction, ignoreConstruction: trimIgnoreConstruction });
        const trail = [...path, raw];
        set({
            geometry: r.g, cursor: raw, trimStroke: { ...s.trimStroke, path: trail, trimmed: s.trimStroke.trimmed + r.trimmed },
            editPreview: trail.slice(1).map((p, i): NewEntity => ({ kind: 'line', a: trail[i], b: p })), editText: null, hover: null,
        });
        return;
    }
    viewPicker?.move?.(raw);
    // Mirror, offset and the line boxes of the forms take a model edge too: light up the one under the cursor.
    const takes = modelEdgeUse(s);
    if (takes || (useSketchModel.getState().hover && !s.tool.startsWith('c:') && s.tool !== 'dimension' && s.tool !== 'select')) {
        const ref = takes ? modelRefUnder(s, raw, tolerance) : null;
        useSketchModel.setState({ hover: ref && fitsUse(ref, takes) ? modelRefEntity(ref, tolerance * 0.35) : null });
    }
    // Box selection, dynamic mirror, jog and the other tools of sketchMoreTools.ts.
    if (moreMove(raw, tolerance, screenX)) {
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
    // Model edges and corners can be picked by these tools too: light up the one under the cursor.
    const model = (picking || s.tool === 'select') && !hover && !s.dimDrag && !s.dimDraft && !s.drag ? modelRefUnder(get(), raw, tolerance) : null;
    if (model || useSketchModel.getState().hover) {
        useSketchModel.setState({ hover: modelRefEntity(model, tolerance * 0.35) });
    }
    if (s.tool === 'xform') {
        set({ editPreview: xformPreview(s, snapped.p) });
    }
    if (s.tool === 'line' && s.draft.length === 1 && s.draft[0].point) {
        // Back over the chain's end and away again: the next piece is a tangent arc (or a line again).
        const next = lineArcMove(s.lineArc, dist(raw, s.draft[0].at), tolerance, !!tangentAt(s.geometry, s.draft[0].point));
        if (next !== s.lineArc) {
            set({ lineArc: next });
        }
    }
    if (s.tool === 'partialEllipse' && s.draft.length === 3) {
        // As the centre-point arc: follow the cursor round from the start, either way.
        const [c, , start] = s.draft.map((d) => d.at);
        const before = Math.atan2(start[1] - c[1], start[0] - c[0]) + s.arcSweep;
        const now = Math.atan2(snapped.p[1] - c[1], snapped.p[0] - c[0]);
        set({ arcSweep: s.arcSweep + Math.atan2(Math.sin(now - before), Math.cos(now - before)) });
    }
    if ((s.tool === 'centerArc' || s.tool === 'centerArcSlot') && s.draft.length === 2) {
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
function dragTo(g: SketchGeometry, drag: NonNullable<SketcherState['drag']>, raw: Pt, overrideDims = false): { geometry: SketchGeometry; dof: number } | null {
    if (overrideDims) {
        // Override dimensions on drag: the driving dimensions on what is dragged give way and take the sizes it is dragged to.
        const released = releasedDimensions(g, drag.points.map((p) => p.id));
        if (released.size) {
            const loose = { ...g, constraints: g.constraints.map((c) => (released.has(c.id) ? { ...c, driven: true } as SketchConstraint : c)) };
            const r = dragTo(loose, drag, raw);
            return r && {
                ...r,
                geometry: { ...r.geometry, constraints: r.geometry.constraints.map((c) => {
                    if (!released.has(c.id)) {
                        return c;
                    }
                    const { driven: _d, ...rest } = c as SketchConstraint & { driven?: boolean };
                    return rest as SketchConstraint;
                }) },
            };
        }
    }
    const delta: Pt = [raw[0] - drag.grab[0], raw[1] - drag.grab[1]];
    const targets = drag.points.map(({ id, from }) => ({ point: id, u: from[0] + delta[0], v: from[1] + delta[1] }));
    const dragged = new Set(drag.points.map((p) => p.id));
    const attached = new Set(g.curves.flatMap((c) => {
        const ids = curvePoints(c);
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
        const result = solveDrag(g, { targets, hold }, drag.grab);
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
    // A block instance that cannot slide turns about what holds it: only the grabbed point is pulled.
    const pull = drag.rigid ? grabbedTarget(drag, drag.rigid, raw) : null;
    const turned = pull ? solveGeometry(g, { targets: [pull], hold: new Set(others) }) : null;
    if (pull && turned?.ok && (!best || Math.hypot(pointOf(turned.geometry, pull.point)!.u - pull.u, pointOf(turned.geometry, pull.point)!.v - pull.v) < best.off)) {
        return turned;
    }
    return best;
}

/** A draw tool with nothing begun: a press on a point or curve drags it, as with the select tool. */
function idleDrawTool(s: SketcherState): boolean {
    const t = s.tool;
    if (t === 'select' || t === 'dimension' || t === 'xform' || t.startsWith('c:') || t.startsWith('m:') || isEditTool(t)) {
        return false;
    }
    return !s.draft.length && !s.picks.length && !viewPicker && !pendingInsert && !pendingReplace && !useSketchModel.getState().picking;
}

/**
 * Pointer pressed: in the select tool, and in a draw tool with nothing begun, start dragging the point (or nearest
 * end of the curve) under it; in the dimension tool, start dragging a dimension out of the geometry under it.
 * True when the press is the sketch's: the view must not move with it.
 */
export function sketchDown(raw: Pt, tolerance: number, screenX?: number): boolean {
    const was = get();
    if (was.stage === 'draw' && was.tool === 'dimension' && !was.dimDraft && !dimensionPlacing(was)) {
        // A model edge or corner pressed on comes into the sketch first (see bringModelUnder).
        bringModelUnder(raw, tolerance);
    }
    const s = get();
    if (s.stage !== 'draw') {
        return false;
    }
    if (splineDown(raw, tolerance)) {
        return true;
    }
    if (s.tool === 'dimension') {
        // Ordinate and path length dimensions are placed by clicks only.
        const pick = s.dimDraft || s.dimSpecial ? null : dimensionPick(s.geometry, raw, tolerance);
        if (!pick) {
            return false;
        }
        // With one pick waiting, this is the second; otherwise it starts over.
        const picks = s.picks.length === 1 && s.picks[0].id !== pick.id ? [...s.picks, pick] : [pick];
        if (!dimensionFromPicks(s.geometry, picks, raw, s.dimLock)) {
            return false;
        }
        set({ dimDrag: { picks, from: raw, slop: tolerance * 0.4 }, cursor: raw, hover: null });
        return true;
    }
    if (s.tool === 'trim' && s.editOptions.trimMode === 'power') {
        // Power trim: the press starts a stroke (not a camera orbit); a press without a drag stays a click.
        set({ trimStroke: { from: s.geometry, path: [raw], trimmed: 0, slop: tolerance * 0.4 } });
        return true;
    }
    const drawing = s.tool !== 'select';
    if (drawing && !idleDrawTool(s)) {
        return false;
    }
    const pick = pickAt(s.geometry, raw, tolerance);
    if (!pick) {
        // Select tool: on empty space the press starts a selection box (SolidWorks box and cross selection).
        return drawing ? false : moreDown(raw, tolerance) || boxStart(raw, tolerance, screenX);
    }
    if (pick.id === ORIGIN || pick.id.startsWith('axis-')) {
        // Nothing to drag, and the view stays put.
        return true;
    }
    // Ctrl-drag copies the entity (or the selection it is in), Shift-drag moves it (sketchMoreTools.ts).
    if (!drawing && (modifiers.ctrl || modifiers.shift) && dragCopyStart(raw, tolerance, pick.id, modifiers.ctrl)) {
        return true;
    }
    // A point moves alone; a line moves as a whole (both ends); a circle or arc by its centre.
    const curve = pick.type === 'curve' ? curveOf(s.geometry, pick.id) : null;
    // A block instance moves as one rigid body (sketchBlocks.ts).
    const rigid = blockDrag(s.geometry, pick.id, raw);
    // Detach segment on drag: an end shared with other curves comes away with the selected (else the newest) curve.
    const detached = pick.type === 'point' && s.settings.detachOnDrag && !rigid ? detachEnd(s.geometry, pick.id, s.selection) : null;
    const g = detached?.g ?? s.geometry;
    // Ellipses, splines, parabolas and conics move as a whole, by all their points.
    const ids = detached ? [detached.point] : pick.type === 'point' ? [pick.id]
        : curve?.kind === 'line' || isExtra(curve) ? curvePoints(curve!) : curve ? [curve.center] : [];
    const points = rigid?.points ?? ids.flatMap((id) => {
        const p = pointOf(g, id);
        return p && !p.fixed && id !== ORIGIN ? [{ id, from: [p.u, p.v] as Pt }] : [];
    });
    if (!points.length) {
        // Locked: it does not move, and the press is not a turn of the view either.
        return true;
    }
    // In a draw tool the press may be its click: nothing moves until the pointer has gone a few pixels.
    set({ geometry: g, drag: { points, grab: raw, ...(detached ? { detached: true } : {}), ...(drawing ? { slop: tolerance * 0.4 } : {}), ...(rigid ? { rigid: rigid.grabbed } : {}) }, dragFrom: s.geometry });
    return true;
}

/** The driving dimensions on these points or on curves built on them (what a drag of them would change). */
function releasedDimensions(g: SketchGeometry, points: string[]): Set<string> {
    const moving = new Set(points);
    for (const c of g.curves) {
        if (curvePoints(c).some((p) => moving.has(p))) {
            moving.add(c.id);
        }
    }
    return new Set(g.constraints.filter((c) => isDimension(c) && !c.driven && !c.suppressed && constraintRefs(c).some((r) => moving.has(r))).map((c) => c.id));
}

/** Splits an end point that several curves share: the selected curve (else the newest) gets a point of its own there. */
function detachEnd(g: SketchGeometry, point: string, selection: Selected[]): { g: SketchGeometry; point: string } | null {
    const users = g.curves.filter((c) => curvePoints(c).includes(point));
    const p = pointOf(g, point);
    if (users.length < 2 || !p || point === ORIGIN) {
        return null;
    }
    const chosen = users.find((c) => selection.some((x) => x.type === 'curve' && x.id === c.id)) ?? users[users.length - 1];
    if (curveCentreOf(chosen) === point) {
        return null;
    }
    const id = newId('p', g);
    const moved = mapCurvePoints(chosen, (x) => (x === point ? id : x));
    return {
        g: { ...g, points: [...g.points, { id, u: p.u, v: p.v }], curves: g.curves.map((c) => (c.id === chosen.id ? moved : c)) },
        point: id,
    };
}

const curveCentreOf = (c: SketchGeometry['curves'][number]): string | null => ('center' in c ? c.center : null);

export function sketchUp(mods: { shift?: boolean; ctrl?: boolean } = {}): void {
    if (splineUp()) {
        return;
    }
    if (moreUp(mods)) {
        return;
    }
    const s = get();
    if (s.trimStroke) {
        const { from, trimmed } = s.trimStroke;
        const after = s.geometry;
        // The whole stroke is one undo step; the trimmed sketch is solved and checked like any edit.
        set({ trimStroke: null, editPreview: [], geometry: from });
        if (trimmed && commit(after, { selection: [] })) {
            set({ message: `Trimmed ${trimmed} piece${trimmed === 1 ? '' : 's'}.` });
        }
        return;
    }
    if (s.drag && s.settings.noSolveMove && noSolveDrop()) {
        return;
    }
    if (s.drag) {
        // A detached end that was not dragged anywhere joins again.
        if (s.drag.detached && s.dragFrom && !s.drag.moved) {
            set({ drag: null, dragFrom: null, geometry: s.dragFrom });
            return;
        }
        // One undo step for the whole drag, and none for a press that moved nothing.
        const moved = s.dragFrom && s.dragFrom !== s.geometry;
        set({ drag: null, dragFrom: null, ...(moved ? { geometry: refreshOffsets(s.geometry), undo: [...s.undo.slice(-80), s.dragFrom!], redo: [] } : {}) });
        if (moved) {
            settleStatus();
        }
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
    // An ordinate row or an angular running set moves together (unless its alignment was broken).
    set((s) => ({ labels: alignedLabels(s.geometry, s.labels, (c) => dimensionAnchor(s.geometry, c), id, at) }));
}

export function sketchClick(raw: Pt, tolerance: number, additive = false, ctrl = false): void {
    const s = get();
    if (s.dimDraft) {
        return;
    }
    if (viewPicker?.click(raw, tolerance)) {
        return;
    }
    if (splineClick()) {
        return;
    }
    // Shift: length snap while drawing; Ctrl: this click adds no automatic relations.
    modifiers.shift = additive;
    modifiers.ctrl = ctrl;
    if (s.tool === 'select' && pendingInsert) {
        insertAt(raw);
        return;
    }
    if (s.tool === 'select' && pendingReplace) {
        replaceAt(raw, tolerance);
        return;
    }
    const takes = modelEdgeUse(s);
    if (takes) {
        // A model edge (or an entity of another sketch) is copied in first, then the tool picks it as usual.
        bringModelUnder(raw, tolerance, takes);
    }
    if (moreClick(raw, tolerance)) {
        return;
    }
    if (s.tool === 'select') {
        // A model edge or corner, or an entity of another sketch, comes into the sketch and is selected.
        bringModelUnder(raw, tolerance);
        selectAt(raw, tolerance, additive);
        return;
    }
    if (s.tool === 'dimension') {
        dimensionClick(raw, tolerance, additive);
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
function selectAt(raw: Pt, tolerance: number, shift: boolean): void {
    const s = get();
    const pick = pickAt(s.geometry, raw, tolerance);
    // With the Add Relations form open, clicks add to the selection, and the origin and axes can be picked too.
    const additive = shift || relationPicking;
    const item: Selected | null = pick && (relationPicking || (pick.id !== AXIS_U && !pick.id.startsWith('axis-') && pick.id !== ORIGIN)) ? pick : null;
    // A curve of a path selects the whole path (sketchPathModel.ts).
    const members = item?.type === 'curve' ? pathSelection(s.geometry, item.id) : null;
    if (members) {
        const all = members.map((id): Selected => ({ type: 'curve', id }));
        const on = s.selection.some((x) => x.id === item!.id);
        set({ selection: additive ? (on ? s.selection.filter((x) => !members.includes(x.id)) : [...s.selection.filter((x) => !members.includes(x.id)), ...all]) : all });
        if (!additive) {
            openCurveForm(s.geometry, item!.id);
        }
        return;
    }
    set({ selection: item ? (additive ? toggle(s.selection, item) : [item]) : additive ? s.selection : [] });
    // A model edge or vertex is only selected (for a relation, a dimension or Convert): it has no form of its own.
    if (item?.type === 'curve' && !additive && !isModelReference(item.id)) {
        openCurveForm(s.geometry, item.id);
    }
    if (item?.type === 'point' && !additive && !isModelReference(item.id)) {
        openEntityForm(s.geometry, item);
    }

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
    const { tool, draft, sides, geometry: g, chainStart, drawOptions, lineArc, arcSweep } = get();
    const last = draft[draft.length - 1];
    if (last && dist(ref.at, last.at) < 1e-6) {
        return;
    }
    set({ lineArc: LINE_ARC_IDLE });
    // Every tool's result goes through the form options that apply to anything drawn (construction, rectangle lines).
    const commit = (next: SketchGeometry, patch: Partial<SketcherState> = {}) => commitDrawn(tool, g, next, patch);
    const variant = placeVariant({
        tool, g, draft, ref, kind, options: drawOptions, sides, sweep: arcSweep, typed, chainStart, lineArc: lineArc.arc,
    });
    if (variant) {
        if ('error' in variant) {
            set({ message: variant.error, typed: '' });
        } else if ('g' in variant) {
            commit(variant.g, { draft: variant.draft, chainStart: variant.chainStart, typed: '', arcSweep: 0 });
        } else {
            set({ draft: variant.draft, typed: '', arcSweep: 0, message: null });
        }
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
            const plain = addLine(g, last, ref, infer);
            const drawn = ref.infer ? { ...plain, g: withInferred(plain.g, plain.id, ref.infer) } : plain;
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
                // Nothing drawn: no width or no height. The first corner stays for another try.
                set({ message: FLAT_RECT, typed: '' });
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
                // Nothing drawn: no width or no height. The first corner stays for another try.
                set({ message: FLAT_RECT, typed: '' });
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
            // Tangent or normal, forwards or back: the intent zone the pointer left the end point by.
            const r = zonedTangentArc(g, last.point!, ref);
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
            } else {
                set({ message: 'The rectangle would have no width: click the last corner off the line of the first side.', typed: '' });
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
        case 'ellipse':
        case 'partialEllipse':
        case 'spline':
        case 'styleSpline':
        case 'parabola':
        case 'conic': {
            if (draft.length === 1 && (tool === 'ellipse' || tool === 'partialEllipse')) {
                typedRadius1 = typed?.[0] !== undefined ? Math.abs(typed[0]) : null;
            }
            const r = placeConic(tool as ConicTool, g, draft, ref, get().arcSweep);
            if (tool === 'partialEllipse' && 'draft' in r && r.draft.length === 3) {
                set({ arcSweep: 0 });
            }
            const radius2 = (tool === 'ellipse' || tool === 'partialEllipse') && 'g' in r && typed?.[0] !== undefined ? Math.abs(typed[0]) : null;
            placedConic(tool as ConicTool, r, radius2);
            return;
        }
    }
}

/**
 * Sets a curve's points (as far as its relations let them go) and its own values, from its PropertyManager. Returns
 * an error to show, or null.
 */
export function editCurve(id: string, targets: { point: string; u: number; v: number }[], patch: Record<string, unknown> = {}): string | null {
    const s = get();
    const g: SketchGeometry = { ...s.geometry, curves: s.geometry.curves.map((c) => (c.id === id ? { ...c, ...patch } as typeof c : c)) };
    const moving = targets.filter((t) => {
        const p = pointOf(g, t.point);
        return p && Math.hypot(p.u - t.u, p.v - t.v) > 1e-12;
    });
    if (!moving.length) {
        return commit(g) ? null : get().message;
    }
    if (!solverReady()) {
        return 'The solver is still loading; try again in a moment.';
    }
    const r = solveGeometry(g, { targets: moving });
    const miss = r.ok ? Math.max(...moving.map((t) => {
        const p = pointOf(r.geometry, t.point);
        return p ? Math.hypot(p.u - t.u, p.v - t.v) : 0;
    })) : Infinity;
    if (miss > 1e-6) {
        return 'Its relations and dimensions do not let it go there; change or delete them first.';
    }
    return commit(r.geometry) ? null : get().message;
}

/** Makes `next` the sketch (solved and checked as any edit); returns an error to show, or null. */
export function replaceGeometry(next: SketchGeometry): string | null {
    return commit(next) ? null : get().message ?? 'Not applied.';
}

/** Opens the PropertyManager of an ellipse, spline, parabola or conic in the left panel. */
function openCurveForm(g: SketchGeometry, id: string): void {
    const c = curveOf(g, id);
    // A curve of a text, equation curve or block instance opens the item's form instead.
    const owner = ownerOf(g, id);
    if (owner && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: OWNER_FORMS[owner.kind] }));
        return;
    }
    if (isExtra(c) && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: `sk-pm-${c.kind}` }));
    }
    // A path, a belt or a slot opens its PropertyManager (sketchDrawCommands.ts).
    const form = formForCurve(g, id);
    if (form && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: form }));
    }
    // A line, circle or arc opens its own PropertyManager (sketchEntityForms.tsx).
    if (!form && !isExtra(c)) {
        openEntityForm(g, { type: 'curve', id });
    }
}

const OWNER_FORMS = { text: 'sk-text', equation: 'sk-equation-curve', insert: 'sk-block-insert', offset: '' } as const;

/** Insert Spline Point / Insert Control Vertex: the curve the next click in the view adds a point to. */
let pendingInsert: string | null = null;

/** Starts Insert Spline Point (a spline) or Insert Control Vertex (a style spline): the next click adds the point. */
export function startInsertPoint(curveId: string): void {
    const c = curveOf(get().geometry, curveId);
    if (c?.kind !== 'spline' && c?.kind !== 'styleSpline') {
        set({ message: 'Select a spline or a style spline first.' });
        return;
    }
    setTool('select');
    pendingInsert = curveId;
    set({ message: c.kind === 'spline' ? 'Click on the spline where the new spline point goes.' : 'Click on the control polygon where the new control vertex goes.' });
}

function insertAt(raw: Pt): void {
    const id = pendingInsert!;
    pendingInsert = null;
    const g = get().geometry;
    const c = curveOf(g, id);
    const r = c?.kind === 'styleSpline' ? insertControlVertex(g, id, raw) : insertSplinePoint(g, id, raw);
    if ('error' in r) {
        set({ message: r.error });
        return;
    }
    if (commit(r.g, { selection: [{ type: 'point', id: r.point }] })) {
        set({ message: null });
    }
}

/** Radius 1 typed for the ellipse in progress, dimensioned when the ellipse is made. */

let typedRadius1: number | null = null;

/** Takes the result of a click of the ellipse, spline, parabola or conic tools. */
function placedConic(tool: ConicTool, r: PlaceResult, radius2: number | null = null): void {
    if ('message' in r) {
        set({ message: r.message });
        return;
    }
    if ('draft' in r) {
        set({ draft: r.draft, typed: '', message: null });
        return;
    }
    let out = r.g;
    const curve = curveOf(out, r.id);
    if ((curve?.kind === 'ellipse' || curve?.kind === 'ellipseArc')) {
        // Typed radii become driving dimensions, from the centre to each axis end.
        if (typedRadius1 !== null) {
            out = addConstraint(out, { kind: 'distance', a: curve.center, b: curve.major, value: typedRadius1 }).g;
        }
        if (radius2 !== null) {
            out = addConstraint(out, { kind: 'distance', a: curve.center, b: curve.minor, value: radius2 }).g;
        }
    }
    typedRadius1 = null;
    // With dynamic mirror on, the curve gets its mirror image (as lines and arcs do).
    out = afterDrawn(get().geometry, out);
    if (commit(out, { draft: [], typed: '', arcSweep: 0, selection: [{ type: 'curve', id: r.id }] })) {
        set({ message: null });
        openCurveForm(get().geometry, r.id);
    }
}

const FLAT_RECT = 'A rectangle needs a width and a height: click the second corner away from the first, not level with it or straight above it.';

function commitDrawn(tool: SketchTool, before: SketchGeometry, next: SketchGeometry, patch: Partial<SketcherState>): boolean {
    // With dynamic mirror on, what was drawn gets its mirror image; its dimensions are driven where they must be.
    const ok = commit(withDrawnDimensions(before, afterDrawn(before, finishDrawn(tool, before, next, get().drawOptions))), patch);
    if (ok) {
        quickSnapUsed();
    }
    return ok;
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
    const s = get();
    if (s.tool === 'spline' && s.draft.length) {
        // Double-click or Enter ends the spline.
        placedConic('spline', finishSpline(s.geometry, s.draft));
        return;
    }
    if (s.tool === 'styleSpline' && s.draft.length) {
        placedConic('styleSpline', finishStyleSpline(s.geometry, s.draft));
        return;
    }
    set({ draft: [], chainStart: null, typed: '' });
}

/**
 * Enter while sketching: applies a typed value (an error goes to the status line), takes an edit tool's next step,
 * or ends the line chain in progress; 'done' when it was used here. With nothing in progress it answers 'repeat':
 * Enter then repeats the last command (SolidWorks keyboard shortcuts); it never leaves the sketch.
 */
export function enterKey(): 'done' | 'repeat' {
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
        if (s.tool === 'line' || s.tool === 'centerline' || s.tool === 'tangentArc' || s.tool === 'spline' || s.tool === 'styleSpline') {
            endChain();
        } else {
            set({ message: 'Finish the shape with a click, or press Esc to drop it.' });
        }
        return 'done';
    }
    if (s.picks.length || s.dimDrag || s.drag || s.offsetCurve || s.xform?.picks.length) {
        return 'done';
    }
    return 'repeat';
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

/** The cursor, or a point next to `p` when the cursor is on it (a click there would be taken as a repeat). */
function awayFrom(p: Pt): Pt {
    const c = get().cursor;
    return c && dist(c, p) > 1e-6 ? c : [p[0] + 1, p[1]];
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
        set(s.tool === 'fillet' ? { filletRadius: size, typed: '', editText: `R${round(size)}` } : { chamferDistance: size, typed: '', editText: `${round(size)}` });
        return null;
    }
    if (s.tool === 'offset') {
        const d = s.cursor && s.offsetCurve ? sideDistance(s.geometry, s.offsetCurve, s.cursor, offsetAllowed(s)) : 1;
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
        case 'midpointLine':
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
                place({ at: awayFrom(last.at) }, null, [a]);
            }
            break;
        case 'centerSlot':
        case 'arcSlot3':
        case 'centerArcSlot':
            // The width, once the slot's centres or arc are placed.
            if (s.draft.length === (s.tool === 'centerSlot' ? 2 : 3)) {
                place({ at: awayFrom(last.at) }, null, [a]);
            }
            break;
        case 'ellipse':
        case 'partialEllipse':
            if (s.draft.length === 1) {
                // Radius 1, toward the cursor.
                place({ at: step(last.at, Math.abs(a)) }, null, [a]);
            } else if (s.draft.length === 2) {
                // Radius 2, square to the first axis on the cursor's side.
                const [c, p] = s.draft.map((d) => d.at);
                const l = dist(c, p) || 1;
                const n: Pt = [-(p[1] - c[1]) / l, (p[0] - c[0]) / l];
                const cur = s.cursor ?? [c[0] + n[0], c[1] + n[1]];
                const side = Math.sign((cur[0] - c[0]) * n[0] + (cur[1] - c[1]) * n[1]) || 1;
                place({ at: [c[0] + n[0] * Math.abs(a) * side, c[1] + n[1] * Math.abs(a) * side] }, null, [a]);
            }
            break;
    }
    return null;

}

// ---- Dimensions ---------------------------------------------------------------------------------------

/**
 * Pick for the dimension tool: a point only when the cursor is right on it, then a line's midpoint (SolidWorks
 * highlights it while hovering), else a curve from well away. With Shift an arc or circle is picked by its edge.
 */
function dimensionPick(g: SketchGeometry, raw: Pt, tolerance: number, shift = false): Pick | null {
    const near = pickAt(g, raw, tolerance * 0.7);
    if (near?.type === 'point') {
        return near;
    }
    for (const c of g.curves) {
        const [a, b] = c.kind === 'line' ? [pointOf(g, c.a), pointOf(g, c.b)] : [];
        if (a && b && dist(raw, [(a.u + b.u) / 2, (a.v + b.v) / 2]) < tolerance * 0.7) {
            return midPick(c.id);
        }
        // An arc's midpoint too (SolidWorks highlights the midpoint of a line, arc or edge while hovering).
        const [m, s0, e0] = c.kind === 'arc' ? [c.center, c.start, c.end].map((id) => pointOf(g, id)) : [];
        if (m && s0 && e0 && dist(raw, arcMiddle([m.u, m.v], [s0.u, s0.v], [e0.u, e0.v])) < tolerance * 0.7) {
            return midPick(c.id);
        }
    }
    const curve = curveAt(g, raw, tolerance * 2.4, tolerance * 0.8);
    const kind = curve ? curveOf(g, curve.id)?.kind : undefined;
    return curve && shift && (kind === 'circle' || kind === 'arc') ? { ...curve, type: 'curve', edge: true } : curve;
}

/** Smart Dimension (null), or the Horizontal or Vertical Dimension tool: the dimension tool measuring along one axis. */
export function setDimensionTool(lock: 'u' | 'v' | null): void {
    setTool('dimension');
    set({ dimLock: lock, dimSpecial: null });
}

/** The Horizontal ('u') or Vertical ('v') Ordinate Dimension tool: a zero, then each point measured from it. */
export function setOrdinateTool(axis: 'u' | 'v'): void {
    setTool('dimension');
    set({ dimLock: null, dimSpecial: { kind: 'ordinate', axis }, message: 'Click the zero: a point, or a line across the direction measured.' });
}

/** The Path Length tool: click a curve of the chain, then where the dimension goes. */
export function setPathLengthTool(): void {
    setTool('dimension');
    set({ dimLock: null, dimSpecial: { kind: 'path' }, message: 'Click a line or arc of the chain to measure.' });
}

/** The lines and arcs joined end to end with `id`, as far as the chain runs without a branch. */
export function chainOf(g: SketchGeometry, id: string): string[] {
    const usable = g.curves.filter((c) => c.kind === 'line' || c.kind === 'arc');
    const ends = (cid: string) => {
        const c = curveOf(g, cid);
        return c?.kind === 'line' ? [c.a, c.b] : c?.kind === 'arc' ? [c.start, c.end] : [];
    };
    if (!usable.some((c) => c.id === id)) {
        return [];
    }
    const chain = [id];
    const grow = (from: string, atEnd: boolean) => {
        let point = from;
        for (;;) {
            const next = usable.filter((c) => !chain.includes(c.id) && ends(c.id).includes(point));
            const sharing = usable.filter((c) => ends(c.id).includes(point));
            if (next.length !== 1 || sharing.length !== 2) {
                return;
            }
            if (atEnd) {
                chain.push(next[0].id);
            } else {
                chain.unshift(next[0].id);
            }
            point = ends(next[0].id).find((p) => p !== point) ?? point;
        }
    };
    const [a, b] = ends(id);
    grow(b, true);
    grow(a, false);
    return chain;
}

/** A click with the Ordinate, Angular Running or Path Length tool (sketchDimTools.ts). */
function specialDimensionClick(raw: Pt, tolerance: number): void {
    specialClick(raw, tolerance);
}

/** Whether a third pick goes on from these two: an arc and one of its ends (arc length), or two points (angle at a point). */
function takesThird(g: SketchGeometry, picks: Pick[], pick: Pick): boolean {
    if (picks.length !== 2 || pick.type !== 'point' || picks.some((p) => p.id === pick.id) || midOfPick(pick)) {
        return false;
    }
    const arc = curveOf(g, midOfPick(picks[0]) ?? picks[0].id);
    if (arc?.kind === 'arc') {
        return [arc.start, arc.end].includes(picks[1].id) && [arc.start, arc.end].includes(pick.id);
    }
    return picks.every((p) => p.type === 'point' && !midOfPick(p));
}

/** Opens the value input for a dimension of `picks`, with its label at `at`. */
function placeDimension(picks: Pick[], at: Pt): void {
    const s = get();
    // A type locked with a right-click stays (see sketchDimTools.ts).
    const constraint = smartDimension(s.geometry, picks, at, s.dimLock);
    clearDimensionLock();
    if (!constraint) {
        set({ picks: [], message: 'Those cannot be dimensioned together.' });
        return;
    }
    const value = measure(s.geometry, { ...constraint, id: 'measuring' } as SketchConstraint) ?? 0;
    // A dimension that would over define the sketch is offered as driven first (SolidWorks: Make Dimension Driven?),
    // or made driven or driving at once, as the Over defining dimensions options say.
    const action = overDefiningAction();
    const overDefining = action !== 'driving' && overDefines(s.geometry, constraint);
    set({ dimDraft: { constraint, at, text: String(round(value)), editing: null, error: null, overDefining }, hover: null, message: null });
    if (overDefining && action === 'driven') {
        chooseDimensionDriven(true);
    }
}

/**
 * The over-defining dimension's choice: driven adds it as a reference dimension (it follows the geometry); driving
 * goes on to its value as usual, which over defines the sketch.
 */
export function chooseDimensionDriven(driven: boolean): void {
    const s = get();
    const draft = s.dimDraft;
    if (!draft) {
        return;
    }
    if (!driven) {
        set({ dimDraft: { ...draft, overDefining: false } });
        return;
    }
    const value = measure(s.geometry, { ...draft.constraint, id: 'measuring' } as SketchConstraint) ?? 0;
    const r = addConstraint(s.geometry, { ...draft.constraint, value, driven: true } as NewConstraint);
    commit(r.g, { dimDraft: null, picks: [], labels: { ...s.labels, [r.id]: draft.at } });
}

/** Switches dimensions between driving and driven (from their PropertyManager or the relations list). */
export function setDimensionsDriven(ids: string[], driven: boolean): boolean {
    return commit(setDriven(get().geometry, ids, driven));
}

/** Replaces one relation or dimension (its PropertyManager's OK); false when the sketch would not solve. */
export function replaceConstraint(id: string, next: SketchConstraint): boolean {
    const g = get().geometry;
    return commit({ ...g, constraints: g.constraints.map((c) => (c.id === id ? next : c)) });
}

/**
 * Whether the next dimension tool click places rather than picks: with two picks (Smart Dimension), the ordinate
 * row after the zero, or a path length with its chain picked. Such a click takes nothing from the model.
 */
function dimensionPlacing(s: SketcherState): boolean {
    return specialPlacing(s);
}

function dimensionClick(raw: Pt, tolerance: number, shift = false): void {
    // A model edge or corner, or an entity of another sketch, under the pointer comes in first and is then picked.
    if (!dimensionPlacing(get())) {
        bringModelUnder(raw, tolerance);
    }
    const s = get();
    if (s.dimSpecial) {
        specialDimensionClick(raw, tolerance);
        return;
    }
    let pick = dimensionPick(s.geometry, raw, tolerance, shift);
    // With two picks already, a click on an axis is the placement, not a third pick.
    if (pick && s.picks.length >= 2 && pick.id.startsWith('axis-')) {
        pick = null;
    }
    if (pick && !(s.picks.length === 1 && s.picks[0].id === pick.id)) {
        const picks = s.picks.length >= 2 && !takesThird(s.geometry, s.picks, pick) ? [pick] : [...s.picks, pick];
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
    if (c.driven && !isOffsetDimension(s.geometry, id)) {
        // A driven dimension has no value to type: its PropertyManager switches it back to driving.
        set({ selection: [{ type: 'constraint', id }], message: 'A driven dimension follows the geometry; clear Driven to set its value.' });
        openDimensionForm(id);
        return;
    }
    const { id: _id, ...constraint } = c;
    set({ dimDraft: { constraint, at: s.labels[id] ?? dimensionAnchor(s.geometry, c), text: String(round(c.value)), editing: id, error: null } });
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
    // Zero and negative values for position dimensions (a negative one reverses), and the first dimension scaling the
    // sketch to it (maintain proportions): see sketchDimTools.ts.
    const plan = typedDimension(s.geometry, draft.constraint, draft.editing, draft.text);
    if ('error' in plan) {
        set({ dimDraft: { ...draft, error: plan.error } });
        return;
    }
    const { value } = plan;
    const constraint = { ...draft.constraint, value } as NewConstraint;
    let next: SketchGeometry;
    let id: string;
    if (draft.editing) {
        id = draft.editing;
        next = { ...plan.g, constraints: plan.g.constraints.map((c) => (c.id === id ? { ...constraint, id } as SketchConstraint : c)) };
    } else {
        const r = addConstraint(plan.g, constraint);
        next = r.g;
        id = r.id;
    }
    const ok = commit(next, { dimDraft: null, picks: [], labels: { ...s.labels, [id]: draft.at } });
    if (!ok) {
        const message = get().message ?? 'Over-constrained';
        set({ dimDraft: { ...draft, error: message } });
    } else if (plan.reverse) {
        reportReverse(s.geometry, id);
    }
}

/** Opens the Dimension PropertyManager of a dimension in the left panel. */
export function openDimensionForm(id: string): void {
    const c = get().geometry.constraints.find((k) => k.id === id);
    if (c && isDimension(c) && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: 'sk-pm-dimension' }));
    }
}

/**
 * Default place for a dimension label: beside what it measures. `gap`: how far off in mm (a size on screen, for a label
 * shown at the zoom of the moment); otherwise a few mm, more beside a long line.
 */
export function dimensionAnchor(g: SketchGeometry, c: SketchConstraint, gap?: number): Pt {
    const more = moreDimensionAnchor(g, c);
    if (more) {
        return more;
    }
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
            const off = gap ?? Math.max(4, l * 0.12);
            return [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / l) * off, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / l) * off];
        }
        case 'distance': {
            const a = p(c.a);
            const b = pointOf(g, c.b) ? p(c.b) : c.b === AXIS_U ? [a[0], 0] as Pt : c.b === 'axis-v' ? [0, a[1]] as Pt : a;
            const off = gap ?? 3;
            return [(a[0] + b[0]) / 2 + off, (a[1] + b[1]) / 2 + off];
        }
        case 'radius':
        case 'diameter': {
            const curve = curveOf(g, c.curve);
            if (!curve || (curve.kind !== 'circle' && curve.kind !== 'arc')) {
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
            const off = gap ?? 4;
            return [u + off, v + off];
        }
        default:
            return [0, 0];
    }
}

// ---- Model edges and vertices as references -------------------------------------------------------------

/** The model edge or vertex under the cursor where no sketch geometry is (dimension and relation tools), or null. */
function modelRefUnder(s: SketcherState, raw: Pt, tolerance: number): ModelRef | null {
    const target = modelTarget(s);
    const model = loadedModel(target, target ? useStudio.getState().meshes.keys[target.partId] ?? null : null);
    const own = s.tool === 'dimension' ? dimensionPick(s.geometry, raw, tolerance) : pickAt(s.geometry, raw, tolerance);
    // The sketch's own geometry wins, but a model corner on one of its axes is still picked as that corner.
    if (own && !own.id.startsWith('axis-')) {
        return null;
    }
    // The part's other sketches can be picked the same way.
    const ref = modelRefAt(model, raw, tolerance, sketchesToSnap(s));
    return own && ref?.kind !== 'point' ? null : ref;
}

/** What the current tool takes from the model where it takes a sketch entity: a straight line, any curve, or nothing. */
function modelEdgeUse(s: SketcherState): 'line' | 'curve' | null {
    if ((s.tool === 'mirror' && s.picks.length) || (s.tool === 'm:pick' && useSketchMore.getState().picker)) {
        return s.tool === 'm:pick' ? useSketchMore.getState().picker?.models ?? 'line' : 'line';
    }
    return s.tool === 'offset' && !s.offsetCurve ? 'curve' : null;
}

const fitsUse = (ref: ModelRef, use: 'line' | 'curve' | null): boolean =>
    !use || (ref.kind === 'curve' && (use === 'curve' || ref.curve.kind === 'line'));

/**
 * A click on a model edge or vertex (or an entity of another sketch): it comes into the sketch as a locked
 * construction entity at its projected place (once; the same edge again reuses it), so the click then picks that.
 * For selecting it and for relations and dimensions it is a model reference: no undo step, and it goes again when
 * nothing uses it (sketchModelSelect.ts); mirror lines, offset bases and pattern directions (`use`) stay. Returns
 * what to pick, or null.
 */
export function bringModelUnder(raw: Pt, tolerance: number, use: 'line' | 'curve' | null = null): Pick | null {
    const s = get();
    const ref = modelRefUnder(s, raw, tolerance);
    if (!ref || !fitsUse(ref, use)) {
        return null;
    }
    const r = bringModelRef(s.geometry, ref, { reference: !use });
    if (r.g !== s.geometry) {
        if (use) {
            commit(r.g);
        } else {
            set({ geometry: r.g });
        }
    }
    useSketchModel.setState({ hover: null });
    return r.pick;
}

// ---- Constraints --------------------------------------------------------------------------------------

/** The constraint tool button: applies to the selection when it fits, else waits for picks in the view. */
export function constraintTool(tool: ConstraintTool): void {
    if (withPieces(() => constraintTool(tool))) {
        return;
    }
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

/** The Add Relations form is open: Select tool clicks add to the selection (see selectAt). */
let relationPicking = false;

export function setRelationPicking(on: boolean): void {
    relationPicking = on;
}

/**
 * The Add Relations form's buttons: adds the relation `tool` makes for the selected entities, keeping them selected
 * (Lock toggles the lock). Returns what the selection still needs when it does not fit, or null.
 */
export function addRelationToSelection(tool: ConstraintTool): string | null {
    const viaPieces = withPieces(() => addRelationToSelection(tool));
    if (viaPieces) {
        return viaPieces.result;
    }
    const s = get();
    const picks = s.selection.filter((x): x is Pick => x.type !== 'constraint');
    if (tool === 'fix') {
        toggleLock(picks);
        return null;
    }
    const result = relationsFromPicks(s.geometry, tool, picks);
    if ('need' in result) {
        return result.need;
    }
    const kept = tool === 'merge' ? picks.slice(0, 1) : picks;
    return applyRelations(tool, result, { selection: kept }) ? null : get().message ?? 'Not applied.';
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
        const collapsed = g.curves.some((c) => (c.kind === 'line' ? c.a === c.b : c.kind === 'arc' ? (c.start === c.end || c.center === c.start || c.center === c.end)
            : c.kind !== 'circle' && c.kind !== 'spline' && new Set(curvePoints(c)).size < curvePoints(c).length));

        if (collapsed) {
            set({ message: 'Those points belong to one line or arc; merging them would collapse it.' });
            return false;
        }
        return commit(g, patch);
    }
    if (tool === 'fixSlot') {
        // Every point locked, less what the slot's own relations (tangent, equal) already hold.
        let g = s.geometry;
        const fresh: string[] = [];
        for (const c of relations) {
            const r = addConstraint(g, c);
            g = r.g;
            fresh.push(r.id);
        }
        return commit(withoutRepeatedLocks(g, fresh, () => newId('k', g)), patch);
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
        return !c ? [] : curvePoints(c);
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
    const fresh: string[] = [];
    for (const id of ids.filter((x) => !locked.has(x))) {
        const r = addConstraint(g, { kind: 'fix', point: id });
        g = r.g;
        fresh.push(r.id);
    }
    for (const id of circles.filter((x) => !locked.has(x))) {
        g = addConstraint(g, { kind: 'fixRadius', curve: id }).g;
    }
    // Arcs, ellipses and parabolas: points that sit on the curve the others give are held in one coordinate only.
    commit(withoutRepeatedLocks(g, fresh, () => newId('k', g)), { picks: [] });
}

function constraintClick(tool: ConstraintTool, raw: Pt, tolerance: number): void {
    bringModelUnder(raw, tolerance);
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
    if (moreEscape() || splineEscape()) {
        return;
    }
    const s = get();
    pendingReplace = null;
    if (s.dimDraft) {
        set({ dimDraft: null });
    } else if (s.typed) {
        set({ typed: '' });
    } else if (s.draft.length) {
        set({ draft: [], chainStart: null });
    } else if (s.picks.length || s.offsetCurve || s.mirrorAbout || s.xform?.picks.length) {
        set((x) => ({ picks: [], trimPicks: [], offsetCurve: null, mirrorAbout: false, editPreview: [], editText: null, xform: x.xform && { ...x.xform, picks: [] } }));
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

/** The curves being offset: the picked one(s). */
function offsetIds(s: SketcherState): string[] {
    const ids = s.picks.filter((p) => p.type === 'curve').map((p) => p.id);
    return s.offsetCurve && !ids.includes(s.offsetCurve) ? [s.offsetCurve, ...ids] : ids;
}

/** With Select chain off, the chain only runs through the picked curves. */
function offsetAllowed(s: SketcherState): ReadonlySet<string> | undefined {
    return s.editOptions.offsetChain ? undefined : new Set(offsetIds(s));
}

/** The offset's options from the form, at signed distance d. */
function offsetOptions(s: SketcherState, d: number): OffsetOptions {
    const o = s.editOptions;
    return {
        distance: d, chain: o.offsetChain, both: o.offsetBoth, cap: o.offsetCap, dimension: o.offsetDimension,
        baseConstruction: o.offsetBaseConstruction, offsetConstruction: o.offsetConstruction,
    };
}

/** Offset distance for the cursor: the typed value on the cursor's side, else the cursor's own distance. */
function offsetDistance(s: SketcherState, raw: Pt): number {
    const d = s.offsetCurve ? sideDistance(s.geometry, s.offsetCurve, raw, offsetAllowed(s)) : 0;
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
            const o = s.editOptions;
            if (s.tool === 'trim' && o.trimMode !== 'power' && o.trimMode !== 'closest') {
                return { hover: pick, editPreview: [], editText: null };
            }
            if (s.tool === 'trim' && pick && !trimmable(g, pick.id, { ignoreConstruction: o.trimIgnoreConstruction })) {
                return { hover: null, editPreview: [], editText: null };
            }
            const plan = pick && (s.tool === 'trim' ? trimAt(g, pick.id, raw, { construction: o.trimConstruction }) : extendAt(g, pick.id, raw));
            const shown = plan ? ('removed' in plan ? plan.removed : plan.added) : null;
            return { hover: null, editPreview: shown ? [shown] : [], editText: null };
        }
        case 'fillet':
        case 'chamfer': {
            const size = s.tool === 'fillet' ? `R${round(s.filletRadius)}` : `${round(s.chamferDistance)}`;
            const pick = cornerPick(g, raw, tolerance);
            // A corner under the pointer: the fillet or chamfer it would get.
            let preview: NewEntity[] = [];
            const corner = pick?.type === 'point' ? filletCornerAt(g, pick.id) : null;
            if (corner && !('error' in corner)) {
                const typed = s.typed ? evaluate(s.typed) : null;
                const r = s.tool === 'fillet'
                    ? filletSides(g, corner, Math.abs(typed ?? s.filletRadius), { keepCorners: s.editOptions.filletKeepCorners })
                    : chamferSides(g, corner, chamferOptions(s, Math.abs(typed ?? s.chamferDistance)));
                if (!('error' in r)) {
                    const old = new Set(g.curves.map((c) => c.id));
                    preview = geometryEntities(r.g, false).filter((e) => !old.has(e.id)) as NewEntity[];
                }
            }
            return { hover: pick, editPreview: preview, editText: s.typed ? null : size };
        }
        case 'offset': {
            if (s.offsetCurve) {
                const d = offsetDistance(s, raw);
                return { hover: null, editPreview: offsetPreview(g, offsetIds(s), offsetOptions(s, d)), editText: s.typed ? null : `${round(Math.abs(d), 0.01)}` };
            }
            return { hover: drawnCurveAt(g, raw, tolerance), editPreview: [], editText: null };
        }
        case 'mirror':
            return { hover: curveAt(g, raw, tolerance), editPreview: [], editText: null };
        case 'split':
            return { hover: drawnCurveAt(g, raw, tolerance), editPreview: [], editText: null };
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
            const name = tool === 'trim' ? 'Trim' : 'Extend';
            const refused = notForCurve(name, curveOf(g, pick.id)) ?? cutRefusal(g, pick.id, name);
            if (refused) {
                set({ message: refused });
                return;
            }
            const o = s.editOptions;
            if (tool === 'trim' && o.trimMode !== 'power' && o.trimMode !== 'closest') {
                trimPickClick(pick.id, raw);
                return;
            }
            if (tool === 'trim' && !trimmable(g, pick.id, { ignoreConstruction: o.trimIgnoreConstruction })) {
                set({ message: 'Construction geometry is not trimmed (Ignore trimming of construction geometry is on).' });
                return;
            }
            const plan = tool === 'trim' ? trimAt(g, pick.id, raw, { construction: o.trimConstruction }) : extendAt(g, pick.id, raw);
            if (!plan) {
                set({ message: tool === 'trim' ? 'Nothing to trim there: a circle, ellipse or closed spline needs two crossings.'
                    : 'Nothing to extend to: the end must be free and point at another curve.' });
                return;
            }
            if (commit(plan.g, { editPreview: [], selection: [] }) && 'dropped' in plan && plan.dropped) {
                set({ message: `Extended; removed ${plan.dropped} relation${plan.dropped === 1 ? '' : 's'} that held the end or the line's length.` });
            }
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
            if (typed === null && sizeErrors.length) {
                set({ picks: [], message: sizeErrors[0] });
                return;
            }
            if (!(size > 0)) {
                set({ picks: [], message: tool === 'fillet' ? 'The radius must be above zero.' : 'The distance must be above zero.' });
                return;
            }
            let corner: ReturnType<typeof filletCornerAt>;
            if (pick.type === 'point') {
                corner = filletCornerAt(g, pick.id);
            } else {
                const first = s.picks.find((p) => p.type === 'curve' && p.id !== pick.id);
                if (!first) {
                    notePick(pick.id, raw);
                    set({ picks: [pick], message: null });
                    return;
                }
                corner = filletCornerOf(g, first.id, pick.id, [pickPosition(first.id), raw]);
            }
            if ('error' in corner) {
                set({ picks: [], message: corner.error });
                return;
            }
            applyCorner(tool, corner, size);
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
        case 'split': {
            const pick = drawnCurveAt(g, raw, tolerance);
            if (!pick) {
                return;
            }
            const held = cutRefusal(g, pick.id, 'Split');
            if (held) {
                set({ message: held });
                return;
            }
            const first = s.trimPicks[0];
            const circle = closesOnItself(curveOf(g, pick.id));
            if (circle && (!first || first.id !== pick.id)) {
                // A circle, ellipse or closed spline takes two split points.
                set({ trimPicks: [{ id: pick.id, at: raw }], picks: [pick], message: secondSplitPrompt(curveOf(g, pick.id)) });
                return;
            }
            const r = splitAt(g, pick.id, circle ? first.at : raw, circle ? raw : undefined);
            if ('error' in r) {
                set({ message: r.error });
                return;
            }
            if (commit(r.g, { trimPicks: [], picks: [], selection: [{ type: 'point', id: r.point }] })) {
                set({ message: r.dropped ? `Split; removed ${r.dropped} relation${r.dropped === 1 ? '' : 's'} on the whole line (its length, middle or equal length).` : 'Split.' });
            }
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
                const r = mirrorCurves(g, objects, pick.id, s.editOptions.mirrorCopy);
                if ('error' in r) {
                    set({ message: r.error });
                    return;
                }
                if (commit(r.g, { picks: [], mirrorAbout: false, hover: null, selection: [] }) && r.dropped) {
                    set({ message: `Mirrored; removed ${r.dropped} relation${r.dropped === 1 ? '' : 's'} of the originals to the rest of the sketch.` });
                }
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

/** The chamfer's options from the form, with Distance 1 = `size`. */
function chamferOptions(s: SketcherState, size: number): ChamferOptions {
    const o = s.editOptions;
    return o.chamferType === 'angle' ? { type: 'angle', distance: size, angle: o.chamferAngle }
        : { type: 'distance', distance: size, ...(o.chamferEqual ? {} : { distance2: o.chamferDistance2 }) };
}

/** Fillets or chamfers one corner; says what happened to the corner's relations. False when it could not. */
function applyCorner(tool: 'fillet' | 'chamfer', corner: FilletCorner, size: number): boolean {
    const s = get();
    const o = s.editOptions;
    if (tool === 'chamfer') {
        const r = chamferSides(s.geometry, corner, chamferOptions(s, size));
        if ('error' in r) {
            set({ picks: [], message: r.error });
            return false;
        }
        return commit(r.g, { picks: [], typed: '', hover: null, selection: [], editPreview: [], chamferDistance: size });
    }
    // Dimension each fillet off: the first fillet of this session gets the radius, later ones are equal to it.
    const first = !o.filletDimensionEach && s.filletFirst && curveOf(s.geometry, s.filletFirst) && Math.abs((curveRadius(s.geometry, s.filletFirst) ?? 0) - size) < 1e-6
        ? s.filletFirst : null;
    const r = filletSides(s.geometry, corner, size, { keepCorners: o.filletKeepCorners, equalTo: first });
    if ('error' in r) {
        set({ picks: [], message: r.error });
        return false;
    }
    if (!commit(r.g, { picks: [], typed: '', hover: null, selection: [], editPreview: [], filletRadius: size, filletFirst: first ?? r.arc })) {
        return false;
    }
    if (r.dropped) {
        set({ message: `Filleted; removed ${r.dropped} relation${r.dropped === 1 ? '' : 's'} or dimension${r.dropped === 1 ? '' : 's'} on the corner (Keep constrained corners is off).` });
    } else if (r.kept) {
        set({ message: 'Filleted; the corner stays as a point with its relations and dimensions.' });
    }
    return true;
}

/** Trim corner, inside and outside: clicks pick the lines or boundaries, then (inside / outside) the curves to trim. */
function trimPickClick(id: string, at: Pt): void {
    const s = get();
    const o = s.editOptions;
    const picks = s.trimPicks;
    const settings = { construction: o.trimConstruction, ignoreConstruction: o.trimIgnoreConstruction };
    if (o.trimMode === 'corner') {
        if (!picks.length || picks[0].id === id) {
            set({ trimPicks: [{ id, at }], picks: [{ type: 'curve', id }], message: null });
            return;
        }
        const r = trimCorner(s.geometry, picks[0], { id, at });
        if ('error' in r) {
            set({ trimPicks: [], picks: [], message: r.error });
            return;
        }
        commit(r.g, { trimPicks: [], picks: [], selection: [], editPreview: [] });
        return;
    }
    if (picks.length < 2) {
        if (picks.some((p) => p.id === id)) {
            return;
        }
        const next = [...picks, { id, at }];
        set({ trimPicks: next, picks: next.map((p) => ({ type: 'curve' as const, id: p.id })), message: null });
        return;
    }
    if (!trimmable(s.geometry, id, settings)) {
        set({ message: 'Construction geometry is not trimmed (Ignore trimming of construction geometry is on).' });
        return;
    }
    const r = trimBetween(s.geometry, id, [picks[0].id, picks[1].id], o.trimMode === 'inside' ? 'inside' : 'outside', settings);
    if ('error' in r) {
        set({ message: r.error });
        return;
    }
    // The boundaries stay picked for the next curve.
    commit(r.g, { selection: [], editPreview: [] });
}

function applyOffset(d: number): void {
    const s = get();
    if (!s.offsetCurve) {
        return;
    }
    const r = offsetEntities(s.geometry, offsetIds(s), offsetOptions(s, d));
    if ('error' in r) {
        set({ typed: '', message: r.error });
        return;
    }
    commit(r.g, { offsetCurve: null, picks: [], typed: '', editPreview: [], editText: null, selection: [] });
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

/** A circular pattern's centre: the selected point when it is there, else the position. */
function centreRef(centre: Pt): string | Pt {
    const s = get();
    const point = s.selection.find((x) => x.type === 'point' && pointOf(s.geometry, x.id) && dist(centre, [pointOf(s.geometry, x.id)!.u, pointOf(s.geometry, x.id)!.v]) < 1e-6);
    return point ? point.id : centre;
}

function patternOf(kind: 'linear' | 'circular', o: LinearPatternOptions | (Omit<CircularPatternOptions, 'centre'> & { centre: Pt })) {
    const g = get().geometry;
    return kind === 'linear' ? linearSketchPattern(g, selectedCurves(), o as LinearPatternOptions)
        : circularSketchPattern(g, selectedCurves(), { ...(o as CircularPatternOptions), centre: centreRef((o as { centre: Pt }).centre) });
}

/** Linear sketch pattern of the selected curves, tied to them. Returns an error to show, or null. */
export function linearPatternSelected(o: LinearPatternOptions): string | null {
    const r = patternOf('linear', o);
    if ('error' in r) {
        return r.error;
    }
    return commit(r.g, { selection: [], editPreview: [] }) ? null : get().message;
}

/** Circular sketch pattern of the selected curves about `centre`, tied to them. Returns an error to show, or null. */
export function circularPatternSelected(o: Omit<CircularPatternOptions, 'centre'> & { centre: Pt }): string | null {
    const r = patternOf('circular', o);
    if ('error' in r) {
        return r.error;
    }
    return commit(r.g, { selection: [], editPreview: [] }) ? null : get().message;
}

/** Shows the instances a pattern form would make (empty options clear it). */
export function previewPattern(kind: 'linear' | 'circular', o: LinearPatternOptions | (Omit<CircularPatternOptions, 'centre'> & { centre: Pt }) | null): void {
    const r = o ? patternOf(kind, o) : null;
    if (!r || 'error' in r) {
        set({ editPreview: [] });
        return;
    }
    const made = new Set(r.created);
    set({ editPreview: geometryEntities(r.g).filter((e) => made.has(e.id)) as NewEntity[] });
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
    if (!from || (s.xform?.kind !== 'move' && s.xform?.kind !== 'copy' && s.xform?.kind !== 'stretch')) {
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
export function transformSelected(t: Transform, copy: boolean, o: { keepRelations?: boolean; copies?: number } = {}): string | null {
    const s = get();
    // Text and block instances hold no relations to the rest: they move as whole items either way.
    if (!copy && o.keepRelations && !transformWithItems(s.geometry, selectedGeometry(), t, false)) {
        return moveKeeping(t, false);
    }
    const copies = copy ? Math.max(1, Math.round(o.copies ?? 1)) : 1;
    if (copies > 1) {
        return copyMany(t, copies);
    }
    const r = transformAll(s.geometry, selectedGeometry(), t, copy, !!o.keepRelations);
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

/** transformEntities, taking text and block instances as whole items. */
function transformAll(g: SketchGeometry, ids: string[], t: Transform, copy: boolean, keep = false): ReturnType<typeof transformEntities> {
    return transformWithItems(g, ids, t, copy, keep) ?? transformEntities(g, ids, t, copy);
}

/** The transform applied k times: k steps of a move or turn, the factor to the power k for a scale. */
function stepped(t: Transform, k: number): Transform {
    return t.kind === 'move' ? { kind: 'move', by: [t.by[0] * k, t.by[1] * k] }
        : t.kind === 'rotate' ? { ...t, angle: t.angle * k } : { ...t, factor: t.factor ** k };
}

/** Copy (or Scale) with a number of copies: each one step further on, all in one undo step. */
function copyMany(t: Transform, copies: number): string | null {
    const s = get();
    const ids = selectedGeometry();
    let g = s.geometry;
    const made: string[] = [];
    for (let k = 1; k <= copies; k++) {
        const r = transformAll(g, ids, stepped(t, k), true);
        if ('error' in r) {
            return r.error;
        }
        g = r.g;
        made.push(...r.created);
    }
    const selection: Selected[] = made.map((id) => ({ type: g.curves.some((c) => c.id === id) ? 'curve' : 'point', id }));
    if (!commit(g, { selection, editPreview: [] })) {
        return get().message;
    }
    set({ message: `Made ${copies} copies.` });
    return null;
}

/**
 * Move, turn or scale keeping relations (and Stretch): the selected points are pulled to their new places and the
 * sketch is solved with every relation kept, so attached curves stretch along. Stretch holds every other point still.
 */
function moveKeeping(t: Transform, stretch: boolean): string | null {
    const s = get();
    const ids = selectedGeometry();
    const points = new Set(ids.flatMap((id) => {
        const c = curveOf(s.geometry, id);
        return c ? curvePoints(c) : [id];
    }).filter((id) => id !== ORIGIN && pointOf(s.geometry, id)));
    if (!points.size) {
        return 'Select the curves or points first.';
    }
    if (!solverReady()) {
        return 'The solver is still loading; try again in a moment.';
    }
    const targets = [...points].map((id) => {
        const p = pointOf(s.geometry, id)!;
        const [u, v] = transformPoint(t, [p.u, p.v]);
        return { point: id, u, v };
    });
    // A scale also scales the selected circles.
    const scaled = t.kind === 'scale' ? new Set(ids) : new Set<string>();
    const start: SketchGeometry = { ...s.geometry, curves: s.geometry.curves.map((c) => (c.kind === 'circle' && scaled.has(c.id) ? { ...c, radius: c.radius * (t as { factor: number }).factor } : c)) };
    const hold = stretch ? new Set(s.geometry.points.filter((p) => !points.has(p.id)).map((p) => p.id)) : undefined;
    const r = solveGeometry(start, { targets, hold });
    const miss = r.ok ? Math.max(...targets.map((x) => {
        const p = pointOf(r.geometry, x.point);
        return p ? Math.hypot(p.u - x.u, p.v - x.v) : 0;
    })) : Infinity;
    if (miss > 1e-3) {
        return 'The relations to the rest of the sketch do not let it go there. Clear Keep relations to break them.';
    }
    if (!commit(r.geometry, { editPreview: [] })) {
        return get().message;
    }
    set({ message: stretch ? 'Stretched.' : 'Moved, keeping its relations.' });
    return null;
}

/** Stretch: moves the selected curves and points by `by`; the curves attached to them stretch, the rest stays. */
export function stretchSelected(by: Pt): string | null {
    return moveKeeping({ kind: 'move', by }, true);
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

/** Suppresses relations and dimensions (kept, not solved) or lets them hold again. */
export function setSuppressed(ids: string[], on: boolean): boolean {
    const set_ = new Set(ids);
    const g = get().geometry;
    const next = {
        ...g,
        constraints: g.constraints.map((c) => {
            if (!set_.has(c.id) || !!c.suppressed === on) {
                return c;
            }
            const { suppressed: _s, ...rest } = c;
            return (on ? { ...c, suppressed: true } : rest) as SketchConstraint;
        }),
    };
    // Suppressing only takes rules away; it applies even if the sketch still does not solve.
    if (!commit(next) && on) {
        const s = get();
        set({ geometry: next, undo: [...s.undo.slice(-80), s.geometry], redo: [] });
        resolve();
    }
    return true;
}

/** Display/Delete Relations' Replace: the next click in the view picks what replaces `ref` in the relation. */
let pendingReplace: { constraint: string; ref: string } | null = null;

export function startReplaceEntity(constraint: string, ref: string): void {
    setTool('select');
    pendingReplace = { constraint, ref };
    set({ message: 'Click the entity that takes its place in the relation (Esc cancels).' });
}

export function cancelReplaceEntity(): void {
    pendingReplace = null;
}

export const replacingEntity = (): { constraint: string; ref: string } | null => pendingReplace;

function replaceAt(raw: Pt, tolerance: number): void {
    const { constraint, ref } = pendingReplace!;
    pendingReplace = null;
    const g = get().geometry;
    const pick = pickAt(g, raw, tolerance);
    if (!pick) {
        set({ message: 'Nothing there to put in the relation.' });
        return;
    }
    const r = replaceEntity(g, constraint, ref, pick.id);
    if ('error' in r) {
        set({ message: r.error });
        return;
    }
    if (commit(r.g)) {
        set({ message: null });
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
export function repairAll(gap?: number): boolean {
    const r = fixAll(get().geometry, gap);
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

/** Fully Define Sketch with its options (the form's Calculate); returns what happened, as the status line says it. */
export function fullyDefineSketchWith(options: FullyDefineOptions): { text: string; isError: boolean } {
    if (!solverReady()) {
        return { text: 'The solver is still loading; try again in a moment.', isError: true };
    }
    const s = get();
    const r = fullyDefineWith(s.geometry, options);
    if ('error' in r) {
        set({ message: r.error });
        return { text: r.error, isError: true };
    }
    const left = r.dof === 0 ? 'the sketch is fully defined' : `${r.dof} degree${r.dof === 1 ? '' : 's'} of freedom left`;
    if (!r.relations && !r.dimensions) {
        const text = r.dof === 0 ? 'The sketch is fully defined already.' : `Nothing could be added; ${left}.`;
        set({ message: text });
        return { text, isError: false };
    }
    // New dimensions sit where the scheme placed them.
    const before = new Set(s.geometry.constraints.map((c) => c.id));
    const labels = { ...s.labels, ...Object.fromEntries(r.g.constraints.flatMap((c) => (!before.has(c.id) && isDimension(c) && c.at ? [[c.id, c.at]] : []))) };
    if (!commit(r.g, { labels })) {
        return { text: get().message ?? 'Not applied.', isError: true };
    }
    const text = `Added ${r.relations} relation${r.relations === 1 ? '' : 's'} and ${r.dimensions} dimension${r.dimensions === 1 ? '' : 's'}; ${left}.`;
    set({ message: text });
    return { text, isError: false };
}

// ---- Output -------------------------------------------------------------------------------------------

export function sketchProfiles(): { profiles: SketchProfile[]; open: number } {
    return geometryProfiles(get().geometry);
}

export function sketchEntities() {
    return geometryEntities(get().geometry);
}

/** Runs before the sketch is read out for saving (a block open for editing is closed into the sketch first). */
let beforeOutput: (() => void) | null = null;

export function setBeforeOutput(hook: (() => void) | null): void {
    beforeOutput = hook;
}

/** The finished sketch: the solved profiles the kernel builds from, and the editable geometry. */
export function currentSketch(): Sketch {
    beforeOutput?.();
    const s = get();
    // Model edges that were only selected leave no trace.
    const g = withoutLooseReferences(s.geometry);
    // Every closed area on its own, so each extrude or cut can use just the ones picked for it.
    const regions = openSketchRegions(s.geometry);
    // Open chains (a sweep path, a guide) are kept too; `profiles` stays the closed areas only.
    const open = geometryOpenChains(s.geometry);
    return {
        plane: s.plane,
        ...(s.offset ? { offset: s.offset } : {}),
        profiles: sketchProfiles().profiles,
        ...(regions.length ? { regions } : {}),
        ...(open.length ? { open } : {}),
        // Label positions travel with their dimensions.
        geometry: {
            ...g,
            constraints: g.constraints.map((c) => (isDimension(c) && s.labels[c.id] ? { ...c, at: s.labels[c.id] } : c)),
        },
        // A derived sketch's link, and the 2D to 3D view a sketch is.
        ...sketchOutputExtras(),
    };
}

/** Defaults for the finish popup: the edited item's values, else the intent's. */
export function finishDefaults(feature: Feature | null, base: { extrude?: { distance: number; direction?: ExtrudeDirection }; revolve?: { axis: RevolveAxis; angle?: number } } | null): FinishOp {
    const s = get();
    // A sketch with exactly one centreline revolves about it by default.
    const centrelines = sketchCentrelines(s);
    const op: FinishOp = {
        op: s.intent === 'revolve' ? 'revolve' : 'extrude',
        mode: s.intent === 'sketch' ? 'sketch' : s.intent === 'cut' ? 'cut' : 'add',
        distance: 10,
        direction: 'normal',
        through: false,
        axis: centrelines.length === 1 ? { line: centrelines[0] } : 'v',
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
        return {
            ...op, op: 'revolve', mode: feature.mode, axis: feature.axis, angle: feature.angle ?? 360,
            type: feature.type ?? 'blind', reverse: !!feature.reverse, angle2: feature.angle2 ?? null,
        };
    }
    if (base?.extrude) {
        return { ...op, op: 'extrude', mode: 'new', distance: base.extrude.distance, direction: base.extrude.direction ?? 'normal' };
    }
    if (base?.revolve) {
        return { ...op, op: 'revolve', mode: 'new', axis: base.revolve.axis, angle: base.revolve.angle ?? 360 };
    }
    // A new feature's depth, angle and end condition: the saved defaults of Extrude, Cut and Revolve (Options).
    return { ...op, ...savedFinishOptions(s.intent) };
}
