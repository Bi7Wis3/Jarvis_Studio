// Reference geometry tools of the part workspace: Plane, Axis and Point, as SolidWorks' PropertyManagers. Each makes
// a construction step (it builds no material) that sketches, revolves, patterns and other planes and axes use; each
// also edits its own steps. References are clicked in the view (faces, edges, vertices, planes, axes, points) or
// chosen from a list; see referenceDefs.ts.

import { useEffect, useState } from 'react';
import type { Feature } from '@jarvis/core';
import { nextFeatureName } from './featureNames';
import { usePickSession } from './pickField';
import { runTool } from './state';
import { useSketcher } from './sketcher';
import {
    AXIS_KINDS, PLANE_BOXES, PLANE_CONSTRAINTS, POINT_KINDS, axisAccept, axisDefaults, axisDefinition, axisValues, boxListPatch,
    checkReference, lineKey, planeAccept, planeAngleAxisPatch, planeAutoPatch, planeCount, planeDefaults, planeDefinition, planeValues, pointAccept,
    pointDefaults, pointPositions, pointSteps, pointValues, referenceStatus, refOptions, slotClass, stepsBefore, type PlaneClass, type RefKind,
    type RefValues,
} from './referenceDefs';
import type { Ctx, Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { helixTool } from './helixToolDef';
import { curveOptions } from './curvePicks';

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

async function attempt(build: () => Promise<Result>): Promise<Result> {
    try {
        return await build();
    } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
}

/** Adds the step, or updates the edited one in place (keeping its id and name). */
function saveStep(ctx: Ctx, feature: Record<string, unknown>): Promise<Result> {
    if (ctx.edit?.feature) {
        const { op: _op, ...fields } = feature;
        return runTool('features_update', { partId: ctx.edit.partId, updates: [{ id: ctx.edit.feature.id, ...fields }] });
    }
    if (!ctx.part) {
        return Promise.resolve({ text: 'Select a part first.', isError: true });
    }
    return runTool('features_add', { partId: ctx.part.id, features: [{ ...feature, name: nextFeatureName(ctx.part.features, { op: feature.op as Feature['op'] }) }] });
}

/** Adds several steps of one kind in order (Number of planes, Number of points). */
function saveSteps(ctx: Ctx, op: Feature['op'], list: Record<string, unknown>[]): Promise<Result> {
    if (list.length === 1 || !ctx.part || ctx.edit) {
        return saveStep(ctx, { op, ...list[0] });
    }
    const named: Pick<Feature, 'name'>[] = [...(ctx.part.features ?? [])];
    const features = list.map((fields) => {
        const name = nextFeatureName(named, { op });
        named.push({ name });
        return { op, name, ...fields };
    });
    return runTool('features_add', { partId: ctx.part.id, features });
}

const edited = (ctx: Ctx, op: Feature['op']): Feature | null => (ctx.edit?.feature?.op === op ? ctx.edit.feature : null);

/**
 * A reference box: the selection list (clicks in the view), the same choice from a list, and coordinates when the
 * list says Coordinates (click them, then in the view, to place the point there).
 */
function refBox(key: string, label: string, section: string, show: (v: Values) => boolean, steps: Feature[],
    entities: Field['entities'], kinds: RefKind[], accept: Field['accept'], ownAxes = false): Field[] {
    return [
        { key, label, kind: 'pick', entities, section, show, accept },
        ...(kinds.length ? [{ key: `${key}list`, label: 'Or choose', kind: 'select' as const, options: refOptions(kinds, steps, ownAxes), section, show }] : []),
        ...(kinds.includes('point') ? [{
            key: `${key}p`, label: 'At', kind: 'vec' as const, unit: 'mm', section, pickable: true,
            show: (v: Values) => show(v) && v[`${key}list`] === 'xyz',
        }] : []),
    ];
}

/** Keeps a box and its list in step; `more` adds a tool's own reaction to a box change. */
function boxChange(more?: (box: string, v: RefValues) => RefValues) {
    return (key: string, v: Values, ctx: Ctx): Values => {
        const patch = boxListPatch(key, v as RefValues, stepsBefore(ctx)) ?? {};
        const box = key.endsWith('list') ? key.slice(0, -4) : key;
        const extra = more && (key.endsWith('list') || `${key}list` in v) ? more(box, { ...v, ...patch } as RefValues) : {};
        return { ...patch, ...extra } as Values;
    };
}

/** The message at the top: whether the reference is fully defined, else what it still needs. */
function Status({ op, api, ctx }: { op: 'plane' | 'axis'; api: PopupApi; ctx: Ctx }) {
    const status = referenceStatus(op, api.values as RefValues, stepsBefore(ctx));
    return <p className={`tb-note pm-status ${status.ok ? 'ok' : 'error'}`} role="status">{status.text}</p>;
}

// ---- Plane --------------------------------------------------------------------------------------------------------

const REF_WORDS = ['First reference', 'Second reference', 'Third reference'];
const ALL_ENTITIES: Field['entities'] = ['face', 'edge', 'vertex', 'ref'];

function planeSlotFields(k: number, steps: Feature[], stored: boolean): Field[] {
    const section = REF_WORDS[k - 1];
    const always = () => true;
    const is = (cls: PlaneClass) => (v: Values) => slotClass(v as RefValues, k) === cls;
    const c = (v: Values, cls: PlaneClass) => (slotClass(v as RefValues, k) === cls ? v[`c${k}${cls}`] : null);
    const constraint = (cls: PlaneClass): Field => ({
        key: `c${k}${cls}`, label: 'Constraint', kind: 'select', options: opts(...PLANE_CONSTRAINTS[cls]), section, show: is(cls),
    });
    return [
        ...refBox(`r${k}`, 'Reference', section, always, steps, ALL_ENTITIES, ['plane', 'line', 'point', 'curve'], planeAccept, k > 1),
        constraint('plane'), constraint('line'), constraint('point'), constraint('cyl'), constraint('curve'),
        { key: `d${k}`, label: 'Distance', kind: 'number', unit: 'mm', min: 0, section, show: (v) => c(v, 'plane') === 'offset' },
        { key: `a${k}`, label: 'Angle', kind: 'number', unit: 'deg', section, show: (v) => c(v, 'plane') === 'angle' },
        { key: `f${k}`, label: 'Flip offset', kind: 'check', section, show: (v) => c(v, 'plane') === 'offset' || c(v, 'plane') === 'angle' },
        { key: `f${k}`, label: 'Other side', kind: 'check', section, show: (v) => c(v, 'cyl') === 'tangent' },
        ...(stored ? [] : [{
            key: `n${k}`, label: 'Number of planes', kind: 'number' as const, min: 1, step: 1, section,
            show: (v: Values) => c(v, 'plane') === 'offset' || c(v, 'plane') === 'angle',
        }]),
    ];
}

const planeTool: ToolDef = {
    id: 'plane',
    label: 'Plane',
    icon: 'ref-plane',
    op: 'plane',
    hint: 'a reference plane from faces, edges, vertices, planes, axes and points: offset, at angle, mid plane, through points',
    needsPart: true,
    panel: true,
    width: 310,
    fields: (ctx) => {
        const steps = stepsBefore(ctx);
        const stored = !!edited(ctx, 'plane');
        return [
            ...planeSlotFields(1, steps, stored),
            ...planeSlotFields(2, steps, stored),
            ...planeSlotFields(3, steps, stored),
            { key: 'nv', label: 'Normal', kind: 'vec', section: 'First reference', show: (v) => !!v.pn },
            { key: 'flipNormal', label: 'Flip normal', kind: 'check', section: 'Options' },
            // SolidWorks' Set origin on curve, for a plane perpendicular to a curve through a point off it.
            { key: 'originOnCurve', label: 'Set origin on curve', kind: 'check', section: 'Options',
                show: (v) => [1, 2, 3].some((k) => slotClass(v as RefValues, k) === 'curve') },
        ];
    },
    defaults: (ctx) => {
        const stored = edited(ctx, 'plane');
        return (stored?.op === 'plane' ? planeValues(stored.definition, stepsBefore(ctx)) : planeDefaults()) as Values;
    },
    onChange: (key, v, ctx) => {
        const patch = boxChange((box, values) => (PLANE_BOXES.includes(box) ? planeAutoPatch(box, values) : {}))(key, v, ctx);
        // At angle with nothing to turn about yet: the plane's own axis, shown in the next box.
        return { ...patch, ...planeAngleAxisPatch(key, { ...v, ...patch } as RefValues, stepsBefore(ctx)) } as Values;
    },
    top: (api, ctx) => <Status op="plane" api={api} ctx={ctx} />,
    apply: (v, ctx) => attempt(async () => {
        const steps = stepsBefore(ctx);
        const count = ctx.edit ? 1 : planeCount(v as RefValues);
        if (count < 1 || count > 50) {
            throw new Error('Number of planes must be 1 to 50.');
        }
        const definitions = Array.from({ length: count }, (_, i) => planeDefinition(v as RefValues, i + 1));
        definitions.forEach((d) => checkReference('plane', d, steps));
        // Several planes, each the next step from the same reference (SolidWorks' Number of planes).
        return saveSteps(ctx, 'plane', definitions.map((definition) => ({ definition })));
    }),
};

// ---- Axis ---------------------------------------------------------------------------------------------------------

/** Keeps the Axis form's sketch in step with a sketch clicked in the view. */
function SketchPick({ api }: { api: PopupApi }) {
    const picked = useSketcher((s) => s.picked);
    const [seen] = useState(() => picked?.n ?? 0);
    useEffect(() => {
        if (picked && picked.n > seen && api.values.sketch !== picked.id) {
            api.set({ sketch: picked.id });
        }
    }, [picked?.n]);
    return null;
}

function lineOptions(step: Extract<Feature, { op: 'sketch' }>) {
    let centre = 0;
    let line = 0;
    return (step.sketch.geometry?.curves ?? []).flatMap((c) => (c.kind === 'line'
        ? [{ value: c.id, label: c.construction ? `Centreline ${++centre}` : `Line ${++line}` }] : []));
}

const sketchStepsOf = (steps: Feature[]) => steps.filter((f): f is Extract<Feature, { op: 'sketch' }> => f.op === 'sketch');

const axisTool: ToolDef = {
    id: 'axis',
    label: 'Axis',
    icon: 'ref-axis',
    op: 'axis',
    hint: 'a reference axis: an edge, a cylindrical face, two planes, two points, point and face, a sketch line',
    needsPart: true,
    panel: true,
    width: 310,
    fields: (ctx) => {
        const steps = stepsBefore(ctx);
        const stored = edited(ctx, 'axis');
        const kinds = [...AXIS_KINDS, ...(stored?.op === 'axis' && stored.definition.kind === 'pointDirection'
            ? [['pointDirection', 'Point and direction'] as [string, string]] : [])];
        const is = (...k: string[]) => (v: Values) => k.includes(v.kind as string);
        const sketches = sketchStepsOf(steps);
        const section = 'Selections';
        return [
            { key: 'kind', label: 'Type', kind: 'select', options: opts(...kinds), section },
            ...refBox('ln', 'Line, edge or axis', section, is('along'), steps, ['edge', 'face', 'ref'], ['line'], axisAccept('ln')),
            ...refBox('cy', 'Cylindrical or conical face', section, is('cylinder'), steps, ['face', 'ref'], [], axisAccept('cy')),
            ...refBox('pa', 'Plane or face', section, is('planeIntersection', 'pointPlane'), steps, ['face', 'ref'], ['plane'], axisAccept('pa')),
            ...refBox('pb', 'Plane or face', section, is('planeIntersection'), steps, ['face', 'ref'], ['plane'], axisAccept('pb')),
            ...refBox('qa', 'Point or vertex', section, is('twoPoints', 'pointPlane', 'pointDirection'), steps, ['edge', 'vertex', 'ref'], ['point'], axisAccept('qa')),
            ...refBox('qb', 'Point or vertex', section, is('twoPoints'), steps, ['edge', 'vertex', 'ref'], ['point'], axisAccept('qb')),
            { key: 'sketch', label: 'Sketch', kind: 'select', options: sketches.map((f) => ({ value: f.id, label: f.name ?? f.id })),
                section, show: is('sketchLine') },
            // One line field per sketch step, shown for the chosen sketch.
            ...sketches.map((s): Field => ({
                key: lineKey(s.id), label: 'Line', kind: 'select', options: lineOptions(s), section,
                show: (v) => v.kind === 'sketchLine' && v.sketch === s.id,
            })),
            { key: 'direction', label: 'Direction', kind: 'vec', section, show: is('pointDirection') },
        ];
    },
    defaults: (ctx) => {
        const stored = edited(ctx, 'axis');
        if (stored?.op === 'axis') {
            return axisValues(stored.definition, stepsBefore(ctx)) as Values;
        }
        const sketches = sketchStepsOf(stepsBefore(ctx));
        const values = { ...axisDefaults(), sketch: sketches[sketches.length - 1]?.id ?? '' } as Values;
        for (const s of sketches) {
            values[lineKey(s.id)] = lineOptions(s)[0]?.value ?? '';
        }
        return values;
    },
    onChange: boxChange(),
    top: (api, ctx) => <Status op="axis" api={api} ctx={ctx} />,
    extra: (api) => <SketchPick api={api} />,
    apply: (v, ctx) => attempt(async () => {
        const definition = axisDefinition(v as RefValues);
        checkReference('axis', definition, stepsBefore(ctx));
        return saveStep(ctx, { op: 'axis', definition });
    }),
};

// ---- Point --------------------------------------------------------------------------------------------------------

/**
 * With Coordinates, a click in the view places the point (pickView: a face where hit, an edge's end, middle or
 * circle centre when near): the coordinates are the active target from the start, and again after each click.
 */
function PlaceOnClick({ api }: { api: PopupApi }) {
    const active = usePickSession((s) => s.active);
    const boxes = usePickSession((s) => s.boxes);
    const placing = api.values.kind === 'xyz';
    useEffect(() => {
        if (placing && active === null && boxes.some((b) => b.key === 'pos')) {
            usePickSession.setState({ active: 'pos', note: null });
        }
    }, [placing, active, boxes]);
    return placing ? <p className="tb-note tb-hint">Click in the view to place the point, or drag its arrows.</p> : null;
}

const pointTool: ToolDef = {
    id: 'point',
    label: 'Point',
    icon: 'ref-point',
    op: 'point',
    hint: 'a reference point: placed by a click, coordinates, arc centre, centre of face, a vertex, an intersection, along an edge',
    needsPart: true,
    panel: true,
    width: 300,
    fields: (ctx) => {
        const is = (...k: string[]) => (v: Values) => k.includes(v.kind as string);
        const section = 'Selections';
        // Helix and spiral steps before this one: their ends (On point) and the curves (Along curve), also from a list.
        const ends = curveOptions(stepsBefore(ctx), true);
        const curves = curveOptions(stepsBefore(ctx), false);
        const choose = (key: string, kind: string, list: { value: string; label: string }[]): Field[] => (list.length ? [{
            key: `${key}list`, label: 'Or choose', kind: 'select', options: [{ value: '', label: 'Picked in the view' }, ...list], section, show: is(kind),
        }] : []);
        const box = (key: string, label: string, kind: string, entities: Field['entities']): Field => ({
            key, label, kind: 'pick', entities, section, show: is(kind), accept: pointAccept(key),
        });
        return [
            { key: 'kind', label: 'Type', kind: 'select', options: opts(...POINT_KINDS), section },
            { key: 'pos', label: 'At', kind: 'vec', unit: 'mm', section, show: is('xyz'), pickable: true },
            box('arc', 'Circular edge', 'arcCentre', ['edge', 'ref']),
            box('fc', 'Face', 'faceCentre', ['face', 'ref']),
            box('vx', 'Vertex', 'vertex', ['edge', 'vertex', 'ref']),
            ...choose('vx', 'vertex', ends),
            box('e1', 'First edge', 'intersection', ['edge', 'ref']),
            box('e2', 'Second edge', 'intersection', ['edge', 'ref']),
            box('ed', 'Edge', 'along', ['edge', 'ref']),
            ...choose('ed', 'along', curves),
            { key: 'by', label: 'Spacing', kind: 'select', options: opts(['distance', 'Distance'], ['percent', 'Percentage']), section, show: is('along') },
            { key: 'amount', label: 'Distance', kind: 'number', unit: 'mm', min: 0, section, show: (v) => v.kind === 'along' && v.by !== 'percent' },
            { key: 'amount', label: 'Percentage', kind: 'number', unit: '%', min: 0, section, show: (v) => v.kind === 'along' && v.by === 'percent' },
            ...(edited(ctx, 'point') ? [] : [{ key: 'count', label: 'Number of points', kind: 'number' as const, min: 1, step: 1, section, show: is('along') }]),
            { key: 'reverse', label: 'From the other end', kind: 'check', section, show: is('along') },
        ];
    },
    defaults: (ctx) => {
        const stored = edited(ctx, 'point');
        return (stored?.op === 'point' ? pointValues(stored, stepsBefore(ctx)) : pointDefaults()) as Values;
    },
    onChange: boxChange(),
    top: (api, ctx) => {
        try {
            pointPositions(api.values as RefValues, stepsBefore(ctx));
            return <p className="tb-note pm-status ok" role="status">Fully defined</p>;
        } catch (e) {
            return <p className="tb-note pm-status error" role="status">{e instanceof Error ? e.message : String(e)}</p>;
        }
    },
    extra: (api) => <PlaceOnClick api={api} />,
    apply: (v, ctx) => attempt(async () => {
        // A point taken from the model keeps how it was taken, so it follows the model; null drops an older one's.
        const steps = pointSteps(v as RefValues, !!ctx.edit, stepsBefore(ctx));
        return saveSteps(ctx, 'point', steps.map((s) => (ctx.edit && !s.definition ? { ...s, definition: null } : s)));
    }),
};

export const referenceTools: ToolDef[] = [planeTool, axisTool, pointTool, helixTool];

/** The editor of a reference step, if it is one. */
export function referenceEditor(feature: Feature | null): ToolDef | null {
    return referenceTools.find((t) => t.op === feature?.op) ?? null;
}
