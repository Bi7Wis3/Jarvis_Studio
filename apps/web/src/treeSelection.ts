// Selection between the feature tree and the view, as SolidWorks links them: what is selected in the tree (a step,
// or a folder's steps) is drawn highlighted in the view where the view draws it (sketches, reference geometry), and
// a sketch or reference step clicked in the view is selected in the tree (or its closed folder is highlighted).

import { create } from 'zustand';

interface TreePicks {
    partId: string | null;
    steps: ReadonlySet<string>;
}

export const useTreePicks = create<TreePicks>(() => ({ partId: null, steps: new Set() }));

export function setTreePicks(partId: string | null, steps: readonly string[]): void {
    const s = useTreePicks.getState();
    if (s.partId === partId && s.steps.size === steps.length && steps.every((id) => s.steps.has(id))) {
        return;
    }
    useTreePicks.setState({ partId, steps: new Set(steps) });
}

/** Is this step of the part selected in the feature tree? */
export function useTreePicked(partId: string, stepId: string): boolean {
    return useTreePicks((s) => s.partId === partId && s.steps.has(stepId));
}

/** The last step clicked in the view (`n` counts clicks, so clicking the same one again selects it again). */
export const useViewPick = create<{ partId: string | null; stepId: string | null; n: number }>(() => ({ partId: null, stepId: null, n: 0 }));

export function viewPick(partId: string, stepId: string): void {
    useViewPick.setState((s) => ({ partId, stepId, n: s.n + 1 }));
}
