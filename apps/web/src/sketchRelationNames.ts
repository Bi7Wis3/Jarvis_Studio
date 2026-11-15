// The names relations and dimensions go by in the lists (Add Relations, Display/Delete Relations, SketchXpert).

import type { Feature, SketchConstraint } from '@jarvis/core';
import { isModelLock, MODEL_LOCK_NAME, sketchLockSource } from './sketchModel';

export const RELATION_NAMES: Record<SketchConstraint['kind'], string> = {
    coincident: 'Coincident', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
    tangent: 'Tangent', equal: 'Equal', pointOnCurve: 'On curve', midpoint: 'Midpoint', symmetric: 'Symmetric', fix: 'Lock',
    fixRadius: 'Lock radius', horizontalPoints: 'Horizontal', verticalPoints: 'Vertical', concentric: 'Concentric', coradial: 'Coradial',
    collinear: 'Collinear', intersection: 'Intersection',
    distance: 'Distance', length: 'Length', angle: 'Angle', radius: 'Radius', diameter: 'Diameter',
    arcLength: 'Arc length', pointAngle: 'Angle', pathLength: 'Path length',
    pathTangent: 'Tangent to path', equalSweep: 'Equal angle', rho: 'Rho',
};

/**
 * The name of a relation in a list: a lock on geometry taken from the model or another sketch says where it came
 * from ("Lock: From the model, as it was", "Lock: From Sketch1, as it was"); the rest go by their kind.
 */
export function relationName(c: SketchConstraint, context: Feature[] = []): string {
    if (isModelLock(c)) {
        return `Lock: ${MODEL_LOCK_NAME}`;
    }
    const step = sketchLockSource(c);
    const name = step ? context.find((f) => f.id === step)?.name ?? step : null;
    return name ? `Lock: From ${name}, as it was` : RELATION_NAMES[c.kind];
}
