// What each toolbar tool asks for and which studio tool call it turns into. All model changes go through
// runTool, exactly as Jarvis makes them; the server validates them and broadcasts the new state.
// Feature and body tools also edit existing history items: with `ctx.edit` set they open prefilled and
// apply with features_update / parts_update instead of adding.

import { useEffect, useState, type ReactNode } from 'react';
import {
    shapeHalfExtents, THREAD_SIZES, type Feature, type FastenerType, type Material, type Part, type Project, type Shape,
    type SketchShape, type ThreadSize, type Vec3,
} from '@jarvis/core';
import { heatsetData, STANDARD_LENGTHS, threadData } from '@jarvis/core/fasteners';
import { clearEditing, editItem, refit, runTool, select, setPerspective, setSketchHidden, setWorkspace, useStudio } from './state';
import { loadedMeshBounds } from './meshes';
import { captureToolCalls, type ToolCall } from './preview';
import { RegionPickSession, useRegionPick } from './regionPick';
import { showError } from './menus';
import { newPart } from './newPart';
import { addPicture, PicturePicker } from './DecalPanel';
import { moreConstrainTools, moreDrawTools, moreModifyTools } from './sketchToolDefs';
import { setSnapModel, useSketchModel } from './sketchModel';
import { modelSketchTools } from './sketchModelForms';
import { curveForms } from './sketchCurveForms';
import { lineDirection, lineOnly, moreSketchTools, PickBoxes } from './sketchMoreForms';
import { CONSTRAINT_TOOLS } from './constraintTools';
import { dimensionForm } from './sketchDimForms';
import { freecadExportTool } from './freecadExportTool';
import { SKETCH_SETTING_FIELDS, SolveButton, sketchSettingValues, sketchSettingsOf } from './sketchSettingsForm';
import { gridSnapStep, solvesAtOnce } from './sketchSettings';
import { editToolForms } from './sketchEditForms';
import { extrasDrawTools, extrasModifyTools } from './sketchExtrasTools';
import { withPatternExtras } from './sketchPatternForms';
import { SPLINE_OPTION_FIELDS, applySplineOptions, splineOptionValues } from './sketchSplineForms';
import { withDrawForm } from './sketchDrawForms';
import { drawCommandForms, drawCommandTools, modifyCommandTools } from './sketchDrawCommandForms';
import { normalToTool, SketchNormalTo } from './sketchNormalTo';
import type { CircularPatternOptions, LinearPatternOptions } from './sketchPattern';
import type { Pt } from './sketchMath';
import { evaluateTools } from './evaluateToolDefs';
import { referenceEditor, referenceTools } from './referenceToolDefs';
import { nextFeatureName, type Nameable } from './featureNames';
import { stepAtBar } from './historyOps';
import { designCopy } from './partCopy';
import { BOX_DEFAULTS, boxShape, boxValues, CYLINDER_DEFAULTS, cylinderShape, cylinderValues } from './primitiveForm';
import { circularPatternTool, combineTool, linearPatternTool, mirrorTool, patternEditor, splitTool } from './patternToolDefs';
import { Icon } from './icons';
import {
    choosePlane, circularPatternSelected, closeSketch, currentSketch, finishDefaults, linearPatternSelected, patternCentre, previewPattern, redoSketch, setTool,
    sketchProfiles, startSketch, undoSketch, useSketcher, constraintTool, toggleConstructionSelected, type FinishOp, type SketchIntent,
    type SketchTool, setDimensionTool, setSketchSettings, solveSketch,
} from './sketcher';
import { evaluate, type ConstraintTool } from './sketchGeometry';
import { angledPlane, planeLabel } from './sketchMath';
import { itemsOf, pickItems, type PickEntity, type PickItem } from './pickField';
import { chamferFeature, draftFeature, filletFeature, shellFeature } from './pickFeatures';
import { valueText } from './numberText';
import {
    axisOptions, axisValue, defaultAxis, readRevolve, revolveAxisKey, revolveStepFields, revolveValues, type RevolveOptionValues,
} from './revolveAxis';
import { derivedSketchTool, rapidSketchTool, sketchToggleTools, wholeModifyTools } from './sketchWholeTools';
import { twoDToThreeDTools } from './sketch2d3dForms';
import { askDiscard } from './sketchBar';

export type Values = Record<string, string | boolean | string[] | PickItem[]>;
export type Result = { text: string; isError: boolean };

export interface Field {
    key: string;
    label: string;
    kind: 'number' | 'text' | 'select' | 'check' | 'multi' | 'color' | 'vec' | 'range' | 'pick';
    unit?: string;
    step?: number;
    min?: number;
    max?: number;
    options?: { value: string; label: string }[];
    /** vec fields: axis labels, stored as key0, key1, key2. */
    axes?: [string, string, string];
    show?: (v: Values) => boolean;
    /** Property manager: consecutive fields with the same section share a titled, collapsible block. */
    section?: string;
    /** pick fields (selection boxes): what a click in the view adds, and whether the box takes more than one. */
    entities?: PickEntity[];
    multi?: boolean;
    /** pick fields: only flat faces. */
    flat?: boolean;
    /** pick fields: why a picked item is refused, or null to take it. */
    accept?: (item: PickItem) => string | null;
    /** vec fields: once focused, a click on the part sets the value (pickField.ts). */
    pickable?: boolean;
}

export interface Ctx {
    /** The part the tools act on: the active part in the part workspace, the selection in the assembly. */
    part: Part | null;
    project: Project | null;
    /** A history item being edited: a feature, or the part's base body (feature null). */
    edit: { partId: string; feature: Feature | null } | null;
}

/** Lets a popup body change its values or run a tool call right away (nudges, presets). */
export interface PopupApi {
    values: Values;
    set: (patch: Values) => void;
    run: (call: () => Promise<Result>, close?: boolean) => void;
}

export interface UiSettings {
    grid: boolean;
    edges: boolean;
    /** Perspective in the view that is open: the sketch being drawn, else the 3D view. */
    perspective: boolean;
    showOthers: boolean;
    sketchTool: SketchTool | null;
}

export interface ToolDef {
    id: string;
    label: string;
    icon: string;
    /** Short hint added to the tooltip. */
    hint?: string;
    shortcut?: string;
    needsPart?: boolean;
    /** Present but not usable yet; the text is the tooltip. */
    soon?: string;
    /** Runs on click without a popup. */
    instant?: (ctx: Ctx) => void;
    /** For instant tools: open the popup instead when this holds. */
    popupIf?: (ctx: Ctx) => boolean;
    /** Toggle state for instant tools. */
    active?: (ctx: Ctx, settings: UiSettings) => boolean;
    fields?: (ctx: Ctx) => Field[];
    defaults?: (ctx: Ctx) => Values;
    onChange?: (key: string, v: Values, ctx: Ctx) => Values | void;
    apply?: (v: Values, ctx: Ctx) => Promise<Result>;
    applyLabel?: string;
    danger?: boolean;
    /** Keep the popup open after a successful apply and show the server's answer. */
    keepOpen?: boolean;
    /** Extra popup content above (top) or below the fields. */
    top?: (api: PopupApi, ctx: Ctx) => ReactNode;
    extra?: (api: PopupApi, ctx: Ctx) => ReactNode;
    /** Popups without an Apply button (they act immediately). */
    noApply?: boolean;
    width?: number;
    /** Feature op this tool creates and can edit. */
    op?: Feature['op'];
    /** Shape kinds this tool creates and can edit as a base body. */
    shapes?: Shape['kind'][];
    /** Opens in the property manager (left panel) in the part workspace even without `op` or `shapes`. */
    panel?: boolean;
    /** Picks sketch regions: of the sketch being edited, or of the sketch step in the `sketch` value. */
    regionPick?: 'sketcher' | 'step';
    /**
     * Live preview while the form is open: apply runs with its tool calls captured, not sent (see toolForm.tsx).
     * Only for tools whose apply makes its model-editing call synchronously and does nothing else before it.
     */
    preview?: boolean;
    /**
     * Live preview for a tool whose apply does more than one model call (the sketch finish panel): the calls to
     * preview for these values, made without side effects. Used instead of capturing apply.
     */
    previewCalls?: (v: Values, ctx: Ctx) => ToolCall[];
}

export interface ToolGroup {
    id: string;
    label: string;
    icon: string;
    tools: ToolDef[];
    /** Lower collapses into a menu first when the toolbar runs out of room; undefined never collapses. */
    collapse?: number;
    /** A shorter name for the collapsed menu's button, where the label is long. */
    short?: string;
}

// ---- Helpers ------------------------------------------------------------------------------------------

export const fmt = valueText;

function num(v: Values, key: string, label: string, opts: { min?: number; positive?: boolean } = {}): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    if (opts.positive && n <= 0) {
        throw new Error(`${label} must be greater than 0.`);
    }
    if (opts.min !== undefined && n < opts.min) {
        throw new Error(`${label} must be at least ${opts.min}.`);
    }
    return n;
}

function vec(v: Values, key: string, label: string): Vec3 {
    return [0, 1, 2].map((i) => num(v, `${key}${i}`, `${label} ${'XYZ'[i]}`)) as Vec3;
}

function vecValues(key: string, value: Vec3): Values {
    return { [`${key}0`]: fmt(value[0]), [`${key}1`]: fmt(value[1]), [`${key}2`]: fmt(value[2]) };
}

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

/** Wraps validation errors in the same shape as a server error, so the popup shows them inline. */
export async function attempt(build: () => Promise<Result>): Promise<Result> {
    try {
        return await build();
    } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
}

function half(part: Part | null): Vec3 {
    return part ? shapeHalfExtents(part.shape) : [10, 10, 10];
}

/**
 * Centre and half size of a part in its own frame: of its built body when that is loaded (a part built from
 * sketches has no size of its own), else of its base shape about the origin.
 */
function partBox(part: Part | null): { centre: Vec3; half: Vec3 } {
    const box = part ? loadedMeshBounds(part.id) : null;
    if (box) {
        const [lo, hi] = box;
        return { centre: [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2) as Vec3, half: [0, 1, 2].map((i) => (hi[i] - lo[i]) / 2) as Vec3 };
    }
    return { centre: [0, 0, 0], half: half(part) };
}

/** The full part from the history (the viewport copy may be cut back by the timeline). */
export function fullPart(id: string): Part | undefined {
    return useStudio.getState().history?.parts.find((p) => p.id === id);
}

const PLA_GREY: Material = { color: '#b8bcc4', metalness: 0, roughness: 0.7 };
const STEEL: Material = { color: '#a3a9b0', metalness: 0.9, roughness: 0.32 };
const BRASS: Material = { color: '#c9a24a', metalness: 1, roughness: 0.3 };

/** Adds one part, selects it and reports like the server does. */
async function addPart(part: Record<string, unknown>): Promise<Result & { id?: string }> {
    const result = await runTool('parts_add', { parts: [part] });
    const id = /Added \d+ part\(s\): ([^,]+?)\.$/.exec(result.text)?.[1];
    if (!result.isError && id) {
        select(id);
    }
    return { ...result, id };
}

/** Adds a feature, or updates the edited one in place (keeping its id and name). */
export function saveFeature(ctx: Ctx, feature: Record<string, unknown>): Promise<Result> {
    if (ctx.edit?.feature) {
        const { name: _name, op: _op, ...fields } = feature;
        return runTool('features_update', { partId: ctx.edit.partId, updates: [{ id: ctx.edit.feature.id, ...fields }] });
    }
    if (!ctx.part) {
        return Promise.resolve({ text: 'Select a part first.', isError: true });
    }
    // New steps are named the SolidWorks way (Boss-Extrude1, Fillet2); what they do is in their tooltip. Names
    // count steps below the rollback bar too (the viewport copy of the part leaves them out).
    const all = fullPart(ctx.part.id)?.features ?? ctx.part.features;
    const name = nextFeatureName(all, feature as unknown as Nameable);
    // While the part is rolled back the step goes in at the bar, which then moves below it (as in SolidWorks).
    const before = stepAtBar(useStudio.getState().history, ctx.part.id);
    return runTool('features_add', { partId: ctx.part.id, features: [{ ...feature, name }], ...(before ? { before } : {}) });
}

/** The edited feature, when it has this op. */
function edited<O extends Feature['op']>(ctx: Ctx, op: O): Extract<Feature, { op: O }> | null {
    const f = ctx.edit?.feature;
    return f && f.op === op ? (f as Extract<Feature, { op: O }>) : null;
}

// ---- Create (and edit base bodies) ---------------------------------------------------------------------

const placeFields: Field[] = [
    { key: 'x', label: 'Position X', kind: 'number', unit: 'mm' },
    { key: 'z', label: 'Position Z', kind: 'number', unit: 'mm' },
    { key: 'y', label: 'Bottom at Y', kind: 'number', unit: 'mm' },
];
const placeDefaults: Values = { x: '0', z: '0', y: '0' };

function createTool(id: Shape['kind'], label: string, fields: Field[], defaults: Values,
    fromShape: (shape: Shape) => Values | null, build: (v: Values) => { shape: Shape; halfHeight: number }): ToolDef {
    return {
        id,
        label,
        icon: id,
        hint: 'placed on the ground',
        shapes: [id],
        preview: true,
        fields: (ctx) => (ctx.edit ? fields : [{ key: 'name', label: 'Name', kind: 'text' }, ...fields, ...placeFields]),
        defaults: (ctx) => {
            const base = ctx.edit && !ctx.edit.feature ? fullPart(ctx.edit.partId)?.shape : null;
            return { name: label, ...defaults, ...placeDefaults, ...(base?.kind === id ? fromShape(base) ?? {} : {}) };
        },
        applyLabel: 'Create',
        apply: (v, ctx) => attempt(async () => {
            const { shape, halfHeight } = build(v);
            if (ctx.edit) {
                return runTool('parts_update', { updates: [{ id: ctx.edit.partId, shape }] });
            }
            const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : label;
            return addPart({
                name,
                shape,
                position: [num(v, 'x', 'Position X'), num(v, 'y', 'Bottom Y') + halfHeight, num(v, 'z', 'Position Z')],
                rotation: [0, 0, 0],
                material: PLA_GREY,
            });
        }),
    };
}

const SCREWS: FastenerType[] = ['socketCap', 'buttonHead', 'countersunk', 'hexBolt'];
const FASTENER_TYPES = opts(
    ['socketCap', 'Socket cap screw (ISO 4762)'],
    ['buttonHead', 'Button head screw (ISO 7380)'],
    ['countersunk', 'Countersunk screw (ISO 10642)'],
    ['hexBolt', 'Hex bolt (ISO 4017)'],
    ['hexNut', 'Hex nut (ISO 4032)'],
    ['nylocNut', 'Nyloc nut (ISO 10511)'],
    ['squareNut', 'Square nut (DIN 562)'],
    ['washer', 'Washer (ISO 7089)'],
    ['heatsetInsert', 'Heat-set insert'],
);
const FASTENER_NAMES: Record<FastenerType, string> = {
    socketCap: 'socket cap screw',
    buttonHead: 'button head screw',
    countersunk: 'countersunk screw',
    hexBolt: 'hex bolt',
    hexNut: 'hex nut',
    nylocNut: 'nyloc nut',
    squareNut: 'square nut',
    washer: 'washer',
    heatsetInsert: 'heat-set insert',
};
const SIZE_OPTIONS = THREAD_SIZES.map((s) => ({ value: s, label: s }));

function fastenerShape(v: Values): Shape {
    const type = v.type as FastenerType;
    const size = v.size as ThreadSize;
    return SCREWS.includes(type)
        ? { kind: 'fastener', type, size, length: Number(v.length), thread: v.thread as 'modelled' | 'plain' }
        : { kind: 'fastener', type, size };
}

const fastener: ToolDef = {
    id: 'fastener',
    label: 'Fastener',
    icon: 'fastener',
    hint: 'ISO screws, nuts, washers and inserts',
    width: 300,
    shapes: ['fastener'],
    preview: true,
    fields: (ctx) => [
        { key: 'type', label: 'Type', kind: 'select', options: FASTENER_TYPES },
        { key: 'size', label: 'Thread', kind: 'select', options: SIZE_OPTIONS },
        {
            key: 'length',
            label: 'Length',
            kind: 'select',
            unit: 'mm',
            options: STANDARD_LENGTHS.map((l) => ({ value: String(l), label: String(l) })),
            show: (v) => SCREWS.includes(v.type as FastenerType),
        },
        { key: 'thread', label: 'Thread model', kind: 'select', options: opts(['modelled', 'Modelled helix'], ['plain', 'Plain shank']),
            show: (v) => SCREWS.includes(v.type as FastenerType) },
        ...(ctx.edit ? [] : placeFields),
    ],
    defaults: (ctx) => {
        const base = ctx.edit && !ctx.edit.feature ? fullPart(ctx.edit.partId)?.shape : null;
        const values: Values = { type: 'socketCap', size: 'M3', length: '10', thread: 'modelled', ...placeDefaults };
        if (base?.kind === 'fastener') {
            Object.assign(values, { type: base.type, size: base.size, length: String(base.length ?? 10), thread: base.thread ?? 'modelled' });
        }
        return values;
    },
    applyLabel: 'Create',
    apply: (v, ctx) => attempt(async () => {
        const shape = fastenerShape(v);
        if (ctx.edit) {
            return runTool('parts_update', { updates: [{ id: ctx.edit.partId, shape }] });
        }
        const type = v.type as FastenerType;
        const screw = SCREWS.includes(type);
        const length = Number(v.length);
        // Screws hang from the underside of the head, so standing upright the head sits `length` up.
        const y = num(v, 'y', 'Bottom Y') + (screw ? length : 0);
        return addPart({
            name: screw ? `${v.size}×${length} ${FASTENER_NAMES[type]}` : `${v.size} ${FASTENER_NAMES[type]}`,
            shape,
            position: [num(v, 'x', 'Position X'), y, num(v, 'z', 'Position Z')],
            rotation: [0, 0, 0],
            material: type === 'heatsetInsert' ? BRASS : STEEL,
        });
    }),
};

