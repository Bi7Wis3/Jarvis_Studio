// Components selected in the assembly tree besides the selected part (a folder's parts, a Ctrl or Shift selection):
// the view lights them as it lights the selected part, as SolidWorks highlights a selected folder's components.

import { create } from 'zustand';
import { useStudio } from './state';

const usePicks = create<{ parts: ReadonlySet<string> }>(() => ({ parts: new Set() }));

export function setComponentPicks(ids: readonly string[]): void {
    const now = usePicks.getState().parts;
    if (now.size === ids.length && ids.every((id) => now.has(id))) {
        return;
    }
    usePicks.setState({ parts: new Set(ids) });
}

/** Is this part selected in the assembly tree (the part workspace lights nothing)? */
export function useComponentPicked(partId: string): boolean {
    const picked = usePicks((s) => s.parts.has(partId));
    const assembly = useStudio((s) => s.workspace !== 'part');
    return picked && assembly;
}
