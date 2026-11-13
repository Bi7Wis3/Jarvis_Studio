// Sketch definition state for the feature tree, SolidWorks style: "(-) " under-defined, "(+) " over-defined (a
// conflict or a redundant relation), "(?) " cannot be solved, nothing when fully defined. Solved once per sketch geometry and cached;
// display only.

import type { Feature, SketchGeometry } from '@jarvis/core';
import { solveGeometry, solverReady } from './solver';

export type DefinitionMark = '' | '(-) ' | '(+) ' | '(?) ';

const byObject = new WeakMap<SketchGeometry, DefinitionMark>();
const byText = new Map<string, DefinitionMark>();
const TEXT_CACHE = 300;

/**
 * The mark from a solve result: a conflict or a redundant relation (over defined) wins; a solve that fails without
 * one cannot be solved; then free degrees of freedom.
 */
export function markFor(result: { ok: boolean; dof: number; conflicting: string[]; redundant?: string[] }): DefinitionMark {
    if (result.conflicting.length || result.redundant?.length) {
        return '(+) ';
    }
    if (!result.ok) {
        return '(?) ';
    }
    return result.dof > 0 ? '(-) ' : '';
}

/**
 * The definition mark of a sketch's geometry; null while the solver is not loaded (show nothing yet). A sketch
 * written directly as profiles (no geometry) has no mark.
 */
export function definitionMark(geometry: SketchGeometry | undefined): DefinitionMark | null {
    if (!geometry) {
        return '';
    }
    const known = byObject.get(geometry);
    if (known !== undefined) {
        return known;
    }
    // History updates arrive as new objects: the text key keeps an unchanged sketch from being solved again.
    const text = JSON.stringify(geometry);
    let mark = byText.get(text);
    if (mark === undefined) {
        if (!solverReady()) {
            return null;
        }
        mark = markFor(solveGeometry(geometry));
        if (byText.size >= TEXT_CACHE) {
            byText.clear();
        }
        byText.set(text, mark);
    }
    byObject.set(geometry, mark);
    return mark;
}

// ---- Recently added or edited steps (the tree's History folder) ----

export interface RecentSteps {
    /** Each step's content when last seen, by id. */
    seen: Map<string, string>;
    /** Step ids, most recent first. */
    recent: string[];
}

/**
 * Updates the recent steps for a new feature list: steps that are new or whose content changed move to the front.
 * The first call (no state) only records what is there; steps that are gone drop out.
 */
export function updateRecent(state: RecentSteps | null, features: Feature[], limit = 5): RecentSteps {
    const seen = new Map(features.map((f) => [f.id, JSON.stringify(f)]));
    if (!state) {
        return { seen, recent: [] };
    }
    const touched = features.filter((f) => state.seen.get(f.id) !== seen.get(f.id)).map((f) => f.id).reverse();
    const recent = [...touched, ...state.recent.filter((id) => seen.has(id) && !touched.includes(id))].slice(0, limit);
    return { seen, recent };
}
