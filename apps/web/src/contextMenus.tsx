// Right-click (shortcut) menus, as SolidWorks offers them for what is under the pointer: a face, an edge, a sketch,
// a reference plane, a part in the assembly, empty space, sketch entities in an open sketch, and steps of the
// feature tree. Pure functions from what was clicked to menu entries; every entry runs an existing tool or action
// through `MenuActions`, so the menus can be tested without the view (viewMenu.tsx wires them to the app).

import type { Feature, Part, SketchGeometry, SketchPlane } from '@jarvis/core';
import type { MenuEntry } from './menus';
import type { P3, PickedEntity } from './picking';
import type { SketchIntent, SketchTool } from './sketcher';
import { kindOf, relationsFromPicks, type Pick } from './sketchGeometry';
import { ALL_TOOLS, ASSEMBLY_GROUPS, CONSTRAINT_TOOLS, VIEWS, type Values } from './toolDefs';
import { familyOf } from './toolFamilies';
import { fittingRelationTools } from './constraintTools';
import { valueText } from './numberText';
import { curvePointIds } from './sketchCurves';
import { itemEntries, pictureEntries, type ItemAction } from './sketchItemsMenu';
import { quickSnapMenu } from './sketchQuickSnaps';
import { hasCopiedSketch, type PasteTarget } from './sketchPasteSketch';
import { drawCommandEntries } from './sketchDrawCommands';
import { splineMenuEntries } from './sketchSplineForms';

// ---- What was clicked -------------------------------------------------------------------------------------------

/** A spot on a face in the part's own frame: where it was clicked and the outward normal there. */
export interface FaceSpot {
    point: P3;
    normal: P3;
    curved: boolean;
}

/** The kind of surface a face is (pickRefs.modelPick): flat, cylinder, cone, or any other. */
export type FaceGeom = 'plane' | 'cylinder' | 'cone' | 'surface';
/** The kind of curve an edge is: straight, a circle or arc, or any other. */
export type EdgeGeom = 'line' | 'circle' | 'curve';

/**
 * `picks`: what the tools opened from the menu start with: the entity right-clicked, or all the picks when it is one of
 * them (SolidWorks: right-click a selected edge to fillet all the selected edges).
 */
export type ViewTarget =
    | { kind: 'face'; partId: string; picks: PickedEntity[]; geom: FaceGeom; spot: FaceSpot; worldNormal: P3 | null }
    | { kind: 'edge'; partId: string; picks: PickedEntity[]; geom: EdgeGeom; full: boolean; spot: FaceSpot | null }
    /** A sketch step drawn in the view. */
    | { kind: 'sketch'; partId: string; featureId: string }
    /** A reference plane, axis or point step drawn in the view. */
    | { kind: 'reference'; partId: string; featureId: string }
    | { kind: 'empty' };

/** What the menus read about the app. */
export interface MenuContext {
    workspace: 'part' | 'assembly';
    /** The part being edited (part workspace); in the assembly, the part a target belongs to is looked up in `parts`. */
    part: Part | null;
    parts: Part[];
    /** `${partId}/${featureId}` of the sketches and reference steps hidden in the view. */
    hiddenSketches: readonly string[];
    hiddenParts: readonly string[];
    settings: { grid: boolean; edges: boolean; sketches: boolean; others: boolean; labels: boolean };
}

export type ViewSetting = keyof MenuContext['settings'];

export interface OpenToolOptions {
    /** Faces and edges for the form's first selection box (SolidWorks preselection). */
    picks?: PickedEntity[];
    /** Values the form opens with instead of its defaults. */
    values?: Values;
    /** Values set once the form is open, through its own change handling (as if typed or chosen there). */
    patch?: Values;
    /** A part to select first (assembly tools act on the selection). */
    select?: string;
    /** Runs once the form is open. */
    then?: () => void;
}

