// SketchXpert opening by itself (SolidWorks: "Always open this dialog when sketch error occurs"): a change that over
// defines the sketch, or a solve that cannot meet its relations, opens the SketchXpert form in the left panel. A
// sketch that is already over defined when it is opened does not: its status ("Over defined") opens it on a click.

import { useSketcher } from './sketcher';
import { sketchProblems } from './sketchXpert';
import { sketchToggle } from './sketchToggles';
import { useToolSession } from './toolSession';

export const XPERT_TOOL = 'sk-sketchxpert';

type State = ReturnType<typeof useSketcher.getState>;

const grew = (now: string[], before: string[]): boolean => now.some((id) => !before.includes(id));

/** Whether going from `prev` to `s` is a sketch error SketchXpert should open for. */
export function xpertShouldOpen(prev: State, s: State, auto = sketchToggle('xpertAutoOpen')): boolean {
    if (!auto || !s.active || !prev.active || s.stage !== 'draw' || s.edit?.featureId !== prev.edit?.featureId) {
        return false;
    }
    // A change of the user's (one more undo step) that left relations repeating others.
    if (s.geometry !== prev.geometry && s.undo !== prev.undo && s.undo.length && grew(s.redundant, prev.redundant)) {
        return true;
    }
    // A sketch that cannot be solved as it stands (Automatic solve off, then Solve). A refused change leaves the sketch
    // as it was, with nothing for SketchXpert to repair: the check tells the two apart.
    return grew(s.conflicting, prev.conflicting) && !sketchProblems(s.geometry).ok;
}

export function openSketchXpert(): void {
    if (useToolSession.getState().toolId !== XPERT_TOOL && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: XPERT_TOOL }));
    }
}

let installed = false;

/** Starts watching the sketcher (once). */
export function watchSketchErrors(): void {
    if (installed) {
        return;
    }
    installed = true;
    useSketcher.subscribe((s, prev) => {
        if (xpertShouldOpen(prev, s)) {
            // After the change has rendered, so the form opens on the sketch as it now is.
            setTimeout(openSketchXpert, 0);
        }
    });
}
