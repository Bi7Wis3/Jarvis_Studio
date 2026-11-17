// The Helix/Spiral step in the history tools (features_add, features_update), as SolidWorks' Helix/Spiral
// PropertyManager: defined by, constant or variable pitch, reverse direction, start angle, clockwise, taper.

import { z, type ZodRawShape } from 'zod';

const row = z.object({
    pitch: z.number().positive().optional(),
    revolutions: z.number().min(0).optional().describe('From the start (0 or left out on the first row)'),
    height: z.number().min(0).optional().describe('From the start, mm (0 or left out on the first row)'),
    diameter: z.number().positive().optional().describe('Diameter at this row; omit to keep the row before\'s'),
});

/** The helix step schema, with the history tools' own id/name/suppressed fields and sketch source. */
export function helixStepSchema<B extends ZodRawShape, S extends ZodRawShape>(base: B, sketchSource: S) {
    return z.object({
        ...base,
        ...sketchSource,
        op: z.literal('helix'),
        definedBy: z.enum(['pitchRevolution', 'heightRevolution', 'heightPitch', 'spiral'])
            .describe('pitchRevolution: pitch and revolutions; heightRevolution: height and revolutions; heightPitch: height '
                + 'and pitch; spiral: a flat spiral in the sketch plane by pitch (radial distance between turns) and revolutions'),
        pitch: z.number().positive().optional().describe('Constant pitch, mm (helix: distance between turns along the axis)'),
        revolutions: z.number().positive().optional(),
        height: z.number().positive().optional().describe('mm along the axis'),
        variablePitch: z.array(row).min(2).optional().describe('Variable pitch (helix only), the region table: the first row is '
            + 'the start (give only its pitch); each later row gives the two values definedBy names, counted from the start '
            + '(pitch and revolutions, height and revolutions, or height and pitch), and optionally a diameter. The pitch '
            + 'changes evenly with the revolutions between rows. Leave out pitch, revolutions and height when given'),
        reverse: z.boolean().optional().describe('Helix: run against the sketch normal. Spiral: run inward'),
        startAngle: z.number().optional().describe('Degrees on the circle from the sketch u axis, counterclockwise, where the curve starts'),
        clockwise: z.boolean().optional().describe('Turn clockwise as seen looking at the sketch; default counterclockwise '
            + '(a right-hand helix when not reversed)'),
        taper: z.number().min(0).lt(90).optional().describe('Taper helix (constant pitch helix only): degrees; narrows along the height'),
        taperOutward: z.boolean().optional().describe('The taper widens instead'),
    }).describe('Helix or spiral curve (builds nothing) from a sketch holding one circle: its centre and the sketch normal are '
        + 'the axis, its diameter the start diameter, and the curve starts on it. Sweeps use it as a path with { curveRef: id } '
        + '(springs: a helix step, a wire profile at its start, a sweep)');
}

/** What a helix step needs given, by definedBy (the schema keeps the fields optional for features_update). */
export function checkHelixStep(where: string, f: Record<string, unknown>): void {
    const table = Array.isArray(f.variablePitch) && f.variablePitch.length > 0;
    if (table) {
        if (f.definedBy === 'spiral') {
            throw new Error(`${where}: variable pitch is for a helix, not a spiral`);
        }
        return;
    }
    const need: Record<string, string[]> = {
        pitchRevolution: ['pitch', 'revolutions'], heightRevolution: ['height', 'revolutions'],
        heightPitch: ['height', 'pitch'], spiral: ['pitch', 'revolutions'],
    };
    const missing = (need[f.definedBy as string] ?? []).filter((k) => typeof f[k] !== 'number');
    if (missing.length) {
        throw new Error(`${where}: defined by ${String(f.definedBy)} needs ${missing.join(' and ')}`);
    }
}
