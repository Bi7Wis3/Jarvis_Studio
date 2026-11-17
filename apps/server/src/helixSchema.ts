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

/** A point on a helix or spiral step, for planes, axes and points made on it. */
export const curvePointSchema = z.object({
    curveRef: z.string().describe('Id of an earlier helix or spiral step (op helix)'),
    at: z.union([z.enum(['start', 'end']), z.number().min(0).max(1)])
        .describe('Its start, its end, or a fraction 0 to 1 of the way through its revolutions'),
}).describe('A point on a helix or spiral step; it follows the curve when the curve changes');

const curveRefSchema = z.object({ curveRef: z.string().describe('Id of an earlier helix or spiral step (op helix)') });

/** The plane square to a helix or spiral (SolidWorks: Perpendicular to the curve, Coincident with a point). */
export function curveNormalSchema<B extends ZodRawShape, P extends z.ZodTypeAny>(base: B, point: P) {
    return z.object({
        ...base,
        kind: z.literal('curveNormal'),
        curve: curveRefSchema,
        point: point.describe('The point it passes through, e.g. { curveRef, at: "start" }; the plane is square to the curve where it passes nearest the point'),
        originOnCurve: z.boolean().optional().describe('Set origin on curve: the origin on the curve instead of at the point'),
    }).describe('Perpendicular to a helix or spiral step at a point: its normal along the curve, its u axis towards the curve\'s axis');
}

/** Point steps made on a helix or spiral: at its start or end (On point), or along it. */
export const curvePointDefinitionSchemas = [
    z.object({ kind: z.literal('onCurve'), curve: curvePointSchema }).describe('On a helix or spiral: its start, end or part way'),
    z.object({
        kind: z.literal('alongCurve'), curve: curveRefSchema, by: z.enum(['distance', 'percent']), amount: z.number().positive(),
        index: z.number().int().min(1).describe('Which of the points spaced amount apart, from the start of the curve'),
        reverse: z.boolean().optional().describe('From the end of the curve'),
    }).describe('Along a helix or spiral by distance or percentage of its length'),
] as const;
