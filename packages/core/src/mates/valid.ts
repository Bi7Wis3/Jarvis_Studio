// Which standard mates a pair of entities takes, after SolidWorks' table "Standard Mates by Entity" (2024 help), and
// the type and alignment a new mate starts with. Non-analytic faces (Surface) and faces of extrusions (Extrusion)
// take no standard mate here yet: the kernel does not describe them to the solver.

import type { MateGeom, MateType } from './types';

/** The entity classes of the table: a frame (an origin) counts as a point, an arc edge as a circle. */
export type EntityClass = 'plane' | 'line' | 'point' | 'cylinder' | 'cone' | 'sphere' | 'circle' | 'surface' | 'curve';

export function entityClass(g: MateGeom): EntityClass {
    return g.type === 'frame' ? 'point' : g.type;
}

type Pair = `${EntityClass}|${EntityClass}`;

/** The valid mate types for each unordered pair (keys written both ways below). */
const TABLE: [EntityClass, EntityClass, MateType[]][] = [
    ['circle', 'circle', ['concentric']],
    ['circle', 'cone', ['coincident', 'concentric']],
    ['circle', 'cylinder', ['concentric', 'coincident']],
    ['circle', 'line', ['concentric']],
    ['circle', 'plane', ['coincident']],
    // An arc edge is also a single-entity curve: a point on it, or a distance from it.
    ['circle', 'point', ['coincident', 'distance']],
    ['cone', 'cone', ['angle', 'coincident', 'concentric', 'distance', 'parallel', 'perpendicular']],
    ['cone', 'cylinder', ['angle', 'concentric', 'parallel', 'perpendicular']],
    ['cone', 'line', ['angle', 'concentric', 'parallel', 'perpendicular']],
    ['cone', 'plane', ['tangent']],
    ['cone', 'point', ['coincident', 'concentric']],
    ['cone', 'sphere', ['tangent']],
    ['cylinder', 'cylinder', ['angle', 'concentric', 'distance', 'parallel', 'perpendicular', 'tangent']],
    ['cylinder', 'line', ['angle', 'coincident', 'concentric', 'distance', 'parallel', 'perpendicular', 'tangent']],
    ['cylinder', 'plane', ['distance', 'tangent']],
    ['cylinder', 'point', ['coincident', 'concentric', 'distance']],
    ['cylinder', 'sphere', ['concentric', 'tangent']],
    ['line', 'line', ['angle', 'coincident', 'distance', 'parallel', 'perpendicular']],
    ['line', 'plane', ['coincident', 'distance', 'parallel', 'perpendicular']],
    ['line', 'point', ['coincident', 'distance']],
    ['line', 'sphere', ['concentric', 'distance', 'tangent']],
    ['plane', 'plane', ['angle', 'coincident', 'distance', 'parallel', 'perpendicular']],
    ['plane', 'point', ['coincident', 'distance']],
    ['plane', 'sphere', ['distance', 'tangent']],
    ['point', 'point', ['coincident', 'distance']],
    ['point', 'sphere', ['coincident', 'concentric', 'distance']],
    ['sphere', 'sphere', ['concentric', 'distance', 'tangent']],
];

const VALID = new Map<Pair, MateType[]>();
for (const [a, b, types] of TABLE) {
    VALID.set(`${a}|${b}`, types);
    VALID.set(`${b}|${a}`, types);
}

/** The order the type buttons are shown in, as in the Mate PropertyManager's Standard tab. */
const ORDER: MateType[] = ['coincident', 'parallel', 'perpendicular', 'tangent', 'concentric', 'lock', 'distance', 'angle'];

/**
 * The standard mates two entities take, in button order. Lock takes any two entities of two different components;
 * `sameComponent` (both on one component, or both on the fixed assembly) takes none.
 */
export function validMateTypes(a: MateGeom, b: MateGeom, sameComponent = false): MateType[] {
    if (sameComponent) {
        return [];
    }
    const types = new Set(VALID.get(`${entityClass(a)}|${entityClass(b)}`) ?? []);
    types.add('lock');
    return ORDER.filter((t) => types.has(t));
}

/** Whether Align axes applies: a coincident mate between two origins (or coordinate systems). */
export const alignsAxes = (a: MateGeom, b: MateGeom): boolean => a.type === 'frame' && b.type === 'frame';

/** Whether a mate of this type between these entities has a direction to align (the Mate alignment buttons). */
export function hasAlignment(type: MateType, a: MateGeom, b: MateGeom): boolean {
    const ca = entityClass(a);
    const cb = entityClass(b);
    const directed = (c: EntityClass) => c === 'plane' || c === 'line' || c === 'cylinder' || c === 'cone' || c === 'circle';
    switch (type) {
        case 'coincident':
            // Faces, planes and lines lying on one another; a circle on a cylinder or cone; cones on cones.
            return (directed(ca) && directed(cb) && !(ca === 'plane' && cb === 'line') && !(ca === 'line' && cb === 'plane'))
                || (a.type === 'frame' && b.type === 'frame');
        case 'concentric':
            return directed(ca) && directed(cb) && ca !== 'plane' && cb !== 'plane';
        case 'parallel':
            return directed(ca) && directed(cb) && !((ca === 'plane') !== (cb === 'plane'));
        case 'perpendicular':
            return (ca === 'plane') !== (cb === 'plane');
        case 'distance':
            return (ca === 'plane' && cb === 'plane') || (ca === 'cone' && cb === 'cone');
        case 'angle':
            return true;
        case 'tangent':
            // Which side the cylinder, sphere or cone touches from.
            return true;
        case 'lock':
            return false;
    }
}

/** Whether Flip dimension applies (distance and angle mates with a side or a turning sense). */
export function hasFlip(type: MateType, a: MateGeom, b: MateGeom): boolean {
    if (type === 'angle') {
        return true;
    }
    if (type !== 'distance') {
        return false;
    }
    const ca = entityClass(a);
    const cb = entityClass(b);
    // A signed distance: from a plane (to anything), or between two cones along their axis.
    return ca === 'plane' || cb === 'plane' || (ca === 'cone' && cb === 'cone');
}

/** Whether a distance can be measured to the near or far side (Center to Center, Minimum, Maximum, Custom). */
export const hasDistanceEnds = (a: MateGeom, b: MateGeom): boolean =>
    a.type === 'cylinder' || a.type === 'sphere' || b.type === 'cylinder' || b.type === 'sphere';

/**
 * The mate SolidWorks offers first for a selection: concentric for round things about an axis or centre, else
 * coincident, else tangent, else the first that applies.
 */
export function defaultMateType(a: MateGeom, b: MateGeom): MateType | null {
    const valid = validMateTypes(a, b);
    if (valid.length === 0) {
        return null;
    }
    const round = (g: MateGeom) => g.type === 'cylinder' || g.type === 'cone' || g.type === 'circle' || g.type === 'sphere';
    if (valid.includes('concentric') && (round(a) || round(b)) && !(a.type === 'point' || b.type === 'point')) {
        return 'concentric';
    }
    for (const t of ['coincident', 'tangent', 'concentric', 'parallel', 'distance'] as MateType[]) {
        if (valid.includes(t)) {
            return t;
        }
    }
    return valid[0];
}

/** Display names of the mate types. */
export const MATE_LABELS: Record<MateType, string> = {
    coincident: 'Coincident',
    parallel: 'Parallel',
    perpendicular: 'Perpendicular',
    tangent: 'Tangent',
    concentric: 'Concentric',
    lock: 'Lock',
    distance: 'Distance',
    angle: 'Angle',
};
