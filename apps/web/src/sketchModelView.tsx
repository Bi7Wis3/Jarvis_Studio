// Draws, on the sketch plane, what a model tool would add (a see-through ghost) and the model edge or corner under
// the cursor for the dimension and relation tools.

import { EntityLine } from './SketchDrawing';
import { useSketchModel } from './sketchModel';

const GHOST = '#7fd3ff';
const HOVER = '#ffb347';

export function ModelPreview() {
    const preview = useSketchModel((s) => s.preview);
    const picking = useSketchModel((s) => s.picking);
    const hover = useSketchModel((s) => s.hover);
    return (
        <>
            {picking !== null && preview.map((e, i) => <EntityLine key={`model-${i}`} entity={e} color={GHOST} dashed width={2.4} />)}
            {hover && <EntityLine entity={hover} color={HOVER} width={3.2} />}
        </>
    );
}
