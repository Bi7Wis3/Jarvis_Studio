// Sketch toggles of the Sketch toolbar and the SketchXpert form (SolidWorks: Shaded Sketch Contours, Instant2D,
// Rapid Sketch, and SketchXpert's "Always open this dialog when sketch error occurs"). Kept in this browser's
// localStorage, apart from the sketch settings form's own settings.

import { create } from 'zustand';

export interface SketchToggles {
    /** Closed contours and sub-contours are shaded; a shaded area can be dragged, and Alt-clicked to extrude it. */
    shadedContours: boolean;
    /** Instant2D: a clicked dimension shows handles to drag its value, with a ruler. */
    instant2d: boolean;
    /** SketchXpert opens by itself when a change over defines the sketch or it cannot be solved. */
    xpertAutoOpen: boolean;
    /** Rapid Sketch: with a draw tool on, pressing on another flat face or plane starts a sketch there. */
    rapidSketch: boolean;
}

export const DEFAULT_TOGGLES: SketchToggles = { shadedContours: true, instant2d: true, xpertAutoOpen: true, rapidSketch: false };

const KEY = 'jarvis.sketch.toggles';

function load(): SketchToggles {
    try {
        const raw = globalThis.localStorage?.getItem(KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return { ...DEFAULT_TOGGLES, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
        return { ...DEFAULT_TOGGLES };
    }
}

export const useSketchToggles = create<SketchToggles>(() => load());

export function setSketchToggle(key: keyof SketchToggles, on: boolean): void {
    useSketchToggles.setState({ [key]: on });
    try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify(useSketchToggles.getState()));
    } catch {
        // Storage can be full or blocked; the toggle still holds for this session.
    }
}

export const sketchToggle = (key: keyof SketchToggles): boolean => useSketchToggles.getState()[key];
