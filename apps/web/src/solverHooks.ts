// Steps the solver runs after each solve, for sketch entities that follow other geometry (a fit spline linked to
// the curves it was fitted to). Modules add their step here when they load; this module imports nothing, so the
// solver can load it first.

import type { SketchGeometry } from '@jarvis/core';

export const afterSolveSteps: ((g: SketchGeometry) => SketchGeometry)[] = [];

export function afterSolve(g: SketchGeometry): SketchGeometry {
    return afterSolveSteps.reduce((out, step) => step(out), g);
}

/**
 * Whether a drag must be solved with the whole sketch: equation driven curves (held rigid through the sketch's
 * equation items) and Constrained fit splines (fitted again to curves they share no point with) are not joined to
 * what moves them by points and relations alone.
 */
export function solvesWhole(g: SketchGeometry): boolean {
    return !!g.equations?.length || g.curves.some((c) => c.kind === 'spline' && !!c.fit);
}