/** The app actions the menus call (viewMenu.tsx has the real ones; tests record them). */
export interface MenuActions {
    /** Opens a toolbar tool by id, as its button does. */
    openTool(id: string, options?: OpenToolOptions): void;
    sketchOnFace(partId: string, face: FaceSpot, intent: SketchIntent): void;
    sketchOnPlane(partId: string, plane: SketchPlane, offset: number, intent: SketchIntent): void;
    /** A new sketch: pick its plane or face next. */
    newSketch(partId: string | null): void;
    /** Turns the view to look against a world direction (Normal to). */
    lookAlong(normal: P3): void;
    lookAtPlane(partId: string, plane: SketchPlane, offset: number): void;
    setView(id: string): void;
    fit(): void;
    edit(partId: string, featureId: string | null): void;
    setSketchHidden(partId: string, featureId: string, hidden: boolean): void;
    /** Copy sketch: the whole sketch to the sketch clipboard (sketchPasteSketch.ts). */
    copySketch(partId: string, featureId: string): void;
    /** Paste sketch: a new sketch on a face (where it was clicked) or a plane, holding the copied one. */
    pasteSketch(partId: string, target: PasteTarget): void;
    toggle(setting: ViewSetting): void;
    undo(): void;
    redo(): void;
    /** Hands a sketch step to the open form, as a click on the sketch in the view does (Sweep sorts profile and path). */
    pickSketch(featureId: string): void;
    editPart(partId: string, view: 'isolated' | 'inContext'): void;
    setHidden(partId: string, hidden: boolean): void;
    zoomToPart(partId: string): void;
}

/** What the components list does for a part; the view hands rename and delete to the list. */
export interface PartListActions {
    rename(part: Part): void;
    remove(part: Part): void;
    insertInstance(part: Part): void;
    duplicate(part: Part): void;
    editPattern(part: Part): void;
    removePattern(part: Part): void;
}

// ---- Helpers ----------------------------------------------------------------------------------------------------

const SEP = 'separator' as const;

/** The toolbar's label and icon of a tool, so an entry looks like the button it stands for. */
function toolLook(id: string): { label: string; icon: string } {
    const tool = ALL_TOOLS.find((t) => t.id === id);
    return { label: tool?.label ?? id, icon: tool?.icon ?? '' };
}

function toolEntry(a: MenuActions, id: string, options?: OpenToolOptions, extra: Partial<Extract<MenuEntry, { onSelect: () => void }>> = {}): MenuEntry {
    return { ...toolLook(id), onSelect: () => a.openTool(id, options), ...extra };
}

/** Drops separators at either end and doubled ones (entries left out by a condition leave them behind). */
export function tidy(items: (MenuEntry | false | null | undefined)[]): MenuEntry[] {
    const out: MenuEntry[] = [];
    for (const item of items) {
        if (!item || (item === SEP && (out.length === 0 || out[out.length - 1] === SEP || isHeader(out[out.length - 1])))) {
            continue;
        }
        out.push(item);
    }
    while (out[out.length - 1] === SEP) {
        out.pop();
    }
    return out;
}

const isHeader = (item: MenuEntry): boolean => typeof item === 'object' && 'header' in item;

const featureOf = (part: Part | null | undefined, id: string): Feature | undefined => part?.features?.find((f) => f.id === id);
const sketchOf = (part: Part | null | undefined, id: string) => {
    const f = featureOf(part, id);
    return f?.op === 'sketch' ? f : undefined;
};
const stepName = (f: Feature): string => f.name ?? f.id;
const sketchCount = (part: Part | null | undefined): number => (part?.features ?? []).filter((f) => f.op === 'sketch' && !f.suppressed).length;

/** The six standard views, as a submenu. */
function viewsMenu(a: MenuActions): MenuEntry {
    return {
        label: 'View orientation',
        icon: 'views',
        items: VIEWS.map((v) => ({ label: v.label === 'Iso' ? 'Isometric' : v.label, hint: v.key, onSelect: () => a.setView(v.id) })),
    };
}

const fitEntry = (a: MenuActions): MenuEntry => ({ label: 'Zoom to fit', icon: 'fit', hint: 'F', onSelect: () => a.fit() });
const undoEntries = (a: MenuActions): MenuEntry[] => [
    { label: 'Undo', icon: 'undo', hint: 'Ctrl+Z', onSelect: () => a.undo() },
    { label: 'Redo', icon: 'redo', hint: 'Ctrl+Shift+Z', onSelect: () => a.redo() },
];

