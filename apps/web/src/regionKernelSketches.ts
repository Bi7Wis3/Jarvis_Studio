// Sketches for the kernel test of regions where curves cross (apps/server/src/cad/sketchRegionCrossings.test.ts):
// drawn as the sketcher holds them and read out with their regions as the finished sketch stores them. Kept on the web
// side so the server's typecheck does not follow the web modules; the server test loads this file at run time.

import type { Sketch, SketchCurve, SketchGeometry } from '@jarvis/core';
import { addLine, addSlot, EMPTY_GEOMETRY, geometryProfiles } from './sketchGeometry';
import { regionsOf } from './regionPick';

function read(g: SketchGeometry): Sketch {
    return { plane: 'top', profiles: geometryProfiles(g).profiles, regions: regionsOf(g), geometry: g };
}

/** A slot from (0, 0) to (20, 0), radius 5, with a line along its middle that crosses both end arcs (no shared points). */
export function slotWithLineThrough(): Sketch {
    const g = addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 5).g;
    return read(addLine(g, { at: [-8, 0] }, { at: [28, 0] }).g);
}

/** The same slot with a line across it that only ends on its two sides (its own points, no relation). */
export function slotWithLineTouching(): Sketch {
    const g = addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 5).g;
    return read(addLine(g, { at: [10, -5] }, { at: [10, 5] }).g);
}

/**
 * A 40 x 20 rectangle crossed by one curve of each kind that cuts it in two (or, closed, pokes through its right
 * side): a spline, a style spline, a conic, a partial ellipse; an ellipse centred on the right side.
 */
export function rectangleCrossedBy(kind: keyof typeof CROSSING): Sketch {
    const corners: [string, number, number][] = [['r0', 0, 0], ['r1', 40, 0], ['r2', 40, 20], ['r3', 0, 20]];
    const sides: SketchCurve[] = [
        { id: 's0', kind: 'line', a: 'r0', b: 'r1' }, { id: 's1', kind: 'line', a: 'r1', b: 'r2' },
        { id: 's2', kind: 'line', a: 'r2', b: 'r3' }, { id: 's3', kind: 'line', a: 'r3', b: 'r0' },
    ];
    const { points, curve } = CROSSING[kind];
    return read({ points: [...corners, ...points].map(([id, u, v]) => ({ id, u, v })), curves: [...sides, curve], constraints: [] });
}

const CROSSING = {
    spline: { points: [['a', 10, -5], ['m', 22, 10], ['b', 15, 25]], curve: { id: 'x', kind: 'spline', points: ['a', 'm', 'b'] } },
    styleSpline: {
        points: [['a', 10, -5], ['p', 30, 5], ['q', 5, 15], ['b', 25, 25]], curve: { id: 'x', kind: 'styleSpline', points: ['a', 'p', 'q', 'b'] },
    },
    conic: { points: [['a', 5, -5], ['b', 35, -5], ['t', 20, 40]], curve: { id: 'x', kind: 'conic', start: 'a', end: 'b', apex: 't', rho: 0.4 } },
    ellipseArc: {
        points: [['c', 20, 10], ['M', 20, 25], ['m', 15, 10], ['a', 20, -5], ['b', 20, 25]],
        curve: { id: 'x', kind: 'ellipseArc', center: 'c', major: 'M', minor: 'm', start: 'a', end: 'b' },
    },
    ellipse: { points: [['c', 40, 10], ['M', 48, 10], ['m', 40, 14]], curve: { id: 'x', kind: 'ellipse', center: 'c', major: 'M', minor: 'm' } },
} satisfies Record<string, { points: [string, number, number][]; curve: SketchCurve }>;

/** Two circles of radius 5, centres 6 apart: the lens and two crescents. */
export function crossingCircles(): Sketch {
    const g: SketchGeometry = {
        points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 6, v: 0 }],
        curves: [{ id: 'A', kind: 'circle', center: 'a', radius: 5 }, { id: 'B', kind: 'circle', center: 'b', radius: 5 }],
        constraints: [],
    };
    return read(g);
}
