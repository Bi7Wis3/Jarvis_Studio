// Copying and pasting entire sketches (SolidWorks: select a closed sketch in the tree, Ctrl+C; click a face of the part
// and Ctrl+V, or paste into an open sketch). A copied sketch goes to the sketch clipboard as one piece with its
// relations and dimensions: Ctrl+V in an open sketch pastes it at the pointer; Paste sketch on a face makes a new
// sketch there with the sketch's centre where the face was clicked; on a plane, a new sketch keeping the sketch's
// own coordinates.

import type { Part, Sketch, SketchGeometry, SketchPlane } from '@jarvis/core';
import { fragmentOf, getClipboard, pasteFragment, setClipboard } from './sketchClipboard';
import { EMPTY_GEOMETRY, profilesToGeometry } from './sketchGeometry';
import { chooseFace, choosePlane, commitGeometry, startSketch, useSketcher } from './sketcher';
import type { Pt } from './sketchMath';

/** Where a copied sketch goes: a face clicked on (its spot), or a plane. */
export type PasteTarget = { face: { point: [number, number, number]; normal: [number, number, number]; curved: boolean } } | { plane: SketchPlane; offset?: number };

let copiedName: string | null = null;

/** Whether the sketch clipboard holds a whole sketch (Paste sketch is offered on faces and planes). */
export const hasCopiedSketch = (): boolean => !!copiedName && !!getClipboard();

/** The sketch's entities with their relations, for pasting; null for an empty sketch. */
export function sketchFragment(sketch: Sketch): ReturnType<typeof fragmentOf> {
    const g: SketchGeometry = sketch.geometry ?? profilesToGeometry(sketch.profiles);
    return fragmentOf(g, [...g.curves.map((c) => c.id), ...g.points.map((p) => p.id)]);
}

/** Copy sketch: the whole sketch goes to the sketch clipboard. Returns an error to show, or null. */
export function copyWholeSketch(sketch: Sketch, name: string): string | null {
    const f = sketchFragment(sketch);
    if (!f) {
        return `${name} is empty: there is nothing to copy.`;
    }
    setClipboard(f);
    copiedName = name;
    return null;
}

/** The copied sketch in a new geometry, its centre at `at` (null: where it was). */
export function pastedGeometry(at: Pt | null): SketchGeometry | null {
    const f = getClipboard();
    return f ? pasteFragment(EMPTY_GEOMETRY, f, at ?? f.centre).g : null;
}

/**
 * Paste sketch: a new sketch on the face or plane holding the copied one, saved as a sketch step. Returns an error
 * to show, or null.
 */
export function pasteWholeSketch(partId: string, target: PasteTarget): string | null {
    if (!hasCopiedSketch()) {
        return 'Copy a sketch first (right-click it, Copy sketch).';
    }
    startSketch(partId, 'sketch');
    if ('face' in target) {
        chooseFace(target.face.normal, target.face.point, target.face.curved);
    } else {
        choosePlane(target.plane, target.offset ?? 0);
    }
    const g = pastedGeometry('face' in target ? useSketcher.getState().anchor : null)!;
    if (!commitGeometry(g)) {
        return useSketcher.getState().message ?? 'The copied sketch does not solve here.';
    }
    useSketcher.setState({ message: `Pasted ${copiedName}.`, tool: 'select' });
    // Saved at once, as a new sketch step (the same as Exit sketch).
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: 'sk-finish' })), 0);
    return null;
}

/** Ctrl+C on a sketch step in the tree, Ctrl+V on a plane: true when the key was used. */
export function treeClipboardKey(key: string, part: Part, stepId: string | null, basePlane: 'front' | 'top' | 'right' | null, say: (text: string) => void): boolean {
    const step = stepId ? part.features?.find((f) => f.id === stepId) : null;
    if (key === 'c' && step?.op === 'sketch') {
        const error = copyWholeSketch(step.sketch, step.name ?? 'the sketch');
        if (error) {
            say(error);
        }
        return true;
    }
    if (key === 'v' && hasCopiedSketch() && (basePlane || step?.op === 'plane')) {
        const error = pasteWholeSketch(part.id, { plane: basePlane ?? { planeRef: step!.id } });
        if (error) {
            say(error);
        }
        return true;
    }
    return false;
}
