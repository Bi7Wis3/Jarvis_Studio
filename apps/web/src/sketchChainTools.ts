// Select Chain (SolidWorks: the entities attached to the picked one both ways, until a branch) and Reverse Endpoint
// Tangent (an arc flips over to the other side of its ends, still tangent where it was: the rest of its circle).

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf } from './solver';
import { curveEndIds } from './sketchCurves';
import { extentHeld } from './sketchGeometry';

/** A curve's two ends, or none (circles, full ellipses, closed splines). */
function openEnds(c: SketchCurve): [string, string] | null {
    const ends = curveEndIds(c);
    return ends.length === 2 && ends[0] !== ends[1] ? [ends[0], ends[1]] : null;
}

/**
 * The chain `id` belongs to: from it, both ways, every curve joined end to end (construction curves too), as far as
 * a point where more than two curves meet. A closed curve is a chain on its own.
 */
export function selectChainOf(g: SketchGeometry, id: string): string[] {
    const start = curveOf(g, id);
    if (!start) {
        return [];
    }
    const first = openEnds(start);
    if (!first) {
        return [id];
    }
    const at = new Map<string, string[]>();
    for (const c of g.curves) {
        for (const p of openEnds(c) ?? []) {
            at.set(p, [...(at.get(p) ?? []), c.id]);
        }
    }
    const chain = [id];
    const seen = new Set(chain);
    const grow = (from: string, forward: boolean) => {
        let point = from;
        for (;;) {
            const sharing = at.get(point) ?? [];
            if (sharing.length !== 2) {
                return;
            }
            const next = sharing.find((c) => !seen.has(c));
            if (!next) {
                return;
            }
            seen.add(next);
            if (forward) {
                chain.push(next);
            } else {
                chain.unshift(next);
            }
            const ends = openEnds(curveOf(g, next)!)!;
            point = ends[0] === point ? ends[1] : ends[0];
        }
    };
    grow(first[1], true);
    grow(first[0], false);
    return chain;
}

/** The chains of all these curves together (Ctrl-picked entities of several chains: every chain). */
export function selectChains(g: SketchGeometry, ids: string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
        for (const c of selectChainOf(g, id)) {
            if (!out.includes(c)) {
                out.push(c);
            }
        }
    }
    return out;
}

/**
 * Reverse Endpoint Tangent: the arc runs round the other part of its circle, between the same ends. It leaves each end
 * the opposite way, so it stays tangent to what it is tangent to there, on the other side. Dimensions of its length
 * go (it is a different length now); its radius and its relations stay.
 */
export function reverseEndpointTangent(g: SketchGeometry, id: string): SketchGeometry | { error: string } {
    const c = curveOf(g, id);
    if (c?.kind !== 'arc') {
        return { error: 'Reverse endpoint tangent works on an arc.' };
    }
    return {
        ...g,
        curves: g.curves.map((k) => (k.id === id ? { ...c, start: c.end, end: c.start } : k)),
        constraints: g.constraints.filter((k) => !extentHeld(k, id)),
    };
}
