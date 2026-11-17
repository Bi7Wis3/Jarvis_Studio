// One drag of a component in the assembly (ComponentDrag.tsx), apart from the pointer handling: which components
// may be dragged, where the pull puts them (their mates kept), the project as shown meanwhile, the project put back
// on Esc, and the one parts_update that saves the drag (one undo step).

import type { Project, Vec3 } from '@jarvis/core';
import { MateSystem, type Placement } from '@jarvis/core/mates';
import { analyseMates } from './mateAnalysis';

export class DragSession {
    /** Where the drag has put each component it moved (the dragged one and the floating ones mated to it). */
    private placements: Record<string, Placement> = {};

    private constructor(private readonly system: MateSystem, readonly part: string, readonly copy: number, readonly grab: Vec3) {}

    /**
     * A drag of `part` (copy `copy`) by the point `grab` of it (part frame), or null when it may not move: a fixed or
     * fully defined component (the view turns instead). Mates in error are left out, as they hold nothing.
     */
    static start(history: Project, part: string, copy: number, grab: Vec3): DragSession | null {
        const analysis = analyseMates(history.parts, history.assembly);
        const state = analysis.components[part];
        if (!history.parts.some((p) => p.id === part) || state === 'fixed' || state === 'defined') {
            return null;
        }
        const exclude = new Set(Object.entries(analysis.mates).filter(([, s]) => s.state === 'error').map(([id]) => id));
        return new DragSession(new MateSystem(history.parts, history.assembly, { exclude }), part, copy, grab);
    }

    /** Pulls the grabbed point towards the pointer's ray; returns every placement the drag has changed so far. */
    pull(ray: { origin: Vec3; direction: Vec3 }): Record<string, Placement> {
        this.placements = { ...this.placements, ...this.system.drag({ part: this.part, copy: this.copy, grab: this.grab, ray }) };
        return this.placements;
    }

    /** The project as shown during the drag: the moved components where the drag has put them. */
    shown(project: Project): Project {
        return { ...project, parts: project.parts.map((p) => (this.placements[p.id] ? { ...p, ...this.placements[p.id] } : p)) };
    }

    /**
     * The project as shown with everything the drag moved put back where the saved project has it (Esc): nothing was
     * sent, so the saved placements are the ones from before the drag.
     */
    restored(project: Project, history: Project): Project {
        return {
            ...project,
            parts: project.parts.map((p) => {
                const saved = this.placements[p.id] ? history.parts.find((q) => q.id === p.id) : undefined;
                return saved ? { ...p, position: saved.position, rotation: saved.rotation } : p;
            }),
        };
    }

    /** The one parts_update that saves the drag, or null when nothing moved. */
    updates(): { id: string; position: Vec3; rotation: Vec3 }[] | null {
        const entries = Object.entries(this.placements);
        return entries.length ? entries.map(([id, p]) => ({ id, position: p.position, rotation: p.rotation })) : null;
    }
}