/** The face a hole is drilled from, by its outward normal (Hole's Drill from), or null for a face at an angle. */
export function drillFace(normal: P3): string | null {
    const faces: [string, P3][] = [['top', [0, 1, 0]], ['bottom', [0, -1, 0]], ['front', [0, 0, 1]], ['back', [0, 0, -1]],
        ['right', [1, 0, 0]], ['left', [-1, 0, 0]]];
    const l = Math.hypot(...normal) || 1;
    return faces.find(([, n]) => n.every((c, i) => Math.abs(c - normal[i] / l) < 1e-6))?.[0] ?? null;
}

// ---- Part workspace: faces and edges -----------------------------------------------------------------------------

const FACE_NAMES: Record<FaceGeom, string> = { plane: 'Planar face', cylinder: 'Cylindrical face', cone: 'Conical face', surface: 'Face' };

export function faceMenu(t: Extract<ViewTarget, { kind: 'face' }>, c: MenuContext, a: MenuActions): MenuEntry[] {
    const flat = t.geom === 'plane';
    const round = t.geom === 'cylinder' || t.geom === 'cone';
    const picks = t.picks;
    const drill = flat ? drillFace(t.spot.normal) : null;
    const sketchTip = flat ? undefined : 'Sketches on the plane that touches the face where it was clicked';
    return tidy([
        { header: `${FACE_NAMES[t.geom]} of ${c.part?.name ?? 'the part'}` },
        { label: flat ? 'Sketch' : 'Sketch on tangent plane', icon: 'sketch', title: sketchTip, onSelect: () => a.sketchOnFace(t.partId, t.spot, 'sketch') },
        { label: 'Extrude', icon: 'extrude', title: 'Starts a sketch on this face, then extrudes it', onSelect: () => a.sketchOnFace(t.partId, t.spot, 'extrude') },
        { label: 'Cut', icon: 'pocket', title: 'Starts a sketch on this face, then cuts it', onSelect: () => a.sketchOnFace(t.partId, t.spot, 'cut') },
        hasCopiedSketch() && { label: 'Paste sketch', icon: 'duplicate', hint: 'Ctrl+V', title: 'A new sketch on this face holding the copied sketch, its centre where you clicked', onSelect: () => a.pasteSketch(t.partId, { face: t.spot }) },
        flat && t.worldNormal && { label: 'Normal to', icon: 'views', title: 'Look straight at this face', onSelect: () => a.lookAlong(t.worldNormal!) },
        SEP,
        t.geom === 'surface'
            ? { ...toolLook('plane'), disabled: true, onSelect: () => undefined, title: 'A plane needs a flat face, a cylinder, an edge or a point.' }
            : toolEntry(a, 'plane', { picks }, { title: flat ? 'A plane offset from this face' : 'A plane tangent to this face' }),
        round && toolEntry(a, 'axis', { picks, values: { kind: 'cylinder' } }, { title: 'An axis through the centre of this face' }),
        toolEntry(a, 'point', { picks, values: { kind: 'faceCentre' } }, { title: 'A point at the centre of this face' }),
        SEP,
        toolEntry(a, 'fillet', { picks }, { title: 'Fillet the edges of this face' }),
        toolEntry(a, 'chamfer', { picks }, { title: 'Chamfer the edges of this face' }),
        toolEntry(a, 'shell', { picks }, { title: 'Shell the part with this face removed' }),
        flat && toolEntry(a, 'draft', { picks }, { title: 'Draft with this face as the neutral plane' }),
        flat && (drill
            ? toolEntry(a, 'hole', {
                values: { face: drill, pos0: valueText(t.spot.point[0]), pos1: valueText(t.spot.point[1]), pos2: valueText(t.spot.point[2]) },
            }, { title: 'A hole drilled into this face where it was clicked' })
            : { ...toolLook('hole'), disabled: true, onSelect: () => undefined, title: 'Hole drills along X, Y or Z; this face is at an angle.' }),
        round && {
            ...toolLook('thread'), disabled: true, onSelect: () => undefined,
            title: 'A thread starts from a circular edge: right-click the edge at the end of the shaft or hole.',
        },
        SEP,
        toolEntry(a, 'measure', { picks }),
        toolEntry(a, 'material', undefined, { title: 'Colour and finish of the part' }),
        SEP,
        fitEntry(a),
    ]);
}

const EDGE_NAMES = (t: Extract<ViewTarget, { kind: 'edge' }>): string => (t.geom === 'line' ? 'Straight edge'
    : t.geom === 'circle' ? (t.full ? 'Circular edge' : 'Arc edge') : 'Edge');