const primitiveTools: ToolDef[] = [
    createTool('box', 'Box', [
        { key: 'w', label: 'Width X', kind: 'number', unit: 'mm', min: 0 },
        { key: 'h', label: 'Height Y', kind: 'number', unit: 'mm', min: 0 },
        { key: 'd', label: 'Depth Z', kind: 'number', unit: 'mm', min: 0 },
        { key: 'autoR', label: 'Automatic edge round', kind: 'check' },
        { key: 'r', label: 'Edge round', kind: 'number', unit: 'mm', min: 0, step: 0.5, show: (v) => !v.autoR },
    ], BOX_DEFAULTS,
    (s) => (s.kind === 'box' ? boxValues(s) : null),
    (v) => {
        const shape = boxShape(v);
        return { shape, halfHeight: shape.size[1] / 2 };
    }),
    createTool('cylinder', 'Cylinder', [
        { key: 'r', label: 'Radius', kind: 'number', unit: 'mm', min: 0 },
        { key: 'taper', label: 'Taper', kind: 'check' },
        { key: 'rt', label: 'Top radius', kind: 'number', unit: 'mm', min: 0, show: (v) => !!v.taper },
        { key: 'h', label: 'Height', kind: 'number', unit: 'mm', min: 0 },
        { key: 'autoBevel', label: 'Automatic edge bevel', kind: 'check' },
        { key: 'bevel', label: 'Edge bevel', kind: 'number', unit: 'mm', min: 0, step: 0.5, show: (v) => !v.autoBevel },
    ], CYLINDER_DEFAULTS,
    (s) => (s.kind === 'cylinder' ? cylinderValues(s) : null),
    (v) => {
        const shape = cylinderShape(v);
        return { shape, halfHeight: shape.height / 2 };
    }),
    createTool('sphere', 'Sphere', [
        { key: 'r', label: 'Radius', kind: 'number', unit: 'mm', min: 0 },
    ], { r: '15' },
    (s) => (s.kind === 'sphere' ? { r: fmt(s.radius) } : null),
    (v) => {
        const r = num(v, 'r', 'Radius', { positive: true });
        return { shape: { kind: 'sphere', radius: r }, halfHeight: r };
    }),
    createTool('cone', 'Cone', [
        { key: 'r', label: 'Base radius', kind: 'number', unit: 'mm', min: 0 },
        { key: 'h', label: 'Height', kind: 'number', unit: 'mm', min: 0 },
    ], { r: '15', h: '30' },
    (s) => (s.kind === 'cone' ? { r: fmt(s.radius), h: fmt(s.height) } : null),
    (v) => {
        const h = num(v, 'h', 'Height', { positive: true });
        return { shape: { kind: 'cone', radius: num(v, 'r', 'Radius', { positive: true }), height: h }, halfHeight: h / 2 };
    }),
    createTool('torus', 'Torus', [
        { key: 'r', label: 'Ring radius', kind: 'number', unit: 'mm', min: 0 },
        { key: 't', label: 'Tube radius', kind: 'number', unit: 'mm', min: 0 },
    ], { r: '20', t: '5' },
    (s) => (s.kind === 'torus' ? { r: fmt(s.radius), t: fmt(s.tube) } : null),
    (v) => {
        const t = num(v, 't', 'Tube radius', { positive: true });
        return { shape: { kind: 'torus', radius: num(v, 'r', 'Ring radius', { positive: true }), tube: t }, halfHeight: t };
    }),
    createTool('tube', 'Tube', [
        { key: 'ro', label: 'Outer radius', kind: 'number', unit: 'mm', min: 0 },
        { key: 'ri', label: 'Inner radius', kind: 'number', unit: 'mm', min: 0 },
        { key: 'h', label: 'Height', kind: 'number', unit: 'mm', min: 0 },
    ], { ro: '15', ri: '12', h: '30' },
    (s) => (s.kind === 'tube' ? { ro: fmt(s.outerRadius), ri: fmt(s.innerRadius), h: fmt(s.height) } : null),
    (v) => {
        const ro = num(v, 'ro', 'Outer radius', { positive: true });
        const ri = num(v, 'ri', 'Inner radius', { positive: true });
        if (ri >= ro) {
            throw new Error('The inner radius must be smaller than the outer radius.');
        }
        const h = num(v, 'h', 'Height', { positive: true });
        return { shape: { kind: 'tube', outerRadius: ro, innerRadius: ri, height: h }, halfHeight: h / 2 };
    }),
];

// ---- Sketcher -----------------------------------------------------------------------------------------

/** Starts a sketch on the part being edited, or for a new part when there is none. */
function beginSketch(ctx: Ctx, intent: SketchIntent): void {
    const { workspace } = useStudio.getState();
    startSketch(workspace === 'part' ? ctx.part?.id ?? null : null, intent);
}

const DRAW_TOOLS: { id: SketchTool; label: string; key?: string; icon?: string; hint: string }[] = [
    { id: 'line', label: 'Line', key: 'L', hint: 'click points; click the start to close' },
    { id: 'midpointLine', label: 'Midpoint line', icon: 'midpoint-line', hint: 'the middle, then an end; it grows both ways' },
    { id: 'rect', label: 'Rectangle', key: 'R', icon: 'rectangle', hint: 'two corners; type w,h' },
    { id: 'centerRect', label: 'Centre rectangle', icon: 'center-rect', hint: 'centre, then a corner; type w,h' },
    { id: 'rect3', label: '3 point rectangle', icon: 'rect-3pt', hint: 'two corners for one side at any angle, then the width' },
    { id: 'centerRect3', label: '3 point centre rectangle', icon: 'center-rect-3pt', hint: 'centre, the middle of a side at any angle, then the width' },
    { id: 'parallelogram', label: 'Parallelogram', icon: 'parallelogram', hint: 'two corners for one side, then the next corner' },
    { id: 'circle', label: 'Circle', key: 'C', hint: 'centre, then a point; type the diameter' },
    { id: 'perimeterCircle', label: 'Perimeter circle', icon: 'perimeter-circle', hint: 'three points on the circle' },
    { id: 'arc', label: 'Arc', key: 'A', hint: 'start, end, then a point on the arc' },
    { id: 'centerArc', label: 'Centre arc', icon: 'center-arc', hint: 'centre, start, then where it ends' },
    { id: 'tangentArc', label: 'Tangent arc', icon: 'tangent-arc', hint: 'from the end of a line or arc, tangent to it' },
    { id: 'slot', label: 'Slot', key: 'S', hint: 'two centres, then the width' },
    { id: 'centerSlot', label: 'Centrepoint straight slot', icon: 'center-slot', hint: 'centre, an end centre, then the width' },
    { id: 'arcSlot3', label: '3 point arc slot', icon: 'arc-slot-3pt', hint: 'start, end, a point on the arc, then the width' },
    { id: 'centerArcSlot', label: 'Centrepoint arc slot', icon: 'center-arc-slot', hint: 'arc centre, start, round to the end, then the width' },
    { id: 'polygon', label: 'Polygon', key: 'P', hint: 'centre, then a corner' },
    { id: 'ellipse', label: 'Ellipse', hint: 'centre, the first axis, then the second' },
    { id: 'partialEllipse', label: 'Partial ellipse', icon: 'partial-ellipse', hint: 'centre, both axes, then round to where it ends' },
    { id: 'spline', label: 'Spline', hint: 'points it runs through; double-click ends it' },
    { id: 'styleSpline', label: 'Style spline (Bezier)', icon: 'style-spline', hint: 'control vertices of a Bezier or B-spline curve; double-click ends it' },
    { id: 'parabola', label: 'Parabola', hint: 'focus, vertex, then where it starts and ends' },
    { id: 'conic', label: 'Conic', hint: 'both ends, the top vertex, then Rho' },
];

const sketchDrawTools: ToolDef[] = DRAW_TOOLS.map(({ id, label, key, icon, hint }) => ({
    id: `sk-${id}`,
    label,
    icon: icon ?? id,
    hint,
    shortcut: key,
    instant: () => setTool(id),
    active: (_, s) => s.sketchTool === id,
}));

const sketchPlaneTool: ToolDef = {
    id: 'sk-plane',
    label: 'Sketch plane',
    icon: 'sketch',
    noApply: true,
    panel: true,
    width: 300,
    fields: () => [
        { key: 'offset', label: 'Offset', kind: 'number', unit: 'mm' },
        { key: 'angle', label: 'Tilt angle', kind: 'number', unit: 'deg' },
        { key: 'axis', label: 'Tilt about', kind: 'select', options: opts(['u', 'Its horizontal axis (u)'], ['v', 'Its vertical axis (v)']),
            show: (v) => Number(v.angle) !== 0 },
    ],
    defaults: () => ({ offset: '0', angle: '0', axis: 'u' }),
    top: (api, ctx) => (
        <>
            <p className="tb-note">
                Click any face of {ctx.part && useSketcher.getState().partId ? <b>{ctx.part.name}</b> : 'a part'} in the view (curved faces
                give the tangent plane), or pick a plane. With a tilt angle the plane is turned about its own axis: a construction plane.
            </p>
            <div className="tb-views">
                {(['top', 'front', 'right'] as const).map((plane) => (
                    <button
                        key={plane}
                        type="button"
                        onClick={() => choosePlane(
                            angledPlane(plane, api.values.axis as 'u' | 'v', evaluate(String(api.values.angle)) ?? 0),
                            evaluate(String(api.values.offset)) ?? 0,
                        )}
                    >
                        {plane[0].toUpperCase() + plane.slice(1)}
                    </button>
                ))}
                {/* The part's reference planes (not tilted: a tilted plane is made with the Plane tool). */}
                {useSketcher.getState().context.filter((f) => f.op === 'plane' && !f.suppressed).map((f) => (
                    <button
                        key={f.id}
                        type="button"
                        title="A reference plane of the part (click it in the view too)"
                        onClick={() => choosePlane({ planeRef: f.id }, evaluate(String(api.values.offset)) ?? 0)}
                    >
                        {f.name ?? f.id}
                    </button>
                ))}
            </div>
        </>
    ),
};

const sketchOptionsTool: ToolDef = {
    id: 'sk-options',
    label: 'Sketch settings',
    icon: 'grid',
    hint: 'grid, snapping, automatic relations and solve, dragging',
    fields: () => [
        { key: 'snap', label: 'Snap to grid and points', kind: 'check' },
        { key: 'snapModel', label: 'Snap to model geometry', kind: 'check' },
        ...SKETCH_SETTING_FIELDS,
        ...SPLINE_OPTION_FIELDS,
    ],
    defaults: () => {
        const s = useSketcher.getState();
        return { snap: s.snap, snapModel: useSketchModel.getState().snapModel, ...sketchSettingValues(s.settings), ...splineOptionValues() };
    },
    apply: (v) => attempt(async () => {
        const settings = sketchSettingsOf(v);
        applySplineOptions(v);
        useSketcher.setState({
            grid: gridSnapStep(settings),
            snap: !!v.snap,
        });
        setSnapModel(!!v.snapModel);
        setSketchSettings(settings);
        return { text: '', isError: false };
    }),
    extra: () => <SolveButton />,
};

/**
 * Whether a cut from the current sketch should go against the plane normal: sketches on faces (custom planes use the
 * outward face normal) and named planes above the part origin.
 */
function cutsInward(): boolean {
    const { plane, offset } = useSketcher.getState();
    return typeof plane !== 'string' || offset > 0;
}

/** The finish popup's operation choice: Sketch only, Extrude, Cut or Revolve. */
type FinishChoice = 'sketch' | 'extrude' | 'cut' | 'revolve';

// ---- Extrude options (From, Direction 1, Direction 2), shared by Extrude / Cut and the sketch finish panel -----

type ExtrudeOptionValues = Pick<FinishOp, 'end' | 'from' | 'draft' | 'draftOutward' | 'flipSide' | 'second'> & { through?: boolean };

const isBlind = (end: unknown): boolean => !end || end === 'blind';

/** Form values for an extrude's options, from a stored step or a FinishOp (absent options: the defaults). */
function extrudeValues(o: ExtrudeOptionValues): Values {
    const end = o.end ?? (o.through ? 'throughAll' : 'blind');
    const s = o.second;
    return {
        end, through: end === 'throughAll', from: o.from ? 'offset' : 'plane', fromOffset: fmt(o.from || 5),
        draft: !!o.draft, draftAngle: fmt(o.draft || 1), draftOutward: !!o.draftOutward, flipSide: !!o.flipSide,
        second: !!s, end2: s?.end ?? 'blind', distance2: fmt(s?.distance ?? 10), draft2: !!s?.draft, draftAngle2: fmt(s?.draft || 1),
        draftOutward2: !!s?.draftOutward,
    };
}

/**
 * The extrude option fields, SolidWorks style: From, Direction 1 (direction, end condition, depth, flip side, draft)
 * and Direction 2. `full` false: only direction and depth (a base body's extrude has no other options).
 */
function extrudeFields(isExtrude: (v: Values) => boolean, isCut: (v: Values) => boolean, full = true): Field[] {
    const direction: Field = {
        key: 'direction', label: 'Direction', kind: 'select', section: 'Direction 1', show: isExtrude,
        options: opts(['normal', 'Along normal'], ['reverse', 'Reversed'], ['symmetric', 'Mid plane (symmetric)']),
    };
    const depth = (key: string, section: string, show: (v: Values) => boolean): Field =>
        ({ key, label: 'Depth', kind: 'number', unit: 'mm', min: 0, section, show });
    if (!full) {
        return [direction, depth('distance', 'Direction 1', isExtrude)];
    }
    const ends = opts(['blind', 'Blind'], ['throughAll', 'Through all'], ['upToNext', 'Up to next']);
    const second = (v: Values) => isExtrude(v) && v.direction !== 'symmetric' && !!v.second;
    const draftFields = (suffix: string, section: string, show: (v: Values) => boolean): Field[] => [
        { key: `draft${suffix}`, label: 'Draft', kind: 'check', section, show },
        { key: `draftAngle${suffix}`, label: 'Draft angle', kind: 'number', unit: 'deg', min: 0, max: 89, section,
            show: (v) => show(v) && !!v[`draft${suffix}`] },
        { key: `draftOutward${suffix}`, label: 'Draft outward', kind: 'check', section, show: (v) => show(v) && !!v[`draft${suffix}`] },
    ];
    return [
        { key: 'from', label: 'Start', kind: 'select', options: opts(['plane', 'Sketch plane'], ['offset', 'Offset']), section: 'From', show: isExtrude },
        { key: 'fromOffset', label: 'Offset', kind: 'number', unit: 'mm', section: 'From', show: (v) => isExtrude(v) && v.from === 'offset' },
        direction,
        { key: 'end', label: 'End condition', kind: 'select', options: ends, section: 'Direction 1', show: isExtrude },
        depth('distance', 'Direction 1', (v) => isExtrude(v) && isBlind(v.end)),
        { key: 'flipSide', label: 'Flip side to cut', kind: 'check', section: 'Direction 1', show: (v) => isExtrude(v) && isCut(v) },
        ...draftFields('', 'Direction 1', isExtrude),
        { key: 'second', label: 'Second direction', kind: 'check', section: 'Direction 2', show: (v) => isExtrude(v) && v.direction !== 'symmetric' },
        { key: 'end2', label: 'End condition', kind: 'select', options: ends, section: 'Direction 2', show: second },
        depth('distance2', 'Direction 2', (v) => second(v) && isBlind(v.end2)),
        ...draftFields('2', 'Direction 2', second),
    ];
}

/** The extrude options in the form. `strict` checks the numbers (OK); the live preview reads them leniently. */
function extrudeOptions(v: Values, cut: boolean, strict = false): ExtrudeOptionValues & { through: boolean } {
    const read = (key: string, label: string, check: { min?: number; positive?: boolean } = {}): number =>
        (strict ? num(v, key, label, check) : Number(v[key]) || 0);
    const angle = (key: string, label: string): number => {
        const a = read(key, label, { min: 0 });
        if (strict && a >= 89) {
            throw new Error(`${label} must be less than 89°.`);
        }
        return a;
    };
    const end = ((v.end as string) || 'blind') as NonNullable<FinishOp['end']>;
    const end2 = ((v.end2 as string) || 'blind') as NonNullable<FinishOp['end']>;
    const draft = v.draft ? angle('draftAngle', 'Draft angle') : 0;
    const draft2 = v.second && v.draft2 ? angle('draftAngle2', 'Direction 2 draft angle') : 0;
    return {
        end, through: end === 'throughAll',
        from: v.from === 'offset' ? read('fromOffset', 'Offset') : 0,
        draft, draftOutward: !!draft && !!v.draftOutward,
        flipSide: cut && !!v.flipSide,
        second: v.second && v.direction !== 'symmetric' ? {
            end: end2,
            ...(isBlind(end2) ? { distance: read('distance2', 'Direction 2 depth', { positive: true }) } : {}),
            ...(draft2 ? { draft: draft2, ...(v.draftOutward2 ? { draftOutward: true } : {}) } : {}),
        } : null,
    };
}

