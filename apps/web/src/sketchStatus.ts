// Which sketch entities are fully defined, for SolidWorks-style colours (black/white defined, blue under defined).
// PlaneGCS gives only the whole sketch's degrees of freedom, so each entity is probed: it is fully defined when
// pinning it down (its points held, a circle's radius fixed) takes no freedom away from the sketch.

import type { SketchGeometry } from '@jarvis/core';
import { ORIGIN, curveRadius, solveGeometry, solverReady } from './solver';

/** Past this many points the probes cost too much per change; the caller falls back to the whole-sketch state. */
const MAX_POINTS = 160;

/**
 * Ids of the points and curves that cannot move or change size any more. Everything when the sketch has no freedom
 * left; null when it cannot be told (solver not loaded, a conflict, or a very large sketch).
 */
export function definedEntities(g: SketchGeometry): Set<string> | null {
    if (!solverReady() || g.points.length > MAX_POINTS) {
        return null;
    }
    const base = solveGeometry(g);
    if (!base.ok) {
        return null;
    }
    const all = [...g.points.map((p) => p.id), ...g.curves.map((c) => c.id)];
    if (base.dof === 0) {
        return new Set(all);
    }
    const geometry = base.geometry;
    const defined = new Set<string>([ORIGIN]);
    for (const p of geometry.points) {
        if (p.fixed || p.id === ORIGIN || solveGeometry(geometry, { targets: [], hold: new Set([p.id]) }).dof === base.dof) {
            defined.add(p.id);
        }
    }
    for (const c of geometry.curves) {
        if (c.kind === 'line') {
            if (defined.has(c.a) && defined.has(c.b)) {
                defined.add(c.id);
            }
        } else if (c.kind === 'arc') {
            if (defined.has(c.center) && defined.has(c.start) && defined.has(c.end)) {
                defined.add(c.id);
            }
        } else if (defined.has(c.center)) {
            // The radius is free when fixing it takes a degree of freedom away.
            const radius = curveRadius(geometry, c.id) ?? c.radius;
            const probe: SketchGeometry = {
                ...geometry,
                constraints: [...geometry.constraints, { id: '__probe', kind: 'radius', curve: c.id, value: radius }],
            };
            if (solveGeometry(probe).dof === base.dof) {
                defined.add(c.id);
            }
        }
    }
    return defined;
}