export function edgeMenu(t: Extract<ViewTarget, { kind: 'edge' }>, c: MenuContext, a: MenuActions): MenuEntry[] {
    const picks = t.picks;
    return tidy([
        { header: `${EDGE_NAMES(t)} of ${c.part?.name ?? 'the part'}` },
        toolEntry(a, 'fillet', { picks }),
        toolEntry(a, 'chamfer', { picks }),
        t.geom === 'circle' && t.full && toolEntry(a, 'thread', { picks }, { title: 'A thread starting at this edge' }),
        SEP,
        t.geom !== 'curve' && toolEntry(a, 'plane', { picks }, { title: t.geom === 'line' ? 'A plane through or normal to this edge' : 'The plane of this edge' }),
        t.geom === 'line' && toolEntry(a, 'axis', { picks }, { title: 'An axis along this edge' }),
        t.geom === 'circle' && toolEntry(a, 'point', { picks, values: { kind: 'arcCentre' } }, { title: 'A point at the centre of this edge' }),
        t.geom === 'line' && toolEntry(a, 'point', { picks, values: { kind: 'along', by: 'percent', amount: '50' } },
            { title: 'A point at the middle of this edge' }),
        SEP,
        toolEntry(a, 'measure', { picks }),
        SEP,
        fitEntry(a),
    ]);
}

// ---- Sketch steps (in the view and in the tree) --------------------------------------------------------------------

/** The entries for a sketch step, shared by the view and the feature tree. `inTree` leaves out what the tree has. */
export function sketchStepEntries(part: Part, featureId: string, c: MenuContext, a: MenuActions, inTree = false): MenuEntry[] {
    const step = sketchOf(part, featureId);
    if (!step) {
        return [];
    }
    const hidden = c.hiddenSketches.includes(`${part.id}/${featureId}`);
    const { plane, offset = 0 } = step.sketch;
    const values = { sketch: featureId };
    const enough = sketchCount(part) >= 2;
    return tidy([
        !inTree && { label: 'Edit sketch', icon: 'sketch', onSelect: () => a.edit(part.id, featureId) },
        SEP,
        toolEntry(a, 'extrude', { values }, { title: `Extrude ${stepName(step)}` }),
        toolEntry(a, 'cut', { values }, { title: `Cut with ${stepName(step)}` }),
        toolEntry(a, 'revolve', { values }, { title: `Revolve ${stepName(step)}` }),
        enough
            ? toolEntry(a, 'loft', { patch: { sections: [featureId] } }, { title: `A loft starting at ${stepName(step)}; pick the next sections` })
            : { ...toolLook('loft'), disabled: true, onSelect: () => undefined, title: 'A loft needs two or more sketches.' },
        toolEntry(a, 'sweep', { then: () => a.pickSketch(featureId) }, { title: `A sweep with ${stepName(step)} as its profile or path` }),
        SEP,
        { label: 'Sketch on the same plane', icon: 'sketch', onSelect: () => a.sketchOnPlane(part.id, plane, offset, 'sketch') },
        { label: 'Normal to', icon: 'views', title: 'Look straight at the sketch plane', onSelect: () => a.lookAtPlane(part.id, plane, offset) },
        {
            label: hidden ? 'Show sketch' : 'Hide sketch', icon: hidden ? 'eye' : 'eye-off',
            onSelect: () => a.setSketchHidden(part.id, featureId, !hidden),
        },
        { label: 'Copy sketch', icon: 'duplicate', hint: 'Ctrl+C', title: 'Copies the whole sketch: paste it on a face or plane, or into an open sketch', onSelect: () => a.copySketch(part.id, featureId) },
        !inTree && SEP,
        !inTree && fitEntry(a),
    ]);
}

export function sketchMenu(t: Extract<ViewTarget, { kind: 'sketch' }>, c: MenuContext, a: MenuActions): MenuEntry[] {
    const part = c.part?.id === t.partId ? c.part : c.parts.find((p) => p.id === t.partId);
    const step = part && sketchOf(part, t.featureId);
    if (!part || !step) {
        return [];
    }
    return [{ header: stepName(step) }, ...sketchStepEntries(part, t.featureId, c, a)];
}

// ---- Reference planes, axes and points ---------------------------------------------------------------------------

const REF_ICONS: Partial<Record<Feature['op'], string>> = { plane: 'ref-plane', axis: 'ref-axis', point: 'ref-point' };

