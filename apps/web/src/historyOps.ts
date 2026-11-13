// Pure helpers for history edits that follow the SolidWorks FeatureManager: inserting at the rollback bar, and
// what suppressing or deleting a step does to the steps that depend on it.

import type { Project } from '@jarvis/core';

/**
 * The first step below the rollback bar of `partId` (new features are inserted before it), or null when the part
 * is not rolled back.
 */
export function stepAtBar(project: Pick<Project, 'parts' | 'view'> | null, partId: string): string | null {
    const rollback = project?.view.rollback;
    const features = project?.parts.find((p) => p.id === partId)?.features ?? [];
    if (!rollback || rollback.partId !== partId || rollback.count >= features.length) {
        return null;
    }
    return features[Math.max(0, rollback.count)].id;
}
