// The sketch settings beyond snapping on or off (SolidWorks: Tools > Sketch Settings, System Options > Sketch and
// Relations/Snaps, and the document's Grid/Snap). Kept in this browser's localStorage.

export interface SketchSettings {
    /** Automatic relations: what the cursor snaps to while drawing becomes a relation (Ctrl held: not for that click). */
    autoRelations: boolean;
    /** Automatic solve: each change is solved at once; off, changes wait for Solve. */
    autoSolve: boolean;
    /** Detach segment on drag: dragging an end pulls it away from what it joins (unless relations hold it). */
    detachOnDrag: boolean;
    /** Override dimensions on drag: dragging changes the driving dimensions it moves, at the end of the drag. */
    overrideDims: boolean;
    /** Show relation markers in the view. */
    showRelations: boolean;
    /** Angle snap step in degrees. */
    snapAngle: number;
    /** No solve move: dragging moves entities without solving; relations and dimensions it would break are asked about. */
    noSolveMove: boolean;
    /** Use fully defined sketches: a feature is made only from a sketch that is fully defined. */
    useFullyDefined: boolean;
    /** Display plane when shaded: the sketch plane is shown, see-through, while sketching. */
    displayPlane: boolean;
    /** Preview sketch dimension when selected: a selected line, circle or arc shows its size to click. */
    previewDims: boolean;
    /** Ghost image on drag: the entity's place before the drag stays as a ghost while dragging. */
    ghostOnDrag: boolean;
    /** Over defining dimensions: ask (Make dimension driven?) first, and which answer is the default (or the action). */
    overDefPrompt: boolean;
    overDefDriven: boolean;
    /** Sketch dimension driven: the dimensions added while drawing (Add dimensions, typed sizes) are driven. */
    drivenOnCreate: boolean;
    /** Show the relations list when the sketch becomes over defined or does not solve (Display/Delete Relations option). */
    relationsOnError: boolean;
    /** Grid/Snap: display grid, dashed lines, automatic scaling, major spacing, minor lines per major, snap points per minor. */
    gridDisplay: boolean;
    gridDash: boolean;
    gridAutoScale: boolean;
    gridMajor: number;
    gridMinorPerMajor: number;
    gridSnapPerMinor: number;
    /** Snap only when grid is displayed: with the grid hidden, the grid snap does nothing. */
    gridSnapOnlyShown: boolean;
    /** Turn off Automatic Solve and Undo when the sketch has more than `solveLimit` entities. */
    solveLimitOn: boolean;
    solveLimit: number;
}

export const DEFAULT_SKETCH_SETTINGS: SketchSettings = {
    autoRelations: true, autoSolve: true, detachOnDrag: false, overrideDims: false, showRelations: true, snapAngle: 15,
    noSolveMove: false, useFullyDefined: false, displayPlane: false, previewDims: false, ghostOnDrag: true,
    overDefPrompt: true, overDefDriven: true, drivenOnCreate: false, relationsOnError: false,
    gridDisplay: true, gridDash: false, gridAutoScale: true, gridMajor: 10, gridMinorPerMajor: 10, gridSnapPerMinor: 1, gridSnapOnlyShown: true,
    solveLimitOn: false, solveLimit: 1000,
};

const KEY = 'jarvis.sketch.settings';

export function loadSketchSettings(): SketchSettings {
    try {
        const raw = globalThis.localStorage?.getItem(KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return { ...DEFAULT_SKETCH_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
        return { ...DEFAULT_SKETCH_SETTINGS };
    }
}

export function saveSketchSettings(s: SketchSettings): void {
    try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
    } catch {
        // Storage can be full or blocked; the setting still holds for this session.
    }
}

/** The grid's snap step: the minor spacing (major spacing over minor lines per major) over the snap points per minor. */
export function gridSnapStep(s: SketchSettings): number {
    return s.gridMajor / Math.max(1, s.gridMinorPerMajor) / Math.max(1, s.gridSnapPerMinor);
}

/** Whether changes are solved at once: Automatic solve, unless the sketch has more entities than the set limit. */
export function solvesAtOnce(s: SketchSettings, entities: number): boolean {
    return s.autoSolve && !overEntityLimit(s, entities);
}

/** More entities than the limit set for Automatic solve and Undo. */
export function overEntityLimit(s: SketchSettings, entities: number): boolean {
    return s.solveLimitOn && entities > s.solveLimit;
}
