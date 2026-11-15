// Options > Defaults: the values new tool forms start with. Each entry names a tool and the fields of its own form that
// can be given a default; the labels, choices and units come from the tool itself, so the page matches the form.

import type { ToolDefaultValue } from '@jarvis/core/settings';
import { ALL_TOOLS, type Ctx, type Field, type ToolDef, type Values } from './toolDefs';
import { SKETCH_TOOL_DEFAULTS } from './optionsSync';

export interface DefaultsTool {
    id: string;
    label: string;
    /** Field keys of the tool's form that take a default. */
    keys: string[];
}

export const DEFAULTS_TOOLS: DefaultsTool[] = [
    // `through` has no field: the form keeps it in step with the end condition, and so does this page.
    { id: 'extrude', label: 'Extrude', keys: ['direction', 'end', 'through', 'distance', 'draft', 'draftAngle', 'draftOutward'] },
    // A cut's direction is not given a default: it follows the sketch (into the part).
    { id: 'cut', label: 'Cut', keys: ['end', 'through', 'distance', 'draft', 'draftAngle', 'draftOutward'] },
    { id: 'revolve', label: 'Revolve', keys: ['revolveType', 'angle'] },
    { id: 'fillet', label: 'Fillet', keys: ['tangent', 'edges', 'r'] },
    { id: 'chamfer', label: 'Chamfer', keys: ['type', 'tangent', 'edges', 's', 'd2', 'angle'] },
    { id: 'shell', label: 'Shell', keys: ['t', 'outward'] },
    { id: 'draft', label: 'Draft', keys: ['angle', 'propagation'] },
    { id: 'hole', label: 'Hole', keys: ['kind', 'size', 'diameter', 'fit', 'through', 'depth'] },
    { id: 'thread', label: 'Thread', keys: ['end', 'length', 'revolutions', 'kind', 'size', 'diameter', 'pitch', 'method', 'hand', 'starts', 'trimStart', 'trimEnd'] },
    { id: 'linear-pattern', label: 'Linear pattern', keys: ['spacing', 'count', 'two', 'spacing2', 'count2'] },
    { id: 'circular-pattern', label: 'Circular pattern', keys: ['equal', 'total', 'step', 'count'] },
    { id: SKETCH_TOOL_DEFAULTS, label: 'Sketch tools', keys: ['filletRadius', 'chamferDistance', 'sides'] },
];

const NO_CTX: Ctx = { part: null, project: null, edit: null };

/** The sketch tools' sizes, which the sketcher keeps itself (they are its starting values). */
const SKETCH_FIELDS: Field[] = [
    { key: 'filletRadius', label: 'Sketch fillet radius', kind: 'number', unit: 'mm', min: 0, step: 0.5 },
    { key: 'chamferDistance', label: 'Sketch chamfer distance', kind: 'number', unit: 'mm', min: 0, step: 0.5 },
    { key: 'sides', label: 'Polygon sides', kind: 'number', min: 3, max: 40, step: 1 },
];
const SKETCH_BUILT_IN: Values = { filletRadius: '5', chamferDistance: '2', sides: '6' };

const toolOf = (id: string): ToolDef | undefined => ALL_TOOLS.find((t) => t.id === id);

const KINDS: Field['kind'][] = ['number', 'text', 'select', 'check'];

/** The tool's own defaults for a new form, and the fields a default can be set for (in the form's order). */
export function defaultsOf(id: string): { fields: Field[]; builtIn: Values } {
    if (id === SKETCH_TOOL_DEFAULTS) {
        return { fields: SKETCH_FIELDS, builtIn: SKETCH_BUILT_IN };
    }
    const entry = DEFAULTS_TOOLS.find((t) => t.id === id);
    const tool = toolOf(id);
    if (!entry || !tool) {
        return { fields: [], builtIn: {} };
    }
    let builtIn: Values = {};
    let all: Field[] = [];
    try {
        builtIn = tool.defaults?.(NO_CTX) ?? {};
        all = tool.fields?.(NO_CTX) ?? [];
    } catch {
        return { fields: [], builtIn: {} };
    }
    // A key can have two fields (shown for different choices, as Distance and Distance 1): the first shown wins.
    const fields = all.filter((f) => entry.keys.includes(f.key) && KINDS.includes(f.kind) && f.key in builtIn);
    return { fields, builtIn: Object.fromEntries(entry.keys.filter((k) => k in builtIn).map((k) => [k, builtIn[k]])) };
}

/** The fields to show for these values: the ones the tool's form would show, one per key. */
export function shownDefaults(fields: Field[], values: Values): Field[] {
    const seen = new Set<string>();
    return fields.filter((f) => {
        if (seen.has(f.key) || (f.show && !f.show(values))) {
            return false;
        }
        seen.add(f.key);
        return true;
    });
}

/** The values the page shows: the tool's own, with the saved ones over them. */
export function defaultsValues(id: string, saved: Record<string, ToolDefaultValue> | undefined): Values {
    const { builtIn } = defaultsOf(id);
    const out: Values = { ...builtIn };
    for (const [key, value] of Object.entries(saved ?? {})) {
        if (key in builtIn && typeof builtIn[key] === typeof value) {
            out[key] = value;
        }
    }
    return out;
}

/** One value changed, followed by what the tool's form changes with it (a thread size sets its pitch). */
export function changeDefault(id: string, values: Values, key: string, value: Values[string]): Values {
    const next = { ...values, [key]: value };
    const follow = toolOf(id)?.onChange?.(key, next, NO_CTX) ?? undefined;
    const { builtIn } = defaultsOf(id);
    // Only what the page holds: the form's other values (a position, picks) are not defaults.
    const kept = Object.fromEntries(Object.entries(follow ?? {}).filter(([k]) => k in builtIn));
    return { ...next, ...kept };
}

/** What is kept in the settings: the values that differ from the tool's own. */
export function savedDefaults(id: string, values: Values): Record<string, ToolDefaultValue> {
    const { builtIn } = defaultsOf(id);
    return Object.fromEntries(Object.entries(values).filter(([key, value]) =>
        key in builtIn && (typeof value === 'string' || typeof value === 'boolean') && value !== builtIn[key])) as Record<string, ToolDefaultValue>;
}

/** Why the values cannot be saved (a number that is not one, or out of the field's range), or null. */
export function checkDefaults(id: string, values: Values): string | null {
    const entry = DEFAULTS_TOOLS.find((t) => t.id === id);
    for (const field of defaultsOf(id).fields) {
        if (field.kind !== 'number') {
            continue;
        }
        const text = String(values[field.key] ?? '');
        const n = Number(text);
        if (text.trim() === '' || !Number.isFinite(n)) {
            return `${entry?.label ?? id}: ${field.label} must be a number.`;
        }
        if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
            const range = field.max === undefined ? `at least ${field.min}` : field.min === undefined ? `at most ${field.max}` : `${field.min} to ${field.max}`;
            return `${entry?.label ?? id}: ${field.label} must be ${range}.`;
        }
    }
    return null;
}
