// The Helix/Spiral form's values (SolidWorks' Helix/Spiral PropertyManager) and the step they make; also what the
// Sweep form needs to take a helix or spiral as its path. Pure, so the form, the view's preview and tests share it.

import type { Feature, Part } from '@jarvis/core';
import {
    helixCircle, helixLength, helixRows, helixShape, helixSketchOf, type HelixDefinedBy, type HelixOptions, type HelixRow, type HelixShape,
    type HelixStep,
} from '@jarvis/core/helix';
import { sketchFrameOf } from '@jarvis/core/reference';
import { valueText } from './numberText';

/** Form values: text as typed, checks as booleans, the variable pitch table as one "P|Rev|H|Dia" text per row. */
export type HelixValues = Record<string, string | boolean | string[]>;

/** The sketch value of a step whose sketch is stored in it (kept as it is). */
export const OWN_SKETCH = '__own';

export const DEFINED_BY: [HelixDefinedBy, string][] = [
    ['pitchRevolution', 'Pitch and revolution'],
    ['heightRevolution', 'Height and revolution'],
    ['heightPitch', 'Height and pitch'],
    ['spiral', 'Spiral'],
];

/** Which cells of a table row are typed (the others are worked out), by Defined by; the first row only has its pitch. */
export function rowInputs(definedBy: string, index: number): { pitch: boolean; revolutions: boolean; height: boolean; diameter: boolean } {
    if (index === 0) {
        return { pitch: true, revolutions: false, height: false, diameter: false };
    }
    return {
        pitch: definedBy !== 'heightRevolution',
        revolutions: definedBy !== 'heightPitch',
        height: definedBy !== 'pitchRevolution',
        diameter: true,
    };
}

export type RowCells = [string, string, string, string];

export const splitRow = (row: string): RowCells => {
    const cells = row.split('|');
    return [cells[0] ?? '', cells[1] ?? '', cells[2] ?? '', cells[3] ?? ''];
};
export const joinRow = (cells: RowCells): string => cells.join('|');

