// Pure helpers for history edits that follow the SolidWorks FeatureManager: inserting at the rollback bar, and
// what suppressing or deleting a step does to the steps that depend on it.

import type { Feature, Project } from '@jarvis/core';
import { stepRefs } from './historyText';

/**
 * The first step below the rollback bar of `partId` (new features are inserted before it), or null when the part
 * is not rolled back.
 */
export function stepAtBar(project: Pick<Project, 'parts' | 'view'> | null, partId: string): string | null {
    const rollback = project?.view?.rollback;
    const features = project?.parts.find((p) => p.id === partId)?.features ?? [];
    if (!rollback || rollback.partId !== partId || rollback.count >= features.length) {
        return null;
    }
    return features[Math.max(0, rollback.count)].id;
}

/** Steps that build on `id`, directly or through other steps (its children), in history order. */
export function dependants(features: readonly Feature[], id: string): Feature[] {
    const found = new Set([id]);
    // Users always come later, so one pass in order finds the whole chain.
    for (const f of features) {
        if (!found.has(f.id) && stepRefs(f).some((ref) => found.has(ref))) {
            found.add(f.id);
        }
    }
    return features.filter((f) => f.id !== id && found.has(f.id));
}

/** Steps `id` builds on, directly or through other steps (its parents), in history order. */
export function ancestors(features: readonly Feature[], id: string): Feature[] {
    const byId = new Map(features.map((f) => [f.id, f]));
    const found = new Set<string>();
    const visit = (step: string) => {
        for (const ref of stepRefs(byId.get(step)!).filter((r) => byId.has(r))) {
            if (!found.has(ref)) {
                found.add(ref);
                visit(ref);
            }
        }
    };
    if (byId.has(id)) {
        visit(id);
    }
    return features.filter((f) => found.has(f.id));
}

/**
 * features_update entries for suppressing a step: it and every step built on it (suppressing a sketch suppresses
 * the features made from it), as SolidWorks does. Steps already suppressed are left alone.
 */
export function suppressUpdates(features: readonly Feature[], id: string): { id: string; suppressed: true }[] {
    const own = features.find((f) => f.id === id);
    return [...(own ? [own] : []), ...dependants(features, id)]
        .filter((f) => !f.suppressed)
        .map((f) => ({ id: f.id, suppressed: true as const }));
}

/**
 * features_update entries for unsuppressing a step: it and the suppressed steps it builds on (a child cannot be
 * built without its parents); with `withDependants`, also the steps built on it (Unsuppress with dependents).
 */
export function unsuppressUpdates(features: readonly Feature[], id: string, withDependants: boolean): { id: string; suppressed: false }[] {
    const ids = new Set([id, ...ancestors(features, id).map((f) => f.id)]);
    if (withDependants) {
        dependants(features, id).forEach((f) => ids.add(f.id));
    }
    return features
        .filter((f) => ids.has(f.id) && f.suppressed)
        .map((f) => ({ id: f.id, suppressed: false as const }));
}

/**
 * The steps deleting `id` removes: it, its children (every step built on it, which would otherwise be left
 * pointing at nothing) and, with `absorbed`, the sketch steps that only the deleted steps use. History order.
 */
export function deletionIds(features: readonly Feature[], id: string, absorbed: boolean): string[] {
    const ids = new Set([id, ...dependants(features, id).map((f) => f.id)]);
    if (absorbed) {
        let grew = true;
        while (grew) {
            grew = false;
            for (const f of features) {
                if (ids.has(f.id) || f.op !== 'sketch') {
                    continue;
                }
                const users = features.filter((g) => stepRefs(g).includes(f.id));
                if (users.length && users.every((g) => ids.has(g.id))) {
                    ids.add(f.id);
                    grew = true;
                }
            }
        }
    }
    return features.filter((f) => ids.has(f.id)).map((f) => f.id);
}
