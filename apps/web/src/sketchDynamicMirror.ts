// Dynamic mirror (SolidWorks Dynamic Mirror Entities): once a mirror line is chosen, whatever is drawn next gets a
// mirror image, each point held symmetric to its original. Entities that were there before are not mirrored. Points
// that already have an image (the start of the next line of a chain) reuse it, so mirrored chains stay joined.

import type { SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, pointOf } from './solver';
import { addConstraint, newId } from './sketchGeometry';
import { curvePoints, mirrorCurves } from './sketchEdit';
import { mergePoints } from './sketchRepair';
import { dist, type Pt } from './sketchMath';

/** Whether `id` can be mirrored about: a line, a centreline or one of the sketch axes. */
export function isMirrorLine(g: SketchGeometry, id: string): boolean {
    return id === AXIS_U || id === AXIS_V || curveOf(g, id)?.kind === 'line';
}

function reflect(g: SketchGeometry, line: string, p: Pt): Pt | null {
    let a: Pt;
    let b: Pt;
    if (line === AXIS_U || line === AXIS_V) {
        [a, b] = [[0, 0], line === AXIS_U ? [1, 0] : [0, 1]];
    } else {
        const l = curveOf(g, line);
        const pa = l?.kind === 'line' ? pointOf(g, l.a) : undefined;
        const pb = l?.kind === 'line' ? pointOf(g, l.b) : undefined;
        if (!pa || !pb) {
            return null;
        }
        [a, b] = [[pa.u, pa.v], [pb.u, pb.v]];
    }
    const d: Pt = [b[0] - a[0], b[1] - a[1]];
    const l2 = d[0] ** 2 + d[1] ** 2;
    if (l2 < 1e-18) {
        return null;
    }
    const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2;
    const f: Pt = [a[0] + d[0] * t, a[1] + d[1] * t];
    return [2 * f[0] - p[0], 2 * f[1] - p[1]];
}

export interface MirrorResult {
    g: SketchGeometry;
    /** Original point id to its image, the known ones and those added now. */
    images: Record<string, string>;
}

/**
 * Mirrors what `after` has that `before` did not (curves, and sketch points of their own) about `line`. `images`
 * are the images made earlier in this dynamic mirror session.
 */
export function mirrorDrawn(before: SketchGeometry, after: SketchGeometry, line: string, images: Record<string, string>): MirrorResult {
    if (!isMirrorLine(after, line)) {
        return { g: after, images };
    }
    const old = new Set(before.curves.map((c) => c.id));
    const fresh = after.curves.filter((c) => !old.has(c.id) && c.id !== line);
    const oldPoints = new Set(before.points.map((p) => p.id));
    const used = new Set(after.curves.flatMap(curvePoints));
    const loose = after.points.filter((p) => !oldPoints.has(p.id) && !used.has(p.id) && p.id !== ORIGIN);
    // A curve lying on the mirror line is its own image.
    const own = (c: (typeof fresh)[number]) => curvePoints(c).every((id) => {
        const p = pointOf(after, id);
        const q = p && reflect(after, line, [p.u, p.v]);
        return !!q && dist(q, [p.u, p.v]) < 1e-6;
    });
    const toMirror = fresh.filter((c) => !own(c)).map((c) => c.id);
    let g = after;
    const next = { ...images };
    const alive = (id: string) => !!pointOf(g, id);
    if (toMirror.length) {
        const r = mirrorCurves(g, toMirror, line, true);
        if ('error' in r) {
            return { g: after, images };
        }
        g = r.g;
        const added = g.constraints.filter((k) => !after.constraints.some((x) => x.id === k.id));
        for (const k of added) {
            if (k.kind !== 'symmetric' || k.about !== line) {
                continue;
            }
            const known = next[k.a];
            if (known && known !== k.b && alive(known)) {
                // Join the new image to the one made before; the repeated symmetric relation goes in the merge.
                g = mergePoints(g, known, k.b);
            } else {
                next[k.a] = k.b;
            }
        }
    }
    for (const p of loose) {
        const q = reflect(g, line, [p.u, p.v]);
        if (!q || dist(q, [p.u, p.v]) < 1e-6) {
            continue;
        }
        const id = newId('p', g);
        g = { ...g, points: [...g.points, { id, u: q[0], v: q[1] }] };
        g = addConstraint(g, { kind: 'symmetric', a: p.id, b: id, about: line }).g;
        next[p.id] = id;
    }
    return { g, images: next };
}
