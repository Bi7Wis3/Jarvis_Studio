// Fully Define Sketch's Calculate (SolidWorks: Calculate analyses the sketch and generates the relations and dimensions):
// what OK would add, worked out on the sketch as it is and kept for the view to draw as ghosts. Nothing changes until
// OK; a change of the options, the selection or the sketch drops the calculation.

import { create } from 'zustand';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { solveGeometry, type SolveResult } from './solver';
import { fullyDefineWith, type FullyDefineOptions } from './sketchFullyDefine';

export interface FullyDefinePreview {
    /** The sketch it was worked out on, and the solved sketch with the additions. */
    base: SketchGeometry;
    result: SketchGeometry;
    /** The relations and dimensions OK would add. */
    added: SketchConstraint[];
    relations: number;
    dimensions: number;
    dof: number;
}

export const useFullyDefinePreview = create<{ preview: FullyDefinePreview | null; text: string | null }>(() => ({ preview: null, text: null }));

/** What Calculate finds for these options on `g`, or why it finds nothing. */
export function calculateFullyDefine(g: SketchGeometry, o: FullyDefineOptions, solve: (g: SketchGeometry) => SolveResult = solveGeometry):
    FullyDefinePreview | { error: string } {
    const r = fullyDefineWith(g, o, solve);
    if ('error' in r) {
        return r;
    }
    const before = new Set(g.constraints.map((c) => c.id));
    return { base: g, result: r.g, added: r.g.constraints.filter((c) => !before.has(c.id)), relations: r.relations, dimensions: r.dimensions, dof: r.dof };
}

/** The sentence under Calculate. */
export function previewText(p: FullyDefinePreview): string {
    const left = p.dof === 0 ? 'the sketch would be fully defined' : `${p.dof} degree${p.dof === 1 ? '' : 's'} of freedom would be left`;
    if (!p.added.length) {
        return p.dof === 0 ? 'The sketch is fully defined already.' : `Nothing can be added; ${left}.`;
    }
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
    return `${n(p.relations, 'relation')} and ${n(p.dimensions, 'dimension')} to add, shown in the view; ${left}. OK adds them.`;
}

export function showFullyDefinePreview(r: FullyDefinePreview | { error: string }): void {
    useFullyDefinePreview.setState('error' in r ? { preview: null, text: r.error } : { preview: r, text: previewText(r) });
}

export function clearFullyDefinePreview(): void {
    const s = useFullyDefinePreview.getState();
    if (s.preview || s.text) {
        useFullyDefinePreview.setState({ preview: null, text: null });
    }
}
