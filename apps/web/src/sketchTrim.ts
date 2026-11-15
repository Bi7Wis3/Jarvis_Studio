// The Trim tool's other modes, on top of trimAt (trim to closest): power trim along a dragged path, corner, and trim
// away inside / outside two boundaries.

import type { SketchGeometry } from '@jarvis/core';
import { curveOf } from './solver';
import { trimAt, type TrimOptions } from './sketchEdit';
import { boundaryParams, closesOnItself, cornerCurves, curveExtent, curvePointAt, pathCrossings } from './sketchCut';
import { cutRefusal } from './sketchItems';
import { dist, type Pt } from './sketchMath';
import { cornerEndless, isEndless } from './sketchInfinite';

export type TrimMode = 'power' | 'corner' | 'inside' | 'outside' | 'closest';

/** Trim's options: keep trimmed entities as construction geometry, and leave construction geometry alone. */
export interface TrimSettings {
    construction?: boolean;
    ignoreConstruction?: boolean;
}

/** Whether the trim may touch this curve. */
export function trimmable(g: SketchGeometry, id: string, o: TrimSettings): boolean {
    const c = curveOf(g, id);
    // Text and block instance curves are not cut (dissolve or explode them first).
    return !!c && !(o.ignoreConstruction && c.construction) && !cutRefusal(g, id, 'Trim');
}

/**
 * Power trim: every curve the pointer path from `from` to `to` crosses is trimmed at the crossing, back to its nearest
 * crossings with other curves (a curve nothing crosses goes). Crossings are taken in order along the path.
 */
export function powerTrim(g: SketchGeometry, from: Pt, to: Pt, o: TrimSettings = {}): { g: SketchGeometry; trimmed: number } {
    if (dist(from, to) < 1e-9) {
        return { g, trimmed: 0 };
    }
    let out = g;
    let trimmed = 0;
    let done = -1;
    const opts: TrimOptions = { construction: o.construction };
    for (let i = 0; i < 64; i++) {
        let next: { id: string; at: Pt; t: number } | null = null;
        for (const c of out.curves) {
            if (!trimmable(out, c.id, o)) {
                continue;
            }
            for (const h of pathCrossings(out, c, from, to)) {
                if (h.t > done + 1e-9 && (!next || h.t < next.t)) {
                    next = { id: c.id, at: h.at, t: h.t };
                }
            }
        }
        if (!next) {
            break;
        }
        done = next.t;
        const plan = trimAt(out, next.id, next.at, opts);
        if (plan) {
            out = plan.g;
            trimmed += 1;
        }
    }
    return { g: out, trimmed };
}

/**
 * Corner: trims or extends two curves until they meet. Each keeps the side of the corner where it was clicked; the
 * other end moves to the corner along the curve's natural path (lines, arcs, partial ellipses, parabolas and conics
 * run on; splines only shorten), and the two curves share it.
 */
export function trimCorner(g: SketchGeometry, a: { id: string; at: Pt }, b: { id: string; at: Pt }): { g: SketchGeometry } | { error: string } {
    // A line that runs on without end keeps doing so on the side it was clicked (sketchInfinite.ts).
    if (isEndless(curveOf(g, a.id)) || isEndless(curveOf(g, b.id))) {
        return cornerEndless(g, a, b);
    }
    return cornerCurves(g, a, b);
}

/**
 * Trim away inside: the piece of the curve between the two boundaries goes. Trim away outside: the pieces beyond them
 * go and the piece between stays. The curve must be open (any kind) and cross each boundary once.
 */
export function trimBetween(g: SketchGeometry, curveId: string, bounds: [string, string], mode: 'inside' | 'outside',
    o: TrimSettings = {}): { g: SketchGeometry } | { error: string } {
    const c = curveOf(g, curveId);
    if (!c || closesOnItself(c)) {
        return { error: 'Pick an open curve that crosses both boundaries: only open entities are trimmed this way.' };
    }
    if (bounds.includes(curveId)) {
        return { error: 'That is one of the boundaries.' };
    }
    const cuts = boundaryParams(g, c, bounds);
    const span = curveExtent(g, c);
    if (!cuts || !span) {
        return { error: 'That curve does not cross each boundary once.' };
    }
    const opts: TrimOptions = { by: bounds, construction: o.construction };
    const point = (t: number) => curvePointAt(g, c, t)!;
    if (mode === 'inside') {
        const plan = trimAt(g, curveId, point((cuts[0] + cuts[1]) / 2), opts);
        return plan ? { g: plan.g } : { error: 'Nothing to trim there.' };
    }
    // Outside: both ends go, each from the curve's end to the nearer boundary (absolute points, as the curve changes).
    const before = point((span.t0 + cuts[0]) / 2);
    const after = point((cuts[1] + span.t1) / 2);
    const first = trimAt(g, curveId, before, opts);
    if (!first) {
        return { error: 'Nothing to trim there.' };
    }
    const second = trimAt(first.g, curveId, after, opts);
    return { g: (second ?? first).g };
}
