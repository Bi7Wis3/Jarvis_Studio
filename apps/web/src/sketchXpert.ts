// SketchXpert's Diagnose: the sets of relations and dimensions whose removal leaves the sketch solvable and no longer
// over defined, found by trying the ones in conflict (one at a time, then in pairs).

import type { SketchGeometry } from '@jarvis/core';
import { solveGeometry, solverReady } from './solver';
import { unmetConstraints } from './sketchCheck';

export interface XpertSolution {
    /** The relations and dimensions this solution deletes. */
    remove: string[];
    /** The sketch as it solves without them. */
    geometry: SketchGeometry;
}

/** Whether the sketch has a problem SketchXpert deals with, and which items are involved. */
export function sketchProblems(g: SketchGeometry): { ok: boolean; involved: string[] } {
    if (!solverReady()) {
        return { ok: true, involved: [] };
    }
    const r = solveGeometry(g);
    const unmet = r.ok ? unmetConstraints(r.geometry).filter((id) => g.constraints.some((c) => c.id === id)) : [];
    const involved = [...new Set([...r.conflicting, ...r.redundant, ...unmet])];
    return { ok: r.ok && !unmet.length && !r.redundant.length, involved };
}

function without(g: SketchGeometry, ids: string[]): SketchGeometry {
    const gone = new Set(ids);
    return { ...g, constraints: g.constraints.filter((c) => !gone.has(c.id)) };
}

/** Solves `g` and tells whether it is sound: solved, every relation met, nothing repeating another. */
function sound(g: SketchGeometry): SketchGeometry | null {
    const r = solveGeometry(g);
    return r.ok && !r.redundant.length && !unmetConstraints(r.geometry).length ? r.geometry : null;
}

/**
 * Diagnose: the smallest sets (one item, else two) of the items involved whose removal makes the sketch sound. At
 * most `limit` solutions; an empty list when no such set exists among them (Manual repair then).
 */
export function diagnose(g: SketchGeometry, limit = 12): XpertSolution[] {
    const { ok, involved } = sketchProblems(g);
    if (ok || !involved.length) {
        return [];
    }
    const out: XpertSolution[] = [];
    for (const id of involved) {
        const geometry = sound(without(g, [id]));
        if (geometry) {
            out.push({ remove: [id], geometry });
        }
        if (out.length >= limit) {
            return out;
        }
    }
    if (out.length) {
        return out;
    }
    const pool = involved.slice(0, 14);
    for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
            const geometry = sound(without(g, [pool[i], pool[j]]));
            if (geometry) {
                out.push({ remove: [pool[i], pool[j]], geometry });
                if (out.length >= limit) {
                    return out;
                }
            }
        }
    }
    return out;
}
