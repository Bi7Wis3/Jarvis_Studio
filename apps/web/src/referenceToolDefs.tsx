// Reference geometry tools of the part workspace: Plane, Axis and Point. Each makes a construction step (it builds
// no material) that sketches, revolves, patterns and other planes and axes use; each also edits its own steps.

import { useEffect, useState } from 'react';
import type { Feature, Vec3 } from '@jarvis/core';
import { nextFeatureName } from './featureNames';
import { runTool } from './state';
import { useSketcher } from './sketcher';
import {
    AXIS_KINDS, PLANE_KINDS, axisDefaults, axisDefinition, axisValues, checkReference, lineKey, planeDefaults, planeDefinition,
    planeValues, type RefValues,
} from './referenceDefs';
import type { Ctx, Field, PopupApi, Result, ToolDef, Values } from './toolDefs';

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

async function attempt(build: () => Promise<Result>): Promise<Result> {
    try {
        return await build();
    } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
}

/** The part's steps a new or edited reference step can use: those before it. */
function stepsBefore(ctx: Ctx): Feature[] {
    const features = ctx.part?.features ?? [];
    const at = ctx.edit?.feature ? features.findIndex((f) => f.id === ctx.edit!.feature!.id) : -1;
    return (at >= 0 ? features.slice(0, at) : features).filter((f) => !f.suppressed);
}

const ofOp = (steps: Feature[], op: Feature['op']) => steps.filter((f) => f.op === op).map((f) => ({ value: f.id, label: f.name ?? f.id }));

function planeOptions(steps: Feature[]) {
    return [...opts(['top', 'Top plane'], ['front', 'Front plane'], ['right', 'Right plane']), ...ofOp(steps, 'plane')];
}

function axisOptions(steps: Feature[], withOwn = false) {
    return [
        ...(withOwn ? opts(['u', 'Its horizontal axis (u)'], ['v', 'Its vertical axis (v)']) : []),
        ...opts(['x', 'X axis'], ['y', 'Y axis'], ['z', 'Z axis']),
        ...steps.filter((f) => f.op === 'axis').map((f) => ({ value: `axis:${f.id}`, label: f.name ?? f.id })),
    ];
}

