// Dimension helpers beyond the plain Smart Dimension: driven (reference) dimensions and the test whether a new
// dimension would over define the sketch (SolidWorks then offers: Make this dimension driven | Leave this dimension
// driving).

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { isDimension, measure, solveGeometry, solverReady } from './solver';
import type { NewConstraint } from './sketchGeometry';

export type Dimension = Extract<SketchConstraint, { value: number }>;

export const isDriven = (c: SketchConstraint): boolean => isDimension(c) && !!c.driven;

/**
 * Whether adding `c` (at the value the geometry has now) would over define the sketch: it takes no freedom away, or
 * it does not solve. False when that cannot be told (solver not loaded, or the sketch does not solve now).
 */
export function overDefines(g: SketchGeometry, c: NewConstraint): boolean {
    if (!solverReady()) {
        return false;
    }
    const before = solveGeometry(g);
    if (!before.ok) {
        return false;
    }
    const probe = { ...c, id: '__probe' } as SketchConstraint;
    const value = isDimension(probe) ? measure(before.geometry, probe) : null;
    const next = { ...before.geometry, constraints: [...before.geometry.constraints, value === null ? probe : { ...probe, value } as SketchConstraint] };
    const after = solveGeometry(next);
    return !after.ok || after.dof >= before.dof || after.redundant.length > before.redundant.length;
}

/** The dimension switched to driven (its value then follows the geometry) or back to driving at the value it has now. */
export function withDriven(g: SketchGeometry, c: Dimension, driven: boolean): Dimension {
    const now = measure(g, c) ?? c.value;
    if (driven) {
        return { ...c, driven: true, value: now };
    }
    const { driven: _d, ...rest } = c;
    return { ...rest, value: now } as Dimension;
}

/** Switches dimensions between driving and driven; others are left alone. */
export function setDriven(g: SketchGeometry, ids: string[], driven: boolean): SketchGeometry {
    const set = new Set(ids);
    return {
        ...g,
        constraints: g.constraints.map((c) => (set.has(c.id) && isDimension(c) && !!c.driven !== driven ? withDriven(g, c, driven) : c)),
    };
}