/** The entries for a reference step, shared by the view and the feature tree (`inTree`: less what the tree has). */
export function referenceStepEntries(part: Part, featureId: string, c: MenuContext, a: MenuActions, inTree = false): MenuEntry[] {
    const step = featureOf(part, featureId);
    if (!step || !REF_ICONS[step.op]) {
        return [];
    }
    const hidden = c.hiddenSketches.includes(`${part.id}/${featureId}`);
    const plane = step.op === 'plane';
    return tidy([
        plane && { label: 'Sketch', icon: 'sketch', title: `Sketch on ${stepName(step)}`, onSelect: () => a.sketchOnPlane(part.id, { planeRef: featureId }, 0, 'sketch') },
        plane && { label: 'Normal to', icon: 'views', title: 'Look straight at the plane', onSelect: () => a.lookAtPlane(part.id, { planeRef: featureId }, 0) },
        plane && toolEntry(a, 'plane', { patch: { r1list: `plane:${featureId}` } }, { label: 'New plane from this one', title: 'A plane offset from this one' }),
        plane && hasCopiedSketch() && { label: 'Paste sketch', icon: 'duplicate', hint: 'Ctrl+V', title: 'A new sketch on this plane holding the copied sketch', onSelect: () => a.pasteSketch(part.id, { plane: { planeRef: featureId } }) },
        !inTree && SEP,
        !inTree && { label: `Edit ${step.op}`, icon: REF_ICONS[step.op], onSelect: () => a.edit(part.id, featureId) },
        { label: hidden ? 'Show' : 'Hide', icon: hidden ? 'eye' : 'eye-off', onSelect: () => a.setSketchHidden(part.id, featureId, !hidden) },
        !inTree && SEP,
        !inTree && fitEntry(a),
    ]);
}

export function referenceMenu(t: Extract<ViewTarget, { kind: 'reference' }>, c: MenuContext, a: MenuActions): MenuEntry[] {
    const part = c.part?.id === t.partId ? c.part : c.parts.find((p) => p.id === t.partId);
    const step = part && featureOf(part, t.featureId);
    if (!part || !step) {
        return [];
    }
    return [{ header: stepName(step) }, ...referenceStepEntries(part, t.featureId, c, a)];
}

/** A base plane (Front, Top, Right) in the tree: what is added to its Sketch entry. */
export function basePlaneEntries(part: Part, plane: 'front' | 'top' | 'right', a: MenuActions): MenuEntry[] {
    return [
        { label: 'Normal to', icon: 'views', title: 'Look straight at the plane', onSelect: () => a.lookAtPlane(part.id, plane, 0) },
        toolEntry(a, 'plane', { patch: { r1list: plane } }, { label: 'New plane from this one', title: 'A plane offset from this one' }),
        ...(hasCopiedSketch() ? [{ label: 'Paste sketch', icon: 'duplicate', hint: 'Ctrl+V', title: 'A new sketch on this plane holding the copied sketch', onSelect: () => a.pasteSketch(part.id, { plane }) }] : []),
    ];
}

/** Feature-tree entries added to a modelling step's menu. */
export function featureStepExtras(a: MenuActions): MenuEntry[] {
    return [fitEntry(a)];
}

// ---- Empty space -------------------------------------------------------------------------------------------------

export function emptyMenu(c: MenuContext, a: MenuActions): MenuEntry[] {
    const s = c.settings;
    if (c.workspace === 'assembly') {
        const insert = ASSEMBLY_GROUPS.find((g) => g.id === 'insert')?.tools.filter((t) => t.id !== 'new-part') ?? [];
        return tidy([
            toolEntry(a, 'new-part'),
            { label: 'Insert', icon: 'box', items: insert.map((t) => toolEntry(a, t.id)) },
            SEP,
            viewsMenu(a),
            fitEntry(a),
            SEP,
            { label: 'Grid', checked: s.grid, hint: 'G', onSelect: () => a.toggle('grid') },
            { label: 'Edges', checked: s.edges, onSelect: () => a.toggle('edges') },
            { label: 'Labels', checked: s.labels, onSelect: () => a.toggle('labels') },
            SEP,
            ...undoEntries(a),
        ]);
    }
    return tidy([
        c.part && { header: c.part.name },
        { label: 'Sketch', icon: 'sketch', hint: 'S', title: 'A new sketch: pick a plane or a flat face next', onSelect: () => a.newSketch(c.part?.id ?? null) },
        SEP,
        viewsMenu(a),
        fitEntry(a),
        SEP,
        { label: 'Show sketches', checked: s.sketches, onSelect: () => a.toggle('sketches') },
        { label: 'Show other parts', checked: s.others, onSelect: () => a.toggle('others') },
        { label: 'Grid', checked: s.grid, hint: 'G', onSelect: () => a.toggle('grid') },
        { label: 'Edges', checked: s.edges, onSelect: () => a.toggle('edges') },
        SEP,
        ...undoEntries(a),
    ]);
}

