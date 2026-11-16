// The Imported step in a build: its solids join the part as bodies of their own (they are not merged with what is
// there, as SolidWorks adds an imported body), and a graphics body is left to the view (graphics.ts).

import { makeCompound, type Shape3D } from 'replicad';
import type { ImportStep } from '@jarvis/core/imported';
import { hasImportAsset } from './assets.js';
import { loadBrep } from './brep.js';

export function applyImport(shape: Shape3D | null, step: ImportStep): Shape3D | null {
    if (step.mesh && !hasImportAsset(step.mesh)) {
        throw new Error(`the mesh of ${step.file.name} (${step.mesh}) is missing from the assets folder`);
    }
    if (!step.brep) {
        return shape;
    }
    const imported = loadBrep(step.brep);
    if (!shape) {
        return imported;
    }
    // One flat compound of every solid, so later steps and the Solid Bodies folder see each body.
    const solids = [...shape.solids, ...imported.solids];
    imported.delete();
    return makeCompound(solids) as Shape3D;
}
