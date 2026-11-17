// How the assembly's mates stand, for the tree (red and yellow marks, component prefixes) and for dragging (which
// components can move): the solver's analysis of the project as the server sent it, worked out once per state.

import type { Part, Vec3 } from '@jarvis/core';
import { fixedParts, MateSystem, solveAssembly, type AssemblyMates, type AssemblyResult, type ComponentState } from '@jarvis/core/mates';
import { useStudio } from '../state';

const EMPTY: AssemblyResult = { placements: {}, mates: {}, components: {}, dof: {}, converged: true };
let last: { parts: readonly Part[]; assembly: AssemblyMates | undefined; result: AssemblyResult } | null = null;

/** The analysis of the mates of these parts (cached for the same parts and mates). */
export function analyseMates(parts: readonly Part[], assembly: AssemblyMates | undefined): AssemblyResult {
    if (last && last.parts === parts && last.assembly === assembly) {
        return last.result;
    }
    const result = parts.length ? solveAssembly(parts, assembly, { analyse: true }) : EMPTY;
    last = { parts, assembly, result };
    return result;
}

/** The analysis of the project as shown in the tree. */
export function useMateAnalysis(): AssemblyResult {
    const parts = useStudio((s) => s.history?.parts);
    const assembly = useStudio((s) => s.history?.assembly);
    return parts ? analyseMates(parts, assembly) : EMPTY;
}

/** The prefix SolidWorks puts before a component's name. */
export const PREFIX: Record<ComponentState, string> = { fixed: '(f) ', under: '(-) ', over: '(+) ', unsolved: '(?) ', defined: '' };

export const PREFIX_TITLE: Record<ComponentState, string> = {
    fixed: 'Fixed: it does not move',
    under: 'Under defined: it can still move',
    over: 'Over defined: conflicting or redundant mates hold it',
    unsolved: 'Not solved: a mate on it cannot be solved',
    defined: 'Fully defined by its mates',
};

/** A component's prefix as the tree shows it. */
export function useComponentState(partId: string): { state: ComponentState; dof: number } | null {
    const analysis = useMateAnalysis();
    const state = analysis.components[partId];
    return state ? { state, dof: analysis.dof[partId] ?? 0 } : null;
}

/**
 * The parts_update entries that place a part (`change`: its new position and/or rotation) with its mates kept: the
 * part where it was asked to go as far as its mates let it, and the floating parts mated to it following. A fixed
 * part goes where it is asked (an explicit placement), the floating parts mated to it following it.
 */
export function matedUpdates(partId: string, change: { position?: Vec3; rotation?: Vec3 }): Record<string, unknown>[] {
    const history = useStudio.getState().history;
    const part = history?.parts.find((p) => p.id === partId);
    const assembly = history?.assembly;
    if (!history || !part || !assembly?.mates.some((m) => !m.suppressed && m.refs.some((r) => r.part === partId))) {
        return [{ id: partId, ...change }];
    }
    const target = { position: change.position ?? part.position, rotation: change.rotation ?? part.rotation };
    const errors = analyseMates(history.parts, assembly).mates;
    const exclude = new Set(Object.entries(errors).filter(([, s]) => s.state === 'error').map(([id]) => id));
    const out: Record<string, unknown>[] = [];
    if (fixedParts(history.parts, assembly).has(partId)) {
        const moved = history.parts.map((p) => (p.id === partId ? { ...p, ...target } : p));
        const solved = new MateSystem(moved, assembly, { exclude }).solve({ only: moved.filter((p) => p.id !== partId).map((p) => p.id) });
        out.push({ id: partId, ...change });
        for (const [id, placement] of Object.entries(solved.placements)) {
            out.push({ id, ...placement });
        }
        return out;
    }
    const placements = new MateSystem(history.parts, assembly, { exclude }).drag({ part: partId, placement: target });
    for (const [id, placement] of Object.entries(placements)) {
        out.push({ id, ...placement });
    }
    return out.length ? out : [{ id: partId, ...change }];
}
