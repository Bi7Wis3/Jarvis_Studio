// Part-workspace feature patterns (SolidWorks Linear Pattern and Circular Pattern), kept apart from toolDefs.tsx.
// The whole-part repeat in the assembly is the separate "Component pattern" tool.

import type { Feature, Part } from '@jarvis/core';
import { useStudio } from './state';
import { stepAtBar } from './historyOps';
import {
    axisOptions, axisValue, CIRCULAR_DEFAULTS, circularFeature, circularValues, LINEAR_DEFAULTS, linearFeature, linearValues,
    patternableSteps, withoutNulls,
} from './patternForm';
import { attempt, fullPart, saveFeature, type Ctx, type Field, type ToolDef } from './toolDefs';

/** The part's whole history, and the step new choices must come before: the edited step, or the rollback bar. */
function scope(ctx: Ctx): { features: Feature[]; upto?: string } {
    const id = ctx.edit?.partId ?? ctx.part?.id;
    const part: Part | null | undefined = id ? fullPart(id) ?? ctx.part : ctx.part;
    const upto = ctx.edit?.feature?.id ?? (id ? stepAtBar(useStudio.getState().history, id) ?? undefined : undefined);
    return { features: part?.features ?? [], upto };
}

type Pattern<K> = Extract<Feature, { op: 'pattern'; kind: K }>;

function edited<K extends 'linear' | 'circular'>(ctx: Ctx, kind: K): Pattern<K> | null {
    const f = ctx.edit?.feature;
    return f?.op === 'pattern' && f.kind === kind ? (f as Pattern<K>) : null;
}

function featureOptions(ctx: Ctx) {
    const { features, upto } = scope(ctx);
    return patternableSteps(features, upto).map((f) => ({ value: f.id, label: f.name ?? f.id }));
}

/** The latest step that can be patterned, picked for a new pattern. */
function lastStep(ctx: Ctx): string[] {
    const options = featureOptions(ctx);
    return options.length ? [options[options.length - 1].value] : [];
}

const NOTE = 'Directions come from the part\'s X, Y and Z axes or an axis step. Picking an edge or face in the view '
    + 'comes with selection boxes.';
const SKIP_NOTE = 'Instance numbers along direction 1, from 1 (the seed): 3, 5. In a grid: 2:3.';

function save(ctx: Ctx, feature: Record<string, unknown>) {
    return saveFeature(ctx, ctx.edit?.feature ? feature : withoutNulls(feature));
}

export const linearPatternTool: ToolDef = {
    id: 'linear-pattern',
    preview: true,
    label: 'Linear pattern',
    icon: 'pattern',
    op: 'pattern',
    hint: 'repeat features in one or two directions',
    needsPart: true,
    width: 310,
    fields: (ctx) => {
        const { features, upto } = scope(ctx);
        const f = edited(ctx, 'linear');
        const dirs = axisOptions(features, upto, f ? axisValue(f.direction) : undefined);
        const dirs2 = axisOptions(features, upto, f ? axisValue(f.direction2) : undefined);
        const two = (v: Record<string, unknown>) => !!v.two;
        const list: Field[] = [
            { key: 'dir', label: 'Pattern direction', kind: 'select', options: dirs, section: 'Direction 1' },
            { key: 'rev', label: 'Reverse direction', kind: 'check', section: 'Direction 1' },
            { key: 'spacing', label: 'Spacing', kind: 'number', unit: 'mm', section: 'Direction 1' },
            { key: 'count', label: 'Number of instances', kind: 'number', min: 2, step: 1, section: 'Direction 1' },
            { key: 'two', label: 'Direction 2', kind: 'check', section: 'Direction 2' },
            { key: 'dir2', label: 'Pattern direction', kind: 'select', options: dirs2, show: two, section: 'Direction 2' },
            { key: 'rev2', label: 'Reverse direction', kind: 'check', show: two, section: 'Direction 2' },
            { key: 'spacing2', label: 'Spacing', kind: 'number', unit: 'mm', show: two, section: 'Direction 2' },
            { key: 'count2', label: 'Number of instances', kind: 'number', min: 2, step: 1, show: two, section: 'Direction 2' },
            { key: 'seedOnly2', label: 'Pattern seed only', kind: 'check', show: two, section: 'Direction 2' },
            { key: 'features', label: 'Features to pattern', kind: 'multi', options: featureOptions(ctx), section: 'Features to pattern' },
            { key: 'skip', label: 'Instances to skip', kind: 'text', section: 'Instances to skip' },
        ];
        return list;
    },
    defaults: (ctx) => {
        const f = edited(ctx, 'linear');
        return f ? linearValues(f) : { ...LINEAR_DEFAULTS, features: lastStep(ctx) };
    },
    top: () => <p className="tb-note">{NOTE}</p>,
    extra: () => <p className="tb-note">{SKIP_NOTE}</p>,
    apply: (v, ctx) => attempt(() => save(ctx, linearFeature(v))),
};

export const circularPatternTool: ToolDef = {
    id: 'circular-pattern',
    preview: true,
    label: 'Circular pattern',
    icon: 'pattern-circular',
    op: 'pattern',
    hint: 'repeat features around an axis',
    needsPart: true,
    width: 310,
    fields: (ctx) => {
        const { features, upto } = scope(ctx);
        // An axis, not a vector: the rotation needs a point to turn about.
        const axes = axisOptions(features, upto);
        const equal = (v: Record<string, unknown>) => !!v.equal;
        return [
            { key: 'axis', label: 'Pattern axis', kind: 'select', options: axes, section: 'Direction 1' },
            { key: 'rev', label: 'Reverse direction', kind: 'check', section: 'Direction 1' },
            { key: 'equal', label: 'Equal spacing', kind: 'check', section: 'Direction 1' },
            { key: 'total', label: 'Total angle', kind: 'number', unit: '°', show: equal, section: 'Direction 1' },
            { key: 'step', label: 'Angle', kind: 'number', unit: '°', show: (v) => !equal(v), section: 'Direction 1' },
            { key: 'count', label: 'Number of instances', kind: 'number', min: 2, step: 1, section: 'Direction 1' },
            { key: 'features', label: 'Features to pattern', kind: 'multi', options: featureOptions(ctx), section: 'Features to pattern' },
            { key: 'skip', label: 'Instances to skip', kind: 'text', section: 'Instances to skip' },
        ];
    },
    defaults: (ctx) => {
        const f = edited(ctx, 'circular');
        return f ? { ...circularValues(f), kind: 'circular' } : { ...CIRCULAR_DEFAULTS, kind: 'circular', features: lastStep(ctx) };
    },
    onChange: (key, v) => (key === 'equal' && v.equal ? { total: '360' } : undefined),
    top: () => <p className="tb-note">The axis is the part's X, Y or Z axis or an axis step. Picking an edge or face in the view comes with selection boxes.</p>,
    extra: () => <p className="tb-note">Instance numbers from 1 (the seed): 3, 5.</p>,
    apply: (v, ctx) => attempt(() => save(ctx, circularFeature(v))),
};

/** The editor for a pattern step. */
export function patternEditor(feature: Extract<Feature, { op: 'pattern' }>): ToolDef {
    return feature.kind === 'circular' ? circularPatternTool : linearPatternTool;
}
