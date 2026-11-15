// Replace Entity (SolidWorks Tools > Sketch Tools > Replace Entity): one entity takes over another's relations and
// dimensions; the old one is deleted or made construction. Its end points (and centre) are joined to the new
// entity's nearest ones, so what met the old entity meets the new one. Relations that cannot hold for the new
// entity's kind (a horizontal relation on an arc, a radius on a line) go, and are counted.

import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, curveOf, pointOf } from './solver';
import { constraintRefs, removeItemsKeepingPoints } from './sketchGeometry';
import { mergePoints } from './sketchRepair';
import { dist, type Pt } from './sketchMath';
import { curveCentreIds, curveEndIds } from './sketchCurves';

export interface ReplaceOptions {
    /** What happens to the old entity. */
    old: 'construction' | 'delete';
    /** Make contour: the new entity becomes ordinary (not construction) geometry. */
    contour: boolean;
}

const endsOf = (c: SketchCurve): string[] => curveEndIds(c);
const centreOf = (c: SketchCurve): string | null => curveCentreIds(c)[0] ?? null;

/** Whether a relation that now names `id` (of kind `kind`) can hold. */
function holds(g: SketchGeometry, k: SketchConstraint, id: string): boolean {
    const kind = (x: string) => (x === AXIS_U || x === AXIS_V ? 'line' : curveOf(g, x)?.kind ?? (pointOf(g, x) ? 'point' : 'other'));
    const round = (x: string) => kind(x) === 'arc' || kind(x) === 'circle';
    const line = (x: string) => kind(x) === 'line';
    switch (k.kind) {
        case 'horizontal':
        case 'vertical':
        case 'length':
            return line(k.line);
        case 'midpoint':
            return line(k.line);
        case 'parallel':
        case 'perpendicular':
        case 'collinear':
        case 'angle':
            return line(k.a) && line(k.b);
        case 'radius':
        case 'diameter':
        case 'fixRadius':
            return round(k.curve);
        case 'concentric':
        case 'coradial':
            return [k.a, k.b].every((x) => round(x) || kind(x) === 'point');
        case 'equal':
            return (line(k.a) && line(k.b)) || (round(k.a) && round(k.b));
        case 'tangent':
            return k.a !== k.b && !(line(k.a) && line(k.b));
        case 'symmetric':
            return line(k.about);
        case 'distance':
            return kind(k.b) === 'point' || (line(k.b) && k.b !== id) || (k.b === id && line(id));
        default:
            return true;
    }
}

/**
 * Replaces `oldId` with `newId`. Returns the new geometry and how many relations or dimensions could not be kept.
 */
export function replaceEntity(g: SketchGeometry, oldId: string, newId: string, o: ReplaceOptions): { g: SketchGeometry; dropped: number } | { error: string } {
    const old = curveOf(g, oldId);
    const next = curveOf(g, newId);
    if (!old || !next) {
        return { error: 'Pick the entity to replace and the one to replace it with.' };
    }
    if (oldId === newId) {
        return { error: 'Pick a different entity to replace it with.' };
    }
    const P = (id: string): Pt => {
        const p = pointOf(g, id);
        return p ? [p.u, p.v] : [0, 0];
    };
    // The new entity's ends join the old one's: the nearer pairing of the two.
    const [oa, ob] = endsOf(old);
    const [na, nb] = endsOf(next);
    const joins: [string, string][] = [];
    if (oa && na) {
        const straight = dist(P(oa), P(na)) + (ob && nb ? dist(P(ob), P(nb)) : 0);
        const crossed = ob ? dist(P(ob), P(na)) + (nb ? dist(P(oa), P(nb)) : 0) : Infinity;
        if (straight <= crossed) {
            joins.push([oa, na], ...(ob && nb ? [[ob, nb] as [string, string]] : []));
        } else {
            joins.push([ob, na], ...(nb ? [[oa, nb] as [string, string]] : []));
        }
    }
    const [oc, nc] = [centreOf(old), centreOf(next)];
    if (oc && nc) {
        joins.push([oc, nc]);
    }
    // Relations on the old entity go to the new one where they can hold there.
    let dropped = 0;
    const constraints: SketchConstraint[] = [];
    for (const k of g.constraints) {
        if (!constraintRefs(k).includes(oldId)) {
            constraints.push(k);
            continue;
        }
        const moved = Object.fromEntries(Object.entries(k).map(([key, v]) => [key, v === oldId && key !== 'id' ? newId : v])) as SketchConstraint;
        // A relation between the two entities says nothing any more.
        if (constraintRefs(moved).filter((r) => r === newId).length > 1 || !holds(g, moved, newId)) {
            dropped += 1;
        } else {
            constraints.push(moved);
        }
    }
    let out: SketchGeometry = {
        ...g,
        constraints,
        curves: g.curves.map((c) => (c.id === newId && o.contour ? { ...c, construction: undefined } : c)),
    };
    for (const [keep, drop] of joins) {
        out = mergePoints(out, keep, drop);
    }
    if (o.old === 'delete') {
        out = removeItemsKeepingPoints(out, [oldId]);
    } else {
        out = { ...out, curves: out.curves.map((c) => (c.id === oldId ? { ...c, construction: true } : c)) };
    }
    return { g: out, dropped };
}
