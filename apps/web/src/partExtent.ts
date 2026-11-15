// How much room a part without a solid takes: its sketches, so the view can frame them.

import type { Feature, Sketch, Vec3 } from '@jarvis/core';
import { planeFrame, profilePoints } from './sketchMath';

/** Half the size given to a part that has nothing in it yet (mm): the view then shows the space around its planes. */
export const EMPTY_PART_HALF: Vec3 = [60, 60, 60];

/** The (u, v) points that span a sketch: its points, and the extremes of its circles. */
function sketchSpan(sketch: Sketch): [number, number][] {
    const g = sketch.geometry;
    if (!g) {
        return sketch.profiles.flatMap((p) => profilePoints(p));
    }
    const at = new Map(g.points.map((p) => [p.id, [p.u, p.v] as [number, number]]));
    const span = [...at.values()];
    for (const c of g.curves) {
        const centre = c.kind === 'circle' ? at.get(c.center) : undefined;
        if (c.kind === 'circle' && centre) {
            span.push([centre[0] - c.radius, centre[1]], [centre[0] + c.radius, centre[1]], [centre[0], centre[1] - c.radius], [centre[0], centre[1] + c.radius]);
        }
    }
    return span;
}

/** The box (part frame) around every sketch of the steps, or null when there is none with anything drawn. */
export function sketchExtent(features: Feature[] | undefined): { min: Vec3; max: Vec3 } | null {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    (features ?? []).forEach((f, index) => {
        const sketch = !f.suppressed && 'sketch' in f ? (f as { sketch?: Sketch }).sketch : undefined;
        if (!sketch) {
            return;
        }
        const frame = planeFrame(sketch.plane, sketch.offset ?? 0, features!.slice(0, index));
        for (const [u, v] of sketchSpan(sketch)) {
            for (let i = 0; i < 3; i++) {
                const x = frame.origin[i] + frame.u[i] * u + frame.v[i] * v;
                min[i] = Math.min(min[i], x);
                max[i] = Math.max(max[i], x);
            }
        }
    });
    return Number.isFinite(min[0]) ? { min, max } : null;
}
