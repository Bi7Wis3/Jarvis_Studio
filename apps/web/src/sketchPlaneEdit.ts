// Edit Sketch Plane (SolidWorks: right-click a sketch in the FeatureManager > Edit Sketch Plane): moves an existing
// sketch step to another plane or flat face. The sketch opens for editing at the plane choice; the plane or face
// clicked next becomes its plane, its geometry unchanged in its own coordinates. Leaving the sketch saves it (Cancel
// in the plane form leaves it as it was).

import { editItem } from './state';
import { useSketcher } from './sketcher';

export function editSketchPlane(partId: string, featureId: string): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = useSketcher.subscribe((s) => {
        if (s.active && s.edit?.partId === partId && s.edit.featureId === featureId && s.stage === 'draw') {
            stop();
            clearTimeout(timer);
            useSketcher.setState({ stage: 'plane', message: 'Pick the new plane or flat face for this sketch.' });
        }
    });
    // The sketch opens through the toolbar's editor; give up waiting if it does not.
    timer = setTimeout(stop, 10000);
    editItem(partId, featureId);
}
