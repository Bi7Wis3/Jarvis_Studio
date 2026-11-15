// The Parameters of a rectangle (SolidWorks Rectangle PropertyManager): X and Y of its four corners, and for the centre
// kinds its centre. A corner typed is pulled there and the rectangle's relations move the others with it; a centre
// typed moves the whole rectangle.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf, pointOf } from './solver';
import type { Target } from './sketchEntityParams';

type Line = Extract<SketchCurve, { kind: 'line' }>;

export interface RectFound {
    /** The corner points in order round the rectangle. */
    corners: [string, string, string, string];
    /** The centre point (held at the middle of a diagonal), if it has one. */
    centre: string | null;
}

/** The rectangle among these curves: the first four lines that close a loop of four corners. */
export function rectangleOf(g: SketchGeometry, curves: string[]): RectFound | null {
    const lines = curves.map((id) => curveOf(g, id)).filter((c): c is Line => c?.kind === 'line').slice(0, 4);
    if (lines.length < 4) {
        return null;
    }
    // Walk the loop from the first line's start.
    const corners: string[] = [lines[0].a];
    let at = lines[0].b;
    const used = new Set([lines[0].id]);
    while (corners.length < 4) {
        corners.push(at);
        const next = lines.find((l) => !used.has(l.id) && (l.a === at || l.b === at));
        if (!next) {
            return null;
        }
        used.add(next.id);
        at = next.a === at ? next.b : next.a;
    }
    if (at !== corners[0] || new Set(corners).size !== 4) {
        return null;
    }
    const four = corners as [string, string, string, string];
    const diagonal = (l: Line) => (l.a === four[0] && l.b === four[2]) || (l.a === four[2] && l.b === four[0])
        || (l.a === four[1] && l.b === four[3]) || (l.a === four[3] && l.b === four[1]);
    for (const k of g.constraints) {
        const l = k.kind === 'midpoint' ? curveOf(g, k.line) : undefined;
        if (k.kind === 'midpoint' && l?.kind === 'line' && diagonal(l)) {
            return { corners: four, centre: k.point };
        }
    }
    return { corners: four, centre: null };
}

const P = (g: SketchGeometry, id: string): [number, number] => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** The middle of the rectangle: its centre point, or the average of its corners. */
function middle(g: SketchGeometry, r: RectFound): [number, number] {
    if (r.centre) {
        return P(g, r.centre);
    }
    const all = r.corners.map((id) => P(g, id));
    return [all.reduce((s, p) => s + p[0], 0) / 4, all.reduce((s, p) => s + p[1], 0) / 4];
}

/** The form's values: `p_c10`, `p_c11` for corner 1 X and Y ... corner 4; `p_m0`, `p_m1` for the centre. */
export function rectValues(g: SketchGeometry, r: RectFound, centre: boolean): Record<string, number> {
    const out: Record<string, number> = {};
    r.corners.forEach((id, i) => {
        [out[`p_c${i + 1}0`], out[`p_c${i + 1}1`]] = P(g, id);
    });
    if (centre) {
        [out.p_m0, out.p_m1] = middle(g, r);
    }
    return out;
}

/** Where the points go for the values typed (the keys of `next` that differ from `now`). */
export function rectTargets(g: SketchGeometry, r: RectFound, next: Record<string, number>, now: Record<string, number>): Target[] {
    const changed = (...keys: string[]) => keys.some((k) => k in next && Math.abs(next[k] - now[k]) > 1e-12);
    if (changed('p_m0', 'p_m1')) {
        // A new centre moves the rectangle as it is.
        const d = [next.p_m0 - now.p_m0, next.p_m1 - now.p_m1];
        return [...r.corners, ...(r.centre ? [r.centre] : [])].map((point) => {
            const [u, v] = P(g, point);
            return { point, u: u + d[0], v: v + d[1] };
        });
    }
    return r.corners.flatMap((point, i) => (changed(`p_c${i + 1}0`, `p_c${i + 1}1`) ? [{ point, u: next[`p_c${i + 1}0`], v: next[`p_c${i + 1}1`] }] : []));
}