// ---- Assembly: a part ----------------------------------------------------------------------------------------------

/**
 * A part of the assembly, the same in the view and in the components list. `face`: where it was clicked in the
 * view (adds a sketch on that face).
 */
export function componentMenu(part: Part, c: MenuContext, a: MenuActions, list: PartListActions, face: FaceSpot | null = null): MenuEntry[] {
    const instance = !!part.instanceOf;
    const source = instance ? c.parts.find((p) => p.id === part.instanceOf) ?? part : part;
    const instances = c.parts.filter((p) => p.instanceOf === part.id).length;
    const hidden = c.hiddenParts.includes(part.id);
    const select = { select: part.id };
    return tidy([
        { header: part.name },
        { label: instance ? 'Edit the shared design' : 'Edit part', hint: 'double-click', onSelect: () => a.editPart(part.id, 'isolated') },
        { label: 'Edit in place', onSelect: () => a.editPart(part.id, 'inContext') },
        face && {
            label: 'Sketch on this face', icon: 'sketch', title: 'Edits the part and starts a sketch on the face that was clicked',
            onSelect: () => a.sketchOnFace(source.id, face, 'sketch'),
        },
        !instance && { label: 'Insert instance', onSelect: () => list.insertInstance(part) },
        ...(part.repeat
            ? [{ label: 'Edit pattern', icon: 'pattern', onSelect: () => list.editPattern(part) },
                { label: 'Remove pattern', onSelect: () => list.removePattern(part) }]
            : [{ label: 'Pattern this part', icon: 'pattern', onSelect: () => list.editPattern(part) }]),
        SEP,
        toolEntry(a, 'move', select),
        toolEntry(a, 'rotate', select),
        toolEntry(a, 'mirror-copy', select),
        toolEntry(a, 'material', select),
        toolEntry(a, 'picture', select),
        SEP,
        { label: 'Rename', onSelect: () => list.rename(part) },
        !instance && { label: 'Duplicate as new part', icon: 'duplicate', onSelect: () => list.duplicate(part) },
        { label: hidden ? 'Show' : 'Hide', icon: hidden ? 'eye' : 'eye-off', onSelect: () => a.setHidden(part.id, !hidden) },
        { label: instance ? 'Zoom to instance' : 'Zoom to part', icon: 'fit', onSelect: () => a.zoomToPart(part.id) },
        SEP,
        {
            label: instance ? 'Delete instance' : instances ? 'Delete with all instances' : 'Delete',
            icon: 'delete',
            danger: true,
            onSelect: () => list.remove(part),
        },
    ]);
}

// ---- The view: dispatch by target ----------------------------------------------------------------------------------

/** The right-click menu of the 3D view (outside an open sketch). */
export function viewMenu(t: ViewTarget, c: MenuContext, a: MenuActions, list: PartListActions): MenuEntry[] {
    if (c.workspace === 'assembly') {
        const partId = t.kind === 'empty' ? null : t.partId;
        const part = partId ? c.parts.find((p) => p.id === partId) : undefined;
        if (!part) {
            return emptyMenu(c, a);
        }
        const face = t.kind === 'face' ? t.spot : t.kind === 'edge' ? t.spot : null;
        return componentMenu(part, c, a, list, face);
    }
    // Only the part being edited takes picks; anything else is treated as empty space.
    if (t.kind !== 'empty' && t.partId !== c.part?.id) {
        return emptyMenu(c, a);
    }
    switch (t.kind) {
        case 'face':
            return faceMenu(t, c, a);
        case 'edge':
            return edgeMenu(t, c, a);
        case 'sketch':
            return sketchMenu(t, c, a);
        case 'reference':
            return referenceMenu(t, c, a);
        default:
            return emptyMenu(c, a);
    }
}

