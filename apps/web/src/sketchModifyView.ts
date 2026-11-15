// Modify Sketch's flip symbols in the view (see sketchModifyDrag.ts; its drags come in through sketchViewPress.ts): a
// right press on one is taken before the view sees it, so it flips without opening the right-click menu.

import { useEffect } from 'react';
import { sketchPointAt } from './SketchDrawing';
import { ARM_PX, flipAt, useModifyDrag } from './sketchModifyDrag';
import { flipWholeSketch } from './sketchMoreTools';
import { useSketcher } from './sketcher';

/** While the Modify Sketch form is open: a right press on a flip symbol of the black origin flips the sketch. */
export function useFlipSymbols(): void {
    useEffect(() => {
        const down = (event: PointerEvent) => {
            const s = useSketcher.getState();
            if (event.button !== 2 || !(event.target instanceof HTMLCanvasElement) || !useModifyDrag.getState().open || !s.active || s.stage !== 'draw') {
                return;
            }
            const hit = sketchPointAt(event.clientX, event.clientY);
            const about = hit ? flipAt(hit.p, (ARM_PX / 10) * hit.tolerance, hit.tolerance) : null;
            if (!about) {
                return;
            }
            event.stopPropagation();
            event.preventDefault();
            const result = flipWholeSketch(about);
            if (result) {
                useSketcher.setState({ message: result });
            }
        };
        window.addEventListener('pointerdown', down, { capture: true });
        return () => window.removeEventListener('pointerdown', down, { capture: true });
    }, []);
}
