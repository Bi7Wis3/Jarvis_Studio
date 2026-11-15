// Picking regions of a sketch for an extrude, cut or revolve that uses only some of it. A pick is a point in
// sketch (u, v); it selects the region that contains it, so it survives edits that keep the point inside.

import { useEffect } from 'react';
import { create } from 'zustand';
import type { SketchGeometry, SketchRegion } from '@jarvis/core';
import { geometryEntities } from './sketchGeometry';
import { sketchRegions } from './sketchRegions';
import { curveEndIds } from './sketchCurves';
import { inside, profilePoints, type Pt } from './sketchMath';

export interface RegionPickState {
    /** Picking regions of a sketch step in the part workspace (the sketcher's finish popup picks regardless). */
    active: boolean;
    /** The sketch step being picked from, as "partId/stepId"; null for the sketch being edited. */
    sketchKey: string | null;
    picked: Pt[];
}

export const useRegionPick = create<RegionPickState>(() => ({ active: false, sketchKey: null, picked: [] }));

/** Starts picking regions of a sketch step ("partId/stepId"; null: the sketch being edited), e.g. from a feature's `regions`. */
export function startRegionPick(sketchKey: string | null, initial: Pt[] = []): void {
    useRegionPick.setState({ active: sketchKey !== null, sketchKey, picked: initial.map((p) => [p[0], p[1]]) });
}

/**
 * Picks the region containing `at`, or unpicks it if a pick already lies in that region. Without `regions` a pick
 * equal to `at` is removed instead.
 */
export function toggleRegion(at: Pt, regions?: SketchRegion[]): void {
    useRegionPick.setState((s) => {
        const region = regions ? regionAt(regions, at) : -1;
        const same = (p: Pt) => (region >= 0 ? regionAt(regions!, p) === region : Math.hypot(p[0] - at[0], p[1] - at[1]) < 1e-6);
        const rest = s.picked.filter((p) => !same(p));
        return { picked: rest.length < s.picked.length ? rest : [...s.picked, [at[0], at[1]]] };
    });
}

export function clearRegionPick(): void {
    useRegionPick.setState({ active: false, sketchKey: null, picked: [] });
}

/**
 * Region picking for as long as the calling component is mounted (e.g. inside a tool popup): starts on `sketchKey`
 * with `initial` picks, starts over when the key changes, and clears on unmount.
 */
export function RegionPickSession({ sketchKey, initial }: { sketchKey: string | null; initial?: Pt[] }): null {
    useEffect(() => {
        startRegionPick(sketchKey, initial ?? []);
        return () => clearRegionPick();
    }, [sketchKey]); // `initial` only seeds a new session
    return null;
}

/** Every bounded region of a sketcher geometry (construction curves left out), as `Sketch.regions` stores them. */
export function regionsOf(g: SketchGeometry): SketchRegion[] {
    const ends = new Map<string, [string, string]>();
    for (const c of g.curves) {
        const e = curveEndIds(c);
        if (e.length === 2) {
            ends.set(c.id, [e[0], e[1]]);
        }
    }
    return sketchRegions(geometryEntities(g, false), ends);
}

/** A region's loops as points, with the outline's bounds; worked out once per region (regions are not changed). */
const ringsKept = new WeakMap<SketchRegion, { outer: Pt[] | undefined; holes: Pt[][]; box: [number, number, number, number] }>();

function ringsOf(r: SketchRegion) {
    let rings = ringsKept.get(r);
    if (!rings) {
        const [outer, ...holes] = r.loops.map(profilePoints);
        const box: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
        for (const [u, v] of outer ?? []) {
            box[0] = Math.min(box[0], u);
            box[1] = Math.max(box[1], u);
            box[2] = Math.min(box[2], v);
            box[3] = Math.max(box[3], v);
        }
        rings = { outer, holes, box };
        ringsKept.set(r, rings);
    }
    return rings;
}

/** Index of the region containing `point` (inside its outline, outside its holes), or -1. */
export function regionAt(regions: SketchRegion[], point: Pt): number {
    return regions.findIndex((r) => {
        const { outer, holes, box } = ringsOf(r);
        // Outside the outline's bounds is outside the outline.
        const near = point[0] >= box[0] && point[0] <= box[1] && point[1] >= box[2] && point[1] <= box[3];
        return !!outer && near && inside(point, outer) && !holes.some((h) => inside(point, h));
    });
}

/** Indices of the regions that some pick lies in, in region order. */
export function pickedRegions(regions: SketchRegion[], picks: Pt[]): number[] {
    const hit = new Set(picks.map((p) => regionAt(regions, p)));
    return regions.flatMap((_, i) => (hit.has(i) ? [i] : []));
}
