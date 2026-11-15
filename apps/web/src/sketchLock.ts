// Locks that repeat nothing: locking every point of an arc, ellipse or parabola holds some of them twice (an arc's
// end already sits on the circle its centre and start give), and the solver calls the sketch over defined. The
// locks are put on in full, then each one the solver finds repeated is cut to one coordinate, or left out.

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { solveGeometry, solverReady } from './solver';

type Fix = Extract<SketchConstraint, { kind: 'fix' }>;

/**
 * `g` with the locks `fresh` (ids of fix constraints in it) pared down until none of them repeats what the rest
 * hold. A lock cut to one coordinate takes a new id from `nextId`. Without the solver, `g` as it is.
 */
export function withoutRepeatedLocks(g: SketchGeometry, fresh: Iterable<string>, nextId: () => string): SketchGeometry {
    if (!solverReady()) {
        return g;
    }
    const ours = new Set(fresh);
    const order = g.constraints.filter((c) => ours.has(c.id));
    const others: SketchGeometry = { ...g, constraints: g.constraints.filter((c) => !ours.has(c.id)) };
    const before = new Set(solveGeometry(others).redundant);
    // What the solver finds repeated (a repeat a hair off, values rounded to 0.000001 mm, shows as a conflict).
    const repeats = (x: SketchGeometry) => {
        const r = solveGeometry(x);
        return [...r.redundant, ...(r.ok ? [] : r.conflicting)].filter((id) => !before.has(id));
    };
    let out = g;
    // Each round removes one coordinate: at most two per lock.
    for (let round = 0; round <= ours.size * 2; round++) {
        const found = repeats(out);
        const repeated = found.filter((id) => ours.has(id));
        if (!found.length) {
            return out;
        }
        if (!repeated.length) {
            // The solver names the curve's own relations instead: add the locks one coordinate at a time.
            break;
        }
        // The latest of them: locks are put on the points that define a curve first.
        const at = Math.max(...repeated.map((id) => out.constraints.findIndex((c) => c.id === id)));
        const c = out.constraints[at] as Fix;
        const constraints = [...out.constraints];
        if (c.kind === 'fix' && !c.axis) {
            const id = nextId();
            ours.add(id);
            constraints.splice(at, 1, { ...c, axis: 'u' }, { id, kind: 'fix', point: c.point, axis: 'v' });
        } else {
            ours.delete(c.id);
            constraints.splice(at, 1);
        }
        out = { ...out, constraints };
    }
    let built = others;
    for (const c of order) {
        const tries: SketchConstraint[] = c.kind === 'fix' && !c.axis ? [c, { ...c, axis: 'u' }, { ...c, axis: 'v' }] : [c];
        for (const lock of tries) {
            const next = { ...built, constraints: [...built.constraints, lock] };
            if (!repeats(next).length) {
                built = next;
                break;
            }
        }
    }
    return built;
}

type Symmetric = Extract<SketchConstraint, { kind: 'symmetric' }>;

/**
 * The same for symmetric relations (a mirror image of an ellipse or parabola: points on the curve are held by the
 * curve along one direction already): a repeated one is cut to half (square to the line, else its middle on the
 * line), or left out.
 */
export function withoutRepeatedSymmetry(g: SketchGeometry, fresh: Iterable<string>): SketchGeometry {
    if (!solverReady()) {
        return g;
    }
    const ours = new Set(fresh);
    const before = new Set(solveGeometry({ ...g, constraints: g.constraints.filter((c) => !ours.has(c.id)) }).redundant);
    let out = g;
    for (let round = 0; round <= ours.size * 3; round++) {
        const r = solveGeometry(out);
        // A repeat a hair off (values rounded to 0.000001 mm) shows as a conflict: the same.
        const repeated = [...r.redundant, ...(r.ok ? [] : r.conflicting)].filter((id) => ours.has(id) && !before.has(id));
        if (!repeated.length) {
            break;
        }
        const at = Math.max(...repeated.map((id) => out.constraints.findIndex((c) => c.id === id)));
        const c = out.constraints[at] as Symmetric;
        const constraints = [...out.constraints];
        if (c.kind === 'symmetric' && c.part !== 'midpoint') {
            constraints[at] = { ...c, part: c.part ? 'midpoint' : 'perpendicular' };
        } else {
            ours.delete(c.id);
            constraints.splice(at, 1);
        }
        out = { ...out, constraints };
    }
    return out;
}
