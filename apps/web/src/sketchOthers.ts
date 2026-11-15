// The part's other sketches as the sketch being drawn sees them, for snapping to their corners, midpoints and lines.

import type { Feature, Sketch, SketchCurve, SketchGeometry, SketchPlane, SketchPoint } from '@jarvis/core';
import { profilesToGeometry } from './sketchGeometry';
import { planeFrame } from './sketchMath';

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The sketch a step holds itself (a sketch step, or an older extrude or revolve with its sketch inline). */
function sketchOf(f: Feature): Sketch | null {
    const sketch = 'sketch' in f ? (f as { sketch?: Sketch }).sketch : undefined;
    return sketch ?? null;
}

/**
 * The points and curves of the sketches in `features`, projected straight onto the plane being sketched on, in its
 * (u, v). Nothing here belongs to the sketch: it is only snapped to. A line projects to a line on any plane; a
 * circle or arc keeps its shape only on a parallel plane (on a tilted one it would be an ellipse), so there only
 * its centre and end points are kept. `skip` leaves a step out (a hidden sketch).
 */
export function otherSketches(features: Feature[], plane: SketchPlane, offset: number, skip: (id: string) => boolean = () => false): SketchGeometry {
    const here = planeFrame(plane, offset, features);
    const points: SketchPoint[] = [];
    const curves: SketchCurve[] = [];
    features.forEach((f, index) => {
        const sketch = f.suppressed || skip(f.id) ? null : sketchOf(f);
        if (!sketch) {
            return;
        }
        const there = planeFrame(sketch.plane, sketch.offset ?? 0, features.slice(0, index));
        const facing = dot(here.n, there.n);
        const parallel = Math.abs(facing) > 1 - 1e-9;
        const g = sketch.geometry ?? profilesToGeometry(sketch.profiles);
        const id = (local: string) => `${f.id}/${local}`;
        const project = (u: number, v: number): [number, number] => {
            const rel: V3 = [0, 1, 2].map((i) => there.origin[i] + there.u[i] * u + there.v[i] * v - here.origin[i]) as V3;
            return [dot(rel, here.u), dot(rel, here.v)];
        };
        const placed = new Map<string, [number, number]>();
        // The other sketch's own origin is a point of it too.
        for (const p of [{ id: 'origin', u: 0, v: 0 }, ...g.points.filter((q) => q.id !== 'origin')]) {
            const [u, v] = project(p.u, p.v);
            placed.set(p.id, [u, v]);
            points.push({ id: id(p.id), u, v });
        }
        for (const c of g.curves) {
            if (c.kind === 'line') {
                const a = placed.get(c.a);
                const b = placed.get(c.b);
                if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) {
                    curves.push({ id: id(c.id), kind: 'line', a: id(c.a), b: id(c.b) });
                }
            } else if (parallel && c.kind === 'circle') {
                curves.push({ id: id(c.id), kind: 'circle', center: id(c.center), radius: c.radius });
            } else if (parallel && c.kind === 'arc') {
                // Seen from behind, a counter-clockwise arc runs clockwise: swap its ends.
                const [start, end] = facing > 0 ? [c.start, c.end] : [c.end, c.start];
                curves.push({ id: id(c.id), kind: 'arc', center: id(c.center), start: id(start), end: id(end) });
            }
        }
    });
    return { points, curves, constraints: [] };
}