// ---- Open sketch ---------------------------------------------------------------------------------------------------

/** What the open sketch's menu reads. */
export interface SketchMenuState {
    stage: 'plane' | 'draw';
    tool: SketchTool;
    geometry: SketchGeometry;
    /** Picks of the entity in progress. */
    draft: number;
    /** Selected points and curves (relations and dimensions left out). */
    selection: Pick[];
    /** Last-used variant per toolbar family (the toolbar's flyout memory). */
    lastUsed: Record<string, string>;
}

export interface SketchMenuActions {
    openTool(id: string): void;
    deleteSelected(): void;
    endChain(): void;
    fitSketch(): void;
    closeSketch(): void;
    /** Sketch text, block instances: dissolve, explode, edit (sketchItemsMenu.ts). */
    itemAction?(action: ItemAction, id: string): void;
}

/** Tools that draw a chain of pieces, ended by a double-click, Enter or right-click > End chain. */
const CHAIN_TOOLS: SketchTool[] = ['line', 'centerline', 'tangentArc'];

const isDrawTool = (tool: SketchTool): boolean => tool !== 'select' && tool !== 'dimension' && tool !== 'xform' && !tool.startsWith('c:')
    && !['trim', 'extend', 'fillet', 'chamfer', 'offset', 'mirror', 'split'].includes(tool);

/** The draw tools offered on empty sketch space: the variant in use of each family on the toolbar, then Point. */
export function drawToolIds(lastUsed: Record<string, string>): string[] {
    const families: [string, string][] = [['line', 'sk-line'], ['rectangle', 'sk-rect'], ['circle', 'sk-circle'], ['arc', 'sk-centerArc'],
        ['slot', 'sk-slot']];
    const ids = families.map(([family, first]) => {
        const last = lastUsed[family];
        return last && familyOf(last)?.id === family && ALL_TOOLS.some((t) => t.id === last) ? last : first;
    });
    return [...ids, 'sk-point'].filter((id) => ALL_TOOLS.some((t) => t.id === id));
}

const ENTITY_NAMES: Record<string, string> = {
    point: 'Point', line: 'Line', circle: 'Circle', arc: 'Arc', ellipse: 'Ellipse', ellipseArc: 'Partial ellipse', parabola: 'Parabola',
    conic: 'Conic', spline: 'Spline', styleSpline: 'Style spline',
};

/** Is every picked point (and each curve's defining points, a circle's radius) locked? */
export function allLocked(g: SketchGeometry, picks: Pick[]): boolean {
    const fixed = new Set(g.constraints.flatMap((k) => (k.kind === 'fix' ? [k.point] : k.kind === 'fixRadius' ? [k.curve] : [])));
    const needed = picks.flatMap((p) => {
        if (p.type === 'point') {
            return [p.id];
        }
        const c = g.curves.find((k) => k.id === p.id);
        // A circle is locked by its centre and its radius; every other curve by the points it is built on.
        return !c ? [] : c.kind === 'circle' ? [c.center, c.id] : curvePointIds(c);
    });
    return needed.length > 0 && needed.every((id) => fixed.has(id));
}

/** The relation tools that fit the selection, by the rule the relation buttons use (relationsFromPicks). */
export function fittingRelations(g: SketchGeometry, picks: Pick[]): typeof CONSTRAINT_TOOLS {
    return fittingRelationTools(g, picks);
}

