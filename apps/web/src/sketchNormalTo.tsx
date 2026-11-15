// Normal To in an open 2D sketch (SolidWorks: in a 2D sketch, Normal To looks straight at the sketch): the view turns
// to look straight at the sketch plane from its front; Normal To again turns it 180 degrees, to look from the back.
// Offered under the toolbar's Views and on the sketch's right-click menu.

import { Euler, MathUtils, Vector3 } from 'three';
import type { Vec3 } from '@jarvis/core';
import type { ToolDef } from './toolDefs';
import { useSketcher } from './sketcher';
import { planeFrame } from './sketchMath';
import { refit, runTool, useStudio } from './state';
import { normalToAngles } from './viewProjection';

/** The open sketch's plane normal in world space (its part turned as the part is), or null with no 2D sketch open. */
export function sketchWorldNormal(): Vec3 | null {
    const s = useSketcher.getState();
    if (!s.active || s.stage !== 'draw') {
        return null;
    }
    const { n } = planeFrame(s.plane, s.offset, s.context);
    const part = useStudio.getState().project?.parts.find((p) => p.id === s.partId) ?? useStudio.getState().history?.parts.find((p) => p.id === s.partId);
    const w = new Vector3(...n);
    if (part) {
        w.applyEuler(new Euler(...(part.rotation.map(MathUtils.degToRad) as Vec3), 'XYZ'));
    }
    return [w.x, w.y, w.z];
}

/** Turns the view normal to the open sketch (from the back when it already looks straight at it). */
export function normalToSketch(): boolean {
    const n = sketchWorldNormal();
    if (!n) {
        return false;
    }
    const { azimuth, elevation } = normalToAngles(n);
    void runTool('view_set', { azimuth, elevation }).then(() => refit());
    return true;
}

export const normalToTool: ToolDef = {
    id: 'sk-normal-to',
    label: 'Normal to',
    icon: 'views',
    hint: 'look straight at the sketch plane; again, from the other side',
    instant: () => {
        normalToSketch();
    },
};

/** The Normal to button of the Views list, while a 2D sketch is open. */
export function SketchNormalTo() {
    const sketching = useSketcher((s) => s.active && s.stage === 'draw');
    return sketching ? (
        <button type="button" title="Look straight at the sketch plane; again, from the other side" onClick={() => normalToSketch()}>
            Normal to
        </button>
    ) : null;
}
