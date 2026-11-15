// Box and cross selection in a sketch (SolidWorks: a box dragged left to right takes what lies wholly inside; right
// to left also what it crosses, drawn dashed). Pure: the sketcher turns the result into its selection.

import type { SketchGeometry } from '@jarvis/core';
import { ORIGIN } from './solver';
import { geometryEntities } from './sketchGeometry';
import { curvePoints } from './sketchEdit';
import { entityPoints, type Pt } from './sketchMath';

export type BoxItem = { type: 'point' | 'curve' | 'constraint'; id: string };

interface Rect {
    lo: Pt;
    hi: Pt;
}

const rectOf = (a: Pt, b: Pt): Rect => ({ lo: [Math.min(a[0], b[0]), Math.min(a[1], b[1])], hi: [Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
const within = (r: Rect, p: Pt) => p[0] >= r.lo[0] && p[0] <= r.hi[0] && p[1] >= r.lo[1] && p[1] <= r.hi[1];

/** Whether segment p-q meets the rectangle (an end inside, or crossing one of its sides). */
function segmentMeets(r: Rect, p: Pt, q: Pt): boolean {
    if (within(r, p) || within(r, q)) {
        return true;
    }
    // Liang-Barsky clip of the segment against the rectangle.
    let t0 = 0;
    let t1 = 1;
    const d: Pt = [q[0] - p[0], q[1] - p[1]];
    for (const [pk, qk] of [[-d[0], p[0] - r.lo[0]], [d[0], r.hi[0] - p[0]], [-d[1], p[1] - r.lo[1]], [d[1], r.hi[1] - p[1]]]) {
        if (pk === 0) {
            if (qk < 0) {
                return false;
            }
        } else {
            const t = qk / pk;
            if (pk < 0) {
                t0 = Math.max(t0, t);
            } else {
                t1 = Math.min(t1, t);
            }
            if (t0 > t1) {
                return false;
            }
        }
    }
    return true;
}

/**
 * What a selection box from `a` to `b` takes: the curves wholly inside it (`crossing`: also those it touches), the
 * sketch points of their own inside it, and the dimensions whose value sits inside it. The points curves are built
 * on go with their curves, so deleting a box selection leaves the curves outside it whole.
 */
export function boxSelect(g: SketchGeometry, a: Pt, b: Pt, crossing: boolean, labels: Record<string, Pt> = {}): BoxItem[] {
    const r = rectOf(a, b);
    const out: BoxItem[] = [];
    for (const e of geometryEntities(g)) {
        const poly = entityPoints(e);
        const inside = poly.every((p) => within(r, p));
        const touched = inside || (crossing && poly.some((p, i) => i > 0 && segmentMeets(r, poly[i - 1], p)));
        if (touched) {
            out.push({ type: 'curve', id: e.id });
        }
    }
    const used = new Set(g.curves.flatMap(curvePoints));
    for (const p of g.points) {
        if (p.id !== ORIGIN && !used.has(p.id) && within(r, [p.u, p.v])) {
            out.push({ type: 'point', id: p.id });
        }
    }
    for (const [id, at] of Object.entries(labels)) {
        if (g.constraints.some((c) => c.id === id) && within(r, at)) {
            out.push({ type: 'constraint', id });
        }
    }
    return out;
}

/**
 * The selection after a box: plain replaces it; Shift adds everything in the box; Ctrl turns each item in the box
 * over (selected ones off, the others on). Items outside the box keep their state with either key.
 */
export function combineBox<T extends BoxItem>(current: T[], boxed: T[], mode: 'replace' | 'add' | 'toggle'): T[] {
    if (mode === 'replace') {
        return boxed;
    }
    const has = new Set(current.map((x) => x.id));
    if (mode === 'add') {
        return [...current, ...boxed.filter((x) => !has.has(x.id))];
    }
    const inBox = new Set(boxed.map((x) => x.id));
    return [...current.filter((x) => !inBox.has(x.id)), ...boxed.filter((x) => !has.has(x.id))];
}
