// Changes to existing relations: Replace (SolidWorks Display/Delete Relations: swap one entity of a relation for
// another of the same type) and the filters the relations list offers.

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, pointOf } from './solver';
import { broughtIn, constraintRefs, liveIds } from './sketchGeometry';
import { unmetConstraints } from './sketchCheck';

/** What sort of entity an id is, for Replace: a point, a line, an arc or circle, another curve, or nothing (deleted). */
function sortOf(g: SketchGeometry, id: string): 'point' | 'line' | 'round' | 'curve' | null {
    if (id === ORIGIN || pointOf(g, id)) {
        return 'point';
    }
    if (id === AXIS_U || id === AXIS_V) {
        return 'line';
    }
    const c = curveOf(g, id);
    return !c ? null : c.kind === 'line' ? 'line' : c.kind === 'circle' || c.kind === 'arc' ? 'round' : 'curve';
}

const NOT_REFS = new Set(['id', 'kind', 'axis', 'aCond', 'bCond']);

/** The relation with `from` swapped for `to`; the replacement must be the same sort of entity (a deleted one: any). */
export function replaceEntity(g: SketchGeometry, id: string, from: string, to: string): { g: SketchGeometry } | { error: string } {
    const c = g.constraints.find((k) => k.id === id);
    if (!c) {
        return { error: 'That relation is gone.' };
    }
    const refs = constraintRefs(c);
    if (!refs.includes(from)) {
        return { error: 'The relation does not refer to that entity.' };
    }
    if (to === from || refs.includes(to)) {
        return { error: 'The relation already refers to that entity; pick another.' };
    }
    const [was, now] = [sortOf(g, from), sortOf(g, to)];
    if (!now) {
        return { error: 'Pick a point or a curve of this sketch.' };
    }
    if (was && was !== now) {
        return { error: `Pick a ${was === 'round' ? 'arc or circle' : was} to take its place.` };
    }
    const next = Object.fromEntries(Object.entries(c).map(([key, v]) => [key, !NOT_REFS.has(key) && v === from ? to : v])) as SketchConstraint;
    return { g: { ...g, constraints: g.constraints.map((k) => (k.id === id ? next : k)) } };
}

export type RelationFilter = 'all' | 'dangling' | 'problems' | 'external' | 'locked' | 'selected' | 'suppressed';

/**
 * The filters of the list, as SolidWorks names them. External: relations to geometry taken from the model or another
 * sketch; Locked: the locks that hold such geometry where it was (it does not follow later changes). Defined in
 * context and Broken are assembly references, which a part sketch here never has.
 */
export const RELATION_FILTERS: { value: RelationFilter; label: string }[] = [
    { value: 'all', label: 'All in this sketch' },
    { value: 'dangling', label: 'Dangling' },
    { value: 'problems', label: 'Over defining / not solved' },
    { value: 'external', label: 'External' },
    { value: 'locked', label: 'Locked' },
    { value: 'selected', label: 'Selected entities' },
    { value: 'suppressed', label: 'Suppressed' },
];

/** The relations to geometry from outside the sketch (the model, another sketch), and the locks that hold it. */
export function externalRelations(g: SketchGeometry): { external: Set<string>; locked: Set<string>; entities: Set<string> } {
    const b = broughtIn(g);
    const entities = new Set([...b.curves, ...b.on.keys()]);
    const external = new Set(g.constraints.filter((c) => b.locks.has(c.id) || constraintRefs(c).some((r) => entities.has(r))).map((c) => c.id));
    return { external, locked: b.locks, entities };
}

export type RelationState = 'ok' | 'conflicting' | 'redundant' | 'dangling' | 'unsolved' | 'suppressed';

/** Each relation's state: dangling, suppressed, conflicting, redundant (over defining), not met by the geometry, or fine. */
export function relationStates(g: SketchGeometry, solved: { conflicting: string[]; redundant: string[] } | null, conflicting: string[] = []): Map<string, RelationState> {
    const alive = liveIds(g);
    const unmet = new Set(unmetConstraints(g));
    return new Map(g.constraints.map((c) => [c.id, constraintRefs(c).some((r) => !alive.has(r)) ? 'dangling'
        : c.suppressed ? 'suppressed'
            : conflicting.includes(c.id) || solved?.conflicting.includes(c.id) ? 'conflicting'
                : solved?.redundant.includes(c.id) ? 'redundant' : unmet.has(c.id) ? 'unsolved' : 'ok']));
}

/** Whether a relation shows under a filter (`scope`: the selected entities). */
export function showsUnder(filter: RelationFilter, state: RelationState, c: SketchConstraint, scope: string[],
    outside: { external: Set<string>; locked: Set<string> } = { external: new Set(), locked: new Set() }): boolean {
    switch (filter) {
        case 'external':
            return outside.external.has(c.id);
        case 'locked':
            return outside.locked.has(c.id);
        case 'all':
            return true;
        case 'dangling':
            return state === 'dangling';
        case 'problems':
            return state === 'conflicting' || state === 'redundant' || state === 'unsolved';
        case 'suppressed':
            return state === 'suppressed';
        case 'selected':
            return constraintRefs(c).some((r) => scope.includes(r));
    }
}
