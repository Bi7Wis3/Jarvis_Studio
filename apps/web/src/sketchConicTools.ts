// The Conic tool's Auto tangency (SolidWorks Conic PropertyManager): with both ends on the ends of lines or arcs, the
// top vertex is where their tangents meet, so that click is skipped, and the conic is tangent at each end it joins.

import type { SketchGeometry } from '@jarvis/core';
import { curveOf, pointOf } from './solver';
import { addConstraint, tangentAt, type NewConstraint, type PointRef } from './sketchGeometry';
import { curveEndIds } from './sketchCurves';
import { placeConic } from './sketchConics';
import type { Pt } from './sketchMath';

/** Where the tangents leaving two end points meet ahead of both (the top vertex), or null. */
export function autoTopVertex(g: SketchGeometry, a: PointRef, b: PointRef): Pt | null {
    const [ta, tb] = [a.point ? tangentAt(g, a.point) : null, b.point ? tangentAt(g, b.point) : null];
    if (!ta || !tb) {
        return null;
    }
    const den = ta.dir[0] * tb.dir[1] - ta.dir[1] * tb.dir[0];
    if (Math.abs(den) < 1e-9) {
        return null;
    }
    const w: Pt = [b.at[0] - a.at[0], b.at[1] - a.at[1]];
    const s = (w[0] * tb.dir[1] - w[1] * tb.dir[0]) / den;
    const t = (w[0] * ta.dir[1] - w[1] * ta.dir[0]) / den;
    return s > 1e-9 && t > 1e-9 ? [a.at[0] + ta.dir[0] * s, a.at[1] + ta.dir[1] * s] : null;
}

/** Tangent relations at each end of the conic that a line or arc ends on (those it has already left out). */
export function conicEndTangents(g: SketchGeometry, conic: string): NewConstraint[] {
    const c = curveOf(g, conic);
    if (c?.kind !== 'conic') {
        return [];
    }
    const out: NewConstraint[] = [];
    for (const end of [c.start, c.end]) {
        const other = [...g.curves].reverse().find((k) => k.id !== conic && (k.kind === 'line' || k.kind === 'arc') && curveEndIds(k).includes(end));
        const has = other && g.constraints.some((k) => k.kind === 'tangent' && [k.a, k.b].includes(conic) && [k.a, k.b].includes(other.id));
        if (other && !has) {
            out.push({ kind: 'tangent', a: other.id, b: conic });
        }
    }
    return out;
}

/** Whether the conic is held tangent at both of its ends. */
export function conicTangentBothEnds(g: SketchGeometry, conic: string): boolean {
    const c = curveOf(g, conic);
    if (c?.kind !== 'conic') {
        return false;
    }
    const ends = (id: string) => {
        const k = curveOf(g, id);
        return k ? curveEndIds(k) : [];
    };
    return [c.start, c.end].every((end) => g.constraints.some((k) => k.kind === 'tangent' && (k.a === conic || k.b === conic)
        && ends(k.a === conic ? k.b : k.a).includes(end)));
}

/** The conic with or without its end tangents (Auto tangency on an existing conic). */
export function setConicTangency(g: SketchGeometry, conic: string, on: boolean): SketchGeometry {
    if (on) {
        return conicEndTangents(g, conic).reduce((out, k) => addConstraint(out, k).g, g);
    }
    const c = curveOf(g, conic);
    if (c?.kind !== 'conic') {
        return g;
    }
    return { ...g, constraints: g.constraints.filter((k) => !(k.kind === 'tangent' && [k.a, k.b].includes(conic))) };
}

export type ConicStep = { draft: PointRef[] } | { g: SketchGeometry; draft: PointRef[]; chainStart: null } | { error: string };

/**
 * A click of the Conic tool: its plain sequence (both ends, the top vertex, Rho); with Auto tangency the top vertex
 * comes from the ends' tangents when both ends are on lines or arcs, and the conic is made tangent where it joins.
 */
export function conicStep(g: SketchGeometry, draft: PointRef[], ref: PointRef, auto: boolean): ConicStep {
    if (auto && draft.length === 1 && pointOf(g, ref.point ?? '') && Math.hypot(ref.at[0] - draft[0].at[0], ref.at[1] - draft[0].at[1]) > 1e-6) {
        const top = autoTopVertex(g, draft[0], ref);
        if (top) {
            return { draft: [draft[0], ref, { at: top }] };
        }
    }
    const r = placeConic('conic', g, draft, ref, 0);
    if ('message' in r) {
        return { error: r.message };
    }
    if ('draft' in r) {
        return { draft: r.draft };
    }
    return { g: auto ? setConicTangency(r.g, r.id, true) : r.g, draft: [], chainStart: null };
}
