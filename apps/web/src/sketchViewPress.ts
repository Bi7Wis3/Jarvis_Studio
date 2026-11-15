// Presses in the sketch view that the whole-sketch tools take before the sketcher sees them: Modify Sketch's drag,
// Instant2D's value handles, and a shaded contour dragged as a whole. Each drag follows the pointer until release.

import { sketchPointAt } from './SketchDrawing';
import { modifyDown, modifyMove, modifyUp } from './sketchModifyDrag';
import { instant2dDown, instant2dMove, instant2dUp } from './sketchInstant2d';
import { contourDown } from './sketchContours';
import type { Pt } from './sketchMath';

/** Follows the pointer with `move` until the button of `event` is released, then calls `up`. */
function follow(event: PointerEvent, move: (p: Pt) => void, up: () => void): void {
    const onMove = (e: PointerEvent) => {
        const at = sketchPointAt(e.clientX, e.clientY);
        if (at) {
            move(at.p);
        }
    };
    const onUp = (e: PointerEvent) => {
        if (e.button !== event.button) {
            return;
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        up();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
}

/** A press in the sketch view: true when one of these tools takes it (the view must then stay still). */
export function viewPress(event: PointerEvent): boolean {
    const hit = sketchPointAt(event.clientX, event.clientY);
    if (!hit) {
        return false;
    }
    if (modifyDown(event.button, hit.p, hit.tolerance)) {
        follow(event, modifyMove, () => void modifyUp());
        return true;
    }
    if (event.button === 0 && instant2dDown(hit.p, hit.tolerance / 10)) {
        follow(event, instant2dMove, instant2dUp);
        return true;
    }
    // A shaded contour pressed with the select tool: the sketcher drags its entity (and solves as it goes).
    return event.button === 0 && contourDown(hit.p, hit.tolerance, event.altKey);
}