/** The open sketch's right-click menu, for the selection (`selection` already includes what was right-clicked). */
export function sketchSpaceMenu(s: SketchMenuState, a: SketchMenuActions): MenuEntry[] {
    if (s.stage === 'plane') {
        return tidy([
            { header: 'Choose a plane or a flat face' },
            { label: 'Cancel sketch', icon: 'cancel', onSelect: () => a.closeSketch() },
        ]);
    }
    const tool = toolLook(`sk-${s.tool}`);
    const select = { label: 'Select', icon: 'select', hint: 'V', title: 'Stop this tool', onSelect: () => a.openTool('sk-select') };
    const exit: MenuEntry[] = [
        { ...toolLook('sk-finish'), onSelect: () => a.openTool('sk-finish') },
        { ...toolLook('sk-cancel'), danger: true, onSelect: () => a.openTool('sk-cancel') },
    ];
    const history: MenuEntry[] = [
        { label: 'Undo', icon: 'undo', hint: 'Ctrl+Z', onSelect: () => a.openTool('sk-undo') },
        { label: 'Redo', icon: 'redo', hint: 'Ctrl+Shift+Z', onSelect: () => a.openTool('sk-redo') },
    ];
    // Mid-command (SolidWorks: right-click > End chain): end what is being drawn, keep the tool.
    if (isDrawTool(s.tool) && s.draft > 0) {
        const chain = CHAIN_TOOLS.includes(s.tool);
        return tidy([
            { header: tool.label },
            { label: chain ? 'End chain' : 'Drop this shape', hint: chain ? 'double-click' : 'Esc', onSelect: () => a.endChain() },
            select,
            // SolidWorks: right-click > Quick Snaps, for the entity being drawn.
            quickSnapMenu(),
            SEP,
            ...history,
        ]);
    }
    const g = s.geometry;
    const picks = s.selection;
    const releaseTool = s.tool !== 'select' && select;
    if (picks.length) {
        const curves = picks.filter((p) => p.type === 'curve').map((p) => g.curves.find((c) => c.id === p.id)).filter((c) => !!c);
        const construction = curves.length > 0 && curves.every((c) => c!.construction);
        const locked = allLocked(g, picks);
        const header = picks.length === 1 ? ENTITY_NAMES[kindOf(g, picks[0])] ?? 'Curve' : `${picks.length} items`;
        const relations = fittingRelations(g, picks);
        // A curve of a text, equation curve or block instance: the item's own entries first.
        const item = itemEntries(g, picks, a);
        const splines = item ? [] : splineMenuEntries(g, picks, (id) => a.openTool(id));
        return tidy([
            { header: item?.header ?? header },
            ...(item ? [...item.entries, SEP] : []),
            ...(splines.length ? [...splines, SEP] : []),
            { label: 'Delete', icon: 'delete', hint: 'Del', danger: true, onSelect: () => a.deleteSelected() },
            curves.length
                ? { ...toolLook('sk-construction'), label: 'Construction geometry', hint: 'X', checked: construction, onSelect: () => a.openTool('sk-construction') }
                : { ...toolLook('sk-construction'), label: 'Construction geometry', disabled: true, onSelect: () => undefined,
                    title: 'Only lines, arcs and circles can be construction geometry.' },
            SEP,
            // Select chain, paths, reverse endpoint tangent, infinite length (sketchDrawCommands.ts).
            ...drawCommandEntries(g, picks, a),
            SEP,
            ...relations.map((r) => ({ label: r.label, icon: `c-${r.id}`, title: r.hint, onSelect: () => a.openTool(`sk-c-${r.id}`) })),
            { label: locked ? 'Unlock' : 'Lock', icon: 'c-fix', title: locked ? 'Free it to move again' : 'Keep it where it is', onSelect: () => a.openTool('sk-c-fix') },
            { ...toolLook('sk-dimension'), hint: 'D', onSelect: () => a.openTool('sk-dimension') },
            SEP,
            releaseTool,
            ...history,
        ]);
    }
    return tidy([
        releaseTool,
        ...(isDrawTool(s.tool) ? [quickSnapMenu()] : []),
        ...drawToolIds(s.lastUsed).map((id) => ({ ...toolLook(id), onSelect: () => a.openTool(id) })),
        { ...toolLook('sk-dimension'), hint: 'D', onSelect: () => a.openTool('sk-dimension') },
        ...pictureEntries(g, a),
        // Geometry from the model (a face or edge right-clicked here starts Convert entities with it).
        ...['sk-convert', 'sk-intersection', 'sk-silhouette'].map((id) => ({ ...toolLook(id), onSelect: () => a.openTool(id) })),
        SEP,
        ...exit,
        SEP,
        { label: 'Zoom to fit', icon: 'fit', hint: 'F', onSelect: () => a.fitSketch() },
        // SolidWorks: Normal To in a 2D sketch looks straight at the sketch; again, from the other side (sketchNormalTo.tsx).
        { label: 'Normal to', icon: 'views', title: 'Look straight at the sketch plane; again, from the other side', onSelect: () => a.openTool('sk-normal-to') },
        ...history,
    ]);
}
