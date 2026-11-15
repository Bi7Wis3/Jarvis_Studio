// The sketch bar under the toolbar: what it says (plane, status), and Discard's question, asked in the bar itself
// rather than in a browser dialog.

import { create } from 'zustand';
import type { SketchGeometry, SketchPlane } from '@jarvis/core';
import { closeSketch, useSketcher } from './sketcher';
import { clearEditing } from './state';
import { ORIGIN } from './solver';
import { planeLabel } from './sketchMath';
import { valueText } from './numberText';

/** A form of the sketcher: every sketch tool's id starts with sk- (the model's tools never do). */
export const isSketchForm = (tool: { id: string }): boolean => tool.id.startsWith('sk-');

/** The plane and its offset as the bar shows them: the plane's name in capitals, the unit as written (mm). */
export function sketchPlaneText(plane: SketchPlane, offset: number): string {
    return `${planeLabel(plane).toUpperCase()}${offset ? ` ${offset > 0 ? '+' : ''}${valueText(offset)} mm` : ''}`;
}

/** The sketch status: empty only with nothing drawn (sketch points alone have degrees of freedom too). */
export function sketchStatusText(g: SketchGeometry, dof: number, over: boolean): string {
    const drawn = g.curves.length > 0 || g.points.some((p) => p.id !== ORIGIN);
    if (!drawn) {
        return 'empty';
    }
    return dof < 0 ? '…' : over ? 'Over defined' : dof === 0 ? 'Fully defined' : `Under defined · ${dof} DOF`;
}

// ---- Discard ---------------------------------------------------------------------------------------------------

interface DiscardAsk {
    /** Discard is waiting for an answer in the bar; `then` runs once the sketch is left (a workspace switch). */
    asking: { then: (() => void) | null } | null;
}

export const useDiscardAsk = create<DiscardAsk>(() => ({ asking: null }));

/** Whether leaving would lose work: a new sketch with something drawn, or an edited one that was changed. */
function unsaved(): boolean {
    const { undo, geometry, edit } = useSketcher.getState();
    return edit ? undo.length > 0 : geometry.curves.length > 0 || geometry.points.some((p) => p.id !== ORIGIN);
}

function leave(then: (() => void) | null): void {
    useDiscardAsk.setState({ asking: null });
    closeSketch(true);
    clearEditing();
    then?.();
}

/** Leaves the sketch without saving it; with unsaved work the bar asks first, and `then` waits for the answer. */
export function askDiscard(then: (() => void) | null = null): void {
    if (unsaved()) {
        useDiscardAsk.setState({ asking: { then } });
        return;
    }
    leave(then);
}

/** The answer Discard: the sketch is left without saving it. */
export function confirmDiscard(): void {
    leave(useDiscardAsk.getState().asking?.then ?? null);
}

/** The answer Keep: back to the sketch as it was. */
export function keepSketch(): void {
    useDiscardAsk.setState({ asking: null });
}

// A sketch that ends some other way takes its question with it; a new one starts without one.
useSketcher.subscribe((s, prev) => {
    if (prev.active !== s.active && useDiscardAsk.getState().asking) {
        useDiscardAsk.setState({ asking: null });
    }
});
