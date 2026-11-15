// What a shown sketch step draws in the view, in every workspace: all of its curves (not only the closed profiles the
// kernel builds from), its construction curves dashed and its sketch points, so that another sketch can snap to them.

import type { Feature, Sketch } from '@jarvis/core';
import { geometryEntities } from './sketchGeometry';
import { entityPoints, sketchToEntities } from './sketchMath';
import { curvePointIds } from './sketchCurves';

type V3 = [number, number, number];

export interface StepDrawing {
    /** Curves that may make profiles, as polylines on the sketch plane (z = 0). */
    curves: V3[][];
    /** Construction curves (centre lines, guides), drawn dashed. */
    construction: V3[][];
    /** Sketch points of their own (not the ends or centre of a curve). */
    points: V3[];
    /** Dash length for the construction curves, in sketch units: a sixtieth of the sketch's size. */
    dash: number;
}

function dashFor(lines: V3[][]): number {
    let [u0, v0, u1, v1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const l of lines) {
        for (const [u, v] of l) {
            [u0, v0, u1, v1] = [Math.min(u0, u), Math.min(v0, v), Math.max(u1, u), Math.max(v1, v)];
        }
    }
    const size = Number.isFinite(u0) ? Math.hypot(u1 - u0, v1 - v0) : 0;
    return Math.min(5, Math.max(0.2, size / 60));
}

const flat = ([u, v]: [number, number]): V3 => [u, v, 0];

/** The drawing of a sketch, from its solved geometry; an old profile-only sketch draws its profiles. */
export function stepDrawing(sketch: Sketch): StepDrawing {
    const g = sketch.geometry;
    if (!g) {
        const curves = sketchToEntities(sketch).map((e) => entityPoints(e).map(flat));
        return { curves, construction: [], points: [], dash: dashFor(curves) };
    }
    const curves: V3[][] = [];
    const construction: V3[][] = [];
    for (const e of geometryEntities(g, true)) {
        (e.construction ? construction : curves).push(entityPoints(e).map(flat));
    }
    const onCurves = new Set(g.curves.flatMap(curvePointIds));
    const points = g.points.filter((p) => p.id !== 'origin' && !onCurves.has(p.id)).map((p): V3 => [p.u, p.v, 0]);
    // Endless construction lines are drawn far out: the dashes follow the rest.
    return { curves, construction, points, dash: dashFor(curves.length ? curves : construction) };
}

/**
 * The sketch steps of a part the view draws: not suppressed, not hidden (`hidden` holds "designId/stepId" keys, see
 * hiddenSteps in @jarvis/core/visibility), not the one being edited (the sketcher draws that). `keep` brings a hidden
 * one back while a form works with it (its regions being picked).
 */
export function shownSketchSteps(features: readonly Feature[], designId: string, hidden: ReadonlySet<string>, editing: string | null,
    keep: (id: string) => boolean = () => false): Extract<Feature, { op: 'sketch' }>[] {
    return features.filter((f): f is Extract<Feature, { op: 'sketch' }> => f.op === 'sketch' && !f.suppressed && f.id !== editing
        && (!hidden.has(`${designId}/${f.id}`) || keep(f.id)));
}