/** The non-default extrude options as step fields (a step without them stays as it was before they existed). */
function extrudeExtras(op: ExtrudeOptionValues, cut: boolean): Record<string, unknown> {
    return {
        ...(op.end === 'upToNext' ? { end: 'upToNext' } : {}),
        ...(op.from ? { from: op.from } : {}),
        ...(op.draft ? { draft: op.draft, ...(op.draftOutward ? { draftOutward: true } : {}) } : {}),
        ...(cut && op.flipSide ? { flipSide: true } : {}),
        ...(op.second ? { second: op.second } : {}),
    };
}

/** On an edit, options the stored step has but the form turned off, reset explicitly (an update only changes what it gives). */
function extrudeResets(stored: Feature | null | undefined, fields: Record<string, unknown>, through: boolean): Record<string, unknown> {
    if (stored?.op !== 'extrude') {
        return {};
    }
    const resets: Record<string, unknown> = {
        end: through ? 'throughAll' : 'blind', from: 0, draft: 0, draftOutward: false, flipSide: false, second: null,
    };
    return Object.fromEntries(Object.entries(resets).filter(([k]) => (stored as unknown as Record<string, unknown>)[k] !== undefined && !(k in fields)));
}

// ---- Revolve options (axis of revolution, Direction 1, Direction 2), shared by Revolve and the sketch finish panel ----

/**
 * The revolve fields, SolidWorks style: Axis of revolution, Direction 1 (type, reverse, angle) and Direction 2.
 * `axisFields` are the axis select(s); `full` false: axis and angle only (a base body's revolve).
 */
function revolveFields(isRevolve: (v: Values) => boolean, axisFields: Field[], full = true): Field[] {
    const blind = (v: Values) => isRevolve(v) && v.revolveType !== 'midPlane';
    return [
        ...axisFields,
        ...(full ? [
            { key: 'revolveType', label: 'Revolve type', kind: 'select' as const, options: opts(['blind', 'Blind'], ['midPlane', 'Mid plane']),
                section: 'Direction 1', show: isRevolve },
            { key: 'reverse', label: 'Reverse direction', kind: 'check' as const, section: 'Direction 1', show: blind },
        ] : []),
        { key: 'angle', label: 'Angle', kind: 'number', unit: 'deg', min: 0, max: 360, section: 'Direction 1', show: isRevolve },
        ...(full ? [
            { key: 'revSecond', label: 'Direction 2', kind: 'check' as const, section: 'Direction 2', show: blind },
            { key: 'angle2', label: 'Angle', kind: 'number' as const, unit: 'deg', min: 0, max: 360, section: 'Direction 2',
                show: (v: Values) => blind(v) && !!v.revSecond },
        ] : []),
    ];
}

/** The revolve options in the form. `strict` checks the numbers (OK); the live preview reads them leniently. */
function revolveOptions(v: Values, axis: unknown, strict = false): RevolveOptionValues {
    const read = (key: string, label: string): number => (strict ? num(v, key, label, { positive: true }) : Number(v[key]) || 0);
    return readRevolve(v, axis, read, strict);
}

function finishOp(v: Values): FinishOp {
    const choice = v.op as FinishChoice;
    const mode = choice === 'sketch' ? 'sketch' : choice === 'cut' ? 'cut' : v.result === 'new' ? 'new' : (v.result as 'add' | 'cut') ?? 'add';
    return {
        op: choice === 'revolve' ? 'revolve' : 'extrude',
        mode,
        distance: Number(v.distance) || 0,
        direction: v.direction as FinishOp['direction'],
        ...revolveOptions(v, v.axis),
        ...extrudeOptions(v, mode === 'cut'),
    };
}

export function sketchEditTarget(): { feature: Feature | null; base: SketchShape | null; partId: string } | null {
    const edit = useSketcher.getState().edit;
    const part = edit && fullPart(edit.partId);
    if (!edit || !part) {
        return null;
    }
    const feature = edit.featureId ? part.features?.find((f) => f.id === edit.featureId) ?? null : null;
    return { feature, base: !edit.featureId && part.shape.kind === 'sketch' ? part.shape : null, partId: part.id };
}

/** The part's sketch steps, oldest first. */
export function sketchSteps(part: Part | null | undefined): Extract<Feature, { op: 'sketch' }>[] {
    return (part?.features ?? []).filter((f): f is Extract<Feature, { op: 'sketch' }> => f.op === 'sketch');
}

/** A fresh id and name for the next sketch step of a part: sketch-3, "Sketch3". */
function nextSketch(part: Part | null | undefined): { id: string; name: string } {
    const ids = new Set((part?.features ?? []).map((f) => f.id));
    let n = sketchSteps(part).length + 1;
    while (ids.has(`sketch-${n}`)) {
        n += 1;
    }
    return { id: `sketch-${n}`, name: nextFeatureName(part?.features, { op: 'sketch' }) };
}

/** An extrude or revolve step that builds from a sketch (inline or by reference); `stored` is the step being edited. */
function sketchOpFeature(op: FinishOp, source: { sketchRef: string } | { sketch: unknown }, label: string, distance: number, angle: number,
    stored?: Feature | null): Record<string, unknown> {
    if (op.op === 'extrude') {
        const verb = op.mode === 'cut' ? 'Cut' : 'Extrude';
        const upToNext = op.end === 'upToNext';
        const size = upToNext ? 'up to next' : op.through ? 'through all' : `${fmt(distance)} mm`;
        return {
            op: 'extrude', name: `${verb} ${size} · ${label}`, ...source, mode: op.mode === 'cut' ? 'cut' : 'add',
            direction: op.direction, ...(op.through ? { through: true } : upToNext ? {} : { distance }),
            ...extrudeExtras(op, op.mode === 'cut'),
        };
    }
    return {
        op: 'revolve', name: `${op.mode === 'cut' ? 'Revolve cut' : 'Revolve'} ${fmt(angle)}° · ${label}`, ...source,
        mode: op.mode === 'cut' ? 'cut' : 'add', ...revolveStepFields({ ...op, angle }, stored),
    };
}

/**
 * Finishes the sketch. A new sketch becomes a named sketch step of the part (a brand-new part starts empty with it),
 * optionally followed by an Extrude, Cut or Revolve that uses it. Editing saves the sketch back in place.
 */
/**
 * Does leaving the sketch need the operation panel? Only when the sketch was started from Extrude, Cut or Revolve
 * (the feature is what was asked for), or it is the own sketch of a feature or base body being edited. A plain
 * sketch, new or edited, is saved as it is: the features that use it are made afterwards, from the part.
 */
export function finishNeedsPanel(): boolean {
    const target = sketchEditTarget();
    if (target) {
        return target.feature?.op !== 'sketch';
    }
    return useSketcher.getState().intent !== 'sketch';
}

/**
 * Leaves the sketch without saving it; when a new sketch has something drawn or an edited one was changed, the
 * sketch bar asks first (sketchBar.ts), and `then` runs once the sketch is left.
 */
export function discardSketch(then?: () => void): void {
    askDiscard(then ?? null);
}

/** Saves the sketch and goes back to the part, without a panel. */
async function exitSketchSaving(ctx: Ctx): Promise<void> {
    const result = await finishTool.apply!({ op: 'sketch', result: 'add', distance: '10', direction: 'normal', through: false, axis: 'v', angle: '360' }, ctx);
    if (result.isError) {
        showError(result.text);
    }
}

const finishTool: ToolDef = {
    id: 'sk-finish',
    label: 'Exit sketch',
    icon: 'finish',
    hint: 'save the sketch and go back to the part',
    instant: (ctx) => void exitSketchSaving(ctx),
    popupIf: () => finishNeedsPanel(),
    width: 300,
    panel: true,
    regionPick: 'sketcher',
    // The real result (end conditions, offsets, draft, both directions, regions) from the server, as Extrude shows it.
    previewCalls: (v, ctx) => finishPreviewCalls(v, ctx),
    fields: () => {
        const target = sketchEditTarget();
        if (target?.feature?.op === 'sketch') {
            return [];
        }
        const hasPart = !!useSketcher.getState().partId;
        const choices: [string, string][] = target?.feature
            ? target.feature.op === 'extrude' ? [['extrude', 'Extrude'], ['cut', 'Cut']] : [['revolve', 'Revolve']]
            : target?.base
                ? target.base.revolve ? [['revolve', 'Revolve']] : [['extrude', 'Extrude']]
                : [['sketch', 'Sketch only'], ['extrude', 'Extrude'], ...(hasPart ? [['cut', 'Cut'] as [string, string]] : []), ['revolve', 'Revolve']];
        const results = target
            ? (target.feature?.op === 'revolve' ? opts(['add', 'Join'], ['cut', 'Cut']) : [])
            : hasPart ? opts(['add', 'Join'], ['new', 'New body']) : [];
        return [
            ...(choices.length > 1 ? [{ key: 'op', label: 'Operation', kind: 'select' as const, options: opts(...choices) }] : []),
            // A base body's extrude has only a distance and a direction.
            ...extrudeFields((v) => v.op === 'extrude' || v.op === 'cut', (v) => v.op === 'cut', !target?.base),
            // A base body has no history, so no axis steps.
            ...revolveFields((v) => v.op === 'revolve', [{
                key: 'axis', label: 'Axis', kind: 'select', section: 'Axis of revolution', show: (v) => v.op === 'revolve',
                options: axisOptions(useSketcher.getState().geometry, target?.base ? [] : useSketcher.getState().context,
                    target?.feature?.op === 'revolve' ? axisValue(target.feature.axis) : undefined),
            }], !target?.base),
            ...(results.length ? [{ key: 'result', label: 'Result', kind: 'select' as const, options: results, section: 'Result',
                show: (v: Values) => v.op === 'extrude' || v.op === 'revolve' }] : []),
        ];
    },
    defaults: () => {
        const target = sketchEditTarget();
        const op = finishDefaults(target?.feature ?? null, target?.base ?? null);
        queueMicrotask(() => useSketcher.setState({ finishing: op }));
        const choice: FinishChoice = op.mode === 'sketch' ? 'sketch' : op.op === 'revolve' ? 'revolve' : op.mode === 'cut' ? 'cut' : 'extrude';
        const direction = !target && choice === 'cut' && cutsInward() ? 'reverse' : op.direction;
        if (direction !== op.direction) {
            queueMicrotask(() => useSketcher.setState({ finishing: { ...op, direction } }));
        }
        // Lines are picked as the axis by selecting them in the sketch.
        queueMicrotask(() => setTool('select'));
        return {
            op: choice, result: op.mode === 'new' ? 'new' : op.mode === 'cut' && op.op === 'revolve' ? 'cut' : 'add',
            distance: fmt(op.distance), direction, axis: axisValue(op.axis), ...revolveValues(op), ...extrudeValues(op),
        };
    },
    onChange: (key, v) => {
        // A cut from a sketch above the part origin goes down into it, and vice versa.
        const patch: Values = key === 'op' && v.op === 'cut' ? { direction: cutsInward() ? 'reverse' : 'normal' } : {};
        if (key === 'end') {
            patch.through = v.end === 'throughAll';
        }
        useSketcher.setState({ finishing: finishOp({ ...v, ...patch }) });
        return patch;
    },
    // The picked areas are listed by the property manager (Selected contours).
    extra: (api) => {
        const f = sketchEditTarget()?.feature;
        if (f?.op === 'sketch' || api.values.op === 'sketch') {
            return null;
        }
        return (
            <>
                <RegionPickSession sketchKey={null} initial={f && (f.op === 'extrude' || f.op === 'revolve') ? f.regions : undefined} />
                {api.values.op === 'revolve' && <SketchAxisListener api={api} />}
                <p className="tb-note tb-hint">
                    Click areas in the view to use only those.{api.values.op === 'revolve' ? ' Click a line or centreline to revolve about it.' : ''}
                </p>
            </>
        );
    },
    applyLabel: 'OK',
    apply: (v, ctx) => attempt(async () => {
        // With Automatic solve off, leaving the sketch solves it first (as a rebuild does).
        if (!solvesAtOnce(useSketcher.getState().settings, useSketcher.getState().geometry.curves.length) && !solveSketch()) {
            throw new Error(useSketcher.getState().message ?? 'The sketch does not solve.');
        }
        const { profiles, open } = sketchProfiles();
        // A sketch saved on its own may be open (a path, a guide, reference lines); a feature needs a closed area.
        const plain = v.op === 'sketch' || sketchEditTarget()?.feature?.op === 'sketch';
        if (plain && !useSketcher.getState().geometry.curves.length) {
            throw new Error('The sketch is empty: draw something, or use Discard to leave.');
        }
        if (!plain && !profiles.length) {
            throw new Error(open ? 'The lines do not form a closed profile yet: join the last point to the first.'
                : 'Draw at least one closed profile.');
        }
        const sketch = currentSketch();
        const target = sketchEditTarget();
        const lenient = finishOp(v);
        // A base body's extrude has no options beyond distance and direction.
        const op: FinishOp = lenient.op === 'extrude' && lenient.mode !== 'sketch' && !target?.base
            ? { ...lenient, ...extrudeOptions(v, lenient.mode === 'cut', true) }
            : { ...lenient, end: 'blind', through: false, from: 0, draft: 0, draftOutward: false, flipSide: false, second: null };
        const regions = op.mode === 'sketch' ? [] : useRegionPick.getState().picked;
        const s = useSketcher.getState();
        const distance = op.op === 'extrude' && op.mode !== 'sketch' && isBlind(op.end) ? num(v, 'distance', 'Depth', { positive: true }) : 0;
        if (op.op === 'revolve' && op.mode !== 'sketch') {
            Object.assign(op, revolveOptions(v, v.axis, true));
            if (target?.base && typeof op.axis === 'object' && !('line' in op.axis)) {
                throw new Error('A base body can only revolve about the sketch axes or a line of the sketch.');
            }
        }
        const angle = op.op === 'revolve' && op.mode !== 'sketch' ? op.angle : 360;
        const done = (result: Result) => {
            if (!result.isError) {
                closeSketch();
                clearEditing();
            }
            return result;
        };

        // Editing: write the sketch (and the step's values) back in place, keeping ids and names.
        if (target?.feature?.op === 'sketch') {
            return done(await runTool('features_update', { partId: target.partId, updates: [{ id: target.feature.id, sketch }] }));
        }
        if (target?.feature) {
            const ref = 'sketchRef' in target.feature ? target.feature.sketchRef : undefined;
            const mode = op.mode === 'cut' ? 'cut' : 'add';
            let fields: Record<string, unknown> = { mode, ...revolveStepFields(op, target.feature), regions };
            if (op.op === 'extrude') {
                const extras = extrudeExtras(op, mode === 'cut');
                fields = { mode, direction: op.direction, through: op.through, ...(isBlind(op.end) ? { distance } : {}), regions, ...extras };
                Object.assign(fields, extrudeResets(target.feature, fields, op.through));
            }
            const updates = ref ? [{ id: ref, sketch }, { id: target.feature.id, ...fields }] : [{ id: target.feature.id, sketch, ...fields }];
            return done(await runTool('features_update', { partId: target.partId, updates }));
        }
        if (target?.base) {
            const shape = op.op === 'extrude'
                ? { kind: 'sketch', sketch, extrude: { distance, direction: op.direction } }
                : { kind: 'sketch', sketch, revolve: { axis: op.axis, ...(angle !== 360 ? { angle } : {}) } };
            return done(await runTool('parts_update', { updates: [{ id: target.partId, shape }] }));
        }

        // A new sketch: a sketch step, plus the operation that uses it.
        const owner = s.partId ? fullPart(s.partId) : null;
        const intoNewPart = !owner || op.mode === 'new';
        const step = nextSketch(intoNewPart ? null : owner);
        const steps: Record<string, unknown>[] = [{ id: step.id, op: 'sketch', name: step.name, sketch }];
        if (op.mode !== 'sketch') {
            const feature = sketchOpFeature(op.mode === 'new' ? { ...op, mode: 'add' } : op, { sketchRef: step.id }, step.name, distance, angle);
            steps.push({
                ...feature,
                name: nextFeatureName(intoNewPart ? [] : owner?.features, feature as unknown as Nameable),
                ...(regions.length ? { regions } : {}),
            });
        }
        if (intoNewPart) {
            const count = useStudio.getState().history?.parts.length ?? 0;
            const added = await addPart({
                name: owner ? `${owner.name} body` : `Part ${count + 1}`,
                shape: { kind: 'empty' },
                position: owner?.position ?? [0, 0, 0],
                rotation: owner?.rotation ?? [0, 0, 0],
                material: owner?.material ?? PLA_GREY,
                features: steps,
            });
            if (!added.isError && added.id) {
                closeSketch();
                clearEditing();
                setWorkspace('part', added.id);
            }
            return added;
        }
        return done(await runTool('features_add', { partId: owner!.id, features: steps }));
    }),
};

