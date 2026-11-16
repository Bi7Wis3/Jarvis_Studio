// Checks for what the import route, the import_file tool and the history tools accept.

import { z } from 'zod';
import { IMPORT_ASSET, IMPORT_UNITS } from '@jarvis/core/imported';

const asset = z.string().regex(IMPORT_ASSET);

export const importOptionsSchema = z.object({
    meshAs: z.enum(['graphics', 'solid']).optional().describe('Mesh files: graphics body (shown only, default) or solid bodies'),
    unit: z.enum(Object.keys(IMPORT_UNITS) as [keyof typeof IMPORT_UNITS]).optional().describe('Mesh files: unit of the numbers in the file (default mm)'),
    groupFacets: z.boolean().optional().describe('Mesh as solid: merge coplanar facets into one face (default true)'),
    repair: z.boolean().optional().describe('Check every body and repair what fails'),
    knit: z.boolean().optional().describe('Knit surfaces in the file into solids (default true)'),
    tolerance: z.number().positive().optional().describe('Curve and knitting tolerance in mm (default: the file\'s own)'),
    up: z.enum(['y', 'z']).optional().describe('Up axis of the file: z (default) is turned to the studio\'s Y up'),
    bodiesAsParts: z.boolean().optional().describe('A new part per body'),
}).strict();

/** The Imported step in the history tools (made by import_file; written by hand only to copy one). */
export const importStepSchema = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    suppressed: z.boolean().optional(),
    op: z.literal('import'),
    file: z.object({ name: z.string(), format: z.string(), asset, thumbnail: z.string().optional() }),
    brep: asset.optional(),
    mesh: asset.optional(),
    bodies: z.array(z.object({ name: z.string().optional(), color: z.string().optional() })).optional(),
    options: importOptionsSchema.optional(),
});