/** A point field: a point step or coordinates. */
function pointFields(key: string, label: string, section: string, show: (v: Values) => boolean, steps: Feature[], onAxis = false): Field[] {
    return [
        { key: `${key}src`, label, kind: 'select', section, show,
            options: [...(onAxis ? opts(['axis', 'On the axis']) : []), ...opts(['xyz', 'Coordinates']), ...ofOp(steps, 'point')] },
        { key, label: 'At', kind: 'vec', unit: 'mm', section, show: (v) => show(v) && v[`${key}src`] === 'xyz' },
    ];
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

const edited = (ctx: Ctx, op: Feature['op']): Feature | null => (ctx.edit?.feature?.op === op ? ctx.edit.feature : null);

const NOTE = 'Or click planes, axes and points in the view.';

// ---- Plane --------------------------------------------------------------------------------------------------------

const planeTool: ToolDef = {
    id: 'plane',
    label: 'Plane',
    icon: 'ref-plane',
    op: 'plane',
    hint: 'a reference plane: offset, at an angle, mid plane, through points',
    needsPart: true,
    panel: true,
    width: 310,
    fields: (ctx) => {
        const steps = stepsBefore(ctx);
        const stored = edited(ctx, 'plane');
        const kinds = [...PLANE_KINDS, ...(stored?.op === 'plane' && stored.definition.kind === 'pointNormal'
            ? [['pointNormal', 'Point and normal'] as [string, string]] : [])];
        const is = (...k: string[]) => (v: Values) => k.includes(v.kind as string);
        return [
            { key: 'kind', label: 'Type', kind: 'select', options: opts(...kinds), section: 'Plane' },
            { key: 'base', label: 'Plane', kind: 'select', options: planeOptions(steps), section: 'First reference', show: is('offset', 'angle', 'parallel') },
            { key: 'distance', label: 'Distance', kind: 'number', unit: 'mm', min: 0, section: 'First reference', show: is('offset') },
            { key: 'about', label: 'Axis', kind: 'select', options: axisOptions(steps, true), section: 'Second reference', show: is('angle') },
            { key: 'angle', label: 'Angle', kind: 'number', unit: 'deg', section: 'First reference', show: is('angle') },
            { key: 'flip', label: 'Flip offset', kind: 'check', section: 'First reference', show: is('offset', 'angle') },
            ...(stored ? [] : [{ key: 'count', label: 'Number of planes', kind: 'number' as const, min: 1, step: 1, section: 'First reference',
                show: is('offset', 'angle') }]),
            { key: 'a', label: 'Plane', kind: 'select', options: planeOptions(steps), section: 'First reference', show: is('midplane') },
            { key: 'b', label: 'Plane', kind: 'select', options: planeOptions(steps), section: 'Second reference', show: is('midplane') },
            { key: 'axis', label: 'Axis', kind: 'select', options: axisOptions(steps), section: 'First reference', show: is('normal') },
            ...pointFields('np', 'Through', 'Second reference', is('normal'), steps, true),
            ...pointFields('p1', 'Point', 'First reference', is('threePoints', 'pointNormal'), steps),
            ...pointFields('p1', 'Point', 'Second reference', is('parallel'), steps),
            ...pointFields('p2', 'Point', 'Second reference', is('threePoints'), steps),
            ...pointFields('p3', 'Point', 'Third reference', is('threePoints'), steps),
            { key: 'normal', label: 'Normal', kind: 'vec', section: 'Second reference', show: is('pointNormal') },
        ];
    },
    defaults: (ctx) => {
        const stored = edited(ctx, 'plane');
        return stored?.op === 'plane' ? planeValues(stored.definition) : planeDefaults();
    },
    top: () => <p className="tb-note">{NOTE}</p>,
    apply: (v, ctx) => attempt(async () => {
        const steps = stepsBefore(ctx);
        const count = !ctx.edit && (v.kind === 'offset' || v.kind === 'angle') ? Math.round(Number(v.count) || 1) : 1;
        if (count < 1 || count > 50) {
            throw new Error('Number of planes must be 1 to 50.');
        }
        const definitions = Array.from({ length: count }, (_, i) => planeDefinition(v as RefValues, i + 1));
        definitions.forEach((d) => checkReference('plane', d, steps));
        if (count === 1 || !ctx.part) {
            return saveStep(ctx, { op: 'plane', definition: definitions[0] });
        }
        // Several planes, each the next step from the same reference (SolidWorks' Number of planes).
        const named: Pick<Feature, 'name'>[] = [...(ctx.part.features ?? [])];
        const features = definitions.map((definition) => {
            const name = nextFeatureName(named, { op: 'plane' });
            named.push({ name });
            return { op: 'plane', name, definition };
        });
        return runTool('features_add', { partId: ctx.part.id, features });
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
    hint: 'a reference axis: a sketch line, two planes, two points, point and plane',
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
        return [
            { key: 'kind', label: 'Type', kind: 'select', options: opts(...kinds), section: 'Axis' },
            { key: 'sketch', label: 'Sketch', kind: 'select', options: sketches.map((f) => ({ value: f.id, label: f.name ?? f.id })),
                section: 'Selections', show: is('sketchLine') },
            // One line field per sketch step, shown for the chosen sketch.
            ...sketches.map((s): Field => ({
                key: lineKey(s.id), label: 'Line', kind: 'select', options: lineOptions(s), section: 'Selections',
                show: (v) => v.kind === 'sketchLine' && v.sketch === s.id,
            })),
            { key: 'a', label: 'Plane', kind: 'select', options: planeOptions(steps), section: 'Selections', show: is('planeIntersection') },
            { key: 'b', label: 'Plane', kind: 'select', options: planeOptions(steps), section: 'Selections', show: is('planeIntersection') },
            ...pointFields('p1', 'Point', 'Selections', is('twoPoints', 'pointPlane', 'pointDirection'), steps),
            ...pointFields('p2', 'Point', 'Selections', is('twoPoints'), steps),
            { key: 'plane', label: 'Plane', kind: 'select', options: planeOptions(steps), section: 'Selections', show: is('pointPlane') },
            { key: 'direction', label: 'Direction', kind: 'vec', section: 'Selections', show: is('pointDirection') },
        ];
    },
    defaults: (ctx) => {
        const stored = edited(ctx, 'axis');
        if (stored?.op === 'axis') {
            return axisValues(stored.definition);
        }
        const sketches = sketchStepsOf(stepsBefore(ctx));
        const values: Values = { ...axisDefaults(), sketch: sketches[sketches.length - 1]?.id ?? '' };
        for (const s of sketches) {
            values[lineKey(s.id)] = lineOptions(s)[0]?.value ?? '';
        }
        if (!sketches.length) {
            values.kind = 'planeIntersection';
        }
        return values;
    },
    top: () => <p className="tb-note">{NOTE} For a line, click it in its sketch.</p>,
    extra: (api) => <SketchPick api={api} />,
    apply: (v, ctx) => attempt(async () => {
        const definition = axisDefinition(v as RefValues);
        checkReference('axis', definition, stepsBefore(ctx));
        return saveStep(ctx, { op: 'axis', definition });
    }),
};

// ---- Point --------------------------------------------------------------------------------------------------------

function readVec(v: Values, key: string): Vec3 {
    return [0, 1, 2].map((i) => {
        const raw = v[`${key}${i}`];
        const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        if (!Number.isFinite(n)) {
            throw new Error(`${'XYZ'[i]} must be a number.`);
        }
        return n;
    }) as Vec3;
}

const pointTool: ToolDef = {
    id: 'point',
    label: 'Point',
    icon: 'ref-point',
    op: 'point',
    hint: 'a reference point at coordinates',
    needsPart: true,
    panel: true,
    width: 290,
    fields: () => [{ key: 'pos', label: 'At', kind: 'vec', unit: 'mm', section: 'Point' }],
    defaults: (ctx) => {
        const stored = edited(ctx, 'point');
        const p: Vec3 = stored?.op === 'point' ? stored.position : [0, 0, 0];
        return Object.fromEntries(p.map((c, i) => [`pos${i}`, String(Math.round(c * 100) / 100)]));
    },
    apply: (v, ctx) => attempt(async () => saveStep(ctx, { op: 'point', position: readVec(v, 'pos') })),
};

export const referenceTools: ToolDef[] = [planeTool, axisTool, pointTool];

/** The editor of a reference step, if it is one. */
export function referenceEditor(feature: Feature | null): ToolDef | null {
    return referenceTools.find((t) => t.op === feature?.op) ?? null;
}