/**
 * The calls the finish panel's OK would make, for the live preview: none for a plain sketch (it builds nothing).
 * Capturing is safe here: a captured call answers as an error, so apply neither closes the sketch nor selects.
 */
export function finishPreviewCalls(v: Values, ctx: Ctx): ToolCall[] {
    if (v.op === 'sketch' || sketchEditTarget()?.feature?.op === 'sketch') {
        return [];
    }
    const captured = captureToolCalls(() => finishTool.apply!(v, ctx));
    void captured.result.catch(() => undefined);
    return captured.calls;
}

/** Keeps a popup's `sketch` field in step with sketch curves clicked in the viewport. */
function SketchPickListener({ api, keyName }: { api: PopupApi; keyName: string }) {
    const picked = useSketcher((s) => s.picked);
    const [seen] = useState(() => picked?.n ?? 0);
    useEffect(() => {
        if (picked && picked.n > seen) {
            api.set(keyName === 'sections'
                ? { sections: [...((api.values.sections as string[]) ?? []).filter((id) => id !== picked.id), picked.id] }
                : { [keyName]: picked.id });
        }
    }, [picked?.n]);
    return null;
}

/** Finish panel, Revolve: a line or centreline selected in the open sketch becomes the axis of revolution. */
function SketchAxisListener({ api }: { api: PopupApi }) {
    const selection = useSketcher((s) => s.selection);
    useEffect(() => {
        const only = selection.length === 1 && selection[0].type === 'curve' ? selection[0].id : null;
        const curve = only && useSketcher.getState().geometry.curves.find((c) => c.id === only);
        if (curve && curve.kind === 'line' && api.values.axis !== `line:${curve.id}`) {
            api.set({ axis: `line:${curve.id}` });
        }
    }, [selection]);
    return null;
}

/** Extrude, Cut or Revolve an existing sketch step of the part (or start a new sketch when it has none). */
function sketchOpTool(kind: FinishChoice & ('extrude' | 'cut' | 'revolve')): ToolDef {
    const label = kind === 'extrude' ? 'Extrude' : kind === 'cut' ? 'Cut' : 'Revolve';
    const op = kind === 'revolve' ? 'revolve' : 'extrude';
    return {
        id: kind,
        label,
        icon: kind === 'cut' ? 'pocket' : kind,
        op,
        hint: kind === 'cut' ? 'cut a sketch into the part' : `${label.toLowerCase()} a sketch`,
        width: 300,
        regionPick: 'step',
        preview: true,
        // With no sketch to use yet, the button starts one.
        instant: (ctx) => beginSketch(ctx, kind),
        popupIf: (ctx) => !!ctx.edit || sketchSteps(ctx.part).length > 0,
        fields: (ctx) => {
            const steps = sketchSteps(ctx.part);
            const features = ctx.part?.features ?? [];
            const stored = ctx.edit?.feature?.op === 'revolve' ? ctx.edit.feature : null;
            // One axis field per sketch step, shown for the chosen sketch: its lines, and the axis steps before the revolve.
            const axisFields: Field[] = op === 'revolve' ? steps.map((s) => {
                const end = stored ? features.indexOf(stored) : features.length;
                return {
                    key: revolveAxisKey(s.id), label: 'Axis', kind: 'select', section: 'Axis of revolution', show: (v: Values) => v.sketch === s.id,
                    options: axisOptions(s.sketch.geometry, features.slice(0, end < 0 ? features.length : end),
                        stored?.sketchRef === s.id ? axisValue(stored.axis) : undefined),
                };
            }) : [];
            return [
                { key: 'sketch', label: 'Sketch', kind: 'select', options: steps.map((f) => ({ value: f.id, label: f.name ?? f.id })) },
                ...extrudeFields(() => op === 'extrude', (v) => v.mode === 'cut'),
                ...(op === 'revolve' ? revolveFields(() => true, axisFields) : []),
                ...(kind === 'revolve' || ctx.edit
                    ? [{ key: 'mode', label: 'Result', kind: 'select' as const, options: opts(['add', 'Join'], ['cut', 'Cut']), section: 'Result' }] : []),
            ];
        },
        defaults: (ctx) => {
            const steps = sketchSteps(ctx.part);
            const f = ctx.edit?.feature;
            const last = steps[steps.length - 1];
            const values: Values = {
                sketch: last?.id ?? '', mode: kind === 'cut' ? 'cut' : 'add', distance: '10',
                direction: kind === 'cut' && last && (typeof last.sketch.plane !== 'string' || (last.sketch.offset ?? 0) > 0) ? 'reverse' : 'normal',
                ...revolveValues({}), ...extrudeValues({ through: kind === 'cut' }),
                // Each sketch's own default axis: its centreline when it has exactly one.
                ...Object.fromEntries(steps.map((s) => [revolveAxisKey(s.id), defaultAxis(s.sketch.geometry)])),
            };
            if (f && (f.op === 'extrude' || f.op === 'revolve')) {
                Object.assign(values, { sketch: f.sketchRef ?? values.sketch, mode: f.mode });
                if (f.op === 'extrude') {
                    Object.assign(values, { distance: fmt(f.distance ?? 10), direction: f.direction ?? 'normal', ...extrudeValues(f) });
                } else {
                    Object.assign(values, { [revolveAxisKey(f.sketchRef)]: axisValue(f.axis), ...revolveValues(f) });
                }
            }
            return values;
        },
        // `through` follows the end condition (other code still reads it).
        onChange: (key, v) => (key === 'end' ? { through: v.end === 'throughAll' } : undefined),
        extra: (api, ctx) => (
            <>
                <SketchPickListener api={api} keyName="sketch" />
                <RegionPickSession
                    sketchKey={ctx.part && api.values.sketch ? `${ctx.part.id}/${api.values.sketch as string}` : null}
                    initial={ctx.edit?.feature && (ctx.edit.feature.op === 'extrude' || ctx.edit.feature.op === 'revolve')
                        && ctx.edit.feature.sketchRef === api.values.sketch ? ctx.edit.feature.regions : undefined}
                />
                <p className="tb-note tb-hint">
                    Or click a sketch in the view. Click areas of it to use only those.
                    {op === 'revolve' ? ' Click a line, centreline or axis to revolve about it.' : ''}
                </p>
                {ctx.part && api.values.sketch && (
                    <button type="button" className="tb-link" onClick={() => editItem(ctx.part!.id, api.values.sketch as string)}>
                        Edit sketch
                    </button>
                )}
            </>
        ),
        apply: (v, ctx) => attempt(async () => {
            const sketchRef = v.sketch as string;
            if (!sketchRef) {
                throw new Error('Pick a sketch first.');
            }
            const mode = (v.mode as 'add' | 'cut') ?? 'add';
            const finish: FinishOp = {
                op, mode, distance: Number(v.distance) || 0, direction: v.direction as FinishOp['direction'],
                ...revolveOptions(v, v[revolveAxisKey(sketchRef)], op === 'revolve'),
                ...(op === 'extrude' ? extrudeOptions(v, mode === 'cut', true) : { through: false }),
            };
            const distance = op === 'extrude' && isBlind(finish.end) ? num(v, 'distance', 'Depth', { positive: true }) : 0;
            const name = sketchSteps(ctx.part).find((f) => f.id === sketchRef)?.name?.split(' · ')[0] ?? sketchRef;
            const feature = sketchOpFeature(finish, { sketchRef }, name, distance, finish.angle, ctx.edit?.feature);
            if (ctx.edit?.feature && op === 'extrude') {
                // Switching between a distance and through-all: send both explicitly; options turned off are reset.
                feature.through = finish.through;
                Object.assign(feature, extrudeResets(ctx.edit.feature, feature, finish.through));
            }
            // On an edit the picks are always sent: an empty list means the whole sketch again.
            const regions = useRegionPick.getState().picked;
            if (ctx.edit?.feature || regions.length) {
                feature.regions = regions;
            }
            return saveFeature(ctx, feature);
        }),
    };
}

/** Loft through two or more sketch steps, in the order picked. */
const loftTool: ToolDef = {
    id: 'loft',
    preview: true,
    label: 'Loft',
    icon: 'loft',
    op: 'loft',
    hint: 'a solid through two or more sketches',
    needsPart: true,
    width: 310,
    fields: (ctx) => [
        { key: 'sections', label: 'Sections', kind: 'multi', options: sketchSteps(ctx.part).map((f) => ({ value: f.id, label: f.name ?? f.id })),
            section: 'Profiles' },
        { key: 'ruled', label: 'Ruled (straight sides)', kind: 'check', section: 'Options' },
        { key: 'closed', label: 'Close loft', kind: 'check', section: 'Options', show: (v) => (v.sections as string[]).length >= 3 },
        { key: 'mode', label: 'Result', kind: 'select', options: opts(['add', 'Join'], ['cut', 'Cut']), section: 'Result' },
    ],
    defaults: (ctx) => {
        const f = edited(ctx, 'loft');
        if (f) {
            return { sections: f.sections.map((s) => s.sketchRef ?? '').filter(Boolean), ruled: !!f.ruled, closed: !!f.closed, mode: f.mode };
        }
        return { sections: sketchSteps(ctx.part).slice(-2).map((f) => f.id), ruled: false, closed: false, mode: 'add' };
    },
    top: () => <p className="tb-note">Pick the sketches in order (chips or in the view). Each needs exactly one closed profile.</p>,
    extra: (api, ctx) => (
        <>
            <SketchPickListener api={api} keyName="sections" />
            <SectionOrder api={api} ctx={ctx} />
        </>
    ),
    apply: (v, ctx) => attempt(async () => {
        const sections = v.sections as string[];
        if (sections.length < 2) {
            throw new Error('Pick at least two sketches.');
        }
        const steps = sketchSteps(ctx.part);
        for (const id of sections) {
            const step = steps.find((f) => f.id === id);
            if (step && step.sketch.profiles.length !== 1) {
                throw new Error(`${step.name ?? id} has ${step.sketch.profiles.length} profiles; a loft section needs exactly one.`);
            }
        }
        const names = sections.map((id) => steps.find((f) => f.id === id)?.name?.split(' · ')[0] ?? id);
        return saveFeature(ctx, {
            op: 'loft',
            name: `Loft ${names.join(' → ')}`,
            sections: sections.map((sketchRef) => ({ sketchRef })),
            ruled: !!v.ruled,
            // Sent on an edit too, so turning it off sticks.
            ...(v.closed && sections.length >= 3 ? { closed: true } : ctx.edit ? { closed: false } : {}),
            mode: v.mode,
        });
    }),
};

/** The loft's sections in order, each with Move up and Move down (the order the loft passes through them). */
function SectionOrder({ api, ctx }: { api: PopupApi; ctx: Ctx }) {
    const list = (api.values.sections as string[]) ?? [];
    if (list.length < 2) {
        return null;
    }
    const steps = sketchSteps(ctx.part);
    const move = (i: number, by: number) => {
        const next = [...list];
        [next[i], next[i + by]] = [next[i + by], next[i]];
        api.set({ sections: next });
    };
    return (
        <ol className="pm-contours" aria-label="Section order">
            {list.map((id, i) => (
                <li key={id}>
                    <span>{i + 1}. {steps.find((f) => f.id === id)?.name?.split(' · ')[0] ?? id}</span>
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} title="Move up" aria-label="Move up">↑</button>
                    <button type="button" disabled={i === list.length - 1} onClick={() => move(i, 1)} title="Move down" aria-label="Move down">↓</button>
                </li>
            ))}
        </ol>
    );
}

/** What a sketch step offers a sweep: closed areas (a profile) and open chains (a path). */
function sweepRole(step: Extract<Feature, { op: 'sketch' }> | undefined): 'profile' | 'path' | null {
    if (!step) {
        return null;
    }
    return (step.sketch.open?.length ?? 0) > 0 && !step.sketch.profiles.length ? 'path' : 'profile';
}

/** Fills the sweep's profile or path from a sketch clicked in the view: an open sketch is the path, else the profile. */
function SweepPickListener({ api, ctx }: { api: PopupApi; ctx: Ctx }) {
    const picked = useSketcher((s) => s.picked);
    const [seen] = useState(() => picked?.n ?? 0);
    useEffect(() => {
        if (picked && picked.n > seen) {
            const role = sweepRole(sketchSteps(ctx.part).find((f) => f.id === picked.id));
            api.set(role === 'path' ? { path: picked.id } : { sketch: picked.id, profileType: 'sketch' });
        }
    }, [picked?.n]);
    return null;
}

/**
 * Sweep: a profile (a sketch step, or a circle of a diameter) along a path (the open chain of another sketch step).
 * The profile sketch is the `sketch` value, so its areas can be picked like an extrude's.
 */
const sweepTool: ToolDef = {
    id: 'sweep',
    preview: true,
    label: 'Sweep',
    icon: 'sweep',
    op: 'sweep',
    hint: 'a profile along a path',
    needsPart: true,
    width: 310,
    regionPick: 'step',
    fields: (ctx) => {
        const steps = sketchSteps(ctx.part).map((f) => ({ value: f.id, label: f.name ?? f.id }));
        const none = [{ value: '', label: 'None' }];
        return [
            { key: 'profileType', label: 'Profile', kind: 'select', options: opts(['sketch', 'Sketch profile'], ['circular', 'Circular profile']),
                section: 'Profile and path' },
            { key: 'sketch', label: 'Profile sketch', kind: 'select', options: [...none, ...steps], section: 'Profile and path',
                show: (v) => v.profileType === 'sketch' },
            { key: 'diameter', label: 'Diameter', kind: 'number', unit: 'mm', min: 0, step: 0.5, section: 'Profile and path',
                show: (v) => v.profileType === 'circular' },
            { key: 'path', label: 'Path sketch', kind: 'select', options: [...none, ...steps], section: 'Profile and path' },
            { key: 'orientation', label: 'Orientation', kind: 'select', section: 'Options',
                options: opts(['followPath', 'Follow path'], ['keepNormal', 'Keep normal constant']) },
            { key: 'twist', label: 'Profile twist', kind: 'select', section: 'Options', show: (v) => v.orientation !== 'keepNormal',
                options: opts(['none', 'None'], ['angle', 'Specify twist angle']) },
            { key: 'twistAngle', label: 'Twist angle', kind: 'number', unit: 'deg', section: 'Options',
                show: (v) => v.orientation !== 'keepNormal' && v.twist === 'angle' },
            { key: 'mode', label: 'Result', kind: 'select', options: opts(['add', 'Join (boss)'], ['cut', 'Cut']), section: 'Result' },
        ];
    },
    defaults: (ctx) => {
        const f = edited(ctx, 'sweep');
        if (f) {
            return {
                profileType: f.profile ? 'sketch' : 'circular', sketch: f.profile?.sketchRef ?? '', kept: f.profile?.sketchRef ?? '',
                diameter: fmt(f.diameter ?? 5), path: 'helix' in f.path ? '' : f.path.sketchRef ?? '',
                orientation: f.orientation ?? 'followPath', twist: f.twist ? 'angle' : 'none', twistAngle: fmt(f.twist ?? 90), mode: f.mode,
            };
        }
        const steps = sketchSteps(ctx.part);
        const path = [...steps].reverse().find((f) => sweepRole(f) === 'path');
        const profile = [...steps].reverse().find((f) => sweepRole(f) === 'profile');
        return {
            profileType: 'sketch', sketch: profile?.id ?? '', kept: profile?.id ?? '', diameter: '5', path: path?.id ?? '',
            orientation: 'followPath', twist: 'none', twistAngle: '90', mode: 'add',
        };
    },
    // A circular profile has no sketch (and so no areas to pick); the sketch comes back when switching back.
    onChange: (key, v): Values | void => {
        if (key === 'profileType') {
            return v.profileType === 'circular' ? { kept: v.sketch, sketch: '' } : { sketch: v.kept || v.sketch };
        }
        if (key === 'sketch') {
            return { kept: v.sketch };
        }
    },
    top: () => (
        <p className="tb-note">
            The profile is a closed sketch (or a circle); the path is a sketch of one open chain of lines and arcs, starting
            at the profile. Pick them in the lists or click them in the view.
        </p>
    ),
    extra: (api, ctx) => {
        const f = edited(ctx, 'sweep');
        return (
            <>
                <SweepPickListener api={api} ctx={ctx} />
                <RegionPickSession
                    sketchKey={ctx.part && api.values.sketch ? `${ctx.part.id}/${api.values.sketch as string}` : null}
                    initial={f?.profile?.sketchRef === api.values.sketch ? f?.regions : undefined}
                />
                {api.values.sketch && <p className="tb-note tb-hint">Click one area of the profile to sweep just that one.</p>}
            </>
        );
    },
    apply: (v, ctx) => attempt(async () => {
        const steps = sketchSteps(ctx.part);
        const path = steps.find((f) => f.id === v.path);
        if (!path) {
            throw new Error('Pick the path sketch.');
        }
        const chains = path.sketch.open?.length ?? 0;
        if (chains > 1 || (chains === 0 && path.sketch.profiles.length !== 1) || (chains === 1 && path.sketch.profiles.length)) {
            throw new Error(`${path.name ?? path.id} is not a path: it needs one connected open chain of lines and arcs (or one closed profile)`
                + `${chains === 0 && path.sketch.geometry ? '. A sketch saved before open chains were kept: open it and exit it again' : ''}.`);
        }
        const circular = v.profileType === 'circular';
        const profile = circular ? null : steps.find((f) => f.id === v.sketch);
        if (!circular && !profile) {
            throw new Error('Pick the profile sketch, or use a circular profile.');
        }
        if (profile && profile.id === path.id) {
            throw new Error('The profile and the path must be different sketches.');
        }
        const keepNormal = v.orientation === 'keepNormal';
        const twist = !keepNormal && v.twist === 'angle' ? num(v, 'twistAngle', 'Twist angle') : 0;
        const regions = circular ? [] : useRegionPick.getState().picked;
        const pathName = path.name?.split(' · ')[0] ?? path.id;
        const feature: Record<string, unknown> = {
            op: 'sweep',
            name: `Sweep ${circular ? `⌀${v.diameter} ` : ''}along ${pathName}`,
            ...(circular ? { diameter: num(v, 'diameter', 'Diameter', { positive: true }) } : { profile: { sketchRef: profile!.id } }),
            path: { sketchRef: path.id },
            mode: v.mode,
            ...(keepNormal ? { orientation: 'keepNormal' } : {}),
            ...(twist ? { twist } : {}),
            ...(regions.length ? { regions } : {}),
        };
        if (ctx.edit?.feature) {
            // An update merges fields: what the form turned off is cleared explicitly.
            Object.assign(feature, {
                ...(circular ? { profile: null } : { diameter: null }),
                orientation: keepNormal ? 'keepNormal' : 'followPath', twist, regions,
            });
        }
        return saveFeature(ctx, feature);
    }),
};

