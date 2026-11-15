// Reference steps taken from the model drawn where the kernel finds them now: the mesh status carries each part's
// plane, axis and point steps as found at the last rebuild (apps/server/src/cad/followRefs.ts), and they replace the
// project's own copies, which still hold where the references were when picked. Everything that resolves planes in
// the view (reference geometry, sketches on those planes, the sketch frame sent to the kernel) then agrees with the
// kernel. A step changed since that rebuild keeps its own values until the next one arrives.

import type { Feature, MeshStatus, Project } from '@jarvis/core';
import { withoutFollowCaches } from '@jarvis/core/reference';

/** Whether two copies of a step differ only in where their references were found (and in name: renaming builds nothing). */
const same = (a: Feature, b: Feature): boolean =>
    JSON.stringify(withoutFollowCaches({ ...a, name: undefined })) === JSON.stringify(withoutFollowCaches({ ...b, name: undefined }));

/** The project with its reference steps where the kernel found them; the same object when nothing changes. */
export function withFollowed(project: Project, followed: MeshStatus['followed']): Project {
    if (!followed) {
        return project;
    }
    let changed = false;
    const parts = project.parts.map((part) => {
        const found = followed[part.id];
        if (!found || !part.features?.length) {
            return part;
        }
        let touched = false;
        const features = part.features.map((f) => {
            const next = found[f.id];
            if (!next || next.op !== f.op || !same(next, f)) {
                return f;
            }
            const { name: _name, ...rest } = next;
            const merged = { ...f, ...rest } as Feature;
            if (JSON.stringify(merged) === JSON.stringify(f)) {
                return f;
            }
            touched = true;
            return merged;
        });
        if (!touched) {
            return part;
        }
        changed = true;
        return { ...part, features };
    });
    return changed ? { ...project, parts } : project;
}
