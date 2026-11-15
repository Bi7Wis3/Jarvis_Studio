// The areas Shaded Sketch Contours draws, kept off the path of a drag: while points are dragged, areas that take long to
// work out are worked out only now and then, so the curves follow the pointer every frame and the shading catches up;
// once the drag ends they are exact again. Picking an area (pressing on it, Alt + click, a feature's region pick) works
// them out itself, exactly, and never uses these.

import { useEffect, useReducer, useRef } from 'react';
import type { SketchGeometry, SketchRegion } from '@jarvis/core';
import { shadedRegions } from './sketchContours';
import { useSketcher } from './sketcher';

/** Areas that take at most this long (ms) are worked out on every move of a drag. */
const BUDGET_MS = 4;
/** Otherwise at most this share of a drag's time goes to them. */
const SHARE = 0.25;

interface Worked {
    geometry: SketchGeometry | null;
    regions: SketchRegion[];
    /** When they were worked out and how long that took (ms). */
    at: number;
    cost: number;
}

/** Whether areas that took `cost` ms, worked out at `at`, are due again at `now` during a drag. */
export function dueWhileDragging(cost: number, at: number, now: number): boolean {
    return cost <= BUDGET_MS || now - at >= cost / SHARE;
}

/** The shaded areas of `geometry` (none when `on` is false), as described above. */
export function useShadedRegions(on: boolean, geometry: SketchGeometry): SketchRegion[] {
    const dragging = useSketcher((s) => !!s.drag);
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    const worked = useRef<Worked>({ geometry: null, regions: [], at: 0, cost: 0 });
    const catchUp = useRef<ReturnType<typeof setTimeout> | null>(null);
    let late = 0;
    if (on && worked.current.geometry !== geometry) {
        const now = performance.now();
        const last = worked.current;
        if (!dragging || !last.geometry || dueWhileDragging(last.cost, last.at, now)) {
            const regions = shadedRegions(geometry);
            const done = performance.now();
            worked.current = { geometry, regions, at: done, cost: done - now };
        } else {
            late = last.cost / SHARE - (now - last.at);
        }
    }
    useEffect(() => {
        if (catchUp.current) {
            clearTimeout(catchUp.current);
            catchUp.current = null;
        }
        if (late > 0) {
            // The pointer may stop here: the shading then catches up without waiting for the next move.
            catchUp.current = setTimeout(() => {
                catchUp.current = null;
                redraw();
            }, late);
        }
    });
    useEffect(() => () => {
        if (catchUp.current) {
            clearTimeout(catchUp.current);
        }
    }, []);
    return on ? worked.current.regions : [];
}