const sketchStartTools: ToolDef[] = [
    { id: 'sketch', label: 'Sketch', icon: 'sketch', hint: 'on a plane or a flat face', instant: (ctx) => beginSketch(ctx, 'sketch') },
];

export { CONSTRAINT_TOOLS };

const constrainTools: ToolDef[] = [
    {
        id: 'sk-dimension',
        label: 'Dimension',
        icon: 'dimension',
        hint: 'lengths, offsets, angles, radii',
        shortcut: 'D',
        instant: () => setDimensionTool(null),
        active: (_, s) => s.sketchTool === 'dimension',
    },
    ...CONSTRAINT_TOOLS.map(({ id, label, hint }): ToolDef => ({
        id: `sk-c-${id}`,
        label,
        icon: `c-${id}`,
        hint,
        instant: () => constraintTool(id),
        active: (_, s) => s.sketchTool === `c:${id}`,
    })),
    {
        id: 'sk-construction',
        label: 'Construction',
        icon: 'c-construction',
        hint: 'toggle the selected curves to construction geometry',
        shortcut: 'X',
        instant: () => toggleConstructionSelected(),
    },
    ...moreConstrainTools,
];

const MODIFY_TOOLS: { id: SketchTool; label: string; key?: string; icon: string; hint: string }[] = [
    { id: 'trim', label: 'Trim', key: 'T', icon: 'trim', hint: 'click the piece of a curve to remove' },
    { id: 'extend', label: 'Extend', icon: 'extend', hint: 'click near an end to lengthen it to the next curve' },
    { id: 'fillet', label: 'Fillet', icon: 'sk-fillet', hint: 'round a corner; type the radius' },
    { id: 'chamfer', label: 'Chamfer', icon: 'sk-chamfer', hint: 'cut a corner; type the distance' },
    { id: 'offset', label: 'Offset', key: 'O', icon: 'offset', hint: 'a parallel copy of a curve or chain' },
    { id: 'mirror', label: 'Mirror', key: 'M', icon: 'mirror', hint: 'copy curves across a line or axis' },
];

const vecField = (key: string, label: string, unit: string): Field => ({ key, label, kind: 'vec', unit, axes: ['U', 'V', ''] });

/** Instances to skip, typed as "i,j; i,j" (linear) or "i, i" (circular), counted from 1 for the original. */
function skipList(text: Values[string]): number[][] {
    return String(text ?? '').split(/;|\s{2,}/).map((part) => part.split(/[,\s]+/).filter(Boolean).map(Number))
        .filter((nums) => nums.length && nums.every((n) => Number.isInteger(n) && n >= 1));
}

/** A count of instances is a whole number. */
function whole(n: number, label: string): number {
    if (!Number.isInteger(n)) {
        throw new Error(`${label} must be a whole number.`);
    }
    return n;
}

function nonZero(n: number, label: string): number {
    if (n === 0) {
        throw new Error(`${label} cannot be 0.`);
    }
    return n;
}

function linearOptions(v: Values): LinearPatternOptions {
    const count2 = whole(num(v, 'count2', 'Direction 2 instances', { min: 1 }), 'Direction 2 instances');
    // A direction taken from a line of the sketch follows that line.
    const [ref1, ref2] = [lineDirection(v.dir1), lineDirection(v.dir2)];
    return {
        ...(ref1 !== null ? { directionLine: String(v.dir1) } : {}),
        ...(ref2 !== null && count2 > 1 ? { directionLine2: String(v.dir2) } : {}),
        count: whole(num(v, 'count', 'Number of instances', { min: 1 }), 'Number of instances'),
        spacing: num(v, 'spacing', 'Spacing', { positive: true }),
        angle: (ref1 ?? num(v, 'angle', 'Angle')) + (v.reverse ? 180 : 0),
        dimension: !!v.dimension,
        fixDirection: !!v.fix,
        count2,
        spacing2: count2 > 1 ? num(v, 'spacing2', 'Direction 2 spacing', { positive: true }) : 0,
        angle2: (ref2 ?? num(v, 'angle2', 'Direction 2 angle')) + (v.reverse2 ? 180 : 0),
        dimension2: !!v.dimension2,
        dimensionAngle: !!v.between,
        skip: skipList(v.skip).filter((n) => n.length === 2).map(([i, j]) => [i - 1, j - 1] as [number, number]),
    };
}

/** Shows the pattern's instances while its form is open. */
function PatternPreview({ kind, values }: { kind: 'linear' | 'circular'; values: Values }) {
    const selection = useSketcher((s) => s.selection);
    useEffect(() => {
        try {
            previewPattern(kind, kind === 'linear' ? linearOptions(values) : circularOptions(values));
        } catch {
            previewPattern(kind, null);
        }
    }, [values, selection]);
    useEffect(() => () => previewPattern(kind, null), []);
    return null;
}

/** Pattern forms act on the curves selected in the sketch. */
const linearSketchPattern: ToolDef = {
    id: 'sk-pattern-linear',
    label: 'Linear pattern',
    icon: 'pattern',
    hint: 'copies of the selected curves in a row or grid, tied to them',
    width: 300,
    panel: true,
    fields: () => [
        { key: 'spacing', label: 'Spacing', kind: 'number', unit: 'mm', section: 'Direction 1' },
        { key: 'count', label: 'Number of instances', kind: 'number', min: 1, step: 1, section: 'Direction 1' },
        { key: 'angle', label: 'Angle', kind: 'number', unit: 'deg', section: 'Direction 1', show: (v) => !v.dir1 },
        { key: 'reverse', label: 'Reverse direction', kind: 'check', section: 'Direction 1' },
        { key: 'dimension', label: 'Dimension X spacing', kind: 'check', section: 'Direction 1' },
        { key: 'fix', label: 'Fix X-axis direction', kind: 'check', section: 'Direction 1', show: (v) => !v.dir1 },
        { key: 'count2', label: 'Number of instances', kind: 'number', min: 1, step: 1, section: 'Direction 2' },
        { key: 'spacing2', label: 'Spacing', kind: 'number', unit: 'mm', section: 'Direction 2', show: (v) => Number(v.count2) > 1 },
        { key: 'angle2', label: 'Angle', kind: 'number', unit: 'deg', section: 'Direction 2', show: (v) => Number(v.count2) > 1 && !v.between && !v.dir2 },
        { key: 'reverse2', label: 'Reverse direction', kind: 'check', section: 'Direction 2', show: (v) => Number(v.count2) > 1 },
        { key: 'dimension2', label: 'Dimension Y spacing', kind: 'check', section: 'Direction 2', show: (v) => Number(v.count2) > 1 },
        { key: 'between', label: 'Dimension angle between axes', kind: 'check', section: 'Direction 2', show: (v) => Number(v.count2) > 1 },
        { key: 'skip', label: 'Instances to skip (e.g. 2,1; 3,2)', kind: 'text', section: 'Instances to skip' },
    ],
    defaults: () => ({
        spacing: '20', count: '3', angle: '0', reverse: false, dimension: true, fix: true,
        count2: '1', spacing2: '20', angle2: '90', reverse2: false, dimension2: true, between: true, skip: '', dir1: '', dir2: '',
    }),
    top: (api) => (
        <>
            <p className="tb-note">Select the curves to pattern in the view (Shift adds). The instances stay tied to them.</p>
            <PickBoxes
                api={api}
                idle
                boxes={[
                    { key: 'dir1', label: 'Direction 1 from a line or straight model edge (optional; else the angle)', accept: lineOnly },
                    ...(Number(api.values.count2) > 1 ? [{ key: 'dir2', label: 'Direction 2 from a line (optional)', accept: lineOnly }] : []),
                ]}
            />
        </>
    ),
    extra: (api) => <PatternPreview kind="linear" values={api.values} />,
    apply: (v) => attempt(async () => {
        const error = linearPatternSelected(linearOptions(v));
        return { text: error ?? '', isError: !!error };
    }),
};

function circularOptions(v: Values): Omit<CircularPatternOptions, 'centre'> & { centre: Pt } {
    return {
        count: whole(num(v, 'count', 'Number of instances', { min: 2 }), 'Number of instances'),
        angle: nonZero(num(v, 'angle', 'Spacing'), 'Spacing') * (v.reverse ? -1 : 1),
        equal: !!v.equal,
        centre: [num(v, 'centre0', 'Centre U'), num(v, 'centre1', 'Centre V')],
        dimensionRadius: !!v.radius,
        dimensionAngle: !!v.angular,
        skip: skipList(v.skip).flat().map((n) => n - 1),
    };
}

const circularSketchPattern: ToolDef = {
    id: 'sk-pattern-circular',
    label: 'Circular pattern',
    icon: 'pattern-circular',
    hint: 'copies of the selected curves round a point, tied to them',
    width: 300,
    panel: true,
    fields: () => [
        { key: 'reverse', label: 'Reverse direction', kind: 'check', section: 'Parameters' },
        vecField('centre', 'Centre', 'mm'),
        { key: 'angle', label: 'Spacing', kind: 'number', unit: 'deg', section: 'Parameters' },
        { key: 'equal', label: 'Equal spacing', kind: 'check', section: 'Parameters' },
        { key: 'radius', label: 'Dimension radius', kind: 'check', section: 'Parameters' },
        { key: 'angular', label: 'Dimension angular spacing', kind: 'check', section: 'Parameters' },
        { key: 'count', label: 'Number of instances', kind: 'number', min: 2, step: 1, section: 'Parameters' },
        { key: 'skip', label: 'Instances to skip (e.g. 2, 4)', kind: 'text', section: 'Instances to skip' },
    ].map((f) => ({ ...f, section: f.section ?? 'Parameters' }) as Field),
    defaults: () => {
        const [u, v] = patternCentre();
        return {
            reverse: false, centre0: fmt(u), centre1: fmt(v), centre2: '0', angle: '360', equal: true, radius: false, angular: true,
            count: '6', skip: '',
        };
    },
    top: () => <p className="tb-note">Select the curves to pattern, and a point for the centre (else the origin). The instances stay tied to them.</p>,
    extra: (api) => <PatternPreview kind="circular" values={api.values} />,
    apply: (v) => attempt(async () => {
        const error = circularPatternSelected(circularOptions(v));
        return { text: error ?? '', isError: !!error };
    }),
};

const modifyTools: ToolDef[] = [
    // Edit tools with options open a form (sketchEditForms.tsx); the rest stay plain click tools.
    ...editToolForms,
    ...MODIFY_TOOLS.filter(({ id }) => !editToolForms.some((t) => t.id === `sk-${id}`)).map(({ id, label, key, icon, hint }): ToolDef => ({
        id: `sk-${id}`,
        label,
        icon,
        hint,
        shortcut: key,
        instant: () => setTool(id),
        active: (_, s) => s.sketchTool === id,
    })),
    withPatternExtras(linearSketchPattern, 'linear', linearOptions),
    withPatternExtras(circularSketchPattern, 'circular', circularOptions),
    ...moreModifyTools,
    ...moreSketchTools,
    ...modifyCommandTools,
    ...extrasModifyTools,
    ...modelSketchTools,
    ...wholeModifyTools,
];

const sketchModeTools: ToolDef[] = [
    {
        id: 'sk-select',
        label: 'Select',
        icon: 'select',
        hint: 'select, drag, edit dimensions',
        shortcut: 'V',
        instant: () => setTool('select'),
        active: (_, s) => s.sketchTool === 'select',
    },
    // Draw tools with options open their form (sketchDrawForms.tsx).
    ...sketchDrawTools.map(withDrawForm),
    ...moreDrawTools.map(withDrawForm),
    // Text, picture and equation driven curve (sketchExtrasTools.ts).
    ...extrasDrawTools,
    // Belt/chain (sketchDrawCommandForms.tsx).
    ...drawCommandTools,
    sketchOptionsTool,
    finishTool,
    {
        id: 'sk-cancel',
        label: 'Discard sketch',
        icon: 'cancel',
        hint: 'leave without saving it',
        danger: true,
        instant: () => discardSketch(),
    },
];

// ---- Solid features (part workspace) ------------------------------------------------------------------

const EDGES = opts(['all', 'All edges'], ['top', 'Top edges'], ['bottom', 'Bottom edges'], ['vertical', 'Vertical edges'],
    ['horizontal', 'Horizontal edges']);