function number(text: string | undefined, what: string): number {
    const n = text !== undefined && text.trim() !== '' ? Number(text) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${what} must be a number.`);
    }
    return n;
}

const optional = (text: string | undefined): number | undefined => {
    const n = text !== undefined && text.trim() !== '' ? Number(text) : NaN;
    return Number.isFinite(n) ? n : undefined;
};

/** The table rows as the step stores them: only the typed cells (and diameters typed on later rows). */
export function tableRows(definedBy: string, rows: string[]): HelixRow[] {
    return rows.map((row, i) => {
        const [p, rev, h, d] = splitRow(row);
        const use = rowInputs(definedBy, i);
        const out: HelixRow = {};
        if (use.pitch) out.pitch = number(p, `Row ${i + 1} pitch`);
        if (use.revolutions) out.revolutions = number(rev, `Row ${i + 1} revolutions`);
        if (use.height) out.height = number(h, `Row ${i + 1} height`);
        const diameter = use.diameter ? optional(d) : undefined;
        if (diameter !== undefined) out.diameter = diameter;
        return out;
    });
}

const isSpiral = (v: HelixValues): boolean => v.definedBy === 'spiral';
export const isVariable = (v: HelixValues): boolean => !isSpiral(v) && v.pitchType === 'variable';

/** The step's settings from the form (throws a message for the form when a value is missing or not a number). */
export function helixOptionsOf(v: HelixValues): HelixOptions {
    const definedBy = v.definedBy as HelixDefinedBy;
    const o: HelixOptions = {
        definedBy,
        reverse: !!v.reverse,
        startAngle: number(v.startAngle as string, 'Start angle'),
        clockwise: v.direction === 'clockwise',
    };
    if (isVariable(v)) {
        o.variablePitch = tableRows(definedBy, v.rows as string[]);
        return o;
    }
    const uses = { pitchRevolution: ['pitch', 'revolutions'], heightRevolution: ['height', 'revolutions'], heightPitch: ['height', 'pitch'], spiral: ['pitch', 'revolutions'] }[definedBy] ?? [];
    for (const key of uses) {
        o[key as 'pitch' | 'revolutions' | 'height'] = number(v[key] as string, key === 'pitch' ? 'Pitch' : key === 'height' ? 'Height' : 'Revolutions');
    }
    if (!isSpiral(v) && v.taper) {
        o.taper = number(v.taperAngle as string, 'Taper angle');
        o.taperOutward = !!v.taperOutward;
    }
    return o;
}

/**
 * The fields to send for the step. On an edit every setting is sent, those the form does not use as null, so an
 * update clears them (features_update merges fields).
 */
export function helixFeature(v: HelixValues, edit: boolean): Record<string, unknown> {
    const o = helixOptionsOf(v);
    const all = ['pitch', 'revolutions', 'height', 'variablePitch', 'taper', 'taperOutward'] as const;
    const out: Record<string, unknown> = { op: 'helix', ...o };
    if (v.sketch !== OWN_SKETCH) {
        out.sketchRef = v.sketch;
    }
    if (edit) {
        for (const key of all) {
            if (out[key] === undefined) {
                out[key] = null;
            }
        }
    }
    return out;
}

const sketchStepsOf = (features: readonly Feature[]) => features.filter((f): f is Extract<Feature, { op: 'sketch' }> => f.op === 'sketch');

/** Sketch steps before `upTo` (all when absent) that hold exactly one circle, newest last. */
export function circleSketches(features: readonly Feature[], upTo = features.length): Extract<Feature, { op: 'sketch' }>[] {
    return sketchStepsOf(features.slice(0, upTo)).filter((f) => {
        try {
            helixCircle(f.sketch);
            return true;
        } catch {
            return false;
        }
    });
}

/** The form's values for a new step (`sketch`: the circle sketch to start from) or for a stored step. */
export function helixValues(step: HelixStep | null, sketch: string, diameter: number | null): HelixValues {
    const values: HelixValues = {
        sketch, definedBy: 'pitchRevolution', pitchType: 'constant', pitch: '5', revolutions: '5', height: '25', reverse: false,
        startAngle: '0', direction: 'clockwise', taper: false, taperAngle: '5', taperOutward: false,
        rows: diameter ? [joinRow(['5', '0', '0', valueText(diameter)]), joinRow(['5', '5', '25', valueText(diameter)])] : ['5|0|0|', '5|5|25|'],
    };
    if (!step) {
        return values;
    }
    const text = (n: number | undefined, fallback: string) => (n === undefined ? fallback : valueText(n));
    Object.assign(values, {
        sketch: step.sketchRef ?? OWN_SKETCH,
        definedBy: step.definedBy,
        pitchType: step.variablePitch?.length ? 'variable' : 'constant',
        pitch: text(step.pitch, values.pitch as string),
        revolutions: text(step.revolutions, values.revolutions as string),
        height: text(step.height, values.height as string),
        reverse: !!step.reverse,
        startAngle: text(step.startAngle, '0'),
        direction: step.clockwise ? 'clockwise' : 'counterclockwise',
        taper: !!step.taper,
        taperAngle: text(step.taper || undefined, '5'),
        taperOutward: !!step.taperOutward,
    });
    if (step.variablePitch?.length) {
        values.rows = step.variablePitch.map((r) => joinRow([text(r.pitch, ''), text(r.revolutions, ''), text(r.height, ''), text(r.diameter, '')]));
    }
    // The third of pitch, revolutions and height, worked out, so changing Defined by keeps the curve.
    return { ...values, ...derivedPatch(values, diameter) };
}

/**
 * Keeps the values the form works out in step with those typed: the third of pitch, revolutions and height, and the
 * table's worked-out cells (so switching Defined by keeps the same curve). `startDiameter` fills the first row.
 */
export function derivedPatch(v: HelixValues, startDiameter?: number | null): HelixValues {
    const patch: HelixValues = {};
    const p = optional(v.pitch as string);
    const n = optional(v.revolutions as string);
    const h = optional(v.height as string);
    if (v.definedBy === 'pitchRevolution' && p !== undefined && n !== undefined) {
        patch.height = valueText(p * n);
    } else if (v.definedBy === 'heightRevolution' && h !== undefined && n !== undefined && n > 0) {
        patch.pitch = valueText(h / n);
    } else if (v.definedBy === 'heightPitch' && h !== undefined && p !== undefined && p > 0) {
        patch.revolutions = valueText(h / p);
    }
    const rows = v.rows as string[] | undefined;
    if (rows && v.definedBy !== 'spiral') {
        try {
            const diameter = startDiameter ?? optional(splitRow(rows[0] ?? '')[3]) ?? 1;
            const worked = helixRows(v.definedBy as HelixDefinedBy, tableRows(v.definedBy as string, rows), diameter);
            patch.rows = worked.map((r, i) => {
                const typed = splitRow(rows[i]);
                const use = rowInputs(v.definedBy as string, i);
                return joinRow([
                    use.pitch ? typed[0] : valueText(r.pitch),
                    use.revolutions ? typed[1] : valueText(r.revolutions),
                    use.height ? typed[2] : valueText(r.height),
                    use.diameter ? typed[3] : valueText(r.diameter),
                ]);
            });
        } catch {
            // Incomplete: the worked-out cells wait for the typed ones.
        }
    }
    return patch;
}

/** A first variable pitch table from the constant pitch values: the same curve as two rows. */
export function tableFromConstant(v: HelixValues, diameter: number | null): string[] {
    const p = v.pitch as string;
    return [joinRow([p, '0', '0', diameter ? valueText(diameter) : '']), joinRow([p, v.revolutions as string, v.height as string, ''])];
}

/** The curve the form makes as it stands (for the preview and the status line), or the reason it cannot. */
export function draftHelix(v: HelixValues, features: readonly Feature[], editing: string | null): { shape: HelixShape | null; error: string | null } {
    try {
        const at = editing ? features.findIndex((f) => f.id === editing) : -1;
        const before = at >= 0 ? features.slice(0, at) : [...features];
        let step: HelixStep;
        const options = helixOptionsOf(v);
        if (v.sketch === OWN_SKETCH) {
            const stored = features[at];
            if (!stored || stored.op !== 'helix' || !stored.sketch) {
                throw new Error('Pick the sketch with the circle.');
            }
            step = { id: '__draft', op: 'helix', ...options, sketch: stored.sketch };
        } else {
            if (!v.sketch) {
                throw new Error('Pick a sketch holding one circle.');
            }
            step = { id: '__draft', op: 'helix', ...options, sketchRef: v.sketch as string };
        }
        const { sketch, earlier } = helixSketchOf(step, before);
        return { shape: helixShape(step, helixCircle(sketch), sketchFrameOf(sketch, earlier)), error: null };
    } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        return { shape: null, error: text.charAt(0).toUpperCase() + text.slice(1) };
    }
}

/** The status line: what the curve comes to (height, revolutions, pitch, diameters, length). */
export function helixStatus(shape: HelixShape): string {
    const mm = (n: number) => `${valueText(n)} mm`;
    const parts = shape.spiral ? ['Spiral'] : [`Height ${mm(shape.height)}`];
    parts.push(`${valueText(shape.revolutions)} revolutions`);
    if (shape.pitch !== null) {
        parts.push(`pitch ${mm(shape.pitch)}`);
    }
    if (Math.abs(shape.endDiameter - shape.startDiameter) > 1e-9) {
        parts.push(`diameter ${mm(shape.startDiameter)} to ${mm(shape.endDiameter)}`);
    }
    parts.push(`length ${mm(helixLength(shape))}`);
    return parts.join(' · ');
}

/** The circle sketch's diameter for a sketch value, if it has one. */
export function sketchDiameter(features: readonly Feature[], sketch: unknown): number | null {
    const step = features.find((f) => f.id === sketch);
    if (!step || step.op !== 'sketch') {
        return null;
    }
    try {
        return 2 * helixCircle(step.sketch).radius;
    } catch {
        return null;
    }
}

// ---- Sweep along a helix or spiral --------------------------------------------------------------------------

/** The helix and spiral steps of a part, as the Sweep form's path list offers them. */
export function curveSteps(part: Part | null | undefined): HelixStep[] {
    return (part?.features ?? []).filter((f): f is HelixStep => f.op === 'helix');
}

/** The helix or spiral step a Sweep path value names, if it is one. */
export function curveStep(part: Part | null | undefined, id: unknown): HelixStep | undefined {
    return curveSteps(part).find((f) => f.id === id);
}

/** A sweep's path as the form's value: the curve or sketch step id ('' for an inline helix or sketch). */
export function sweepPathValue(path: Extract<Feature, { op: 'sweep' }>['path']): string {
    if ('helix' in path) {
        return '';
    }
    return 'curveRef' in path ? path.curveRef : path.sketchRef ?? '';
}

/** The newer of the latest path sketch and the latest helix step: what a new sweep starts with. */
export function newestPath(part: Part | null | undefined, sketchPath: string | undefined): string {
    const features = part?.features ?? [];
    const curve = curveSteps(part).pop();
    const at = (id: string | undefined) => (id ? features.findIndex((f) => f.id === id) : -1);
    return curve && at(curve.id) > at(sketchPath) ? curve.id : sketchPath ?? '';
}