const CHAMFER_TYPES = opts(['angle', 'Angle distance'], ['distance', 'Distance distance'], ['equal', 'Equal distance']);
const FACES = opts(['top', 'Top'], ['bottom', 'Bottom'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right']);
const FACE_NORMALS: Record<string, Vec3> = {
    top: [0, 1, 0], bottom: [0, -1, 0], front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0],
};

const repeatFields = (prefix: string): Field[] => [
    { key: `${prefix}kind`, label: 'Pattern', kind: 'select', options: opts(['none', 'None'], ['linear', 'Linear'], ['radial', 'Radial']) },
    { key: `${prefix}count`, label: 'Count', kind: 'number', unit: '×', min: 2, step: 1, show: (v) => v[`${prefix}kind`] !== 'none' },
    { key: `${prefix}step`, label: 'Step', kind: 'vec', unit: 'mm', show: (v) => v[`${prefix}kind`] === 'linear' },
    { key: `${prefix}centre`, label: 'Axis X / Z', kind: 'vec', unit: 'mm', axes: ['X', '', 'Z'],
        show: (v) => v[`${prefix}kind`] === 'radial' },
    { key: `${prefix}angle`, label: 'Sweep', kind: 'number', unit: 'deg', show: (v) => v[`${prefix}kind`] === 'radial' },
];

function repeatDefaults(prefix: string, step: Vec3, kind = 'none'): Values {
    return {
        [`${prefix}kind`]: kind,
        [`${prefix}count`]: kind === 'radial' ? '6' : '3',
        ...vecValues(`${prefix}step`, step),
        ...vecValues(`${prefix}centre`, [0, 0, 0]),
        [`${prefix}angle`]: '360',
    };
}

function repeatValues(prefix: string, r: Part['repeat'], fallbackStep: Vec3): Values {
    const base = repeatDefaults(prefix, fallbackStep, r?.kind ?? 'none');
    if (r?.kind === 'linear') {
        return { ...base, [`${prefix}count`]: String(r.count), ...vecValues(`${prefix}step`, r.step) };
    }
    if (r?.kind === 'radial') {
        return { ...base, [`${prefix}count`]: String(r.count), ...vecValues(`${prefix}centre`, [r.centre?.[0] ?? 0, 0, r.centre?.[1] ?? 0]),
            [`${prefix}angle`]: String(r.angle ?? 360) };
    }
    return base;
}

function readRepeat(v: Values, prefix: string): Record<string, unknown> | undefined {
    const kind = v[`${prefix}kind`];
    if (kind === 'none') {
        return undefined;
    }
    const count = Math.round(num(v, `${prefix}count`, 'Count', { min: 2 }));
    if (kind === 'linear') {
        return { kind: 'linear', count, step: vec(v, `${prefix}step`, 'Step') };
    }
    const angle = num(v, `${prefix}angle`, 'Sweep');
    return {
        kind: 'radial',
        count,
        centre: [num(v, `${prefix}centre0`, 'Axis X'), num(v, `${prefix}centre2`, 'Axis Z')],
        ...(angle !== 360 ? { angle } : {}),
    };
}

const HOLE_KINDS = opts(['clearance', 'Clearance'], ['tap', 'Tap drill'], ['heatset', 'Heat-set insert'],
    ['counterbore', 'Counterbore'], ['countersink', 'Countersink'], ['nutTrap', 'Nut trap'], ['plain', 'Plain (diameter)']);

/** The face a drilling direction comes in from, or 'other' for a direction that is not along an axis. */
function faceOf(direction: Vec3 | undefined): string {
    const d = direction ?? [0, -1, 0];
    const l = Math.hypot(...d) || 1;
    return Object.entries(FACE_NORMALS).find(([, n]) => n.every((c, i) => Math.abs(c + d[i] / l) < 1e-6))?.[0] ?? 'other';
}

/** Vector form values without rounding (a direction must come back exactly as it was stored). */
const exactVec = (key: string, value: Vec3): Values => ({ [`${key}0`]: String(value[0]), [`${key}1`]: String(value[1]), [`${key}2`]: String(value[2]) });

/** Depth of a heat-set insert's hole (the kernel's default for it). */
const insertDepth = (size: string): number => Math.round((heatsetData(size as ThreadSize).length + 0.5) * 1000) / 1000;

const featureTools: Record<string, ToolDef> = {
    fillet: {
        id: 'fillet',
        preview: true,
        label: 'Fillet',
        icon: 'fillet',
        op: 'fillet',
        needsPart: true,
        fields: () => [
            { key: 'items', label: 'Items to fillet', kind: 'pick', entities: ['edge', 'face'], multi: true, section: 'Items to fillet' },
            { key: 'tangent', label: 'Tangent propagation', kind: 'check', section: 'Items to fillet' },
            { key: 'edges', label: 'Edge group (when none picked)', kind: 'select', options: EDGES, section: 'Items to fillet',
                show: (v) => pickItems(v.items).length === 0 },
            { key: 'r', label: 'Radius', kind: 'number', unit: 'mm', min: 0, step: 0.5, section: 'Fillet parameters' },
        ],
        defaults: (ctx) => {
            const f = edited(ctx, 'fillet');
            return f
                ? { r: fmt(f.radius), edges: f.edges ?? 'all', items: itemsOf(f.at, f.faces), tangent: !!f.tangent }
                : { r: '2', edges: 'vertical', items: [], tangent: true };
        },
        // A variable radius (radius2, set by Jarvis) is kept: which end of each edge gets which radius is not stored.
        top: (_, ctx) => {
            const f = edited(ctx, 'fillet');
            return f?.radius2 !== undefined
                ? <p className="tb-note">The variable radius to {fmt(f.radius2)} mm is kept. Ask Jarvis to change it.</p> : null;
        },
        apply: (v, ctx) => attempt(() => saveFeature(ctx, filletFeature(v))),
    },
    chamfer: {
        id: 'chamfer',
        preview: true,
        label: 'Chamfer',
        icon: 'chamfer',
        op: 'chamfer',
        needsPart: true,
        fields: () => [
            { key: 'type', label: 'Chamfer type', kind: 'select', options: CHAMFER_TYPES, section: 'Chamfer type' },
            { key: 'items', label: 'Items to chamfer', kind: 'pick', entities: ['edge', 'face'], multi: true, section: 'Items to chamfer' },
            { key: 'tangent', label: 'Tangent propagation', kind: 'check', section: 'Items to chamfer' },
            { key: 'edges', label: 'Edge group (when none picked)', kind: 'select', options: EDGES, section: 'Items to chamfer',
                show: (v) => pickItems(v.items).length === 0 },
            { key: 's', label: 'Distance', kind: 'number', unit: 'mm', min: 0, step: 0.5, section: 'Chamfer parameters',
                show: (v) => v.type !== 'distance' },
            { key: 's', label: 'Distance 1', kind: 'number', unit: 'mm', min: 0, step: 0.5, section: 'Chamfer parameters',
                show: (v) => v.type === 'distance' },
            { key: 'd2', label: 'Distance 2', kind: 'number', unit: 'mm', min: 0, step: 0.5, section: 'Chamfer parameters',
                show: (v) => v.type === 'distance' },
            { key: 'angle', label: 'Angle', kind: 'number', unit: 'deg', min: 0, max: 90, step: 1, section: 'Chamfer parameters',
                show: (v) => v.type === 'angle' },
            { key: 'flip', label: 'Flip direction', kind: 'check', section: 'Chamfer parameters', show: (v) => v.type !== 'equal' },
        ],
        defaults: (ctx) => {
            const f = edited(ctx, 'chamfer');
            if (!f) {
                return { type: 'equal', s: '1', d2: '2', angle: '45', flip: false, edges: 'top', items: [], tangent: true, side: '' };
            }
            return {
                type: f.angle !== undefined ? 'angle' : f.distance2 !== undefined ? 'distance' : 'equal',
                s: fmt(f.size),
                d2: fmt(f.distance2 ?? f.size),
                angle: fmt(f.angle ?? 45),
                flip: false,
                edges: f.edges ?? 'all',
                items: itemsOf(f.at, f.faces),
                tangent: !!f.tangent,
                side: f.side ? JSON.stringify(f.side) : '',
            };
        },
        apply: (v, ctx) => attempt(() => saveFeature(ctx, chamferFeature(v, !!ctx.edit))),
    },
    shell: {
        id: 'shell',
        preview: true,
        label: 'Shell',
        icon: 'shell',
        op: 'shell',
        needsPart: true,
        fields: () => [
            { key: 't', label: 'Thickness', kind: 'number', unit: 'mm', min: 0, step: 0.4, section: 'Parameters' },
            { key: 'remove', label: 'Faces to remove', kind: 'pick', entities: ['face'], multi: true, section: 'Parameters' },
            { key: 'outward', label: 'Shell outward', kind: 'check', section: 'Parameters' },
            { key: 'open', label: 'Open sides (when no face picked)', kind: 'multi', options: FACES, section: 'Parameters',
                show: (v) => pickItems(v.remove).length === 0 },
        ],
        defaults: (ctx) => {
            const f = edited(ctx, 'shell');
            return f
                ? { t: fmt(f.thickness), open: [...(f.open ?? [])], remove: itemsOf(undefined, f.remove), outward: !!f.outward }
                : { t: '2', open: ['top'], remove: [], outward: false };
        },
        apply: (v, ctx) => attempt(() => saveFeature(ctx, shellFeature(v))),
    },
    draft: {
        id: 'draft',
        preview: true,
        label: 'Draft',
        icon: 'draft',
        hint: 'tilt faces about a neutral plane',
        op: 'draft',
        needsPart: true,
        fields: () => [
            { key: 'angle', label: 'Draft angle', kind: 'number', unit: 'deg', min: 0, max: 45, step: 1, section: 'Draft angle' },
            { key: 'neutral', label: 'Neutral plane', kind: 'pick', entities: ['face'], multi: false, flat: true, section: 'Neutral plane' },
            { key: 'flip', label: 'Reverse direction', kind: 'check', section: 'Neutral plane' },
            { key: 'faces', label: 'Faces to draft', kind: 'pick', entities: ['face'], multi: true, section: 'Faces to draft' },
            { key: 'propagation', label: 'Face propagation', kind: 'select', options: opts(['none', 'None'], ['tangent', 'Along tangent']),
                section: 'Faces to draft' },
        ],
        defaults: (ctx) => {
            const f = edited(ctx, 'draft');
            return f
                ? {
                    angle: fmt(f.angle), neutral: itemsOf(undefined, f.neutralFace ? [f.neutralFace] : []), flip: !!f.flip,
                    faces: itemsOf(undefined, f.picked), propagation: f.tangent ? 'tangent' : 'none',
                }
                : { angle: '3', neutral: [], flip: false, faces: [], propagation: 'none' };
        },
        top: (_, ctx) => {
            const f = edited(ctx, 'draft');
            const kept = [
                ...(f?.neutral && !f.neutralFace ? ['the neutral plane'] : []),
                ...(f?.faces?.length ? [`the ${f.faces.join(', ')} faces`] : []),
            ];
            return kept.length ? <p className="tb-note">Jarvis set {kept.join(' and ')}; picks made here are used with them.</p> : null;
        },
        apply: (v, ctx) => attempt(() => saveFeature(ctx, draftFeature(v, edited(ctx, 'draft')))),
    },
    hole: {
        id: 'hole',
        preview: true,
        label: 'Hole',
        icon: 'hole',
        op: 'hole',
        needsPart: true,
        width: 320,
        fields: (ctx) => [
            { key: 'kind', label: 'Type', kind: 'select', options: HOLE_KINDS },
            { key: 'size', label: 'Size', kind: 'select', options: SIZE_OPTIONS, show: (v) => v.kind !== 'plain' },
            { key: 'diameter', label: 'Diameter', kind: 'number', unit: 'mm', min: 0, step: 0.1, show: (v) => v.kind === 'plain' },
            { key: 'fit', label: 'Fit', kind: 'select', options: opts(['normal', 'Normal'], ['close', 'Close']),
                show: (v) => ['clearance', 'counterbore', 'countersink', 'nutTrap'].includes(v.kind as string) },
            { key: 'face', label: 'Drill from', kind: 'select',
                options: (ctx.edit?.feature?.op === 'hole' && faceOf(ctx.edit.feature.direction) === 'other')
                    ? [...FACES, { value: 'other', label: 'Its own direction' }] : FACES },
            { key: 'dir', label: 'Direction', kind: 'vec', show: (v) => v.face === 'other' },
            { key: 'pos', label: 'Entry point', kind: 'vec', unit: 'mm', pickable: true },
            // A heat-set hole is as deep as its insert unless a depth is given: it has no Through all.
            { key: 'through', label: 'Through all', kind: 'check', show: (v) => v.kind !== 'heatset' },
            { key: 'depth', label: 'Depth', kind: 'number', unit: 'mm', min: 0, show: (v) => v.kind === 'heatset' || !v.through },
            ...repeatFields('rep'),
        ],
        defaults: (ctx) => {
            const { centre: c, half: [, hy] } = partBox(ctx.part);
            const values: Values = {
                kind: 'clearance', size: 'M3', diameter: '5', fit: 'normal', face: 'top', ...vecValues('dir', [0, -1, 0]),
                ...vecValues('pos', [c[0], c[1] + hy, c[2]]), through: true, depth: '10', ...repeatDefaults('rep', [10, 0, 0]),
            };
            const f = edited(ctx, 'hole');
            if (f) {
                const size = f.spec.size ?? 'M3';
                Object.assign(values, {
                    kind: f.spec.kind, size, diameter: fmt(f.spec.diameter ?? 5), fit: f.spec.fit ?? 'normal',
                    face: faceOf(f.direction), ...exactVec('dir', f.direction ?? [0, -1, 0]), ...vecValues('pos', f.position),
                    through: f.depth === undefined,
                    depth: fmt(f.depth ?? (f.spec.kind === 'heatset' ? insertDepth(size) : 10)), ...repeatValues('rep', f.repeat, [10, 0, 0]),
                });
            }
            return values;
        },
        onChange: (key, v, { part }) => {
            const { centre: c, half: h } = partBox(part);
            if (key === 'face' && v.face !== 'other') {
                const n = FACE_NORMALS[v.face as string];
                return vecValues('pos', [c[0] + n[0] * h[0], c[1] + n[1] * h[1], c[2] + n[2] * h[2]]);
            }
            if ((key === 'kind' || key === 'size') && v.kind === 'heatset') {
                return { depth: fmt(insertDepth(v.size as string)) };
            }
            if (key === 'repkind' && v.repkind === 'radial') {
                return { repcount: '6', pos0: fmt(Math.round(c[0] + h[0] * 0.6)) };
            }
        },
        apply: (v, ctx) => attempt(() => {
            const kind = v.kind as string;
            const spec: Record<string, unknown> = { kind };
            if (kind === 'plain') {
                spec.diameter = num(v, 'diameter', 'Diameter', { positive: true });
            } else {
                spec.size = v.size;
            }
            if (['clearance', 'counterbore', 'countersink', 'nutTrap'].includes(kind)) {
                spec.fit = v.fit;
            }
            // A direction that is along no axis (a hole Jarvis drilled at an angle) is kept as it is.
            const direction = v.face === 'other' ? vec(v, 'dir', 'Direction') : FACE_NORMALS[v.face as string].map((c) => -c);
            if (!(Math.hypot(...direction) > 1e-9)) {
                throw new Error('Direction must not be zero.');
            }
            const repeat = readRepeat(v, 'rep');
            const label = kind === 'plain' ? `Ø${fmt(spec.diameter as number)} hole` : `${v.size} ${HOLE_KINDS.find((o) => o.value === kind)!.label.toLowerCase()} hole`;
            return saveFeature(ctx, {
                op: 'hole',
                name: `${label[0].toUpperCase()}${label.slice(1)}${repeat ? ` ×${repeat.count}` : ''}`,
                spec,
                position: vec(v, 'pos', 'Entry'),
                direction,
                ...(v.through && kind !== 'heatset' ? {} : { depth: num(v, 'depth', 'Depth', { positive: true }) }),
                ...(repeat ? { repeat } : {}),
            });
        }),
    },
    pocket: {
        id: 'pocket',
        preview: true,
        label: 'Cut pocket',
        icon: 'pocket',
        op: 'cut',
        hint: 'box or cylinder cut from the top',
        needsPart: true,
        width: 300,
        fields: () => [
            { key: 'shape', label: 'Shape', kind: 'select', options: opts(['box', 'Rectangular'], ['cylinder', 'Round']) },
            { key: 'sx', label: 'Width X', kind: 'number', unit: 'mm', min: 0, show: (v) => v.shape === 'box' },
            { key: 'sz', label: 'Length Z', kind: 'number', unit: 'mm', min: 0, show: (v) => v.shape === 'box' },
            { key: 'dia', label: 'Diameter', kind: 'number', unit: 'mm', min: 0, show: (v) => v.shape === 'cylinder' },
            { key: 'depth', label: 'Depth', kind: 'number', unit: 'mm', min: 0 },
            { key: 'r', label: 'Corner round', kind: 'number', unit: 'mm', min: 0, show: (v) => v.shape === 'box' },
            { key: 'pos', label: 'Top centre', kind: 'vec', unit: 'mm', pickable: true },
        ],
        defaults: (ctx) => {
            const [hx, hy, hz] = half(ctx.part);
            const values: Values = {
                shape: 'box', sx: fmt(Math.max(1, Math.round(hx))), sz: fmt(Math.max(1, Math.round(hz))),
                dia: fmt(Math.max(1, Math.round(Math.min(hx, hz)))), depth: fmt(Math.max(1, Math.round(hy / 2))), r: '0',
                ...vecValues('pos', [0, hy, 0]),
            };
            const f = edited(ctx, 'cut');
            if (f && (f.shape.kind === 'box' || f.shape.kind === 'cylinder')) {
                const height = f.shape.kind === 'box' ? f.shape.size[1] : f.shape.height;
                const depth = height - 0.5;
                const [x, y, z] = f.position ?? [0, 0, 0];
                Object.assign(values, { shape: f.shape.kind, depth: fmt(depth), ...vecValues('pos', [x, y + depth / 2 - 0.25, z]) });
                if (f.shape.kind === 'box') {
                    Object.assign(values, { sx: fmt(f.shape.size[0]), sz: fmt(f.shape.size[2]), r: fmt(f.shape.radius ?? 0) });
                } else {
                    values.dia = fmt(f.shape.radius * 2);
                }
            }
            return values;
        },
        apply: (v, ctx) => attempt(() => {
            const depth = num(v, 'depth', 'Depth', { positive: true });
            const [x, top, z] = vec(v, 'pos', 'Top centre');
            // 0.5 mm above the surface so the cut leaves no skin.
            const height = depth + 0.5;
            const position: Vec3 = [x, top - depth / 2 + 0.25, z];
            if (v.shape === 'box') {
                const sx = num(v, 'sx', 'Width', { positive: true });
                const sz = num(v, 'sz', 'Length', { positive: true });
                return saveFeature(ctx, {
                    op: 'cut',
                    name: `Pocket ${fmt(sx)}×${fmt(sz)}×${fmt(depth)} mm`,
                    shape: { kind: 'box', size: [sx, height, sz], radius: num(v, 'r', 'Corner round', { min: 0 }) },
                    position,
                });
            }
            const d = num(v, 'dia', 'Diameter', { positive: true });
            return saveFeature(ctx, {
                op: 'cut',
                name: `Round pocket Ø${fmt(d)}×${fmt(depth)} mm`,
                shape: { kind: 'cylinder', radius: d / 2, height, bevel: 0 },
                position,
            });
        }),
    },
    mirror: mirrorTool,
    thread: {
        id: 'thread',
        preview: true,
        label: 'Thread',
        icon: 'thread',
        op: 'thread',
        hint: 'a modelled thread on a shaft or in a hole: cut or extruded',
        needsPart: true,
        width: 310,
        fields: (ctx) => [
            { key: 'start', label: 'Start at', kind: 'select', section: 'Thread location',
                options: opts(['edge', 'Circular edges (picked)'], ['point', 'Point on a +Y axis']) },
            // Several holes or shafts get the same thread in one step, each from its own edge.
            { key: 'edges', label: 'Circular edges', kind: 'pick', entities: ['edge'], multi: true, section: 'Thread location',
                show: (v) => v.start === 'edge' },
            { key: 'pos', label: 'Start point', kind: 'vec', unit: 'mm', section: 'Thread location', show: (v) => v.start === 'point' },
            { key: 'offset', label: 'Offset', kind: 'number', unit: 'mm', section: 'Thread location', show: (v) => v.start === 'edge' },
            { key: 'startAngle', label: 'Start angle', kind: 'number', unit: 'deg', section: 'Thread location' },
            { key: 'end', label: 'End condition', kind: 'select', options: opts(['blind', 'Blind'], ['revolutions', 'Revolutions']), section: 'End condition' },
            { key: 'length', label: 'Depth', kind: 'number', unit: 'mm', min: 0, section: 'End condition', show: (v) => v.end !== 'revolutions' },
            { key: 'revolutions', label: 'Revolutions', kind: 'number', min: 0, section: 'End condition', show: (v) => v.end === 'revolutions' },
            { key: 'second', label: 'Second direction', kind: 'check', section: 'Direction 2', show: (v) => v.start === 'edge' },
            { key: 'length2', label: 'Depth', kind: 'number', unit: 'mm', min: 0, section: 'Direction 2',
                show: (v) => v.start === 'edge' && !!v.second },
            { key: 'kind', label: 'Type', kind: 'select', options: opts(['external', 'External (shaft)'], ['internal', 'Internal (hole)']), section: 'Specification' },
            { key: 'size', label: 'Size', kind: 'select', options: [{ value: 'custom', label: 'Custom' }, ...SIZE_OPTIONS], section: 'Specification' },
            { key: 'override', label: 'Override diameter', kind: 'check', section: 'Specification', show: (v) => v.start === 'edge' },
            { key: 'diameter', label: 'Diameter', kind: 'number', unit: 'mm', min: 0, step: 0.1, section: 'Specification',
                show: (v) => v.start !== 'edge' || !!v.override },
            { key: 'pitch', label: 'Pitch', kind: 'number', unit: 'mm', min: 0, step: 0.05, section: 'Specification' },
            // Cut thread only removes material (hole at tap size, shaft at the major diameter); Extrude thread adds
            // the ridges (hole at the major diameter, shaft at the root). Automatic picks one per edge by its size, so a
            // full-size hole gets ridges instead of an error.
            { key: 'method', label: 'Thread method', kind: 'select', section: 'Specification', show: (v) => v.start === 'edge',
                options: opts(['auto', 'Automatic (by the size of each hole or shaft)'], ['cut', 'Cut thread'], ['extrude', 'Extrude thread']) },
            { key: 'hand', label: 'Hand', kind: 'select', options: opts(['right', 'Right-hand'], ['left', 'Left-hand']), section: 'Thread options' },
            { key: 'starts', label: 'Starts', kind: 'number', min: 1, max: 8, step: 1, section: 'Thread options' },
            { key: 'trimStart', label: 'Trim with start face', kind: 'check', section: 'Thread options' },
            { key: 'trimEnd', label: 'Trim with end face', kind: 'check', section: 'Thread options' },
        ],
        defaults: (ctx) => {
            const f = edited(ctx, 'thread');
            if (f) {
                const preset = THREAD_SIZES.find((s) => {
                    const t = threadData(s);
                    return f.diameter !== undefined && Math.abs(t.major - f.diameter) < 1e-6 && Math.abs(t.pitch - f.pitch) < 1e-6;
                });
                return {
                    start: f.at ? 'edge' : 'point', edges: itemsOf(f.at ? [f.at, ...(f.alsoAt ?? [])] : [], undefined),
                    ...vecValues('pos', f.position ?? [0, 0, 0]), offset: fmt(f.offset ?? 0), startAngle: fmt(f.startAngle ?? 0),
                    end: f.revolutions !== undefined ? 'revolutions' : 'blind', length: fmt(f.length ?? 10), revolutions: fmt(f.revolutions ?? 8),
                    kind: f.kind, size: preset ?? 'custom', override: !!f.at && f.diameter !== undefined, diameter: fmt(f.diameter ?? 8),
                    pitch: fmt(f.pitch), hand: f.leftHanded ? 'left' : 'right', starts: String(f.starts ?? 1),
                    second: f.length2 !== undefined, length2: fmt(f.length2 ?? 5),
                    method: f.method ?? 'auto', trimStart: f.trimStart ?? true, trimEnd: f.trimEnd ?? true,
                };
            }
            const { centre: c, half: [, hy] } = partBox(ctx.part);
            return {
                start: 'edge', edges: [], ...vecValues('pos', [c[0], c[1] - hy, c[2]]), offset: '0',
                startAngle: '0', end: 'blind', length: '10', revolutions: '8', kind: 'external', size: 'M8', override: false,
                diameter: '8', pitch: '1.25', hand: 'right', starts: '1', second: false, length2: '5',
                method: 'auto', trimStart: true, trimEnd: true,
            };
        },
        onChange: (key, v) => {
            if (key === 'size' && v.size !== 'custom') {
                const t = threadData(v.size as ThreadSize);
                return { diameter: fmt(t.major), pitch: fmt(t.pitch) };
            }
        },
        top: (api) => (
            <p className="tb-note">
                {api.values.start !== 'edge' ? 'The thread runs up +Y from the start point, as a rod or bore of its own.'
                    : 'Click the circular edge at the end of each shaft or hole to thread: each gets the same thread, from its own edge.'}
            </p>
        ),
        apply: (v, ctx) => attempt(() => {
            const pitch = num(v, 'pitch', 'Pitch', { positive: true });
            const onEdge = v.start === 'edge';
            const edges = pickItems(v.edges).filter((i) => i.kind === 'edge').map((i) => [...i.at] as Vec3);
            if (onEdge && edges.length === 0) {
                throw new Error('Click the circular edge where the thread starts.');
            }
            const diameter = !onEdge || v.override ? num(v, 'diameter', 'Diameter', { positive: true }) : undefined;
            const revolutions = v.end === 'revolutions' ? num(v, 'revolutions', 'Revolutions', { positive: true }) : undefined;
            const length = revolutions === undefined ? num(v, 'length', 'Depth', { positive: true }) : undefined;
            const starts = Math.round(num(v, 'starts', 'Starts', { min: 1 }));
            const startAngle = num(v, 'startAngle', 'Start angle');
            const offset = onEdge ? num(v, 'offset', 'Offset') : 0;
            const length2 = onEdge && v.second ? num(v, 'length2', 'Direction 2 depth', { positive: true }) : undefined;
            const size = v.size !== 'custom' ? String(v.size) : diameter !== undefined ? `Ø${fmt(diameter)}` : '';
            const feature: Record<string, unknown> = {
                op: 'thread',
                name: `${v.kind === 'external' ? 'External' : 'Internal'} thread ${size}${size ? '×' : 'P'}${fmt(pitch)}`,
                kind: v.kind,
                pitch,
                ...(diameter !== undefined ? { diameter } : {}),
                ...(onEdge ? { at: edges[0], ...(edges.length > 1 ? { alsoAt: edges.slice(1) } : {}) } : { position: vec(v, 'pos', 'Start') }),
                ...(revolutions !== undefined ? { revolutions } : { length }),
                ...(offset ? { offset } : {}),
                ...(length2 !== undefined ? { length2 } : {}),
                ...(startAngle ? { startAngle } : {}),
                ...(v.hand === 'left' ? { leftHanded: true } : {}),
                ...(starts > 1 ? { starts } : {}),
                ...(onEdge && (v.method === 'cut' || v.method === 'extrude') ? { method: v.method } : {}),
                ...(v.trimStart ? {} : { trimStart: false }),
                ...(v.trimEnd ? {} : { trimEnd: false }),
            };
            if (ctx.edit?.feature) {
                // An update merges fields: what the form left out is cleared explicitly.
                Object.assign(feature, {
                    diameter: diameter ?? null, at: onEdge ? feature.at : null, alsoAt: feature.alsoAt ?? null,
                    position: onEdge ? null : feature.position,
                    revolutions: revolutions ?? null, length: length ?? null, offset, startAngle, leftHanded: v.hand === 'left', starts,
                    length2: length2 ?? null, method: feature.method ?? null, trimStart: v.trimStart ? null : false,
                    trimEnd: v.trimEnd ? null : false,
                });
            }
            return saveFeature(ctx, feature);
        }),
    },
};

const solidTools: ToolDef[] = [
    sketchOpTool('extrude'),
    sketchOpTool('cut'),
    sketchOpTool('revolve'),
    sweepTool,
    loftTool,
    featureTools.mirror,
    featureTools.shell,
    featureTools.fillet,
    featureTools.chamfer,
    featureTools.draft,
    featureTools.hole,
    featureTools.pocket,
    featureTools.thread,
    combineTool,
    splitTool,
];

// ---- Pattern, transform, material ---------------------------------------------------------------------

/** Assembly: copies of the whole part (SolidWorks component pattern). Feature patterns are in patternToolDefs.tsx. */
const patternTool: ToolDef = {
    id: 'pattern',
    preview: true,
    label: 'Component pattern',
    icon: 'pattern',
    hint: 'copies of the whole part in the assembly',
    needsPart: true,
    width: 300,
    panel: true,
    fields: () => repeatFields('rep').map((f) => (f.key === 'repkind'
        ? { ...f, options: f.options!.filter((o) => o.value !== 'none') } : f)),
    defaults: ({ part }) => {
        const r = part?.repeat;
        return repeatValues('rep', r ?? { kind: 'linear', count: 3, step: [2 * half(part)[0] + 5, 0, 0] }, [2 * half(part)[0] + 5, 0, 0]);
    },
    apply: (v, { part }) => attempt(async () => {
        if (!part) {
            throw new Error('Select a part first.');
        }
        return runTool('parts_update', { updates: [{ id: part.id, repeat: readRepeat(v, 'rep') }] });
    }),
};

function copyOf(part: Part, patch: Partial<Part>): Record<string, unknown> {
    return designCopy(part, patch, useStudio.getState().history?.parts ?? []);
}

const transformTools: ToolDef[] = [
    {
        id: 'move',
        preview: true,
        label: 'Move',
        icon: 'move',
        hint: 'absolute position of the part centre',
        needsPart: true,
        width: 300,
        fields: () => [
            { key: 'pos', label: 'Position', kind: 'vec', unit: 'mm' },
            { key: 'step', label: 'Nudge step', kind: 'number', unit: 'mm', min: 0 },
        ],
        defaults: ({ part }) => ({ ...vecValues('pos', part?.position ?? [0, 0, 0]), step: '10' }),
        apply: (v, { part }) => attempt(async () => runTool('parts_update', { updates: [{ id: part!.id, position: vec(v, 'pos', 'Position') }] })),
        extra: (api, { part }) => (
            <div className="tb-nudges">
                {[0, 1, 2].map((axis) => (
                    <span key={axis} className={`tb-nudge axis-${'xyz'[axis]}`}>
                        {[-1, 1].map((sign) => (
                            <button
                                key={sign}
                                type="button"
                                onClick={() => api.run(() => attempt(async () => {
                                    const position = vec(api.values, 'pos', 'Position');
                                    position[axis] += sign * num(api.values, 'step', 'Nudge step', { positive: true });
                                    api.set(vecValues('pos', position));
                                    return runTool('parts_update', { updates: [{ id: part!.id, position }] });
                                }), false)}
                            >
                                {sign < 0 ? '−' : '+'}{'XYZ'[axis]}
                            </button>
                        ))}
                    </span>
                ))}
            </div>
        ),
    },
    {
        id: 'rotate',
        preview: true,
        label: 'Rotate',
        icon: 'rotate',
        hint: 'Euler XYZ',
        needsPart: true,
        width: 300,
        fields: () => [{ key: 'rot', label: 'Rotation', kind: 'vec', unit: 'deg' }],
        defaults: ({ part }) => vecValues('rot', part?.rotation ?? [0, 0, 0]),
        apply: (v, { part }) => attempt(async () => runTool('parts_update', { updates: [{ id: part!.id, rotation: vec(v, 'rot', 'Rotation') }] })),
        extra: (api) => (
            <div className="tb-nudges">
                {[0, 1, 2].map((axis) => (
                    <span key={axis} className={`tb-nudge axis-${'xyz'[axis]}`}>
                        {[-90, 90].map((d) => (
                            <button
                                key={d}
                                type="button"
                                onClick={() => {
                                    const key = `rot${axis}`;
                                    const current = Number(api.values[key]) || 0;
                                    api.set({ [key]: fmt((((current + d) % 360) + 540) % 360 - 180) });
                                }}
                            >
                                {d < 0 ? '−' : '+'}90° {'XYZ'[axis]}
                            </button>
                        ))}
                    </span>
                ))}
            </div>
        ),
    },
    {
        id: 'duplicate',
        preview: true,
        label: 'Duplicate',
        icon: 'duplicate',
        needsPart: true,
        width: 300,
        fields: () => [{ key: 'off', label: 'Offset', kind: 'vec', unit: 'mm' }],
        defaults: ({ part }) => vecValues('off', [2 * half(part)[0] + 10, 0, 0]),
        applyLabel: 'Duplicate',
        apply: (v, { part }) => attempt(async () => {
            const full = fullPart(part!.id) ?? part!;
            const off = vec(v, 'off', 'Offset');
            return addPart(copyOf(full, {
                name: `${full.name} copy`,
                position: full.position.map((c, i) => c + off[i]) as Vec3,
            }));
        }),
    },
    {
        id: 'mirror-copy',
        preview: true,
        label: 'Mirror copy',
        icon: 'mirror',
        hint: 'a mirrored copy across a world plane',
        needsPart: true,
        fields: () => [
            { key: 'plane', label: 'Plane', kind: 'select', options: opts(['YZ', 'YZ (flip X)'], ['XY', 'XY (flip Z)']) },
            { key: 'copy', label: 'Keep original', kind: 'check' },
        ],
        defaults: () => ({ plane: 'YZ', copy: true }),
        applyLabel: 'Mirror',
        apply: (v, { part }) => attempt(async () => {
            const full = fullPart(part!.id) ?? part!;
            const [x, y, z] = full.position;
            const [rx, ry, rz] = full.rotation;
            // The placement is reflected (M·R·M); the solid itself gets a mirror feature so its shape flips too.
            const patch = v.plane === 'YZ'
                ? { position: [-x, y, z] as Vec3, rotation: [rx, -ry, -rz] as Vec3 }
                : { position: [x, y, -z] as Vec3, rotation: [-rx, -ry, rz] as Vec3 };
            const flip = { id: 'mirror-image', op: 'mirror', name: `Mirror image (${v.plane})`, plane: v.plane, keepOriginal: false };
            if (v.copy) {
                const design = copyOf(full, {});
                const features = [...((design.features as Feature[] | undefined) ?? []), flip];
                return addPart({ ...design, ...patch, name: `${full.name} mirrored`, features });
            }
            if (full.instanceOf) {
                // An instance shares its source's design, so its own shape cannot be flipped on its own.
                throw new Error(`${full.name} is an instance of another part: turn on Keep original to make a mirrored copy.`);
            }
            return runTool('parts_update', { updates: [{ id: full.id, ...patch, features: [...(full.features ?? []), flip] }] });
        }),
    },
    {
        id: 'delete',
        label: 'Delete',
        icon: 'delete',
        shortcut: 'Del',
        needsPart: true,
        danger: true,
        applyLabel: 'Delete',
        top: (_, { part }) => <p className="tb-note">Delete <b>{part?.name}</b>? Undo brings it back.</p>,
        apply: (_, { part }) => attempt(async () => {
            const result = await runTool('parts_remove', { ids: [part!.id] });
            if (!result.isError) {
                select(null);
            }
            return result;
        }),
    },
];

export const MATERIAL_PRESETS: { name: string; material: Required<Pick<Material, 'color' | 'metalness' | 'roughness'>> & { clearcoat: number; transmission: number } }[] = [
    { name: 'PLA matte', material: { color: '#b8bcc4', metalness: 0, roughness: 0.7, clearcoat: 0, transmission: 0 } },
    { name: 'PETG gloss', material: { color: '#3a7bd5', metalness: 0, roughness: 0.22, clearcoat: 0.6, transmission: 0 } },
    { name: 'TPU rubber', material: { color: '#2b2e33', metalness: 0, roughness: 0.92, clearcoat: 0, transmission: 0 } },
    { name: 'Aluminium anodised', material: { color: '#8d97a5', metalness: 0.85, roughness: 0.38, clearcoat: 0.2, transmission: 0 } },
    { name: 'Stainless steel', material: { color: '#c4c8cd', metalness: 1, roughness: 0.26, clearcoat: 0, transmission: 0 } },
    { name: 'Brass', material: { color: '#c9a24a', metalness: 1, roughness: 0.3, clearcoat: 0, transmission: 0 } },
    { name: 'Clear acrylic', material: { color: '#e9f3ff', metalness: 0, roughness: 0.04, clearcoat: 0.8, transmission: 0.92 } },
];

const materialTool: ToolDef = {
    id: 'material',
    preview: true,
    label: 'Material',
    icon: 'material',
    needsPart: true,
    width: 300,
    fields: () => [
        { key: 'color', label: 'Colour', kind: 'color' },
        { key: 'metalness', label: 'Metalness', kind: 'range', min: 0, max: 1, step: 0.01 },
        { key: 'roughness', label: 'Roughness', kind: 'range', min: 0, max: 1, step: 0.01 },
        { key: 'clearcoat', label: 'Clear coat', kind: 'range', min: 0, max: 1, step: 0.01 },
        { key: 'transmission', label: 'Transmission', kind: 'range', min: 0, max: 1, step: 0.01 },
    ],
    defaults: ({ part }) => {
        const m = part?.material ?? PLA_GREY;
        return {
            color: m.color.length === 7 ? m.color : '#b8bcc4',
            metalness: fmt(m.metalness),
            roughness: fmt(m.roughness),
            clearcoat: fmt(m.clearcoat ?? (m.metalness > 0.5 ? 0.3 : 0)),
            transmission: fmt(m.transmission ?? 0),
        };
    },
    top: (api) => (
        <div className="tb-presets">
            {MATERIAL_PRESETS.map(({ name, material }) => (
                <button
                    key={name}
                    type="button"
                    title={name}
                    onClick={() => api.set({
                        color: material.color, metalness: fmt(material.metalness), roughness: fmt(material.roughness),
                        clearcoat: fmt(material.clearcoat), transmission: fmt(material.transmission),
                    })}
                >
                    <span className="swatch" style={{ background: material.color }} />
                    {name}
                </button>
            ))}
        </div>
    ),
    apply: (v, { part }) => attempt(async () => {
        const transmission = num(v, 'transmission', 'Transmission');
        return runTool('parts_update', {
            updates: [{
                id: part!.id,
                material: {
                    color: v.color,
                    metalness: num(v, 'metalness', 'Metalness'),
                    roughness: num(v, 'roughness', 'Roughness'),
                    clearcoat: num(v, 'clearcoat', 'Clear coat'),
                    transmission,
                    // Clear parts keep their full opacity; transmission does the see-through.
                    ...(transmission > 0 ? { opacity: 1 } : {}),
                },
            }],
        });
    }),
};

// ---- View ---------------------------------------------------------------------------------------------

export const VIEWS: { id: string; label: string; key?: string; azimuth: number; elevation: number }[] = [
    { id: 'iso', label: 'Iso', key: '4', azimuth: 45, elevation: 35.26 },
    { id: 'front', label: 'Front', key: '1', azimuth: 0, elevation: 0 },
    { id: 'top', label: 'Top', key: '2', azimuth: 0, elevation: 89 },
    { id: 'right', label: 'Right', key: '3', azimuth: 90, elevation: 0 },
    { id: 'left', label: 'Left', azimuth: -90, elevation: 0 },
    { id: 'back', label: 'Back', azimuth: 180, elevation: 0 },
    // From below, the front at the top of the screen; Trimetric and Dimetric look from the front, right and above as
    // Isometric does (SOLIDWORKS_REFERENCE E3).
    { id: 'bottom', label: 'Bottom', azimuth: 0, elevation: -89 },
    { id: 'trimetric', label: 'Trimetric', azimuth: 35, elevation: 20 },
    { id: 'dimetric', label: 'Dimetric', azimuth: 20.7048, elevation: 19.4712 },
];

export async function setView(azimuth: number, elevation: number): Promise<void> {
    await runTool('view_set', { azimuth, elevation });
    refit();
}

export async function fitView(): Promise<void> {
    if (useStudio.getState().history?.view.focus) {
        await runTool('view_set', { focus: null });
    }
    refit();
}

let explodeTimer: number | undefined;

function explodeTo(factor: number): void {
    window.clearTimeout(explodeTimer);
    explodeTimer = window.setTimeout(() => void runTool('assembly_explode', { factor }), 220);
}

const viewsTool: ToolDef = {
    id: 'views',
    label: 'Views',
    icon: 'views',
    hint: 'standard views',
    noApply: true,
    width: 236,
    top: () => (
        <div className="tb-views">
            {VIEWS.map((view) => (
                <button key={view.id} type="button" onClick={() => void setView(view.azimuth, view.elevation)}>
                    {view.label}
                    {view.key && <kbd>{view.key}</kbd>}
                </button>
            ))}
            <SketchNormalTo />
        </div>
    ),
};
const fitTool: ToolDef = { id: 'fit', label: 'Fit all', icon: 'fit', shortcut: 'F', instant: () => void fitView() };
const gridTool: ToolDef = {
    id: 'grid',
    label: 'Grid',
    icon: 'grid',
    hint: '10 mm cells',
    shortcut: 'G',
    instant: () => useStudio.setState((s) => ({ grid: !s.grid })),
    active: (_, s) => s.grid,
};
/** The view a Perspective choice is for: the sketch being drawn (flat by default), else the 3D view. */
export const perspectiveView = (): 'sketch' | 'model' => {
    const s = useSketcher.getState();
    return s.active && s.stage === 'draw' ? 'sketch' : 'model';
};
const perspectiveTool: ToolDef = {
    id: 'perspective',
    label: 'Perspective',
    icon: 'perspective',
    hint: 'off: a flat view without perspective. Sketching and the 3D view each keep their own choice',
    instant: () => {
        const view = perspectiveView();
        setPerspective(view, !useStudio.getState().perspective[view]);
    },
    active: (_, s) => s.perspective,
};
const edgesTool: ToolDef = {
    id: 'edges',
    label: 'Edges',
    icon: 'edges',
    instant: () => useStudio.setState((s) => ({ edges: !s.edges })),
    active: (_, s) => s.edges,
};
const labelsTool: ToolDef = {
    id: 'labels',
    label: 'Labels',
    icon: 'labels',
    hint: 'callouts',
    instant: ({ project }) => void runTool('view_set', { labels: !project?.view.labels }),
    active: ({ project }) => project?.view.labels ?? false,
};
const othersTool: ToolDef = {
    id: 'others',
    label: 'Show other parts',
    icon: 'ghost',
    hint: 'in context: the rest of the assembly as faint ghosts',
    // The same switch as Isolated / In context above the tree.
    instant: () => useStudio.setState((s) => ({ partView: s.partView === 'inContext' ? 'isolated' : 'inContext' })),
    active: (_, s) => s.showOthers,
};
const sketchesTool: ToolDef = {
    id: 'sketches',
    label: 'Show sketches',
    icon: 'sketch',
    hint: 'the part\'s sketch steps as curves',
    instant: () => useSketcher.setState((s) => ({ showSketches: !s.showSketches })),
    active: () => useSketcher.getState().showSketches,
};
/** Hides the sketch picked in the view, or shows all of the part's hidden sketches again. */
const sketchVisibilityTool: ToolDef = {
    id: 'sketch-visibility',
    label: 'Hide or show sketches',
    icon: 'eye',
    hint: 'hide the clicked sketch, or show all (right-click a sketch hides it too)',
    needsPart: true,
    noApply: true,
    width: 280,
    top: (_, ctx) => {
        const part = ctx.part!;
        const hidden = new Set(useStudio.getState().history?.view.hiddenSketches ?? []);
        const steps = sketchSteps(part);
        if (!steps.length) {
            return <p className="tb-note">This part has no sketches.</p>;
        }
        return (
            <div className="tb-sketch-list">
                {steps.map((f) => {
                    const off = hidden.has(`${part.id}/${f.id}`);
                    return (
                        <button key={f.id} type="button" className={off ? '' : 'on'} onClick={() => setSketchHidden(part.id, f.id, !off)}>
                            <Icon name={off ? 'eye-off' : 'eye'} size={14} />
                            <span>{f.name ?? f.id}</span>
                        </button>
                    );
                })}
            </div>
        );
    },
};
const explodeTool: ToolDef = {
    id: 'explode',
    label: 'Explode',
    icon: 'explode',
    noApply: true,
    width: 260,
    fields: () => [{ key: 'factor', label: 'Explode', kind: 'range', min: 0, max: 1, step: 0.01 }],
    defaults: ({ project }) => ({ factor: fmt(project?.view.explode ?? 0) }),
    onChange: (key, v) => {
        if (key === 'factor') {
            explodeTo(Number(v.factor));
        }
    },
};

// ---- Export and inspect -------------------------------------------------------------------------------

const checkTool: ToolDef = {
    id: 'check',
    label: 'Check',
    icon: 'check',
    hint: 'build errors, sizes, bed fit',
    keepOpen: true,
    width: 340,
    top: () => <p className="tb-note">Builds every part and reports errors, real sizes and whether printed parts fit the bed.</p>,
    applyLabel: 'Run check',
    apply: () => runTool('cad_check', {}),
};

const exportTools: ToolDef[] = [
    {
        id: 'stl',
        label: 'Export STL',
        icon: 'stl',
        hint: 'printed parts',
        keepOpen: true,
        width: 300,
        fields: ({ part }) => [
            ...(part ? [{ key: 'only', label: `Only ${part.name}`, kind: 'check' as const }] : []),
            { key: 'combined', label: 'One combined file', kind: 'check', show: (v) => !v.only },
        ],
        defaults: () => ({ only: false, combined: false }),
        applyLabel: 'Export',
        apply: (v, { part }) => runTool('export_stl', {
            ...(v.only && part ? { partIds: [part.id] } : {}),
            ...(v.combined && !v.only ? { combined: true } : {}),
        }),
    },
    {
        id: 'step',
        label: 'Export STEP',
        icon: 'step',
        hint: 'whole assembly',
        keepOpen: true,
        width: 300,
        top: () => <p className="tb-note">Real solids with names and colours, for Fusion, FreeCAD, SolidWorks or Onshape.</p>,
        applyLabel: 'Export',
        apply: () => runTool('export_step', {}),
    },
    freecadExportTool,
    checkTool,
];

const historyTools: ToolDef[] = [
    { id: 'undo', label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', instant: () => void runTool('undo') },
    { id: 'redo', label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Shift+Z', instant: () => void runTool('redo') },
];

const sketchHistoryTools: ToolDef[] = [
    { id: 'sk-undo', label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', instant: () => undoSketch() },
    { id: 'sk-redo', label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Shift+Z', instant: () => redoSketch() },
];

/** Puts a picture on the part's surface: choose, drop or paste it, then click where it goes. */
const pictureTool: ToolDef = {
    id: 'picture',
    label: 'Add picture',
    icon: 'picture',
    hint: 'put a picture on the surface of the part',
    needsPart: true,
    noApply: true,
    width: 280,
    top: (api, ctx) => (
        <PicturePicker
            busy={false}
            onPicture={(blob) => api.run(() => addPicture(ctx.part!, blob), false)}
            onDone={() => api.run(async () => ({ text: '', isError: false }))}
        />
    ),
};

// ---- Workspaces ---------------------------------------------------------------------------------------

const newPartTool: ToolDef = {
    id: 'new-part',
    label: 'New part',
    icon: 'sketch',
    hint: 'an empty part: sketch on a plane, add planes, then build features from them',
    instant: () => void newPart(),
};

/** Shown in the editing popup for history items the toolbar cannot edit. */
export const noEditTool: ToolDef = {
    id: 'no-edit',
    label: 'Edit',
    icon: 'sketch',
    noApply: true,
    panel: true,
    top: () => <p className="tb-note">This step has no editor here yet. Ask Jarvis to change it, e.g. “make the boss 2 mm taller”.</p>,
};

export const PART_GROUPS: ToolGroup[] = [
    { id: 'sketch', label: 'Sketch', icon: 'sketch', tools: [...sketchStartTools, derivedSketchTool, rapidSketchTool] },
    { id: 'solid', label: 'Solid', icon: 'extrude', collapse: 4, tools: solidTools },
    { id: 'reference', label: 'Reference geometry', short: 'Planes', icon: 'ref-plane', collapse: 2, tools: referenceTools },
    { id: 'pattern', label: 'Pattern', icon: 'pattern', tools: [linearPatternTool, circularPatternTool] },
    { id: 'material', label: 'Material', icon: 'material', tools: [materialTool, pictureTool] },
    { id: 'view', label: 'View', icon: 'views', collapse: 3, tools: [viewsTool, fitTool, gridTool, edgesTool, perspectiveTool, othersTool, sketchesTool, sketchVisibilityTool] },
    { id: 'inspect', label: 'Inspect', icon: 'check', collapse: 1, tools: [checkTool, ...evaluateTools] },
    { id: 'history', label: 'History', icon: 'undo', tools: historyTools },
];

// Sketch mode. Selecting and leaving the sketch always stay on the bar; what is drawn, modified and constrained are
// groups of their own, so a narrow window turns each into a named menu instead of hiding every tool in one.
const SKETCH_ALWAYS = ['sk-select', 'sk-finish', 'sk-cancel'];
const SKETCH_SETUP = ['sk-options', 'sk-snaps'];
const sketchTools = (ids: string[]) => ids.flatMap((id) => sketchModeTools.filter((t) => t.id === id));

export const SKETCH_GROUPS: ToolGroup[] = [
    { id: 'sketch', label: 'Sketch', icon: 'sketch', tools: sketchTools(SKETCH_ALWAYS) },
    { id: 'draw', label: 'Draw', icon: 'line', collapse: 4,
        tools: sketchModeTools.filter((t) => !SKETCH_ALWAYS.includes(t.id) && !SKETCH_SETUP.includes(t.id)) },
    { id: 'modify', label: 'Modify', icon: 'trim', collapse: 2, tools: modifyTools },
    { id: 'constrain', label: 'Dimensions and relations', short: 'Relations', icon: 'dimension', collapse: 3, tools: constrainTools },
    { id: 'view', label: 'View and snaps', short: 'View', icon: 'views', collapse: 1,
        tools: [viewsTool, fitTool, perspectiveTool, othersTool, ...sketchTools(SKETCH_SETUP), ...sketchToggleTools, rapidSketchTool] },
    { id: '2d-to-3d', label: '2D to 3D', short: '2D to 3D', icon: 'add-front', collapse: 0, tools: twoDToThreeDTools },
    { id: 'history', label: 'History', icon: 'undo', tools: sketchHistoryTools },
];

export const ASSEMBLY_GROUPS: ToolGroup[] = [
    { id: 'insert', label: 'Insert', icon: 'box', collapse: 3, tools: [...primitiveTools, fastener, newPartTool] },
    { id: 'transform', label: 'Transform', icon: 'move', collapse: 4, tools: transformTools },
    { id: 'pattern', label: 'Pattern', icon: 'pattern', tools: [patternTool, explodeTool] },
    { id: 'material', label: 'Material', icon: 'material', tools: [materialTool, pictureTool] },
    { id: 'view', label: 'View', icon: 'views', collapse: 5, tools: [viewsTool, fitTool, gridTool, edgesTool, perspectiveTool, labelsTool] },
    { id: 'export', label: 'Export', icon: 'stl', collapse: 1, tools: exportTools },
    { id: 'history', label: 'History', icon: 'undo', tools: historyTools },
];

/** Every tool, including those only reached by editing or by the sketcher (finish, plane). */
export const ALL_TOOLS: ToolDef[] = [
    ...new Map([...PART_GROUPS, ...SKETCH_GROUPS, ...ASSEMBLY_GROUPS].flatMap((g) => g.tools).map((t) => [t.id, t])).values(),
    sketchPlaneTool,
    noEditTool,
    ...curveForms,
    dimensionForm,
    ...drawCommandForms,
    normalToTool,
];

/** The editor for a history item: a feature tool by op, or a create tool by the base body's shape kind. */
export function editorFor(part: Part, feature: Feature | null): ToolDef | 'sketch' {
    if (feature && (feature.op === 'extrude' || feature.op === 'revolve') && feature.sketchRef) {
        return solidTools.find((t) => t.id === (feature.op === 'revolve' ? 'revolve' : feature.mode === 'cut' ? 'cut' : 'extrude'))!;
    }
    if (feature?.op === 'pattern') {
        return patternEditor(feature);
    }
    if (feature?.op === 'combine' || feature?.op === 'split') {
        return feature.op === 'combine' ? combineTool : splitTool;
    }
    if (feature?.op === 'loft') {
        return feature.sections.every((s) => s.sketchRef) ? loftTool : noEditTool;
    }
    const reference = referenceEditor(feature);
    if (reference) {
        return reference;
    }
    if (feature?.op === 'sweep') {
        // The form edits sweeps of sketch steps; coils (helix paths) and inline sketches are Jarvis's.
        const path = 'helix' in feature.path ? null : feature.path;
        return path?.sketchRef && (!feature.profile || feature.profile.sketchRef) ? sweepTool : noEditTool;
    }
    if (feature ? feature.op === 'extrude' || feature.op === 'revolve' || feature.op === 'sketch' : part.shape.kind === 'sketch') {
        return 'sketch';
    }
    if (feature) {
        const tool = Object.values(featureTools).find((t) => t.op === feature.op);
        if (feature.op === 'cut' && feature.shape.kind !== 'box' && feature.shape.kind !== 'cylinder') {
            return noEditTool;
        }
        return tool ?? noEditTool;
    }
    return [...primitiveTools, fastener].find((t) => t.shapes?.includes(part.shape.kind)) ?? noEditTool;
}

export { sketchPlaneTool, finishTool };
